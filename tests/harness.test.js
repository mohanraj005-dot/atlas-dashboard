import { env } from "cloudflare:test";
import { it, expect } from "vitest";

it("env.DB is defined", () => {
  expect(env.DB).toBeDefined();
});

it("env.ATLAS_INGEST_HMAC_SECRET is a non-empty string", () => {
  expect(typeof env.ATLAS_INGEST_HMAC_SECRET).toBe("string");
  expect(env.ATLAS_INGEST_HMAC_SECRET.length).toBeGreaterThan(0);
});
