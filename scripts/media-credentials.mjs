import { randomBytes } from "node:crypto";

export function createEphemeralMediaCredentials() {
  return {
    apiKey: `cinder_${randomBytes(12).toString("hex")}`,
    apiSecret: randomBytes(32).toString("base64url"),
    ephemeral: true,
  };
}

export function resolveMediaCredentials(environment = process.env) {
  const apiKey = environment.LIVEKIT_API_KEY?.trim() ?? "";
  const apiSecret = environment.LIVEKIT_API_SECRET?.trim() ?? "";

  if (Boolean(apiKey) !== Boolean(apiSecret)) {
    throw new Error("LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set together.");
  }

  if (apiKey && apiSecret) return { apiKey, apiSecret, ephemeral: false };
  return createEphemeralMediaCredentials();
}

export function liveKitKeysValue(credentials) {
  return `${credentials.apiKey}: ${credentials.apiSecret}`;
}
