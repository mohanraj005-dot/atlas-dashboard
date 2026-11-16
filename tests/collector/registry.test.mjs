// tests/collector/registry.test.mjs
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { loadRegistry } from "../../collector/lib/registry.mjs";
import { computeTier, computeProvenance } from "../../collector/lib/tier.mjs";

const REGISTRY_PATH = join(
  new URL("../../collector/registry.yml", import.meta.url).pathname
);

describe("loadRegistry — real registry.yml", () => {
  test("loads exactly 11 entries", () => {
    const doc = loadRegistry(REGISTRY_PATH);
    assert.equal(doc.projects.length, 11);
  });

  test("tilde expansion resolves every path against os.homedir()", () => {
    const doc = loadRegistry(REGISTRY_PATH);
    for (const entry of doc.projects) {
      assert.ok(
        !entry.path.startsWith("~"),
        `expected "${entry.path}" to have its leading tilde expanded`
      );
    }
    const orchard = doc.projects.find((p) => p.slug === "orchard");
    assert.equal(orchard.path, `${homedir()}/projects/orchard`);
  });

  test("orchard-portal has git_scope subdir", () => {
    const doc = loadRegistry(REGISTRY_PATH);
    const portal = doc.projects.find((p) => p.slug === "orchard-portal");
    assert.equal(portal.git_scope, "subdir");
  });

  test("field-notes has skip_git true", () => {
    const doc = loadRegistry(REGISTRY_PATH);
    const fieldNotes = doc.projects.find((p) => p.slug === "field-notes");
    assert.equal(fieldNotes.skip_git, true);
  });
});

describe("loadRegistry — validation failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-registry-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("a malformed (non-JSON) file throws with a message naming registry.yml", () => {
    const badPath = join(dir, "registry.yml");
    writeFileSync(badPath, "{ this is not json", "utf8");
    assert.throws(
      () => loadRegistry(badPath),
      (err) => {
        assert.match(err.message, /registry\.yml/);
        return true;
      }
    );
  });

  test("a duplicate slug throws", () => {
    const dupPath = join(dir, "dup-registry.yml");
    writeFileSync(
      dupPath,
      JSON.stringify({
        schema_version: 1,
        tenant_id: "local",
        projects: [
          { slug: "a", name: "A", path: "~/a" },
          { slug: "a", name: "A again", path: "~/a2" },
        ],
      }),
      "utf8"
    );
    assert.throws(() => loadRegistry(dupPath), /duplicate slug/);
  });

  test("an empty projects array throws", () => {
    const emptyPath = join(dir, "empty-registry.yml");
    writeFileSync(
      emptyPath,
      JSON.stringify({ schema_version: 1, tenant_id: "local", projects: [] }),
      "utf8"
    );
    assert.throws(() => loadRegistry(emptyPath), /non-empty/);
  });

  test("a wrong schema_version throws", () => {
    const wrongVersionPath = join(dir, "wrong-version-registry.yml");
    writeFileSync(
      wrongVersionPath,
      JSON.stringify({
        schema_version: 2,
        tenant_id: "local",
        projects: [{ slug: "a", name: "A", path: "~/a" }],
      }),
      "utf8"
    );
    assert.throws(() => loadRegistry(wrongVersionPath), /schema_version/);
  });

  test("a missing slug/name/path throws", () => {
    const missingFieldPath = join(dir, "missing-field-registry.yml");
    writeFileSync(
      missingFieldPath,
      JSON.stringify({
        schema_version: 1,
        tenant_id: "local",
        projects: [{ slug: "a", name: "A" }],
      }),
      "utf8"
    );
    assert.throws(() => loadRegistry(missingFieldPath), /path/);
  });
});

describe("computeTier — ordered presence-based rule", () => {
  test("skip_git true forces T0 even when everything else is true", () => {
    assert.equal(
      computeTier({
        hasPlanning: true,
        hasRoadmapAndState: true,
        hasCommit: true,
        skipGit: true,
      }),
      "T0"
    );
  });

  test(".planning present -> T3", () => {
    assert.equal(
      computeTier({
        hasPlanning: true,
        hasRoadmapAndState: false,
        hasCommit: false,
        skipGit: false,
      }),
      "T3"
    );
  });

  test("ROADMAP.md and STATE.md present, no .planning -> T2", () => {
    assert.equal(
      computeTier({
        hasPlanning: false,
        hasRoadmapAndState: true,
        hasCommit: false,
        skipGit: false,
      }),
      "T2"
    );
  });

  test("commit exists, no .planning, no ROADMAP+STATE -> T1", () => {
    assert.equal(
      computeTier({
        hasPlanning: false,
        hasRoadmapAndState: false,
        hasCommit: true,
        skipGit: false,
      }),
      "T1"
    );
  });

  test("nothing present -> T0", () => {
    assert.equal(
      computeTier({
        hasPlanning: false,
        hasRoadmapAndState: false,
        hasCommit: false,
        skipGit: false,
      }),
      "T0"
    );
  });
});

describe("computeProvenance — four strings", () => {
  test("hasPlanning and hasGit -> git + .planning", () => {
    assert.equal(
      computeProvenance({ hasPlanning: true, hasGit: true }),
      "git + .planning"
    );
  });

  test("hasPlanning and not hasGit -> .planning only", () => {
    assert.equal(
      computeProvenance({ hasPlanning: true, hasGit: false }),
      ".planning only"
    );
  });

  test("not hasPlanning and hasGit -> git only", () => {
    assert.equal(
      computeProvenance({ hasPlanning: false, hasGit: true }),
      "git only"
    );
  });

  test("neither -> registry only", () => {
    assert.equal(
      computeProvenance({ hasPlanning: false, hasGit: false }),
      "registry only"
    );
  });
});
