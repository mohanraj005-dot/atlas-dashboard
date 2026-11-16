#!/usr/bin/env node
// collector/install.mjs
// Installs the Atlas collector to ~/.atlas/ and renders the launchd
// agent plist into ~/Library/LaunchAgents/. Node built-ins only — the same
// zero-dependency constraint the collector itself runs under, because the
// install target has no node_modules beside it.
//
// The install location is deliberate: ~/.atlas/ is outside any tool-managed
// tree that might be wiped on update, and this script refuses to install
// anywhere containing a /skills/ segment.
//
// The deployed registry.yml is MERGED, not overwritten. `atlas init`
// writes project entries directly into the deployed copy
// (~/.atlas/registry.yml), so a blind copy from the repo on every
// re-install would delete every project declared since the last install.
// mergeRegistryDocs keeps the repo copy authoritative for shared slugs while
// preserving deployed-only entries; a path collision between the two fails
// the install loudly rather than silently dropping an entry.
//
// This script does NOT bootstrap the launchd agent. Loading it is a separate,
// explicit step so that the load and the first run are separately observable
// in the logs. See the Operations section of README.md.

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readRegistryDoc, mergeRegistryDocs } from "./lib/registry.mjs";

const LABEL = "com.example.atlas.collector";
// There is no default endpoint: set ATLAS_INGEST_URL to your own Worker's
// /v1/ingest URL when installing. This placeholder is only used by --dry-run.
const DEFAULT_INGEST_URL = "https://<YOUR_WORKER_SUBDOMAIN>.workers.dev/v1/ingest";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Everything the installer will write, computed without touching disk, so
 * --dry-run and the real run share one source of truth about the plan.
 */
export function buildPlan({ home = homedir(), ingestUrl = DEFAULT_INGEST_URL } = {}) {
  const atlasHome = join(home, ".atlas");
  const binDir = join(atlasHome, "bin");
  const logsDir = join(atlasHome, "logs");
  const launchAgentsDir = join(home, "Library", "LaunchAgents");

  return {
    home,
    ingestUrl,
    atlasHome,
    binDir,
    logsDir,
    launchAgentsDir,
    plistPath: join(launchAgentsDir, `${LABEL}.plist`),
    templatePath: join(SOURCE_DIR, `${LABEL}.plist.template`),
    dirs: [atlasHome, binDir, logsDir, launchAgentsDir],
    // atlas-collect.mjs imports ./lib/*.mjs and ./adapters/*.mjs relatively,
    // so lib/ and adapters/ must land beside it inside bin/, not above it.
    // templates/ joins them for the same reason: collector/lib/project-
    // template.mjs's loadTemplateDef resolves
    // join(dirname(fileURLToPath(import.meta.url)), "..", "templates", ...)
    // — with lib/ deployed at bin/lib/, that resolves to bin/templates/, so
    // the templates directory must land there too. registry.yml is NOT in
    // this list — see registryMerge below. Every other entry here genuinely
    // is a one-way overwrite of code.
    copies: [
      { from: join(SOURCE_DIR, "atlas-collect.mjs"), to: join(binDir, "atlas-collect.mjs"), mode: 0o755 },
      { from: join(SOURCE_DIR, "run-collect.sh"), to: join(binDir, "run-collect.sh"), mode: 0o755 },
      { from: join(SOURCE_DIR, "atlas"), to: join(binDir, "atlas"), mode: 0o755 },
      { from: join(SOURCE_DIR, "atlas-init.mjs"), to: join(binDir, "atlas-init.mjs"), mode: 0o755 },
      { from: join(SOURCE_DIR, "lib"), to: join(binDir, "lib"), dir: true },
      { from: join(SOURCE_DIR, "adapters"), to: join(binDir, "adapters"), dir: true },
      { from: join(SOURCE_DIR, "templates"), to: join(binDir, "templates"), dir: true },
    ],
    // the deployed registry.yml is merged with the repo copy, not
    // blindly overwritten. See mergeRegistryDocs() in main().
    registryMerge: {
      from: join(SOURCE_DIR, "registry.yml"),
      to: join(atlasHome, "registry.yml"),
    },
  };
}

/**
 * Substitutes the template's placeholders. Every path handed in must already
 * be absolute — launchd does not expand "~", and a plist carrying a literal
 * tilde fails silently at run time rather than loudly at load time.
 */
export function renderPlist(template, { atlasHome, home, ingestUrl }) {
  const rendered = template
    .replaceAll("__ATLAS_HOME__", atlasHome)
    .replaceAll("__USER_HOME__", home)
    .replaceAll("__ATLAS_INGEST_URL__", ingestUrl);

  if (rendered.includes("__ATLAS_") || rendered.includes("__USER_HOME__")) {
    throw new Error("renderPlist: template still contains unsubstituted placeholders");
  }
  return rendered;
}

