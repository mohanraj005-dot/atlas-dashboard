// tests/portfolio.test.js
// Read-API coverage for GET /api/portfolio and GET /api/health. Seeds through the real /v1/ingest endpoint — reusing
// the signed(body) helper pattern from tests/ingest.test.js — so the read
// tests also prove the write and read halves agree on the schema.
import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect } from "vitest";
import { handleIngest } from "../src/ingest.js";
import { handlePortfolio } from "../src/portfolio.js";
import { handleHealth, collectorState } from "../src/health.js";
import worker from "../src/index.js";
import { sha256Hex } from "../src/lib/hash.js";
import { SESSION_COOKIE, issueSessionToken } from "../src/lib/session.js";

const GENERATED_AT = "2026-08-09T06:00:00Z";

async function hmacHex(body, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body)
  );
  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Builds a POST /v1/ingest Request, signed by default with
 * env.ATLAS_INGEST_HMAC_SECRET (the fixed test binding from
 * vitest.config.js), mirroring tests/ingest.test.js's helper.
 */
async function signed(bodyObj, opts = {}) {
  const {
    secret = env.ATLAS_INGEST_HMAC_SECRET,
    token = "test-token",
    omitSignature = false,
  } = opts;

  const body = JSON.stringify(bodyObj);
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": String(new TextEncoder().encode(body).length),
  };
  if (token !== null) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (!omitSignature) {
    headers["X-Atlas-Signature"] = `sha256=${await hmacHex(body, secret)}`;
  }

  return new Request("http://example.com/v1/ingest", {
    method: "POST",
    body,
    headers,
  });
}

function field(section, key, value, confidence, source, as_of) {
  return { section, key, value, confidence, source, as_of };
}

function declaredField(section, key, value, as_of = GENERATED_AT) {
  return field(section, key, value, "declared", "declared", as_of);
}

function buildProject(slug, name, tier, provenance, lastActivity) {
  const lastActivityField = lastActivity
    ? field(
        "freshness",
        "last_activity",
        lastActivity,
        "derived",
        "git",
        lastActivity
      )
    : field("freshness", "last_activity", null, "unknown", "git", GENERATED_AT);

  return {
    slug,
    name,
    tier,
    planner_version: null,
    parser_status: "ok",
    fields: [
      field("identity", "name", name, "declared", "registry", GENERATED_AT),
      field("identity", "tier", tier, "derived", "collector", GENERATED_AT),
      field(
        "identity",
        "provenance",
        provenance,
        "derived",
        "collector",
        GENERATED_AT
      ),
      lastActivityField,
    ],
  };
}

// 11 registered projects, exactly 2 at T3, 3 with last_activity null, and a
// deliberate spread of dates so ascending sort order is unambiguous.
export const envelopeFixture = {
  schema_version: 1,
  tenant_id: "local",
  collector_version: "0.1.0",
  run_id: "run-standard",
  generated_at: GENERATED_AT,
  ok: true,
  errors: [],
  projects: [
    buildProject(
      "atlas",
      "Atlas",
      "T3",
      "git + .planning",
      "2026-08-09T05:00:00Z"
    ),
    buildProject(
      "orchard",
      "Orchard",
      "T3",
      "git + .planning",
      "2026-08-08T20:00:00Z"
    ),
    buildProject(
      "kestrel",
      "Kestrel",
      "T2",
      "git + .planning",
      "2026-08-01T10:00:00Z"
    ),
    buildProject("orchard-portal", "Orchard Portal", "T1", "git only", "2026-07-15T10:00:00Z"),
    buildProject(
      "status-board",
      "Status Board",
      "T1",
      "git only",
      "2026-06-01T10:00:00Z"
    ),
    buildProject(
      "project-f",
      "Project F",
      "T1",
      "git only",
      "2026-05-01T10:00:00Z"
    ),
    buildProject("project-g", "Project G", "T0", "registry only", null),
    buildProject(
      "project-h",
      "Project H",
      "T1",
      "git only",
      "2026-03-01T10:00:00Z"
    ),
    buildProject(
      "project-i",
      "Project I",
      "T0",
      "registry only",
      "2026-02-01T10:00:00Z"
    ),
    buildProject("harbor", "Harbor", "T0", "registry only", null),
    buildProject(
      "field-notes",
      "Field Notes",
      "T0",
      "registry only",
      null
    ),
  ],
};

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM fields"),
    env.DB.prepare("DELETE FROM snapshots"),
    env.DB.prepare("DELETE FROM projects"),
    env.DB.prepare("DELETE FROM collector_runs"),
    env.DB.prepare("DELETE FROM ingest_tokens"),
    env.DB.prepare("DELETE FROM tenants WHERE tenant_id != 'local'"),
  ]);

  const activeHash = await sha256Hex("test-token");
  await env.DB.prepare(
    "INSERT INTO ingest_tokens (token_hash, tenant_id, scope) VALUES (?, 'local', 'ingest:write')"
  )
    .bind(activeHash)
    .run();
});

