// collector/lib/sign.mjs
// HMAC-SHA256 signing of the collector's outgoing envelope body, via
// node:crypto — a built-in, so the zero-npm-dependency constraint holds.
// This is the collector half of the signed-push design: every push
// carries `X-Atlas-Signature: sha256=<hex>` over the exact serialised bytes
// sent, verified on the Worker side by src/lib/hmac.js's
// crypto.subtle.verify.

import { createHmac } from "node:crypto";

/**
 * Signs `rawBody` (the already-serialised string that will be sent as the
 * request body — never a re-serialisation of the object, so the signed
 * bytes and the sent bytes cannot diverge) with `secret`, returning
 * `sha256=<lowercase hex>`.
 *
 * Throws when `secret` is missing or empty rather than silently signing
 * with an empty key — an unsigned-looking push would be rejected by the
 * Worker with a 401 that looks like a bad token, which is a worse failure
 * mode than failing loudly here.
 */
export function signBody(rawBody, secret) {
  if (!secret) {
    throw new Error(
      "signBody: secret is missing or empty — refusing to sign with an empty key"
    );
  }
  const hex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `sha256=${hex}`;
}
