import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mobile room and meeting layouts reserve safe-area controls", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /\.top-actions\s*\{[\s\S]*position: fixed;[\s\S]*env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.meeting-grid\s*\{[^}]*overflow-y: auto;/);
  assert.match(css, /\.meeting-controls\s*\{[^}]*env\(safe-area-inset-bottom\)/);
});

test("direct deployments create invitations from the browser origin", async () => {
  const roomApp = await readFile(new URL("../components/room-app.tsx", import.meta.url), "utf8");
  assert.match(roomApp, /route\.type === "local" \? window\.location\.origin : route\.baseUrl/);
});
