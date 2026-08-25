use std::{
    collections::{HashMap, HashSet},
    env,
    path::PathBuf,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    body::{Body, to_bytes},
    extract::{DefaultBodyLimit, Path as AxumPath, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use socketioxide::{
    SocketIo,
    extract::{AckSender, Data, SocketRef},
};
use subtle::ConstantTimeEq;
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::broadcast,
    time::{MissedTickBehavior, interval, sleep},
};
use uuid::Uuid;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredMessage {
    id: String,
    encrypted: String,
    created_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeetingSignal {
    id: String,
    encrypted: String,
    created_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PresenceItem {
    id: String,
    encrypted_alias: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingItem {
    id: String,
    encrypted_alias: String,
}

#[derive(Clone)]
struct StoredFile {
    public: PublicFile,
    path: PathBuf,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicFile {
    id: String,
    encrypted_meta: String,
    encrypted_size: usize,
    created_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicRoute {
    r#type: &'static str,
    base_url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenStart {
    id: String,
    encrypted: String,
    created_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenChunk {
    stream_id: String,
    sequence: usize,
    encrypted: String,
}

#[derive(Clone, Serialize)]
struct ScreenState {
    start: ScreenStart,
    chunks: Vec<ScreenChunk>,
}

struct ActiveScreen {
    presenter_socket_id: String,
    start: ScreenStart,
    chunks: Vec<ScreenChunk>,
    encrypted_bytes: usize,
}

struct AppState {
    room_id: String,
    owner_hash: [u8; 32],
    max_file_bytes: usize,
    max_participants: usize,
    max_concurrent_uploads: usize,
    max_files: usize,
    max_room_storage_bytes: usize,
    room_ttl_minutes: u64,
    screen_max_minutes: u64,
    livekit_url: String,
    livekit_api_key: String,
    livekit_api_secret: String,
    ui_dir: PathBuf,
    file_dir: PathBuf,
    messages: RwLock<Vec<StoredMessage>>,
    meeting_signals: RwLock<Vec<MeetingSignal>>,
    files: RwLock<HashMap<String, StoredFile>>,
    aliases: RwLock<HashMap<String, String>>,
    pending_aliases: RwLock<HashMap<String, String>>,
    owner_sockets: RwLock<HashSet<String>>,
    sockets: RwLock<HashMap<String, SocketRef>>,
    routes: RwLock<Vec<PublicRoute>>,
    active_screen: Mutex<Option<ActiveScreen>>,
    media_presenter: Mutex<Option<String>>,
    admission_locked: AtomicBool,
    connections: AtomicUsize,
    active_uploads: AtomicUsize,
    reserved_files: AtomicUsize,
    stored_ciphertext_bytes: AtomicUsize,
    file_events: broadcast::Sender<PublicFile>,
    shutdown: broadcast::Sender<()>,
    _run_dir: TempDir,
}

struct UploadGuard {
    state: Arc<AppState>,
    reserved_bytes: usize,
    reserved_file: bool,
    committed: bool,
}

impl Drop for UploadGuard {
    fn drop(&mut self) {
        self.state.active_uploads.fetch_sub(1, Ordering::SeqCst);
        if !self.committed {
            if self.reserved_file {
                self.state.reserved_files.fetch_sub(1, Ordering::SeqCst);
            }
            if self.reserved_bytes > 0 {
                self.state.stored_ciphertext_bytes.fetch_sub(self.reserved_bytes, Ordering::SeqCst);
            }
        }
    }
}

#[derive(Deserialize)]
struct RoomQuery {
    room: Option<String>,
}

#[derive(Deserialize)]
struct AuthPayload {
    room: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AliasPayload {
    encrypted_alias: String,
    #[serde(default)]
    owner_token: Option<String>,
}

#[derive(Deserialize)]
struct EncryptedPayload {
    encrypted: String,
}

#[derive(Deserialize)]
struct EmptyPayload {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdmissionLockPayload {
    owner_token: String,
    locked: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdmissionDecisionPayload {
    owner_token: String,
    socket_id: String,
    allow: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModerationPayload {
    owner_token: String,
    target: String,
    command: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DestroyPayload {
    owner_token: String,
}

#[derive(Serialize)]
struct AckResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
}

#[derive(Serialize)]
struct StopEvent {
    reason: &'static str,
}

#[derive(Serialize)]
struct AdmissionState {
    locked: bool,
}

#[derive(Serialize)]
struct ModerationEvent<'a> {
    command: &'a str,
    reason: &'a str,
}

#[derive(Default)]
struct RateWindow {
    started_at: u64,
    count: u32,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn random_token(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    rand::rng().fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

fn env_number(name: &str, default: u64, minimum: u64, maximum: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
        .clamp(minimum, maximum)
}

#[cfg(unix)]
fn restrict_directory(path: &PathBuf) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn restrict_directory(_path: &PathBuf) -> std::io::Result<()> {
    Ok(())
}

fn is_base64_url(value: &str, maximum: usize) -> bool {
    value.len() >= 24
        && value.len() <= maximum
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn owner_matches(state: &AppState, candidate: &str) -> bool {
    let digest: [u8; 32] = Sha256::digest(candidate.as_bytes()).into();
    bool::from(digest.ct_eq(&state.owner_hash))
}

fn create_media_token(state: &AppState, encrypted_alias: &str, identity: &str) -> Option<String> {
    let now = now_ms() / 1_000;
    let header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({
        "alg": "HS256",
        "typ": "JWT"
    })).ok()?);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({
        "iss": state.livekit_api_key.as_str(),
        "sub": identity,
        "nbf": now.saturating_sub(5),
        "exp": now + 15 * 60,
        "metadata": encrypted_alias,
        "video": {
            "room": state.room_id.as_str(),
            "roomJoin": true,
            "canPublish": true,
            "canSubscribe": true,
            "canPublishData": false
        }
    })).ok()?);
    let unsigned = format!("{header}.{payload}");
    let mut signer = Hmac::<Sha256>::new_from_slice(state.livekit_api_secret.as_bytes()).ok()?;
    signer.update(unsigned.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(signer.finalize().into_bytes());
    Some(format!("{unsigned}.{signature}"))
}

fn media_url_for_request(state: &AppState, headers: &HeaderMap) -> Option<String> {
    if state.livekit_url.is_empty() || state.livekit_api_key.is_empty() || state.livekit_api_secret.is_empty() {
        return None;
    }
    let media_is_local = state.livekit_url.contains("://localhost") || state.livekit_url.contains("://127.0.0.1") || state.livekit_url.contains("://[::1]");
    let host = headers.get(header::HOST).and_then(|value| value.to_str().ok()).unwrap_or_default().split(':').next().unwrap_or_default();
    let request_is_local = matches!(host, "localhost" | "127.0.0.1" | "::1");
    (!media_is_local || request_is_local).then(|| state.livekit_url.clone())
}

fn document_html() -> Html<&'static str> {
    Html(
        r#"<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
    <meta name="color-scheme" content="dark light" />
    <meta name="referrer" content="no-referrer" />
    <title>Cinder Room</title>
    <meta name="description" content="An end-to-end encrypted room that leaves when you do." />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body><div id="root"></div><script type="module" src="/app.js"></script></body>
</html>"#,
    )
}

async fn security_headers(request: axum::extract::Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store, max-age=0"));
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static("camera=(self), microphone=(self), geolocation=(), payment=(), usb=()"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"),
    );
    response
}

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "ok": true,
        "relay": "rust",
        "expiresInMinutes": state.room_ttl_minutes,
        "maxFileMb": state.max_file_bytes / 1024 / 1024,
        "mediaConfigured": !state.livekit_url.is_empty() && !state.livekit_api_key.is_empty() && !state.livekit_api_secret.is_empty(),
        "limits": {
            "participants": state.max_participants,
            "concurrentUploads": state.max_concurrent_uploads,
            "files": state.max_files,
            "roomStorageMb": state.max_room_storage_bytes / 1024 / 1024,
            "messagesPerTenSeconds": 30
        }
    }))
}

async fn route_list(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    axum::Json(state.routes.read().expect("routes lock").clone())
}

async fn media_token(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RoomQuery>,
    headers: HeaderMap,
) -> Response {
    if query.room.as_deref() != Some(state.room_id.as_str()) {
        return (StatusCode::NOT_FOUND, axum::Json(serde_json::json!({ "error": "Room unavailable" }))).into_response();
    }
    let encrypted_alias = headers.get("x-cinder-alias").and_then(|value| value.to_str().ok()).unwrap_or_default();
    let socket_id = headers.get("x-cinder-socket").and_then(|value| value.to_str().ok()).unwrap_or_default();
    let joined = is_base64_url(encrypted_alias, 2_048)
        && state.aliases.read().expect("aliases lock").get(socket_id).is_some_and(|value| value == encrypted_alias);
    if !joined {
        return (StatusCode::FORBIDDEN, axum::Json(serde_json::json!({ "error": "Join the encrypted room before starting media." }))).into_response();
    }
    let Some(server_url) = media_url_for_request(&state, &headers) else {
        return (StatusCode::SERVICE_UNAVAILABLE, axum::Json(serde_json::json!({
            "error": "Group video needs a public LiveKit/TURN endpoint. Cloudflare Quick Tunnel carries the room page, but not the required UDP media path."
        }))).into_response();
    };
    let Some(participant_token) = create_media_token(&state, encrypted_alias, socket_id) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(serde_json::json!({ "error": "Media authorization failed." }))).into_response();
    };
    (StatusCode::CREATED, axum::Json(serde_json::json!({
        "serverUrl": server_url,
        "participantToken": participant_token
    }))).into_response()
}

async fn file_list(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RoomQuery>,
) -> Response {
    if query.room.as_deref() != Some(state.room_id.as_str()) {
        return (StatusCode::NOT_FOUND, "Room unavailable").into_response();
    }
    let mut files = state
        .files
        .read()
        .expect("files lock")
        .values()
        .map(|file| file.public.clone())
        .collect::<Vec<_>>();
    files.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    axum::Json(files).into_response()
}

async fn upload_file(
    State(state): State<Arc<AppState>>,
    request: axum::extract::Request,
) -> Response {
    let headers: &HeaderMap = request.headers();
    let room = headers.get("x-cinder-room").and_then(|value| value.to_str().ok());
    let encrypted_meta = headers
        .get("x-cinder-meta")
        .and_then(|value| value.to_str().ok());
    if room != Some(state.room_id.as_str())
        || encrypted_meta.is_none_or(|value| !is_base64_url(value, 16_384))
    {
        return (StatusCode::BAD_REQUEST, "Invalid encrypted upload").into_response();
    }
    let declared_size = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if declared_size > state.max_file_bytes + 28 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "Encrypted file exceeds this room's limit")
            .into_response();
    }
    if state
        .active_uploads
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
            (value < state.max_concurrent_uploads).then_some(value + 1)
        })
        .is_err()
    {
        return (StatusCode::TOO_MANY_REQUESTS, "All encrypted upload lanes are busy. Try again shortly.").into_response();
    }
    let mut guard = UploadGuard { state: state.clone(), reserved_bytes: 0, reserved_file: false, committed: false };
    let encrypted_meta = encrypted_meta.unwrap_or_default().to_owned();
    let Ok(body) = to_bytes(request.into_body(), state.max_file_bytes + 28).await else {
        return (StatusCode::PAYLOAD_TOO_LARGE, "Encrypted file exceeds this room's limit").into_response();
    };
    if body.len() < 29 {
        return (StatusCode::BAD_REQUEST, "Invalid encrypted upload").into_response();
    }
    if state.reserved_files.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| (value < state.max_files).then_some(value + 1)).is_err() {
        return (StatusCode::INSUFFICIENT_STORAGE, "This room reached its temporary file limit.").into_response();
    }
    guard.reserved_file = true;
    if state.stored_ciphertext_bytes.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
        value.checked_add(body.len()).filter(|next| *next <= state.max_room_storage_bytes)
    }).is_err() {
        return (StatusCode::INSUFFICIENT_STORAGE, "This room reached its temporary storage limit.").into_response();
    }
    guard.reserved_bytes = body.len();

    let id = Uuid::new_v4().to_string();
    let path = state.file_dir.join(format!("{id}.bin"));
    if tokio::fs::write(&path, &body).await.is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Temporary relay error").into_response();
    }
    let public = PublicFile {
        id: id.clone(),
        encrypted_meta,
        encrypted_size: body.len(),
        created_at: now_ms(),
    };
    state.files.write().expect("files lock").insert(
        id,
        StoredFile {
            public: public.clone(),
            path,
        },
    );
    guard.committed = true;
    let _ = state.file_events.send(public.clone());
    (StatusCode::CREATED, axum::Json(public)).into_response()
}

