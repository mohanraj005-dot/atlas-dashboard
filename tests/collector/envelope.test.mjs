// tests/collector/envelope.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildEnvelope, buildProjectFields } from "../../collector/lib/envelope.mjs";
import { signBody } from "../../collector/lib/sign.mjs";
import { collectAll, main } from "../../collector/atlas-collect.mjs";

const SAMPLE_ENVELOPE = JSON.parse(
  readFileSync(
    new URL("../fixtures/envelope.sample.json", import.meta.url),
    "utf8"
  )
);

const GENERATED_AT = "2026-08-09T06:00:00Z";

function fieldsAssertions(fields) {
  assert.equal(fields.length, 4);
  for (const field of fields) {
    assert.ok(field.section, "section must be non-empty");
    assert.ok(field.key, "key must be non-empty");
    assert.ok(field.confidence, "confidence must be non-empty");
    assert.ok(field.source, "source must be non-empty");
    assert.ok(field.as_of, "as_of must be non-empty");
  }
  // sorted by section then key
  for (let i = 1; i < fields.length; i++) {
    const prev = fields[i - 1];
    const cur = fields[i];
    const prevKey = `${prev.section}/${prev.key}`;
    const curKey = `${cur.section}/${cur.key}`;
    assert.ok(prevKey < curKey, `expected ${prevKey} < ${curKey}`);
  }
}

describe("buildProjectFields", () => {
  test("returns exactly 4 sorted entries, every entry fully populated", () => {
    const entry = { slug: "demo", name: "Demo", path: "/x", skip_git: false };
    const gitResult = { value: "2026-08-08T14:22:31-07:00", confidence: "derived", source: "git", as_of: "2026-08-08T14:22:31-07:00" };
    const fields = buildProjectFields(
      entry,
      gitResult,
      { hasPlanning: true, hasRoadmapAndState: true },
      GENERATED_AT
    );
    fieldsAssertions(fields);
  });

  test("a project with a git date produces freshness/last_activity with as_of === value", () => {
    const entry = { slug: "demo", name: "Demo", path: "/x", skip_git: false };
    const gitResult = { value: "2026-08-08T14:22:31-07:00", confidence: "derived", source: "git" };
    const fields = buildProjectFields(
      entry,
      gitResult,
      { hasPlanning: false, hasRoadmapAndState: false },
      GENERATED_AT
    );
    const freshness = fields.find((f) => f.section === "freshness" && f.key === "last_activity");
    assert.equal(freshness.value, "2026-08-08T14:22:31-07:00");
    assert.equal(freshness.confidence, "derived");
    assert.equal(freshness.source, "git");
    assert.equal(freshness.as_of, freshness.value);
  });

  test("a project with no git produces value null and confidence unknown, never 0 or empty string", () => {
    const entry = { slug: "demo", name: "Demo", path: "/x", skip_git: false };
    const gitResult = { value: null, confidence: "unknown", source: "git", reason: "not_a_repo_or_git_error" };
    const fields = buildProjectFields(
      entry,
      gitResult,
      { hasPlanning: false, hasRoadmapAndState: false },
      GENERATED_AT
    );
    const freshness = fields.find((f) => f.section === "freshness" && f.key === "last_activity");
    assert.equal(freshness.value, null);
    assert.notEqual(freshness.value, 0);
    assert.notEqual(freshness.value, "");
    assert.equal(freshness.confidence, "unknown");
  });

  test("a skip_git entry with no git result sources freshness from registry, not git", () => {
    const entry = { slug: "demo", name: "Demo", path: "/x", skip_git: true };
    const fields = buildProjectFields(
      entry,
      null,
      { hasPlanning: false, hasRoadmapAndState: false },
      GENERATED_AT
    );
    const freshness = fields.find((f) => f.section === "freshness" && f.key === "last_activity");
    assert.equal(freshness.value, null);
    assert.equal(freshness.source, "registry");
  });
});

