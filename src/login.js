// src/login.js
// GET /login  — serves the login page (or bounces an already-signed-in
//               browser straight to the dashboard).
// POST /login — checks the submitted password in constant time and, on
//               success, sets exactly one signed session cookie.
//
// Both routes are OPEN by definition: a gate cannot gate its own door. They
// are also the only place ATLAS_VIEW_PASSWORD is ever read as a comparison
// operand, and it is never echoed back in any response.
import { constantTimeEqual } from "./lib/hmac.js";
import {
  buildSessionCookie,
  isAuthenticated,
  issueSessionToken,
} from "./lib/session.js";
import { loginPage } from "./login-page.js";

/** A login form is never cacheable, and neither is a rejection. */
const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
};

/** Nothing a browser can legitimately submit is larger than this. */
const MAX_LOGIN_BODY_BYTES = 4096;

const NOT_CONFIGURED =
  "This deployment has no view password configured yet. Nothing is being served until it does.";

function page(status, message) {
  return new Response(loginPage(message), { status, headers: HTML_HEADERS });
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "cache-control": "no-store", ...extraHeaders },
  });
}

export async function handleLoginPage(request, env) {
  if (!env.ATLAS_VIEW_PASSWORD) {
    return page(503, NOT_CONFIGURED);
  }
  // Already signed in — no reason to show a form, and no reason to re-issue a
  // cookie either. The existing one keeps its original expiry.
  if (await isAuthenticated(request, env)) {
    return redirect("/");
  }
  return page(200, null);
}

export async function handleLoginSubmit(request, env) {
  const expected = env.ATLAS_VIEW_PASSWORD;
  if (!expected) {
    // Fail closed, loudly. A Worker without its secret serves nothing.
    return page(503, NOT_CONFIGURED);
  }

  // Declared size first — an honest oversized client costs us nothing but
  // the header read.
  const declaredLength = Number(request.headers.get("Content-Length") || "0");
  if (declaredLength > MAX_LOGIN_BODY_BYTES) {
    return page(413, "That request was too large to be a password.");
  }

  // Content-Length is a claim, not a fact: a chunked request can omit the
  // header entirely, and `Number(null || "0")` is 0, which passes any ceiling.
  // So re-check the bytes actually received, exactly as the ingest path does
  // (src/ingest.js). A guard that only fires when the attacker volunteers an
  // honest header is not a guard. Threat T-1-31.
  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    return page(400, "That form could not be read. Try again.");
  }
  if (new TextEncoder().encode(rawBody).length > MAX_LOGIN_BODY_BYTES) {
    return page(413, "That request was too large to be a password.");
  }

  let submitted = "";
  try {
    // Re-wrapped rather than parsed by hand so the enctype handling stays
    // identical to the request.formData() this replaced.
    const form = await new Response(rawBody, {
      headers: { "content-type": request.headers.get("Content-Type") || "" },
    }).formData();
    const value = form.get("password");
    submitted = typeof value === "string" ? value : "";
  } catch {
    return page(400, "That form could not be read. Try again.");
  }

  // Constant-time throughout: no early return on an empty submission, no
  // length check, no `===`. See constantTimeEqual in src/lib/hmac.js.
  const correct = await constantTimeEqual(submitted, expected);
  if (!correct) {
    // No Set-Cookie on this path, ever. The message is deliberately the same
    // for an empty, short, or nearly-correct password.
    return page(401, "Incorrect password.");
  }

  const token = await issueSessionToken(
    expected,
    Math.floor(Date.now() / 1000)
  );
  return redirect("/", { "Set-Cookie": buildSessionCookie(token) });
}
