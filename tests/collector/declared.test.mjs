// tests/collector/declared.test.mjs
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectDeclared,
  hasDeclaredFile,
  MAX_DECLARED_FIELDS,
} from "../../collector/adapters/declared.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "atlas-declared-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** Writes `doc` as .atlas/project.yml (plain JSON — a JSON-subset-YAML doc). */
function writeProjectYml(dir, doc) {
  mkdirSync(join(dir, ".atlas"), { recursive: true });
  writeFileSync(join(dir, ".atlas", "project.yml"), JSON.stringify(doc), "utf8");
}

/** Writes `lockDoc` as .atlas/template.lock. */
function writeLockFile(dir, lockDoc) {
  mkdirSync(join(dir, ".atlas"), { recursive: true });
  writeFileSync(join(dir, ".atlas", "template.lock"), JSON.stringify(lockDoc), "utf8");
}

/** Initialises a git repo at `dir` (created if missing) with git identity configured. */
function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

/** Commits `relPath` inside `dir` at a pinned author/committer date. */
function commitAt(dir, relPath, authorDate, committerDate) {
  execFileSync("git", ["add", relPath], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", `commit ${relPath}`], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: authorDate,
      GIT_COMMITTER_DATE: committerDate,
    },
  });
}

const VALID_DOC = {
  identity: { name: "Demo Project", statement: "A demo project for declared-adapter tests." },
  profile: "code-project",
  next_action: "Wire the declared adapter tests.",
};

describe("hasDeclaredFile / collectDeclared — no .atlas directory", () => {
  test("hasDeclaredFile is false and collectDeclared returns no_declared_file, never throws", () => {
    const dir = join(ROOT, "no-atlas");
    mkdirSync(dir, { recursive: true });

    assert.equal(hasDeclaredFile(dir), false);

    let result;
    assert.doesNotThrow(() => {
      result = collectDeclared(dir);
    });
    assert.deepEqual(result, { fields: [], declared: false, reason: "no_declared_file" });
  });
});

describe("collectDeclared — valid file", () => {
  test("declared is true and every returned field carries confidence declared and source declared", () => {
    const dir = join(ROOT, "valid-file");
    mkdirSync(dir, { recursive: true });
    writeProjectYml(dir, VALID_DOC);

    const result = collectDeclared(dir);

    assert.equal(result.declared, true);
    assert.ok(result.fields.find((f) => f.section === "identity" && f.key === "name"));
    assert.ok(result.fields.find((f) => f.section === "identity" && f.key === "statement"));
    assert.ok(result.fields.find((f) => f.section === "next_action" && f.key === "statement"));
    assert.ok(result.fields.find((f) => f.section === "template" && f.key === "profile"));
    assert.ok(result.fields.find((f) => f.section === "template" && f.key === "declared_at"));

    for (const field of result.fields) {
      assert.equal(field.confidence, "declared", `field ${field.section}/${field.key} confidence`);
      assert.equal(field.source, "declared", `field ${field.section}/${field.key} source`);
    }
  });
});

describe("collectDeclared — optional sections", () => {
  test("health and blockers round-trip as health/value and blockers/value", () => {
    const dir = join(ROOT, "optional-sections");
    mkdirSync(dir, { recursive: true });
    writeProjectYml(dir, {
      ...VALID_DOC,
      health: "green",
      blockers: ["Waiting on vendor API credentials"],
    });

    const result = collectDeclared(dir);

    const health = result.fields.find((f) => f.section === "health" && f.key === "value");
    const blockers = result.fields.find((f) => f.section === "blockers" && f.key === "value");
    assert.equal(health.value, "green");
    assert.deepEqual(blockers.value, ["Waiting on vendor API credentials"]);
  });
});

describe("collectDeclared — bespoke section (end to end)", () => {
  test("a bespoke top-level key yields a <section>/value field with no template fork", () => {
    const dir = join(ROOT, "bespoke-section");
    mkdirSync(dir, { recursive: true });
    writeProjectYml(dir, { ...VALID_DOC, vendor_escalations: ["Acme SLA"] });

    const result = collectDeclared(dir);

    const field = result.fields.find((f) => f.section === "vendor_escalations" && f.key === "value");
    assert.ok(field, "expected a vendor_escalations/value field");
    assert.deepEqual(field.value, ["Acme SLA"]);
  });
});

describe("collectDeclared — malformed file never throws", () => {
  test("a project.yml that is not valid JSON returns a structured parse_error, never throws", () => {
    const dir = join(ROOT, "malformed-file");
    mkdirSync(join(dir, ".atlas"), { recursive: true });
    writeFileSync(join(dir, ".atlas", "project.yml"), "{ not json", "utf8");

    let result;
    assert.doesNotThrow(() => {
      result = collectDeclared(dir);
    });
    assert.equal(result.fields.length, 0);
    assert.equal(result.declared, false);
    assert.equal(result.reason, "parse_error");
    assert.ok(result.error, "expected an error message");
  });
});