describe("buildProjectFields — declaredFields merge", () => {
  const entry = { slug: "demo", name: "Demo", path: "/x", skip_git: false };
  const gitResult = { value: "2026-08-08T14:22:31-07:00", confidence: "derived", source: "git" };
  const presence = { hasPlanning: true, hasRoadmapAndState: true };

  test("backwards compatibility — no fifth argument returns exactly the same four fields as today", () => {
    const fields = buildProjectFields(entry, gitResult, presence, GENERATED_AT);
    fieldsAssertions(fields);
  });

  test("a declared identity/name collision leaves exactly one identity/name, sourced declared", () => {
    const declaredFields = [
      {
        section: "identity",
        key: "name",
        value: "Human-Declared Name",
        confidence: "declared",
        source: "declared",
        as_of: "2026-08-09T00:00:00Z",
      },
    ];
    const fields = buildProjectFields(entry, gitResult, presence, GENERATED_AT, declaredFields);

    const nameFields = fields.filter((f) => f.section === "identity" && f.key === "name");
    assert.equal(nameFields.length, 1);
    assert.equal(nameFields[0].source, "declared");
    assert.equal(nameFields[0].value, "Human-Declared Name");
  });

  test("non-colliding declared fields are appended and the whole array stays sorted by section then key", () => {
    const declaredFields = [
      {
        section: "template",
        key: "profile",
        value: "code-project",
        confidence: "declared",
        source: "declared",
        as_of: "2026-08-09T00:00:00Z",
      },
      {
        section: "health",
        key: "value",
        value: "green",
        confidence: "declared",
        source: "declared",
        as_of: "2026-08-09T00:00:00Z",
      },
    ];
    const fields = buildProjectFields(entry, gitResult, presence, GENERATED_AT, declaredFields);

    assert.equal(fields.length, 6);
    assert.ok(fields.find((f) => f.section === "template" && f.key === "profile"));
    assert.ok(fields.find((f) => f.section === "health" && f.key === "value"));
    for (let i = 1; i < fields.length; i++) {
      const prevKey = `${fields[i - 1].section}/${fields[i - 1].key}`;
      const curKey = `${fields[i].section}/${fields[i].key}`;
      assert.ok(prevKey < curKey, `expected ${prevKey} < ${curKey}`);
    }
  });

  test("(section,key) uniqueness invariant over the full merged array", () => {
    const declaredFields = [
      {
        section: "identity",
        key: "name",
        value: "Human-Declared Name",
        confidence: "declared",
        source: "declared",
        as_of: "2026-08-09T00:00:00Z",
      },
      {
        section: "template",
        key: "profile",
        value: "code-project",
        confidence: "declared",
        source: "declared",
        as_of: "2026-08-09T00:00:00Z",
      },
    ];
    const fields = buildProjectFields(entry, gitResult, presence, GENERATED_AT, declaredFields);

    const keys = new Set(fields.map((f) => `${f.section}/${f.key}`));
    assert.equal(keys.size, fields.length);
  });
});

describe("buildEnvelope — shape matches tests/fixtures/envelope.sample.json", () => {
  test("same key sets at every level", () => {
    const envelope = buildEnvelope({
      tenantId: "local",
      collectorVersion: "0.1.0",
      runId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      generatedAt: GENERATED_AT,
      ok: true,
      errors: [],
      projects: SAMPLE_ENVELOPE.projects,
    });

    assert.deepEqual(Object.keys(envelope).sort(), Object.keys(SAMPLE_ENVELOPE).sort());

    for (let i = 0; i < envelope.projects.length; i++) {
      assert.deepEqual(
        Object.keys(envelope.projects[i]).sort(),
        Object.keys(SAMPLE_ENVELOPE.projects[i]).sort()
      );
      for (let j = 0; j < envelope.projects[i].fields.length; j++) {
        assert.deepEqual(
          Object.keys(envelope.projects[i].fields[j]).sort(),
          Object.keys(SAMPLE_ENVELOPE.projects[i].fields[j]).sort()
        );
      }
    }
  });

  test("same enum membership for confidence and tier", () => {
    const CONFIDENCE_ENUM = new Set(["declared", "derived", "unknown"]);
    const TIER_ENUM = new Set(["T0", "T1", "T2", "T3"]);
    for (const project of SAMPLE_ENVELOPE.projects) {
      assert.ok(TIER_ENUM.has(project.tier));
      for (const field of project.fields) {
        assert.ok(CONFIDENCE_ENUM.has(field.confidence));
      }
    }
  });
});

