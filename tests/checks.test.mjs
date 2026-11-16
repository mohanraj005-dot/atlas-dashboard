import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const CHECKS_MJS = join(REPO_ROOT, "checks.mjs");

function writeFixtureConfig(name) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-checks-"));
  const file = join(dir, "wrangler.jsonc");
  writeFileSync(file, JSON.stringify({ name }));
  return file;
}

test("checks.mjs exits 1 and names the offending value when the Worker name is wrong", () => {
  const configPath = writeFixtureConfig("some-other-worker");
  assert.throws(() => {
    execFileSync("node", [CHECKS_MJS, configPath], { stdio: "pipe" });
  }, (err) => {
    assert.equal(err.status, 1);
    assert.match(err.stderr.toString(), /some-other-worker/);
    return true;
  });
});

test("checks.mjs exits 0 when name is atlas-dashboard", () => {
  const configPath = writeFixtureConfig("atlas-dashboard");
  const out = execFileSync("node", [CHECKS_MJS, configPath], { encoding: "utf8" });
  assert.match(out, /atlas-dashboard/);
});

test("checks.mjs exits 1 when name is atlas-dashboard-staging", () => {
  const configPath = writeFixtureConfig("atlas-dashboard-staging");
  assert.throws(() => {
    execFileSync("node", [CHECKS_MJS, configPath], { stdio: "pipe" });
  }, (err) => {
    assert.equal(err.status, 1);
    return true;
  });
});

test("the pre-push hook script itself propagates a non-zero exit for a wrong Worker name", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-hook-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, ".githooks"));
  copyFileSync(CHECKS_MJS, join(dir, "checks.mjs"));
  copyFileSync(join(REPO_ROOT, ".githooks", "pre-push"), join(dir, ".githooks", "pre-push"));
  chmodSync(join(dir, ".githooks", "pre-push"), 0o755);
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({ name: "some-other-worker" }));

  assert.throws(() => {
    execFileSync("sh", [".githooks/pre-push"], { cwd: dir, stdio: "pipe" });
  }, (err) => {
    assert.notEqual(err.status, 0);
    return true;
  });
});
