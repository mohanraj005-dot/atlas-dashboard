// tests/collector/git-adapter.test.mjs
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectGit,
  hasPlanningDir,
  hasRoadmapAndState,
} from "../../collector/adapters/git.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "atlas-git-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** Initialises a git repo at `dir` (created if missing) with an initial commit. */
function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

/** Commits `content` to `filename` inside `dir` at pinned author/committer dates. */
function commitAt(dir, filename, content, authorDate, committerDate) {
  writeFileSync(join(dir, filename), content, "utf8");
  execFileSync("git", ["add", filename], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", `commit ${filename}`], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: authorDate,
      GIT_COMMITTER_DATE: committerDate,
    },
  });
}

describe("collectGit — commit exists", () => {
  test("returns the exact pinned author date, confidence derived, source git, as_of === value", () => {
    const dir = initRepo(join(ROOT, "one-commit"));
    commitAt(
      dir,
      "a.txt",
      "hello",
      "2026-01-15T10:00:00-08:00",
      "2026-01-15T10:00:00-08:00"
    );

    const result = collectGit(dir);

    assert.equal(result.value, "2026-01-15T10:00:00-08:00");
    assert.equal(result.confidence, "derived");
    assert.equal(result.source, "git");
    assert.equal(result.as_of, result.value);
  });

  test("returns the author date, not the committer date, when they diverge by 30 days", () => {
    const dir = initRepo(join(ROOT, "rebased-commit"));
    commitAt(
      dir,
      "a.txt",
      "hello",
      "2026-01-01T09:00:00-08:00",
      "2026-01-31T09:00:00-08:00"
    );

    const result = collectGit(dir);

    // This assertion fails if the implementation reads %cI instead of %aI.
    assert.equal(result.value, "2026-01-01T09:00:00-08:00");
    assert.equal(result.confidence, "derived");
  });
});

describe("collectGit — no usable commit", () => {
  test("an initialised repo with zero commits returns unknown, does not throw", () => {
    const dir = initRepo(join(ROOT, "empty-repo"));

    const result = collectGit(dir);

    assert.equal(result.value, null);
    assert.equal(result.confidence, "unknown");
    assert.equal(result.reason, "empty_repo_no_commits");
  });

  test("a plain non-repo directory returns unknown, does not throw", () => {
    const dir = join(ROOT, "not-a-repo");
    mkdirSync(dir, { recursive: true });

    const result = collectGit(dir);

    assert.equal(result.value, null);
    assert.equal(result.confidence, "unknown");
    assert.equal(result.reason, "not_a_repo_or_git_error");
  });

  test("a non-existent path returns path_not_found, does not throw", () => {
    const result = collectGit(join(ROOT, "does-not-exist-at-all"));

    assert.equal(result.value, null);
    assert.equal(result.confidence, "unknown");
    assert.equal(result.reason, "path_not_found");
  });
});

describe("collectGit — hard guards 2 and 3 (exclusion)", () => {
  test("a path containing .claude/worktrees/ is skipped without invoking git", () => {
    // A real, existing, non-repo directory — if the exclusion guard did not
    // fire before git ran, this would return not_a_repo_or_git_error instead.
    const dir = join(ROOT, ".claude", "worktrees", "some-agent");
    mkdirSync(dir, { recursive: true });

    const result = collectGit(dir);

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "excluded_path");
  });

  test("a path containing a spikes/<name>/ segment is skipped without invoking git", () => {
    const dir = join(ROOT, "some-project", "spikes", "experiment-1");
    mkdirSync(dir, { recursive: true });

    const result = collectGit(dir);

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "excluded_path");
  });
});

describe("collectGit — guard 1 (realpath canonicalisation)", () => {
  test("a symlink pointing at a repo resolves via realpathSync and returns the same value", () => {
    const realDir = initRepo(join(ROOT, "real-repo"));
    commitAt(
      realDir,
      "a.txt",
      "hello",
      "2026-02-01T08:00:00-08:00",
      "2026-02-01T08:00:00-08:00"
    );
    const linkPath = join(ROOT, "symlinked-repo");
    symlinkSync(realDir, linkPath);

    const realResult = collectGit(realDir);
    const linkResult = collectGit(linkPath);

    assert.equal(linkResult.value, realResult.value);
    assert.equal(linkResult.value, "2026-02-01T08:00:00-08:00");
  });
});

describe("collectGit — gitScope subdir", () => {
  test("returns the subdirectory's last-touching commit date, not the repo tip's", () => {
    const dir = initRepo(join(ROOT, "parent-repo"));
    mkdirSync(join(dir, "nested"), { recursive: true });

    // First commit touches only the nested subdirectory.
    commitAt(
      dir,
      "nested/child.txt",
      "child",
      "2026-01-05T08:00:00-08:00",
      "2026-01-05T08:00:00-08:00"
    );
    // Second (later) commit touches only the repo root, not the subdirectory.
    commitAt(
      dir,
      "root.txt",
      "root",
      "2026-01-20T08:00:00-08:00",
      "2026-01-20T08:00:00-08:00"
    );

    const rootResult = collectGit(dir, { gitScope: "root" });
    const subdirResult = collectGit(join(dir, "nested"), { gitScope: "subdir" });

    assert.equal(rootResult.value, "2026-01-20T08:00:00-08:00");
    assert.equal(subdirResult.value, "2026-01-05T08:00:00-08:00");
  });
});

describe("hasPlanningDir / hasRoadmapAndState — presence only", () => {
  test("hasPlanningDir is true only when .planning exists as a directory", () => {
    const withPlanning = join(ROOT, "with-planning");
    mkdirSync(join(withPlanning, ".planning"), { recursive: true });
    const withoutPlanning = join(ROOT, "without-planning");
    mkdirSync(withoutPlanning, { recursive: true });

    assert.equal(hasPlanningDir(withPlanning), true);
    assert.equal(hasPlanningDir(withoutPlanning), false);
  });

  test("hasRoadmapAndState is true only when both files exist", () => {
    const withBoth = join(ROOT, "with-both");
    mkdirSync(withBoth, { recursive: true });
    writeFileSync(join(withBoth, "ROADMAP.md"), "# roadmap", "utf8");
    writeFileSync(join(withBoth, "STATE.md"), "# state", "utf8");

    const withOnlyOne = join(ROOT, "with-only-one");
    mkdirSync(withOnlyOne, { recursive: true });
    writeFileSync(join(withOnlyOne, "ROADMAP.md"), "# roadmap", "utf8");

    assert.equal(hasRoadmapAndState(withBoth), true);
    assert.equal(hasRoadmapAndState(withOnlyOne), false);
  });
});