describe("collectAll — per-project adapter failure does not fail the run", () => {
  function fakeRegistry(count) {
    return {
      schema_version: 1,
      tenant_id: "local",
      projects: Array.from({ length: count }, (_, i) => ({
        slug: `proj-${i}`,
        name: `Project ${i}`,
        path: `/fake/proj-${i}`,
        git_scope: "root",
        skip_git: false,
      })),
    };
  }

  test("a single project whose adapter throws yields ok true, an errors entry naming that slug, all projects present", async () => {
    const registry = fakeRegistry(11);
    const throwingSlug = "proj-5";

    const collectGitFn = (rawPath) => {
      if (rawPath.includes(throwingSlug)) {
        throw new Error("boom: adapter exploded");
      }
      return { value: "2026-01-01T00:00:00-08:00", confidence: "derived", source: "git" };
    };

    const result = await collectAll({
      registry,
      generatedAt: GENERATED_AT,
      collectGitFn,
      hasPlanningDirFn: () => false,
      hasRoadmapAndStateFn: () => false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.projects.length, 11);
    const matchingError = result.errors.find((e) => e.slug === throwingSlug);
    assert.ok(matchingError, "expected an errors entry naming the throwing slug");
    assert.match(matchingError.error, /boom/);

    const failedProject = result.projects.find((p) => p.slug === throwingSlug);
    const freshness = failedProject.fields.find(
      (f) => f.section === "freshness" && f.key === "last_activity"
    );
    assert.equal(freshness.value, null);
    assert.equal(freshness.confidence, "unknown");
  });
});

describe("signBody", () => {
  test("output starts with sha256= and its hex tail is 64 characters", () => {
    const sig = signBody("hello world", "secret");
    assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  });

  test("is deterministic for the same body and secret", () => {
    const a = signBody("hello world", "secret");
    const b = signBody("hello world", "secret");
    assert.equal(a, b);
  });

  test("differs when the body changes by one character", () => {
    const a = signBody("hello world", "secret");
    const b = signBody("hello worlD", "secret");
    assert.notEqual(a, b);
  });

  test("differs when the secret changes by one character", () => {
    const a = signBody("hello world", "secret");
    const b = signBody("hello world", "secreT");
    assert.notEqual(a, b);
  });

  test("throws when the secret is empty or undefined", () => {
    assert.throws(() => signBody("body", ""));
    assert.throws(() => signBody("body", undefined));
  });
});

describe("main — end-to-end orchestration with a stubbed fetch", () => {
  function makeStubFetch(responses) {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const status = responses.shift() ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({ projects_seen: 1, snapshots_written: 1 }),
      };
    };
    return { fetchImpl, calls };
  }

  test("registry unreadable causes exactly one POST with ok false, empty projects, one errors entry, and a non-zero exit", async () => {
    const { fetchImpl, calls } = makeStubFetch([200]);

    const exitCode = await main({
      argv: [],
      env: {
        ATLAS_REGISTRY: "/definitely/does/not/exist/registry.yml",
        ATLAS_INGEST_HMAC_SECRET: "test-secret",
        ATLAS_INGEST_TOKEN: "test-token",
        ATLAS_INGEST_URL: "https://example.test/v1/ingest",
      },
      fetchImpl,
    });

    assert.equal(exitCode, 1);
    assert.equal(calls.length, 1);

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.ok, false);
    assert.deepEqual(body.projects, []);
    assert.equal(body.errors.length, 1);
    assert.equal(body.errors[0].slug, null);
  });

  test("a normal run sends X-Atlas-Signature matching signBody of the exact body sent", async () => {
    const { fetchImpl, calls } = makeStubFetch([200]);
    const secret = "test-secret";

    const registry = {
      schema_version: 1,
      tenant_id: "local",
      projects: [
        { slug: "solo", name: "Solo", path: "/fake/solo", git_scope: "root", skip_git: false },
      ],
    };

    const exitCode = await main({
      argv: [],
      env: {
        ATLAS_INGEST_HMAC_SECRET: secret,
        ATLAS_INGEST_TOKEN: "test-token",
        ATLAS_INGEST_URL: "https://example.test/v1/ingest",
      },
      loadRegistryFn: () => registry,
      collectGitFn: () => ({ value: null, confidence: "unknown", source: "git", reason: "not_a_repo_or_git_error" }),
      hasPlanningDirFn: () => false,
      hasRoadmapAndStateFn: () => false,
      fetchImpl,
    });

    assert.equal(exitCode, 0);
    assert.equal(calls.length, 1);

    const sentBody = calls[0].init.body;
    const expectedSignature = signBody(sentBody, secret);
    assert.equal(calls[0].init.headers["X-Atlas-Signature"], expectedSignature);
  });

  test("the fatal-path failure envelope is also signed, matching its own body", async () => {
    const { fetchImpl, calls } = makeStubFetch([200]);
    const secret = "test-secret";

    const exitCode = await main({
      argv: [],
      env: {
        ATLAS_REGISTRY: "/definitely/does/not/exist/registry.yml",
        ATLAS_INGEST_HMAC_SECRET: secret,
        ATLAS_INGEST_TOKEN: "test-token",
        ATLAS_INGEST_URL: "https://example.test/v1/ingest",
      },
      fetchImpl,
    });

    assert.equal(exitCode, 1);
    assert.equal(calls.length, 1);

    const sentBody = calls[0].init.body;
    const expectedSignature = signBody(sentBody, secret);
    assert.equal(calls[0].init.headers["X-Atlas-Signature"], expectedSignature);
  });

  test("--dry-run builds and prints an envelope without requiring credentials or POSTing", async () => {
    const registry = {
      schema_version: 1,
      tenant_id: "local",
      projects: [
        { slug: "solo", name: "Solo", path: "/fake/solo", git_scope: "root", skip_git: false },
      ],
    };
    let fetchCalled = false;
    const fetchImpl = async () => {
      fetchCalled = true;
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const exitCode = await main({
      argv: ["--dry-run"],
      env: {},
      loadRegistryFn: () => registry,
      collectGitFn: () => ({ value: null, confidence: "unknown", source: "git", reason: "not_a_repo_or_git_error" }),
      hasPlanningDirFn: () => false,
      hasRoadmapAndStateFn: () => false,
      fetchImpl,
    });

    assert.equal(exitCode, 0);
    assert.equal(fetchCalled, false);
  });
});
