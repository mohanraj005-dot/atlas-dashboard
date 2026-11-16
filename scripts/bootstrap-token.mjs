#!/usr/bin/env node
// scripts/bootstrap-token.mjs
// One-time bootstrap: mints three independent 32-byte credentials —
//   1. the ingest bearer token (only its sha256 hash reaches D1; the raw
//      value goes to the macOS Keychain, never a dotfile, never the repo)
//   2. the HMAC signing secret behind the *signed*
//      snapshot (Worker secret store + Keychain, and nowhere else)
//   3. the view password behind the read-side gate (Worker secret store +
//      Keychain). Independent of 1 and 2: a reader cannot push and a pusher
//      cannot read.
// Built-ins only. Raw credential values are NEVER written to stdout in
// production mode — they go to the Keychain and the Worker secret store, and
// are read back on demand. See the note above the closing console.log block.
//
// Usage:
//   node scripts/bootstrap-token.mjs           # production: --remote D1 +
//                                               # `wrangler secret put`.
//                                               # ROTATES the ingest token and
//                                               # the HMAC secret — the
//                                               # collector needs a re-read of
//                                               # the Keychain afterwards
//   node scripts/bootstrap-token.mjs --local    # dev: --local D1; the HMAC
//                                               # secret is generated and
//                                               # printed but NOT written to
//                                               # the Worker secret store or
//                                               # the Keychain — copy it into
//                                               # your gitignored .dev.vars
//                                               # by hand instead
//   node scripts/bootstrap-token.mjs --view-password-only
//                                               # mints ONLY credential 3.
//                                               # Touches no D1 row and does
//                                               # not rotate the collector's
//                                               # credentials — safe to run on
//                                               # a live deployment
//
// Design notes: token comparison via SHA-256 + D1 hash-as-primary-key lookup;
// src/ingest.js (the exact hash
// algorithm and the columns the lookup expects), src/lib/hmac.js (the
// Worker's HMAC-SHA256 verification via Web Crypto).

import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const isLocal = process.argv.includes("--local");
const viewPasswordOnly = process.argv.includes("--view-password-only");
const D1_FLAG = isLocal ? "--local" : "--remote";
const TENANT_ID = "local";
const SCOPE = "ingest:write";

/** 32 random bytes, base64url-encoded — never a guessable/human-chosen value. */
function randomToken() {
  return randomBytes(32).toString("base64url");
}

/**
 * sha256 hex, matching src/lib/hash.js's sha256Hex byte-for-byte: both hash
 * the UTF-8 encoding of the same string. A mismatch here produces a 401
 * that looks exactly like a wrong token.
 */
function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function d1Execute(sql) {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "atlas", D1_FLAG, "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] }
  );
}

/** -U updates an existing entry in place rather than erroring on rerun. */
function keychainStore(service, value) {
  execFileSync(
    "security",
    ["add-generic-password", "-a", "atlas", "-s", service, "-w", value, "-U"],
    { encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] }
  );
}

/** Pipes a value into `wrangler secret put` over stdin, so it never touches
 *  argv or shell history. */
function workerSecretPut(name, value) {
  execFileSync("npx", ["wrangler", "secret", "put", name], {
    input: value,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
}

/**
 * Credential 3 in isolation: the read-side view password. Deliberately its
 * own path — running the full bootstrap on a live deployment would rotate the
 * ingest token and the HMAC secret out from under the scheduled collector.
 */
function mintViewPassword() {
  if (isLocal) {
    const viewPassword = randomToken();
    console.log("");
    console.log("=== View password (--local) ===");
    console.log(
      "--local mode: nothing was written to the Worker secret store or the Keychain."
    );
    console.log("Paste this into your gitignored .dev.vars:");
    console.log(`  ATLAS_VIEW_PASSWORD=${viewPassword}`);
    console.log("");
    return;
  }

  const viewPassword = randomToken();
  workerSecretPut("ATLAS_VIEW_PASSWORD", viewPassword);
  keychainStore("atlas-view-password", viewPassword);

  // Non-secret fingerprint only. The sha256 of a 32-byte random value is not
  // reversible and is printed solely so a later reader can confirm the
  // Keychain entry and the Worker secret are the same generation.
  console.log("");
  console.log("=== View password provisioned ===");
  console.log(
    `Fingerprint sha256 (NOT a secret, for cross-checking only):  ${sha256Hex(
      viewPassword
    )}`
  );
  console.log("");
  console.log("Retrieve the raw view password when you need it:");
  console.log(
    "  security find-generic-password -a atlas -s atlas-view-password -w"
  );
  console.log("");
  console.log("The Worker reads it as the ATLAS_VIEW_PASSWORD secret binding.");
  console.log("");
}

function main() {
  if (viewPasswordOnly) {
    // No D1 write, no rotation of credentials 1 and 2 — safe against a live
    // deployment with a scheduled collector running.
    mintViewPassword();
    return;
  }

  // --- Credential 1: ingest bearer token ---
  const ingestToken = randomToken();
  const tokenHash = sha256Hex(ingestToken);

  const insertTokenSql =
    `INSERT INTO ingest_tokens (token_hash, tenant_id, scope, revoked_at) ` +
    `VALUES ('${tokenHash}', '${TENANT_ID}', '${SCOPE}', NULL)`;
  d1Execute(insertTokenSql);
  keychainStore("atlas-ingest-token", ingestToken);

  // --- Credential 2: HMAC signing secret — independent of credential 1.
  // Holding one without the other is not enough to push.
  const hmacSecret = randomToken();

  if (isLocal) {
    console.log(
      "--local mode: HMAC secret was NOT written to the Worker secret store or the Keychain."
    );
    console.log(
      "Copy the value below into your gitignored .dev.vars as ATLAS_INGEST_HMAC_SECRET=<value>."
    );
  } else {
    // Piped via stdin so the secret never touches shell history or argv.
    workerSecretPut("ATLAS_INGEST_HMAC_SECRET", hmacSecret);
    keychainStore("atlas-ingest-hmac-secret", hmacSecret);
  }

  // Raw credentials are deliberately NOT printed. stdout is captured by shell
  // history, CI logs and agent transcripts; a value printed once is a value
  // stored forever somewhere you did not choose. Both credentials are already
  // in the Keychain — read them from there, on demand, when a consumer needs
  // them. The only exception is --local's HMAC secret, which has no Keychain
  // entry because it belongs in a gitignored .dev.vars instead.
  console.log("");
  console.log("=== Bootstrap complete ===");
  console.log(
    `Token hash inserted into D1 (for cross-checking, not a secret):    ${tokenHash}`
  );
  console.log("");
  console.log("Retrieve the raw ingest token when you need it:");
  console.log(
    "  security find-generic-password -a atlas -s atlas-ingest-token -w"
  );

  if (isLocal) {
    console.log("");
    console.log(
      "--local HMAC secret (no Keychain entry in local mode — paste into .dev.vars now):"
    );
    console.log(`  ATLAS_INGEST_HMAC_SECRET=${hmacSecret}`);
  } else {
    console.log("");
    console.log("Retrieve the raw HMAC signing secret when you need it:");
    console.log(
      "  security find-generic-password -a atlas -s atlas-ingest-hmac-secret -w"
    );
  }
  console.log("");

  // --- Credential 3: the read-side view password. Same hardened path.
  mintViewPassword();
}

main();
