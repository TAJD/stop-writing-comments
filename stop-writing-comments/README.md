# stop-writing-comments

[![CI](https://github.com/TAJD/stop-writing-comments/actions/workflows/ci.yml/badge.svg)](https://github.com/TAJD/stop-writing-comments/actions/workflows/ci.yml)

A Claude Code hook that stops Claude writing code comments.

**The policy:** comments are written by humans. Claude may delete comments or condense them, but every edit it makes must *reduce* the net number of comment lines. An edit that adds a comment, or rewrites one at the same size, is refused before it touches disk, and Claude is told to put the explanation in the commit message or PR description instead.

"Don't write verbose comments" in a `CLAUDE.md` is a request. This is a rule.

## Install

```
/plugin marketplace add TAJD/stop-writing-comments
/plugin install stop-writing-comments@stop-writing-comments
```

Zero dependencies: the hook is a single Node script and Claude Code already ships Node.

## What Claude sees

When an edit is refused:

> Net comment count must decrease (old 0, new 2). New/changed comments on lines 3–4 of the new text. Remove them — comments are written by humans. Put the explanation in the commit message or PR description instead. If a comment is genuinely essential, tell the user what you wanted to annotate and let them add it (they can mark it HUMAN-APPROVED to exempt it).

Claude retries without the comments. If it thinks one is load-bearing it will say so; you decide.

When an edit that touches comments is allowed and the file contains a comment block of three or more lines, Claude is nudged to offer you a shorter version. Edits that don't touch comments stay silent.

## The rule

For each `Edit`, `Write` or `MultiEdit`, comment lines are counted in the old text and the new text:

| old | new | result |
|----:|----:|--------|
| 3 | 2 | allow |
| 3 | 3 | deny (rewrite in place) |
| 0 | 1 | deny |
| 2 | 0 | allow |
| 0 | 0 | allow, silent |

`Write` compares against the file on disk (empty for a new file). Each edit in a `MultiEdit` is judged on its own.

There is a second check on top of the net count. The old and new text are line-diffed, and **no hunk may add more comment lines than it removes**. Deleting three comments at the top of a function and slipping a new one in at the bottom nets negative but is still refused, because the new comment sits in a hunk that removed nothing. Condensing a five-line block into two lines in the same place is fine. Very large edits (over 3 000 lines a side) skip the diff and use the net rule alone.

## Bash

Edits made through the shell would otherwise walk straight past the rule, so `Bash` is covered twice.

**Before it runs.** A command that rewrites a source file in place is refused and Claude is pointed at Edit/Write: `sed -i`, `perl -pi`, `>` / `>>` / `tee` into a file with a recognised extension, and inline `python` / `node` / `ruby` / `pwsh` scripts (`-c`, `-e`, heredoc) that call a write API (`open(…, 'w')`, `write_text`, `writeFile`, `Set-Content`, `Out-File`, `File.write`). Redirects to `.txt`, `.log`, `/dev/null` and the like are left alone.

**After it runs.** Anything that got through — a formatter, a codegen step, a script on disk — is audited. Before the command, the hook snapshots the working tree with git (tracked and untracked files; the real index is never touched). Afterwards it diffs the tree against that snapshot and runs the same net and per-hunk rule over every changed source file. A file that gained comment lines produces a `block` decision naming the file and lines; Claude is told to revert them with Edit. Reflows that keep the count (a formatter re-wrapping a comment) pass.

The audit needs a git repository. Outside one, Bash is only checked for in-place edits.

## What counts as a comment

| family | extensions |
|--------|-----------|
| `#` | py rb ex exs sh bash zsh yaml yml toml tf pl, `Dockerfile`, `Makefile` |
| `//` `/* */` | ts tsx js jsx mjs cjs go rs java kt swift c h cpp cs php css scss |
| `--` | sql lua |
| `<!-- -->` | html xml |
| `#` `<# #>` | ps1 |

Anything else, including Markdown and JSON, is never analysed. `.gitignore`, `.env*` and similar structural files are skipped.

### Never counted

- Doc comments: Python docstrings, `@doc` / `@moduledoc` heredocs, JSDoc `/** */`, Rust `///` and `//!`, Go doc comments directly above a declaration
- Shebangs and encoding lines
- Tool directives: `noqa`, `type: ignore`, `pyright:`, `eslint-*`, `@ts-*`, `biome-ignore`, `prettier-ignore`, `credo:disable`, `shellcheck disable`, `checkov:skip`, `tflint-ignore`, `hadolint ignore`, `pragma`, `fmt: off/on`, Dockerfile `# syntax=`, `cofferdam-ignore`
- A license or copyright header at the top of a file
- Any comment line containing `HUMAN-APPROVED`

String stripping is deliberately crude (a `//` inside a string literal is usually ignored, not always). The exemptions absorb the common false positives and `HUMAN-APPROVED` covers the rest.

## The escape hatch

Put `HUMAN-APPROVED` on a comment line and it is invisible to the hook, on both sides of an edit. Add it yourself after approving a comment in chat, or tell Claude to. That is the whole approval flow.

## Configuration

### Per project

Put a `.claude/stop-writing-comments.json` at the project root (the hook walks up from the working directory to find it). Every key is optional:

```json
{
  "mode": "deny",
  "directives": ["SAFETY:", "nolint"],
  "extensions": { "vue": "slash", "nix": "hash" },
  "skip": ["vendor/", "generated/"]
}
```

| key | meaning |
|-----|---------|
| `mode` | `deny`, `warn` (allow but log), `off` |
| `directives` | extra regexes; a comment line matching any of them is never counted |
| `extensions` | extra file extensions mapped to a comment family: `hash`, `slash`, `dash`, `xml`, `ps1` |
| `skip` | path substrings; matching files are never analysed |

A malformed file is ignored (defaults apply). Rust projects will want `"directives": ["SAFETY:"]` so Clippy's mandated `// SAFETY:` comments pass.

### Environment

Settable in `settings.json` under `"env"`; these override the project file.

| variable | values | default |
|----------|--------|---------|
| `STOP_WRITING_COMMENTS_MODE` | `deny`, `warn`, `off` | `deny` |
| `STOP_WRITING_COMMENTS_LOG` | path; one tab-separated line per analysed edit | unset (no log) |

To switch the plugin off entirely for one project, disable it in that project's `.claude/settings.json` `enabledPlugins`.

## Failure mode

The hook fails open. Malformed input, an unreadable file, an unknown extension, an exception: exit 0, no output, the edit proceeds. A bug in this hook never blocks you.

## Non-goals

- Judging comment *content*. Whether a surviving comment explains WHY rather than WHAT is still on you and your `CLAUDE.md`.
- Rewriting Claude's edit silently to strip comments. Denial with a reason teaches the retry; silent rewriting hides it.

## Development

```
npm test
```

Tests live in `tests/` at the repo root (not shipped with the plugin) and use `node:test`. CI runs them on Linux, macOS and Windows with Node 20 and 22.
