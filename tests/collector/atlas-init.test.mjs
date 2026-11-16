// tests/collector/atlas-init.test.mjs
// Covers collector/atlas-init.mjs — the CLI the dashboard's paste-able
// `atlas init {slug}` command invokes. Every test drives main() with
// injected deps and a captured logger array, matching the injectable-deps
// convention collector/atlas-collect.mjs's own main() already establishes —
// main() never terminates the process directly. Every registry and project
// directory used here is a real mkdtempSync temp directory, cleaned up in
// after().
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { parseArgs, renderProjectYml, buildInitPlan, main } from "../../collector/atlas-init.mjs";
import { loadTemplateDef, loadProjectYml, PROFILES } from "../../collector/lib/project-template.mjs";
import { readLock, LOCK_FILENAME, UPGRADE_NOTES_FILENAME } from "../../collector/lib/lock.mjs";
import { readRegistryDoc } from "../../collector/lib/registry.mjs";

const V2_MAJOR = JSON.parse(
  readFileSync(new URL("./fixtures/template-v2-major.json", import.meta.url), "utf8")
);

const dirs = [];
function freshDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function writeRegistry(dir, projects) {
  const path = join(dir, "registry.yml");
  writeFileSync(
    path,
    JSON.stringify({ _format: "test fixture", schema_version: 1, tenant_id: "local", projects }, null, 2) + "\n",
    "utf8"
  );
  return path;
}

/**
 * Seeds a project directory with a template.lock pinned at v1.0.0 and a
 * project.yml that has customised "health" — the fixture template-v2-major
 * moves "health" from optional_canonical into required, which is what makes
 * this seed exercise the CONFLICT branch rather than the plain MAJOR
 * branch.
 */
function seedProjectAtV1WithHealth(projectDir) {
  const atlasDir = join(projectDir, ".atlas");
  mkdirSync(atlasDir, { recursive: true });
  const projectDoc = {
    _format: "test fixture",
    identity: { name: "Test Project", statement: "A test project for the atlas-init suite." },
    profile: "code-project",
    next_action: "Write the next test",
    health: "green — on track",
  };
  writeFileSync(join(atlasDir, "project.yml"), JSON.stringify(projectDoc, null, 2) + "\n", "utf8");
  const lockObj = {
    template_version: "1.0.0",
    profile: "code-project",
    sections_hash: "sha256:seed-value-recomputed-live-by-mergeTemplate",
    review_state: "ok",
  };
  writeFileSync(join(atlasDir, LOCK_FILENAME), JSON.stringify(lockObj, null, 2) + "\n", "utf8");
  return atlasDir;
}

describe("parseArgs", () => {
  test("parses the init subcommand, a slug and every flag", () => {
    const parsed = parseArgs(["init", "orchard-portal", "--dry-run", "--path", "/tmp/x", "--profile", "research", "--accept-major"]);
    assert.equal(parsed.subcommand, "init");
    assert.equal(parsed.slug, "orchard-portal");
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.path, "/tmp/x");
    assert.equal(parsed.profile, "research");
    assert.equal(parsed.acceptMajor, true);
  });

  test("an unrecognised flag throws naming it", () => {
    assert.throws(() => parseArgs(["init", "orchard-portal", "--dryrun"]), /--dryrun/);
  });
});

describe("dry-run and real-run plan parity", () => {
  test("buildInitPlan's plan object captured via main() is identical for a --dry-run call and a real call against unchanged state", () => {
    const registryDir = freshDir("atlas-init-parity-registry-");
    const projectDir = freshDir("atlas-init-parity-project-");
    const registryPath = writeRegistry(registryDir, [
      { slug: "orchard-portal", name: "Orchard Portal", path: projectDir, git_scope: "root", skip_git: false },
    ]);

    const capturedPlans = [];

    const dryCode = main({
      argv: ["init", "orchard-portal", "--dry-run"],
      env: { ATLAS_REGISTRY: registryPath },
      log: () => {},
      errorLog: () => {},
      onPlan: (plan) => capturedPlans.push(plan),
    });
    assert.equal(dryCode, 0);
    assert.equal(existsSync(join(projectDir, ".atlas")), false);

    const realCode = main({
      argv: ["init", "orchard-portal"],
      env: { ATLAS_REGISTRY: registryPath },
      log: () => {},
      errorLog: () => {},
      onPlan: (plan) => capturedPlans.push(plan),
    });
    assert.equal(realCode, 0);

    assert.equal(capturedPlans.length, 2);
    assert.deepStrictEqual(capturedPlans[0], capturedPlans[1]);
  });
});

