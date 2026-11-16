// tests/session.test.js
// Unit coverage for the view gate's crypto primitives and session token.
// These run in the real workerd runtime (so crypto.subtle is the same
// implementation production uses) but touch no D1 and no routing — the
// end-to-end gate behaviour lives in tests/view-gate.test.js.
import { describe, it, expect } from "vitest";
import { constantTimeEqual, signHex, verifyHex } from "../src/lib/hmac.js";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  buildSessionCookie,
  issueSessionToken,
  readSessionCookie,
  verifySessionToken,
} from "../src/lib/session.js";

const SECRET = "a-test-view-password";
const NOW = 1_760_000_000; // fixed epoch seconds — no wall clock in assertions

describe("hmac primitives", () => {
  it("signHex round-trips through verifyHex", async () => {
    const hex = await signHex("hello", SECRET);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyHex("hello", hex, SECRET)).toBe(true);
  });

  it("verifyHex rejects a different message, secret, or malformed hex", async () => {
    const hex = await signHex("hello", SECRET);
    expect(await verifyHex("hello!", hex, SECRET)).toBe(false);
    expect(await verifyHex("hello", hex, "another-secret")).toBe(false);
    expect(await verifyHex("hello", "not-hex", SECRET)).toBe(false);
    expect(await verifyHex("hello", "", SECRET)).toBe(false);
    expect(await verifyHex("hello", hex, undefined)).toBe(false);
  });

  it("constantTimeEqual matches only identical strings", async () => {
    expect(await constantTimeEqual("correct horse", "correct horse")).toBe(true);
    expect(await constantTimeEqual("correct horse", "correct hors")).toBe(false);
    expect(await constantTimeEqual("correct horse", "")).toBe(false);
    expect(await constantTimeEqual("", "")).toBe(true);
    expect(await constantTimeEqual("a", undefined)).toBe(false);
    expect(await constantTimeEqual(null, "a")).toBe(false);
  });
});

describe("session token", () => {
  it("issues a token that verifies under the same secret", async () => {
    const token = await issueSessionToken(SECRET, NOW);
    expect(await verifySessionToken(token, SECRET, NOW)).toBe(true);
  });

  it("is not the password and is not a bare flag", async () => {
    const token = await issueSessionToken(SECRET, NOW);
    expect(token).not.toContain(SECRET);
    expect(token.split(".").length).toBe(3);
    // A client-forged flag value must not authenticate.
    expect(await verifySessionToken("1", SECRET, NOW)).toBe(false);
    expect(await verifySessionToken("authed=1", SECRET, NOW)).toBe(false);
    expect(await verifySessionToken("", SECRET, NOW)).toBe(false);
  });

  it("rejects a tampered expiry, a tampered signature, and a foreign secret", async () => {
    const token = await issueSessionToken(SECRET, NOW);
    const [version, exp, signature] = token.split(".");

    // Extend the expiry, keep the signature — the classic replay attempt.
    const extended = `${version}.${Number(exp) + 86_400}.${signature}`;
    expect(await verifySessionToken(extended, SECRET, NOW)).toBe(false);

    // Flip the last signature nibble.
    const flipped = signature.slice(0, -1) + (signature.at(-1) === "0" ? "1" : "0");
    expect(await verifySessionToken(`${version}.${exp}.${flipped}`, SECRET, NOW)).toBe(
      false
    );

    // Signed by someone else entirely.
    const foreign = await issueSessionToken("someone-elses-secret", NOW);
    expect(await verifySessionToken(foreign, SECRET, NOW)).toBe(false);
  });

  it("expires — an old cookie cannot be replayed forever", async () => {
    const token = await issueSessionToken(SECRET, NOW, 60);
    expect(await verifySessionToken(token, SECRET, NOW + 59)).toBe(true);
    expect(await verifySessionToken(token, SECRET, NOW + 61)).toBe(false);
  });

  it("fails closed with no secret provisioned", async () => {
    const token = await issueSessionToken(SECRET, NOW);
    expect(await verifySessionToken(token, undefined, NOW)).toBe(false);
    expect(await verifySessionToken(token, "", NOW)).toBe(false);
  });
});

describe("session cookie", () => {
  it("carries every required attribute exactly once", async () => {
    const token = await issueSessionToken(SECRET, NOW);
    const cookie = buildSessionCookie(token);

    expect(cookie.startsWith(`${SESSION_COOKIE}=${token};`)).toBe(true);
    for (const attribute of [
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      "Path=/",
      `Max-Age=${SESSION_TTL_SECONDS}`,
    ]) {
      expect(cookie.split(attribute).length - 1).toBe(1);
    }
  });

  it("reads its own cookie back out of a request, alongside others", async () => {
    const request = new Request("https://example.com/", {
      headers: { Cookie: `other=1; ${SESSION_COOKIE}=abc.def; trailing=2` },
    });
    expect(readSessionCookie(request)).toBe("abc.def");

    expect(readSessionCookie(new Request("https://example.com/"))).toBeNull();
    expect(
      readSessionCookie(
        new Request("https://example.com/", { headers: { Cookie: "other=1" } })
      )
    ).toBeNull();
  });
});