/**
 * Guards the one property that makes this install survive an engine update.
 */
export function assertOutsideWipeZone(atlasHome) {
  if (atlasHome.includes("/skills/") || atlasHome.endsWith("/skills")) {
    throw new Error(
      `install: refusing to install under a /skills/ directory (${atlasHome})`
    );
  }
}

function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes("--dry-run");
  const plan = buildPlan({ ingestUrl: process.env.ATLAS_INGEST_URL || DEFAULT_INGEST_URL });

  assertOutsideWipeZone(plan.atlasHome);

  if (!existsSync(plan.templatePath)) {
    console.error(`install: plist template not found at ${plan.templatePath}`);
    return 1;
  }
  const rendered = renderPlist(readFileSync(plan.templatePath, "utf8"), plan);

  // Compute the registry merge before printing the plan, so --dry-run
  // reports the truth rather than a stale "copy" description.
  const sourceRegistry = readRegistryDoc(plan.registryMerge.from);
  let deployedRegistry = null;
  if (existsSync(plan.registryMerge.to)) {
    try {
      deployedRegistry = readRegistryDoc(plan.registryMerge.to);
    } catch (err) {
      console.error(
        `install: could not read the deployed registry at ${plan.registryMerge.to}: ${err.message}`
      );
      console.error(
        "install: refusing to overwrite a deployed registry.yml that failed to parse — that would lose every project declared since the last install"
      );
      return 1;
    }
  }
  const merged = mergeRegistryDocs(sourceRegistry, deployedRegistry);

  const targets = [
    ...plan.dirs.map((d) => ({ kind: "mkdir", path: d })),
    ...plan.copies.map((c) => ({ kind: c.dir ? "copy-dir" : "copy", path: c.to, from: c.from })),
    { kind: "merge", path: plan.registryMerge.to },
    { kind: "render", path: plan.plistPath, from: plan.templatePath },
  ];

  console.log(dryRun ? "install: --dry-run, nothing will be written" : "install: writing");
  console.log(`install: ingest URL ${plan.ingestUrl}`);
  console.log(`install: target root ${plan.atlasHome} (outside any /skills/ directory)`);

  for (const target of targets) {
    console.log(`  ${target.kind.padEnd(9)} ${target.path}`);
  }

  console.log(
    `install: registry merge — ${sourceRegistry.projects.length} entry(ies) from the repo, ${merged.preserved.length} deployed-only entry(ies) preserved`
  );
  for (const slug of merged.preserved) {
    console.log(`install: preserving deployed-only entry "${slug}"`);
  }
  for (const conflict of merged.conflicts) {
    console.log(
      `install: CONFLICT deployed entry "${conflict.slug}" shares a path with "${conflict.collides_with}" — not merged`
    );
  }

  // Printed on both --dry-run and the real run: it is static, not
  // conditional on anything actually being written yet, and a user running
  // --dry-run first should see it just as plainly.
  console.log(
    `install: for the dashboard's "atlas init {slug}" command to work, add ${plan.binDir} to PATH:`
  );
  console.log(`install:   export PATH="$HOME/.atlas/bin:$PATH"`);
  console.log(
    "install:   add that line to ~/.zshrc (or your shell's profile file) yourself — this installer never edits it."
  );

  if (dryRun) {
    console.log("install: dry run complete — re-run without --dry-run to apply");
    return 0;
  }

  if (merged.conflicts.length > 0) {
    console.error(
      `install: refusing to complete — ${merged.conflicts.length} registry path conflict(s) would double-count a project in coverage`
    );
    return 1;
  }

  for (const dir of plan.dirs) {
    mkdirSync(dir, { recursive: true });
  }
  for (const copy of plan.copies) {
    cpSync(copy.from, copy.to, { recursive: Boolean(copy.dir), force: true });
    if (copy.mode) chmodSync(copy.to, copy.mode);
  }

  // Same temp+rename discipline registry.mjs's own writer uses — atomic on
  // one filesystem, so a crash mid-write can't leave loadRegistry's
  // hard-throw-on-malformed posture staring at a torn deployed registry.
  const mergedRegistrySerialized = JSON.stringify(merged.doc, null, 2) + "\n";
  const registryTmpPath = `${plan.registryMerge.to}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(registryTmpPath, mergedRegistrySerialized, "utf8");
  try {
    renameSync(registryTmpPath, plan.registryMerge.to);
  } catch (err) {
    rmSync(registryTmpPath, { force: true });
    throw err;
  }

  writeFileSync(plan.plistPath, rendered, "utf8");

  console.log("install: done.");
  console.log(`install: load it with  launchctl bootstrap gui/$(id -u) ${plan.plistPath}`);
  console.log(`install: logs at       ${plan.logsDir}`);
  return 0;
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  process.exit(main());
}