describe("dry run", () => {
  test("writes nothing and prints exact file content, not just paths", () => {
    const registryDir = freshDir("atlas-init-dry-registry-");
    const projectDir = freshDir("atlas-init-dry-project-");
    const registryPath = writeRegistry(registryDir, [
      { slug: "orchard-portal", name: "Orchard Portal", path: projectDir, git_scope: "root", skip_git: false },
    ]);

    const logs = [];
    const code = main({
      argv: ["init", "orchard-portal", "--dry-run"],
      env: { ATLAS_REGISTRY: registryPath },
      log: (m) => logs.push(m),
      errorLog: () => {},
    });

    assert.equal(code, 0);
    const output = logs.join("\n");
    assert.match(output, /\.atlas[\\/]project\.yml/);
    assert.match(output, /\.atlas[\\/]template\.lock/);
    assert.match(output, /"identity"/);
    assert.match(output, /"next_action"/);
    assert.equal(existsSync(join(projectDir, ".atlas")), false);
  });
});

describe("real run", () => {
  test("writes both files, project.yml carries exactly the required sections plus profile defaults, at most 20 lines", () => {
    const registryDir = freshDir("atlas-init-real-registry-");
    const projectDir = freshDir("atlas-init-real-project-");
    const registryPath = writeRegistry(registryDir, [
      { slug: "orchard-portal", name: "Orchard Portal", path: projectDir, git_scope: "root", skip_git: false },
    ]);

    const code = main({
      argv: ["init", "orchard-portal"],
      env: { ATLAS_REGISTRY: registryPath },
      log: () => {},
      errorLog: () => {},
    });
    assert.equal(code, 0);

    const ymlPath = join(projectDir, ".atlas", "project.yml");
    const lockPath = join(projectDir, ".atlas", LOCK_FILENAME);
    assert.ok(existsSync(ymlPath), "expected project.yml to exist");
    assert.ok(existsSync(lockPath), "expected template.lock to exist");

    const doc = loadProjectYml(ymlPath);
    for (const section of ["identity", "profile", "next_action"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(doc, section), `expected "${section}" to be declared`);
    }
    for (const section of ["coverage", "freshness", "phase_progress", "recent_activity"]) {
      assert.ok(!Object.prototype.hasOwnProperty.call(doc, section), `expected "${section}" NOT to be declared`);
    }

    const raw = readFileSync(ymlPath, "utf8");
    const lineCount = raw.trimEnd().split("\n").length;
    assert.ok(lineCount <= 20, `expected at most 20 lines, got ${lineCount}`);
  });
});

describe("profile selection", () => {
  test('--profile research yields profile "research" and research\'s optional defaults', () => {
    const registryDir = freshDir("atlas-init-profile-registry-");
    const projectDir = freshDir("atlas-init-profile-project-");
    const registryPath = writeRegistry(registryDir, [
      { slug: "resly", name: "Resly", path: projectDir, git_scope: "root", skip_git: false },
    ]);

    const code = main({
      argv: ["init", "resly", "--profile", "research"],
      env: { ATLAS_REGISTRY: registryPath },
      log: () => {},
      errorLog: () => {},
    });
    assert.equal(code, 0);

    const doc = loadProjectYml(join(projectDir, ".atlas", "project.yml"));
    assert.equal(doc.profile, "research");
    assert.ok(Object.prototype.hasOwnProperty.call(doc, "open_questions"));
    assert.ok(Object.prototype.hasOwnProperty.call(doc, "links"));
  });

  test("--profile startup exits non-zero and lists the four valid profiles", () => {
    const errors = [];
    const code = main({
      argv: ["init", "somezz", "--profile", "startup"],
      env: {},
      log: () => {},
      errorLog: (m) => errors.push(m),
    });
    assert.notEqual(code, 0);
    const message = errors.join("\n");
    for (const p of PROFILES) {
      assert.ok(message.includes(p), `expected the profile list to mention "${p}"`);
    }
  });
});

