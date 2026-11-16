// tests/collector/install-merge.test.mjs
// The regression: re-running collector/install.mjs must not delete
// entries that exist only in the deployed registry.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { mergeRegistryDocs } from "../../collector/lib/registry.mjs";
import { buildPlan } from "../../collector/install.mjs";

function doc(projects) {
  return { _format: "test fixture", schema_version: 1, tenant_id: "local", projects };
}

describe("mergeRegistryDocs — deployed-only entries survive a re-install", () => {
  test("a slug present only in the deployed registry (e.g. one atlas init added) is preserved after merging with the repo registry", () => {
    const source = doc([
      { slug: "a", name: "A", path: "~/A" },
      { slug: "b", name: "B", path: "~/B" },
    ]);
    const deployed = doc([
      { slug: "a", name: "A", path: "~/A" },
      { slug: "b", name: "B", path: "~/B" },
      { slug: "declared-later", name: "Declared Later", path: "~/DeclaredLater" },
    ]);

    const { doc: merged } = mergeRegistryDocs(source, deployed);

    assert.equal(merged.projects.length, 3);
    assert.ok(
      merged.projects.some((p) => p.slug === "declared-later"),
      "expected the deployed-only slug to survive the merge"
    );
  });
});

describe("mergeRegistryDocs — merge semantics", () => {
  test("source wins on a shared slug", () => {
    const source = doc([{ slug: "a", name: "Source Name", path: "~/A" }]);
    const deployed = doc([{ slug: "a", name: "Deployed Name", path: "~/A" }]);

    const { doc: merged, preserved } = mergeRegistryDocs(source, deployed);

    const entry = merged.projects.find((p) => p.slug === "a");
    assert.equal(entry.name, "Source Name");
    assert.ok(!preserved.includes("a"));
  });

  test("new source entries are added and listed in added", () => {
    const source = doc([{ slug: "a", name: "A", path: "~/A" }]);
    const deployed = doc([]);

    const { added } = mergeRegistryDocs(source, deployed);

    assert.deepEqual(added, ["a"]);
  });

  test("order is stable — every source entry in source order first, then deployed-only entries in deployed order", () => {
    const source = doc([
      { slug: "b", name: "B", path: "~/B" },
      { slug: "a", name: "A", path: "~/A" },
    ]);
    const deployed = doc([
      { slug: "z", name: "Z", path: "~/Z" },
      { slug: "y", name: "Y", path: "~/Y" },
    ]);

    const { doc: merged } = mergeRegistryDocs(source, deployed);

    assert.deepEqual(merged.projects.map((p) => p.slug), ["b", "a", "z", "y"]);
  });

  test("a path conflict between a deployed-only entry and a source entry is reported in conflicts and NOT added", () => {
    const source = doc([{ slug: "a", name: "A", path: "/tmp/atlas-merge-conflict-fixture" }]);
    const deployed = doc([{ slug: "z", name: "Z", path: "/tmp/atlas-merge-conflict-fixture" }]);

    const { doc: merged, conflicts } = mergeRegistryDocs(source, deployed);

    assert.equal(merged.projects.some((p) => p.slug === "z"), false);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].slug, "z");
    assert.equal(conflicts[0].collides_with, "a");
  });

  test("a missing deployed file (null) is not an error — returns the source doc unchanged", () => {
    const source = doc([{ slug: "a", name: "A", path: "~/A" }]);

    const result = mergeRegistryDocs(source, null);

    assert.equal(result.doc, source);
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.preserved, []);
    assert.deepEqual(result.conflicts, []);
  });
});

describe("buildPlan — installer plan no longer blind-copies the registry", () => {
  test("copies contains no registry.yml entry, and a registryMerge object is exposed with from/to", () => {
    const plan = buildPlan({ home: "/tmp/fake" });

    assert.ok(
      !plan.copies.some((c) => c.to.endsWith("registry.yml")),
      "expected copies to contain no blind registry.yml copy"
    );
    assert.ok(plan.registryMerge, "expected buildPlan() to expose a registryMerge object");
    assert.ok(plan.registryMerge.from.endsWith("registry.yml"));
    assert.ok(plan.registryMerge.to.endsWith("registry.yml"));
  });
});
