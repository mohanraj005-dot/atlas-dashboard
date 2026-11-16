// collector/adapters/git.mjs
// GitAdapter — author-date recency, with the four hard guards that defeat
// every collector trap 01-disk-recon.md found on this machine: a symlinked
// or worktree-duplicated path, a spike directory with tens of thousands of
// files, and a single slow/hung repo stalling the whole run.

import { execFileSync } from "node:child_process";
import { realpathSync, existsSync } from "node:fs";
import { join } from "node:path";

// Guard 2 + 3: exclude worktree copies and pruned spike directories.
// Stale worktree copies can lag the canonical tree by days, and a spike-heavy
// repo can hold tens of thousands of files under a planning directory.
const EXCLUDE_PATTERNS = [/\.claude\/worktrees\//, /(^|\/)spikes\/[^/]+(\/|$)/];

/**
 * Returns the last-activity signal for `rawPath`, scoped by `gitScope`.
 * Never throws — every failure mode returns a structured unknown/skipped
 * shape so one bad project can never stall or crash a run.
 */
export function collectGit(rawPath, { budgetMs = 3000, gitScope = "root" } = {}) {
  const start = Date.now();

  // Guard 1: realpath canonicalisation, so a symlinked or doubled path
  // resolves to one canonical form before anything else runs.
  let path;
  try {
    path = realpathSync(rawPath);
  } catch {
    return { value: null, confidence: "unknown", source: "git", reason: "path_not_found" };
  }

  // Guards 2 and 3, evaluated after canonicalisation so a symlinked route
  // into a worktree or spike cannot bypass them.
  if (EXCLUDE_PATTERNS.some((re) => re.test(path))) {
    return { skipped: true, reason: "excluded_path" };
  }

  const args =
    gitScope === "subdir"
      ? ["log", "-1", "--format=%aI", "--", "."]
      : ["log", "-1", "--format=%aI"];

  let out;
  try {
    // Guard 4: per-project time budget. execFileSync's own `timeout` kills
    // the child process; the wall-clock check below catches the case where
    // the process returned just past budget. One slow repo must never stall
    // the whole run.
    // stdio must be explicit here: execFileSync's undocumented-in-practice
    // default mirrors the child's stderr onto the parent process's stderr
    // in addition to capturing it. Left at the default, every non-repo or
    // zero-commit project (an expected, honest degradation, not a crash)
    // would spam "fatal: not a git repository" into the collector's
    // launchd error log on every 30-minute run.
    out = execFileSync("git", args, {
      cwd: path,
      timeout: budgetMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    // A repo with zero commits is not a "not a repo" error — `git log`
    // exits non-zero with "does not have any commits yet" on stderr rather
    // than printing empty stdout. Distinguish it so it degrades to the
    // correct reason rather than being lumped in with a genuine missing
    // repo, missing git binary, or permission error.
    const stderr = typeof err.stderr === "string" ? err.stderr : "";
    if (/does not have any commits yet/i.test(stderr)) {
      return { value: null, confidence: "unknown", source: "git", reason: "empty_repo_no_commits" };
    }
    // Covers: not a repo, git missing, permission denied, or the timeout
    // itself killing the process (execFileSync throws on timeout too).
    return { value: null, confidence: "unknown", source: "git", reason: "not_a_repo_or_git_error" };
  }

  const elapsed = Date.now() - start;

  if (!out) {
    // Belt-and-braces: some git versions/configurations may still produce
    // empty stdout with a zero exit code for a commit-less repo instead of
    // throwing. Treat that the same way as the thrown case above.
    return { value: null, confidence: "unknown", source: "git", reason: "empty_repo_no_commits" };
  }

  // `%aI` is the author date in strict ISO 8601 — never the committer-date
  // format specifier. Committer date shifts on rebase, amend and
  // cherry-pick and stops reflecting when the work actually happened
  // (a known git pitfall).
  //
  // `as_of` is the author date itself, not Date.now(): a git author date is
  // a fixed historical fact the instant it is read (the freshness contract). Stamping read-time here would also make the
  // ingest content hash change on every run, permanently breaking dedup
  // and the "no change" state.
  //
  // Detached HEAD and shallow clones do not break this specific call
  // because `git log -1` walks the commit graph from the current tip
  // regardless of what ref that tip is pointed to by — but they WILL break
  // `git symbolic-ref` and `git rev-list --count` if you add
  // branch-name or ahead/behind fields. Guard for those separately then.
  if (elapsed > budgetMs) {
    return { value: out, confidence: "derived", source: "git", as_of: out, timed_out: true };
  }

  return { value: out, confidence: "derived", source: "git", as_of: out };
}

/** Presence-only check: does `<path>/.planning` exist as a directory? */
export function hasPlanningDir(path) {
  return existsSync(join(path, ".planning"));
}

/**
 * Presence-only check: do both `<path>/ROADMAP.md` and `<path>/STATE.md`
 * exist? Contents are deliberately not parsed here; a real parser would be a separate adapter.
 */
export function hasRoadmapAndState(path) {
  return existsSync(join(path, "ROADMAP.md")) && existsSync(join(path, "STATE.md"));
}
