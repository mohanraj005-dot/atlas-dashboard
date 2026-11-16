-- migrations/0001_init.sql

CREATE TABLE tenants (
  tenant_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ingest_tokens (
  token_hash  TEXT PRIMARY KEY,          -- sha256 hex of the raw bearer token
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  scope       TEXT NOT NULL DEFAULT 'ingest:write',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at  TEXT
);
CREATE INDEX idx_ingest_tokens_tenant ON ingest_tokens(tenant_id, token_hash);

CREATE TABLE projects (
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  slug           TEXT NOT NULL,           -- stable id, from registry.yml
  name           TEXT NOT NULL,
  tier           TEXT NOT NULL DEFAULT 'T0',   -- T0|T1|T2|T3, recomputed by collector each run
  managed        TEXT NOT NULL DEFAULT 'discovered', -- discovered|declared
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, slug)
);
CREATE INDEX idx_projects_tenant_tier ON projects(tenant_id, tier);

CREATE TABLE snapshots (
  tenant_id          TEXT NOT NULL,
  slug               TEXT NOT NULL,
  snapshot_id        TEXT NOT NULL,       -- uuid, collector-generated
  as_of              TEXT NOT NULL,       -- envelope.generated_at
  content_hash       TEXT NOT NULL,       -- sha256 of normalized per-project payload; dedup key
  collector_version  TEXT NOT NULL,
  planner_version    TEXT,
  parser_status      TEXT NOT NULL DEFAULT 'ok',  -- ok|parser_degraded|error
  PRIMARY KEY (tenant_id, slug, snapshot_id),
  FOREIGN KEY (tenant_id, slug) REFERENCES projects(tenant_id, slug)
);
CREATE INDEX idx_snapshots_tenant_slug_asof ON snapshots(tenant_id, slug, as_of DESC);
CREATE UNIQUE INDEX idx_snapshots_dedup ON snapshots(tenant_id, slug, content_hash);

CREATE TABLE fields (
  tenant_id     TEXT NOT NULL,
  slug          TEXT NOT NULL,
  snapshot_id   TEXT NOT NULL,
  section       TEXT NOT NULL,            -- 'identity' | 'freshness' | 'health' | 'coverage' | ...
  key           TEXT NOT NULL,            -- 'last_activity' | 'tier' | 'collector_status' | ...
  value_json    TEXT NOT NULL,            -- JSON-encoded scalar or small object
  confidence    TEXT NOT NULL,            -- verified|derived|inferred|declared|unknown
  source        TEXT NOT NULL,            -- 'git'|'registry'|'planning-tools'|'declared'|'collector'
  as_of         TEXT NOT NULL,
  PRIMARY KEY (tenant_id, slug, snapshot_id, section, key),
  FOREIGN KEY (tenant_id, slug, snapshot_id) REFERENCES snapshots(tenant_id, slug, snapshot_id)
);
CREATE INDEX idx_fields_tenant_slug_section ON fields(tenant_id, slug, section, key);
CREATE INDEX idx_fields_tenant_confidence   ON fields(tenant_id, confidence);
CREATE INDEX idx_fields_tenant_asof         ON fields(tenant_id, as_of);

CREATE TABLE collector_runs (
  tenant_id      TEXT NOT NULL,
  run_id         TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  ok             INTEGER NOT NULL,        -- 0/1 — did the run complete without a fatal error
  projects_seen  INTEGER NOT NULL DEFAULT 0,
  errors_json    TEXT,                    -- [{slug, error}], partial per-project failures
  PRIMARY KEY (tenant_id, run_id)
);
CREATE INDEX idx_collector_runs_tenant_started ON collector_runs(tenant_id, started_at DESC);

INSERT INTO tenants (tenant_id, name) VALUES ('local', 'Demo');
