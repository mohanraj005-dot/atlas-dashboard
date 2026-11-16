// src/index.js — Worker entry point.
// Plain ES module default export, no framework, no router library, no build
// step. Two route tables keyed by pathname then method — a wrong method on a
// known path returns 405 rather than falling through to static assets; an
// unknown path falls through to env.ASSETS.fetch.
//
// ---------------------------------------------------------------------------
// THE ROUTE SPLIT — the whole correctness question of the view gate.
//
// OPEN (no session cookie required):
//   POST /v1/ingest   — already authenticated by a bearer token PLUS an
//                       HMAC-SHA256 signature over the raw body. The launchd
//                       collector runs headless every 30 minutes and holds NO
//                       cookie. Gating this would break the collector on its
//                       next tick, and the failure would look like a signing
//                       bug rather than an auth-gate bug. Do not "tidy" this
//                       into the gated table.
//   GET/POST /login   — a gate cannot gate its own door.
//
// GATED (valid signed session cookie required):
//   /                 — the dashboard shell
//   /app.js and every other static asset — wrangler.jsonc sets
//                       run_worker_first: true, so asset requests reach this
//                       function and the default branch below gates them.
//   /api/portfolio    — the project data itself
//   /api/health       — collector state
//
// The gate check sits BETWEEN the two tables, so a gated path's method check
// happens only after authentication — an anonymous prober cannot learn which
// methods a gated route accepts.
// ---------------------------------------------------------------------------
import { handleIngest } from "./ingest.js";
import { handlePortfolio } from "./portfolio.js";
import { handleHealth } from "./health.js";
import { handleLoginPage, handleLoginSubmit } from "./login.js";
import { isAuthenticated } from "./lib/session.js";

const OPEN_ROUTES = {
  "/v1/ingest": { POST: handleIngest },
  "/login": { GET: handleLoginPage, POST: handleLoginSubmit },
};

const GATED_ROUTES = {
  "/api/portfolio": { GET: handlePortfolio },
  "/api/health": { GET: handleHealth },
};

function dispatch(route, request, env) {
  const handler = route[request.method];
  if (!handler) {
    return new Response("method not allowed", { status: 405 });
  }
  return handler(request, env);
}

/**
 * The deny path. Never carries data, never carries a Set-Cookie, and is
 * always no-store so an intermediate cache can never hold a 302 in front of
 * an authenticated browser.
 */
function deny(url, env) {
  if (!env.ATLAS_VIEW_PASSWORD) {
    // Fail closed: no secret provisioned means serve nothing, not serve all.
    return new Response("view gate not configured", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
  if (url.pathname.startsWith("/api/")) {
    // An API client gets a status code, not a redirect into an HTML page.
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  }
  return new Response(null, {
    status: 302,
    headers: { Location: "/login", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const openRoute = OPEN_ROUTES[url.pathname];
    if (openRoute) {
      return dispatch(openRoute, request, env);
    }

    if (!(await isAuthenticated(request, env))) {
      return deny(url, env);
    }

    const gatedRoute = GATED_ROUTES[url.pathname];
    if (gatedRoute) {
      return dispatch(gatedRoute, request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