describe("collectDeclared — as_of derivation", () => {
  test("as_of comes from the git commit author date of the last commit touching project.yml", () => {
    const dir = initRepo(join(ROOT, "as-of-git"));
    writeProjectYml(dir, VALID_DOC);
    commitAt(dir, ".atlas/project.yml", "2026-03-01T09:00:00-08:00", "2026-03-01T09:00:00-08:00");

    const expected = execFileSync(
      "git",
      ["log", "-1", "--format=%aI", "--", ".atlas/project.yml"],
      { cwd: dir, encoding: "utf8" }
    ).trim();

    const result = collectDeclared(dir);

    const declaredAt = result.fields.find((f) => f.section === "template" && f.key === "declared_at");
    assert.equal(declaredAt.value, expected);
    for (const field of result.fields) {
      assert.equal(field.as_of, expected, `field ${field.section}/${field.key} as_of`);
    }
  });

  test("as_of falls back to the file's mtime outside a git repo", () => {
    const dir = join(ROOT, "as-of-mtime");
    mkdirSync(dir, { recursive: true });
    writeProjectYml(dir, VALID_DOC);

    const expectedMtime = statSync(join(dir, ".atlas", "project.yml")).mtime.toISOString();

    const result = collectDeclared(dir);

    const declaredAt = result.fields.find((f) => f.section === "template" && f.key === "declared_at");
    assert.equal(declaredAt.value, expectedMtime);
    assert.equal(result.as_of_source, "mtime");
  });
});

describe("collectDeclared — review_state from the lock", () => {
  test("a lock with review_state needs_review produces a matching template/review_state field", () => {
    const dir = join(ROOT, "lock-needs-review");
    mkdirSync(dir, { recursive: true });
    writeProjectYml(dir, VALID_DOC);
    writeLockFile(dir, {
      template_version: "1.0.0",
      profile: "code-project",
      sections_hash: "sha256:deadbeef",
      review_state: "needs_review",
    });

    const result = collectDeclared(dir);

    const reviewState = result.fields.find((f) => f.section === "template" && f.key === "review_state");
    assert.equal(reviewState.value, "needs_review");
  });

  test("no lock present defaults review_state to ok and omits (or nulls) template/version", () => {
    const dir = join(ROOT, "lock-absent");
    mkdirSync(dir, { recursive: true });
    writeProjectYml(dir, VALID_DOC);

    const result = collectDeclared(dir);

    const reviewState = result.fields.find((f) => f.section === "template" && f.key === "review_state");
    const version = result.fields.find((f) => f.section === "template" && f.key === "version");
    assert.equal(reviewState.value, "ok");
    assert.ok(version === undefined || version.value === null);
  });
});

describe("collectDeclared — malformed lock degrades, does not abort", () => {
  test("a corrupt template.lock beside a valid project.yml still returns declared true, review_state ok", () => {
    const dir = join(ROOT, "lock-corrupt");
    mkdirSync(join(dir, ".atlas"), { recursive: true });
    writeProjectYml(dir, VALID_DOC);
    writeFileSync(join(dir, ".atlas", "template.lock"), "{ not json", "utf8");

    const result = collectDeclared(dir);

    assert.equal(result.declared, true);
    assert.ok(result.reason, "expected a reason naming the lock failure");
    const reviewState = result.fields.find((f) => f.section === "template" && f.key === "review_state");
    assert.equal(reviewState.value, "ok");
  });
});

describe("collectDeclared — field cap", () => {
  test("more than MAX_DECLARED_FIELDS bespoke sections truncates to exactly MAX_DECLARED_FIELDS with truncated: true", () => {
    const dir = join(ROOT, "field-cap");
    mkdirSync(dir, { recursive: true });
    const doc = { ...VALID_DOC };
    for (let i = 0; i < 30; i++) {
      doc[`extra_section_${i}`] = `value ${i}`;
    }
    writeProjectYml(dir, doc);

    const result = collectDeclared(dir);

    assert.equal(result.fields.length, MAX_DECLARED_FIELDS);
    assert.equal(result.truncated, true);
  });
});

describe("collectDeclared — budget", () => {
  test("collectDeclared with budgetMs: 0 still returns a structured result and never hangs", () => {
    const dir = join(ROOT, "budget-zero");
    mkdirSync(dir, { recursive: true });
    writeProjectYml(dir, VALID_DOC);

    const result = collectDeclared(dir, { budgetMs: 0 });

    assert.equal(result.declared, true);
    assert.ok(Array.isArray(result.fields));
  });
});
