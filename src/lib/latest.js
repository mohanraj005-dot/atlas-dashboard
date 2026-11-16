// src/lib/latest.js
// Shared read-path queries so /api/portfolio and /api/health compute their
// figures from the same underlying facts — this is what keeps
// coverage.*.as_of and health.last_run_at from being two independently
// computed numbers that can silently drift apart.
//
// Also home to resolveTenant, the single SaaS seam (seam 5) tenant
// resolution passes through on the read path. The deployment is single-tenant, so
// it always returns the constant 'local' — never a query-string or header
// value — but every future scoped-tenant check lands in this one place.

/**
 * The constant tenant seam for the read path. The deployment is single-tenant;
 * this is the one place a future scoped-tenant check would replace the
 * constant with a real lookup (e.g. from a validated session/Access claim).
 */
export function resolveTenant(_request) {
  return "local";
}

/**
 * The most recent collector_runs row for a tenant, by started_at DESC, or
 * null when the tenant has never had a run recorded. Uses
 * idx_collector_runs_tenant_started.
 */
export async function latestRun(db, tenantId) {
  const row = await db
    .prepare(
      "SELECT tenant_id, run_id, started_at, finished_at, ok, projects_seen, errors_json FROM collector_runs WHERE tenant_id = ? ORDER BY started_at DESC LIMIT 1"
    )
    .bind(tenantId)
    .first();
  return row ?? null;
}

/**
 * For every slug with at least one snapshot, the snapshot_id of the row
 * with the greatest as_of (ties broken by snapshot_id for determinism).
 * One windowed query over idx_snapshots_tenant_slug_asof — never one query
 * per project.
 */
export async function latestSnapshotIds(db, tenantId) {
  const sql =
    "SELECT slug, snapshot_id FROM (" +
    "SELECT slug, snapshot_id, " +
    "ROW_NUMBER() OVER (PARTITION BY slug ORDER BY as_of DESC, snapshot_id DESC) AS rn " +
    "FROM snapshots WHERE tenant_id = ?" +
    ") WHERE rn = 1";
  const result = await db.prepare(sql).bind(tenantId).all();
  return result.results ?? [];
}