describe("GET /api/portfolio", () => {
  it("lists all registered projects", async () => {
    await handleIngest(await signed(envelopeFixture), env);

    const res = await handlePortfolio(
      new Request("http://example.com/api/portfolio"),
      env
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.projects.length).toBe(11);
    const slugs = body.projects.map((p) => p.slug).sort();
    const expectedSlugs = envelopeFixture.projects.map((p) => p.slug).sort();
    expect(slugs).toEqual(expectedSlugs);

    for (const project of body.projects) {
      expect(Object.keys(project).sort()).toEqual(
        [
          "declared_at",
          "last_activity",
          "managed",
          "name",
          "provenance",
          "review_state",
          "slug",
          "tier",
        ].sort()
      );
    }
  });

  it("coverage tile", async () => {
    await handleIngest(await signed(envelopeFixture), env);

    const res = await handlePortfolio(
      new Request("http://example.com/api/portfolio"),
      env
    );
    const body = await res.json();

    expect(body.coverage.parsed.value).toBe(2);
    expect(body.coverage.declared.value).toBe(0);
    expect(body.coverage.total.value).toBe(11);
    expect(body.coverage.gap.value).toBe(9);
    expect(body.coverage.instrumented).toBeUndefined();

    expect(body.coverage.parsed.as_of).toBe(GENERATED_AT);
    expect(body.coverage.declared.as_of).toBe(GENERATED_AT);
    expect(body.coverage.total.as_of).toBe(GENERATED_AT);
    expect(body.coverage.gap.as_of).toBe(GENERATED_AT);
  });

  it("declared projects (none T3) shift declared and gap", async () => {
    // Three currently-non-T3 projects each gain a declared next_action
    // statement and a declared declared_at timestamp.
    const declaredSlugs = new Set(["orchard-portal", "status-board", "project-f"]);
    const envelope = {
      ...envelopeFixture,
      run_id: "run-declared",
      projects: envelopeFixture.projects.map((project) =>
        declaredSlugs.has(project.slug)
          ? {
              ...project,
              fields: [
                ...project.fields,
                declaredField("next_action", "statement", "Ship the thing"),
                declaredField(
                  "template",
                  "declared_at",
                  "2026-07-01T00:00:00.000Z"
                ),
              ],
            }
          : project
      ),
    };
    await handleIngest(await signed(envelope), env);

    const res = await handlePortfolio(
      new Request("http://example.com/api/portfolio"),
      env
    );
    const body = await res.json();

    expect(body.coverage.parsed.value).toBe(2);
    expect(body.coverage.declared.value).toBe(3);
    expect(body.coverage.total.value).toBe(11);
    expect(body.coverage.gap.value).toBe(6);
  });

  it("a project both T3 and declared is counted once, not double-subtracted", async () => {
    // atlas is one of the two T3 projects in envelopeFixture. Give it a
    // declared field too, so it is simultaneously parsed AND declared.
    const envelope = {
      ...envelopeFixture,
      run_id: "run-overlap",
      projects: envelopeFixture.projects.map((project) =>
        project.slug === "atlas"
          ? {
              ...project,
              fields: [
                ...project.fields,
                declaredField("next_action", "statement", "Ship the thing"),
                declaredField(
                  "template",
                  "declared_at",
                  "2026-07-01T00:00:00.000Z"
                ),
              ],
            }
          : project
      ),
    };
    await handleIngest(await signed(envelope), env);

    const res = await handlePortfolio(
      new Request("http://example.com/api/portfolio"),
      env
    );
    const body = await res.json();

    expect(body.coverage.parsed.value).toBe(2);
    expect(body.coverage.declared.value).toBe(1);
    expect(body.coverage.total.value).toBe(11);
    // NOT 8: total(11) - parsed(2) - declared(1) = 8 double-subtracts the
    // overlapping project (both T3 and declared). The correct predicate
    // count of projects that are neither is 9.
    expect(body.coverage.gap.value).toBe(9);
  });

  it("every project row carries managed, review_state and declared_at", async () => {
    const declaredSlugs = new Set(["orchard-portal"]);
    const envelope = {
      ...envelopeFixture,
      run_id: "run-axes",
      projects: envelopeFixture.projects.map((project) =>
        declaredSlugs.has(project.slug)
          ? {
              ...project,
              fields: [
                ...project.fields,
                declaredField("next_action", "statement", "Ship the thing"),
                declaredField(
                  "template",
                  "declared_at",
                  "2026-07-01T00:00:00.000Z"
                ),
              ],
            }
          : project
      ),
    };
    await handleIngest(await signed(envelope), env);

    const res = await handlePortfolio(
      new Request("http://example.com/api/portfolio"),
      env
    );
    const body = await res.json();

    const declared = body.projects.find((p) => p.slug === "orchard-portal");
    expect(declared.managed.value).toBe("declared");
    expect(declared.review_state.value).toBe("ok");
    expect(declared.declared_at.value).toBe("2026-07-01T00:00:00.000Z");

    const undeclared = body.projects.find((p) => p.slug === "atlas");
    expect(undeclared.managed.value).toBe("discovered");
    expect(undeclared.declared_at.value).toBeNull();
    expect(undeclared.declared_at.confidence).toBe("unknown");
  });

  it("needs_review on one project does not affect global health", async () => {
    const envelope = {
      ...envelopeFixture,
      run_id: "run-needs-review",
      projects: envelopeFixture.projects.map((project) =>
        project.slug === "atlas"
          ? {
              ...project,
              fields: [
                ...project.fields,
                declaredField("template", "review_state", "needs_review"),
              ],
            }
          : project
      ),
    };
    await handleIngest(await signed(envelope), env);

    const portfolioRes = await handlePortfolio(
      new Request("http://example.com/api/portfolio"),
      env
    );
    const portfolio = await portfolioRes.json();
    const atlas = portfolio.projects.find((p) => p.slug === "atlas");
    expect(atlas.review_state.value).toBe("needs_review");

    const healthRes = await handleHealth(
      new Request("http://example.com/api/health"),
      env
    );
    const health = await healthRes.json();
    expect(health.state).toBe("ok");
  });

  it("sorts stalest first", async () => {
    await handleIngest(await signed(envelopeFixture), env);

    const res = await handlePortfolio(
      new Request("http://example.com/api/portfolio"),
      env
    );
    const body = await res.json();

    // Nulls first, alphabetical among nulls: field-notes, harbor,
    // project-g — then ascending by date.
    const expectedOrder = [
      "field-notes",
      "harbor",
      "project-g",
      "project-i",
      "project-h",
      "project-f",
      "status-board",
      "orchard-portal",
      "kestrel",
      "orchard",
      "atlas",
    ];
    expect(body.projects.map((p) => p.slug)).toEqual(expectedOrder);
    expect(body.projects[0].last_activity.value).toBeNull();
  });

  it("renders a project with no snapshot as unknown", async () => {
    await handleIngest(await signed(envelopeFixture), env);

    // Not reachable through the real ingest path (a project row and its
    // first snapshot are always written in the same batch) — this is the
    // one deliberate direct-insert seed, constructing a state ingest itself
    // cannot produce: a registered project that has never been pushed.
    await env.DB.prepare(
      "INSERT INTO projects (tenant_id, slug, name, tier) VALUES ('local', 'orphan-project', 'Orphan Project', 'T0')"
    ).run();

    const res = await handlePortfolio(
      new Request("http://example.com/api/portfolio"),
      env
    );
    const body = await res.json();

    const orphan = body.projects.find((p) => p.slug === "orphan-project");
    expect(orphan).toBeDefined();
    expect(orphan.name.value).toBe("Orphan Project");
    expect(orphan.name.confidence).toBe("declared");
    expect(orphan.tier.value).toBe("T0");
    expect(orphan.provenance.value).toBeNull();
    expect(orphan.provenance.confidence).toBe("unknown");
    expect(orphan.last_activity.value).toBeNull();
    expect(orphan.last_activity.confidence).toBe("unknown");
  });

  it("empty database returns an empty portfolio, not an error", async () => {
    const res = await handlePortfolio(
      new Request("http://example.com/api/portfolio"),
      env
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.projects).toEqual([]);
    expect(body.coverage.parsed.value).toBe(0);
    expect(body.coverage.declared.value).toBe(0);
    expect(body.coverage.total.value).toBe(0);
    expect(body.coverage.gap.value).toBe(0);
  });
});

