-- migrations/0002_declare.sql
-- Adds projects.review_state. `managed` is NOT added here — it already
-- exists in migrations/0001_init.sql and this migration is its first *use*,
-- not its introduction. That sentence exists to stop a future reader filing
-- the absent `managed` DDL as an omission.

ALTER TABLE projects ADD COLUMN review_state TEXT NOT NULL DEFAULT 'ok';
-- ok|needs_review, per-project template review state. NOT the collector
-- health state in src/health.js, which keeps its own three values.
