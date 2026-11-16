// collector/lib/envelope.mjs
// Envelope construction with per-field provenance. There is no code path
// here that emits a bare scalar — every field carries confidence, source
// and as_of.

import { computeTier, computeProvenance } from "./tier.mjs";

/**
 * Builds the four base fields for one project: identity/name,
 * identity/tier, identity/provenance, freshness/last_activity — plus any declared fields from that project's `.atlas/project.yml`
 * merged in, deduplicated and sorted by section then key so field order is
 * stable across runs.
 *
 * @param {object} entry - a registry entry (slug, name, path, skip_git, ...)
 * @param {object|null} gitResult - the shape returned by collectGit, or
 *   null when git was never invoked (e.g. entry.skip_git is true)
 * @param {{hasPlanning: boolean, hasRoadmapAndState: boolean}} presence
 * @param {string} generatedAt - ISO timestamp for this collector run
 * @param {Array} declaredFields - fields from collectDeclared, defaulting to
 *   empty so every pre-existing call site keeps working unchanged
 */
export function buildProjectFields(entry, gitResult, presence, generatedAt, declaredFields = []) {
  const value = gitResult && gitResult.value != null ? gitResult.value : null;
  const hasCommit = value !== null;

  const tier = computeTier({
    hasPlanning: presence.hasPlanning,
    hasRoadmapAndState: presence.hasRoadmapAndState,
    hasCommit,
    skipGit: Boolean(entry.skip_git),
  });

  const provenance = computeProvenance({
    hasPlanning: presence.hasPlanning,
    hasGit: hasCommit,
  });

  const freshnessField =
    value !== null
      ? {
          section: "freshness",
          key: "last_activity",
          value,
          confidence: "derived",
          source: "git",
          // as_of is the author date itself — a fixed historical fact the
          // instant it is read — never generatedAt. Stamping read-time here
          // would also change the ingest content hash on every run,
          // permanently breaking dedup.
          as_of: value,
        }
      : {
          section: "freshness",
          key: "last_activity",
          value: null,
          confidence: "unknown",
          source: entry.skip_git ? "registry" : "git",
          as_of: generatedAt,
        };

  const fields = [
    {
      section: "identity",
      key: "name",
      value: entry.name,
      confidence: "declared",
      source: "registry",
      as_of: generatedAt,
    },
    {
      section: "identity",
      key: "tier",
      value: tier,
      confidence: "derived",
      source: "collector",
      as_of: generatedAt,
    },
    {
      section: "identity",
      key: "provenance",
      value: provenance,
      confidence: "derived",
      source: "collector",
      as_of: generatedAt,
    },
    freshnessField,
  ];

  // Collision rule: identity/name above ships with
  // source: "registry" as a stand-in default. The `fields` table's primary
  // key is (tenant_id, slug, snapshot_id, section, key), so a second
  // identity/name reaching the same ingest batch is a D1 constraint
  // failure, not a harmless double-write. Concatenate declaredFields last
  // so a human's explicit identity.name — a real statement — wins over the
  // registry default on any (section,key) collision.
  const merged = new Map();
  for (const f of [...fields, ...declaredFields]) {
    merged.set(`${f.section}/${f.key}`, f);
  }

  return [...merged.values()].sort((a, b) => {
    if (a.section !== b.section) return a.section < b.section ? -1 : 1;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return 0;
  });
}

/**
 * Builds the schema_version 1 envelope. `parser_status` is "ok" and
 * `planner_version` is null for now — a planning-tool adapter that would
 * populate it meaningfully is not implemented.
 */
export function buildEnvelope({
  tenantId,
  collectorVersion,
  runId,
  generatedAt,
  ok,
  errors,
  projects,
}) {
  return {
    schema_version: 1,
    tenant_id: tenantId,
    collector_version: collectorVersion,
    run_id: runId,
    generated_at: generatedAt,
    ok,
    errors: errors || [],
    projects: projects || [],
  };
}
