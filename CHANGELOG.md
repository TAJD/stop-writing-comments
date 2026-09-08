# Changelog

## 0.3.3 — 2026-09-08

- Fixed a false-positive class where a single large file poisoned every subsequent Bash audit in a repo. `git show <tree>:<path>` ran with Node's default 1MB `execFileSync` buffer, so any tracked file over roughly 1MB threw `ENOBUFS`; the catch set the previous contents to the empty string, which made the whole file read as newly added and attributed all of its pre-existing comments to the command. The buffer is now 256MB, and a failed read is distinguished from a genuinely new file with `git cat-file -e` rather than assumed to mean "new" — if the path is in the snapshot tree but unreadable, the file is skipped instead of blamed.

## 0.3.2 — 2026-09-06

- Fixed a false-positive class in the post-Bash audit: a snapshot taken before the command is now discarded (with a skip log entry, no block) if the git worktree root or `HEAD` has moved by the time the command finishes — e.g. the command `cd`'d into a different worktree, or ran a `git checkout`/`fetch` mixed with a non-plumbing verb such as `git status`, which fell outside the existing `git`-plumbing-only fast path. Previously either case could diff the new tree's pre-existing, human-authored comments against the old snapshot and misattribute them to the command.
- The audit still fires on a genuine same-repo, same-`HEAD` comment addition; only tree/HEAD movement is exempted.

## 0.3.1 — 2026-09-06

- Regex literals containing `/` (e.g. `route.path.replace(/^\//, '')`) are no longer misdetected as `//` line comments in the `slash` family.
- HTML/XML comments that are a single bare token (e.g. `<!--app-head-->`) are treated as template placeholders, not prose, and exempted; multi-word or multi-line HTML comments are still flagged as before.
- `Bash` commands that are entirely `git checkout`/`switch`/`mv`/`restore`/`merge`/`rebase`/`cherry-pick`/`pull`/`reset`/`stash apply`/`stash pop` (chained with `&&`/`;`/`||`) skip the pre/post snapshot and audit — these change working-tree content without the agent authoring anything, so they can no longer be flagged for "adding" pre-existing comments.
- `Write` to a brand-new file no longer denies unconditionally when it contains comments: if every added comment line's text also exists elsewhere in the repo's `HEAD` tree, it's treated as moved, not authored.
- `Edit`/`Write`/`MultiEdit` no longer deny restoring a comment that still exists in the file's `HEAD`-committed blob — reverting an incidental deletion is no longer permanent.

## 0.3.0 — 2026-08-25

- Bash commands that rewrite source files in place (`sed -i`, `perl -pi`, `>`/`>>`/`tee` into a source file, inline `python`/`node`/`ruby`/`pwsh` scripts that call a write API) are denied with a pointer to Edit/Write, where the comment rule applies.
- Every other Bash command is audited afterwards: a git snapshot of the working tree (tracked and untracked) is taken before the command runs and diffed against it after. Files that gained comment lines, net or in any hunk, produce a `block` decision naming the file and lines. Same-count reflows (formatters) pass. Outside a git repository nothing happens.
- `hooks.json` now matches `Bash` on `PreToolUse` and `PostToolUse`; timeout raised to 10 s for the snapshot.

## 0.2.0 — 2026-08-25

- Per-hunk accounting: old and new text are line-diffed and no hunk may add more comment lines than it removes. Closes the "delete three, add one elsewhere" loophole. Each `MultiEdit` edit is judged on its own.
- The large-comment advisory only fires when the edit itself touches comment lines.
- Project configuration in `.claude/stop-writing-comments.json`: `mode`, `directives`, `extensions`, `skip`. Environment variables still override.
- Marketplace entry gains `displayName` and `category`.

## 0.1.0 — 2026-08-24

Initial release.

- PreToolUse hook on `Edit`, `Write` and `MultiEdit`: deny unless the net comment line count decreases.
- `HUMAN-APPROVED` marker exempts a comment line on both sides of an edit.
- Advisory nudge when the touched file contains a comment block of three or more lines.
- Comment families: `#`, `//` + `/* */`, `--`, `<!-- -->`, PowerShell `<# #>`; doc comments, directives, shebangs and license headers are never counted.
- `STOP_WRITING_COMMENTS_MODE` (`deny` | `warn` | `off`) and optional `STOP_WRITING_COMMENTS_LOG`.
- Fails open on any error.
