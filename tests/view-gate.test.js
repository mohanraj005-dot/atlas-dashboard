// tests/view-gate.test.js
// End-to-end coverage of the flat-password view gate, driven through
// worker.fetch (src/index.js) so it exercises the real route split rather
// than the handlers in isolation.
//
// The load-bearing test in this file is the LAST describe block: the headless
// collector holds no cookie, and if POST /v1/ingest ever lands behind the
// gate it fails on its next 30-minute tick with a 401 that looks exactly like
// a signing bug. That regression must stay green.
import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect } from "vitest";
import worker from "../src/index.js";
import { sha256Hex } from "../src/lib/hash.js";
import {
  SESSION_COOKIE,
  buildSessionCookie,
  issueSessionToken,
} from "../src/lib/session.js";

const ORIGIN = "https://atlas.example.com";
const GENERATED_AT = "2026-08-09T06:00:00Z";

function field(section, key, value, confidence, source) {
  return { section, key, value, confidence, source, as_of: GENERATED_AT };
}

const ENVELOPE = {
  schema_version: 1,
  tenant_id: "local",
  collector_version: "0.1.0",
  run_id: "run-view-gate",
  generated_at: GENERATED_AT,
  ok: true,
  errors: [],
  projects: [
    {
      slug: "atlas",
      name: "Atlas",
      tier: "T3",
      planner_version: null,
      parser_status: "ok",
      fields: [
        field("identity", "name", "Atlas", "declared", "registry"),
        field("identity", "tier", "T3", "derived", "collector"),
        field("identity", "provenance", "git + .planning", "derived", "collector"),
        field("freshness", "last_activity", GENERATED_AT, "derived", "git"),
      ],
    },
  ],
};

async function hmacHex(body, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body)
  );
  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A correctly signed ingest POST carrying NO cookie — the collector's shape. */
async function collectorPush(opts = {}) {
  const { secret = env.ATLAS_INGEST_HMAC_SECRET, token = "test-token" } = opts;
  const body = JSON.stringify(ENVELOPE);
  return new Request(`${ORIGIN}/v1/ingest`, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(new TextEncoder().encode(body).length),
      Authorization: `Bearer ${token}`,
      "X-Atlas-Signature": `sha256=${await hmacHex(body, secret)}`,
    },
  });
}

function loginPost(password) {
  const body = new URLSearchParams({ password }).toString();
  return new Request(`${ORIGIN}/login`, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": String(new TextEncoder().encode(body).length),
    },
  });
}

