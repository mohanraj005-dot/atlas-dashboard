// tests/collector/project-template.test.mjs
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadTemplateDef,
  loadProjectYml,
  parseProjectYml,
  sectionKeysIn,
  sectionsHash,
  REQUIRED_SECTIONS,
  AUTO_DERIVED_SECTIONS,
  OPTIONAL_CANONICAL,
  PROFILES,
  NO_DATA_COPY,
} from "../../collector/lib/project-template.mjs";

const dir = mkdtempSync(join(tmpdir(), "atlas-project-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("loadTemplateDef", () => {
  test("returns version 1.0.0", () => {
    const def = loadTemplateDef("1.0.0");
    assert.equal(def.version, "1.0.0");
  });

  test("sections.required deep-equals the three required sections", () => {
    const def = loadTemplateDef("1.0.0");
    assert.deepEqual(def.sections.required, ["identity", "profile", "next_action"]);
  });

  test("sections.auto_derived deep-equals the four auto-derived sections", () => {
    const def = loadTemplateDef("1.0.0");
    assert.deepEqual(def.sections.auto_derived, [
      "coverage",
      "freshness",
      "phase_progress",
      "recent_activity",
    ]);
  });

  test("sections.optional_canonical has length 6 and contains all six names", () => {
    const def = loadTemplateDef("1.0.0");
    assert.equal(def.sections.optional_canonical.length, 6);
    for (const name of ["health", "blockers", "risks", "decisions", "open_questions", "links"]) {
      assert.ok(
        def.sections.optional_canonical.includes(name),
        `expected optional_canonical to include "${name}"`
      );
    }
  });

  test("Object.keys(profiles) deep-equals the four profile names", () => {
    const def = loadTemplateDef("1.0.0");
    assert.deepEqual(Object.keys(def.profiles), [
      "code-project",
      "ops-workstream",
      "business",
      "research",
    ]);
  });

  test("ops-workstream profile labels next_action as 'Current focus'", () => {
    const def = loadTemplateDef("1.0.0");
    assert.equal(def.profiles["ops-workstream"].labels.next_action, "Current focus");
  });

  test("research profile labels next_action as 'Open question'", () => {
    const def = loadTemplateDef("1.0.0");
    assert.equal(def.profiles.research.labels.next_action, "Open question");
  });

  test("an unknown template version throws naming the version", () => {
    assert.throws(() => loadTemplateDef("9.9.9"), /9\.9\.9/);
  });
});

describe("parseProjectYml — accept cases", () => {
  test("the end-to-end fixture parses and round-trips its values within a 15-line budget", () => {
    const fixture = {
      _format: "JSON-subset YAML — see collector/registry.yml for the convention.",
      identity: {
        name: "Orchard Portal",
        statement: "Customer-facing ordering portal, spun out of Orchard.",
      },
      profile: "code-project",
      next_action: "Wire the Stripe webhook retry queue before the Friday demo.",
      health: "green",
      blockers: ["Waiting on vendor API credentials from ops"],
    };
    const raw = JSON.stringify(fixture, null, 2);
    const doc = parseProjectYml(raw, "sc1-fixture.yml");
    assert.equal(doc.identity.name, "Orchard Portal");
    assert.equal(
      doc.identity.statement,
      "Customer-facing ordering portal, spun out of Orchard."
    );
    assert.equal(doc.profile, "code-project");
    assert.equal(
      doc.next_action,
      "Wire the Stripe webhook retry queue before the Friday demo."
    );
    assert.equal(doc.health, "green");
    assert.deepEqual(doc.blockers, ["Waiting on vendor API credentials from ops"]);
    assert.ok(JSON.stringify(doc, null, 2).split("\n").length <= 16);
  });

  test("a bespoke top-level key parses without throwing", () => {
    const raw = JSON.stringify({
      identity: { name: "X", statement: "Y" },
      profile: "code-project",
      next_action: "Z",
      vendor_escalations: ["Acme SLA"],
    });
    const doc = parseProjectYml(raw, "bespoke.yml");
    assert.ok(sectionKeysIn(doc).includes("vendor_escalations"));
  });

  test("all four profile enum values parse", () => {
    for (const profile of PROFILES) {
      const raw = JSON.stringify({
        identity: { name: "X", statement: "Y" },
        profile,
        next_action: "Z",
      });
      const doc = parseProjectYml(raw, `profile-${profile}.yml`);
      assert.equal(doc.profile, profile);
    }
  });

  test("sectionKeysIn excludes _format and includes every other top-level key", () => {
    const raw = JSON.stringify({
      _format: "note",
      identity: { name: "X", statement: "Y" },
      profile: "code-project",
      next_action: "Z",
      health: "green",
    });
    const doc = parseProjectYml(raw, "keys.yml");
    const keys = sectionKeysIn(doc);
    assert.ok(!keys.includes("_format"));
    assert.ok(keys.includes("identity"));
    assert.ok(keys.includes("profile"));
    assert.ok(keys.includes("next_action"));
    assert.ok(keys.includes("health"));
  });
});