describe("collectorState (pure)", () => {
  it("resolves no_run, failed and ok from raw collector_runs rows", () => {
    expect(collectorState(null)).toBe("no_run");
    expect(collectorState({ ok: 0 })).toBe("failed");
    expect(collectorState({ ok: 1 })).toBe("ok");
  });
});

describe("GET /api/health", () => {
  it("health reports no_run before any collector run", async () => {
    const res = await handleHealth(
      new Request("http://example.com/api/health"),
      env
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.state).toBe("no_run");
    expect(body.last_run_at).toBeNull();
    expect(body.age_seconds).toBeNull();
  });

  it("health reports failed after a failure envelope", async () => {
    const failedEnvelope = {
      ...envelopeFixture,
      run_id: "run-failed",
      ok: false,
      projects: [],
      errors: [{ slug: "atlas", error: "parser crashed" }],
    };
    await handleIngest(await signed(failedEnvelope), env);

    const res = await handleHealth(
      new Request("http://example.com/api/health"),
      env
    );
    const body = await res.json();

    expect(body.state).toBe("failed");
    expect(body.errors_count).toBeGreaterThan(0);
  });

  it("health reports ok after a successful run", async () => {
    await handleIngest(await signed(envelopeFixture), env);

    const res = await handleHealth(
      new Request("http://example.com/api/health"),
      env
    );
    const body = await res.json();

    expect(body.state).toBe("ok");
    expect(body.last_run_at).not.toBeNull();
    expect(body.age_seconds).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.age_seconds)).toBe(true);
  });

  it("rejects a wrong method on a known path", async () => {
    // /api/health is behind the view gate, so its method check is only
    // reachable with a session cookie — an anonymous POST is turned away by
    // the gate first (covered in tests/view-gate.test.js). /v1/ingest is
    // deliberately open, so its 405 needs no cookie.
    const token = await issueSessionToken(
      env.ATLAS_VIEW_PASSWORD,
      Math.floor(Date.now() / 1000)
    );
    const res = await worker.fetch(
      new Request("http://example.com/api/health", {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env
    );
    expect(res.status).toBe(405);

    const res2 = await worker.fetch(
      new Request("http://example.com/v1/ingest", { method: "GET" }),
      env
    );
    expect(res2.status).toBe(405);
  });
});

