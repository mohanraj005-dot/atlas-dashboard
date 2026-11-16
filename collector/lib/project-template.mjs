// collector/lib/project-template.mjs
// Parses and validates .atlas/project.yml against the immutable, version-pinned
// template definitions in collector/templates/*.json. Zero dependencies (no js-yaml,
// no ajv, no zod) — mirrors collector/lib/registry.mjs's hard-throw,
// never-a-silent-fallback posture verbatim: readFileSync -> try/catch ->
// JSON.parse -> try/catch -> structural validation -> one named Error per
// violation. A malformed or hostile project.yml must fail loudly, not degrade
// silently into a confidently wrong dashboard card.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_SECTIONS = ["identity", "profile", "next_action"];
export const AUTO_DERIVED_SECTIONS = new Set([
  "coverage",
  "freshness",
  "phase_progress",
  "recent_activity",
]);
export const OPTIONAL_CANONICAL = new Set([
  "health",
  "blockers",
  "risks",
  "decisions",
  "open_questions",
  "links",
]);
export const PROFILES = ["code-project", "ops-workstream", "business", "research"];
export const NO_DATA_COPY = "— no data (optional section, not declared)";

export const MAX_PROJECT_YML_BYTES = 65536;
export const MAX_DEPTH = 4;
export const MAX_ARRAY_ITEMS = 100;
export const MAX_STRING_BYTES = 4096;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");

/**
 * Loads and JSON.parses the immutable template definition for `version`
 * (defaulting to the current template version). Hard-throws — a missing or
 * malformed template file is a repo defect, never something to fall back on.
 *
 * `version` is a semver string (e.g. "1.0.0"); the definition file on disk is
 * named after the major version only (collector/templates/v1.json), matching
 * the fixed "v1.json" artifact path — a template bump within the same major
 * version never ships a new file.
 */
export function loadTemplateDef(version = "1.0.0") {
  const major = String(version).split(".")[0];
  const path = join(TEMPLATES_DIR, `v${major}.json`);

  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`loadTemplateDef: unknown template version "${version}": ${err.message}`);
  }

  let def;
  try {
    def = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `loadTemplateDef: "${path}" is not valid JSON — template definitions must be plain JSON. Parse error: ${err.message}`
    );
  }

  return def;
}

/**
 * Recursively walks `value`, enforcing the shape/size guards that must hold
 * everywhere in the document (not just at the top level): forbidden keys,
 * the "as_of" ban, max nesting depth, max array items, and max string
 * length. Single walk, single source of truth for every structural rule that
 * isn't section-specific.
 */
function walkNode(value, depth, label, keyName) {
  if (depth > MAX_DEPTH) {
    throw new Error(`parseProjectYml: "${label}" is too deeply nested (limit ${MAX_DEPTH})`);
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      throw new Error(
        `parseProjectYml: "${label}" has too many items in "${keyName}" (limit ${MAX_ARRAY_ITEMS})`
      );
    }
    for (const item of value) {
      walkNode(item, depth + 1, label, keyName);
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new Error(`parseProjectYml: "${label}" contains forbidden key "${key}"`);
      }
      if (key === "as_of") {
        throw new Error(
          `parseProjectYml: "${label}" declares "as_of" — always derived from the file's last commit or mtime, never typed`
        );
      }
      walkNode(value[key], depth + 1, label, key);
    }
    return;
  }

  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) {
      throw new Error(
        `parseProjectYml: "${label}" has a value too long at "${keyName}" (limit ${MAX_STRING_BYTES} bytes)`
      );
    }
  }
}

/**
 * The single validation entry point for a raw project.yml string. Hard-throws
 * on every rule violation with a named Error — never a silent fallback.
 *
 * `label` is the path or identifier used in error messages (so both
 * loadProjectYml and direct-string callers, e.g. tests, get an error that
 * names the offending source).
 */
export function parseProjectYml(raw, label) {
  if (Buffer.byteLength(raw, "utf8") > MAX_PROJECT_YML_BYTES) {
    throw new Error(
      `parseProjectYml: "${label}" is too large (${Buffer.byteLength(raw, "utf8")} bytes, limit ${MAX_PROJECT_YML_BYTES})`
    );
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `parseProjectYml: "${label}" is not valid JSON-subset YAML — project.yml must contain plain JSON. Parse error: ${err.message}`
    );
  }

  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`parseProjectYml: "${label}" must be a JSON object at the top level`);
  }

  // Single recursive walk: forbidden keys, "as_of" ban, depth/array/string
  // size guards. Never spread or Object.assign the parsed document into
  // another object anywhere downstream — that is what makes a "__proto__"
  // key dangerous in the first place; use hasOwnProperty/Object.keys only.
  walkNode(doc, 0, label, null);

  for (const key of sectionKeysIn(doc)) {
    if (AUTO_DERIVED_SECTIONS.has(key)) {
      throw new Error(
        `parseProjectYml: "${label}" declares "${key}" — auto-derived from git/collector data and cannot be hand-typed. Remove it.`
      );
    }
  }

  for (const name of REQUIRED_SECTIONS) {
    if (
      !Object.prototype.hasOwnProperty.call(doc, name) ||
      doc[name] === null ||
      doc[name] === undefined
    ) {
      throw new Error(`parseProjectYml: "${label}" is missing required section "${name}"`);
    }
  }

  if (typeof doc.identity !== "object" || doc.identity === null || Array.isArray(doc.identity)) {
    throw new Error(`parseProjectYml: "${label}" has an invalid "identity" section`);
  }
  if (typeof doc.identity.name !== "string" || doc.identity.name.length === 0) {
    throw new Error(`parseProjectYml: "${label}" is missing a non-empty "identity.name"`);
  }
  if (typeof doc.identity.statement !== "string" || doc.identity.statement.length === 0) {
    throw new Error(`parseProjectYml: "${label}" is missing a non-empty "identity.statement"`);
  }
  if (typeof doc.next_action !== "string" || doc.next_action.length === 0) {
    throw new Error(`parseProjectYml: "${label}" is missing a non-empty "next_action"`);
  }

  if (!PROFILES.includes(doc.profile)) {
    throw new Error(
      `parseProjectYml: "${label}" has unknown profile "${doc.profile}" — must be one of ${PROFILES.join(", ")}`
    );
  }

  // Any other top-level key is accepted without complaint. Do not add an
  // unknown-key rejection here — the auto-derived list above is the only
  // reject-list. This single omission is what lets a bespoke
  // section work without forking the template.

  return doc;
}

/**
 * Reads `path` and delegates to parseProjectYml, so both call sites (CLI init
 * and the collector's declared-field adapter) share exactly one rule set.
 */
export function loadProjectYml(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`loadProjectYml: could not read "${path}": ${err.message}`);
  }
  return parseProjectYml(raw, path);
}

/** Every top-level key of `doc` except the "_format" pseudo-comment field. */
export function sectionKeysIn(doc) {
  return Object.keys(doc).filter((k) => k !== "_format");
}

/**
 * A structural fingerprint of which sections exist in `doc`, not a content
 * hash — a content hash would flag every routine edit as drift, which is not
 * the signal template.lock's merge algorithm needs.
 */
export function sectionsHash(doc) {
  const sorted = sectionKeysIn(doc).sort();
  return `sha256:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex")}`;
}
