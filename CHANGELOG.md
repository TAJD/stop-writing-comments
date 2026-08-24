# Changelog

## 0.1.0 — 2026-08-24

Initial release.

- PreToolUse hook on `Edit`, `Write` and `MultiEdit`: deny unless the net comment line count decreases.
- `HUMAN-APPROVED` marker exempts a comment line on both sides of an edit.
- Advisory nudge when the touched file contains a comment block of three or more lines.
- Comment families: `#`, `//` + `/* */`, `--`, `<!-- -->`, PowerShell `<# #>`; doc comments, directives, shebangs and license headers are never counted.
- `STOP_WRITING_COMMENTS_MODE` (`deny` | `warn` | `off`) and optional `STOP_WRITING_COMMENTS_LOG`.
- Fails open on any error.
