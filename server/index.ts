import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { Server, type Socket } from "socket.io";

type StoredMessage = { id: string; encrypted: string; createdAt: number };
type MeetingSignal = { id: string; encrypted: string; createdAt: number };
type StoredFile = { id: string; encryptedMeta: string; encryptedSize: number; createdAt: number; path: string; uploaderSocketId: string };
type PublicFile = Omit<StoredFile, "path">;
type PublicRoute = { type: "local" | "onion" | "cloudflare"; baseUrl: string };
type ScreenStart = { id: string; encrypted: string; createdAt: number };
type ScreenChunk = { streamId: string; sequence: number; encrypted: string };
type ActiveScreen = {
  presenterSocketId: string;
  start: ScreenStart;
  chunks: ScreenChunk[];
  encryptedBytes: number;
  timeout: NodeJS.Timeout;
};

const ENV_PATH = resolve(process.cwd(), ".env");
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const BIND = process.env.CINDER_BIND ?? "127.0.0.1";
const MAX_FILE_MB = Math.min(Math.max(Number.parseInt(process.env.MAX_FILE_MB ?? "100", 10), 1), 1024);
const MAX_PARTICIPANTS = Math.min(Math.max(Number.parseInt(process.env.MAX_PARTICIPANTS ?? "50", 10), 2), 500);
const MAX_CONCURRENT_UPLOADS = Math.min(Math.max(Number.parseInt(process.env.MAX_CONCURRENT_UPLOADS ?? "4", 10), 1), 32);
const MAX_FILES = Math.min(Math.max(Number.parseInt(process.env.MAX_FILES ?? "200", 10), 1), 10_000);
const MAX_ROOM_STORAGE_MB = Math.min(Math.max(Number.parseInt(process.env.MAX_ROOM_STORAGE_MB ?? "1024", 10), MAX_FILE_MB), 102_400);
const ROOM_TTL_MINUTES = Math.min(Math.max(Number.parseInt(process.env.ROOM_TTL_MINUTES ?? "180", 10), 5), 10_080);
const SCREEN_MAX_MINUTES = Math.min(Math.max(Number.parseInt(process.env.SCREEN_MAX_MINUTES ?? "5", 10), 1), 30);
const ROUTE_MODE = process.env.CINDER_ROUTES ?? "both";
const LIVEKIT_URL = process.env.LIVEKIT_URL ?? "";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? "";
const UI_DIR = resolve(process.cwd(), "self-host-dist");
const roomId = randomBytes(18).toString("base64url");
const ownerToken = randomBytes(32).toString("base64url");
const ownerHash = createHash("sha256").update(ownerToken).digest();
const RUN_DIR = mkdtempSync(join(tmpdir(), "cinder-room-"));
const FILE_DIR = join(RUN_DIR, "ciphertext");
mkdirSync(FILE_DIR, { recursive: true, mode: 0o700 });

const messages: StoredMessage[] = [];
const meetingSignals: MeetingSignal[] = [];
const files = new Map<string, StoredFile>();
const aliases = new Map<string, string>();
const pendingAliases = new Map<string, string>();
const ownerSockets = new Set<string>();
const routes: PublicRoute[] = [{ type: "local", baseUrl: `http://localhost:${PORT}` }];
const children = new Set<ChildProcess>();
let shuttingDown = false;
let activeScreen: ActiveScreen | null = null;
let activeMediaPresenter: string | null = null;
let admissionLocked = false;
let activeUploads = 0;
let storedCiphertextBytes = 0;

function publicFile(file: StoredFile): PublicFile {
  return { id: file.id, encryptedMeta: file.encryptedMeta, encryptedSize: file.encryptedSize, createdAt: file.createdAt };
}

function isBase64Url(value: unknown, maximum: number) {
  return typeof value === "string" && value.length >= 24 && value.length <= maximum && /^[A-Za-z0-9_-]+$/.test(value);
}

function ownerMatches(candidate: unknown) {
  if (typeof candidate !== "string") return false;
  const hash = createHash("sha256").update(candidate).digest();
  return hash.length === ownerHash.length && timingSafeEqual(hash, ownerHash);
}

