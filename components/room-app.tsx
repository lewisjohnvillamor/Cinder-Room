"use client";

import {
  ArrowDown,
  ArrowUp,
  CheckCircle,
  Coffee,
  Copy,
  DoorOpen,
  DownloadSimple,
  File,
  FileImage,
  FileVideo,
  Files,
  Fire,
  Gauge,
  LinkSimple,
  LockKey,
  Moon,
  Microphone,
  MonitorArrowUp,
  Phone,
  PaperPlaneRight,
  Paperclip,
  ShieldCheck,
  Screencast,
  SignOut,
  StopCircle,
  Sun,
  Trash,
  UploadSimple,
  UsersThree,
  VideoCamera,
  X,
} from "@phosphor-icons/react";
import { ClipboardEvent, DragEvent, FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import MeetingPanel from "./meeting-panel";
import { useAccessibleDialog } from "./use-accessible-dialog";

type WireMessage = { id: string; encrypted: string; createdAt: number };
type DirectMessageWire = { id: string; from: string; to: string; encrypted: string; createdAt: number };
type MessageAttachment = { fileId: string; name: string; type: string; size: number };
type Message = WireMessage & { sender: string; text: string; attachment?: MessageAttachment };
type DirectMessage = DirectMessageWire & { sender: string; text: string; attachment?: MessageAttachment };
type WireFile = { id: string; encryptedMeta: string; encryptedSize: number; createdAt: number };
type SharedFile = WireFile & { name: string; type: string; size: number; sender: string };
type Route = { type: "local" | "onion" | "cloudflare"; baseUrl: string };
type Preview = { url: string; type: string; name: string; fileId?: string };
type ScreenStartWire = { id: string; encrypted: string; createdAt: number };
type ScreenChunkWire = { streamId: string; sequence: number; encrypted: string };
type ActivePresentation = ScreenStartWire & { presenter: string; mimeType: string };
type RoomLimits = { participants: number; concurrentUploads: number; files: number; roomStorageMb: number; messagesPerTenSeconds: number };
type PresenceWire = { id: string; encryptedAlias: string };
export type MeetingSignal = { id: string; createdAt: number; senderId: string; sender: string; type: "hand" | "reaction" | "caption" | "question" | "question-answer" | "poll" | "vote" | "call-start" | "call-end"; value: string; extra?: string[] };
type MeetingSignalWire = { id: string; encrypted: string; createdAt: number };
type PendingPerson = { id: string; name: string };
type ConfirmDialog = {
  title: string;
  message: string;
  confirmLabel: string;
  tone?: "danger" | "default";
  onConfirm: () => void;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEMO_TIME = 1_788_000_000_000;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const SUPPORT_URL = "https://www.paypal.com/paypalme/lewisjohnvillamor/250";

function renderLinkedText(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(text.slice(lastIndex, index));
    nodes.push(<a className="message-link" href={match[0]} key={`${index}-${match[0]}`} rel="noopener noreferrer" target="_blank">{match[0]}</a>);
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes.length ? nodes : [text];
}

function voiceMimeType() {
  if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
  if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
  if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/mp4")) return "audio/mp4";
  return "";
}

function ChatAttachment({
  attachment,
  onOpen,
  roomId,
  roomKey,
  httpCapability,
}: {
  attachment: MessageAttachment;
  roomId: string;
  roomKey: CryptoKey;
  httpCapability: string;
  onOpen: (attachment: MessageAttachment) => void;
}) {
  const [mediaUrl, setMediaUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    const isInlineMedia = attachment.type.startsWith("image/") || attachment.type.startsWith("audio/") || attachment.type.startsWith("video/");
    if (!isInlineMedia) return undefined;

    void (async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/files/${encodeURIComponent(attachment.fileId)}?room=${encodeURIComponent(roomId)}`, { headers: { "X-Cinder-Capability": httpCapability } });
        if (!response.ok) throw new Error("missing");
        const clear = await decryptBytes(roomKey, new Uint8Array(await response.arrayBuffer()));
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([clear], { type: attachment.type }));
        setMediaUrl(objectUrl);
      } catch {
        if (!cancelled) setMissing(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.fileId, attachment.type, httpCapability, roomId, roomKey]);

  const openAttachment = () => {
    onOpen(attachment);
  };

  if (attachment.type.startsWith("image/")) {
    return (
      <button className="message-attachment image-attachment" type="button" onClick={openAttachment} aria-label={`Open ${attachment.name}`}>
        {loading && <span className="attachment-placeholder">Decrypting image…</span>}
        {missing && <span className="attachment-placeholder">Image unavailable</span>}
        {/* A decrypted blob URL cannot use Next's remote image optimizer. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {mediaUrl && <img alt={attachment.name} src={mediaUrl} />}
      </button>
    );
  }

  if (attachment.type.startsWith("audio/")) {
    return (
      <div className="message-attachment audio-attachment">
        {loading && <span className="attachment-placeholder">Decrypting voice note…</span>}
        {missing && <span className="attachment-placeholder">Voice note unavailable</span>}
        {mediaUrl && <audio controls preload="metadata" src={mediaUrl} />}
        <span className="attachment-label">{attachment.name}</span>
      </div>
    );
  }

  if (attachment.type.startsWith("video/")) {
    return (
      <button className="message-attachment video-attachment" type="button" onClick={openAttachment} aria-label={`Open ${attachment.name}`}>
        {loading && <span className="attachment-placeholder">Decrypting video…</span>}
        {missing && <span className="attachment-placeholder">Video unavailable</span>}
        {mediaUrl ? <video controls preload="metadata" src={mediaUrl} /> : <span className="attachment-label">{attachment.name}</span>}
      </button>
    );
  }

  return (
    <button className="message-attachment file-attachment" type="button" onClick={openAttachment}>
      <FileGlyph type={attachment.type} />
      <span className="attachment-label">{attachment.name}</span>
      <span className="attachment-meta">{formatBytes(attachment.size)}</span>
    </button>
  );
}

function toArrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importRoomKey(encodedKey: string) {
  const bytes = base64UrlToBytes(encodedKey);
  if (bytes.byteLength !== 32) throw new Error("The room key is invalid.");
  return crypto.subtle.importKey("raw", toArrayBuffer(bytes), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptBytes(key: CryptoKey, clear: Uint8Array) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, toArrayBuffer(clear)));
  const packed = new Uint8Array(iv.length + encrypted.length);
  packed.set(iv);
  packed.set(encrypted, iv.length);
  return packed;
}

async function decryptBytes(key: CryptoKey, packed: Uint8Array) {
  if (packed.byteLength < 29) throw new Error("Encrypted payload is incomplete.");
  const iv = packed.slice(0, 12);
  const encrypted = packed.slice(12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, toArrayBuffer(encrypted)));
}

async function encryptJson(key: CryptoKey, value: unknown) {
  return bytesToBase64Url(await encryptBytes(key, encoder.encode(JSON.stringify(value))));
}

async function decryptJson<T>(key: CryptoKey, value: string) {
  return JSON.parse(decoder.decode(await decryptBytes(key, base64UrlToBytes(value)))) as T;
}

function roomFromPath() {
  const match = window.location.pathname.match(/^\/room\/([A-Za-z0-9_-]{12,80})/);
  return match?.[1] ?? "";
}

function hashValues() {
  return new URLSearchParams(window.location.hash.replace(/^#/, ""));
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("");
}

function FileGlyph({ type }: { type: string }) {
  if (type.startsWith("image/")) return <FileImage size={19} weight="duotone" />;
  if (type.startsWith("video/")) return <FileVideo size={19} weight="duotone" />;
  return <File size={19} weight="duotone" />;
}

function supportedScreenMimeType() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type) && MediaSource.isTypeSupported(type)) ?? "";
}

export default function RoomApp({ demo = false }: { demo?: boolean }) {
  const [roomId, setRoomId] = useState(demo ? "demo-room-v04" : "");
  const [encodedKey, setEncodedKey] = useState(demo ? "demo-key-never-used" : "");
  const [ownerToken, setOwnerToken] = useState("");
  const [roomKey, setRoomKey] = useState<CryptoKey | null>(null);
  const [alias, setAlias] = useState(demo ? "demo-encrypted-alias-value" : "");
  const [draftAlias, setDraftAlias] = useState("");
  const [connected, setConnected] = useState(demo);
  const [relay, setRelay] = useState<"rust" | "node">("rust");
  const [limits, setLimits] = useState<RoomLimits>({ participants: 50, concurrentUploads: 4, files: 200, roomStorageMb: 1024, messagesPerTenSeconds: 30 });
  const [maxFileMb, setMaxFileMb] = useState(100);
  const [messages, setMessages] = useState<Message[]>(demo ? [
    { id: "demo-1", encrypted: "", createdAt: DEMO_TIME - 180_000, sender: "Mika", text: "The launch notes are in the encrypted file container." },
    { id: "demo-2", encrypted: "", createdAt: DEMO_TIME - 90_000, sender: "Lewis", text: "Perfect. I’ll present the final flow after everyone joins." },
    { id: "demo-3", encrypted: "", createdAt: DEMO_TIME - 30_000, sender: "Sam", text: "Connected through Tor — everything is working smoothly." },
  ] : []);
  const [directMessages, setDirectMessages] = useState<DirectMessage[]>([]);
  const [activeConversation, setActiveConversation] = useState("group");
  const [directUnread, setDirectUnread] = useState<Record<string, number>>({});
  const [files, setFiles] = useState<SharedFile[]>(demo ? [
    { id: "demo-file-1", encryptedMeta: "", encryptedSize: 2_480_000, createdAt: DEMO_TIME - 120_000, name: "launch-notes.pdf", type: "application/pdf", size: 2_479_840, sender: "Mika" },
    { id: "demo-file-2", encryptedMeta: "", encryptedSize: 4_920_000, createdAt: DEMO_TIME - 60_000, name: "room-preview.png", type: "image/png", size: 4_919_302, sender: "Lewis" },
  ] : []);
  const [people, setPeople] = useState<string[]>(demo ? ["Lewis", "Mika", "Sam"] : []);
  const [presence, setPresence] = useState<Array<{ id: string; name: string }>>([]);
  const [socketId, setSocketId] = useState("");
  const [httpCapability, setHttpCapability] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [admissionLocked, setAdmissionLocked] = useState(false);
  const [pendingPeople, setPendingPeople] = useState<PendingPerson[]>([]);
  const [keyMismatchCount, setKeyMismatchCount] = useState(0);
  const [meetingSignals, setMeetingSignals] = useState<MeetingSignal[]>([]);
  const [broadcasters, setBroadcasters] = useState<Record<string, { name: string; intent: "video" | "audio" }>>({});
  const [moderationCommand, setModerationCommand] = useState<{ id: string; command: "mute" | "remove"; reason: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [routes, setRoutes] = useState<Route[]>(demo ? [
    { type: "onion", baseUrl: "http://cinderexampleonionaddress.onion" },
    { type: "cloudflare", baseUrl: "https://cinder-room.trycloudflare.com" },
  ] : []);
  const [shareOpen, setShareOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);
  const [toast, setToast] = useState("");
  const [fatal, setFatal] = useState("");
  const [guestExitCountdown, setGuestExitCountdown] = useState<number | null>(null);
  const [left, setLeft] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [presenting, setPresenting] = useState(false);
  const [activePresentation, setActivePresentation] = useState<ActivePresentation | null>(null);
  const [screenOpen, setScreenOpen] = useState(false);
  const [meetingOpen, setMeetingOpen] = useState(false);
  const [mobileCallView, setMobileCallView] = useState<"video" | "chat">("video");
  const [meetingIntent, setMeetingIntent] = useState<"video" | "audio" | "present">("video");
  const [recordingVoice, setRecordingVoice] = useState(false);
  const [composerDragging, setComposerDragging] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const presentingRef = useRef(false);
  const activeScreenIdRef = useRef("");
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const screenUrlRef = useRef("");
  const screenQueueRef = useRef<Uint8Array[]>([]);
  const screenHistoryRef = useRef<Uint8Array[]>([]);
  const screenDecryptChainRef = useRef<Promise<void>>(Promise.resolve());
  const recordingChainRef = useRef<Promise<void>>(Promise.resolve());
  const activeConversationRef = useRef("group");
  const uploadRequestsRef = useRef(new Map<string, XMLHttpRequest>());
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = window.setTimeout(() => { setToast(""); toastTimerRef.current = null; }, 2200);
  }, []);

  const openConversation = useCallback((id: string) => {
    activeConversationRef.current = id;
    setActiveConversation(id);
    if (id !== "group") setDirectUnread((current) => ({ ...current, [id]: 0 }));
  }, []);

  const requestConfirm = useCallback((dialog: ConfirmDialog) => {
    setConfirmDialog(dialog);
  }, []);

  const closeConfirm = useCallback(() => {
    setConfirmDialog(null);
  }, []);

  const confirmAction = useCallback(() => {
    setConfirmDialog((current) => {
      current?.onConfirm();
      return null;
    });
  }, []);

  const anyDialogOpen = shareOpen || securityOpen || supportOpen || Boolean(preview) || Boolean(confirmDialog) || waiting;
  const closeTopDialog = useCallback(() => {
    if (waiting) return;
    if (confirmDialog) closeConfirm();
    else if (preview) { URL.revokeObjectURL(preview.url); setPreview(null); }
    else if (supportOpen) setSupportOpen(false);
    else if (securityOpen) setSecurityOpen(false);
    else if (shareOpen) setShareOpen(false);
  }, [closeConfirm, confirmDialog, preview, securityOpen, shareOpen, supportOpen, waiting]);
  useAccessibleDialog(anyDialogOpen, closeTopDialog, `${Boolean(confirmDialog)}-${Boolean(preview)}-${supportOpen}-${securityOpen}-${shareOpen}-${waiting}`);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cinder-theme", theme);
  }, [theme]);

  useEffect(() => {
    const saved = localStorage.getItem("cinder-theme");
    const frame = window.requestAnimationFrame(() => {
      if (saved === "light" || saved === "dark") setTheme(saved);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (demo) return;
    let active = true;
    async function initializeRoom() {
      await Promise.resolve();
      const id = roomFromPath();
      const hash = hashValues();
      const owner = hash.get("o") ?? "";
      let key = hash.get("k") ?? "";

      if (!id) {
        if (active) setFatal("This page needs a temporary room link from the Cinder server.");
        return;
      }

      if (!key && owner) {
        key = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
        hash.set("k", key);
        window.history.replaceState(null, "", `${window.location.pathname}#${hash.toString()}`);
      }

      if (!key) {
        if (active) setFatal("This invitation is missing its encryption key. Ask the host for the complete link.");
        return;
      }

      try {
        const importedKey = await importRoomKey(key);
        if (!active) return;
        setRoomId(id);
        setOwnerToken(owner);
        setEncodedKey(key);
        setRoomKey(importedKey);
        setDraftAlias(sessionStorage.getItem(`cinder-alias-${id}`) ?? "");
      } catch (error) {
        if (active) setFatal(error instanceof Error ? error.message : "The room key is invalid.");
      }
    }
    void initializeRoom();
    return () => { active = false; };
  }, [demo]);

  const decryptMessage = useCallback(async (wire: WireMessage, key: CryptoKey) => {
    const clear = await decryptJson<{ sender: string; text: string; attachment?: MessageAttachment }>(key, wire.encrypted);
    return { ...wire, ...clear };
  }, []);

  const decryptFile = useCallback(async (wire: WireFile, key: CryptoKey) => {
    const clear = await decryptJson<{ name: string; type: string; size: number; sender: string }>(key, wire.encryptedMeta);
    return { ...wire, ...clear };
  }, []);

  const appendScreenQueue = useCallback(() => {
    const sourceBuffer = sourceBufferRef.current;
    if (!sourceBuffer || sourceBuffer.updating || screenQueueRef.current.length === 0) return;
    const next = screenQueueRef.current.shift();
    if (!next) return;
    try {
      sourceBuffer.appendBuffer(toArrayBuffer(next));
    } catch {
      setScreenOpen(false);
      showToast("This browser could not continue the encrypted presentation.");
    }
  }, [showToast]);

  const stopLocalPresentation = useCallback((notifyRelay = true) => {
    if (notifyRelay) socketRef.current?.emit("screen:stop");
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    displayStreamRef.current?.getTracks().forEach((track) => track.stop());
    displayStreamRef.current = null;
    presentingRef.current = false;
    setPresenting(false);
  }, []);

  useEffect(() => {
    if (demo) return;
    if (!alias || !roomId || !roomKey) return;

    const socket = io({
      transports: ["websocket", "polling"],
      auth: { room: roomId },
      reconnectionAttempts: 8,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setSocketId(socket.id ?? "");
      socket.emit("room:join", { encryptedAlias: alias, ownerToken });
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => setConnected(false));
    socket.on("room:error", (message: string) => showToast(message));
    socket.on("room:destroyed", () => {
      setConnected(false);
      setGuestExitCountdown(3);
      setFatal("The host destroyed this room. Its temporary contents are no longer available.");
    });
    socket.on("admission:waiting", () => setWaiting(true));
    socket.on("admission:admitted", (state: { locked?: boolean; httpCapability?: string }) => {
      setWaiting(false);
      setAdmissionLocked(Boolean(state?.locked));
      const capability = state?.httpCapability ?? "";
      setHttpCapability(capability);
      if (capability) {
        fetch(`/api/files?room=${encodeURIComponent(roomId)}`, { headers: { "X-Cinder-Capability": capability } })
          .then((response) => response.ok ? response.json() : Promise.reject())
          .then(async (items: WireFile[]) => {
            const settled = await Promise.allSettled(items.map((item) => decryptFile(item, roomKey)));
            setFiles(settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []));
          })
          .catch(() => showToast("The file container is temporarily unavailable."));
      }
    });
    socket.on("admission:state", (state: { locked?: boolean }) => setAdmissionLocked(Boolean(state?.locked)));
    socket.on("admission:pending", async (items: Array<{ id: string; encryptedAlias: string }>) => {
      const settled = await Promise.allSettled(items.map(async (item) => ({ id: item.id, ...(await decryptJson<{ name: string }>(roomKey, item.encryptedAlias)) })));
      const clear = settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
      setPendingPeople(clear);
      if (clear.length) showToast(`${clear.length} ${clear.length === 1 ? "person is" : "people are"} waiting to enter.`);
    });
    socket.on("presence", async (items: PresenceWire[] | string[]) => {
      const normalized = items.map((item, index) => typeof item === "string" ? { id: `legacy-${index}`, encryptedAlias: item } : item);
      const settled = await Promise.allSettled(normalized.map(async (item) => ({ id: item.id, ...(await decryptJson<{ name: string }>(roomKey, item.encryptedAlias)) })));
      const clear = settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
      setKeyMismatchCount(settled.length - clear.length);
      setPresence(clear);
      setBroadcasters((current) => Object.fromEntries(Object.entries(current).filter(([id]) => clear.some((person) => person.id === id))));
      setPeople(clear.map((person) => person.name));
      if (activeConversationRef.current !== "group" && !clear.some((person) => person.id === activeConversationRef.current)) openConversation("group");
    });
    socket.on("routes", (items: Route[]) => setRoutes(items));
    socket.on("messages:init", async (items: WireMessage[]) => {
      const settled = await Promise.allSettled(items.map((item) => decryptMessage(item, roomKey)));
      setMessages(settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []));
    });
    socket.on("message:new", async (item: WireMessage) => {
      try {
        const clear = await decryptMessage(item, roomKey);
        setMessages((current) => current.some((message) => message.id === clear.id) ? current : [...current, clear]);
      } catch {
        showToast("A message could not be decrypted.");
      }
    });
    const decryptDirectMessage = async (wire: DirectMessageWire) => {
      const clear = await decryptJson<{ sender: string; text: string; attachment?: MessageAttachment }>(roomKey, wire.encrypted);
      return { ...wire, ...clear };
    };
    socket.on("direct:messages:init", async (items: DirectMessageWire[]) => {
      const settled = await Promise.allSettled(items.map(decryptDirectMessage));
      setDirectMessages(settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []));
    });
    socket.on("direct:new", async (item: DirectMessageWire) => {
      try {
        const clear = await decryptDirectMessage(item);
        setDirectMessages((current) => current.some((message) => message.id === clear.id) ? current : [...current, clear]);
        if (item.from !== socket.id && activeConversationRef.current !== item.from) {
          setDirectUnread((current) => ({ ...current, [item.from]: (current[item.from] ?? 0) + 1 }));
          showToast(`New direct message from ${clear.sender}.`);
        }
      } catch { showToast("A direct message could not be decrypted."); }
    });
    const decryptMeetingSignal = async (wire: MeetingSignalWire) => {
      const clear = await decryptJson<Omit<MeetingSignal, "id" | "createdAt">>(roomKey, wire.encrypted);
      return { ...clear, id: wire.id, createdAt: wire.createdAt };
    };
    socket.on("meeting:signals:init", async (items: MeetingSignalWire[]) => {
      const settled = await Promise.allSettled(items.map(decryptMeetingSignal));
      const clear = settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
      setMeetingSignals(clear);
      const active: Record<string, { name: string; intent: "video" | "audio" }> = {};
      for (const signal of clear) {
        if (signal.type === "call-start") active[signal.senderId] = { name: signal.sender, intent: signal.value === "audio" ? "audio" : "video" };
        if (signal.type === "call-end") delete active[signal.senderId];
      }
      setBroadcasters(active);
    });
    socket.on("meeting:signal", async (item: MeetingSignalWire) => {
      try {
        const clear = await decryptMeetingSignal(item);
        setMeetingSignals((current) => [...current.filter((signal) => signal.id !== clear.id), clear].slice(-150));
        if (clear.type === "call-start") setBroadcasters((current) => ({ ...current, [clear.senderId]: { name: clear.sender, intent: clear.value === "audio" ? "audio" : "video" } }));
        if (clear.type === "call-end") setBroadcasters((current) => { const next = { ...current }; delete next[clear.senderId]; return next; });
        if (clear.type === "call-start" && clear.senderId !== socket.id) {
          showToast(`${clear.sender} started a ${clear.value === "audio" ? "voice" : "video"} call.`);
        }
      } catch { showToast("A meeting activity could not be decrypted."); }
    });
    socket.on("moderation:command", (command: { command?: "mute" | "remove"; reason?: string }) => {
      if (!command?.command) return;
      setModerationCommand({ id: crypto.randomUUID(), command: command.command, reason: command.reason || "Host action" });
      if (command.command === "remove") {
        setFatal(command.reason || "The host removed you from this room.");
        socket.disconnect();
      } else showToast(command.reason || "The host muted your microphone.");
    });
    socket.on("file:added", async (item: WireFile) => {
      try {
        const clear = await decryptFile(item, roomKey);
        setFiles((current) => current.some((file) => file.id === clear.id) ? current : [clear, ...current]);
      } catch {
        showToast("A file description could not be decrypted.");
      }
    });
    socket.on("file:removed", (item: { id?: string }) => {
      if (!item?.id) return;
      setFiles((current) => current.filter((file) => file.id !== item.id));
    });
    const revealPresentation = async (wire: ScreenStartWire) => {
      const clear = await decryptJson<{ presenter: string; mimeType: string }>(roomKey, wire.encrypted);
      activeScreenIdRef.current = wire.id;
      screenHistoryRef.current = [];
      screenQueueRef.current = [];
      setActivePresentation({ ...wire, ...clear });
      setScreenOpen(true);
    };
    const consumeScreenChunk = (chunk: ScreenChunkWire) => {
      screenDecryptChainRef.current = screenDecryptChainRef.current.then(async () => {
        if (chunk.streamId !== activeScreenIdRef.current) return;
        const clear = await decryptBytes(roomKey, base64UrlToBytes(chunk.encrypted));
        screenHistoryRef.current.push(clear);
        screenQueueRef.current.push(clear);
        appendScreenQueue();
      }).catch(() => showToast("A presentation segment could not be decrypted."));
    };
    socket.on("screen:start", async (wire: ScreenStartWire) => {
      try {
        await revealPresentation(wire);
      } catch {
        showToast("The presentation details could not be decrypted.");
      }
    });
    socket.on("screen:state", async (state: { start: ScreenStartWire; chunks: ScreenChunkWire[] }) => {
      try {
        await revealPresentation(state.start);
        for (const chunk of state.chunks) consumeScreenChunk(chunk);
      } catch {
        showToast("The live presentation could not be restored.");
      }
    });
    socket.on("screen:chunk", consumeScreenChunk);
    socket.on("screen:stop", (event: { reason?: string }) => {
      activeScreenIdRef.current = "";
      setActivePresentation(null);
      setScreenOpen(false);
      screenQueueRef.current = [];
      screenHistoryRef.current = [];
      if (presentingRef.current) stopLocalPresentation(false);
      if (event?.reason === "limit") showToast("The encrypted presentation reached its safety limit.");
    });

    fetch("/api/routes")
      .then((response) => response.json())
      .then((items: Route[]) => setRoutes(items))
      .catch(() => setRoutes([{ type: "local", baseUrl: window.location.origin }]));

    fetch("/api/health")
      .then((response) => response.json())
      .then((health: { relay?: string; maxFileMb?: number; limits?: RoomLimits }) => {
        setRelay(health.relay === "node" ? "node" : "rust");
        if (typeof health.maxFileMb === "number") setMaxFileMb(health.maxFileMb);
        if (health.limits) setLimits(health.limits);
      })
      .catch(() => undefined);

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setHttpCapability("");
    };
  }, [alias, appendScreenQueue, decryptFile, decryptMessage, demo, openConversation, ownerToken, roomId, roomKey, showToast, stopLocalPresentation]);

  useEffect(() => {
    if (guestExitCountdown === null) return undefined;
    const timer = window.setTimeout(() => {
      if (guestExitCountdown <= 1) { window.close(); setGuestExitCountdown(null); }
      else setGuestExitCountdown(guestExitCountdown - 1);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [guestExitCountdown]);

  function supportPanel() {
    return (
      <>
        <p>Cinder Room is free and open source. If it helps you, you can support continued development.</p>
        <div className="support-card">
          <Coffee size={28} weight="duotone" />
          <div>
            <strong>Support Lewis</strong>
            <span>One-time contribution through PayPal</span>
          </div>
        </div>
        <a className="primary-button support-button" href={SUPPORT_URL} target="_blank" rel="noreferrer">
          <Coffee size={17} weight="fill" /> Support via PayPal
        </a>
        <p className="privacy-note">Opens PayPal in a new tab. Guest checkout availability depends on your region; no payment is required to use Cinder Room.</p>
      </>
    );
  }

  useEffect(() => {
    const list = messageListRef.current;
    list?.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => () => {
    voiceRecorderRef.current?.stop();
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    uploadRequestsRef.current.forEach((request) => request.abort());
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview.url);
  }, [preview]);

  useEffect(() => {
    const video = screenVideoRef.current;
    if (!video || !screenOpen || !presenting || !displayStreamRef.current) return;
    video.srcObject = displayStreamRef.current;
    void video.play().catch(() => undefined);
    return () => { video.srcObject = null; };
  }, [presenting, screenOpen]);

  useEffect(() => {
    const video = screenVideoRef.current;
    if (!video || !screenOpen || !activePresentation || presenting) return;
    if (!MediaSource.isTypeSupported(activePresentation.mimeType)) {
      queueMicrotask(() => showToast("This browser cannot play the presenter’s selected format."));
      return;
    }

    const mediaSource = new MediaSource();
    const url = URL.createObjectURL(mediaSource);
    mediaSourceRef.current = mediaSource;
    screenUrlRef.current = url;
    screenQueueRef.current = [...screenHistoryRef.current];
    video.src = url;

    const onSourceOpen = () => {
      try {
        const sourceBuffer = mediaSource.addSourceBuffer(activePresentation.mimeType);
        sourceBuffer.mode = "sequence";
        sourceBufferRef.current = sourceBuffer;
        sourceBuffer.addEventListener("updateend", appendScreenQueue);
        appendScreenQueue();
        void video.play().catch(() => undefined);
      } catch {
        showToast("The encrypted presentation could not start in this browser.");
      }
    };
    mediaSource.addEventListener("sourceopen", onSourceOpen, { once: true });

    return () => {
      const sourceBuffer = sourceBufferRef.current;
      sourceBuffer?.removeEventListener("updateend", appendScreenQueue);
      sourceBufferRef.current = null;
      mediaSourceRef.current = null;
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      screenUrlRef.current = "";
    };
  }, [activePresentation, appendScreenQueue, presenting, screenOpen, showToast]);

  async function join(event: FormEvent) {
    event.preventDefault();
    const clean = draftAlias.trim().slice(0, 40);
    if (!clean || !roomKey) return;
    const encrypted = await encryptJson(roomKey, { name: clean });
    sessionStorage.setItem(`cinder-alias-${roomId}`, encrypted);
    sessionStorage.setItem(`cinder-name-${roomId}`, clean);
    setAlias(encrypted);
  }

  const ownName = demo ? "Lewis" : typeof window !== "undefined" ? sessionStorage.getItem(`cinder-name-${roomId}`) ?? "You" : "You";

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !roomKey || !socketRef.current?.connected) return;
    const encrypted = await encryptJson(roomKey, { sender: ownName, text: text.slice(0, 8000) });
    if (activeConversation === "group") socketRef.current.emit("message:send", { encrypted });
    else socketRef.current.emit("direct:send", { target: activeConversation, encrypted });
    setDraft("");
  }

  async function startPresentation() {
    if (!roomKey || !socketRef.current?.connected || presenting || activePresentation) return;
    if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === "undefined" || typeof MediaSource === "undefined") {
      showToast("Screen presentation is not supported by this browser.");
      return;
    }
    const mimeType = supportedScreenMimeType();
    if (!mimeType) {
      showToast("This browser has no compatible encrypted presentation format.");
      return;
    }

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: 1280 }, height: { max: 720 }, frameRate: { ideal: 12, max: 15 } },
        audio: false,
      });
      displayStreamRef.current = stream;
      presentingRef.current = true;
      setPresenting(true);
      setScreenOpen(true);

      const encrypted = await encryptJson(roomKey, { presenter: ownName, mimeType });
      const accepted = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        socketRef.current?.timeout(5000).emit("screen:start", { encrypted }, (error: Error | null, result: { ok: boolean; error?: string }) => {
          resolve(error ? { ok: false, error: "The relay did not answer." } : result);
        });
      });
      if (!accepted.ok) throw new Error(accepted.error ?? "The presentation could not start.");

      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 900_000 });
      recorderRef.current = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (!event.data.size || !roomKey || !socketRef.current?.connected) return;
        recordingChainRef.current = recordingChainRef.current.then(async () => {
          const encryptedChunk = await encryptBytes(roomKey, new Uint8Array(await event.data.arrayBuffer()));
          socketRef.current?.emit("screen:chunk", { encrypted: bytesToBase64Url(encryptedChunk) });
        }).catch(() => {
          showToast("A screen segment could not be encrypted.");
          stopLocalPresentation();
        });
      });
      stream.getVideoTracks()[0]?.addEventListener("ended", () => stopLocalPresentation(), { once: true });
      recorder.start(800);
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      stopLocalPresentation(false);
      showToast(error instanceof Error ? error.message : "Screen access was not granted.");
    }
  }

  async function shareFileInChat(attachment: MessageAttachment, caption = "") {
    if (!roomKey || !socketRef.current?.connected) return;
    const encrypted = await encryptJson(roomKey, { sender: ownName, text: caption, attachment });
    if (activeConversationRef.current === "group") socketRef.current.emit("message:send", { encrypted });
    else socketRef.current.emit("direct:send", { target: activeConversationRef.current, encrypted });
  }

  async function uploadOne(file: globalThis.File, shareInChat = true) {
    if (!roomKey || !roomId || !httpCapability) { showToast("Finishing the secure room connection. Try again in a moment."); return null; }
    if (file.size > maxFileMb * 1024 * 1024) { showToast(`${file.name} exceeds the ${maxFileMb} MB room limit.`); return null; }
    const uploadId = crypto.randomUUID();
    setUploadProgress((current) => ({ ...current, [uploadId]: 2 }));
    try {
      const encryptedMeta = await encryptJson(roomKey, {
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        sender: ownName,
      });
      const encrypted = await encryptBytes(roomKey, new Uint8Array(await file.arrayBuffer()));
      const stored = await new Promise<WireFile>((resolve, reject) => {
        const request = new XMLHttpRequest();
        uploadRequestsRef.current.set(uploadId, request);
        request.open("POST", "/api/files");
        request.setRequestHeader("Content-Type", "application/octet-stream");
        request.setRequestHeader("X-Cinder-Room", roomId);
        request.setRequestHeader("X-Cinder-Meta", encryptedMeta);
        request.setRequestHeader("X-Cinder-Capability", httpCapability);
        request.upload.onprogress = (progress) => {
          if (progress.lengthComputable) {
            setUploadProgress((current) => ({ ...current, [uploadId]: Math.max(5, Math.round(progress.loaded / progress.total * 100)) }));
          }
        };
        request.onload = () => {
          if (request.status >= 200 && request.status < 300) {
            try { resolve(JSON.parse(request.responseText) as WireFile); }
            catch { reject(new Error("Upload rejected")); }
            return;
          }
          try { reject(new Error(JSON.parse(request.responseText).error ?? "Upload rejected")); }
          catch { reject(new Error("Upload rejected")); }
        };
        request.onerror = () => reject(new Error("Upload interrupted"));
        request.onabort = () => reject(new Error("Upload cancelled"));
        request.send(encrypted);
      });
      const attachment: MessageAttachment = {
        fileId: stored.id,
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
      };
      if (shareInChat) await shareFileInChat(attachment);
      showToast(`${file.name} added to the room.`);
      return attachment;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The upload failed.");
      return null;
    } finally {
      setUploadProgress((current) => {
        const next = { ...current };
        delete next[uploadId];
        return next;
      });
      uploadRequestsRef.current.delete(uploadId);
    }
  }

  async function handleFiles(list: FileList | null, shareInChat = true) {
    if (!list) return;
    const queue = Array.from(list);
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const file = queue[next++];
        await uploadOne(file, shareInChat);
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker));
  }

  function meetingPanel() {
    if (demo || !roomKey) return null;
    return <MeetingPanel
      open={meetingOpen}
      intent={meetingIntent}
      roomId={roomId}
      roomKey={roomKey}
      encodedKey={encodedKey}
      encryptedAlias={alias}
      ownName={ownName}
      onMinimize={() => setMeetingOpen(false)}
      onCallEnded={() => { void sendMeetingSignal({ type: "call-end", value: "ended" }); }}
      onFallbackPresent={() => { setMeetingOpen(false); void startPresentation(); }}
      onRequestPresent={requestMediaPresentation}
      onReleasePresent={releaseMediaPresentation}
      socketId={socketId}
      httpCapability={httpCapability}
      isHost={Boolean(ownerToken)}
      participants={presence}
      meetingSignals={meetingSignals}
      moderationCommand={moderationCommand}
      admissionLocked={admissionLocked}
      pendingPeople={pendingPeople}
      onMeetingSignal={sendMeetingSignal}
      onAdmissionLock={setRoomAdmission}
      onAdmissionDecision={decideAdmission}
      onModerate={moderateParticipant}
    />;
  }

  function fallbackPresentationPanel() {
    if (!screenOpen || !activePresentation) return null;
    return <section className="inline-screen-panel" aria-labelledby="screen-title">
      <div className="screen-toolbar">
        <div><p className="eyebrow"><span className="live-pulse" /> Encrypted presentation</p><h2 id="screen-title">{presenting ? "You are presenting" : `${activePresentation.presenter} is presenting`}</h2></div>
        <div className="row-actions">
          {presenting && <button className="danger-button" onClick={() => stopLocalPresentation()}><StopCircle size={17} weight="fill" /> Stop sharing</button>}
          <button className="icon-button" aria-label="Collapse presentation" onClick={() => setScreenOpen(false)}><X size={18} /></button>
        </div>
      </div>
      <div className="screen-viewport"><video ref={screenVideoRef} autoPlay playsInline muted={presenting} controls={!presenting} /></div>
      <div className="screen-footer"><span><LockKey size={15} /> AES-GCM encrypted chunks</span><span>720p target · no microphone · temporary relay</span></div>
    </section>;
  }

  async function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const clipboardFiles = event.clipboardData?.files;
    if (!clipboardFiles?.length) return;
    event.preventDefault();
    await handleFiles(clipboardFiles, true);
  }

  async function handleComposerDrop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    setComposerDragging(false);
    if (event.dataTransfer.files.length) await handleFiles(event.dataTransfer.files, true);
  }

  async function stopVoiceRecording() {
    const recorder = voiceRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
  }

  async function toggleVoiceRecording() {
    if (recordingVoice) {
      await stopVoiceRecording();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      showToast("Voice notes are not supported in this browser.");
      return;
    }
    const mimeType = voiceMimeType();
    if (!mimeType) {
      showToast("This browser has no compatible voice-note format.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceStreamRef.current = stream;
      voiceChunksRef.current = [];
      const recorder = new MediaRecorder(stream, { mimeType });
      voiceRecorderRef.current = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size) voiceChunksRef.current.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        stream.getTracks().forEach((track) => track.stop());
        voiceStreamRef.current = null;
        voiceRecorderRef.current = null;
        setRecordingVoice(false);
        const blob = new Blob(voiceChunksRef.current, { type: mimeType });
        voiceChunksRef.current = [];
        if (!blob.size) return;
        const extension = mimeType.includes("mp4") ? "m4a" : "webm";
        void uploadOne(new globalThis.File([blob], `voice-${Date.now()}.${extension}`, { type: mimeType }), true);
      }, { once: true });
      recorder.start();
      setRecordingVoice(true);
    } catch {
      showToast("Microphone access was not granted.");
    }
  }

  async function openAttachment(attachment: MessageAttachment, download = false) {
    if (!roomKey) return;
    showToast("Decrypting file locally…");
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(attachment.fileId)}?room=${encodeURIComponent(roomId)}`, { headers: { "X-Cinder-Capability": httpCapability } });
      if (!response.ok) throw new Error("The file is no longer available.");
      const clear = await decryptBytes(roomKey, new Uint8Array(await response.arrayBuffer()));
      const url = URL.createObjectURL(new Blob([clear], { type: attachment.type }));
      if (download || (!attachment.type.startsWith("image/") && !attachment.type.startsWith("video/"))) {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = attachment.name;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 3000);
      } else {
        setPreview({ url, type: attachment.type, name: attachment.name, fileId: attachment.fileId });
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The file could not be decrypted.");
    }
  }

  async function performDeleteFile(item: SharedFile) {
    if (!roomId) return;
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(item.id)}?room=${encodeURIComponent(roomId)}`, {
        method: "DELETE",
        headers: {
          ...(httpCapability ? { "X-Cinder-Capability": httpCapability } : {}),
          ...(ownerToken ? { "X-Cinder-Owner-Token": ownerToken } : {}),
        },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: "Delete rejected" }));
        throw new Error(typeof payload.error === "string" ? payload.error : "Delete rejected");
      }
      setFiles((current) => current.filter((file) => file.id !== item.id));
      showToast(`${item.name} deleted.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The file could not be deleted.");
    }
  }

  function deleteFile(item: SharedFile) {
    if (!roomId || item.sender !== ownName) return;
    requestConfirm({
      title: `Delete ${item.name}?`,
      message: "This removes the encrypted file from the room for everyone.",
      confirmLabel: "Delete file",
      tone: "danger",
      onConfirm: () => void performDeleteFile(item),
    });
  }

  async function openFile(item: SharedFile, download = false) {
    if (!roomKey) return;
    showToast("Decrypting file locally…");
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(item.id)}?room=${encodeURIComponent(roomId)}`, { headers: { "X-Cinder-Capability": httpCapability } });
      if (!response.ok) throw new Error("The file is no longer available.");
      const clear = await decryptBytes(roomKey, new Uint8Array(await response.arrayBuffer()));
      const url = URL.createObjectURL(new Blob([clear], { type: item.type }));
      if (download || (!item.type.startsWith("image/") && !item.type.startsWith("video/"))) {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = item.name;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 3000);
      } else {
        setPreview({ url, type: item.type, name: item.name });
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The file could not be decrypted.");
    }
  }

  function guestLink(route: Route) {
    const baseUrl = route.type === "local" ? window.location.origin : route.baseUrl;
    return `${baseUrl}/room/${roomId}#k=${encodedKey}`;
  }

  async function copyRoute(route: Route) {
    await navigator.clipboard.writeText(guestLink(route));
    showToast(`${route.type === "onion" ? "Tor" : route.type === "cloudflare" ? "Browser" : "Direct browser"} invitation copied.`);
  }

  function destroyRoom() {
    if (!ownerToken || !socketRef.current) return;
    requestConfirm({
      title: "Destroy this room?",
      message: "The room, tunnel, messages, and temporary files will be permanently closed. It will not reopen automatically.",
      confirmLabel: "Destroy room",
      tone: "danger",
      onConfirm: () => socketRef.current?.emit("room:destroy", { ownerToken }),
    });
  }

  function openMeeting(intent: "video" | "audio" | "present") {
    if (demo) {
      showToast("Group media is available when the self-hosted relay is running.");
      return;
    }
    setMeetingIntent(intent);
    setMobileCallView("video");
    setMeetingOpen(true);
    void sendMeetingSignal({ type: "call-start", value: intent });
  }

  async function requestMediaPresentation() {
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const socket = socketRef.current;
      if (!socket?.connected) {
        resolve({ ok: false, error: "The encrypted room is reconnecting." });
        return;
      }
      socket.timeout(5000).emit("media:present:start", {}, (error: Error | null, result: { ok: boolean; error?: string }) => {
        resolve(error ? { ok: false, error: "The room did not answer." } : result);
      });
    });
  }

  function releaseMediaPresentation() {
    socketRef.current?.emit("media:present:stop");
  }

  async function sendMeetingSignal(signal: Omit<MeetingSignal, "id" | "createdAt" | "senderId" | "sender">) {
    if (!roomKey || !socketRef.current?.connected) return;
    const encrypted = await encryptJson(roomKey, { ...signal, senderId: socketId, sender: ownName });
    socketRef.current.emit("meeting:signal", { encrypted });
  }

  function setRoomAdmission(locked: boolean) {
    socketRef.current?.emit("admission:lock", { ownerToken, locked });
  }

  function decideAdmission(target: string, allow: boolean) {
    socketRef.current?.emit("admission:decide", { ownerToken, socketId: target, allow });
  }

  function moderateParticipant(target: string, command: "mute" | "remove") {
    socketRef.current?.emit("moderation:command", { ownerToken, target, command });
  }

  function leaveRoomConfirmed() {
    stopLocalPresentation(false);
    void stopVoiceRecording();
    socketRef.current?.disconnect();
    socketRef.current = null;
    if (preview) URL.revokeObjectURL(preview.url);
    sessionStorage.removeItem(`cinder-alias-${roomId}`);
    sessionStorage.removeItem(`cinder-name-${roomId}`);
    window.history.replaceState(null, "", "/");

    setConnected(false);
    setAlias("");
    setDraftAlias("");
    setRoomKey(null);
    setEncodedKey("");
    setOwnerToken("");
    setMessages([]);
    setDirectMessages([]);
    openConversation("group");
    setDirectUnread({});
    setFiles([]);
    setPeople([]);
    setPreview(null);
    setActivePresentation(null);
    setScreenOpen(false);
    setShareOpen(false);
    setFilesOpen(false);
    setSecurityOpen(false);
    setMeetingOpen(false);
    setLeft(true);
  }

  function leaveRoom() {
    if (ownerToken) {
      requestConfirm({
        title: "Leave without destroying?",
        message: "Everyone else will remain connected, and this tab will lose its host controls.",
        confirmLabel: "Leave room",
        onConfirm: leaveRoomConfirmed,
      });
      return;
    }
    leaveRoomConfirmed();
  }

  if (left) {
    return (
      <main className="join-overlay">
        <section className="join-card" aria-labelledby="left-title">
          <div className="brand-mark"><Fire size={18} weight="fill" /></div>
          <p className="eyebrow">Cinder Room</p>
          <h1 id="left-title">You left the room.</h1>
          <p>This tab is disconnected. Its temporary alias, room key, messages, and file list have been cleared.</p>
          <div className="security-row"><LockKey size={17} /><span>Other participants remain connected until the host destroys the room or the server ends.</span></div>
        </section>
      </main>
    );
  }

  if (fatal) {
    return (
      <main className="join-overlay">
        <section className="join-card" aria-labelledby="ended-title">
          <div className="brand-mark"><Fire size={18} weight="fill" /></div>
          <p className="eyebrow">Cinder Room</p>
          <h1 id="ended-title">Nothing stays behind.</h1>
          <p>{fatal}</p>
          <div className="security-row"><LockKey size={17} /><span>No recoverable room history is stored in this browser.</span></div>
          {guestExitCountdown !== null ? (
            <p className="recovery-note">Room cleanup completes in {guestExitCountdown}s…</p>
          ) : null}
          {guestExitCountdown === null && <button className="soft-button" type="button" onClick={() => window.close()}>Close this tab</button>}
        </section>
      </main>
    );
  }

  if (!alias) {
    return (
      <main className="join-overlay">
        <form className="join-card" onSubmit={join}>
          <div className="brand-mark"><Fire size={18} weight="fill" /></div>
          <p className="eyebrow">Encrypted temporary room</p>
          <h1>Enter without an account.</h1>
          <p>Your display name is encrypted before it leaves this browser. Choose any temporary alias.</p>
          <label className="field-label" htmlFor="alias">Display name</label>
          <input id="alias" autoFocus autoComplete="off" maxLength={40} value={draftAlias} onChange={(event) => setDraftAlias(event.target.value)} placeholder="How should the room know you?" />
          <button className="primary-button" type="submit" disabled={!draftAlias.trim() || !roomKey}>
            <DoorOpen size={17} weight="bold" /> Enter room
          </button>
        </form>
      </main>
    );
  }

  const activeDirectPerson = activeConversation === "group" ? null : presence.find((person) => person.id === activeConversation) ?? null;
  const visibleMessages: Array<Message | DirectMessage> = activeConversation === "group"
    ? messages
    : directMessages.filter((message) => message.from === activeConversation || message.to === activeConversation);
  const directParticipants = presence.filter((person) => person.id !== socketId);
  const orderedPresence = [...presence].sort((left, right) => Number(right.id === socketId) - Number(left.id === socketId));
  const totalDirectUnread = Object.values(directUnread).reduce((total, count) => total + count, 0);
  const activeBroadcastEntries = Object.entries(broadcasters).filter(([id]) => presence.some((person) => person.id === id));
  const activeBroadcaster = activeBroadcastEntries.find(([id]) => id !== socketId)?.[1] ?? activeBroadcastEntries[0]?.[1] ?? null;

  return (
    <main className="room-app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Fire size={18} weight="fill" /></div>
          <strong>Cinder Room</strong>
        </div>
        <div className="status-line" aria-live="polite">
          <span className={`status-dot ${connected ? "" : "offline"}`} />
          {connected ? `Encrypted room is live · ${relay === "rust" ? "Rust relay" : "Node compatibility relay"}` : "Reconnecting securely"}
        </div>
        <div className="top-actions">
          <button className="icon-button mobile-hide" aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="icon-button mobile-files-button" aria-label="Open files" onClick={() => setFilesOpen(true)}><Files size={18} /></button>
          <button className="icon-button mobile-only-button" aria-label="Open participants" onClick={() => setPeopleOpen(true)}><UsersThree size={18} /></button>
          {activeBroadcaster && !meetingOpen && <button className="broadcast-indicator" onClick={() => openMeeting(activeBroadcaster.intent)}><span className="broadcast-pulse" /><span>{activeBroadcaster.name} is broadcasting</span><strong>Join</strong></button>}
          {presenting ? (
            <button className="danger-button" onClick={() => stopLocalPresentation()}><StopCircle size={17} weight="fill" /><span className="button-label">Stop</span></button>
          ) : activePresentation ? (
            <button className="soft-button live-button" onClick={() => setScreenOpen(true)}><Screencast size={17} weight="fill" /><span className="button-label">Watch live</span></button>
          ) : (
            <button className="soft-button" onClick={() => openMeeting("present")}><MonitorArrowUp size={17} /><span className="button-label">Present</span></button>
          )}
          <button className="soft-button" onClick={() => openMeeting("audio")}><Phone size={17} /><span className="button-label">Call</span></button>
          <button className="soft-button" onClick={() => openMeeting("video")}><VideoCamera size={17} /><span className="button-label">Video</span></button>
          <button className="soft-button mobile-hide" onClick={() => setSecurityOpen(true)}><ShieldCheck size={17} /><span className="button-label">Privacy</span></button>
          <button className="icon-button mobile-only-button" aria-label="Open privacy information" onClick={() => setSecurityOpen(true)}><ShieldCheck size={18} /></button>
          <button className="soft-button" onClick={leaveRoom}><SignOut size={17} /><span className="button-label">Leave</span></button>
          <button className="primary-button" onClick={() => setShareOpen(true)}><LinkSimple size={17} weight="bold" /> Invite</button>
        </div>
      </header>

      <div className={`workspace ${meetingOpen || (screenOpen && activePresentation) ? "call-active" : ""}`}>
        <aside className="people-panel" aria-label="Participants">
          <div className="panel-heading"><h2>In this room</h2><span className="muted">{people.length}/{limits.participants}</span></div>
          {ownerToken && pendingPeople.length > 0 && <section className="admission-alert" aria-label="Waiting participants"><strong>{pendingPeople.length} waiting to enter</strong>{pendingPeople.map((person) => <div key={person.id}><span>{person.name}</span><button onClick={() => decideAdmission(person.id, true)}>Admit</button><button onClick={() => decideAdmission(person.id, false)}>Deny</button></div>)}</section>}
          {keyMismatchCount > 0 && <div className="key-mismatch-alert" role="alert"><strong>{keyMismatchCount} connected device{keyMismatchCount === 1 ? " has" : "s have"} a different room key.</strong><span>Open the complete Invite link containing <code>#k=</code>. Messages cannot be decrypted across different keys.</span></div>}
          <ul className="person-list">
            {(orderedPresence.length ? orderedPresence : [{ id: socketId, name: ownName }]).map((person) => (
              <li className="person" key={person.id || person.name}>
                <div className="avatar">{initials(person.name)}</div>
                <span className="person-name">{person.name}{person.id === socketId ? " · you" : ""}</span>
                <span className="person-state" role="status" aria-label="Online"><span className="presence-pulse" /></span>
                {person.id && person.id !== socketId ? <button className="direct-chat-button" aria-label={`Direct message ${person.name}`} onClick={() => openConversation(person.id)}><PaperPlaneRight size={14} />{directUnread[person.id] ? <span>{directUnread[person.id]}</span> : null}</button> : null}
              </li>
            ))}
          </ul>
          <p className="privacy-note">Aliases, messages, and file details are encrypted in each participant’s browser. The relay stores ciphertext only.</p>
          {ownerToken && <button className="danger-button" style={{ marginTop: 16 }} onClick={destroyRoom}><Trash size={16} /> Destroy room</button>}
        </aside>

        <div className={`room-center ${meetingOpen || (screenOpen && activePresentation) ? `media-open mobile-show-${mobileCallView}` : ""}`}>
          {(meetingOpen || (screenOpen && activePresentation)) && <nav className="mobile-call-switcher" aria-label="Call view"><button className={mobileCallView === "video" ? "active" : ""} onClick={() => setMobileCallView("video")}>Video</button><button className={mobileCallView === "chat" ? "active" : ""} onClick={() => setMobileCallView("chat")}>Chat{totalDirectUnread ? <span className="unread-badge">{totalDirectUnread}</span> : null}</button></nav>}
          {fallbackPresentationPanel()}
          {meetingPanel()}
        <section className="chat-panel" aria-label="Room chat">
          <nav className="conversation-tabs" aria-label="Conversations">
            <button className={activeConversation === "group" ? "active" : ""} aria-current={activeConversation === "group" ? "page" : undefined} onClick={() => openConversation("group")}>Live conversation</button>
            {directParticipants.map((person) => <button key={person.id} className={activeConversation === person.id ? "active" : ""} aria-current={activeConversation === person.id ? "page" : undefined} onClick={() => openConversation(person.id)}>{person.name}{directUnread[person.id] ? <span className="unread-badge">{directUnread[person.id]}</span> : null}</button>)}
            {totalDirectUnread > 0 && <span className="conversation-summary" aria-label={`${totalDirectUnread} unread direct messages`}>{totalDirectUnread} new</span>}
          </nav>
          <div className="chat-heading">
            <div><p className="eyebrow">{activeConversation === "group" ? "Live conversation" : "Direct chat"}</p><h1>{activeConversation === "group" ? "Temporary by design." : activeDirectPerson?.name ?? "Direct conversation"}</h1><p className="heading-note">{activeConversation === "group" ? "Group history exists only while this server is running." : "Relay-targeted to you and this participant; content remains encrypted in transit."}</p></div>
            <button className="icon-button" aria-label="Jump to latest message" onClick={() => { const list = messageListRef.current; list?.scrollTo({ top: list.scrollHeight, behavior: "smooth" }); }}><ArrowDown size={18} /></button>
          </div>
          <div ref={messageListRef} className="message-list" role="log" aria-live="polite" aria-relevant="additions" aria-atomic="false">
            {visibleMessages.length === 0 ? (
              <div className="empty-chat"><div className="empty-symbol"><LockKey size={23} weight="duotone" /></div><strong>{activeConversation === "group" ? "The room is quiet." : "No direct messages yet."}</strong><p>{activeConversation === "group" ? "Start the group conversation. Everything sent here is encrypted before it reaches the relay." : "Start a dedicated conversation with this participant."}</p></div>
            ) : visibleMessages.map((message) => (
              <article className={`message ${message.sender === ownName ? "mine" : "theirs"}`} key={message.id}>
                <div className="avatar">{initials(message.sender)}</div>
                <div className="message-body"><div className="message-meta"><strong>{message.sender}</strong><time suppressHydrationWarning>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>{message.text ? <p className="message-copy">{renderLinkedText(message.text)}</p> : null}{message.attachment && roomKey && httpCapability ? <ChatAttachment attachment={message.attachment} onOpen={(item) => void openAttachment(item)} roomId={roomId} roomKey={roomKey} httpCapability={httpCapability} /> : null}</div>
              </article>
            ))}
          </div>
          <div className="composer-wrap">
            <div className={`mobile-connection ${connected ? "" : "offline"}`} role="status"><span className={`status-dot ${connected ? "" : "offline"}`} />{connected ? "Securely connected" : "Reconnecting securely…"}</div>
            <form className={`composer ${composerDragging ? "dragging" : ""} ${recordingVoice ? "recording" : ""}`} onDragLeave={() => setComposerDragging(false)} onDragOver={(event) => { event.preventDefault(); setComposerDragging(true); }} onDrop={(event) => void handleComposerDrop(event)} onSubmit={sendMessage}>
              <button className="icon-button" type="button" disabled={!httpCapability} aria-label="Attach a file" onClick={() => fileInputRef.current?.click()}><Paperclip size={19} /></button>
              <button className={`icon-button ${recordingVoice ? "recording-active" : ""}`} type="button" disabled={!httpCapability} aria-label={recordingVoice ? "Stop and send voice note" : "Record a voice note"} onClick={() => void toggleVoiceRecording()}><Microphone size={19} weight={recordingVoice ? "fill" : "regular"} /></button>
              <textarea rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} onPaste={(event) => void handleComposerPaste(event)} placeholder={recordingVoice ? "Recording voice note…" : activeConversation === "group" ? "Message the whole room…" : `Message ${activeDirectPerson?.name ?? "participant"}…`} aria-label="Message" />
              <button className="send-button" type="submit" disabled={!draft.trim() || !connected || recordingVoice} aria-label="Send message"><PaperPlaneRight size={18} weight="fill" /></button>
            </form>
            <p className="composer-note">{recordingVoice ? "Tap the microphone again to stop and send." : activeConversation === "group" ? "Enter to send · Shift + Enter for a new line · paste or drop files, images, and links" : "Enter to send directly · attachments also remain available in the shared room file drawer"}</p>
          </div>
        </section>
        </div>

        <aside className={`files-panel ${filesOpen ? "open" : ""}`} aria-label="Shared files">
          <div className="panel-heading"><div><h2>File container</h2><p className="heading-note">Encrypted · temporary</p></div><button className="icon-button mobile-files-button" aria-label="Close files" onClick={() => setFilesOpen(false)}><X size={18} /></button></div>
          <input ref={fileInputRef} type="file" hidden multiple disabled={!httpCapability} onChange={(event) => { void handleFiles(event.target.files); event.currentTarget.value = ""; }} />
          <button className={`drop-zone ${dragging ? "dragging" : ""}`} disabled={!httpCapability} onClick={() => fileInputRef.current?.click()} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); handleFiles(event.dataTransfer.files); }}>
            <UploadSimple size={22} weight="duotone" /><strong>{httpCapability ? "Drop anything here" : "Securing file access…"}</strong><span>Encrypted before upload · {maxFileMb} MB maximum</span>
          </button>
          {Object.entries(uploadProgress).map(([id, progress]) => <div className="upload-progress-row" key={id}><div className="progress-track" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><div className="progress-fill" style={{ width: `${progress}%` }} /></div><button className="icon-button" type="button" aria-label="Cancel upload" onClick={() => uploadRequestsRef.current.get(id)?.abort()}><X size={15} /></button></div>)}
          <ul className="file-list">
            {files.map((item) => (
              <li className="file-item" key={item.id}>
                <div className="file-kind"><FileGlyph type={item.type} /></div>
                <div className="file-info"><div className="file-name" title={item.name}>{item.name}</div><div className="file-meta">{formatBytes(item.size)} · {item.sender}</div></div>
                <button className="icon-button" aria-label={`Open ${item.name}`} onClick={() => openFile(item)}>{item.type.startsWith("image/") || item.type.startsWith("video/") ? <ArrowUp size={17} /> : <DownloadSimple size={17} />}</button>
                {item.sender === ownName ? <button className="icon-button danger-icon-button" aria-label={`Delete ${item.name}`} onClick={() => void deleteFile(item)}><Trash size={17} /></button> : null}
              </li>
            ))}
          </ul>
          {files.length === 0 && <p className="privacy-note">Shared images, videos, and documents will appear here. Nothing persists after shutdown.</p>}
        </aside>
        <aside className={`mobile-people-drawer ${peopleOpen ? "open" : ""}`} aria-label="Participants" aria-hidden={!peopleOpen} inert={!peopleOpen}>
          <div className="panel-heading"><h2>In this room</h2><button className="icon-button" aria-label="Close participants" onClick={() => setPeopleOpen(false)}><X size={18} /></button></div>
          {ownerToken && pendingPeople.length > 0 && <section className="admission-alert" aria-label="Waiting participants"><strong>{pendingPeople.length} waiting to enter</strong>{pendingPeople.map((person) => <div key={person.id}><span>{person.name}</span><button onClick={() => decideAdmission(person.id, true)}>Admit</button><button onClick={() => decideAdmission(person.id, false)}>Deny</button></div>)}</section>}
          {keyMismatchCount > 0 && <div className="key-mismatch-alert" role="alert"><strong>Different room key detected.</strong><span>Reopen the complete Invite link containing <code>#k=</code>.</span></div>}
          <ul className="person-list">{(orderedPresence.length ? orderedPresence : [{ id: socketId, name: ownName }]).map((person) => <li className="person" key={person.id || person.name}><div className="avatar">{initials(person.name)}</div><span className="person-name">{person.name}{person.id === socketId ? " · you" : ""}</span><span className="person-state" role="status" aria-label="Online"><span className="presence-pulse" /></span></li>)}</ul>
          <p className="privacy-note">{people.length}/{limits.participants} participants currently connected.</p>
        </aside>
      </div>

      {shareOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShareOpen(false)}>
          <section className="modal-card" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="invite-title">
            <div className="panel-heading"><div><p className="eyebrow">Invite routes</p><h2 id="invite-title">{routes.length > 1 ? "One room, multiple entrances." : "Choose an invitation route."}</h2></div><button className="icon-button" aria-label="Close invite dialog" onClick={() => setShareOpen(false)}><X size={18} /></button></div>
            <p>Choose Tor for stronger network privacy or the browser link for guests who do not have Tor.</p>
            <div className="route-list">
              {(routes.length ? routes : [{ type: "local" as const, baseUrl: window.location.origin }]).map((route) => (
                <div className="route-row" key={`${route.type}-${route.baseUrl}`}><div><div className="route-type">{route.type === "onion" ? "Tor Browser" : route.type === "cloudflare" ? "Normal browser" : window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "Local network" : "Direct browser"}</div><div className="route-url">{guestLink(route)}</div></div><button className="icon-button" aria-label={`Copy ${route.type} invitation`} onClick={() => copyRoute(route)}><Copy size={17} /></button></div>
              ))}
            </div>
            <div className="security-row"><LockKey size={17} /><span>The encryption key stays after # and is never sent in an HTTP request.</span></div>
          </section>
        </div>
      )}

      {securityOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setSecurityOpen(false)}>
          <section className="modal-card" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="privacy-title">
            <div className="panel-heading"><div><p className="eyebrow">Privacy model</p><h2 id="privacy-title">Private, with honest limits.</h2></div><button className="icon-button" aria-label="Close privacy dialog" onClick={() => setSecurityOpen(false)}><X size={18} /></button></div>
            <p>Cinder minimizes what the relay can learn. It does not claim mathematically perfect anonymity.</p>
            <div className="security-list">
              <div className="security-row"><CheckCircle size={18} weight="fill" /><span>AES-256-GCM browser-side encryption</span></div>
              <div className="security-row"><CheckCircle size={18} weight="fill" /><span>No accounts, database, analytics, or intentional application request logs</span></div>
              <div className="security-row"><CheckCircle size={18} weight="fill" /><span>Memory-safe Rust relay with Node compatibility fallback</span></div>
              <div className="security-row"><CheckCircle size={18} weight="fill" /><span>Temporary ciphertext files deleted at shutdown</span></div>
              <div className="security-row"><CheckCircle size={18} weight="fill" /><span>Independent Tor and normal-browser routes</span></div>
              <div className="security-row"><CheckCircle size={18} weight="fill" /><span>Browser-side E2EE for camera, microphone, and screen media</span></div>
            </div>
            <div className="limit-grid" aria-label="Current room guardrails">
              <div><UsersThree size={18} /><strong>{limits.participants}</strong><span>participants</span></div>
              <div><UploadSimple size={18} /><strong>{limits.concurrentUploads}</strong><span>parallel uploads</span></div>
              <div><Files size={18} /><strong>{limits.files}</strong><span>temporary files</span></div>
              <div><Gauge size={18} /><strong>{limits.roomStorageMb >= 1024 ? `${limits.roomStorageMb / 1024} GB` : `${limits.roomStorageMb} MB`}</strong><span>ciphertext cap</span></div>
            </div>
            <p className="privacy-note">Recipients can still save or capture anything they can view. Hosting and tunnel providers may retain connection metadata.</p>
          </section>
        </div>
      )}

      {supportOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setSupportOpen(false)}>
          <section className="modal-card" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="support-room-title">
            <div className="panel-heading"><div><p className="eyebrow">Support</p><h2 id="support-room-title">Help keep Cinder Room free.</h2></div><button className="icon-button" aria-label="Close support dialog" onClick={() => setSupportOpen(false)}><X size={18} /></button></div>
            {supportPanel()}
          </section>
        </div>
      )}

      {waiting && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-card waiting-card" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="waiting-title">
            <div className="meeting-prejoin-icon"><LockKey size={28} weight="duotone" /></div>
            <p className="eyebrow">Waiting room</p>
            <h2 id="waiting-title">The host will let you in.</h2>
            <p>Your alias is encrypted. Chat, files, and meeting activity remain unavailable until admission.</p>
            <button className="soft-button" onClick={leaveRoom}><SignOut size={17} /> Leave</button>
          </section>
        </div>
      )}

      {preview && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { URL.revokeObjectURL(preview.url); setPreview(null); } }}>
          <section className="modal-card preview-card" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="preview-title">
            <div className="panel-heading"><div><p className="eyebrow">Decrypted locally</p><h2 id="preview-title">{preview.name}</h2></div><div className="row-actions"><a className="icon-button" href={preview.url} download={preview.name} aria-label="Download file"><DownloadSimple size={18} /></a><button className="icon-button" aria-label="Close preview" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null); }}><X size={18} /></button></div></div>
            {preview.type.startsWith("image/") ? (
              // Blob URLs are created after local decryption and cannot use Next image optimization.
              // eslint-disable-next-line @next/next/no-img-element
              <img className="preview-media" src={preview.url} alt={preview.name} />
            ) : <video className="preview-media" src={preview.url} controls />}
          </section>
        </div>
      )}

      {confirmDialog && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeConfirm()}>
          <section className="modal-card confirm-card" tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
            <p className="eyebrow">{confirmDialog.tone === "danger" ? "Destructive action" : "Confirm action"}</p>
            <h2 id="confirm-title">{confirmDialog.title}</h2>
            <p id="confirm-message">{confirmDialog.message}</p>
            <div className="confirm-actions">
              <button className="soft-button" type="button" onClick={closeConfirm}>Cancel</button>
              <button className={confirmDialog.tone === "danger" ? "danger-button" : "primary-button"} type="button" onClick={confirmAction}>
                {confirmDialog.tone === "danger" ? <Trash size={16} /> : null}
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </section>
        </div>
      )}

      <footer className="room-footer">
        <button className="support-footer-link" type="button" onClick={() => setSupportOpen(true)}>
          <Coffee size={16} weight="fill" /> Support the project
        </button>
      </footer>

      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
