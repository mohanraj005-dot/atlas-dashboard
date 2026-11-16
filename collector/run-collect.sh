#!/bin/sh
# collector/run-collect.sh — the launchd entry point for the Atlas collector.
#
# launchd hands a job almost no environment: no shell profile, no PATH beyond
# what the plist declares, and none of Terminal's exported variables. So this
# wrapper assembles configuration rather than assuming it, and it is the only
# place the two credentials are ever materialised.
#
# Both are read from the macOS Keychain with the security(1) CLI at run time
# and exported solely for the exec below. Neither is written to a dotfile,
# printed, or logged, and shell tracing is never enabled — the log files this
# job writes must stay safe to read.
#
# If either read fails the wrapper exits loudly and non-zero WITHOUT running
# the collector. That matters: the collector's own catch block pushes a
# failure envelope, but it cannot fire if the process never starts, so a
# provisioning fault is the one failure mode that produces no envelope at all
# and must therefore be unmissable in the log. Pushing with a token but no
# signing secret would be worse than not pushing — every request would 401 and
# the run would read as an auth problem rather than the provisioning problem it
# actually is.

set -euo pipefail

KEYCHAIN_ACCOUNT="${ATLAS_KEYCHAIN_ACCOUNT:-atlas}"
TOKEN_SERVICE="${ATLAS_TOKEN_SERVICE:-atlas-ingest-token}"
SECRET_SERVICE="${ATLAS_SECRET_SERVICE:-atlas-ingest-hmac-secret}"

ATLAS_ROOT="${ATLAS_ROOT:-$HOME/.atlas}"
ATLAS_INGEST_URL="${ATLAS_INGEST_URL:?set ATLAS_INGEST_URL to your Worker /v1/ingest URL}"
ATLAS_REGISTRY="${ATLAS_REGISTRY:-$ATLAS_ROOT/registry.yml}"
COLLECTOR="$ATLAS_ROOT/bin/atlas-collect.mjs"

# launchd's PATH comes from the plist. Resolve node to an absolute path here so
# a missing interpreter is a named error rather than a bare 127.
NODE_BIN="${ATLAS_NODE:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  printf '%s\n' "run-collect.sh: no usable node binary found on PATH=$PATH — set ATLAS_NODE to an absolute path. Not running." >&2
  exit 78
fi

if ! ATLAS_INGEST_TOKEN="$(security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$TOKEN_SERVICE" -w 2>/dev/null)"; then
  printf '%s\n' "run-collect.sh: Keychain entry '$TOKEN_SERVICE' (account '$KEYCHAIN_ACCOUNT') could not be read. Provision it with scripts/bootstrap-token.mjs. Not running." >&2
  exit 78
fi

if ! ATLAS_INGEST_HMAC_SECRET="$(security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$SECRET_SERVICE" -w 2>/dev/null)"; then
  printf '%s\n' "run-collect.sh: Keychain entry '$SECRET_SERVICE' (account '$KEYCHAIN_ACCOUNT') could not be read. Refusing to push unsigned. Provision it with scripts/bootstrap-token.mjs. Not running." >&2
  exit 78
fi

if [ ! -f "$COLLECTOR" ]; then
  printf '%s\n' "run-collect.sh: collector not found at $COLLECTOR — run 'node collector/install.mjs' from the Atlas checkout. Not running." >&2
  exit 78
fi

export ATLAS_INGEST_TOKEN
export ATLAS_INGEST_HMAC_SECRET
export ATLAS_INGEST_URL
export ATLAS_REGISTRY

exec "$NODE_BIN" "$COLLECTOR"
