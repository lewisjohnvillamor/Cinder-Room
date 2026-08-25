import { spawn, spawnSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import { liveKitKeysValue, resolveMediaCredentials } from "./media-credentials.mjs";

try {
  loadEnvFile();
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const children = new Set();
let stopping = false;

function start(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 900).unref();
}

const relayEnvironment = { ...process.env };
const hasMediaUrl = Boolean(process.env.LIVEKIT_URL?.trim());
const startConfiguredMedia = process.env.CINDER_START_LIVEKIT === "true";
let mediaProcess = null;
let mediaCredentials;

try {
  mediaCredentials = resolveMediaCredentials(process.env);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (startConfiguredMedia) {
  const livekitAvailable = spawnSync("livekit-server", ["--version"], { stdio: "ignore" }).status === 0;
  if (!livekitAvailable || !hasMediaUrl || !process.env.LIVEKIT_CONFIG) {
    console.error("CINDER_START_LIVEKIT=true requires livekit-server, LIVEKIT_CONFIG, and LIVEKIT_URL.");
    process.exit(1);
  }
  relayEnvironment.LIVEKIT_API_KEY = mediaCredentials.apiKey;
  relayEnvironment.LIVEKIT_API_SECRET = mediaCredentials.apiSecret;
  const mediaEnvironment = { ...process.env, LIVEKIT_KEYS: liveKitKeysValue(mediaCredentials) };
  mediaProcess = start("livekit-server", ["--config", process.env.LIVEKIT_CONFIG], { env: mediaEnvironment });
  console.log(`Cinder is starting its configured public LiveKit media server with ${mediaCredentials.ephemeral ? "one-session" : "configured"} credentials.`);
  if (mediaCredentials.ephemeral) console.log("The generated media credentials exist only for this room process and disappear on shutdown.\n");
} else if (!hasMediaUrl) {
  const livekitAvailable = spawnSync("livekit-server", ["--version"], { stdio: "ignore" }).status === 0;
  if (livekitAvailable) {
    relayEnvironment.LIVEKIT_URL = "ws://localhost:7880";
    relayEnvironment.LIVEKIT_API_KEY = mediaCredentials.apiKey;
    relayEnvironment.LIVEKIT_API_SECRET = mediaCredentials.apiSecret;
    const mediaEnvironment = { ...process.env, LIVEKIT_KEYS: liveKitKeysValue(mediaCredentials) };
    mediaProcess = start("livekit-server", ["--bind", "127.0.0.1"], { env: mediaEnvironment });
    console.log(`Cinder encrypted media is starting with ${mediaCredentials.ephemeral ? "one-session" : "configured"} credentials for this desktop.`);
    if (mediaCredentials.ephemeral) console.log("The generated credentials are never written to disk and disappear on shutdown.");
    console.log("Public invitations still need a public LiveKit/TURN endpoint.\n");
  } else {
    console.log("Group video is disabled: install livekit-server for local media or configure LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.\n");
  }
} else {
  if (mediaCredentials.ephemeral) {
    console.error("An externally managed LIVEKIT_URL requires LIVEKIT_API_KEY and LIVEKIT_API_SECRET.");
    process.exit(1);
  }
}

const useNodeRelay = process.env.CINDER_RELAY === "node";
const relay = useNodeRelay
  ? start(process.execPath, ["--import", "tsx", "server/index.ts"], { env: relayEnvironment })
  : start("cargo", ["run", "--release", "--locked", "--manifest-path", "rust-server/Cargo.toml"], { env: relayEnvironment });
console.log(`Cinder is using the ${useNodeRelay ? "Node compatibility" : "Rust"} relay.`);
relay.once("exit", (code) => stop(code ?? 1));
mediaProcess?.once("exit", (code) => {
  if (!stopping && code) console.log("The media server stopped; chat and files remain available.");
});

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
