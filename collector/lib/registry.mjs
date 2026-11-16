// collector/lib/registry.mjs
// Loads and validates collector/registry.yml — the sole discovery source.
// No crawl: no readdirSync, no glob, no `find`. A naive `find ~ -name .planning`
// yields 4 hits for 2 real projects (01-disk-recon.md § 6), so registry.yml is
// the only authoritative list. registry.yml is JSON-subset YAML (YAML 1.2 is a
// strict superset of JSON), so it is parsed with plain JSON.parse — zero
// dependencies.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  realpathSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/** Expands a leading `~/` against os.homedir(). Leaves other paths untouched. */
function expandTilde(rawPath) {
  if (rawPath.startsWith("~/")) {
    return `${homedir()}/${rawPath.slice(2)}`;
  }
  return rawPath;
}

/**
 * Resolves `p` to a canonical filesystem path for duplicate-detection
 * purposes. Falls back to the tilde-expanded raw path when the target does
 * not exist yet (a not-yet-created project directory, or a fixture path in
 * tests) — realpathSync throws ENOENT in that case, and a duplicate check
 * against a not-yet-existing directory is still meaningful as a raw-string
 * comparison. Mirrors the git adapter's own realpath canonicalization guard.
 */
function realpathOrRaw(p) {
  const expanded = expandTilde(p);
  try {
    return realpathSync(expanded);
  } catch {
    return expanded;
  }
}

/**
 * The deployed registry.yml — the only copy the running collector reads
 * (collector/atlas-collect.mjs's DEFAULT_REGISTRY_PATH / ATLAS_REGISTRY
 * convention, mirrored here so the CLI and the collector agree on the
 * target by construction).
 */
export const DEPLOYED_REGISTRY_PATH = join(homedir(), ".atlas", "registry.yml");

/** A slug must be lowercase alphanumeric-with-hyphens, starting alphanumeric. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The path-traversal guard: a slug reaches the filesystem via
 * join(projectDir, ".atlas", ...) elsewhere and via this file's duplicate
 * checks, so it must never contain "/", "..", or anything a shell/path
 * would treat specially.
 */
export function assertValidSlug(slug) {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
    throw new Error(
      `registry: invalid slug ${JSON.stringify(slug)} — must match ^[a-z0-9][a-z0-9-]*$`
    );
  }
}

/**
 * Raw parse + structural validation shared by readRegistryDoc and
 * appendRegistryEntry (which needs an injectable readFileSyncFn for
 * testability). `callerName` names the throwing function in the error
 * message so callers keep their own identity in the message text.
 */
