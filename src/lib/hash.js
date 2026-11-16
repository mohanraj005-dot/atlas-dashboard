// src/lib/hash.js
// Web Crypto only — never a hand-rolled hash.

/** SHA-256 of `input`, rendered as lowercase hex. */
export async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The dedup key for a project's fields. Deliberately excludes the fact-dated
 * timestamp column so that reposting an unchanged snapshot with a new
 * collection time still hashes identically — this is what makes the
 * "no change" state reachable. (A plain `sha256Hex(JSON.stringify(project.fields))`
 * would hash differently on every run.)
 */
export async function contentHash(fields) {
  const tuples = fields
    .map((field) => [
      field.section,
      field.key,
      field.value,
      field.confidence,
      field.source,
    ])
    .sort((a, b) => {
      if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
      if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
      return 0;
    });
  return sha256Hex(JSON.stringify(tuples));
}
