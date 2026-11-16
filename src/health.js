// src/health.js
// GET /api/health — the collector's three-state distinction: no_run, ok, or
// failed. Age is computed at request time, never stored, so freshness
// itself is never stale (a launchd StartInterval tick
// missed during sleep is dropped, not coalesced — a long gap is expected
// behavior, not a fault, and this endpoint reports rather than editorialises).
import { latestRun, resolveTenant } from "./lib/latest.js";

/**
 * Pure — no database. 'no_run' when run is null, 'failed' when run.ok is
 * falsy/0, 'ok' otherwise. Unit-testable without D1.
 */
export function collectorState(run) {
  if (!run) return "no_run";
  if (!run.ok) return "failed";
  return "ok";
}

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export async function handleHealth(request, env) {
  const tenantId = resolveTenant(request);
  const now = new Date();

  const run = await latestRun(env.DB, tenantId);
  const state = collectorState(run);

  const ageSeconds = run
    ? Math.max(
        0,
        Math.floor((now.getTime() - new Date(run.started_at).getTime()) / 1000)
      )
    : null;
  const errorsCount = run ? JSON.parse(run.errors_json || "[]").length : null;

  return json({
    state,
    last_run_at: run ? run.started_at : null,
    age_seconds: ageSeconds,
    projects_seen: run ? run.projects_seen : null,
    errors_count: errorsCount,
    as_of: now.toISOString(),
  });
}
