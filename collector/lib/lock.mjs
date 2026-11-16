// collector/lib/lock.mjs
// Reads and writes template.lock and computes the zero-dependency three-way
// merge that makes template upgrades trustworthy. Zero dependencies:
// no js-yaml, no diff library, no diff3 — mirrors collector/lib/registry.mjs's
// hard-throw, never-a-silent-fallback posture verbatim: readFileSync ->
// try/catch -> JSON.parse -> try/catch -> structural validation -> one named
// Error per violation. A malformed or hostile template.lock must fail loudly,
// not degrade silently into a project whose customisation was quietly
// dropped on the next upgrade.
//
// The write half has no analog anywhere else in this repo (02-PATTERNS.md
// § 2 — every other writeFileSync call renders a template output or a test
// fixture, never a config file this repo's own parser later re-reads).
// template.lock is the first such file, so writeLock deliberately copies
// registry.mjs's atomicity discipline (temp-file in the same directory,
// then renameSync into place, temp removed and error rethrown on failure)
// rather than reaching for a bare writeFileSync — upgrades must
// never half-write, and a torn lock would hard-throw in readLock on every
// subsequent run.

import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { sectionKeysIn, sectionsHash } from "./project-template.mjs";

export const LOCK_FILENAME = "template.lock";
export const UPGRADE_NOTES_FILENAME = "UPGRADE-NOTES.md";

/**
 * The two `needs_review` banner strings, fixed verbatim. Exported as module
 * constants so the copy lives in exactly one place when a future
 * change builds a surface to render them on. `{new}`/`{old}` are substituted by
 * mergeTemplate for the MAJOR case; the CONFLICT case needs no
 * substitution and is used verbatim.
 */
export const BANNER_MAJOR =
  "This project's template needs review — updated to v{new}, this project is on v{old}. See UPGRADE-NOTES.md.";
export const BANNER_CONFLICT =
  "This project's template needs review — an automatic merge found a conflict during the last update. See UPGRADE-NOTES.md.";

const REVIEW_STATES = new Set(["ok", "needs_review"]);

/**
 * Builds a template.lock object — exactly four keys, no more, no fewer.
 * `sections_hash` is always recomputed from `projectDoc` here; it is never
 * accepted as a raw pass-through, so a caller cannot accidentally persist a
 * stale hash.
 */
export function buildLock({ templateVersion, profile, projectDoc, reviewState = "ok" }) {
  return {
    template_version: templateVersion,
    profile,
    sections_hash: sectionsHash(projectDoc),
    review_state: reviewState,
  };
}

/**
 * Reads and validates `template.lock` from `atlasDir`. Returns `null` if
 * the file does not exist — a project that has never been initialised is
 * not an error. Hard-throws on anything else unexpected: malformed JSON, a
 * missing required field, or a `review_state` outside its enum. A missing
 * `review_state` defaults to "ok" for forward compatibility with a lock
 * written before this key existed; a present-but-invalid one still throws,
 * since silently coercing it could mask a real needs_review signal.
 */
export function readLock(atlasDir, deps = {}) {
  const { readFileSyncFn = readFileSync } = deps;
  const path = join(atlasDir, LOCK_FILENAME);

  let raw;
  try {
    raw = readFileSyncFn(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `readLock: "${path}" is not valid JSON-subset YAML. Parse error: ${err.message}`
    );
  }

  for (const field of ["template_version", "profile", "sections_hash"]) {
    if (typeof doc[field] !== "string" || doc[field].length === 0) {
      throw new Error(`readLock: "${path}" is missing a non-empty "${field}"`);
    }
  }

  if (doc.review_state === undefined) {
    doc.review_state = "ok";
  } else if (!REVIEW_STATES.has(doc.review_state)) {
    throw new Error(
      `readLock: "${path}" has invalid "review_state" ${JSON.stringify(doc.review_state)} — must be "ok" or "needs_review"`
    );
  }

  return doc;
}

/**
 * Atomically writes `lockObj` to `template.lock` in `atlasDir`: serializes,
 * writes to a same-directory temp file, then renameSync's it into place. A
 * same-directory rename is atomic on one filesystem, which is the entire
 * story for why a crash mid-write cannot leave readLock staring at a torn
 * file. On rename failure the temp file is removed and the error rethrown
 * — the previous lock (if any) is left byte-identical. `deps` allows
 * `{writeFileSyncFn, renameSyncFn, rmSyncFn}` to be injected for the crash
 * test.
 */
