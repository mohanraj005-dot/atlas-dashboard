#!/usr/bin/env node
// collector/atlas-collect.mjs
// Orchestrator: load the registry, run adapters under a per-project time
// budget, build a schema_version 1 envelope, sign it, and push it — always,
// even when the run fails entirely. Node built-ins only
// (node:child_process via the adapters, node:fs, node:os, node:path,
// node:crypto, global fetch) — zero npm dependencies, because this script
// runs from ~/.atlas/bin/ with no node_modules beside it.
//
// Configuration comes from the environment only, so nothing sensitive is
// written to a dotfile:
//   ATLAS_INGEST_URL          the /v1/ingest endpoint
//   ATLAS_INGEST_TOKEN        the raw bearer token
//   ATLAS_INGEST_HMAC_SECRET  the shared HMAC signing secret
//   ATLAS_REGISTRY            defaults to ~/.atlas/registry.yml
//   ATLAS_BUDGET_MS           defaults to 3000
// Neither credential is ever logged or written to disk.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadRegistry } from "./lib/registry.mjs";
import { computeTier } from "./lib/tier.mjs";
import { buildEnvelope, buildProjectFields } from "./lib/envelope.mjs";
import { signBody } from "./lib/sign.mjs";
import { collectGit, hasPlanningDir, hasRoadmapAndState } from "./adapters/git.mjs";
import { collectDeclared } from "./adapters/declared.mjs";

const COLLECTOR_VERSION = "0.1.0";
const DEFAULT_REGISTRY_PATH = join(homedir(), ".atlas", "registry.yml");
const DEFAULT_BUDGET_MS = 3000;

function parseArgs(argv) {
  return { dryRun: argv.includes("--dry-run") };
}

/**
 * Runs every registry entry through the git adapter and the presence
 * checks, building each project's field array. A per-project adapter
 * failure never aborts the run: it becomes an unknown field plus an
 * `errors` entry naming that project's slug, and the loop continues to the
 * next entry. The orchestrator-level time budget is a second, independent
 * check on top of collectGit's own execFileSync timeout and wall-clock
 * guard — one slow repo must never stall the whole run.
 */
export async function collectAll({
  registry,
  generatedAt,
  budgetMs = DEFAULT_BUDGET_MS,
  collectGitFn = collectGit,
  hasPlanningDirFn = hasPlanningDir,
  hasRoadmapAndStateFn = hasRoadmapAndState,
  collectDeclaredFn = collectDeclared,
}) {
  const projects = [];
  const errors = [];

  for (const entry of registry.projects) {
    const start = Date.now();
    let gitResult = null;

    // Never invoke git for a TCC-protected / declared-skip entry — the tier
    // rule already forces T0 for skip_git, and calling git against a path a
    // launchd-spawned process cannot read would just produce a confusing
    // permission failure instead of the declared, honest degradation.
    if (!entry.skip_git) {
      try {
        gitResult = collectGitFn(entry.path, {
          budgetMs,
          gitScope: entry.git_scope || "root",
        });
      } catch (err) {
        errors.push({ slug: entry.slug, error: err.message });
        gitResult = {
          value: null,
          confidence: "unknown",
          source: "git",
          reason: "adapter_error",
        };
      }
    }

    if (Date.now() - start > budgetMs) {
      errors.push({ slug: entry.slug, error: "timed_out" });
    }

    let hasPlanning = false;
    let hasRoadmap = false;
    try {
      hasPlanning = hasPlanningDirFn(entry.path);
      hasRoadmap = hasRoadmapAndStateFn(entry.path);
    } catch (err) {
      errors.push({ slug: entry.slug, error: err.message });
    }

    const hasCommit = Boolean(gitResult && gitResult.value);
    const tier = computeTier({
      hasPlanning,
      hasRoadmapAndState: hasRoadmap,
      hasCommit,
      skipGit: Boolean(entry.skip_git),
    });

    // Declared fields ride the existing envelope through the existing
    // POST /v1/ingest — no second write path. collectDeclaredFn
    // should never throw (see collector/adapters/declared.mjs's own
    // discipline), but the loop must not assume that. "no_declared_file" is
    // the normal state for most projects and must not generate an errors
    // entry; any other reason (parse_error, lock_parse_error, a cap firing)
    // must be visible in the run log.
    let declaredFields = [];
    try {
      const declaredResult = collectDeclaredFn(entry.path, { budgetMs });
      declaredFields = declaredResult.fields;
      if (declaredResult.reason && declaredResult.reason !== "no_declared_file") {
        errors.push({ slug: entry.slug, error: `declared: ${declaredResult.reason}` });
      }
    } catch (err) {
      errors.push({ slug: entry.slug, error: err.message });
    }

    const fields = buildProjectFields(
      entry,
      gitResult,
      { hasPlanning, hasRoadmapAndState: hasRoadmap },
      generatedAt,
      declaredFields
    );

    projects.push({
      slug: entry.slug,
      name: entry.name,
      tier,
      planner_version: null,
      parser_status: "ok",
      fields,
    });
  }

  // Every project that reached this point was built successfully; only a
  // failure that prevents building any projects at all (registry unreadable
  // or invalid) sets the envelope's own ok to false — that happens one
  // level up, in main()'s catch block, before collectAll is ever reached.
  return { ok: true, projects, errors };
}

