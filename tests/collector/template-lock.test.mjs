// tests/collector/template-lock.test.mjs
// Covers collector/lib/lock.mjs — template.lock atomic read/write plus the
// zero-dependency three-way merge (mergeTemplate) that makes template
// upgrades trustworthy: a minor bump auto-applies, a conflicting
// upgrade surfaces as needs_review rather than being silently dropped
//. Only templates/v1.json ships this phase, so every real `atlas
// init` run hits the NO-OP branch in production — the MINOR/MAJOR/CONFLICT
// branches are exercised here against synthetic v2 fixtures under
// tests/collector/fixtures/.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readLock,
  writeLock,
  buildLock,
  mergeTemplate,
  renderUpgradeNotes,
  LOCK_FILENAME,
  UPGRADE_NOTES_FILENAME,
} from "../../collector/lib/lock.mjs";
import { sectionsHash, loadTemplateDef } from "../../collector/lib/project-template.mjs";

const V1 = loadTemplateDef("1.0.0");

const V2_MINOR = JSON.parse(
  readFileSync(new URL("./fixtures/template-v2-minor.json", import.meta.url), "utf8")
);
const V2_MAJOR = JSON.parse(
  readFileSync(new URL("./fixtures/template-v2-major.json", import.meta.url), "utf8")
);

const DETECTED_AT = "2026-08-10T00:00:00.000Z";
const SLUG = "test-project";

// Fixture project doc used across tests: identity, profile, next_action,
// plus health and blockers — i.e. the project HAS customised "health".
const PROJECT_DOC_WITH_HEALTH = {
  identity: { name: "Test Project", statement: "A test project for the merge suite." },
  profile: "code-project",
  next_action: "Write the next test",
  health: "green — on track",
  blockers: ["none currently"],
};

// The same project, but without "health" declared — used for the MAJOR
// no-conflict case, where the project has not customised the
// section that moved category.
const PROJECT_DOC_WITHOUT_HEALTH = {
  identity: { name: "Test Project", statement: "A test project for the merge suite." },
  profile: "code-project",
  next_action: "Write the next test",
  blockers: ["none currently"],
};

function lockAtV1(projectDoc) {
  return buildLock({ templateVersion: "1.0.0", profile: "code-project", projectDoc });
}

describe("mergeTemplate — five outcomes", () => {
  test("NO-OP — same template version and unchanged sections_hash", () => {
    const lock = lockAtV1(PROJECT_DOC_WITH_HEALTH);
    const result = mergeTemplate({
      lock,
      projectDoc: PROJECT_DOC_WITH_HEALTH,
      baseTemplate: V1,
      currentTemplate: V1,
      slug: SLUG,
      detectedAt: DETECTED_AT,
    });
    assert.equal(result.outcome, "noop");
    assert.deepEqual(result.writes, []);
    assert.equal(lock.template_version, "1.0.0");
    assert.equal(lock.sections_hash, sectionsHash(PROJECT_DOC_WITH_HEALTH));
  });

  test("MINOR — a minor bump propagates with zero per-project work", () => {
    const lock = lockAtV1(PROJECT_DOC_WITH_HEALTH);
    const result = mergeTemplate({
      lock,
      projectDoc: PROJECT_DOC_WITH_HEALTH,
      baseTemplate: V1,
      currentTemplate: V2_MINOR,
      slug: SLUG,
      detectedAt: DETECTED_AT,
    });
    assert.equal(result.outcome, "minor");
    assert.equal(result.lock.template_version, "2.0.0");
    assert.equal(result.lock.sections_hash, sectionsHash(PROJECT_DOC_WITH_HEALTH));
    assert.equal(result.lock.review_state, "ok");
    assert.equal(result.writes.length, 1);
    assert.equal(result.writes[0].filename, LOCK_FILENAME);
    assert.ok(
      !result.writes.some((w) => w.filename === UPGRADE_NOTES_FILENAME),
      "MINOR must not write UPGRADE-NOTES.md — no per-project work is implied"
    );
  });

  test("MAJOR, no conflict — project has not customised the moved section", () => {
    const lock = lockAtV1(PROJECT_DOC_WITHOUT_HEALTH);
    const result = mergeTemplate({
      lock,
      projectDoc: PROJECT_DOC_WITHOUT_HEALTH,
      baseTemplate: V1,
      currentTemplate: V2_MAJOR,
      slug: SLUG,
      detectedAt: DETECTED_AT,
    });
    assert.equal(result.outcome, "major");
    assert.equal(result.lock.review_state, "needs_review");
    assert.equal(result.lock.template_version, "1.0.0");
    assert.equal(
      result.banner,
      "This project's template needs review — updated to v2.0.0, this project is on v1.0.0. See UPGRADE-NOTES.md."
    );
  });

  test("CONFLICT — project has customised the section that broke", () => {
    const lock = lockAtV1(PROJECT_DOC_WITH_HEALTH);
    const result = mergeTemplate({
      lock,
      projectDoc: PROJECT_DOC_WITH_HEALTH,
      baseTemplate: V1,
      currentTemplate: V2_MAJOR,
      slug: SLUG,
      detectedAt: DETECTED_AT,
    });
    assert.equal(result.outcome, "conflict");
    assert.deepEqual(result.conflicts, ["health"]);
    assert.equal(result.lock.review_state, "needs_review");
    assert.equal(result.lock.template_version, "1.0.0");

    assert.equal(result.writes.length, 2);
    assert.ok(result.writes.some((w) => w.filename === LOCK_FILENAME));
    const notesWrite = result.writes.find((w) => w.filename === UPGRADE_NOTES_FILENAME);
    assert.ok(notesWrite, "expected an UPGRADE-NOTES.md write entry");
    assert.match(notesWrite.content, /needs_review/);
    assert.ok(notesWrite.content.includes("v1.0.0 → v2.0.0"));
    assert.ok(notesWrite.content.includes("health"));
    assert.ok(notesWrite.content.includes(V2_MAJOR.breaking_changes.health.description));
    assert.ok(notesWrite.content.includes(PROJECT_DOC_WITH_HEALTH.health));

    assert.equal(
      result.banner,
      "This project's template needs review — an automatic merge found a conflict during the last update. See UPGRADE-NOTES.md."
    );
  });

  test("--accept-major clears the conflict", () => {
    const lock = lockAtV1(PROJECT_DOC_WITH_HEALTH);
    const result = mergeTemplate({
      lock,
      projectDoc: PROJECT_DOC_WITH_HEALTH,
      baseTemplate: V1,
      currentTemplate: V2_MAJOR,
      slug: SLUG,
      detectedAt: DETECTED_AT,
      acceptMajor: true,
    });
    assert.equal(result.lock.template_version, "2.0.0");
    assert.equal(result.lock.review_state, "ok");
  });

  test("conflict detection is live from projectDoc, never from the stored sections_hash", () => {
    const lock = lockAtV1(PROJECT_DOC_WITH_HEALTH);
    lock.sections_hash = "sha256:deliberately-stale-or-wrong";
    const result = mergeTemplate({
      lock,
      projectDoc: PROJECT_DOC_WITH_HEALTH,
      baseTemplate: V1,
      currentTemplate: V2_MAJOR,
      slug: SLUG,
      detectedAt: DETECTED_AT,
    });
    assert.equal(result.outcome, "conflict");
    assert.deepEqual(result.conflicts, ["health"]);
  });

  test("idempotency short-circuit — unchanged sections_hash and version is a no-op naming the hash match", () => {
    const lock = lockAtV1(PROJECT_DOC_WITH_HEALTH);
    const result = mergeTemplate({
      lock,
      projectDoc: PROJECT_DOC_WITH_HEALTH,
      baseTemplate: V1,
      currentTemplate: V1,
      slug: SLUG,
      detectedAt: DETECTED_AT,
    });
    assert.equal(result.outcome, "noop");
    assert.match(result.reason, /sections_hash/);
  });

  test("empty breaking_changes is loud, not silent — under-documented template version is visible", () => {
    const currentTemplateNoDocs = { ...V2_MAJOR, breaking_changes: {} };
    const notes = renderUpgradeNotes({
      slug: SLUG,
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      detectedAt: DETECTED_AT,
      conflicts: ["health"],
      currentTemplate: currentTemplateNoDocs,
      projectDoc: PROJECT_DOC_WITH_HEALTH,
    });
    assert.match(notes, /no breaking_changes entry/);
  });
});