function createMediaToken(encryptedAlias: string, identity: string) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    iss: LIVEKIT_API_KEY,
    sub: identity,
    nbf: now - 5,
    exp: now + 15 * 60,
    metadata: encryptedAlias,
    video: { room: roomId, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false },
  });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac("sha256", LIVEKIT_API_SECRET).update(unsigned).digest("base64url")}`;
}

function mediaUrlForRequest(request: Request) {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return "";
  try {
    const media = new URL(LIVEKIT_URL);
    const requestHost = request.hostname.toLowerCase();
    const mediaIsLocal = media.hostname === "localhost" || media.hostname === "127.0.0.1" || media.hostname === "::1";
    const requestIsLocal = requestHost === "localhost" || requestHost === "127.0.0.1" || requestHost === "::1";
    return mediaIsLocal && !requestIsLocal ? "" : LIVEKIT_URL;
  } catch {
    return "";
  }
}

function documentHtml() {
  return `<!doctype html>
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
</html>`;
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", false);
app.use((_request, response, next) => {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()");
  response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  next();
});

function isLocalRequest(request: Request) {
  const host = request.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

app.get("/api/session", (request, response) => {
  if (!isLocalRequest(request)) return response.status(403).json({ error: "Open the local host link to fetch a fresh session." });
  return response.json({ roomId, ownerToken, routes });
});

app.get("/api/health", (_request, response) => response.json({
  ok: true,
  relay: "node",
  expiresInMinutes: ROOM_TTL_MINUTES,
  maxFileMb: MAX_FILE_MB,
  mediaConfigured: Boolean(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET),
  limits: {
    participants: MAX_PARTICIPANTS,
    concurrentUploads: MAX_CONCURRENT_UPLOADS,
    files: MAX_FILES,
    roomStorageMb: MAX_ROOM_STORAGE_MB,
    messagesPerTenSeconds: 30,
  },
}));
app.get("/api/routes", (_request, response) => response.json(routes));
app.get("/api/media-token", (request, response) => {
  if (request.query.room !== roomId) return response.status(404).json({ error: "Room unavailable" });
  const encryptedAlias = request.header("X-Cinder-Alias") ?? "";
  const socketId = request.header("X-Cinder-Socket") ?? "";
  if (!isBase64Url(encryptedAlias, 2048) || aliases.get(socketId) !== encryptedAlias) {
    return response.status(403).json({ error: "Join the encrypted room before starting media." });
  }
  const serverUrl = mediaUrlForRequest(request);
  if (!serverUrl) {
    return response.status(503).json({ error: "Group video needs a public LiveKit/TURN endpoint. Cloudflare Quick Tunnel carries the room page, but not the required UDP media path." });
  }
  return response.status(201).json({ serverUrl, participantToken: createMediaToken(encryptedAlias, socketId) });
});
app.get("/api/files", (request, response) => {
  if (request.query.room !== roomId) return response.status(404).json({ error: "Room unavailable" });
  return response.json(Array.from(files.values()).map(publicFile).sort((a, b) => b.createdAt - a.createdAt));
});

app.post("/api/files", (request, response, next) => {
  if (request.header("X-Cinder-Room") !== roomId) return response.status(400).json({ error: "Invalid encrypted upload" });
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) return response.status(429).json({ error: "All encrypted upload lanes are busy. Try again shortly." });
  if (files.size >= MAX_FILES) return response.status(507).json({ error: "This room reached its temporary file limit." });
  const declaredSize = Number.parseInt(request.header("Content-Length") ?? "0", 10);
  if (declaredSize > MAX_FILE_MB * 1024 * 1024 + 28) return response.status(413).json({ error: "Encrypted file exceeds this room's limit" });
  if (declaredSize > 0 && storedCiphertextBytes + declaredSize > MAX_ROOM_STORAGE_MB * 1024 * 1024) return response.status(507).json({ error: "This room reached its temporary storage limit." });
  activeUploads += 1;
  let released = false;
  const release = () => { if (!released) { released = true; activeUploads = Math.max(0, activeUploads - 1); } };
  response.once("finish", release);
  response.once("close", release);
  return next();
}, express.raw({ type: "application/octet-stream", limit: `${MAX_FILE_MB + 1}mb` }), (request, response) => {
  const room = request.header("X-Cinder-Room");
  const encryptedMeta = request.header("X-Cinder-Meta");
  const uploaderSocketId = request.header("X-Cinder-Socket") ?? "";
  if (room !== roomId || !isBase64Url(encryptedMeta, 16_384) || !Buffer.isBuffer(request.body)) return response.status(400).json({ error: "Invalid encrypted upload" });
  if (request.body.byteLength < 29 || request.body.byteLength > MAX_FILE_MB * 1024 * 1024 + 28) return response.status(413).json({ error: "Encrypted file exceeds this room's limit" });
  if (files.size >= MAX_FILES || storedCiphertextBytes + request.body.byteLength > MAX_ROOM_STORAGE_MB * 1024 * 1024) return response.status(507).json({ error: "This room reached its temporary storage limit." });
  const id = randomUUID();
  const filePath = join(FILE_DIR, `${id}.bin`);
  writeFileSync(filePath, request.body, { mode: 0o600, flag: "wx" });
  const item: StoredFile = { id, encryptedMeta: encryptedMeta as string, encryptedSize: request.body.byteLength, createdAt: Date.now(), path: filePath, uploaderSocketId };
  files.set(id, item);
  storedCiphertextBytes += item.encryptedSize;
  io.emit("file:added", publicFile(item));
  return response.status(201).json(publicFile(item));
});

app.get("/api/files/:id", (request, response) => {
  if (request.query.room !== roomId) return response.status(404).end();
  const item = files.get(request.params.id);
  if (!item || !existsSync(item.path)) return response.status(404).end();
  response.setHeader("Content-Type", "application/octet-stream");
  response.setHeader("Content-Length", String(item.encryptedSize));
  return response.sendFile(item.path);
});

app.delete("/api/files/:id", (request, response) => {
  if (request.query.room !== roomId) return response.status(404).json({ error: "Room unavailable" });
  const item = files.get(request.params.id);
  if (!item) return response.status(404).json({ error: "File unavailable" });
  const socketId = request.header("X-Cinder-Socket") ?? "";
  const isOwner = ownerMatches(request.header("X-Cinder-Owner-Token"));
  if (item.uploaderSocketId !== socketId && !isOwner) return response.status(403).json({ error: "Only the sender or host can delete this file." });
  if (existsSync(item.path)) rmSync(item.path);
  storedCiphertextBytes = Math.max(0, storedCiphertextBytes - item.encryptedSize);
  files.delete(request.params.id);
  io.emit("file:removed", { id: request.params.id });
  return response.status(204).end();
});

app.get("/app.js", (_request, response) => response.sendFile(join(UI_DIR, "app.js")));
app.get("/app.css", (_request, response) => response.sendFile(join(UI_DIR, "app.css")));
app.get("/e2ee-worker.js", (_request, response) => response.type("text/javascript").sendFile(join(UI_DIR, "e2ee-worker.js")));
app.get("/room/:room", (request, response) => {
  if (request.params.room !== roomId) return response.status(404).type("text").send("Room unavailable");
  return response.type("html").send(documentHtml());
});
app.get("/", (_request, response) => response.status(403).type("text").send("Open the private host link printed by the Cinder Room server."));
app.use((_request, response) => response.status(404).type("text").send("Room unavailable"));
app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
  void next;
  if (error && typeof error === "object" && "type" in error && error.type === "entity.too.large") return response.status(413).json({ error: `Files are limited to ${MAX_FILE_MB} MB` });
  return response.status(500).json({ error: "Temporary relay error" });
});

const server = createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2 * 1024 * 1024, serveClient: false, transports: ["websocket", "polling"], cors: { origin: false } });
io.use((socket, next) => {
  if (socket.handshake.auth.room !== roomId) return next(new Error("Room unavailable"));
  if (io.of("/").sockets.size >= MAX_PARTICIPANTS) return next(new Error(`Room is full (${MAX_PARTICIPANTS} participants).`));
  return next();
});

function stopActiveScreen(reason: "presenter" | "disconnected" | "limit") {
  if (!activeScreen) return;
  clearTimeout(activeScreen.timeout);
  activeScreen = null;
  io.emit("screen:stop", { reason });
}

function emitPending() {
  const pending = Array.from(pendingAliases, ([id, encryptedAlias]) => ({ id, encryptedAlias }));
  for (const ownerId of ownerSockets) io.to(ownerId).emit("admission:pending", pending);
}

function admit(socket: Socket, encryptedAlias: string) {
  pendingAliases.delete(socket.id);
  aliases.set(socket.id, encryptedAlias);
  socket.emit("admission:admitted", { locked: admissionLocked });
  socket.emit("messages:init", messages);
  socket.emit("meeting:signals:init", meetingSignals);
  if (activeScreen) socket.emit("screen:state", { start: activeScreen.start, chunks: activeScreen.chunks });
  io.emit("presence", Array.from(aliases.entries()).map(([id, aliasValue]) => ({ id, encryptedAlias: aliasValue })));
  emitPending();
}

io.on("connection", (socket) => {
  let sentInWindow = 0;
  let windowStarted = Date.now();
  let meetingInWindow = 0;
  let meetingWindowStarted = Date.now();
  let screenChunksInWindow = 0;
  let screenWindowStarted = Date.now();
  socket.on("room:join", (payload: { encryptedAlias?: unknown; ownerToken?: unknown }) => {
    if (!isBase64Url(payload?.encryptedAlias, 2048)) return socket.emit("room:error", "Invalid encrypted alias.");
    const isOwner = ownerMatches(payload?.ownerToken);
    if (isOwner) ownerSockets.add(socket.id);
    if (admissionLocked && !isOwner) {
      pendingAliases.set(socket.id, payload.encryptedAlias as string);
      socket.emit("admission:waiting");
      emitPending();
      return;
    }
    admit(socket, payload.encryptedAlias as string);
  });

  socket.on("admission:lock", (payload: { ownerToken?: unknown; locked?: unknown }) => {
    if (!ownerMatches(payload?.ownerToken) || typeof payload?.locked !== "boolean") return socket.emit("room:error", "Only the host can change admission.");
    admissionLocked = payload.locked;
    io.emit("admission:state", { locked: admissionLocked });
  });

  socket.on("admission:decide", (payload: { ownerToken?: unknown; socketId?: unknown; allow?: unknown }) => {
    if (!ownerMatches(payload?.ownerToken) || typeof payload?.socketId !== "string" || typeof payload?.allow !== "boolean") return socket.emit("room:error", "Invalid admission decision.");
    const encryptedAlias = pendingAliases.get(payload.socketId);
    const target = io.sockets.sockets.get(payload.socketId);
    if (!encryptedAlias || !target) return;
    if (payload.allow) admit(target, encryptedAlias);
    else { pendingAliases.delete(payload.socketId); target.emit("moderation:command", { command: "remove", reason: "The host declined this request." }); target.disconnect(true); emitPending(); }
  });

  socket.on("moderation:command", (payload: { ownerToken?: unknown; target?: unknown; command?: unknown }) => {
    if (!ownerMatches(payload?.ownerToken) || typeof payload?.target !== "string" || !["mute", "remove"].includes(String(payload?.command))) return socket.emit("room:error", "Invalid host action.");
    const target = io.sockets.sockets.get(payload.target);
    if (!target || ownerSockets.has(target.id)) return;
    target.emit("moderation:command", { command: payload.command, reason: payload.command === "mute" ? "The host muted your microphone." : "The host removed you from the room." });
    if (payload.command === "remove") target.disconnect(true);
  });

  socket.on("message:send", (payload: { encrypted?: unknown }) => {
    if (!aliases.has(socket.id)) return socket.emit("room:error", "Wait for the host to admit you.");
    const now = Date.now();
    if (now - windowStarted > 10_000) { windowStarted = now; sentInWindow = 0; }
    sentInWindow += 1;
    if (sentInWindow > 30) return socket.emit("room:error", "Slow down for a moment.");
    if (!isBase64Url(payload?.encrypted, 24_000)) return socket.emit("room:error", "Invalid encrypted message.");
    const item: StoredMessage = { id: randomUUID(), encrypted: payload.encrypted as string, createdAt: now };
    messages.push(item);
    if (messages.length > 500) messages.shift();
    io.emit("message:new", item);
  });

  socket.on("meeting:signal", (payload: { encrypted?: unknown }) => {
    if (!aliases.has(socket.id)) return;
    const now = Date.now();
    if (now - meetingWindowStarted > 10_000) { meetingWindowStarted = now; meetingInWindow = 0; }
    meetingInWindow += 1;
    if (meetingInWindow > 40) return socket.emit("room:error", "Meeting activity is moving too quickly.");
    if (!isBase64Url(payload?.encrypted, 32_000)) return socket.emit("room:error", "Invalid encrypted meeting activity.");
    const item: MeetingSignal = { id: randomUUID(), encrypted: payload.encrypted as string, createdAt: now };
    meetingSignals.push(item);
    if (meetingSignals.length > 150) meetingSignals.shift();
    io.emit("meeting:signal", item);
  });

  socket.on("room:destroy", (payload: { ownerToken?: unknown }) => {
    if (!ownerMatches(payload?.ownerToken)) return socket.emit("room:error", "Only the host can destroy this room.");
    socket.emit("room:restarting", { countdownSeconds: 10 });
    for (const peer of io.sockets.sockets.values()) {
      if (peer.id !== socket.id) peer.emit("room:destroyed");
    }
    setTimeout(() => shutdown("Host destroyed the room."), 350).unref();
  });

  socket.on("screen:start", (payload: { encrypted?: unknown }, acknowledge?: (result: { ok: boolean; error?: string }) => void) => {
    if (!aliases.has(socket.id)) { acknowledge?.({ ok: false, error: "Wait for the host to admit you." }); return; }
    if (activeScreen) { acknowledge?.({ ok: false, error: "Someone is already presenting." }); return; }
    if (!isBase64Url(payload?.encrypted, 4096)) { acknowledge?.({ ok: false, error: "Invalid encrypted presentation metadata." }); return; }
    const start: ScreenStart = { id: randomUUID(), encrypted: payload.encrypted as string, createdAt: Date.now() };
    const timeout = setTimeout(() => stopActiveScreen("limit"), SCREEN_MAX_MINUTES * 60_000);
    timeout.unref();
    activeScreen = { presenterSocketId: socket.id, start, chunks: [], encryptedBytes: 0, timeout };
    io.emit("screen:start", start);
    acknowledge?.({ ok: true });
  });

  socket.on("screen:chunk", (payload: { encrypted?: unknown }) => {
    if (!activeScreen || activeScreen.presenterSocketId !== socket.id) return;
    const now = Date.now();
    if (now - screenWindowStarted > 10_000) { screenWindowStarted = now; screenChunksInWindow = 0; }
    screenChunksInWindow += 1;
    if (screenChunksInWindow > 30) return stopActiveScreen("limit");
    if (!isBase64Url(payload?.encrypted, 2_000_000)) return stopActiveScreen("limit");
    const chunk: ScreenChunk = { streamId: activeScreen.start.id, sequence: activeScreen.chunks.length, encrypted: payload.encrypted as string };
    activeScreen.chunks.push(chunk);
    activeScreen.encryptedBytes += chunk.encrypted.length;
    if (activeScreen.chunks.length > 500 || activeScreen.encryptedBytes > 64 * 1024 * 1024) return stopActiveScreen("limit");
    socket.broadcast.emit("screen:chunk", chunk);
  });

  socket.on("screen:stop", () => {
    if (activeScreen?.presenterSocketId === socket.id) stopActiveScreen("presenter");
  });

  socket.on("media:present:start", (_payload: Record<string, never>, acknowledge?: (result: { ok: boolean; error?: string }) => void) => {
    if (!aliases.has(socket.id)) { acknowledge?.({ ok: false, error: "Wait for the host to admit you." }); return; }
    if (activeMediaPresenter && activeMediaPresenter !== socket.id) {
      acknowledge?.({ ok: false, error: "Someone is already presenting." });
      return;
    }
    activeMediaPresenter = socket.id;
    acknowledge?.({ ok: true });
  });

  socket.on("media:present:stop", () => {
    if (activeMediaPresenter === socket.id) activeMediaPresenter = null;
  });

  socket.on("disconnect", () => {
    if (activeScreen?.presenterSocketId === socket.id) stopActiveScreen("disconnected");
    if (activeMediaPresenter === socket.id) activeMediaPresenter = null;
    aliases.delete(socket.id);
    pendingAliases.delete(socket.id);
    ownerSockets.delete(socket.id);
    io.emit("presence", Array.from(aliases.entries()).map(([id, aliasValue]) => ({ id, encryptedAlias: aliasValue })));
    emitPending();
  });
});

function addRoute(route: PublicRoute) {
  if (!routes.some((item) => item.type === route.type && item.baseUrl === route.baseUrl)) {
    routes.push(route);
    io.emit("routes", routes);
    console.log(`Guest ${route.type} route: ${route.baseUrl}/room/${roomId}#k=<copied-from-host-screen>`);
  }
}

