#!/usr/bin/env node
// checks.mjs — pre-push gate, wired via .githooks/pre-push
// (git config core.hooksPath .githooks).
//
// Guards one thing: the Worker name in wrangler.jsonc must be exactly
// "atlas-dashboard". A deploy under any other name would create or overwrite a
// different Worker in your account, so the gate refuses the push instead.
// If you rename the Worker on purpose, change EXPECTED_NAME below and the
// matching assertions in tests/checks.test.mjs.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXPECTED_NAME = "atlas-dashboard";

const configPath = process.argv[2]
  ? resolve(process.argv[2])
  : new URL("./wrangler.jsonc", import.meta.url);

const RAW = readFileSync(configPath, "utf8");
// wrangler.jsonc is kept deliberately comment-free so plain JSON.parse works.
const config = JSON.parse(RAW);

if (config.name !== EXPECTED_NAME) {
  console.error(
    `FATAL: wrangler.jsonc name is "${config.name}", expected "${EXPECTED_NAME}". Refusing to push.`
  );
  process.exit(1);
}
console.log(`checks.mjs: OK — worker name is "${EXPECTED_NAME}"`);
