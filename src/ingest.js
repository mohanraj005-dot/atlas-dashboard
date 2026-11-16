// src/ingest.js
// POST /v1/ingest — token auth, HMAC envelope verification, size ceiling,
// dedup, D1 writes. Ordering is deliberate throughout: cheapest rejection
// first, no I/O before the request has proven it is authentic.
// Signed pushes (HMAC) and an as_of-excluding content hash for dedup.
import { sha256Hex, contentHash } from "./lib/hash.js";
import { verifySignature } from "./lib/hmac.js";

const MAX_INGEST_BYTES = 1_000_000;

const VALID_CONFIDENCE = new Set([
  "verified",
  "derived",
  "inferred",
  "declared",
  "unknown",
]);
const VALID_SOURCE = new Set([
  "git",
  "registry",
  "planning-tools",
  "declared",
  "collector",
]);

// these four sections are always collector/git-derived. A hand-edited
// .atlas/project.yml that bypasses atlas init still cannot fake instrumentation
// by declaring one of them — this is the second, independent layer over
// collector/lib/project-template.mjs's local parser.
const AUTO_DERIVED_SECTIONS = new Set([
  "coverage",
  "freshness",
  "phase_progress",
  "recent_activity",
]);

function text(body, status) {
  return new Response(body, { status });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isMissing(value) {
  return value === undefined || value === null;
}

function findInvalidField(projects) {
  for (const project of projects) {
    const fields = Array.isArray(project.fields) ? project.fields : [];
    for (const field of fields) {
      if (
        isMissing(field.section) ||
        isMissing(field.key) ||
        isMissing(field.confidence) ||
        isMissing(field.source) ||
        isMissing(field.as_of)
      ) {
        return "field missing provenance";
      }
      if (!VALID_CONFIDENCE.has(field.confidence)) {
        return "invalid confidence";
      }
      if (!VALID_SOURCE.has(field.source)) {
        return "invalid source";
      }
      // Guard order matters: test source === "declared" first. The collector
      // legitimately emits freshness/last_activity with source "git" or
      // "registry" — this branch must never reject that.
      if (
        field.source === "declared" &&
        AUTO_DERIVED_SECTIONS.has(field.section)
      ) {
        return `auto-derived section "${field.section}" cannot be declared`;
      }
    }
  }
  return null;
}

export async function handleIngest(request, env) {
  if (request.method !== "POST") {
    return text("method not allowed", 405);
  }

  // --- Size ceiling before anything else (Threat T-1-05): an oversized
  // body must cost the Worker nothing beyond the read, no crypto work yet.
  const contentLength = request.headers.get("Content-Length");
  if (!contentLength || Number(contentLength) > MAX_INGEST_BYTES) {
    return text("payload too large", 413);
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).length > MAX_INGEST_BYTES) {
    return text("payload too large", 413);
  }

  // --- Signature verification runs before the token lookup on purpose: it
  // is pure computation with no D1 round trip, so a forged or unsigned
  // request cannot cause a database read (Threat T-1-02).
  const signatureHeader = request.headers.get("X-Atlas-Signature");
  const validSignature = await verifySignature(
    rawBody,
    signatureHeader,
    env.ATLAS_INGEST_HMAC_SECRET
  );
  if (!validSignature) {
    return text("invalid signature", 401);
  }

  // --- Parse only after the body has proven both small enough and authentic.
  let envelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return text("malformed JSON", 400);
  }

  // --- Auth: hashed bearer token lookup, constant-time by construction
  // (Threats T-1-01, T-1-06). Never compare raw token strings.
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/, "");
  if (!token) {
    return text("unauthorized", 401);
  }
  const tokenHash = await sha256Hex(token);
  const tokenRow = await env.DB.prepare(
    "SELECT tenant_id, scope FROM ingest_tokens WHERE token_hash = ? AND revoked_at IS NULL"
  )
    .bind(tokenHash)
    .first();
  if (!tokenRow) {
    return text("unauthorized", 401);
  }
  if (tokenRow.scope !== "ingest:write") {
    return text("forbidden", 403);
  }
  const tenantId = tokenRow.tenant_id;

  // --- Envelope validation.
  if (envelope.schema_version !== 1) {
    return text("unsupported schema_version", 400);
  }
  if (isMissing(envelope.run_id) || isMissing(envelope.generated_at)) {
    return text("missing run_id or generated_at", 400);
  }
  if (!Array.isArray(envelope.projects)) {
    return text("projects must be an array", 400);
  }

  // --- Tenant isolation (Threat T-1-07): the effective tenant is always the
  // one from the token row. envelope.tenant_id is read only for comparison,
  // never bound into a SQL statement.
  if (!isMissing(envelope.tenant_id) && envelope.tenant_id !== tenantId) {
    return text("forbidden", 403);
  }

  // --- Field-level validation before any write (belt-and-braces over
  // the NOT NULL columns) — this must run before the unconditional
  // collector_runs insert below, so a malformed field writes nothing at all.
  const fieldError = findInvalidField(envelope.projects);
  if (fieldError) {
    return text(fieldError, 400);
  }

  // --- Unconditionally record the run, even when ok is false and even when
  // projects is empty. This is what makes "no run yet" and "run failed"
  // distinguishable. INSERT OR REPLACE keeps a retried push idempotent.
  await env.DB.prepare(
    "INSERT OR REPLACE INTO collector_runs (tenant_id, run_id, started_at, finished_at, ok, projects_seen, errors_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      tenantId,
      envelope.run_id,
      envelope.generated_at,
      new Date().toISOString(),
      envelope.ok ? 1 : 0,
      envelope.projects.length,
      JSON.stringify(envelope.errors || [])
    )
    .run();

  let snapshotsWritten = 0;
  const batch = [];

  for (const project of envelope.projects) {
    const fields = Array.isArray(project.fields) ? project.fields : [];

    // --- managed and review_state are derived from field provenance inside
    // the Worker only. Any equivalent columns the envelope's project object
    // itself may carry are deliberately never read — the same never-trust-
    // the-client rule that governs tenant_id (line ~123). A collector-sent
    // value for either column is ignored.
    const hasDeclaredField = fields.some((f) => f.source === "declared");
    const managed = hasDeclaredField ? "declared" : "discovered";
    const reviewField = fields.find(
      (f) => f.section === "template" && f.key === "review_state"
    );
    const reviewState =
      reviewField && reviewField.value === "needs_review"
        ? "needs_review"
        : "ok";

    batch.push(
      env.DB.prepare(
        "INSERT INTO projects (tenant_id, slug, name, tier, managed, review_state) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, slug) DO UPDATE SET name = excluded.name, tier = excluded.tier, managed = excluded.managed, review_state = excluded.review_state"
      ).bind(
        tenantId,
        project.slug,
        project.name,
        project.tier,
        managed,
        reviewState
      )
    );

    const hash = await contentHash(fields);
    const existing = await env.DB.prepare(
      "SELECT snapshot_id FROM snapshots WHERE tenant_id = ? AND slug = ? AND content_hash = ?"
    )
      .bind(tenantId, project.slug, hash)
      .first();

    if (existing) {
      // No change — dedup, nothing new written for this project.
      continue;
    }

    const snapshotId = crypto.randomUUID();
    batch.push(
      env.DB.prepare(
        "INSERT INTO snapshots (tenant_id, slug, snapshot_id, as_of, content_hash, collector_version, planner_version, parser_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        tenantId,
        project.slug,
        snapshotId,
        envelope.generated_at,
        hash,
        envelope.collector_version,
        project.planner_version ?? null,
        project.parser_status ?? "ok"
      )
    );

    for (const field of fields) {
      batch.push(
        env.DB.prepare(
          "INSERT INTO fields (tenant_id, slug, snapshot_id, section, key, value_json, confidence, source, as_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          tenantId,
          project.slug,
          snapshotId,
          field.section,
          field.key,
          JSON.stringify(field.value),
          field.confidence,
          field.source,
          field.as_of
        )
      );
    }

    snapshotsWritten++;
  }

  if (batch.length > 0) {
    await env.DB.batch(batch);
  }

  return json({
    ok: true,
    run_id: envelope.run_id,
    projects_seen: envelope.projects.length,
    snapshots_written: snapshotsWritten,
  });
}
