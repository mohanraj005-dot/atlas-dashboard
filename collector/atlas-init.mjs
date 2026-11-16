#!/usr/bin/env node
// collector/atlas-init.mjs
// The CLI the dashboard's paste-able `atlas init {slug}` command invokes
// (the dashboard's INSTRUMENT column). Resolves the slug against the
// registry, writes .atlas/project.yml and .atlas/template.lock into the
// project directory, conditionally appends to the deployed registry.yml,
// and runs the three-way merge (collector/lib/lock.mjs) on re-invocation.
// Node built-ins only: no js-yaml, no argv-parsing library — same
// zero-dependency constraint every other collector/ script runs under.
//
// buildInitPlan() is pure and computes no I/O, exactly like install.mjs's
// buildPlan() — --dry-run and the real run share one source of truth about
// what will be written, which is what makes their plans provably
// identical rather than merely similarly-worded.
//
// .atlas/project.yml is written exactly once: a re-run only ever
// touches template.lock and, on a breaking template change, UPGRADE-NOTES.md
// — see collector/lib/lock.mjs's mergeTemplate for the merge algorithm this
// CLI applies verbatim.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

import {
  loadTemplateDef,
  parseProjectYml,
  loadProjectYml,
  PROFILES,
} from "./lib/project-template.mjs";
import {
  buildLock,
  mergeTemplate,
  readLock,
  writeLock,
  LOCK_FILENAME,
} from "./lib/lock.mjs";
import {
  loadRegistry,
  readRegistryDoc,
  appendRegistryEntry,
  assertValidSlug,
  DEPLOYED_REGISTRY_PATH,
} from "./lib/registry.mjs";

const USAGE = "usage: atlas init <slug> [--dry-run] [--path <dir>] [--profile <name>] [--accept-major]";
const DEFAULT_PROFILE = "code-project";

/**
 * Hand-rolled argv parser, matching collector/atlas-collect.mjs's own
 * parseArgs convention. Recognises the positional subcommand `init`, one
 * positional slug, and --dry-run / --path <dir> / --profile <name> /
 * --accept-major. Any unrecognised token beginning with "-" throws naming
 * it — a typo'd flag on a command that writes files must never be silently
 * ignored.
 */
export function parseArgs(argv) {
  const positionals = [];
  const result = { dryRun: false, path: null, profile: DEFAULT_PROFILE, acceptMajor: false };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    if (tok === "--accept-major") {
      result.acceptMajor = true;
      continue;
    }
    if (tok === "--path") {
      result.path = argv[++i] ?? null;
      continue;
    }
    if (tok === "--profile") {
      result.profile = argv[++i] ?? null;
      continue;
    }
    if (typeof tok === "string" && tok.startsWith("-")) {
      throw new Error(`atlas init: unrecognised flag "${tok}"`);
    }
    positionals.push(tok);
  }

  result.subcommand = positionals.length > 0 ? positionals[0] : null;
  result.slug = positionals.length > 1 ? positionals[1] : null;
  return result;
}

/**
 * Pure. Renders the exact project.yml text for a freshly-declared project:
 * the _format pseudo-comment (matching collector/registry.yml's convention),
 * the three required sections with placeholder content, then one key per
 * name in templateDef.profiles[profile].optional_defaults — an empty string
 * for "health", an empty array for every other optional canonical section.
 * Asserts its own output parses under parseProjectYml before returning: the
 * generator must never emit a file its own parser rejects.
 */
export function renderProjectYml({ slug, name, profile, templateDef }) {
  const optionalDefaults =
    (templateDef.profiles && templateDef.profiles[profile] && templateDef.profiles[profile].optional_defaults) || [];

  const doc = {
    _format:
      "This file is JSON-subset YAML — YAML 1.2 is a strict superset of JSON, so it parses with plain JSON.parse and needs zero dependencies. Do not add real YAML syntax (anchors, multi-doc, unquoted special scalars) here.",
    identity: {
      name: name || slug,
      statement: "TODO — replace with a one-line statement of what this project is.",
    },
    profile,
    next_action: "TODO — replace with the single next concrete action.",
  };

  for (const key of optionalDefaults) {
    doc[key] = key === "health" ? "" : [];
  }

  const content = JSON.stringify(doc, null, 2) + "\n";
  // Catching a self-rejecting generator here is far cheaper than at the
  // next collector run.
  parseProjectYml(content, "generated");
  return content;
}

/** True when any path segment of `p` is literally "..". */
function hasDotDotSegment(p) {
  return String(p)
    .split(/[\\/]+/)
    .includes("..");
}

/**
 * Pure, no disk access — exactly like install.mjs's buildPlan(). Computes
 * every write atlas init would perform, the conditional registry append,
 * and (on a re-invocation) the merge outcome. Both --dry-run and the real
 * run call this same function with the same inputs, so their plans are
 * identical by construction.
 */
