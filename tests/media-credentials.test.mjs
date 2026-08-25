import assert from "node:assert/strict";
import test from "node:test";
import {
  createEphemeralMediaCredentials,
  liveKitKeysValue,
  resolveMediaCredentials,
} from "../scripts/media-credentials.mjs";

test("creates distinct high-entropy one-session credentials", () => {
  const first = createEphemeralMediaCredentials();
  const second = createEphemeralMediaCredentials();

  assert.match(first.apiKey, /^cinder_[a-f0-9]{24}$/);
  assert.match(first.apiSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.apiKey, second.apiKey);
  assert.notEqual(first.apiSecret, second.apiSecret);
  assert.equal(first.ephemeral, true);
  assert.equal(liveKitKeysValue(first), `${first.apiKey}: ${first.apiSecret}`);
});

test("keeps a complete configured key pair", () => {
  assert.deepEqual(
    resolveMediaCredentials({ LIVEKIT_API_KEY: "owner-key", LIVEKIT_API_SECRET: "owner-secret" }),
    { apiKey: "owner-key", apiSecret: "owner-secret", ephemeral: false },
  );
});

test("rejects a partial configured key pair", () => {
  assert.throws(
    () => resolveMediaCredentials({ LIVEKIT_API_KEY: "owner-key" }),
    /must be set together/,
  );
});