export function writeLock(atlasDir, lockObj, deps = {}) {
  const {
    writeFileSyncFn = writeFileSync,
    renameSyncFn = renameSync,
    rmSyncFn = rmSync,
  } = deps;

  const path = join(atlasDir, LOCK_FILENAME);
  const serialized = JSON.stringify(lockObj, null, 2) + "\n";
  const tmpPath = `${path}.tmp-${randomBytes(6).toString("hex")}`;

  writeFileSyncFn(tmpPath, serialized, "utf8");
  try {
    renameSyncFn(tmpPath, path);
  } catch (err) {
    rmSyncFn(tmpPath, { force: true });
    throw err;
  }
}

/**
 * Renders the UPGRADE-NOTES.md body for a conflicting upgrade, following
 * a fixed template. When a conflicting section has no
 * `breaking_changes` entry in `currentTemplate` (an under-documented
 * template version), the description is replaced with a literal warning
 * sentence so the omission is visible in the rendered file rather than
 * silently producing an empty, useless notice.
 */
export function renderUpgradeNotes({
  slug,
  fromVersion,
  toVersion,
  detectedAt,
  conflicts,
  currentTemplate,
  projectDoc,
}) {
  const lines = [];
  lines.push(`# Upgrade Notes — ${slug}`, "");
  lines.push("**Status:** needs_review");
  lines.push(`**Template:** v${fromVersion} → v${toVersion}`);
  lines.push(`**Detected:** ${detectedAt}`, "");
  lines.push("## What changed");

  for (const section of conflicts) {
    const breaking = currentTemplate.breaking_changes && currentTemplate.breaking_changes[section];
    const description =
      breaking && typeof breaking.description === "string" && breaking.description.length > 0
        ? breaking.description
        : `(no breaking_changes entry was shipped for this section in template v${toVersion} — the template author must add one)`;
    const currentValue = JSON.stringify(projectDoc[section], null, 2);

    lines.push(`- **${section}** — ${description}`);
    lines.push("  Your current content:");
    lines.push("  ```yaml");
    lines.push(`  ${section}: ${currentValue}`);
    lines.push("  ```");
  }

  lines.push("", "## What to do");
  lines.push("1. Review each section above against the new template's meaning.");
  lines.push(
    "2. Update `.atlas/project.yml` by hand, or explicitly keep your version if it still applies."
  );
  lines.push(`3. Re-run \`atlas init ${slug}\` to accept and clear this notice.`, "");
  lines.push("This file is not read by the collector or the dashboard — delete it once resolved.");

  return lines.join("\n") + "\n";
}

/**
 * The zero-dependency three-way merge. Pure — performs no I/O, computes and
 * returns a plan the caller applies. That is what lets `atlas init`'s
 * `--dry-run` print the exact same result the real run would apply.
 *
 * Algorithm (in order):
 *  1. If the template version hasn't moved, short-circuit to a no-op —
 *     either fully unchanged (sections_hash also matches) or a hash refresh
 *     (a project added/removed a section without a version move).
 *  2. Compute `theirsAdded` (new optional sections) and `theirsBreaking`
 *     (sections removed from required, moved category between
 *     required/optional_canonical in either direction, or removed from
 *     optional_canonical entirely) from the two template objects only —
 *     never from the lock.
 *  3. Recompute the project's own declared sections LIVE from `projectDoc`
 *     — the stored `sections_hash` is never consulted for conflict
 *     detection, so a hand-edited lock cannot suppress a real conflict.
 *  4. Any live conflict, unless explicitly accepted, wins: outcome
 *     "conflict", needs_review, UPGRADE-NOTES.md written, version NOT
 *     advanced.
 *  5. A breaking change with no conflict still needs_review — a human must
 *     explicitly accept the bump via `acceptMajor` (`atlas init
 *     --accept-major`). Silently advancing would clear needs_review on the
 *     next run and lose the very signal this lock exists to preserve.
 *  6. `acceptMajor` explicitly clears a pending major/conflict, advancing
 *     the version and resetting review_state to "ok".
 *  7. Otherwise: only additions, nothing breaking — auto-apply, the
 *     only outcome that produces no dashboard state change.
 */
