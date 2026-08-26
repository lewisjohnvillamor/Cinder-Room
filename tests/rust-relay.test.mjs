import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { io } from "socket.io-client";

const port = 34192;

async function waitForServer(child) {
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  for (let attempt = 0; attempt < 480; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        const health = await response.json();
        const roomId = output.match(/Host local link: http:\/\/localhost:\d+\/room\/([A-Za-z0-9_-]+)/)?.[1];
        const ownerToken = output.match(/#o=([A-Za-z0-9_-]+)/)?.[1];
        if (roomId && ownerToken) return { ...health, roomId, ownerToken };
      }
    } catch {}
    if (child.exitCode !== null) throw new Error(`Rust relay exited early:\n${output}`);
    await delay(250);
  }
  throw new Error(`Rust relay did not become ready:\n${output}`);
}

function connect(roomId) {
  return io(`http://127.0.0.1:${port}`, {
    auth: { room: roomId },
    transports: ["websocket"],
  });
}

test("Rust relay matches the encrypted room, admission, moderation, and media protocol", async (context) => {
  const child = spawn("cargo", ["run", "--quiet", "--manifest-path", "rust-server/Cargo.toml"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), CINDER_ROUTES: "local", ROOM_TTL_MINUTES: "5", MAX_PARTICIPANTS: "3", MAX_FILES: "1", LIVEKIT_URL: "ws://localhost:7880", LIVEKIT_API_KEY: "test-key", LIVEKIT_API_SECRET: "test-secret" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));
  const health = await waitForServer(child);
  assert.equal(health.ok, true);
  assert.equal(health.relay, "rust");
  assert.equal(health.mediaConfigured, true);
  assert.equal(health.limits.participants, 3);
  assert.match(health.roomId, /^[A-Za-z0-9_-]{12,}$/);

  const page = await fetch(`http://127.0.0.1:${port}/room/${health.roomId}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Cinder Room/);
  assert.equal(page.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(page.headers.get("permissions-policy"), /camera=\(self\)/);
  assert.equal(page.headers.get("cross-origin-opener-policy"), "same-origin");

  const presenter = connect(health.roomId);
  const viewer = connect(health.roomId);
  context.after(() => presenter.close());
  context.after(() => viewer.close());
  await Promise.all([
    new Promise((resolve, reject) => { presenter.once("connect", resolve); presenter.once("connect_error", reject); }),
    new Promise((resolve, reject) => { viewer.once("connect", resolve); viewer.once("connect_error", reject); }),
  ]);

  const encryptedAlias = "Z".repeat(32);
  const presence = new Promise((resolve) => presenter.once("presence", resolve));
  const presenterAdmitted = new Promise((resolve) => presenter.once("admission:admitted", resolve));
  presenter.emit("room:join", { encryptedAlias, ownerToken: health.ownerToken });
  await presence;
  const { httpCapability } = await presenterAdmitted;
  const viewerAdmitted = new Promise((resolve) => viewer.once("admission:admitted", resolve));
  viewer.emit("room:join", { encryptedAlias: "V".repeat(32) });
  const { httpCapability: viewerCapability } = await viewerAdmitted;
  const impersonation = await fetch(`http://127.0.0.1:${port}/api/media-token?room=${health.roomId}`, { headers: { "X-Cinder-Alias": encryptedAlias, "X-Cinder-Capability": viewerCapability } });
  assert.equal(impersonation.status, 403);
  const mediaResponse = await fetch(`http://127.0.0.1:${port}/api/media-token?room=${health.roomId}`, { headers: { "X-Cinder-Alias": encryptedAlias, "X-Cinder-Capability": httpCapability } });
  assert.equal(mediaResponse.status, 201);
  const media = await mediaResponse.json();
  assert.equal(media.serverUrl, "ws://localhost:7880");
  const mediaClaims = JSON.parse(Buffer.from(media.participantToken.split(".")[1], "base64url").toString());
  assert.equal(mediaClaims.video.room, health.roomId);
  assert.equal(mediaClaims.metadata, encryptedAlias);
  assert.equal(mediaClaims.sub, presenter.id);
  const meetingActivity = new Promise((resolve) => presenter.once("meeting:signal", resolve));
  presenter.emit("meeting:signal", { encrypted: "S".repeat(32) });
  assert.equal((await meetingActivity).encrypted, "S".repeat(32));
  const mediaPresentAccepted = await new Promise((resolve) => presenter.emit("media:present:start", {}, resolve));
  assert.equal(mediaPresentAccepted.ok, true);
  const competingPresenter = await new Promise((resolve) => viewer.emit("media:present:start", {}, resolve));
  assert.equal(competingPresenter.ok, false);
  presenter.emit("media:present:stop");

  const received = new Promise((resolve) => viewer.once("message:new", resolve));
  presenter.emit("message:send", { encrypted: "A".repeat(32) });
  const message = await received;
  assert.equal(message.encrypted, "A".repeat(32));
  assert.ok(message.id);

  const announced = new Promise((resolve) => viewer.once("screen:start", resolve));
  const accepted = await new Promise((resolve) => presenter.emit("screen:start", { encrypted: "C".repeat(32) }, resolve));
  assert.equal(accepted.ok, true);
  const screenStart = await announced;
  const relayedChunk = new Promise((resolve) => viewer.once("screen:chunk", resolve));
  presenter.emit("screen:chunk", { encrypted: "D".repeat(32) });
  const chunk = await relayedChunk;
  assert.equal(chunk.streamId, screenStart.id);
  assert.equal(chunk.encrypted, "D".repeat(32));

  const muted = new Promise((resolve) => viewer.once("moderation:command", resolve));
  presenter.emit("moderation:command", { ownerToken: health.ownerToken, target: viewer.id, command: "mute" });
  assert.equal((await muted).command, "mute");

  const lateViewer = connect(health.roomId);
  context.after(() => lateViewer.close());
  const lockState = new Promise((resolve) => presenter.once("admission:state", resolve));
  presenter.emit("admission:lock", { ownerToken: health.ownerToken, locked: true });
  assert.equal((await lockState).locked, true);
  await new Promise((resolve, reject) => { lateViewer.once("connect", resolve); lateViewer.once("connect_error", reject); });
  const restoredState = new Promise((resolve) => lateViewer.once("screen:state", resolve));
  const restoredSignals = new Promise((resolve) => lateViewer.once("meeting:signals:init", resolve));
  const waiting = new Promise((resolve) => lateViewer.once("admission:waiting", resolve));
  const pending = new Promise((resolve) => presenter.once("admission:pending", resolve));
  lateViewer.emit("room:join", { encryptedAlias: "L".repeat(32) });
  await waiting;
  const pendingPeople = await pending;
  assert.equal(pendingPeople[0].id, lateViewer.id);
  presenter.emit("admission:decide", { ownerToken: health.ownerToken, socketId: lateViewer.id, allow: true });
  const state = await restoredState;
  assert.equal(state.start.encrypted, "C".repeat(32));
  assert.equal(state.chunks[0].encrypted, "D".repeat(32));
  assert.equal((await restoredSignals)[0].encrypted, "S".repeat(32));

  const rejectedViewer = connect(health.roomId);
  const capacityError = await new Promise((resolve) => rejectedViewer.once("room:error", resolve));
  assert.match(capacityError, /Room is full/);
  rejectedViewer.close();

  const fileAdded = new Promise((resolve) => viewer.once("file:added", resolve));
  const encryptedFile = new Uint8Array(64).fill(7);
  const unauthorizedUpload = await fetch(`http://127.0.0.1:${port}/api/files`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Cinder-Room": health.roomId, "X-Cinder-Meta": "B".repeat(32) },
    body: encryptedFile,
  });
  assert.equal(unauthorizedUpload.status, 403);
  const upload = await fetch(`http://127.0.0.1:${port}/api/files`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Cinder-Room": health.roomId,
      "X-Cinder-Meta": "B".repeat(32),
      "X-Cinder-Capability": httpCapability,
    },
    body: encryptedFile,
  });
  assert.equal(upload.status, 201);
  const stored = await upload.json();
  assert.equal((await fileAdded).id, stored.id);
  const download = await fetch(`http://127.0.0.1:${port}/api/files/${stored.id}?room=${health.roomId}`, { headers: { "X-Cinder-Capability": httpCapability } });
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), encryptedFile);
  const secondUpload = await fetch(`http://127.0.0.1:${port}/api/files`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Cinder-Room": health.roomId, "X-Cinder-Meta": "E".repeat(32), "X-Cinder-Capability": httpCapability },
    body: encryptedFile,
  });
  assert.equal(secondUpload.status, 507);
});