function parseRegistryDoc(path, readFileSyncFn, callerName) {
  let raw;
  try {
    raw = readFileSyncFn(path, "utf8");
  } catch (err) {
    throw new Error(`${callerName}: could not read "${path}": ${err.message}`);
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${callerName}: "${path}" is not valid JSON-subset YAML — registry.yml must contain plain JSON. Parse error: ${err.message}`
    );
  }

  if (doc.schema_version !== 1) {
    throw new Error(
      `${callerName}: "${path}" has schema_version ${JSON.stringify(doc.schema_version)}, expected 1`
    );
  }

  if (!Array.isArray(doc.projects)) {
    throw new Error(`${callerName}: "${path}" must have a "projects" array`);
  }

  return doc;
}

/**
 * Raw parse of the registry at `path` — no tilde expansion, no
 * git_scope/skip_git defaulting. loadRegistry's transformed return value
 * must never be serialized back to disk (it would replace "~/projects/orchard"
 * with an absolute path and machine-lock the git-tracked file), so any
 * programmatic writer reads through this function instead.
 */
export function readRegistryDoc(path) {
  return parseRegistryDoc(path, readFileSync, "readRegistryDoc");
}

/**
 * Loads, parses and validates the registry at `path`.
 * Throws on any structural violation — a silent fallback is not acceptable
 * for the authoritative discovery source.
 */
export function loadRegistry(path) {
  const doc = parseRegistryDoc(path, readFileSync, "loadRegistry");

  if (doc.projects.length === 0) {
    throw new Error(
      `loadRegistry: "${path}" must have a non-empty "projects" array`
    );
  }

  const seenSlugs = new Set();
  for (const entry of doc.projects) {
    if (!entry || typeof entry !== "object") {
      throw new Error(
        `loadRegistry: "${path}" contains a non-object project entry`
      );
    }
    for (const field of ["slug", "name", "path"]) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        throw new Error(
          `loadRegistry: "${path}" has a project entry missing a non-empty "${field}"`
        );
      }
    }
    if (seenSlugs.has(entry.slug)) {
      throw new Error(
        `loadRegistry: "${path}" has a duplicate slug "${entry.slug}"`
      );
    }
    seenSlugs.add(entry.slug);
  }

  return {
    ...doc,
    projects: doc.projects.map((entry) => ({
      ...entry,
      path: expandTilde(entry.path),
      git_scope: entry.git_scope || "root",
      skip_git: Boolean(entry.skip_git),
    })),
  };
}

/**
 * Atomically, idempotently appends one entry to the registry at `path`.
 * Idempotent on both slug and realpath (two slugs pointing at one directory
 * would otherwise double-count that project in coverage — loadRegistry
 * dedupes on slug but not on path).
 *
 * `deps` allows {writeFileSyncFn, renameSyncFn, rmSyncFn, readFileSyncFn}
 * to be injected for testability, matching the injectable-deps convention
 * atlas-collect.mjs's main() already establishes.
 *
 * Crash-safety: writes to `${path}.tmp-{random}` in the same directory,
 * then renameSync's it into place — a same-directory rename is atomic on
 * one filesystem, which is the entire story for why a crash mid-write
 * cannot leave loadRegistry's hard-throw-on-malformed posture staring at a
 * torn file.
 *
 * Concurrency-safety: an exclusive `${path}.lock` file, opened with the
 * "wx" flag, is held across the read-check-write sequence and released in
 * a finally block. This closes the TOCTOU window between the duplicate
 * check and the rename — without it, two concurrent `atlas init` runs
 * could both read the pre-append doc and the second rename would silently
 * drop the first append.
 */
export function appendRegistryEntry(path, entry, deps = {}) {
  const {
    writeFileSyncFn = writeFileSync,
    renameSyncFn = renameSync,
    rmSyncFn = rmSync,
    readFileSyncFn = readFileSync,
  } = deps;

  assertValidSlug(entry?.slug);
  if (typeof entry.name !== "string" || entry.name.length === 0) {
    throw new Error("appendRegistryEntry: entry.name must be a non-empty string");
  }
  if (typeof entry.path !== "string" || entry.path.length === 0) {
    throw new Error("appendRegistryEntry: entry.path must be a non-empty string");
  }

  const lockPath = `${path}.lock`;
  let lockFd;
  try {
    lockFd = openSync(lockPath, "wx");
  } catch (err) {
    if (err.code === "EEXIST") {
      throw new Error(
        `appendRegistryEntry: another atlas init appears to be running (lock file ${lockPath} exists) — remove it if that is stale`
      );
    }
    throw err;
  }

  try {
    const doc = parseRegistryDoc(path, readFileSyncFn, "readRegistryDoc");

    const existingBySlug = doc.projects.find((p) => p.slug === entry.slug);
    if (existingBySlug) {
      return { written: false, reason: "already_registered", entry: existingBySlug };
    }

    const newRealpath = realpathOrRaw(entry.path);
    const existingByPath = doc.projects.find((p) => realpathOrRaw(p.path) === newRealpath);
    if (existingByPath) {
      return { written: false, reason: "path_already_registered", entry: existingByPath };
    }

    doc.projects.push(entry);
    const serialized = JSON.stringify(doc, null, 2) + "\n";

    const tmpPath = `${path}.tmp-${randomBytes(6).toString("hex")}`;
    writeFileSyncFn(tmpPath, serialized, "utf8");
    try {
      renameSyncFn(tmpPath, path);
    } catch (err) {
      rmSyncFn(tmpPath, { force: true });
      throw err;
    }

    return { written: true, entry };
  } finally {
    closeSync(lockFd);
    unlinkSync(lockPath);
  }
}

/**
 * Pure merge of a git-tracked `sourceDoc` with a live `deployedDoc` — no
 * I/O, so both install.mjs and its tests share one implementation.
 *
 * Source is authoritative for a shared slug: the git-tracked registry.yml
 * is the curated allowlist (the no-crawl rule), so a locally-edited
 * deployed copy never silently overrides it. Deployed-only entries
 * (typically ones `atlas init` added since the last install) are
 * preserved unless their path collides with a source entry under a
 * different slug, in which case the collision is reported in `conflicts`
 * and NOT merged — two slugs on one directory would double-count that
 * project in coverage.
 */
export function mergeRegistryDocs(sourceDoc, deployedDoc) {
  if (!deployedDoc) {
    return { doc: sourceDoc, added: [], preserved: [], conflicts: [] };
  }

  const sourceSlugs = new Set(sourceDoc.projects.map((p) => p.slug));
  const deployedSlugs = new Set(deployedDoc.projects.map((p) => p.slug));

  const added = sourceDoc.projects
    .filter((p) => !deployedSlugs.has(p.slug))
    .map((p) => p.slug);

  const projects = [...sourceDoc.projects];
  const preserved = [];
  const conflicts = [];

  for (const entry of deployedDoc.projects) {
    if (sourceSlugs.has(entry.slug)) continue; // source wins on a shared slug

    const entryRealpath = realpathOrRaw(entry.path);
    const collision = sourceDoc.projects.find(
      (p) => realpathOrRaw(p.path) === entryRealpath
    );
    if (collision) {
      conflicts.push({ slug: entry.slug, path: entry.path, collides_with: collision.slug });
      continue;
    }

    projects.push(entry);
    preserved.push(entry.slug);
  }

  return {
    doc: { ...sourceDoc, projects },
    added,
    preserved,
    conflicts,
  };
}
