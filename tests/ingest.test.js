// tests/ingest.test.js
// Integration coverage for POST /v1/ingest — auth, signature, failure
// envelopes, dedup, and tenant isolation. Runs against the real workerd
// runtime with migrations pre-applied by tests/apply-migrations.js.
import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect } from "vitest";
import { handleIngest } from "../src/ingest.js";
import { sha256Hex } from "../src/lib/hash.js";
import fixture from "./fixtures/envelope.sample.json";

const MAX_INGEST_BYTES = 1_000_000;
const GENERATED_AT = "2026-08-09T06:00:00Z";

/**
 * Builds a single declared field, matching the shape the declared
 * adapter will emit: confidence and source are both "declared".
 */
function declaredField(section, key, value) {
  return {
    section,
    key,
    value,
    confidence: "declared",
    source: "declared",
    as_of: GENERATED_AT,
  };
}

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
 * env.ATLAS_INGEST_HMAC_SECRET (the fixed test binding from vitest.config.js)
 * so every other test in this file sends a correctly signed request unless
 * it opts out.
 */
async function signed(bodyObj, opts = {}) {
  const {
    secret = env.ATLAS_INGEST_HMAC_SECRET,
    token = "test-token",
    omitSignature = false,
    contentLengthOverride,
  } = opts;

  const body = JSON.stringify(bodyObj);
  const headers = { "Content-Type": "application/json" };

  headers["Content-Length"] =
    contentLengthOverride ?? String(new TextEncoder().encode(body).length);

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
  const revokedHash = await sha256Hex("revoked-token");
  const wrongScopeHash = await sha256Hex("wrong-scope-token");
  const otherTenantHash = await sha256Hex("other-tenant-token");

  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (tenant_id, name) VALUES ('other', 'Other Tenant')"
    ),
    env.DB.prepare(
      "INSERT INTO ingest_tokens (token_hash, tenant_id, scope) VALUES (?, 'local', 'ingest:write')"
    ).bind(activeHash),
    env.DB.prepare(
      "INSERT INTO ingest_tokens (token_hash, tenant_id, scope, revoked_at) VALUES (?, 'local', 'ingest:write', datetime('now'))"
    ).bind(revokedHash),
    env.DB.prepare(
      "INSERT INTO ingest_tokens (token_hash, tenant_id, scope) VALUES (?, 'local', 'read:only')"
    ).bind(wrongScopeHash),
    env.DB.prepare(
      "INSERT INTO ingest_tokens (token_hash, tenant_id, scope) VALUES (?, 'other', 'ingest:write')"
    ).bind(otherTenantHash),
  ]);
});