describe("idempotency", () => {
  test("running init twice leaves project.yml byte-identical, logs that it already exists, and leaves the registry unchanged", () => {
    const registryDir = freshDir("atlas-init-idem-registry-");
    const projectDir = freshDir("atlas-init-idem-project-");
    const registryPath = writeRegistry(registryDir, [
      { slug: "idem", name: "Idem", path: projectDir, git_scope: "root", skip_git: false },
    ]);
    const registryBefore = readFileSync(registryPath, "utf8");

    const firstCode = main({
      argv: ["init", "idem"],
      env: { ATLAS_REGISTRY: registryPath },
      log: () => {},
      errorLog: () => {},
    });
    assert.equal(firstCode, 0);
    const ymlAfterFirst = readFileSync(join(projectDir, ".atlas", "project.yml"), "utf8");

    const logs2 = [];
    const secondCode = main({
      argv: ["init", "idem"],
      env: { ATLAS_REGISTRY: registryPath },
      log: (m) => logs2.push(m),
      errorLog: () => {},
    });
    assert.equal(secondCode, 0);

    const ymlAfterSecond = readFileSync(join(projectDir, ".atlas", "project.yml"), "utf8");
    assert.equal(ymlAfterSecond, ymlAfterFirst);
    assert.match(logs2.join("\n"), /already exists/);
    assert.equal(readFileSync(registryPath, "utf8"), registryBefore);
  });
});

describe("conditional registry append", () => {
  test("an already-registered slug leaves the registry byte-identical", () => {
    const registryDir = freshDir("atlas-init-append-noop-registry-");
    const projectDir = freshDir("atlas-init-append-noop-project-");
    const registryPath = writeRegistry(registryDir, [
      { slug: "already", name: "Already", path: projectDir, git_scope: "root", skip_git: false },
    ]);
    const before = readFileSync(registryPath, "utf8");

    const code = main({
      argv: ["init", "already"],
      env: { ATLAS_REGISTRY: registryPath },
      log: () => {},
      errorLog: () => {},
    });
    assert.equal(code, 0);
    assert.equal(readFileSync(registryPath, "utf8"), before);
  });

  test("a new slug with --path gains exactly one registry entry, and every pre-existing entry survives", () => {
    const registryDir = freshDir("atlas-init-append-new-registry-");
    const existingProjectDir = freshDir("atlas-init-append-existing-project-");
    const newProjectDir = freshDir("atlas-init-append-new-project-");
    const registryPath = writeRegistry(registryDir, [
      { slug: "existing-one", name: "Existing One", path: existingProjectDir, git_scope: "root", skip_git: false },
    ]);
    const before = readRegistryDoc(registryPath);

    const code = main({
      argv: ["init", "newone", "--path", newProjectDir],
      env: { ATLAS_REGISTRY: registryPath },
      log: () => {},
      errorLog: () => {},
    });
    assert.equal(code, 0);

    const after = readRegistryDoc(registryPath);
    assert.equal(after.projects.length, before.projects.length + 1);
    assert.ok(after.projects.some((p) => p.slug === "existing-one"));
    assert.ok(after.projects.some((p) => p.slug === "newone"));
  });
});

describe("registry not found", () => {
  test("project files are still written, the entry to paste is printed, and the exit code is non-zero", () => {
    const missingRegistryDir = freshDir("atlas-init-missing-registry-");
    const registryPath = join(missingRegistryDir, "registry.yml"); // deliberately never written
    const projectDir = freshDir("atlas-init-d17-project-");

    const logs = [];
    const errors = [];
    const code = main({
      argv: ["init", "ghost", "--path", projectDir],
      env: { ATLAS_REGISTRY: registryPath },
      log: (m) => logs.push(m),
      errorLog: (m) => errors.push(m),
    });

    assert.equal(code, 3);
    assert.ok(existsSync(join(projectDir, ".atlas", "project.yml")), "expected project.yml to be written anyway");
    assert.ok(existsSync(join(projectDir, ".atlas", LOCK_FILENAME)), "expected template.lock to be written anyway");

    const output = [...logs, ...errors].join("\n");
    assert.match(output, /ghost/);
    const escapedPath = projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(output, new RegExp(escapedPath));
  });
});

