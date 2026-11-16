// src/lib/session.js
// The view gate's session token and its cookie.
//
// The cookie value is NOT the password and NOT a flag. A client that sets
// `atlas_session=1` by hand gets rejected, because the value is an
// HMAC-SHA256-signed payload that carries its own expiry:
//
//     v1.<exp-epoch-seconds>.<hex-hmac>
//
// signed over `atlas-view-session-v1:v1.<exp>` under ATLAS_VIEW_PASSWORD. The
// domain-separation prefix means a session signature can never be replayed as
// an ingest-envelope signature or vice versa, even if the two secrets were
// ever confused. The expiry lives INSIDE the signed payload, so an old cookie
// cannot be replayed forever by a client that simply refuses to let it lapse
// — Max-Age is a browser courtesy, the signed exp is the enforcement.
//
// Crypto comes from ./hmac.js — the same Web Crypto helper the ingest path
// uses. No second implementation, no new dependency.
import { signHex, verifyHex } from "./hmac.js";

export const SESSION_COOKIE = "atlas_session";

/** 30 days. A personal dashboard behind a 32-byte random password; long
 *  enough that the owner is not retyping it weekly, short enough to be bounded. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const TOKEN_VERSION = "v1";
const DOMAIN = "atlas-view-session-v1";

function signedMessage(payload) {
  return `${DOMAIN}:${payload}`;
}

/**
 * Mints a session token expiring `ttlSeconds` after `nowSeconds`
 * (epoch seconds; injectable so tests are deterministic).
 */
export async function issueSessionToken(
  secret,
  nowSeconds,
  ttlSeconds = SESSION_TTL_SECONDS
) {
  const exp = Math.floor(nowSeconds) + ttlSeconds;
  const payload = `${TOKEN_VERSION}.${exp}`;
  const signature = await signHex(signedMessage(payload), secret);
  return `${payload}.${signature}`;
}

/**
 * True only for a well-formed, correctly signed, unexpired token. Returns
 * false — never throws — for every malformed shape, so a hostile cookie can
 * never produce a 500 that distinguishes it from a merely wrong one.
 *
 * Signature is checked BEFORE expiry on purpose: an unsigned token must not
 * be able to learn "this would have worked but for the date".
 */
export async function verifySessionToken(token, secret, nowSeconds) {
  if (typeof token !== "string" || !secret) {
    return false;
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return false;
  }
  const [version, expRaw, signature] = parts;
  if (version !== TOKEN_VERSION || !/^\d+$/.test(expRaw)) {
    return false;
  }

  const payload = `${version}.${expRaw}`;
  const valid = await verifyHex(signedMessage(payload), signature, secret);
  if (!valid) {
    return false;
  }

  return Number(expRaw) > nowSeconds;
}

/**
 * The one cookie the gate ever sets. HttpOnly (no script can read it),
 * Secure (never sent over plain HTTP), SameSite=Strict (no cross-site
 * request carries it), Path=/ (it governs the whole origin), explicit
 * Max-Age (no session cookie that outlives its signed expiry in the jar).
 */
export function buildSessionCookie(token, ttlSeconds = SESSION_TTL_SECONDS) {
  return (
    `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; ` +
    `Path=/; Max-Age=${ttlSeconds}`
  );
}

/** Reads the session cookie out of a request's Cookie header, or null. */
export function readSessionCookie(request) {
  const header = request.headers.get("Cookie");
  if (!header) {
    return null;
  }
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() === SESSION_COOKIE) {
      return pair.slice(separator + 1).trim();
    }
  }
  return null;
}

/**
 * The gate's single question. FAILS CLOSED: with no ATLAS_VIEW_PASSWORD
 * provisioned this returns false, so a Worker deployed without its secret
 * serves nothing rather than serving everything.
 */
export async function isAuthenticated(request, env) {
  const secret = env.ATLAS_VIEW_PASSWORD;
  if (!secret) {
    return false;
  }
  const token = readSessionCookie(request);
  if (!token) {
    return false;
  }
  return verifySessionToken(token, secret, Math.floor(Date.now() / 1000));
}
