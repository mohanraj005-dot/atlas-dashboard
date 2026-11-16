#!/usr/bin/env node
// scripts/demo-seed.mjs
// Local-only demo: builds a handful of fictional git projects in a temp
// directory, points the real collector at them, and pushes the result into a
// locally running `wrangler dev` Worker (local D1, no Cloudflare account).
//
// Prerequisites (see README, "Try it locally"):
//   npm run migrate:local
//   cp .dev.vars.example .dev.vars
//   npm run dev                      # leaves the Worker on http://localhost:8787
// Then, in a second terminal:
//   node scripts/demo-seed.mjs
//
// It never talks to a remote host: the ingest URL is hard-wired to localhost
// unless ATLAS_DEMO_URL says otherwise, and D1 writes use --local.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const URL_BASE = process.env.ATLAS_DEMO_URL || "http://localhost:8787";

// Read the HMAC secret from the gitignored .dev.vars the Worker also reads.
function devVar(name) {
  const text = readFileSync(join(ROOT, ".dev.vars"), "utf8");
  const line = text.split("\n").find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} not found in .dev.vars`);
  return line.slice(name.length + 1).trim();
}

function git(cwd, args, date) {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Demo",
      GIT_AUTHOR_EMAIL: "demo@example.com",
      GIT_COMMITTER_NAME: "Demo",
      GIT_COMMITTER_EMAIL: "demo@example.com",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  });
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

// slug, display name, days since last commit, extras
const DEMO = [
  { slug: "orchard", name: "Orchard", age: 0.2, planning: true },
  { slug: "kestrel", name: "Kestrel", age: 1, planning: true },
  { slug: "meridian", name: "Meridian", age: 3, roadmap: true },
  { slug: "toolbox", name: "Toolbox", age: 9 },
  { slug: "ledger-lab", name: "Ledger Lab", age: 21 },
  { slug: "northwind", name: "Northwind", age: 60, declared: true },
  { slug: "bistro-pos", name: "Bistro POS", age: 120 },
];

const work = mkdtempSync(join(tmpdir(), "atlas-demo-"));
const projects = [];
for (const d of DEMO) {
  const dir = join(work, d.slug);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "README.md"), `# ${d.name}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "initial"], daysAgo(d.age));
  if (d.planning) mkdirSync(join(dir, ".planning"));
  if (d.roadmap) {
    writeFileSync(join(dir, "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(join(dir, "STATE.md"), "# State\n");
  }
  if (d.declared) {
    mkdirSync(join(dir, ".atlas"));
    writeFileSync(
      join(dir, ".atlas", "project.yml"),
      JSON.stringify({
        identity: { name: d.name, statement: "Demo project with a declared status." },
        profile: "code-project",
        next_action: "Write the launch checklist.",
        health: "amber, waiting on design review",
      })
    );
  }
  projects.push({ slug: d.slug, name: d.name, path: dir, git_scope: "root", skip_git: false, note: "demo" });
}
const registryPath = join(work, "registry.yml");
writeFileSync(registryPath, JSON.stringify({ schema_version: 1, tenant_id: "local", projects }, null, 2));

// Local ingest token: insert its hash into the LOCAL D1 only.
const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token, "utf8").digest("hex");
execFileSync(
  "npx",
  ["wrangler", "d1", "execute", "atlas", "--local", "--command",
   `INSERT OR IGNORE INTO ingest_tokens (token_hash, tenant_id, scope, revoked_at) VALUES ('${hash}', 'local', 'ingest:write', NULL)`],
  { cwd: ROOT, stdio: "ignore" }
);

console.log(`demo-seed: collecting ${projects.length} fictional projects from ${work}`);
execFileSync("node", [join(ROOT, "collector", "atlas-collect.mjs")], {
  stdio: "inherit",
  env: {
    ...process.env,
    ATLAS_REGISTRY: registryPath,
    ATLAS_INGEST_URL: `${URL_BASE}/v1/ingest`,
    ATLAS_INGEST_TOKEN: token,
    ATLAS_INGEST_HMAC_SECRET: devVar("ATLAS_INGEST_HMAC_SECRET"),
  },
});
console.log(`demo-seed: done. Open ${URL_BASE}/ and sign in with ATLAS_VIEW_PASSWORD from .dev.vars.`);
