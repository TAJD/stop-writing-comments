# stop-writing-comments

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

When an edit is allowed but the file contains a comment block of three or more lines, Claude is nudged to offer you a shorter version.

## The rule

For each `Edit`, `Write` or `MultiEdit`, comment lines are counted in the old text and the new text:

| old | new | result |
|----:|----:|--------|
| 3 | 2 | allow |
| 3 | 3 | deny (rewrite in place) |
| 0 | 1 | deny |
| 2 | 0 | allow |
| 0 | 0 | allow, silent |

`Write` compares against the file on disk (empty for a new file). `MultiEdit` sums across its edits, so a batch that deletes three comments and adds one nets negative and passes. Net-down is the contract.

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

Environment variables, settable in `settings.json` under `"env"`:

| variable | values | default |
|----------|--------|---------|
| `STOP_WRITING_COMMENTS_MODE` | `deny`, `warn` (allow but log), `off` | `deny` |
| `STOP_WRITING_COMMENTS_LOG` | path; one tab-separated line per analysed edit | unset (no log) |

To switch it off for one project, disable the plugin in that project's `.claude/settings.json` `enabledPlugins`.

## Failure mode

The hook fails open. Malformed input, an unreadable file, an unknown extension, an exception: exit 0, no output, the edit proceeds. A bug in this hook never blocks you.

## Non-goals

- Judging comment *content*. Whether a surviving comment explains WHY rather than WHAT is still on you and your `CLAUDE.md`.
- Per-hunk accounting. If the netting loophole gets abused it can be tightened; so far it hasn't.
- Rewriting Claude's edit silently to strip comments. Denial with a reason teaches the retry; silent rewriting hides it.

## Development

```
npm test
```

Tests live in `tests/` at the repo root (not shipped with the plugin) and use `node:test`. CI runs them on Linux, macOS and Windows with Node 20 and 22.