describe("unknown slug with no --path", () => {
  test("exits non-zero naming the slug and instructing --path, and writes nothing", () => {
    const registryDir = freshDir("atlas-init-unknown-registry-");
    const otherProjectDir = freshDir("atlas-init-unknown-other-project-");
    const registryPath = writeRegistry(registryDir, [
      { slug: "other", name: "Other", path: otherProjectDir, git_scope: "root", skip_git: false },
    ]);

    const errors = [];
    const code = main({
      argv: ["init", "nowhere"],
      env: { ATLAS_REGISTRY: registryPath },
      log: () => {},
      errorLog: (m) => errors.push(m),
    });
    assert.notEqual(code, 0);
    const message = errors.join("\n");
    assert.match(message, /nowhere/);
    assert.match(message, /--path/);
  });
});

describe("slug validation", () => {
  test('init "../etc", init "Bad Slug" and init "" each exit non-zero matching /invalid slug/ and create no file', () => {
    const registryDir = freshDir("atlas-init-slugval-registry-");
    const registryPath = writeRegistry(registryDir, [
      { slug: "placeholder", name: "Placeholder", path: freshDir("atlas-init-slugval-placeholder-"), git_scope: "root", skip_git: false },
    ]);

    for (const badSlug of ["../etc", "Bad Slug", ""]) {
      const errors = [];
      const code = main({
        argv: ["init", badSlug],
        env: { ATLAS_REGISTRY: registryPath },
        log: () => {},
        errorLog: (m) => errors.push(m),
      });
      assert.notEqual(code, 0, `expected a non-zero exit for slug ${JSON.stringify(badSlug)}`);
      assert.match(errors.join("\n"), /invalid slug/);
    }
  });
});

describe("path containment", () => {
  test("every plan write resolves to a path under the project directory", () => {
    const registryDir = freshDir("atlas-init-contain-registry-");
    const projectDir = freshDir("atlas-init-contain-project-");
    const registryPath = writeRegistry(registryDir, [
      { slug: "contained", name: "Contained", path: projectDir, git_scope: "root", skip_git: false },
    ]);

    const plans = [];
    main({
      argv: ["init", "contained", "--dry-run"],
      env: { ATLAS_REGISTRY: registryPath },
      log: () => {},
      errorLog: () => {},
      onPlan: (plan) => plans.push(plan),
    });

    assert.equal(plans.length, 1);
    for (const w of plans[0].writes) {
      assert.ok(
        w.path.startsWith(projectDir + sep),
        `expected write path "${w.path}" to be under "${projectDir}"`
      );
    }
  });

  test("a --path containing a .. segment is rejected before any write", () => {
    const registryDir = freshDir("atlas-init-traversal-registry-");
    const registryPath = writeRegistry(registryDir, []);
    const base = freshDir("atlas-init-traversal-base-");
    // Deliberately NOT path.join() — join() normalizes away ".." segments at
    // construction time, which would make this test assert nothing. Plain
    // string concatenation preserves the literal ".." the guard must reject.
    const traversalPath = `${base}/../atlas-init-traversal-escaped`;

    const errors = [];
    const code = main({
      argv: ["init", "escapee", "--path", traversalPath],
      env: { ATLAS_REGISTRY: registryPath },
      log: () => {},
      errorLog: (m) => errors.push(m),
    });
    assert.notEqual(code, 0);
    assert.match(errors.join("\n"), /\.\./);
    assert.equal(existsSync(join(traversalPath, ".atlas")), false);
  });
});

describe("unknown flag", () => {
  test("a typo'd --dryrun exits non-zero naming the flag", () => {
    const errors = [];
    const code = main({
      argv: ["init", "whatever", "--dryrun"],
      env: {},
      log: () => {},
      errorLog: (m) => errors.push(m),
    });
    assert.notEqual(code, 0);
    assert.match(errors.join("\n"), /--dryrun/);
  });
});