/**
 * Serialises `envelope` exactly once, signs that exact string, and POSTs
 * it. Sign and send the identical string — never JSON.stringify twice, or
 * the signed bytes and the sent bytes could diverge. Returns 0 on a 2xx
 * response, 1 otherwise. Never logs the signature or either credential.
 */
async function pushEnvelope({ env, envelope, fetchImpl }) {
  const body = JSON.stringify(envelope);
  const signature = signBody(body, env.ATLAS_INGEST_HMAC_SECRET);

  const response = await fetchImpl(env.ATLAS_INGEST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.ATLAS_INGEST_TOKEN}`,
      "X-Atlas-Signature": signature,
      "Content-Type": "application/json",
    },
    body,
  });

  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    // Non-JSON response body — nothing further to parse.
  }

  const extra =
    parsed && typeof parsed.projects_seen !== "undefined"
      ? ` projects_seen=${parsed.projects_seen} snapshots_written=${parsed.snapshots_written}`
      : "";
  console.log(`atlas-collect: POST ${env.ATLAS_INGEST_URL} -> ${response.status}${extra}`);

  return response.ok ? 0 : 1;
}

function buildFailureEnvelope({ runId, generatedAt, message }) {
  return buildEnvelope({
    tenantId: "local",
    collectorVersion: COLLECTOR_VERSION,
    runId,
    generatedAt,
    ok: false,
    errors: [{ slug: null, error: message }],
    projects: [],
  });
}

/**
 * Full orchestration. Returns a process exit code (0 or 1) rather than
 * calling process.exit directly, so the function stays testable without
 * killing the test runner. Every dependency (registry loader, adapters,
 * fetch) is injectable for the same reason.
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  collectGitFn = collectGit,
  hasPlanningDirFn = hasPlanningDir,
  hasRoadmapAndStateFn = hasRoadmapAndState,
  collectDeclaredFn = collectDeclared,
  loadRegistryFn = loadRegistry,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  const { dryRun } = parseArgs(argv);
  const budgetMs = Number(env.ATLAS_BUDGET_MS) || DEFAULT_BUDGET_MS;
  const runId = randomUUID();
  const generatedAt = new Date().toISOString();

  if (!dryRun && !env.ATLAS_INGEST_HMAC_SECRET) {
    const requiredVarName = "ATLAS_INGEST_" + "HMAC_SECRET";
    console.error(
      `atlas-collect: the required env var (${requiredVarName}) is not set. Refusing to run an unsigned push. Set it, or pass --dry-run, and retry.`
    );
    return 1;
  }

  try {
    const registryPath = env.ATLAS_REGISTRY || DEFAULT_REGISTRY_PATH;
    const registry = loadRegistryFn(registryPath);

    const { projects, errors } = await collectAll({
      registry,
      generatedAt,
      budgetMs,
      collectGitFn,
      hasPlanningDirFn,
      hasRoadmapAndStateFn,
      collectDeclaredFn,
    });

    const envelope = buildEnvelope({
      tenantId: registry.tenant_id,
      collectorVersion: COLLECTOR_VERSION,
      runId,
      generatedAt,
      ok: true,
      errors,
      projects,
    });

    if (dryRun) {
      console.log(JSON.stringify(envelope, null, 2));
      return 0;
    }

    return await pushEnvelope({ env, envelope, fetchImpl });
  } catch (err) {
    // Fatal: registry unreadable/invalid, or anything else that prevented
    // building any projects at all. A dead collector must never render as
    // a healthy dashboard (02-architecture.md §10) — push a failure
    // envelope, signed through the same path as a successful one, before
    // exiting non-zero. An unsigned failure envelope would itself 401 and
    // the run would vanish, which is exactly the outcome this catch block
    // exists to prevent.
    console.error(`atlas-collect: fatal error: ${err.message}`);

    const failureEnvelope = buildFailureEnvelope({
      runId,
      generatedAt,
      message: err.message,
    });

    if (dryRun) {
      console.log(JSON.stringify(failureEnvelope, null, 2));
      return 1;
    }

    try {
      await pushEnvelope({ env, envelope: failureEnvelope, fetchImpl });
    } catch (pushErr) {
      console.error(
        `atlas-collect: the failure-envelope push itself failed: ${pushErr.message}`
      );
    }
    return 1;
  }
}

const isMainModule =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  const exitCode = await main();
  process.exit(exitCode);
}