async fn download_file(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<RoomQuery>,
) -> Response {
    if query.room.as_deref() != Some(state.room_id.as_str()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let file = state.files.read().expect("files lock").get(&id).cloned();
    let Some(file) = file else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(bytes) = tokio::fs::read(file.path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    if let Ok(length) = HeaderValue::from_str(&file.public.encrypted_size.to_string()) {
        response.headers_mut().insert(header::CONTENT_LENGTH, length);
    }
    response
}

async fn static_asset(State(state): State<Arc<AppState>>, AxumPath(name): AxumPath<String>) -> Response {
    if name != "app.js" && name != "app.css" && name != "e2ee-worker.js" {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(bytes) = tokio::fs::read(state.ui_dir.join(&name)).await else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Build the room UI first").into_response();
    };
    let content_type = if name.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else {
        "text/css; charset=utf-8"
    };
    ([(header::CONTENT_TYPE, content_type)], bytes).into_response()
}

async fn room_page(State(state): State<Arc<AppState>>, AxumPath(room): AxumPath<String>) -> Response {
    if room != state.room_id {
        return (StatusCode::NOT_FOUND, "Room unavailable").into_response();
    }
    document_html().into_response()
}

async fn root_page() -> impl IntoResponse {
    (
        StatusCode::FORBIDDEN,
        "Open the private host link printed by the Cinder Room server.",
    )
}

fn rate_allowed(window: &Mutex<RateWindow>, maximum: u32) -> bool {
    let now = now_ms();
    let mut current = window.lock().expect("rate lock");
    if now.saturating_sub(current.started_at) > 10_000 {
        current.started_at = now;
        current.count = 0;
    }
    current.count += 1;
    current.count <= maximum
}

async fn stop_active_screen(state: &AppState, io: &SocketIo, reason: &'static str) {
    let removed = state.active_screen.lock().expect("screen lock").take().is_some();
    if removed {
        io.emit("screen:stop", &StopEvent { reason }).await.ok();
    }
}

fn presence_snapshot(state: &AppState) -> Vec<PresenceItem> {
    state.aliases.read().expect("aliases lock").iter().map(|(id, encrypted_alias)| PresenceItem {
        id: id.clone(),
        encrypted_alias: encrypted_alias.clone(),
    }).collect()
}

fn pending_snapshot(state: &AppState) -> Vec<PendingItem> {
    state.pending_aliases.read().expect("pending aliases lock").iter().map(|(id, encrypted_alias)| PendingItem {
        id: id.clone(),
        encrypted_alias: encrypted_alias.clone(),
    }).collect()
}

fn emit_pending(state: &AppState) {
    let pending = pending_snapshot(state);
    let owner_ids = state.owner_sockets.read().expect("owner sockets lock").clone();
    let sockets = state.sockets.read().expect("sockets lock");
    for owner_id in owner_ids {
        if let Some(socket) = sockets.get(&owner_id) {
            socket.emit("admission:pending", &pending).ok();
        }
    }
}

fn is_admitted(state: &AppState, socket_id: &str) -> bool {
    state.aliases.read().expect("aliases lock").contains_key(socket_id)
}

async fn admit_socket(state: &AppState, io: &SocketIo, socket: &SocketRef, encrypted_alias: String) {
    let socket_id = socket.id.to_string();
    state.pending_aliases.write().expect("pending aliases lock").remove(&socket_id);
    state.aliases.write().expect("aliases lock").insert(socket_id, encrypted_alias);
    socket.emit("admission:admitted", &AdmissionState { locked: state.admission_locked.load(Ordering::SeqCst) }).ok();
    socket.emit("messages:init", &state.messages.read().expect("messages lock").clone()).ok();
    socket.emit("meeting:signals:init", &state.meeting_signals.read().expect("meeting signals lock").clone()).ok();
    let screen_state = state.active_screen.lock().expect("screen lock").as_ref().map(|screen| ScreenState {
        start: screen.start.clone(),
        chunks: screen.chunks.clone(),
    });
    if let Some(screen_state) = screen_state {
        socket.emit("screen:state", &screen_state).ok();
    }
    io.emit("presence", &presence_snapshot(state)).await.ok();
    emit_pending(state);
}

fn configure_socket_io(io: &SocketIo, state: Arc<AppState>) {
    let namespace_io = io.clone();
    io.ns(
        "/",
        move |socket: SocketRef, Data(auth): Data<AuthPayload>| {
            let state = state.clone();
            let io = namespace_io.clone();
            async move {
                if auth.room.as_deref() != Some(state.room_id.as_str()) {
                    socket.emit("room:error", "Room unavailable").ok();
                    socket.disconnect().ok();
                    return;
                }
                if state.connections.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| (value < state.max_participants).then_some(value + 1)).is_err() {
                    socket.emit("room:error", &format!("Room is full ({} participants).", state.max_participants)).ok();
                    socket.disconnect().ok();
                    return;
                }

                let socket_id = socket.id.to_string();
                state.sockets.write().expect("sockets lock").insert(socket_id.clone(), socket.clone());
                let message_rate = Arc::new(Mutex::new(RateWindow::default()));
                let meeting_rate = Arc::new(Mutex::new(RateWindow::default()));
                let screen_rate = Arc::new(Mutex::new(RateWindow::default()));
                let mut file_events = state.file_events.subscribe();
                let file_socket = socket.clone();
                tokio::spawn(async move {
                    while let Ok(file) = file_events.recv().await {
                        if file_socket.emit("file:added", &file).is_err() {
                            break;
                        }
                    }
                });

                let join_state = state.clone();
                let join_io = io.clone();
                socket.on(
                    "room:join",
                    move |socket: SocketRef, Data(payload): Data<AliasPayload>| {
                        let state = join_state.clone();
                        let io = join_io.clone();
                        async move {
                            if !is_base64_url(&payload.encrypted_alias, 2_048) {
                                socket.emit("room:error", "Invalid encrypted alias.").ok();
                                return;
                            }
                            let is_owner = payload.owner_token.as_deref().is_some_and(|token| owner_matches(&state, token));
                            if is_owner {
                                state.owner_sockets.write().expect("owner sockets lock").insert(socket.id.to_string());
                            }
                            if state.admission_locked.load(Ordering::SeqCst) && !is_owner {
                                state.pending_aliases.write().expect("pending aliases lock").insert(socket.id.to_string(), payload.encrypted_alias);
                                socket.emit("admission:waiting", &()).ok();
                                emit_pending(&state);
                                return;
                            }
                            admit_socket(&state, &io, &socket, payload.encrypted_alias).await;
                        }
                    },
                );

                let admission_lock_state = state.clone();
                let admission_lock_io = io.clone();
                socket.on(
                    "admission:lock",
                    move |socket: SocketRef, Data(payload): Data<AdmissionLockPayload>| {
                        let state = admission_lock_state.clone();
                        let io = admission_lock_io.clone();
                        async move {
                            if !owner_matches(&state, &payload.owner_token) {
                                socket.emit("room:error", "Only the host can change admission.").ok();
                                return;
                            }
                            state.admission_locked.store(payload.locked, Ordering::SeqCst);
                            io.emit("admission:state", &AdmissionState { locked: payload.locked }).await.ok();
                        }
                    },
                );

                let admission_decision_state = state.clone();
                let admission_decision_io = io.clone();
                socket.on(
                    "admission:decide",
                    move |socket: SocketRef, Data(payload): Data<AdmissionDecisionPayload>| {
                        let state = admission_decision_state.clone();
                        let io = admission_decision_io.clone();
                        async move {
                            if !owner_matches(&state, &payload.owner_token) {
                                socket.emit("room:error", "Invalid admission decision.").ok();
                                return;
                            }
                            let encrypted_alias = state.pending_aliases.write().expect("pending aliases lock").remove(&payload.socket_id);
                            let target = state.sockets.read().expect("sockets lock").get(&payload.socket_id).cloned();
                            let (Some(encrypted_alias), Some(target)) = (encrypted_alias, target) else {
                                emit_pending(&state);
                                return;
                            };
                            if payload.allow {
                                admit_socket(&state, &io, &target, encrypted_alias).await;
                            } else {
                                target.emit("moderation:command", &ModerationEvent { command: "remove", reason: "The host declined this request." }).ok();
                                target.disconnect().ok();
                                emit_pending(&state);
                            }
                        }
                    },
                );

                let moderation_state = state.clone();
                socket.on(
                    "moderation:command",
                    move |socket: SocketRef, Data(payload): Data<ModerationPayload>| {
                        let state = moderation_state.clone();
                        async move {
                            if !owner_matches(&state, &payload.owner_token) || !matches!(payload.command.as_str(), "mute" | "remove") {
                                socket.emit("room:error", "Invalid host action.").ok();
                                return;
                            }
                            if state.owner_sockets.read().expect("owner sockets lock").contains(&payload.target) {
                                return;
                            }
                            let target = state.sockets.read().expect("sockets lock").get(&payload.target).cloned();
                            let Some(target) = target else { return };
                            let reason = if payload.command == "mute" { "The host muted your microphone." } else { "The host removed you from the room." };
                            target.emit("moderation:command", &ModerationEvent { command: &payload.command, reason }).ok();
                            if payload.command == "remove" { target.disconnect().ok(); }
                        }
                    },
                );

                let message_state = state.clone();
                let message_io = io.clone();
                socket.on(
                    "message:send",
                    move |socket: SocketRef, Data(payload): Data<EncryptedPayload>| {
                        let state = message_state.clone();
                        let io = message_io.clone();
                        let rate = message_rate.clone();
                        async move {
                            if !is_admitted(&state, &socket.id.to_string()) {
                                socket.emit("room:error", "Wait for the host to admit you.").ok();
                                return;
                            }
                            if !rate_allowed(&rate, 30) {
                                socket.emit("room:error", "Slow down for a moment.").ok();
                                return;
                            }
                            if !is_base64_url(&payload.encrypted, 24_000) {
                                socket.emit("room:error", "Invalid encrypted message.").ok();
                                return;
                            }
                            let message = StoredMessage {
                                id: Uuid::new_v4().to_string(),
                                encrypted: payload.encrypted,
                                created_at: now_ms(),
                            };
                            {
                                let mut messages = state.messages.write().expect("messages lock");
                                messages.push(message.clone());
                                if messages.len() > 500 {
                                    messages.remove(0);
                                }
                            }
                            io.emit("message:new", &message).await.ok();
                        }
                    },
                );

                let meeting_state = state.clone();
                let meeting_io = io.clone();
                socket.on(
                    "meeting:signal",
                    move |socket: SocketRef, Data(payload): Data<EncryptedPayload>| {
                        let state = meeting_state.clone();
                        let io = meeting_io.clone();
                        let rate = meeting_rate.clone();
                        async move {
                            if !is_admitted(&state, &socket.id.to_string()) { return; }
                            if !rate_allowed(&rate, 40) {
                                socket.emit("room:error", "Meeting activity is moving too quickly.").ok();
                                return;
                            }
                            if !is_base64_url(&payload.encrypted, 32_000) {
                                socket.emit("room:error", "Invalid encrypted meeting activity.").ok();
                                return;
                            }
                            let signal = MeetingSignal { id: Uuid::new_v4().to_string(), encrypted: payload.encrypted, created_at: now_ms() };
                            {
                                let mut signals = state.meeting_signals.write().expect("meeting signals lock");
                                signals.push(signal.clone());
                                if signals.len() > 150 { signals.remove(0); }
                            }
                            io.emit("meeting:signal", &signal).await.ok();
                        }
                    },
                );

                let destroy_state = state.clone();
                let destroy_io = io.clone();
                socket.on(
                    "room:destroy",
                    move |socket: SocketRef, Data(payload): Data<DestroyPayload>| {
                        let state = destroy_state.clone();
                        let io = destroy_io.clone();
                        async move {
                            if !owner_matches(&state, &payload.owner_token) {
                                socket.emit("room:error", "Only the host can destroy this room.").ok();
                                return;
                            }
                            io.emit("room:destroyed", &()).await.ok();
                            sleep(Duration::from_millis(350)).await;
                            let _ = state.shutdown.send(());
                        }
                    },
                );

                let start_state = state.clone();
                let start_io = io.clone();
                let presenter_id = socket_id.clone();
                socket.on(
                    "screen:start",
                    move |socket: SocketRef, Data(payload): Data<EncryptedPayload>, ack: AckSender| {
                        let state = start_state.clone();
                        let io = start_io.clone();
                        let presenter = presenter_id.clone();
                        async move {
                            if !is_admitted(&state, &socket.id.to_string()) {
                                ack.send(&AckResult { ok: false, error: Some("Wait for the host to admit you.") }).ok();
                                return;
                            }
                            if !is_base64_url(&payload.encrypted, 4_096) {
                                ack.send(&AckResult { ok: false, error: Some("Invalid encrypted presentation metadata.") }).ok();
                                return;
                            }
                            let start = ScreenStart { id: Uuid::new_v4().to_string(), encrypted: payload.encrypted, created_at: now_ms() };
                            let stream_id = start.id.clone();
                            let started = {
                                let mut active = state.active_screen.lock().expect("screen lock");
                                if active.is_some() {
                                    false
                                } else {
                                    *active = Some(ActiveScreen { presenter_socket_id: presenter, start: start.clone(), chunks: Vec::new(), encrypted_bytes: 0 });
                                    true
                                }
                            };
                            if !started {
                                ack.send(&AckResult { ok: false, error: Some("Someone is already presenting.") }).ok();
                                return;
                            }
                            io.emit("screen:start", &start).await.ok();
                            ack.send(&AckResult { ok: true, error: None }).ok();
                            let timeout_state = state.clone();
                            let timeout_io = io.clone();
                            tokio::spawn(async move {
                                sleep(Duration::from_secs(timeout_state.screen_max_minutes * 60)).await;
                                let is_same = timeout_state.active_screen.lock().expect("screen lock").as_ref().is_some_and(|screen| screen.start.id == stream_id);
                                if is_same { stop_active_screen(&timeout_state, &timeout_io, "limit").await; }
                            });
                        }
                    },
                );

                let chunk_state = state.clone();
                let chunk_io = io.clone();
                let chunk_presenter_id = socket_id.clone();
                socket.on(
                    "screen:chunk",
                    move |socket: SocketRef, Data(payload): Data<EncryptedPayload>| {
                        let state = chunk_state.clone();
                        let io = chunk_io.clone();
                        let rate = screen_rate.clone();
                        let presenter = chunk_presenter_id.clone();
                        async move {
                            if !rate_allowed(&rate, 30) || !is_base64_url(&payload.encrypted, 2_000_000) {
                                stop_active_screen(&state, &io, "limit").await;
                                return;
                            }
                            let outcome = {
                                let mut active = state.active_screen.lock().expect("screen lock");
                                active.as_mut().and_then(|screen| {
                                    if screen.presenter_socket_id != presenter { return None; }
                                    let chunk = ScreenChunk { stream_id: screen.start.id.clone(), sequence: screen.chunks.len(), encrypted: payload.encrypted };
                                    screen.encrypted_bytes += chunk.encrypted.len();
                                    screen.chunks.push(chunk.clone());
                                    let exceeded = screen.chunks.len() > 500 || screen.encrypted_bytes > 64 * 1024 * 1024;
                                    Some((chunk, exceeded))
                                })
                            };
                            let Some((chunk, exceeded)) = outcome else { return };
                            if exceeded {
                                stop_active_screen(&state, &io, "limit").await;
                                return;
                            }
                            socket.broadcast().emit("screen:chunk", &chunk).await.ok();
                        }
                    },
                );

                let stop_state = state.clone();
                let stop_io = io.clone();
                let stop_presenter_id = socket_id.clone();
                socket.on("screen:stop", move || {
                    let state = stop_state.clone();
                    let io = stop_io.clone();
                    let presenter = stop_presenter_id.clone();
                    async move {
                        let is_presenter = state.active_screen.lock().expect("screen lock").as_ref().is_some_and(|screen| screen.presenter_socket_id == presenter);
                        if is_presenter { stop_active_screen(&state, &io, "presenter").await; }
                    }
                });

                let media_present_state = state.clone();
                let media_presenter_id = socket_id.clone();
                socket.on(
                    "media:present:start",
                    move |socket: SocketRef, Data(_payload): Data<EmptyPayload>, ack: AckSender| {
                        let state = media_present_state.clone();
                        let presenter = media_presenter_id.clone();
                        async move {
                            if !is_admitted(&state, &socket.id.to_string()) {
                                ack.send(&AckResult { ok: false, error: Some("Wait for the host to admit you.") }).ok();
                                return;
                            }
                            let mut active = state.media_presenter.lock().expect("media presenter lock");
                            if active.as_ref().is_some_and(|current| current != &presenter) {
                                ack.send(&AckResult { ok: false, error: Some("Someone is already presenting.") }).ok();
                                return;
                            }
                            *active = Some(presenter);
                            ack.send(&AckResult { ok: true, error: None }).ok();
                        }
                    },
                );

                let media_stop_state = state.clone();
                let media_stop_id = socket_id.clone();
                socket.on("media:present:stop", move || {
                    let state = media_stop_state.clone();
                    let presenter = media_stop_id.clone();
                    async move {
                        let mut active = state.media_presenter.lock().expect("media presenter lock");
                        if active.as_ref() == Some(&presenter) { *active = None; }
                    }
                });

                let disconnect_state = state.clone();
                let disconnect_io = io.clone();
                socket.on_disconnect(move |socket: SocketRef| {
                    let state = disconnect_state.clone();
                    let io = disconnect_io.clone();
                    async move {
                        let disconnected_id = socket.id.to_string();
                        state.connections.fetch_sub(1, Ordering::SeqCst);
                        let was_presenter = state.active_screen.lock().expect("screen lock").as_ref().is_some_and(|screen| screen.presenter_socket_id == disconnected_id);
                        if was_presenter { stop_active_screen(&state, &io, "disconnected").await; }
                        {
                            let mut active = state.media_presenter.lock().expect("media presenter lock");
                            if active.as_ref() == Some(&disconnected_id) { *active = None; }
                        }
                        state.aliases.write().expect("aliases lock").remove(&disconnected_id);
                        state.pending_aliases.write().expect("pending aliases lock").remove(&disconnected_id);
                        state.owner_sockets.write().expect("owner sockets lock").remove(&disconnected_id);
                        state.sockets.write().expect("sockets lock").remove(&disconnected_id);
                        io.emit("presence", &presence_snapshot(&state)).await.ok();
                        emit_pending(&state);
                    }
                });
            }
        },
    );
}

async fn add_route(state: &AppState, io: &SocketIo, route: PublicRoute) {
    let snapshot = {
        let mut routes = state.routes.write().expect("routes lock");
        if routes
            .iter()
            .any(|item| item.r#type == route.r#type && item.base_url == route.base_url)
        {
            return;
        }
        routes.push(route.clone());
        routes.clone()
    };
    io.emit("routes", &snapshot).await.ok();
    println!(
        "Guest {} route: {}/room/{}#k=<copied-from-host-screen>",
        route.r#type, route.base_url, state.room_id
    );
}

fn launch_cloudflare(state: Arc<AppState>, io: SocketIo, owner_token: String) {
    tokio::spawn(async move {
        let mut child = match Command::new("cloudflared")
            .args([
                "tunnel",
                "--url",
                &format!("http://127.0.0.1:{}", env_number("PORT", 3000, 1, 65_535)),
                "--no-autoupdate",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(_) => {
                println!("Normal-browser route unavailable: install cloudflared or use CINDER_ROUTES=local.");
                return;
            }
        };
        let stderr = child.stderr.take().expect("cloudflared stderr");
        let mut lines = BufReader::new(stderr).lines();
        let mut shutdown = state.shutdown.subscribe();
        loop {
            tokio::select! {
                _ = shutdown.recv() => { let _ = child.kill().await; break; }
                line = lines.next_line() => match line {
                    Ok(Some(line)) => {
                        if let Some(start) = line.find("https://") {
                            let candidate = line[start..].split_whitespace().next().unwrap_or_default().trim_end_matches(|value: char| !value.is_ascii_alphanumeric() && value != '/');
                            if candidate.ends_with(".trycloudflare.com") {
                                add_route(&state, &io, PublicRoute { r#type: "cloudflare", base_url: candidate.to_owned() }).await;
                                println!("Host browser link: {candidate}/room/{}#o={owner_token}", state.room_id);
                            }
                        }
                    }
                    _ => break,
                }
            }
        }
    });
}

fn launch_tor(state: Arc<AppState>, io: SocketIo, owner_token: String, port: u16) {
    tokio::spawn(async move {
        let tor_data = state._run_dir.path().join("tor-data");
        let hidden_service = state._run_dir.path().join("onion-service");
        if tokio::fs::create_dir_all(&tor_data).await.is_err()
            || tokio::fs::create_dir_all(&hidden_service).await.is_err()
        {
            return;
        }
        if restrict_directory(&tor_data).is_err() || restrict_directory(&hidden_service).is_err() {
            return;
        }
        let mut child = match Command::new("tor")
            .args([
                "--DataDirectory",
                &tor_data.to_string_lossy(),
                "--HiddenServiceDir",
                &hidden_service.to_string_lossy(),
                "--HiddenServiceVersion",
                "3",
                "--HiddenServicePort",
                &format!("80 127.0.0.1:{port}"),
                "--SocksPort",
                "0",
                "--Log",
                "notice stdout",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(_) => {
                println!("Tor route unavailable: install the Tor daemon or use CINDER_ROUTES=local.");
                return;
            }
        };
        let hostname_path = hidden_service.join("hostname");
        let mut poll = interval(Duration::from_millis(500));
        poll.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut shutdown = state.shutdown.subscribe();
        loop {
            tokio::select! {
                _ = shutdown.recv() => { let _ = child.kill().await; break; }
                _ = poll.tick() => {
                    if let Ok(hostname) = tokio::fs::read_to_string(&hostname_path).await {
                        let base_url = format!("http://{}", hostname.trim());
                        add_route(&state, &io, PublicRoute { r#type: "onion", base_url: base_url.clone() }).await;
                        println!("Host Tor link: {base_url}/room/{}#o={owner_token}", state.room_id);
                        tokio::select! {
                            _ = shutdown.recv() => { let _ = child.kill().await; }
                            _ = child.wait() => {}
                        }
                        break;
                    }
                    if child.try_wait().ok().flatten().is_some() { break; }
                }
            }
        }
    });
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port = env_number("PORT", 3000, 1, 65_535) as u16;
    let max_file_mb = env_number("MAX_FILE_MB", 100, 1, 1_024) as usize;
    let max_participants = env_number("MAX_PARTICIPANTS", 50, 2, 500) as usize;
    let max_concurrent_uploads = env_number("MAX_CONCURRENT_UPLOADS", 4, 1, 32) as usize;
    let max_files = env_number("MAX_FILES", 200, 1, 10_000) as usize;
    let max_room_storage_mb = env_number("MAX_ROOM_STORAGE_MB", 1_024, max_file_mb as u64, 102_400) as usize;
    let room_ttl_minutes = env_number("ROOM_TTL_MINUTES", 180, 5, 10_080);
    let screen_max_minutes = env_number("SCREEN_MAX_MINUTES", 5, 1, 30);
    let route_mode = env::var("CINDER_ROUTES").unwrap_or_else(|_| "both".to_owned());
    let livekit_url = env::var("LIVEKIT_URL").unwrap_or_default();
    let livekit_api_key = env::var("LIVEKIT_API_KEY").unwrap_or_default();
    let livekit_api_secret = env::var("LIVEKIT_API_SECRET").unwrap_or_default();
    let bind_address = env::var("CINDER_BIND").unwrap_or_else(|_| "127.0.0.1".to_owned());
    let room_id = random_token(18);
    let owner_token = random_token(32);
    let owner_hash: [u8; 32] = Sha256::digest(owner_token.as_bytes()).into();
    let run_dir = tempfile::Builder::new().prefix("cinder-room-").tempdir()?;
    let file_dir = run_dir.path().join("ciphertext");
    std::fs::create_dir_all(&file_dir)?;
    restrict_directory(&file_dir)?;
    let (shutdown, _) = broadcast::channel(8);
    let (file_events, _) = broadcast::channel(64);
    let (socket_layer, io) = SocketIo::builder()
        .max_payload(2 * 1024 * 1024)
        .build_layer();
    let state = Arc::new(AppState {
        room_id: room_id.clone(),
        owner_hash,
        max_file_bytes: max_file_mb * 1024 * 1024,
        max_participants,
        max_concurrent_uploads,
        max_files,
        max_room_storage_bytes: max_room_storage_mb * 1024 * 1024,
        room_ttl_minutes,
        screen_max_minutes,
        livekit_url,
        livekit_api_key,
        livekit_api_secret,
        ui_dir: env::current_dir()?.join("self-host-dist"),
        file_dir,
        messages: RwLock::new(Vec::new()),
        meeting_signals: RwLock::new(Vec::new()),
        files: RwLock::new(HashMap::new()),
        aliases: RwLock::new(HashMap::new()),
        pending_aliases: RwLock::new(HashMap::new()),
        owner_sockets: RwLock::new(HashSet::new()),
        sockets: RwLock::new(HashMap::new()),
        routes: RwLock::new(vec![PublicRoute {
            r#type: "local",
            base_url: format!("http://localhost:{port}"),
        }]),
        active_screen: Mutex::new(None),
        media_presenter: Mutex::new(None),
        admission_locked: AtomicBool::new(false),
        connections: AtomicUsize::new(0),
        active_uploads: AtomicUsize::new(0),
        reserved_files: AtomicUsize::new(0),
        stored_ciphertext_bytes: AtomicUsize::new(0),
        file_events,
        shutdown,
        _run_dir: run_dir,
    });

    configure_socket_io(&io, state.clone());

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/routes", get(route_list))
        .route("/api/media-token", get(media_token))
        .route(
            "/api/files",
            get(file_list)
                .post(upload_file)
                .layer(DefaultBodyLimit::max(state.max_file_bytes + 28)),
        )
        .route("/api/files/{id}", get(download_file))
        .route("/room/{room}", get(room_page))
        .route("/{name}", get(static_asset))
        .route("/", get(root_page))
        .fallback(|| async { (StatusCode::NOT_FOUND, "Room unavailable") })
        .layer(middleware::from_fn(security_headers))
        .layer(socket_layer)
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind((bind_address.as_str(), port)).await?;
    println!("\nCinder Room v0.9.0 Rust relay is live");
    println!("Host local link: http://localhost:{port}/room/{room_id}#o={owner_token}");
    println!("Open a host link, choose an alias, then use Invite to copy guest links.");
    println!("The room will self-destruct after {room_ttl_minutes} minutes. Press Ctrl+C to end it now.\n");
    println!("Guardrails: {max_participants} participants, {max_concurrent_uploads} concurrent uploads, {max_files} files, {max_room_storage_mb} MB ciphertext storage.\n");

    if route_mode == "both" || route_mode.contains("cloudflare") {
        launch_cloudflare(state.clone(), io.clone(), owner_token.clone());
    }
    if route_mode == "both" || route_mode.contains("tor") {
        launch_tor(state.clone(), io.clone(), owner_token, port);
    }

    let ttl_shutdown = state.shutdown.clone();
    tokio::spawn(async move {
        sleep(Duration::from_secs(room_ttl_minutes * 60)).await;
        println!("Room lifetime ended.");
        let _ = ttl_shutdown.send(());
    });

    let mut server_shutdown = state.shutdown.subscribe();
    let signal_shutdown = state.shutdown.clone();
    tokio::spawn(async move {
        shutdown_signal().await;
        println!("Server stopped. Temporary room data deleted.");
        let _ = signal_shutdown.send(());
    });

    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = server_shutdown.recv().await;
        })
        .await?;
    drop(io);
    println!("Temporary ciphertext and Onion Service identity deleted.");
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut terminate) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_only_bounded_base64url_ciphertext() {
        assert!(is_base64_url(&"A".repeat(24), 64));
        assert!(!is_base64_url("too-short", 64));
        assert!(!is_base64_url(&format!("{}+", "A".repeat(24)), 64));
        assert!(!is_base64_url(&"A".repeat(65), 64));
    }

    #[test]
    fn random_room_tokens_are_url_safe() {
        let token = random_token(32);
        assert!(token.len() >= 40);
        assert!(token.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'));
    }
}
