#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: deny Edit/Write/MultiEdit unless the net
 * comment line count decreases. Comments are written by humans.
 * Fails open on any error. See README.md for the policy and exemptions.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = 'HUMAN-APPROVED';

const FAMILY_BY_EXT = new Map();
for (const e of 'py rb ex exs sh bash zsh yaml yml toml tf pl'.split(' ')) FAMILY_BY_EXT.set(e, 'hash');
for (const e of 'ts tsx js jsx mjs cjs go rs java kt swift c h cpp cs php css scss'.split(' ')) FAMILY_BY_EXT.set(e, 'slash');
for (const e of 'sql lua'.split(' ')) FAMILY_BY_EXT.set(e, 'dash');
for (const e of 'html xml'.split(' ')) FAMILY_BY_EXT.set(e, 'xml');
FAMILY_BY_EXT.set('ps1', 'ps1');
const FAMILY_BY_NAME = { dockerfile: 'hash', makefile: 'hash' };
const SKIP_NAMES = new Set(['.gitignore', '.gitattributes', '.dockerignore', '.npmrc', '.editorconfig']);

const DIRECTIVE_RE = new RegExp(
  'noqa|type:\\s*ignore|pyright:|eslint-|@ts-|biome-ignore|prettier-ignore|credo:disable'
  + '|shellcheck disable|checkov:skip|tflint-ignore|hadolint ignore|pragma|fmt:\\s*(off|on)'
  + '|^\\s*#\\s*syntax=|cofferdam-ignore|-\\*-\\s*coding|' + MARKER,
  'i',
);
const LICENSE_RE = /copyright|licen[sc]e|SPDX/i;
const STRING_RE = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;
const GO_DECL_RE = /^\s*(func|type|var|const|package)\b/;
const TRIPLE_RE = /"""|'''/g;
const DOC_LINE_RE = /^\s*(\/\/\/|\/\/!)/;

export function familyFor(path) {
  const name = basename(path);
  if (SKIP_NAMES.has(name) || name.startsWith('.env')) return null;
  const byName = FAMILY_BY_NAME[name.toLowerCase()];
  if (byName) return byName;
  return FAMILY_BY_EXT.get(extname(path).slice(1).toLowerCase()) ?? null;
}

const stripStrings = (line) => line.replace(STRING_RE, '""');
const splitLines = (text) => text.split(/\r?\n/);

function hashLines(lines) {
  const out = [];
  let inTriple = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inTriple) {
      if (TRIPLE_RE.test(line)) inTriple = false;
      TRIPLE_RE.lastIndex = 0;
      continue;
    }
    const n = (line.match(TRIPLE_RE) || []).length;
    if (n % 2 === 1) {
      inTriple = true;
      continue;
    }
    if (stripStrings(line).includes('#')) out.push(i);
  }
  return out;
}

function blockLines(lines, lineOpen, blockOpen, blockClose, docOpen = []) {
  const out = [];
  let inBlock = false;
  let doc = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBlock) {
      if (!doc) out.push(i);
      if (line.includes(blockClose)) inBlock = false;
      continue;
    }
    const s = stripStrings(line);
    const start = s.indexOf(blockOpen);
    if (start !== -1) {
      doc = docOpen.some((d) => s.startsWith(d, start));
      if (!s.slice(start + blockOpen.length).includes(blockClose)) inBlock = true;
      if (!doc) out.push(i);
      continue;
    }
    if (lineOpen && s.includes(lineOpen)) out.push(i);
  }
  return out;
}

function dropGoDocComments(idx, lines) {
  const set = new Set(idx);
  return idx.filter((i) => {
    let j = i;
    while (set.has(j + 1)) j++;
    const next = lines[j + 1];
    return !(next !== undefined && GO_DECL_RE.test(next));
  });
}

function dropLicenseHeader(idx, lines) {
  const run = [];
  for (const i of idx) {
    if (run.length === 0 ? i <= 1 : i === run[run.length - 1] + 1) run.push(i);
    else break;
  }
  if (run.length && run.some((i) => LICENSE_RE.test(lines[i]))) {
    const drop = new Set(run);
    return idx.filter((i) => !drop.has(i));
  }
  return idx;
}

function rawCommentLines(text, path) {
  const fam = familyFor(path);
  const lines = splitLines(text);
  const ext = extname(path).slice(1).toLowerCase();
  switch (fam) {
    case 'hash':
      return hashLines(lines);
    case 'slash': {
      let idx = blockLines(lines, '//', '/*', '*/', ['/**']).filter((i) => !DOC_LINE_RE.test(lines[i]));
      if (ext === 'go') idx = dropGoDocComments(idx, lines);
      return idx;
    }
    case 'dash':
      return lines.map((l, i) => (stripStrings(l).includes('--') ? i : -1)).filter((i) => i >= 0);
    case 'xml':
      return blockLines(lines, null, '<!--', '-->');
    case 'ps1':
      return blockLines(lines, '#', '<#', '#>');
    default:
      return [];
  }
}

export function analyse(text, path) {
  const lines = splitLines(text);
  let idx = rawCommentLines(text, path);
  idx = idx.filter((i) => !(i === 0 && lines[i].startsWith('#!')));
  idx = idx.filter((i) => !DIRECTIVE_RE.test(lines[i]));
  idx = dropLicenseHeader(idx, lines);
  return idx.map((i) => i + 1);
}

export function largeBlocks(text, path, minLines = 3) {
  const blocks = [];
  let run = [];
  for (const n of analyse(text, path)) {
    if (run.length && n === run[run.length - 1] + 1) run.push(n);
    else {
      if (run.length >= minLines) blocks.push([run[0], run[run.length - 1]]);
      run = [n];
    }
  }
  if (run.length >= minLines) blocks.push([run[0], run[run.length - 1]]);
  return blocks;
}

function ranges(nums) {
  const parts = [];
  let start = null;
  let prev = null;
  const flush = () => parts.push(start === prev ? String(start) : `${start}–${prev}`);
  for (const n of nums) {
    if (start === null) { start = prev = n; }
    else if (n === prev + 1) prev = n;
    else { flush(); start = prev = n; }
  }
  if (start !== null) flush();
  return parts.join(', ');
}

export function decide(oldLines, newLines, mode) {
  if (oldLines.length === 0 && newLines.length === 0) return { action: 'allow', reason: '', wouldDeny: false };
  if (newLines.length < oldLines.length) return { action: 'allow', reason: '', wouldDeny: false };
  const reason =
    `Net comment count must decrease (old ${oldLines.length}, new ${newLines.length}). `
    + `New/changed comments on lines ${ranges(newLines)} of the new text. `
    + 'Remove them — comments are written by humans. '
    + 'Put the explanation in the commit message or PR description instead. '
    + 'If a comment is genuinely essential, tell the user what you wanted to annotate and let them add it '
    + `(they can mark it ${MARKER} to exempt it).`;
  return { action: mode === 'warn' ? 'allow' : 'deny', reason, wouldDeny: true };
}

const advisory = (blocks) =>
  `Existing large comment at lines ${blocks.map(([a, b]) => `${a}–${b}`).join(', ')}; `
  + 'offer the user a more concise version (net count must still decrease).';

function readFile(path) {
  return readFileSync(path, 'utf8');
}

function oldNew(tool, inp) {
  const path = inp.file_path;
  if (tool === 'Write') {
    const old = existsSync(path) ? readFile(path) : '';
    return [[old, inp.content]];
  }
  if (tool === 'MultiEdit') return inp.edits.map((e) => [e.old_string, e.new_string]);
  return [[inp.old_string, inp.new_string]];
}

function log(path, file, oldN, newN, outcome) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${new Date().toISOString()}\t${file}\t${oldN}\t${newN}\t${outcome}\n`);
}

export function main() {
  const mode = (process.env.STOP_WRITING_COMMENTS_MODE || 'deny').toLowerCase();
  if (mode === 'off') return;
  const data = JSON.parse(readFileSync(0, 'utf8'));
  const tool = data?.tool_name;
  if (!['Edit', 'Write', 'MultiEdit'].includes(tool)) return;
  const inp = data.tool_input || {};
  const path = inp.file_path;
  if (!path || familyFor(path) === null) return;
  const pairs = oldNew(tool, inp);
  if (pairs.some(([o, n]) => typeof o !== 'string' || typeof n !== 'string')) return;
  const oldLines = pairs.flatMap(([o]) => analyse(o, path));
  const newLines = pairs.flatMap(([, n]) => analyse(n, path));
  const d = decide(oldLines, newLines, mode);

  let fileText = tool === 'Write' ? pairs[0][0] : null;
  if (fileText === null && existsSync(path) && statSync(path).isFile()) fileText = readFile(path);
  const blocks = fileText ? largeBlocks(fileText, path) : [];

  const outcome = d.wouldDeny && d.action === 'allow' ? 'warn-deny' : d.action;
  log(process.env.STOP_WRITING_COMMENTS_LOG, path, oldLines.length, newLines.length, outcome);

  const out = { hookEventName: 'PreToolUse' };
  if (d.action === 'deny') {
    out.permissionDecision = 'deny';
    out.permissionDecisionReason = d.reason + (blocks.length ? ' ' + advisory(blocks) : '');
  } else if (blocks.length) {
    out.permissionDecision = 'allow';
    out.additionalContext = advisory(blocks);
  } else {
    return;
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }) + '\n');
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (invokedDirectly) {
  try {
    main();
  } catch {
    process.exitCode = 0;
  }
}