describe("parseProjectYml — reject cases", () => {
  test("non-JSON input throws naming it not valid JSON-subset YAML", () => {
    assert.throws(
      () => parseProjectYml("{ this is not json", "bad.yml"),
      (err) => {
        assert.match(err.message, /parseProjectYml/);
        assert.match(err.message, /not valid JSON-subset YAML/);
        return true;
      }
    );
  });

  for (const missing of REQUIRED_SECTIONS) {
    test(`missing required section "${missing}" throws naming it`, () => {
      const full = {
        identity: { name: "X", statement: "Y" },
        profile: "code-project",
        next_action: "Z",
      };
      delete full[missing];
      assert.throws(
        () => parseProjectYml(JSON.stringify(full), "missing.yml"),
        (err) => {
          assert.match(err.message, /parseProjectYml/);
          assert.match(err.message, new RegExp(missing));
          return true;
        }
      );
    });
  }

  test("identity.name empty string throws", () => {
    const raw = JSON.stringify({
      identity: { name: "", statement: "Y" },
      profile: "code-project",
      next_action: "Z",
    });
    assert.throws(() => parseProjectYml(raw, "name-empty.yml"), /identity\.name/);
  });

  test("identity.statement missing throws", () => {
    const raw = JSON.stringify({
      identity: { name: "X" },
      profile: "code-project",
      next_action: "Z",
    });
    assert.throws(() => parseProjectYml(raw, "statement-missing.yml"), /identity\.statement/);
  });

  test("next_action empty string throws", () => {
    const raw = JSON.stringify({
      identity: { name: "X", statement: "Y" },
      profile: "code-project",
      next_action: "",
    });
    assert.throws(() => parseProjectYml(raw, "next-action-empty.yml"), /next_action/);
  });

  test('profile "startup" throws naming unknown profile and listing all four valid values', () => {
    const raw = JSON.stringify({
      identity: { name: "X", statement: "Y" },
      profile: "startup",
      next_action: "Z",
    });
    assert.throws(
      () => parseProjectYml(raw, "bad-profile.yml"),
      (err) => {
        assert.match(err.message, /unknown profile/);
        for (const p of PROFILES) {
          assert.match(err.message, new RegExp(p));
        }
        return true;
      }
    );
  });

  for (const key of AUTO_DERIVED_SECTIONS) {
    test(`auto-derived key "${key}" present at top level throws`, () => {
      const raw = JSON.stringify({
        identity: { name: "X", statement: "Y" },
        profile: "code-project",
        next_action: "Z",
        [key]: "hand-typed value",
      });
      assert.throws(
        () => parseProjectYml(raw, "auto-derived.yml"),
        (err) => {
          assert.match(err.message, /auto-derived/);
          assert.match(err.message, new RegExp(key));
          return true;
        }
      );
    });
  }

  test("as_of at top level throws", () => {
    const raw = JSON.stringify({
      identity: { name: "X", statement: "Y" },
      profile: "code-project",
      next_action: "Z",
      as_of: "2026-08-10",
    });
    assert.throws(() => parseProjectYml(raw, "as-of-top.yml"), /as_of/);
  });

  test("as_of nested inside identity throws", () => {
    const raw = JSON.stringify({
      identity: { name: "X", statement: "Y", as_of: "2026-08-10" },
      profile: "code-project",
      next_action: "Z",
    });
    assert.throws(() => parseProjectYml(raw, "as-of-nested.yml"), /as_of/);
  });

  for (const key of ["__proto__", "constructor", "prototype"]) {
    test(`forbidden key "${key}" as a top-level key throws`, () => {
      const doc = {
        identity: { name: "X", statement: "Y" },
        profile: "code-project",
        next_action: "Z",
      };
      Object.defineProperty(doc, key, {
        value: "danger",
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const raw = JSON.stringify(doc);
      assert.throws(() => parseProjectYml(raw, "forbidden.yml"), /forbidden key/);
    });
  }

  test("a document over 65536 bytes throws too large", () => {
    const raw = JSON.stringify({
      identity: { name: "X", statement: "Y".repeat(70000) },
      profile: "code-project",
      next_action: "Z",
    });
    assert.throws(() => parseProjectYml(raw, "too-large.yml"), /too large/);
  });

  test("a document nested more than 4 levels deep throws too deeply nested", () => {
    const raw = JSON.stringify({
      identity: { name: "X", statement: "Y" },
      profile: "code-project",
      next_action: "Z",
      health: { a: { b: { c: { d: "too deep" } } } },
    });
    assert.throws(() => parseProjectYml(raw, "too-deep.yml"), /too deeply nested/);
  });

  test("an optional-section array with more than 100 items throws too many items", () => {
    const raw = JSON.stringify({
      identity: { name: "X", statement: "Y" },
      profile: "code-project",
      next_action: "Z",
      blockers: Array.from({ length: 101 }, (_, i) => `item ${i}`),
    });
    assert.throws(() => parseProjectYml(raw, "too-many-items.yml"), /too many items/);
  });

  test("a string value longer than 4096 bytes throws value too long", () => {
    const raw = JSON.stringify({
      identity: { name: "X", statement: "Y" },
      profile: "code-project",
      next_action: "Z",
      health: "z".repeat(5000),
    });
    assert.throws(() => parseProjectYml(raw, "value-too-long.yml"), /value too long/);
  });

  test("loadProjectYml on a nonexistent path throws could not read", () => {
    assert.throws(
      () => loadProjectYml(join(dir, "does-not-exist.yml")),
      (err) => {
        assert.match(err.message, /loadProjectYml/);
        assert.match(err.message, /could not read/);
        return true;
      }
    );
  });

  test("loadProjectYml on a real file delegates to parseProjectYml", () => {
    const p = join(dir, "real.yml");
    writeFileSync(
      p,
      JSON.stringify({
        identity: { name: "X", statement: "Y" },
        profile: "code-project",
        next_action: "Z",
      }),
      "utf8"
    );
    const doc = loadProjectYml(p);
    assert.equal(doc.profile, "code-project");
  });
});

describe("sectionsHash", () => {
  test("returns a string starting with sha256:", () => {
    const doc = {
      identity: { name: "X", statement: "Y" },
      profile: "code-project",
      next_action: "Z",
    };
    assert.match(sectionsHash(doc), /^sha256:/);
  });

  test("is identical for two documents whose section keys differ only in insertion order", () => {
    const a = { identity: {}, profile: "x", next_action: "y", health: "green" };
    const b = { health: "green", next_action: "y", profile: "x", identity: {} };
    assert.equal(sectionsHash(a), sectionsHash(b));
  });

  test("differs when a section is added", () => {
    const a = { identity: {}, profile: "x", next_action: "y" };
    const b = { identity: {}, profile: "x", next_action: "y", health: "green" };
    assert.notEqual(sectionsHash(a), sectionsHash(b));
  });

  test("ignores _format", () => {
    const a = { _format: "note-a", identity: {}, profile: "x", next_action: "y" };
    const b = { _format: "note-b-completely-different", identity: {}, profile: "x", next_action: "y" };
    assert.equal(sectionsHash(a), sectionsHash(b));
  });
});

describe("exported constants", () => {
  test("NO_DATA_COPY matches the exact copy string", () => {
    assert.equal(NO_DATA_COPY, "— no data (optional section, not declared)");
  });

  test("OPTIONAL_CANONICAL is a Set of six names", () => {
    assert.ok(OPTIONAL_CANONICAL instanceof Set);
    assert.equal(OPTIONAL_CANONICAL.size, 6);
  });

  test("AUTO_DERIVED_SECTIONS is a Set of four names", () => {
    assert.ok(AUTO_DERIVED_SECTIONS instanceof Set);
    assert.equal(AUTO_DERIVED_SECTIONS.size, 4);
  });
});