describe("POST /v1/ingest — auth and rejection paths", () => {
  it("rejects a missing token", async () => {
    const req = await signed(fixture, { token: null });
    const res = await handleIngest(req, env);
    expect(res.status).toBe(401);
  });

  it("rejects an unknown token", async () => {
    const req = await signed(fixture, { token: "not-a-real-token" });
    const res = await handleIngest(req, env);
    expect(res.status).toBe(401);
  });

  it("rejects a revoked token", async () => {
    const req = await signed(fixture, { token: "revoked-token" });
    const res = await handleIngest(req, env);
    expect(res.status).toBe(401);
  });

  it("rejects a token without ingest:write scope", async () => {
    const req = await signed(fixture, { token: "wrong-scope-token" });
    const res = await handleIngest(req, env);
    expect(res.status).toBe(403);
  });

  it("rejects an unsupported schema_version", async () => {
    const req = await signed({ ...fixture, schema_version: 2 });
    const res = await handleIngest(req, env);
    expect(res.status).toBe(400);
  });

  it("rejects an oversized payload before parsing", async () => {
    const req = await signed(fixture, {
      contentLengthOverride: String(MAX_INGEST_BYTES + 1),
    });
    const res = await handleIngest(req, env);
    expect(res.status).toBe(413);

    const row = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM collector_runs"
    ).first();
    expect(row.n).toBe(0);
  });

  it("refuses a cross-tenant envelope", async () => {
    const req = await signed({ ...fixture, tenant_id: "other" });
    const res = await handleIngest(req, env);
    expect(res.status).toBe(403);

    const row = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM collector_runs"
    ).first();
    expect(row.n).toBe(0);
  });

  it("accepts a correctly signed envelope", async () => {
    const req = await signed(fixture);
    const res = await handleIngest(req, env);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.run_id).toBe(fixture.run_id);
  });

  it("rejects a tampered body", async () => {
    const body = JSON.stringify(fixture);
    const signature = `sha256=${await hmacHex(
      body,
      env.ATLAS_INGEST_HMAC_SECRET
    )}`;
    const tamperedBody = JSON.stringify({ ...fixture, ok: false });
    const req = new Request("http://example.com/v1/ingest", {
      method: "POST",
      body: tamperedBody,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(
          new TextEncoder().encode(tamperedBody).length
        ),
        Authorization: "Bearer test-token",
        "X-Atlas-Signature": signature,
      },
    });
    const res = await handleIngest(req, env);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("invalid signature");
  });

  it("rejects a missing signature header", async () => {
    const req = await signed(fixture, { omitSignature: true });
    const res = await handleIngest(req, env);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("invalid signature");
  });

  it("rejects a signature from a different secret", async () => {
    const req = await signed(fixture, {
      secret: "a-completely-different-secret",
    });
    const res = await handleIngest(req, env);
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/ingest — write path: failure envelopes, dedup, provenance", () => {
  it("failed run still inserts collector_runs", async () => {
    const failedEnvelope = {
      ...fixture,
      run_id: "failed-run-id",
      ok: false,
      projects: [],
      errors: [{ slug: "atlas", error: "parser crashed" }],
    };
    const req = await signed(failedEnvelope);
    const res = await handleIngest(req, env);
    expect(res.status).toBe(200);

    const runs = await env.DB.prepare(
      "SELECT * FROM collector_runs WHERE run_id = ?"
    )
      .bind("failed-run-id")
      .all();
    expect(runs.results.length).toBe(1);
    expect(runs.results[0].ok).toBe(0);
    expect(JSON.parse(runs.results[0].errors_json).length).toBe(1);

    const snaps = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM snapshots"
    ).first();
    expect(snaps.n).toBe(0);
  });

  it("stores every field with confidence, source and as_of", async () => {
    const req = await signed(fixture);
    const res = await handleIngest(req, env);
    expect(res.status).toBe(200);

    const totalFieldsInFixture = fixture.projects.reduce(
      (sum, p) => sum + p.fields.length,
      0
    );
    const rows = await env.DB.prepare(
      "SELECT confidence, source, as_of FROM fields"
    ).all();
    expect(rows.results.length).toBe(totalFieldsInFixture);
    for (const row of rows.results) {
      expect(row.confidence).toBeTruthy();
      expect(row.source).toBeTruthy();
      expect(row.as_of).toBeTruthy();
    }
  });

  it("deduplicates an unchanged push", async () => {
    const first = {
      ...fixture,
      run_id: "run-a",
      generated_at: "2026-08-09T06:00:00Z",
    };
    const second = {
      ...fixture,
      run_id: "run-b",
      generated_at: "2026-08-09T06:30:00Z",
    };

    await handleIngest(await signed(first), env);
    await handleIngest(await signed(second), env);

    const runs = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM collector_runs"
    ).first();
    expect(runs.n).toBe(2);

    for (const project of fixture.projects) {
      const snaps = await env.DB.prepare(
        "SELECT COUNT(*) as n FROM snapshots WHERE slug = ?"
      )
        .bind(project.slug)
        .first();
      expect(snaps.n).toBe(1);
    }
  });

  it("treats reordered fields as unchanged", async () => {
    await handleIngest(await signed({ ...fixture, run_id: "run-a" }), env);

    const shuffled = {
      ...fixture,
      run_id: "run-b",
      projects: fixture.projects.map((p) => ({
        ...p,
        fields: [...p.fields].reverse(),
      })),
    };
    await handleIngest(await signed(shuffled), env);

    for (const project of fixture.projects) {
      const snaps = await env.DB.prepare(
        "SELECT COUNT(*) as n FROM snapshots WHERE slug = ?"
      )
        .bind(project.slug)
        .first();
      expect(snaps.n).toBe(1);
    }
  });

  it("writes a new snapshot when a value actually changes", async () => {
    await handleIngest(await signed({ ...fixture, run_id: "run-a" }), env);

    const changed = {
      ...fixture,
      run_id: "run-b",
      projects: fixture.projects.map((p, i) =>
        i === 0
          ? {
              ...p,
              fields: p.fields.map((f) =>
                f.section === "freshness" && f.key === "last_activity"
                  ? { ...f, value: "2026-08-09T12:00:00-07:00" }
                  : f
              ),
            }
          : p
      ),
    };
    await handleIngest(await signed(changed), env);

    const changedSlug = fixture.projects[0].slug;
    const changedSnaps = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM snapshots WHERE slug = ?"
    )
      .bind(changedSlug)
      .first();
    expect(changedSnaps.n).toBe(2);

    for (const project of fixture.projects.slice(1)) {
      const snaps = await env.DB.prepare(
        "SELECT COUNT(*) as n FROM snapshots WHERE slug = ?"
      )
        .bind(project.slug)
        .first();
      expect(snaps.n).toBe(1);
    }
  });

  it("rejects a field missing its provenance", async () => {
    const broken = {
      ...fixture,
      projects: fixture.projects.map((p, i) =>
        i === 0
          ? {
              ...p,
              fields: p.fields.map((f, j) => {
                if (j !== 0) return f;
                const { source, ...rest } = f;
                return rest;
              }),
            }
          : p
      ),
    };
    const req = await signed(broken);
    const res = await handleIngest(req, env);
    expect(res.status).toBe(400);

    const runs = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM collector_runs"
    ).first();
    expect(runs.n).toBe(0);
  });
});

