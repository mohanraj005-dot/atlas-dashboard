// collector/adapters/declared.mjs
//
// Reads a project's .atlas/project.yml (plus its sibling template.lock) and
// turns it into declared envelope fields. Two non-negotiables:
//   1. This adapter never throws. Every branch returns a structured
//      {fields, declared, reason, ...} result, mirroring
//      collector/adapters/git.mjs's discipline — one bad project must never
//      abort an eleven-project run.
//   2. as_of is never read from the parsed document. It is always derived
//      from the git commit date of the last commit touching project.yml,
//      falling back to the file's mtime, and only falling back to "now" if
//      both of those fail. The parser separately rejects a literal
//      as_of key anywhere in the document.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import { loadProjectYml, sectionKeysIn } from "../lib/project-template.mjs";
import { readLock } from "../lib/lock.mjs";

export const MAX_DECLARED_FIELDS = 32;
export const MAX_DECLARED_VALUE_BYTES = 4096;

const CORE_SECTIONS = new Set(["identity", "profile", "next_action"]);

/** Presence-only check: does `<projectPath>/.atlas/project.yml` exist? */
export function hasDeclaredFile(projectPath) {
  return existsSync(join(projectPath, ".atlas", "project.yml"));
}

function fieldSort(a, b) {
  if (a.section !== b.section) return a.section < b.section ? -1 : 1;
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  return 0;
}

function deriveAsOf(path, ymlPath, budgetMs, execFileSyncFn, nowFn) {
  try {
    const out = execFileSyncFn(
      "git",
      ["log", "-1", "--format=%aI", "--", ".atlas/project.yml"],
      { cwd: path, timeout: budgetMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
    if (out) {
      return { asOf: out, asOfSource: "git" };
    }
  } catch {
    // fall through to mtime
  }

  try {
    return { asOf: statSync(ymlPath).mtime.toISOString(), asOfSource: "mtime" };
  } catch {
    // fall through to now
  }

  return { asOf: nowFn().toISOString(), asOfSource: "collector", asOfReason: "as_of_unavailable" };
}

/**
 * Reads `.atlas/project.yml` (and `.atlas/template.lock`, if present) inside
 * `rawPath` and returns declared envelope fields. Never hard-fails — see the
 * file-level comment. `execFileSyncFn` and `nowFn` are injectable for tests.
 */
export function collectDeclared(
  rawPath,
  { budgetMs = 3000, execFileSyncFn = execFileSync, nowFn = () => new Date() } = {}
) {
  // Step 1 — canonicalise, mirroring collectGit's first guard.
  let path;
  try {
    path = realpathSync(rawPath);
  } catch {
    return { fields: [], declared: false, reason: "path_not_found" };
  }

  // Step 2 — presence check.
  if (!hasDeclaredFile(path)) {
    return { fields: [], declared: false, reason: "no_declared_file" };
  }

  const atlasDir = join(path, ".atlas");
  const ymlPath = join(atlasDir, "project.yml");

  // Step 3 — parse/validate. loadProjectYml hard-fails on malformation by
  // design; this catch is the boundary that converts that hard
  // failure into a structured degradation so one bad project cannot abort
  // the run.
  let doc;
  try {
    doc = loadProjectYml(ymlPath);
  } catch (err) {
    return { fields: [], declared: false, reason: "parse_error", error: err.message };
  }

  // Step 4 — derive as_of. Never read from the document.
  const { asOf, asOfSource, asOfReason } = deriveAsOf(path, ymlPath, budgetMs, execFileSyncFn, nowFn);

  // Step 5 — read the lock. A corrupt lock must not un-declare a project
  // whose project.yml is perfectly valid.
  let reviewState = "ok";
  let templateVersion = null;
  let lockReason = null;
  try {
    const lock = readLock(atlasDir);
    if (lock) {
      reviewState = lock.review_state;
      templateVersion = lock.template_version;
    }
  } catch {
    lockReason = "lock_parse_error";
  }

  // Step 6 — emit fields, in fixed order, then one field per remaining
  // section key (covers both the six optional-canonical sections and any
  // bespoke section, with no per-section code — this is what lets bespoke
  // sections work).
  const fields = [];
  fields.push({
    section: "identity",
    key: "name",
    value: doc.identity.name,
    confidence: "declared",
    source: "declared",
    as_of: asOf,
  });
  fields.push({
    section: "identity",
    key: "statement",
    value: doc.identity.statement,
    confidence: "declared",
    source: "declared",
    as_of: asOf,
  });
  fields.push({
    section: "next_action",
    key: "statement",
    value: doc.next_action,
    confidence: "declared",
    source: "declared",
    as_of: asOf,
  });
  fields.push({
    section: "template",
    key: "profile",
    value: doc.profile,
    confidence: "declared",
    source: "declared",
    as_of: asOf,
  });
  fields.push({
    section: "template",
    key: "declared_at",
    value: asOf,
    confidence: "declared",
    source: "declared",
    as_of: asOf,
  });
  fields.push({
    section: "template",
    key: "review_state",
    value: reviewState,
    confidence: "declared",
    source: "declared",
    as_of: asOf,
  });
  if (templateVersion) {
    fields.push({
      section: "template",
      key: "version",
      value: templateVersion,
      confidence: "declared",
      source: "declared",
      as_of: asOf,
    });
  }

  for (const key of sectionKeysIn(doc)) {
    if (CORE_SECTIONS.has(key)) continue;
    fields.push({
      section: key,
      key: "value",
      value: doc[key],
      confidence: "declared",
      source: "declared",
      as_of: asOf,
    });
  }

  // Step 7 — enforce the caps. Exceeding either never drops the project —
  // it truncates and the caller pushes an errors entry instead.
  let truncated = false;
  let capReason = null;
  let capped = fields.filter((f) => {
    const withinBudget = JSON.stringify(f.value).length <= MAX_DECLARED_VALUE_BYTES;
    if (!withinBudget) {
      truncated = true;
      capReason = "value_too_large";
    }
    return withinBudget;
  });
  if (capped.length > MAX_DECLARED_FIELDS) {
    capped = capped.slice(0, MAX_DECLARED_FIELDS);
    truncated = true;
    capReason = capReason || "field_count_exceeded";
  }

  // Step 8 — sort, matching buildProjectFields's own comparator, so field
  // order is stable across runs (unstable order would change the ingest
  // content hash and permanently break dedup).
  capped.sort(fieldSort);

  const result = { fields: capped, declared: true, as_of_source: asOfSource };
  const reason = lockReason || asOfReason || capReason;
  if (reason) result.reason = reason;
  if (truncated) result.truncated = true;

  return result;
}
