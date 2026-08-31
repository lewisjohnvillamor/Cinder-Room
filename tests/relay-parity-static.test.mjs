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

// A route present in only one relay is exactly how an unreviewed endpoint slips in:
// listing known event names can never fail for a surface nobody thought to list.
test("both relays expose an identical /api surface", async () => {
  const [nodeRelay, rustRelay] = await Promise.all([
    readFile("server/index.ts", "utf8"),
    readFile("rust-server/src/main.rs", "utf8"),
  ]);

  // Node writes path params as :id, axum as {id}. Compare them in one shape.
  const apiPaths = (source) =>
    [...source.matchAll(/"(\/api\/[A-Za-z0-9\-_/:{}]*)"/g)]
      .map((match) => match[1].replace(/:([A-Za-z0-9_]+)/g, "{$1}"))
      .sort();

  const nodePaths = [...new Set(apiPaths(nodeRelay))];
  const rustPaths = [...new Set(apiPaths(rustRelay))];

  assert.deepEqual(nodePaths, rustPaths, "the two relays disagree about which /api routes exist");
  assert.ok(nodePaths.length > 0, "no /api routes were found to compare");

  // Handing the owner token to anything that claims a localhost Host header is a
  // full host takeover over the tunnel or onion route. It must not come back.
  for (const relay of [nodeRelay, rustRelay]) {
    assert.ok(!relay.includes("/api/session"), "the owner-token session route must stay removed");
    assert.ok(!/ownerToken,\s*routes/.test(relay), "the owner token must never be served over HTTP");
  }
});