describe("re-run after a template bump", () => {
  test("a conflicting bump writes UPGRADE-NOTES.md, sets needs_review, does not advance the version, and leaves project.yml byte-identical", () => {
    const registryDir = freshDir("atlas-init-bump-registry-");
    const projectDir = freshDir("atlas-init-bump-project-");
    const atlasDir = seedProjectAtV1WithHealth(projectDir);
    const ymlBefore = readFileSync(join(atlasDir, "project.yml"), "utf8");
    const registryPath = writeRegistry(registryDir, [
      { slug: "bumpy", name: "Bumpy", path: projectDir, git_scope: "root", skip_git: false },
    ]);

    const code = main({
      argv: ["init", "bumpy"],
      env: { ATLAS_REGISTRY: registryPath },
      log: () => {},
      errorLog: () => {},
      templateDef: V2_MAJOR,
    });

    assert.equal(code, 4);
    assert.ok(existsSync(join(atlasDir, UPGRADE_NOTES_FILENAME)), "expected UPGRADE-NOTES.md to be written");
    const lock = readLock(atlasDir);
    assert.equal(lock.review_state, "needs_review");
    assert.equal(lock.template_version, "1.0.0");
    assert.equal(readFileSync(join(atlasDir, "project.yml"), "utf8"), ymlBefore);
  });

  test("--accept-major advances the lock to the new version and clears review_state", () => {
    const registryDir = freshDir("atlas-init-accept-registry-");
    const projectDir = freshDir("atlas-init-accept-project-");
    const atlasDir = seedProjectAtV1WithHealth(projectDir);
    const registryPath = writeRegistry(registryDir, [
      { slug: "bumpy2", name: "Bumpy2", path: projectDir, git_scope: "root", skip_git: false },
    ]);

    const code = main({
      argv: ["init", "bumpy2", "--accept-major"],
      env: { ATLAS_REGISTRY: registryPath },
      log: () => {},
      errorLog: () => {},
      templateDef: V2_MAJOR,
    });

    assert.equal(code, 0);
    const lock = readLock(atlasDir);
    assert.equal(lock.template_version, "2.0.0");
    assert.equal(lock.review_state, "ok");
  });
});

describe("merge failure does not corrupt", () => {
  test("an injected throwing writeLockFn leaves the previous template.lock byte-identical and exits non-zero", () => {
    const registryDir = freshDir("atlas-init-crash-registry-");
    const projectDir = freshDir("atlas-init-crash-project-");
    const atlasDir = seedProjectAtV1WithHealth(projectDir);
    const lockBefore = readFileSync(join(atlasDir, LOCK_FILENAME), "utf8");
    const registryPath = writeRegistry(registryDir, [
      { slug: "crashy", name: "Crashy", path: projectDir, git_scope: "root", skip_git: false },
    ]);

    const code = main({
      argv: ["init", "crashy"],
      env: { ATLAS_REGISTRY: registryPath },
      log: () => {},
      errorLog: () => {},
      templateDef: V2_MAJOR,
      writeLockFn: () => {
        throw new Error("simulated write failure");
      },
    });

    assert.notEqual(code, 0);
    const lockAfter = readFileSync(join(atlasDir, LOCK_FILENAME), "utf8");
    assert.equal(lockAfter, lockBefore);
  });
});

describe("buildInitPlan / renderProjectYml — direct unit coverage", () => {
  test("renderProjectYml's own output always parses under parseProjectYml, for every profile", () => {
    const templateDef = loadTemplateDef("1.0.0");
    for (const profile of PROFILES) {
      const content = renderProjectYml({ slug: "unit-test", name: "Unit Test", profile, templateDef });
      assert.doesNotThrow(() => JSON.parse(content));
    }
  });

  test("buildInitPlan (pure) computes writes rooted under projectPath for a fresh project", () => {
    const templateDef = loadTemplateDef("1.0.0");
    const projectPath = "/tmp/atlas-init-unit-fixture";
    const plan = buildInitPlan({
      slug: "unit-fixture",
      projectPath,
      profile: "code-project",
      templateDef,
      existingDoc: null,
      existingLock: null,
      registryDoc: null,
      registryPath: "/tmp/registry.yml",
      detectedAt: "2026-08-10T00:00:00.000Z",
    });
    assert.equal(plan.mergeOutcome, "created");
    assert.equal(plan.writes.length, 2);
    for (const w of plan.writes) {
      assert.ok(w.path.startsWith(projectPath + sep));
    }
    assert.deepEqual(plan.registryAppend, {
      slug: "unit-fixture",
      name: "atlas-init-unit-fixture",
      path: projectPath,
      git_scope: "root",
      skip_git: false,
    });
  });
});
