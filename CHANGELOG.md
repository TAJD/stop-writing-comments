# Changelog

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