function get(path, cookie) {
  return new Request(`${ORIGIN}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

/** Signs in for real and returns the Cookie header a browser would send back. */
async function signIn() {
  const res = await worker.fetch(loginPost(env.ATLAS_VIEW_PASSWORD), env);
  expect(res.status).toBe(302);
  const setCookie = res.headers.get("Set-Cookie");
  expect(setCookie).toBeTruthy();
  return setCookie.split(";")[0];
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM fields"),
    env.DB.prepare("DELETE FROM snapshots"),
    env.DB.prepare("DELETE FROM projects"),
    env.DB.prepare("DELETE FROM collector_runs"),
    env.DB.prepare("DELETE FROM ingest_tokens"),
  ]);
  await env.DB.prepare(
    "INSERT INTO ingest_tokens (token_hash, tenant_id, scope) VALUES (?, 'local', 'ingest:write')"
  )
    .bind(await sha256Hex("test-token"))
    .run();
});

describe("unauthenticated browser requests are gated", () => {
  it("GET / does not return the dashboard", async () => {
    const res = await worker.fetch(get("/"), env);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
    expect(res.headers.get("Set-Cookie")).toBeNull();

    const body = await res.text();
    expect(body).not.toContain("portfolio-tbody");
    expect(body).not.toContain("instrumented");
  });

  it("GET /app.js — a static asset — is gated too", async () => {
    const res = await worker.fetch(get("/app.js"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
    expect(await res.text()).not.toContain("renderPortfolio");
  });

  it("GET /api/portfolio does not return portfolio data", async () => {
    await worker.fetch(await collectorPush(), env);

    const res = await worker.fetch(get("/api/portfolio"), env);
    expect(res.status).toBe(401);

    const body = await res.text();
    expect(body).not.toContain("projects");
    expect(body).not.toContain("atlas");
    expect(body).not.toContain("coverage");
  });

  it("GET /api/health is gated", async () => {
    const res = await worker.fetch(get("/api/health"), env);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("last_run_at");
  });

  it("GET /login is open and serves the form, never the dashboard", async () => {
    const res = await worker.fetch(get("/login"), env);
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain('name="password"');
    expect(body).toContain('action="/login"');
    expect(body).not.toContain("portfolio-tbody");
  });
});

describe("signing in", () => {
  it("the correct password sets exactly one hardened cookie and unlocks the data", async () => {
    await worker.fetch(await collectorPush(), env);

    const res = await worker.fetch(loginPost(env.ATLAS_VIEW_PASSWORD), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");

    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toMatch(/Max-Age=\d+/);
    // The cookie is a signed token, never the password itself.
    expect(setCookie).not.toContain(env.ATLAS_VIEW_PASSWORD);

    const cookie = setCookie.split(";")[0];
    const dataRes = await worker.fetch(get("/api/portfolio", cookie), env);
    expect(dataRes.status).toBe(200);

    const body = await dataRes.json();
    expect(body.projects.length).toBe(1);
    expect(body.projects[0].slug).toBe("atlas");
    expect(body.coverage.total.value).toBe(1);
  });

  it("the wrong password sets no cookie and returns no data", async () => {
    await worker.fetch(await collectorPush(), env);

    const res = await worker.fetch(loginPost("not-the-password"), env);
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();

    const body = await res.text();
    expect(body).toContain("Incorrect password.");
    expect(body).not.toContain("portfolio-tbody");
    expect(body).not.toContain("atlas");
  });

  it("an empty submission is rejected like any other wrong password", async () => {
    const res = await worker.fetch(loginPost(""), env);
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("an already-signed-in browser is bounced off /login without a new cookie", async () => {
    const cookie = await signIn();
    const res = await worker.fetch(get("/login", cookie), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("the login body ceiling holds against a dishonest client", () => {
  // Threat T-1-31. The ceiling used to read Content-Length and nothing else,
  // so a chunked request that simply omitted the header evaluated to 0, sailed
  // past the guard and reached an unbounded formData(). The ingest path has
  // always re-checked the real byte length after the read (src/ingest.js);
  // login now does the same. A guard that only works when the attacker
  // volunteers an honest header is not a guard.
  const OVERSIZED = "x".repeat(8192);

  it("rejects an oversized body that declares its true Content-Length", async () => {
    const body = new URLSearchParams({ password: OVERSIZED }).toString();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/login`, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": String(new TextEncoder().encode(body).length),
        },
      }),
      env
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("rejects an oversized body sent with NO Content-Length at all", async () => {
    const body = new URLSearchParams({ password: OVERSIZED }).toString();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    const res = await worker.fetch(
      new Request(`${ORIGIN}/login`, {
        method: "POST",
        body: stream,
        duplex: "half",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
      env
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("still lets a normal-sized password through", async () => {
    const res = await worker.fetch(loginPost(env.ATLAS_VIEW_PASSWORD), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toBeTruthy();
  });
});

describe("forged and tampered cookies are rejected", () => {
  it("a bare flag value does not authenticate", async () => {
    for (const forged of ["1", "true", "authed", "v1.9999999999.deadbeef"]) {
      const res = await worker.fetch(
        get("/api/portfolio", `${SESSION_COOKIE}=${forged}`),
        env
      );
      expect(res.status).toBe(401);
    }
  });

  it("a well-formed cookie signed with the wrong secret fails verification", async () => {
    const token = await issueSessionToken(
      "an-attackers-guess",
      Math.floor(Date.now() / 1000)
    );
    const res = await worker.fetch(
      get("/api/portfolio", buildSessionCookie(token).split(";")[0]),
      env
    );
    expect(res.status).toBe(401);
  });

  it("extending the expiry of a real cookie invalidates its signature", async () => {
    const cookie = await signIn();
    const [name, value] = cookie.split("=");
    const [version, exp, signature] = value.split(".");
    const extended = `${name}=${version}.${Number(exp) + 31_536_000}.${signature}`;

    const res = await worker.fetch(get("/api/portfolio", extended), env);
    expect(res.status).toBe(401);
  });

  it("an expired-but-genuine cookie is rejected", async () => {
    const token = await issueSessionToken(
      env.ATLAS_VIEW_PASSWORD,
      Math.floor(Date.now() / 1000) - 120,
      60
    );
    const res = await worker.fetch(
      get("/api/portfolio", `${SESSION_COOKIE}=${token}`),
      env
    );
    expect(res.status).toBe(401);
  });

  it("a gated route's method check is only reachable once authenticated", async () => {
    const anon = await worker.fetch(
      new Request(`${ORIGIN}/api/health`, { method: "POST" }),
      env
    );
    expect(anon.status).toBe(401);

    const cookie = await signIn();
    const authed = await worker.fetch(
      new Request(`${ORIGIN}/api/health`, {
        method: "POST",
        headers: { Cookie: cookie },
      }),
      env
    );
    expect(authed.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// The regression that protects the collector. Do not weaken these.
// ---------------------------------------------------------------------------
describe("POST /v1/ingest stays OPEN — the collector holds no cookie", () => {
  it("a valid token + valid signature still succeeds with NO cookie present", async () => {
    const request = await collectorPush();
    expect(request.headers.get("Cookie")).toBeNull();

    const res = await worker.fetch(request, env);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.run_id).toBe(ENVELOPE.run_id);
    expect(body.projects_seen).toBe(1);

    const runs = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM collector_runs"
    ).first();
    expect(runs.n).toBe(1);
  });

  it("a bad signature still fails on the SIGNATURE, not on the view gate", async () => {
    const res = await worker.fetch(
      await collectorPush({ secret: "a-different-secret" }),
      env
    );
    expect(res.status).toBe(401);
    // The literal ingest-path message proves the request reached handleIngest
    // rather than being turned away by the gate.
    expect(await res.text()).toBe("invalid signature");
  });

  it("a wrong method on the open ingest route is still a 405, not a redirect", async () => {
    const res = await worker.fetch(get("/v1/ingest"), env);
    expect(res.status).toBe(405);
  });
});