describe("template.lock I/O", () => {
  const dirs = [];
  function freshDir() {
    const dir = mkdtempSync(join(tmpdir(), "atlas-lock-"));
    dirs.push(dir);
    return dir;
  }
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("writeLock then readLock round-trips all four keys", () => {
    const dir = freshDir();
    const lockObj = buildLock({
      templateVersion: "1.0.0",
      profile: "code-project",
      projectDoc: PROJECT_DOC_WITH_HEALTH,
    });
    writeLock(dir, lockObj);
    const readBack = readLock(dir);
    assert.deepEqual(readBack, lockObj);
  });

  test("readLock on a missing file returns null", () => {
    const dir = freshDir();
    assert.equal(readLock(dir), null);
  });

  test("readLock on a malformed file throws matching /template\\.lock/", () => {
    const dir = freshDir();
    writeFileSync(join(dir, LOCK_FILENAME), "{ not json", "utf8");
    assert.throws(() => readLock(dir), /template\.lock/);
  });

  test("writeLock with an injected throwing renameSyncFn leaves the previous lock byte-identical and removes the temp file", () => {
    const dir = freshDir();
    const original = buildLock({
      templateVersion: "1.0.0",
      profile: "code-project",
      projectDoc: PROJECT_DOC_WITH_HEALTH,
    });
    writeLock(dir, original);
    const before = readFileSync(join(dir, LOCK_FILENAME), "utf8");

    assert.throws(() =>
      writeLock(
        dir,
        buildLock({ templateVersion: "2.0.0", profile: "code-project", projectDoc: PROJECT_DOC_WITH_HEALTH }),
        {
          renameSyncFn: () => {
            throw new Error("simulated rename failure");
          },
        }
      )
    );

    const after = readFileSync(join(dir, LOCK_FILENAME), "utf8");
    assert.equal(after, before);

    const leftovers = readdirSync(dir).filter((f) => /\.tmp-/.test(f));
    assert.deepEqual(leftovers, []);
  });

  test("buildLock returns exactly four keys: template_version, profile, sections_hash, review_state", () => {
    const lockObj = buildLock({
      templateVersion: "1.0.0",
      profile: "code-project",
      projectDoc: PROJECT_DOC_WITH_HEALTH,
    });
    assert.deepEqual(
      Object.keys(lockObj).sort(),
      ["profile", "review_state", "sections_hash", "template_version"]
    );
  });
});