describe("declared fields", () => {
  it("marks a project declared when any field has source 'declared'", async () => {
    const envelope = {
      ...fixture,
      run_id: "declare-managed-true",
      projects: [
        {
          ...fixture.projects[0],
          fields: [
            ...fixture.projects[0].fields,
            declaredField("next_action", "statement", "Ship the thing"),
          ],
        },
      ],
    };
    const req = await signed(envelope);
    const res = await handleIngest(req, env);
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT managed FROM projects WHERE tenant_id = ? AND slug = ?"
    )
      .bind("local", fixture.projects[0].slug)
      .first();
    expect(row.managed).toBe("declared");
  });

  it("marks a project discovered when no field carries source 'declared'", async () => {
    const req = await signed({ ...fixture, run_id: "declare-managed-false" });
    const res = await handleIngest(req, env);
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT managed FROM projects WHERE tenant_id = ? AND slug = ?"
    )
      .bind("local", fixture.projects[0].slug)
      .first();
    expect(row.managed).toBe("discovered");
  });

  it("re-derives managed back to discovered when a later push carries no declared field", async () => {
    const declaredEnvelope = {
      ...fixture,
      run_id: "declare-latch-1",
      projects: [
        {
          ...fixture.projects[0],
          fields: [
            ...fixture.projects[0].fields,
            declaredField("next_action", "statement", "Ship it"),
          ],
        },
      ],
    };
    await handleIngest(await signed(declaredEnvelope), env);

    let row = await env.DB.prepare(
      "SELECT managed FROM projects WHERE tenant_id = ? AND slug = ?"
    )
      .bind("local", fixture.projects[0].slug)
      .first();
    expect(row.managed).toBe("declared");

    const discoveredEnvelope = {
      ...fixture,
      run_id: "declare-latch-2",
      generated_at: "2026-08-09T07:00:00Z",
      projects: [fixture.projects[0]],
    };
    await handleIngest(await signed(discoveredEnvelope), env);

    row = await env.DB.prepare(
      "SELECT managed FROM projects WHERE tenant_id = ? AND slug = ?"
    )
      .bind("local", fixture.projects[0].slug)
      .first();
    expect(row.managed).toBe("discovered");
  });

  it("ignores a client-sent project.managed value", async () => {
    const envelope = {
      ...fixture,
      run_id: "declare-client-ignored",
      projects: [{ ...fixture.projects[0], managed: "declared" }],
    };
    const req = await signed(envelope);
    const res = await handleIngest(req, env);
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT managed FROM projects WHERE tenant_id = ? AND slug = ?"
    )
      .bind("local", fixture.projects[0].slug)
      .first();
    expect(row.managed).toBe("discovered");
  });

  it("marks review_state needs_review from a declared template field", async () => {
    const envelope = {
      ...fixture,
      run_id: "declare-review-needs",
      projects: [
        {
          ...fixture.projects[0],
          fields: [
            ...fixture.projects[0].fields,
            declaredField("template", "review_state", "needs_review"),
          ],
        },
      ],
    };
    const req = await signed(envelope);
    const res = await handleIngest(req, env);
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT review_state FROM projects WHERE tenant_id = ? AND slug = ?"
    )
      .bind("local", fixture.projects[0].slug)
      .first();
    expect(row.review_state).toBe("needs_review");
  });

  it("treats an explicit review_state of 'ok' as ok and still returns 200", async () => {
    const envelope = {
      ...fixture,
      run_id: "declare-review-ok-explicit",
      projects: [
        {
          ...fixture.projects[0],
          fields: [
            ...fixture.projects[0].fields,
            declaredField("template", "review_state", "ok"),
          ],
        },
      ],
    };
    const req = await signed(envelope);
    const res = await handleIngest(req, env);
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT review_state FROM projects WHERE tenant_id = ? AND slug = ?"
    )
      .bind("local", fixture.projects[0].slug)
      .first();
    expect(row.review_state).toBe("ok");
  });

  it("treats an absent review_state field as ok and still returns 200", async () => {
    const req = await signed({ ...fixture, run_id: "declare-review-ok-absent" });
    const res = await handleIngest(req, env);
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT review_state FROM projects WHERE tenant_id = ? AND slug = ?"
    )
      .bind("local", fixture.projects[0].slug)
      .first();
    expect(row.review_state).toBe("ok");
  });

  it("treats an out-of-enum review_state value as ok and still returns 200", async () => {
    const envelope = {
      ...fixture,
      run_id: "declare-review-ok-bogus",
      projects: [
        {
          ...fixture.projects[0],
          fields: [
            ...fixture.projects[0].fields,
            declaredField("template", "review_state", "totally-not-a-value"),
          ],
        },
      ],
    };
    const req = await signed(envelope);
    const res = await handleIngest(req, env);
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT review_state FROM projects WHERE tenant_id = ? AND slug = ?"
    )
      .bind("local", fixture.projects[0].slug)
      .first();
    expect(row.review_state).toBe("ok");
  });

  it("rejects an auto-derived section declared by the client, with zero rows written", async () => {
    const envelope = {
      ...fixture,
      run_id: "declare-auto-derived-reject",
      projects: [
        {
          ...fixture.projects[0],
          fields: [
            ...fixture.projects[0].fields,
            {
              section: "coverage",
              key: "value",
              value: 100,
              confidence: "declared",
              source: "declared",
              as_of: GENERATED_AT,
            },
          ],
        },
      ],
    };
    const req = await signed(envelope);
    const res = await handleIngest(req, env);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/coverage/);

    const row = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM collector_runs"
    ).first();
    expect(row.n).toBe(0);
  });

  it("does not reject freshness/last_activity sourced from git or registry", async () => {
    // Guards the AUTO_DERIVED_SECTIONS branch against rejecting the legitimate
    // collector-emitted freshness field, which is never source "declared".
    const req = await signed({ ...fixture, run_id: "declare-freshness-ok" });
    const res = await handleIngest(req, env);
    expect(res.status).toBe(200);
  });

  it("stores declared section content retrievable from fields", async () => {
    const statement = "Ship the migration by Friday";
    const envelope = {
      ...fixture,
      run_id: "declare-content-stored",
      projects: [
        {
          ...fixture.projects[0],
          fields: [
            ...fixture.projects[0].fields,
            declaredField("next_action", "statement", statement),
          ],
        },
      ],
    };
    const req = await signed(envelope);
    const res = await handleIngest(req, env);
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT value_json FROM fields WHERE slug = ? AND section = 'next_action'"
    )
      .bind(fixture.projects[0].slug)
      .first();
    expect(JSON.parse(row.value_json)).toBe(statement);
  });

  it("rejects a declared field missing as_of, unchanged from existing behavior", async () => {
    const envelope = {
      ...fixture,
      run_id: "declare-missing-as-of",
      projects: [
        {
          ...fixture.projects[0],
          fields: [
            ...fixture.projects[0].fields,
            {
              section: "next_action",
              key: "statement",
              value: "x",
              confidence: "declared",
              source: "declared",
            },
          ],
        },
      ],
    };
    const req = await signed(envelope);
    const res = await handleIngest(req, env);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("field missing provenance");
  });
});