export function buildInitPlan({
  slug,
  projectPath,
  profile,
  templateDef,
  existingDoc,
  existingLock,
  registryDoc,
  registryPath,
  acceptMajor = false,
  detectedAt,
}) {
  const atlasDir = join(projectPath, ".atlas");

  const registryEntry =
    registryDoc && Array.isArray(registryDoc.projects)
      ? registryDoc.projects.find((p) => p.slug === slug) || null
      : null;
  const name =
    (registryEntry && registryEntry.name) ||
    (existingDoc && existingDoc.identity && existingDoc.identity.name) ||
    basename(projectPath);

  const writes = [];
  let mergeOutcome;
  let banner = null;
  let conflicts = [];

  if (!existingDoc) {
    mergeOutcome = "created";
    const projectYmlContent = renderProjectYml({ slug, name, profile, templateDef });
    const lockObj = buildLock({
      templateVersion: templateDef.version,
      profile,
      projectDoc: JSON.parse(projectYmlContent),
    });
    writes.push({ kind: "create", path: join(atlasDir, "project.yml"), content: projectYmlContent });
    writes.push({
      kind: "create",
      path: join(atlasDir, LOCK_FILENAME),
      content: JSON.stringify(lockObj, null, 2) + "\n",
    });
  } else {
    if (!existingLock) {
      throw new Error(
        `buildInitPlan: found "${join(atlasDir, "project.yml")}" without a "${LOCK_FILENAME}" — this project needs re-initialising`
      );
    }
    const baseTemplate = loadTemplateDef(existingLock.template_version);
    const mergeResult = mergeTemplate({
      lock: existingLock,
      projectDoc: existingDoc,
      baseTemplate,
      currentTemplate: templateDef,
      slug,
      detectedAt,
      acceptMajor,
    });
    mergeOutcome = mergeResult.outcome;
    banner = mergeResult.banner;
    conflicts = mergeResult.conflicts;
    for (const w of mergeResult.writes) {
      // mergeTemplate's LOCK_FILENAME write carries a lock OBJECT (so main()
      // can hand it to writeLock's own atomic writer unchanged); every other
      // write (UPGRADE-NOTES.md) already carries a rendered string.
      const content = w.filename === LOCK_FILENAME ? JSON.stringify(w.content, null, 2) + "\n" : w.content;
      writes.push({ kind: "update", path: join(atlasDir, w.filename), content });
    }
  }

  // Path containment guard — the named unconditional refusal idiom
  // install.mjs's assertOutsideWipeZone established, applied here to every
  // write this plan would perform.
  const projectRoot = resolve(projectPath) + sep;
  for (const w of writes) {
    if (!resolve(w.path).startsWith(projectRoot)) {
      throw new Error(`buildInitPlan: refusing to write outside the project directory (${w.path})`);
    }
  }

  const alreadyRegistered = Boolean(
    registryDoc && Array.isArray(registryDoc.projects) && registryDoc.projects.some((p) => p.slug === slug)
  );
  const registryAppend = alreadyRegistered
    ? null
    : { slug, name, path: projectPath, git_scope: "root", skip_git: false };

  return { slug, projectPath, atlasDir, writes, registryAppend, mergeOutcome, banner, conflicts };
}

/**
 * Full orchestration. Returns an exit code and never terminates the
 * process directly — every dependency is injectable for testability,
 * matching atlas-collect.mjs's main() convention. `onPlan` is invoked with the
 * buildInitPlan() result right after it is computed, before the dry-run /
 * apply branch — this is what lets a test assert dry-run and real-run plans
 * are deep-equal without duplicating buildInitPlan's own inputs.
 *
 * Exit codes: 0 success · 1 handled error (malformed existing project.yml,
 * a failed write) · 2 bad CLI usage (unknown subcommand/flag/profile,
 * invalid slug, unresolvable project path) · 3 written but not registered
 * · 4 mergeOutcome is "conflict" or "major" —
 * needs_review is a real outcome the caller should notice.
 */