export function mergeTemplate({
  lock,
  projectDoc,
  baseTemplate,
  currentTemplate,
  slug,
  detectedAt,
  acceptMajor = false,
}) {
  // Step 1 — template version unchanged since the lock was last written.
  if (currentTemplate.version === lock.template_version) {
    const liveHash = sectionsHash(projectDoc);
    if (lock.sections_hash === liveHash) {
      return {
        outcome: "noop",
        reason: "version and sections_hash both unchanged",
        conflicts: [],
        banner: null,
        lock,
        writes: [],
      };
    }
    const refreshedLock = buildLock({
      templateVersion: lock.template_version,
      profile: lock.profile,
      projectDoc,
      reviewState: lock.review_state,
    });
    return {
      outcome: "noop",
      reason: "template version unchanged",
      conflicts: [],
      banner: null,
      lock: refreshedLock,
      writes: [{ filename: LOCK_FILENAME, content: refreshedLock }],
    };
  }

  // Step 2 — compute additions/breaking changes from the two template
  // objects only. Never from the lock.
  const baseRequired = new Set(baseTemplate.sections.required);
  const currentRequired = new Set(currentTemplate.sections.required);
  const baseOptional = new Set(baseTemplate.sections.optional_canonical);
  const currentOptional = new Set(currentTemplate.sections.optional_canonical);

  const theirsAdded = [...currentOptional].filter((s) => !baseOptional.has(s));

  const breaking = new Set();
  for (const s of baseRequired) {
    if (!currentRequired.has(s)) breaking.add(s); // removed from required (moved to optional, or dropped)
  }
  for (const s of baseOptional) {
    if (currentRequired.has(s)) breaking.add(s); // moved from optional_canonical to required
  }
  for (const s of baseOptional) {
    if (!currentOptional.has(s) && !currentRequired.has(s)) breaking.add(s); // removed entirely
  }
  const theirsBreaking = [...breaking];

  // Step 3 — live conflict detection. sectionKeysIn(projectDoc) is
  // recomputed from the project's actual current document, not from any
  // stored fingerprint, so a stale or tampered lock.sections_hash cannot
  // suppress a real conflict (this is the signal the lock exists to preserve).
  const mineSections = sectionKeysIn(projectDoc);
  const conflicts = mineSections.filter((s) => theirsBreaking.includes(s)).sort();

  // Step 4 — CONFLICT.
  if (conflicts.length > 0 && !acceptMajor) {
    const newLock = buildLock({
      templateVersion: lock.template_version,
      profile: lock.profile,
      projectDoc,
      reviewState: "needs_review",
    });
    const notes = renderUpgradeNotes({
      slug,
      fromVersion: lock.template_version,
      toVersion: currentTemplate.version,
      detectedAt,
      conflicts,
      currentTemplate,
      projectDoc,
    });
    return {
      outcome: "conflict",
      reason: "one or more customised sections conflict with a breaking template change",
      conflicts,
      banner: BANNER_CONFLICT,
      lock: newLock,
      writes: [
        { filename: LOCK_FILENAME, content: newLock },
        { filename: UPGRADE_NOTES_FILENAME, content: notes },
      ],
    };
  }

  // Step 5 — MAJOR, no conflict.
  if (theirsBreaking.length > 0 && !acceptMajor) {
    const newLock = buildLock({
      templateVersion: lock.template_version,
      profile: lock.profile,
      projectDoc,
      reviewState: "needs_review",
    });
    return {
      outcome: "major",
      reason: "template has a breaking change the project has not customised; a human must explicitly accept the bump",
      conflicts: [],
      banner: BANNER_MAJOR.replaceAll("{new}", currentTemplate.version).replaceAll(
        "{old}",
        lock.template_version
      ),
      lock: newLock,
      writes: [{ filename: LOCK_FILENAME, content: newLock }],
    };
  }

  // Step 6 — explicit --accept-major clears a pending major/conflict.
  if (acceptMajor) {
    const newLock = buildLock({
      templateVersion: currentTemplate.version,
      profile: lock.profile,
      projectDoc,
      reviewState: "ok",
    });
    return {
      outcome: "accepted",
      reason: "major bump explicitly accepted via --accept-major",
      conflicts: [],
      banner: null,
      lock: newLock,
      writes: [{ filename: LOCK_FILENAME, content: newLock }],
    };
  }

  // Step 7 — MINOR: only additions, nothing breaking. The only
  // auto-applying branch — no dashboard state change, recorded in the
  // collector run log by the caller.
  const newLock = buildLock({
    templateVersion: currentTemplate.version,
    profile: lock.profile,
    projectDoc,
    reviewState: "ok",
  });
  return {
    outcome: "minor",
    reason:
      theirsAdded.length > 0
        ? "optional sections added, nothing breaking"
        : "template version advanced, no section changes",
    conflicts: [],
    banner: null,
    lock: newLock,
    writes: [{ filename: LOCK_FILENAME, content: newLock }],
  };
}
