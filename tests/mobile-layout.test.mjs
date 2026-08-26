import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mobile room and meeting layouts reserve safe-area controls", async () => {
  const [css, room, meeting] = await Promise.all([
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../components/room-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/meeting-panel.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /\.top-actions\s*\{[\s\S]*position: fixed;[\s\S]*env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.meeting-grid\s*\{[^}]*overflow-y: auto;/);
  assert.match(css, /\.room-center\.media-open/);
  assert.match(css, /\.meeting-inline-shell/);
  assert.match(css, /\.room-center\.media-open[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /\.mobile-people-drawer\.open/);
  assert.match(room, /Open privacy information/);
  assert.match(room, /Open participants/);
  assert.match(room, /role="log"/);
  assert.match(room, /Cancel upload/);
  assert.match(meeting, /aria-pressed=\{microphoneOn\}/);
  assert.match(meeting, /Start device preview/);
  assert.doesNotMatch(meeting, /meeting-backdrop/);
});

test("direct deployments create invitations from the browser origin", async () => {
  const roomApp = await readFile(new URL("../components/room-app.tsx", import.meta.url), "utf8");
  assert.match(roomApp, /route\.type === "local" \? window\.location\.origin : route\.baseUrl/);
});