function trackChild(child: ChildProcess) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.once("error", () => children.delete(child));
  return child;
}

function startCloudflare() {
  const child = trackChild(spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${PORT}`, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] }));
  let found = false;
  const inspect = (chunk: Buffer) => {
    if (found) return;
    const match = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match) { found = true; addRoute({ type: "cloudflare", baseUrl: match[0] }); console.log(`Host browser link: ${match[0]}/room/${roomId}#o=${ownerToken}`); }
  };
  child.stdout?.on("data", inspect);
  child.stderr?.on("data", inspect);
  child.on("error", () => console.log("Normal-browser route unavailable: install cloudflared or use CINDER_ROUTES=local."));
}

function startTor() {
  const torData = join(RUN_DIR, "tor-data");
  const hiddenService = join(RUN_DIR, "onion-service");
  mkdirSync(torData, { recursive: true, mode: 0o700 });
  const child = trackChild(spawn("tor", ["--DataDirectory", torData, "--HiddenServiceDir", hiddenService, "--HiddenServiceVersion", "3", "--HiddenServicePort", `80 127.0.0.1:${PORT}`, "--SocksPort", "0", "--Log", "notice stdout"], { stdio: ["ignore", "pipe", "pipe"] }));
  child.stdout?.resume();
  child.stderr?.resume();
  child.on("error", () => console.log("Tor route unavailable: install the Tor daemon or use CINDER_ROUTES=local."));
  let attempts = 0;
  const poll = setInterval(() => {
    attempts += 1;
    const hostnamePath = join(hiddenService, "hostname");
    if (existsSync(hostnamePath)) {
      clearInterval(poll);
      const baseUrl = `http://${readFileSync(hostnamePath, "utf8").trim()}`;
      addRoute({ type: "onion", baseUrl });
      console.log(`Host Tor link: ${baseUrl}/room/${roomId}#o=${ownerToken}`);
    } else if (attempts > 180 || child.exitCode !== null) clearInterval(poll);
  }, 500);
  poll.unref();
}

