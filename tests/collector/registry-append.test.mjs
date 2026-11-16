// tests/collector/registry-append.test.mjs
// Covers the first programmatic writer for collector/registry.yml:
// readRegistryDoc (raw parse), appendRegistryEntry (atomic, lock-guarded,
// slug-and-path idempotent append).
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readRegistryDoc,
  appendRegistryEntry,
  mergeRegistryDocs,
  loadRegistry,
} from "../../collector/lib/registry.mjs";

const REGISTRY_PATH = join(
  new URL("../../collector/registry.yml", import.meta.url).pathname
);
const REAL_REGISTRY_RAW = readFileSync(REGISTRY_PATH, "utf8");

describe("readRegistryDoc — byte-for-byte round trip", () => {
  test('JSON.parse then JSON.stringify(doc, null, 2) + "\\n" is byte-identical to the real registry.yml', () => {
    const doc = JSON.parse(REAL_REGISTRY_RAW);
    const roundTripped = JSON.stringify(doc, null, 2) + "\n";
    assert.equal(roundTripped, REAL_REGISTRY_RAW);
  });

  test("readRegistryDoc returns the raw doc — no tilde expansion, unlike loadRegistry", () => {
    const raw = readRegistryDoc(REGISTRY_PATH);
    const loaded = loadRegistry(REGISTRY_PATH);
    const orchardRaw = raw.projects.find((p) => p.slug === "orchard");
    const orchardLoaded = loaded.projects.find((p) => p.slug === "orchard");
    assert.equal(orchardRaw.path, "~/projects/orchard");
    assert.notEqual(orchardLoaded.path, "~/projects/orchard");
  });
});

describe("mergeRegistryDocs — smoke import (full coverage lives in install-merge.test.mjs)", () => {
  test("a null deployedDoc returns the source doc unchanged", () => {
    const source = { schema_version: 1, tenant_id: "local", projects: [{ slug: "a", name: "A", path: "~/A" }] };
    const result = mergeRegistryDocs(source, null);
    assert.equal(result.doc, source);
    assert.deepEqual(result.preserved, []);
  });
});

describe("appendRegistryEntry", () => {
  const dirs = [];
  let dir;

  function freshRegistry() {
    dir = mkdtempSync(join(tmpdir(), "atlas-append-"));
    dirs.push(dir);
    const target = join(dir, "registry.yml");
    writeFileSync(target, REAL_REGISTRY_RAW, "utf8");
    return target;
  }

  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("adds one entry and preserves all others byte-for-byte in tilde form", () => {
    const target = freshRegistry();
    const originalDoc = JSON.parse(REAL_REGISTRY_RAW);

    const result = appendRegistryEntry(target, {
      slug: "newproj",
      name: "New Project",
      path: "~/NewProj",
      git_scope: "root",
      skip_git: false,
    });

    assert.equal(result.written, true);

    const afterDoc = readRegistryDoc(target);
    assert.equal(afterDoc.projects.length, originalDoc.projects.length + 1);

    for (const original of originalDoc.projects) {
      const stillThere = afterDoc.projects.find((p) => p.slug === original.slug);
      assert.ok(stillThere, `expected slug "${original.slug}" to survive the append`);
      assert.equal(
        stillThere.path,
        original.path,
        `expected "${original.slug}"'s path to remain tilde-form, unchanged (the loadRegistry trap)`
      );
    }

    const added = afterDoc.projects.find((p) => p.slug === "newproj");
    assert.equal(added.path, "~/NewProj");
  });

  test('idempotent by slug — appending the same slug twice returns {written:false, reason:"already_registered"} and leaves the file unchanged', () => {
    const target = freshRegistry();
    appendRegistryEntry(target, {
      slug: "newproj",
      name: "New Project",
      path: "~/NewProj",
      git_scope: "root",
      skip_git: false,
    });
    const afterFirst = readFileSync(target, "utf8");

    const result = appendRegistryEntry(target, {
      slug: "newproj",
      name: "New Project Again",
      path: "~/NewProjAgain",
      git_scope: "root",
      skip_git: false,
    });

    assert.equal(result.written, false);
    assert.equal(result.reason, "already_registered");
    const afterSecond = readFileSync(target, "utf8");
    assert.equal(afterSecond, afterFirst);
  });

  test('idempotent by realpath — a different slug whose path resolves to an already-registered directory returns {written:false, reason:"path_already_registered"}', () => {
    const target = freshRegistry();
    const existing = JSON.parse(REAL_REGISTRY_RAW).projects[0];

    const result = appendRegistryEntry(target, {
      slug: "some-other-slug",
      name: "Duplicate Path",
      path: existing.path,
      git_scope: "root",
      skip_git: false,
    });

    assert.equal(result.written, false);
    assert.equal(result.reason, "path_already_registered");
  });

  test("slug validation — invalid slugs each throw a message matching /invalid slug/", () => {
    const target = freshRegistry();
    for (const badSlug of ["../etc", "Bad Slug", ""]) {
      assert.throws(
        () => appendRegistryEntry(target, { slug: badSlug, name: "X", path: "~/X" }),
        /invalid slug/
      );
    }
  });

  test("atomicity under simulated crash — an injected renameSync failure leaves the original file byte-identical and no .tmp- file behind", () => {
    const target = freshRegistry();
    const before = readFileSync(target, "utf8");

    assert.throws(() =>
      appendRegistryEntry(
        target,
        { slug: "crashtest", name: "Crash Test", path: "~/CrashTest" },
        {
          renameSyncFn: () => {
            throw new Error("simulated rename failure");
          },
        }
      )
    );

    const after = readFileSync(target, "utf8");
    assert.equal(after, before);

    const leftovers = readdirSync(dir).filter((f) => /\.tmp-/.test(f));
    assert.deepEqual(leftovers, []);
  });

  test("concurrent-run guard — a pre-existing lock file blocks the append with a message matching /another atlas init/, leaving the registry unchanged", () => {
    const target = freshRegistry();
    const lockPath = `${target}.lock`;
    writeFileSync(lockPath, "", "utf8");
    const before = readFileSync(target, "utf8");

    assert.throws(
      () => appendRegistryEntry(target, { slug: "lockedout", name: "Locked Out", path: "~/LockedOut" }),
      /another atlas init/
    );

    const after = readFileSync(target, "utf8");
    assert.equal(after, before);
    rmSync(lockPath, { force: true });
  });

  test("a normal successful append leaves no .lock file behind", () => {
    const target = freshRegistry();
    appendRegistryEntry(target, { slug: "cleanlock", name: "Clean Lock", path: "~/CleanLock" });
    const remaining = readdirSync(dir).filter((f) => f.endsWith(".lock"));
    assert.deepEqual(remaining, []);
  });
});

describe("readRegistryDoc — error paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-append-errors-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('a malformed target throws matching /not valid JSON-subset YAML/', () => {
    const badPath = join(dir, "registry.yml");
    writeFileSync(badPath, "{ not json", "utf8");
    assert.throws(() => readRegistryDoc(badPath), /not valid JSON-subset YAML/);
  });

  test('a missing target throws matching /could not read/', () => {
    const missingPath = join(dir, "does-not-exist.yml");
    assert.throws(() => readRegistryDoc(missingPath), /could not read/);
  });
});
