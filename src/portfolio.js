// src/portfolio.js
// GET /api/portfolio — pivots the latest snapshot per registered project
// into a fully provenance-tagged response, computes coverage from stored
// tiers (never hardcoded), and sorts rows stalest-first so the most
// neglected project is the top row (ROADMAP "Patterns to fold in" #8).
//
// Every leaf value below the top level is a {value, confidence, source,
// as_of} object — the golden-fixture contract tests/portfolio.test.js
// walks and enforces.
import { latestRun, latestSnapshotIds, resolveTenant } from "./lib/latest.js";

const SECTION_KEY_TO_FIELD = {
  "identity/name": "name",
  "identity/tier": "tier",
  "identity/provenance": "provenance",
  "freshness/last_activity": "last_activity",
  "template/declared_at": "declared_at",
};
// NOTE: template/review_state is deliberately NOT in this map. review_state
// is one fact with one source — the `projects.review_state` column, derived
// server-side by src/ingest.js from the field of the same name. Pivoting it
// here too would create a second, divergeable source for the same fact.

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function unknownField(now) {
  return { value: null, confidence: "unknown", source: "collector", as_of: now };
}

export async function handlePortfolio(request, env) {
  const tenantId = resolveTenant(request);
  const now = new Date().toISOString();

  const projectsResult = await env.DB.prepare(
    "SELECT slug, name, tier, managed, review_state FROM projects WHERE tenant_id = ? ORDER BY slug"
  )
    .bind(tenantId)
    .all();
  const projectRows = projectsResult.results ?? [];

  const run = await latestRun(env.DB, tenantId);
  const asOf = run ? run.started_at : now;

  const snapshotRows = await latestSnapshotIds(env.DB, tenantId);
  const snapshotIdBySlug = new Map(
    snapshotRows.map((row) => [row.slug, row.snapshot_id])
  );
  const snapshotIds = snapshotRows.map((row) => row.snapshot_id);

  const fieldsBySlug = new Map();
  if (snapshotIds.length > 0) {
    // Placeholder count is structural (never data), built without a
    // template literal so no interpolated SQL reaches .prepare().
    const placeholders = snapshotIds.map(() => "?").join(", ");
    const sql =
      "SELECT slug, section, key, value_json, confidence, source, as_of FROM fields WHERE tenant_id = ? AND snapshot_id IN (" +
      placeholders +
      ")";
    const fieldsResult = await env.DB.prepare(sql)
      .bind(tenantId, ...snapshotIds)
      .all();
    for (const row of fieldsResult.results ?? []) {
      const fieldName = SECTION_KEY_TO_FIELD[`${row.section}/${row.key}`];
      if (!fieldName) continue;
      if (!fieldsBySlug.has(row.slug)) fieldsBySlug.set(row.slug, {});
      fieldsBySlug.get(row.slug)[fieldName] = {
        value: JSON.parse(row.value_json),
        confidence: row.confidence,
        source: row.source,
        as_of: row.as_of,
      };
    }
  }

  const projects = projectRows.map((project) => {
    const hasSnapshot = snapshotIdBySlug.has(project.slug);
    const fields = fieldsBySlug.get(project.slug) || {};

    const name = fields.name ?? {
      value: project.name,
      confidence: "declared",
      source: "registry",
      as_of: now,
    };
    const tier = fields.tier ?? {
      value: project.tier,
      confidence: "declared",
      source: "registry",
      as_of: now,
    };
    const provenance =
      hasSnapshot && fields.provenance ? fields.provenance : unknownField(now);
    const lastActivity =
      hasSnapshot && fields.last_activity
        ? fields.last_activity
        : unknownField(now);
    const declaredAt =
      hasSnapshot && fields.declared_at ? fields.declared_at : unknownField(now);

    // managed and review_state are derived/collector, not declared/declared:
    // the Worker computed them from field provenance (src/ingest.js), so the
    // value is the Worker's inference about the project, not the human's
    // declared claim itself — R2 requires that distinction stay visible.
    const managed = {
      value: project.managed ?? "discovered",
      confidence: "derived",
      source: "collector",
      as_of: asOf,
    };
    const reviewState = {
      value: project.review_state ?? "ok",
      confidence: "derived",
      source: "collector",
      as_of: asOf,
    };

    return {
      slug: project.slug,
      name,
      tier,
      provenance,
      last_activity: lastActivity,
      managed,
      review_state: reviewState,
      declared_at: declaredAt,
    };
  });

  // Stalest-first: nulls come first (nothing is staler than never), then
  // ascending by last_activity.value, then by slug for determinism.
  projects.sort((a, b) => {
    const av = a.last_activity.value;
    const bv = b.last_activity.value;
    if (av === null && bv === null) return a.slug.localeCompare(b.slug);
    if (av === null) return -1;
    if (bv === null) return 1;
    const diff = new Date(av).getTime() - new Date(bv).getTime();
    if (diff !== 0) return diff;
    return a.slug.localeCompare(b.slug);
  });

  // Note the totals asymmetry deliberately: parsedCount/declaredCount/
  // gapCount are computed over `projects` (the mapped rows) while `total`
  // stays `projectRows.length`. They are the same length; using `projects`
  // for the three predicates is what lets them read the mapped
  // `managed.value` rather than the raw D1 row.
  const parsedCount = projects.filter((p) => p.tier.value === "T3").length;
  const declaredCount = projects.filter(
    (p) => p.managed.value === "declared"
  ).length;
  // tier and managed are orthogonal, so a project can be both
  // T3 and declared. `total − parsed − declared` double-subtracts that
  // project. gap MUST stay a predicate count over the project list, never
  // arithmetic — do not "simplify" this back into subtraction.
  const gapCount = projects.filter(
    (p) => p.tier.value !== "T3" && p.managed.value !== "declared"
  ).length;
  const totalCount = projectRows.length;

  return json({
    generated_at: now,
    coverage: {
      parsed: {
        value: parsedCount,
        confidence: "derived",
        source: "collector",
        as_of: asOf,
      },
      declared: {
        value: declaredCount,
        confidence: "derived",
        source: "collector",
        as_of: asOf,
      },
      total: {
        value: totalCount,
        confidence: "derived",
        source: "registry",
        as_of: asOf,
      },
      gap: {
        value: gapCount,
        confidence: "derived",
        source: "collector",
        as_of: asOf,
      },
    },
    projects,
  });
}