function printHostLinks(label = "Cinder Room is live") {
  console.log(`\n${label}`);
  console.log(`Host local link: http://localhost:${PORT}/room/${roomId}#o=${ownerToken}`);
  const cloudflareRoute = routes.find((route) => route.type === "cloudflare");
  if (cloudflareRoute) console.log(`Host browser link: ${cloudflareRoute.baseUrl}/room/${roomId}#o=${ownerToken}`);
}

function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${reason}`);
  for (const child of children) child.kill("SIGTERM");
  io.close();
  server.close(() => { rmSync(RUN_DIR, { recursive: true, force: true }); process.exit(0); });
  setTimeout(() => { rmSync(RUN_DIR, { recursive: true, force: true }); process.exit(0); }, 1500).unref();
}

server.listen(PORT, BIND, () => {
  printHostLinks();
  console.log("Open a host link, choose an alias, then use Invite to copy guest links.");
  console.log(`The room will self-destruct after ${ROOM_TTL_MINUTES} minutes. Press Ctrl+C to end it now.\n`);
  console.log(`Guardrails: ${MAX_PARTICIPANTS} participants, ${MAX_CONCURRENT_UPLOADS} concurrent uploads, ${MAX_FILES} files, ${MAX_ROOM_STORAGE_MB} MB ciphertext storage.\n`);
  if (ROUTE_MODE === "both" || ROUTE_MODE.includes("cloudflare")) startCloudflare();
  if (ROUTE_MODE === "both" || ROUTE_MODE.includes("tor")) startTor();
});

setTimeout(() => shutdown("Room lifetime ended."), ROOM_TTL_MINUTES * 60_000).unref();
process.once("SIGINT", () => shutdown("Server stopped. Temporary room data deleted."));
process.once("SIGTERM", () => shutdown("Server stopped. Temporary room data deleted."));
process.once("uncaughtException", (error) => { console.error(error instanceof Error ? error.message : "Unexpected relay error"); shutdown("Relay stopped safely."); });