export function main({
  argv = process.argv.slice(2),
  env = process.env,
  log = console.log,
  errorLog = console.error,
  loadRegistryFn = loadRegistry,
  readRegistryDocFn = readRegistryDoc,
  appendRegistryEntryFn = appendRegistryEntry,
  loadProjectYmlFn = loadProjectYml,
  readLockFn = readLock,
  writeLockFn = writeLock,
  writeFileSyncFn = writeFileSync,
  mkdirSyncFn = mkdirSync,
  existsSyncFn = existsSync,
  templateDef = loadTemplateDef("1.0.0"),
  nowFn = () => new Date(),
  onPlan = () => {},
} = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    errorLog(err.message);
    log(USAGE);
    return 2;
  }

  if (parsed.subcommand !== "init") {
    log(USAGE);
    return 2;
  }

  if (!PROFILES.includes(parsed.profile)) {
    errorLog(`atlas init: unknown profile "${parsed.profile}" — must be one of ${PROFILES.join(", ")}`);
    return 2;
  }

  // The path-traversal guard: assertValidSlug runs before the slug reaches
  // any join() call.
  try {
    assertValidSlug(parsed.slug);
  } catch (err) {
    errorLog(err.message);
    return 2;
  }
  const slug = parsed.slug;

  const registryPath = env.ATLAS_REGISTRY || DEPLOYED_REGISTRY_PATH;

  let registryMissing = false;
  let resolvedRegistry = null;
  let registryDoc = null;
  try {
    resolvedRegistry = loadRegistryFn(registryPath);
    registryDoc = readRegistryDocFn(registryPath);
  } catch {
    // the registry may be unreadable/missing/malformed. The project
    // files are still written; only the append and the exit code reflect
    // this.
    registryMissing = true;
  }

  const registryEntry = resolvedRegistry ? resolvedRegistry.projects.find((p) => p.slug === slug) || null : null;

  let projectPath;
  if (registryEntry) {
    projectPath = registryEntry.path;
  } else if (parsed.path) {
    if (hasDotDotSegment(parsed.path)) {
      errorLog(`atlas init: --path "${parsed.path}" must not contain a ".." segment`);
      return 2;
    }
    const resolvedPath = resolve(parsed.path);
    if (!existsSyncFn(resolvedPath)) {
      errorLog(`atlas init: --path "${parsed.path}" does not exist or is not a directory`);
      return 2;
    }
    projectPath = resolvedPath;
  } else {
    errorLog(`atlas init: slug "${slug}" is not registered — pass --path <dir> to declare it`);
    return 2;
  }

  try {
    const projectYmlPath = join(projectPath, ".atlas", "project.yml");
    let existingDoc = null;
    if (existsSyncFn(projectYmlPath)) {
      // A malformed existing project.yml is a hard failure carrying the
      // parser's own message — this command must never overwrite a file it
      // cannot understand.
      existingDoc = loadProjectYmlFn(projectYmlPath);
    }
    const existingLock = readLockFn(join(projectPath, ".atlas"));

    const plan = buildInitPlan({
      slug,
      projectPath,
      profile: parsed.profile,
      templateDef,
      existingDoc,
      existingLock,
      registryDoc,
      registryPath,
      acceptMajor: parsed.acceptMajor,
      detectedAt: nowFn().toISOString(),
    });
    onPlan(plan);

    for (const w of plan.writes) {
      log(`${w.kind} ${w.path}`);
      log(`--- ${w.path} ---`);
      log(w.content);
      log(`--- end ${w.path} ---`);
    }
    if (plan.registryAppend) {
      log(
        `registry-append ${plan.registryAppend.path} (slug "${plan.registryAppend.slug}") into ${registryPath}`
      );
    } else {
      log("registry-append: already registered");
    }
    if (plan.banner) log(plan.banner);
    for (const c of plan.conflicts) log(`conflict: ${c}`);
    if (plan.mergeOutcome === "noop") {
      log("atlas init: .atlas/project.yml already exists — no changes needed");
    }

    if (parsed.dryRun) {
      log("atlas init: dry run complete — re-run without --dry-run to apply");
      return 0;
    }

    mkdirSyncFn(plan.atlasDir, { recursive: true });
    for (const w of plan.writes) {
      if (basename(w.path) === LOCK_FILENAME) {
        // template.lock is the one file with an atomic writer (lock.mjs's
        // writeLock: temp-file + renameSync) — routed through writeLockFn
        // so a failed write can never corrupt a lock a previous run wrote.
        writeLockFn(plan.atlasDir, JSON.parse(w.content));
      } else {
        writeFileSyncFn(w.path, w.content, "utf8");
      }
    }

    if (!registryMissing && plan.registryAppend) {
      const result = appendRegistryEntryFn(registryPath, plan.registryAppend);
      if (result.reason === "already_registered" || result.reason === "path_already_registered") {
        log("atlas init: already registered");
      }
    }

    log(
      "atlas init: the dashboard updates on the next collector run (up to 30 minutes later) — this is expected, not a failure"
    );

    if (registryMissing) {
      errorLog(
        `atlas init: could not read the registry at "${registryPath}" — paste this entry into it: ${JSON.stringify(plan.registryAppend)}`
      );
      return 3;
    }

    if (plan.mergeOutcome === "conflict" || plan.mergeOutcome === "major") {
      return 4;
    }

    return 0;
  } catch (err) {
    errorLog(`atlas init: ${err.message}`);
    return 1;
  }
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  process.exit(main());
}
