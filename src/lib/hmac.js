// src/lib/hmac.js
// HMAC-SHA256 primitives via Web Crypto — the project's ONLY crypto module.
// crypto.subtle.verify IS the timing-safe comparison — never compare hex
// strings with `===` and never hand-roll a constant-time loop.
//
// Two consumers share this file deliberately, so there is one implementation
// to review rather than two:
//   1. src/ingest.js — verifies `X-Atlas-Signature` over the raw request body
//      (signed pushes).
//   2. src/lib/session.js — signs and verifies the view-gate session cookie,
//      and compares the submitted view password in constant time.

const SIGNATURE_PREFIX = "sha256=";

function hexToBytes(hex) {
  if (
    typeof hex !== "string" ||
    hex.length === 0 ||
    hex.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(hex)
  ) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function importKey(secret, usages) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

/**
 * HMAC-SHA256 of `message` under `secret`, hex-encoded. Throws only if the
 * secret is unusable (undefined/null) — callers that can be reached without a
 * provisioned secret must check for it first and fail closed.
 */
export async function signHex(message, secret) {
  const key = await importKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );
  return bytesToHex(signature);
}

/**
 * Verifies a hex HMAC-SHA256 over `message` under `secret`. Returns false —
 * never throws — for a non-hex signature, a missing secret, or any Web Crypto
 * error, so every failure mode collapses to a single "reject" branch.
 * The comparison itself is crypto.subtle.verify, which is timing-safe.
 */
export async function verifyHex(message, hex, secret) {
  const sigBytes = hexToBytes(hex);
  if (!sigBytes) {
    return false;
  }
  try {
    const key = await importKey(secret, ["verify"]);
    return await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      new TextEncoder().encode(message)
    );
  } catch {
    return false;
  }
}

/**
 * Timing-safe string equality for secret material (the submitted view
 * password against the provisioned one).
 *
 * Double-HMAC comparison: both sides are MAC'd under a random 32-byte key
 * generated per call, then compared by crypto.subtle.verify. A byte-by-byte
 * early return would leak the shared prefix through timing, and a length
 * check would leak the length; MACs are always 32 bytes, so neither the
 * length nor the prefix of the real password is observable. The ephemeral key
 * means an attacker cannot precompute either MAC.
 */
export async function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  try {
    const ephemeral = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey(
      "raw",
      ephemeral,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );
    const encoder = new TextEncoder();
    const macA = await crypto.subtle.sign("HMAC", key, encoder.encode(a));
    return await crypto.subtle.verify("HMAC", key, macA, encoder.encode(b));
  } catch {
    return false;
  }
}

/**
 * Verifies `X-Atlas-Signature: sha256=<hex>` against `rawBody`, keyed by
 * `secret`. Returns false — never throws — for a missing header, a malformed
 * prefix, or a non-hex body, so callers can treat every failure mode
 * uniformly as "reject with 401".
 */
export async function verifySignature(rawBody, headerValue, secret) {
  if (!headerValue || !headerValue.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }
  return verifyHex(rawBody, headerValue.slice(SIGNATURE_PREFIX.length), secret);
}
