import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const REQUIRED_EVENTS = [
  "room:join",
  "admission:waiting",
  "admission:admitted",
  "admission:state",
  "admission:pending",
  "admission:lock",
  "admission:decide",
  "moderation:command",
  "messages:init",
  "message:send",
  "message:new",
  "direct:messages:init",
  "direct:send",
  "direct:new",
  "meeting:signals:init",
  "meeting:signal",
  "presence",
  "screen:start",
  "screen:state",
  "screen:chunk",
  "screen:stop",
  "media:present:start",
  "media:present:stop",
  "room:destroy",
  "room:destroyed",
];

test("Node and Rust relays expose the same bounded room protocol", async () => {
  const [nodeRelay, rustRelay] = await Promise.all([
    readFile("server/index.ts", "utf8"),
    readFile("rust-server/src/main.rs", "utf8"),
  ]);

  for (const event of REQUIRED_EVENTS) {
    assert.ok(nodeRelay.includes(`"${event}"`), `Node relay is missing ${event}`);
    assert.ok(rustRelay.includes(`"${event}"`), `Rust relay is missing ${event}`);
  }

  for (const header of ["x-cinder-alias", "x-cinder-capability"]) {
    assert.ok(nodeRelay.toLowerCase().includes(header));
    assert.ok(rustRelay.toLowerCase().includes(header));
  }

  assert.match(nodeRelay, /meetingSignals\.length > 150/);
  assert.match(rustRelay, /signals\.len\(\) > 150/);
});
