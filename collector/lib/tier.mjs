// collector/lib/tier.mjs
// Presence-based tier rule and provenance string. Pure functions —
// booleans in, string out, no filesystem access — so they are trivially unit
// tested. A content-aware T3 would need a parser; this uses a cheap existence check and is
// honest about that by labelling the tier itself confidence=derived, source=collector.

/**
 * Ordered presence-based tier rule:
 *   registry entry has skip_git true                 -> T0
 *   <root>/.planning/ exists as a directory           -> T3
 *   <root>/ROADMAP.md AND <root>/STATE.md both exist  -> T2
 *   git reports at least one commit for the entry      -> T1
 *   otherwise                                          -> T0
 */
export function computeTier({ hasPlanning, hasRoadmapAndState, hasCommit, skipGit }) {
  if (skipGit) return "T0";
  if (hasPlanning) return "T3";
  if (hasRoadmapAndState) return "T2";
  if (hasCommit) return "T1";
  return "T0";
}

/**
 * Provenance string — the SOURCE column in the UI in the portfolio table.
 */
export function computeProvenance({ hasPlanning, hasGit }) {
  if (hasPlanning && hasGit) return "git + .planning";
  if (hasPlanning && !hasGit) return ".planning only";
  if (!hasPlanning && hasGit) return "git only";
  return "registry only";
}
