import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { io } from "socket.io-client";

const port = 34191;

async function waitForServer(child) {
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        const health = await response.json();
        const roomId = output.match(/Host local link: http:\/\/localhost:\d+\/room\/([A-Za-z0-9_-]+)/)?.[1];
        const ownerToken = output.match(/#o=([A-Za-z0-9_-]+)/)?.[1];
        if (roomId && ownerToken) return { ...health, roomId, ownerToken };
      }
    } catch {}
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${output}`);
    await delay(50);
  }
  throw new Error(`Server did not become ready:\n${output}`);
}

test("ephemeral relay accepts opaque real-time data and encrypted files", async (context) => {
  const serverArguments = process.env.CINDER_TEST_BUNDLED === "true"
    ? ["server-dist/index.cjs"]
    : ["--import", "tsx", "server/index.ts"];
  const child = spawn(process.execPath, serverArguments, {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), CINDER_ROUTES: "local", ROOM_TTL_MINUTES: "5", MAX_PARTICIPANTS: "3", MAX_FILES: "1", LIVEKIT_URL: "ws://localhost:7880", LIVEKIT_API_KEY: "test-key", LIVEKIT_API_SECRET: "test-secret" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));
  const health = await waitForServer(child);
  assert.equal(health.ok, true);
  assert.equal(health.relay, "node");
  assert.equal(health.mediaConfigured, true);
  assert.equal(health.limits.participants, 3);
  assert.match(health.roomId, /^[A-Za-z0-9_-]{12,}$/);

  const page = await fetch(`http://127.0.0.1:${port}/room/${health.roomId}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Cinder Room/);
  assert.match(page.headers.get("permissions-policy"), /camera=\(self\)/);

  const socket = io(`http://127.0.0.1:${port}`, { auth: { room: health.roomId }, transports: ["websocket"] });
  context.after(() => socket.close());
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  const encryptedAlias = "Z".repeat(32);
  const presence = new Promise((resolve) => socket.once("presence", resolve));
  socket.emit("room:join", { encryptedAlias, ownerToken: health.ownerToken });
  await presence;
  const mediaResponse = await fetch(`http://127.0.0.1:${port}/api/media-token?room=${health.roomId}`, { headers: { "X-Cinder-Alias": encryptedAlias, "X-Cinder-Socket": socket.id } });
  assert.equal(mediaResponse.status, 201);
  const media = await mediaResponse.json();
  assert.equal(media.serverUrl, "ws://localhost:7880");
  const mediaClaims = JSON.parse(Buffer.from(media.participantToken.split(".")[1], "base64url").toString());
  assert.equal(mediaClaims.video.room, health.roomId);
  assert.equal(mediaClaims.video.roomJoin, true);
  assert.equal(mediaClaims.metadata, encryptedAlias);
  assert.equal(mediaClaims.sub, socket.id);
  const meetingActivity = new Promise((resolve) => socket.once("meeting:signal", resolve));
  socket.emit("meeting:signal", { encrypted: "S".repeat(32) });
  assert.equal((await meetingActivity).encrypted, "S".repeat(32));
  const received = new Promise((resolve) => socket.once("message:new", resolve));
  socket.emit("message:send", { encrypted: "A".repeat(32) });
  const message = await received;
  assert.equal(message.encrypted, "A".repeat(32));
  assert.ok(message.id);

  const viewer = io(`http://127.0.0.1:${port}`, { auth: { room: health.roomId }, transports: ["websocket"] });
  context.after(() => viewer.close());
  await new Promise((resolve, reject) => { viewer.once("connect", resolve); viewer.once("connect_error", reject); });
  const viewerAdmitted = new Promise((resolve) => viewer.once("admission:admitted", resolve));
  viewer.emit("room:join", { encryptedAlias: "V".repeat(32) });
  await viewerAdmitted;
  const mediaPresentAccepted = await new Promise((resolve) => socket.emit("media:present:start", {}, resolve));
  assert.equal(mediaPresentAccepted.ok, true);
  const competingPresenter = await new Promise((resolve) => viewer.emit("media:present:start", {}, resolve));
  assert.equal(competingPresenter.ok, false);
  socket.emit("media:present:stop");
  const announced = new Promise((resolve) => viewer.once("screen:start", resolve));
  const accepted = await new Promise((resolve) => socket.emit("screen:start", { encrypted: "C".repeat(32) }, resolve));
  assert.equal(accepted.ok, true);
  const screenStart = await announced;
  assert.equal(screenStart.encrypted, "C".repeat(32));

  const relayedChunk = new Promise((resolve) => viewer.once("screen:chunk", resolve));
  socket.emit("screen:chunk", { encrypted: "D".repeat(32) });
  const chunk = await relayedChunk;
  assert.equal(chunk.encrypted, "D".repeat(32));
  assert.equal(chunk.streamId, screenStart.id);

  const muted = new Promise((resolve) => viewer.once("moderation:command", resolve));
  socket.emit("moderation:command", { ownerToken: health.ownerToken, target: viewer.id, command: "mute" });
  assert.equal((await muted).command, "mute");

  const lateViewer = io(`http://127.0.0.1:${port}`, { auth: { room: health.roomId }, transports: ["websocket"] });
  context.after(() => lateViewer.close());
  const lockState = new Promise((resolve) => socket.once("admission:state", resolve));
  socket.emit("admission:lock", { ownerToken: health.ownerToken, locked: true });
  assert.equal((await lockState).locked, true);
  await new Promise((resolve, reject) => { lateViewer.once("connect", resolve); lateViewer.once("connect_error", reject); });
  const restoredState = new Promise((resolve) => lateViewer.once("screen:state", resolve));
  const waiting = new Promise((resolve) => lateViewer.once("admission:waiting", resolve));
  const pending = new Promise((resolve) => socket.once("admission:pending", resolve));
  lateViewer.emit("room:join", { encryptedAlias: "L".repeat(32) });
  await waiting;
  const pendingPeople = await pending;
  assert.equal(pendingPeople[0].id, lateViewer.id);
  socket.emit("admission:decide", { ownerToken: health.ownerToken, socketId: lateViewer.id, allow: true });
  const state = await restoredState;
  assert.equal(state.start.encrypted, "C".repeat(32));
  assert.equal(state.chunks[0].encrypted, "D".repeat(32));

  const rejectedViewer = io(`http://127.0.0.1:${port}`, { auth: { room: health.roomId }, transports: ["websocket"], reconnection: false });
  const capacityError = await new Promise((resolve) => rejectedViewer.once("connect_error", resolve));
  assert.match(capacityError.message, /Room is full/);
  rejectedViewer.close();

  const stopped = new Promise((resolve) => viewer.once("screen:stop", resolve));
  socket.emit("screen:stop");
  assert.equal((await stopped).reason, "presenter");

  const encryptedFile = new Uint8Array(64).fill(7);
  const upload = await fetch(`http://127.0.0.1:${port}/api/files`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Cinder-Room": health.roomId, "X-Cinder-Meta": "B".repeat(32) }, body: encryptedFile });
  assert.equal(upload.status, 201);
  const stored = await upload.json();
  const download = await fetch(`http://127.0.0.1:${port}/api/files/${stored.id}?room=${health.roomId}`);
  assert.equal(download.status, 200);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), encryptedFile);
  const secondUpload = await fetch(`http://127.0.0.1:${port}/api/files`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Cinder-Room": health.roomId, "X-Cinder-Meta": "E".repeat(32) }, body: encryptedFile });
  assert.equal(secondUpload.status, 507);
});