/**
 * Recursively walks a JSON-shaped value. Any plain object carrying a
 * `value` key must also carry non-empty `confidence`, `source` and `as_of`
 * keys. Asserts on the walk itself, not a hand-listed set of paths, so a
 * field added later cannot slip through untagged.
 */
function collectProvenanceViolations(node, path, violations) {
  if (node === null || typeof node !== "object") return;

  if (!Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, "value")) {
    for (const key of ["confidence", "source", "as_of"]) {
      const present = Object.prototype.hasOwnProperty.call(node, key);
      if (!present || node[key] === null || node[key] === "") {
        violations.push(`${path}.${key}`);
      }
    }
  }

  for (const [childKey, childValue] of Object.entries(node)) {
    collectProvenanceViolations(childValue, `${path}.${childKey}`, violations);
  }
}

describe("Read-API contract", () => {
  it("every field has confidence/source/as_of", async () => {
    await handleIngest(await signed(envelopeFixture), env);

    const res = await handlePortfolio(
      new Request("http://example.com/api/portfolio"),
      env
    );
    const body = await res.json();

    const violations = [];
    collectProvenanceViolations(body, "$", violations);
    expect(violations).toEqual([]);
  });

  it("coverage as_of matches collector health", async () => {
    await handleIngest(await signed(envelopeFixture), env);

    const portfolioRes = await handlePortfolio(
      new Request("http://example.com/api/portfolio"),
      env
    );
    const healthRes = await handleHealth(
      new Request("http://example.com/api/health"),
      env
    );
    const portfolio = await portfolioRes.json();
    const health = await healthRes.json();

    expect(portfolio.coverage.parsed.as_of).toBe(health.last_run_at);
    expect(portfolio.coverage.declared.as_of).toBe(health.last_run_at);
    expect(portfolio.coverage.gap.as_of).toBe(health.last_run_at);
    expect(portfolio.coverage.parsed.as_of).toBe(
      portfolio.coverage.total.as_of
    );
  });

  // T-2-08: the response must carry no filesystem path. managed,
  // review_state and declared_at are a status enum, a status enum and a
  // timestamp — none of them should ever be able to leak an absolute local
  // path like /home/dev/projects/orchard.
  it("no response value is or contains an absolute filesystem path", async () => {
    const envelope = {
      ...envelopeFixture,
      run_id: "run-path-check",
      projects: envelopeFixture.projects.map((project) =>
        project.slug === "orchard-portal"
          ? {
              ...project,
              fields: [
                ...project.fields,
                declaredField("next_action", "statement", "Ship the thing"),
                declaredField(
                  "template",
                  "declared_at",
                  "2026-07-01T00:00:00.000Z"
                ),
              ],
            }
          : project
      ),
    };
    await handleIngest(await signed(envelope), env);

    const res = await handlePortfolio(
      new Request("http://example.com/api/portfolio"),
      env
    );
    const body = await res.json();

    const violations = [];
    (function walk(node, path) {
      if (node === null || node === undefined) return;
      if (typeof node === "string") {
        if (/^\//.test(node) || /\/(Users|home)\//.test(node)) {
          violations.push(`${path}: ${node}`);
        }
        return;
      }
      if (typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        walk(value, `${path}.${key}`);
      }
    })(body, "$");

    expect(violations).toEqual([]);
  });
});
