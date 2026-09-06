#!/usr/bin/env node
/**
 * Claude Code hook: deny Edit/Write/MultiEdit unless the net comment line
 * count decreases, and no hunk adds more comment lines than it removes.
 * Bash commands that rewrite source files in place are denied; every other
 * Bash command is audited afterwards against a git snapshot taken before it
 * ran. Comments are written by humans. Fails open on any error.
 * See README.md for the policy, exemptions and configuration.
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename, dirname, extname, join, resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = 'HUMAN-APPROVED';
export const CONFIG_FILE = join('.claude', 'stop-writing-comments.json');
const DIFF_LINE_CAP = 3000;

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
const REGEX_LITERAL_RE = /(?<=[=(,:!&|?[;]|^|\breturn\b)\s*\/(?:\\.|\[(?:\\.|[^\]\\])*]|[^/\\\n])+\/[a-z]*/g;
const HTML_PLACEHOLDER_RE = /^<!--\s*[\w.:-]+\s*-->$/;
const GO_DECL_RE = /^\s*(func|type|var|const|package)\b/;
const TRIPLE_RE = /"""|'''/g;
const DOC_LINE_RE = /^\s*(\/\/\/|\/\/!)/;

const state = { extraExtensions: {}, extraDirectives: [], skip: [] };

export function configure(cfg = {}) {
  state.extraExtensions = cfg.extensions && typeof cfg.extensions === 'object' ? cfg.extensions : {};
  state.extraDirectives = Array.isArray(cfg.directives)
    ? cfg.directives.filter((d) => typeof d === 'string').map((d) => new RegExp(d, 'i'))
    : [];
  state.skip = Array.isArray(cfg.skip) ? cfg.skip.filter((s) => typeof s === 'string') : [];
}

export function loadConfig(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, 'utf8'));
      } catch {
        return {};
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return {};
    dir = parent;
  }
}

export function familyFor(path) {
  const slashed = path.replace(/\\/g, '/');
  if (state.skip.some((s) => slashed.includes(s))) return null;
  const name = basename(path);
  if (SKIP_NAMES.has(name) || name.startsWith('.env')) return null;
  const byName = FAMILY_BY_NAME[name.toLowerCase()];
  if (byName) return byName;
  const ext = extname(path).slice(1).toLowerCase();
  return state.extraExtensions[ext] ?? FAMILY_BY_EXT.get(ext) ?? null;
}

const stripStrings = (line) => line.replace(STRING_RE, '""');
const splitLines = (text) => text.split(/\r?\n/);
const isDirective = (line) => DIRECTIVE_RE.test(line) || state.extraDirectives.some((re) => re.test(line));

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

function blockLines(lines, lineOpen, blockOpen, blockClose, docOpen = [], extraStrip = (x) => x) {
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
    const s = extraStrip(stripStrings(line));
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
      const stripRegex = (s) => s.replace(REGEX_LITERAL_RE, '""');
      let idx = blockLines(lines, '//', '/*', '*/', ['/**'], stripRegex).filter((i) => !DOC_LINE_RE.test(lines[i]));
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
  idx = idx.filter((i) => !isDirective(lines[i]));
  idx = idx.filter((i) => !HTML_PLACEHOLDER_RE.test(lines[i].trim()));
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

function diffOps(a, b) {
  const n = a.length;
  const m = b.length;
  const lcs = new Int32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[at(i, j)] = a[i] === b[j] ? lcs[at(i + 1, j + 1)] + 1 : Math.max(lcs[at(i + 1, j)], lcs[at(i, j + 1)]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push(['=', i, j]); i++; j++; }
    else if (j < m && (i >= n || lcs[at(i, j + 1)] >= lcs[at(i + 1, j)])) { ops.push(['+', i, j]); j++; }
    else { ops.push(['-', i, j]); i++; }
  }
  return ops;
}

export function hunkViolations(oldText, newText, path) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length > DIFF_LINE_CAP || b.length > DIFF_LINE_CAP) return [];
  const oldC = new Set(analyse(oldText, path));
  const newC = new Set(analyse(newText, path));
  const violations = [];
  let removed = 0;
  let added = [];
  const flush = () => {
    if (added.length > removed) violations.push(...added);
    removed = 0;
    added = [];
  };
  for (const [op, i, j] of diffOps(a, b)) {
    if (op === '=') flush();
    else if (op === '-' && oldC.has(i + 1)) removed++;
    else if (op === '+' && newC.has(j + 1)) added.push(j + 1);
  }
  flush();
  return violations;
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

const GUIDANCE =
  'Remove them — comments are written by humans. '
  + 'Put the explanation in the commit message or PR description instead. '
  + 'If a comment is genuinely essential, tell the user what you wanted to annotate and let them add it '
  + `(they can mark it ${MARKER} to exempt it).`;

export function decide(oldLines, newLines, mode, violations = []) {
  const netOk = newLines.length < oldLines.length || (oldLines.length === 0 && newLines.length === 0);
  if (netOk && violations.length === 0) return { action: 'allow', reason: '', wouldDeny: false };
  const parts = [];
  if (!netOk) {
    parts.push(`Net comment count must decrease (old ${oldLines.length}, new ${newLines.length}). `
      + `New/changed comments on lines ${ranges(newLines)} of the new text.`);
  }
  if (violations.length) {
    parts.push(`The change adds comment lines (lines ${ranges(violations)} of the new text) `
      + 'without removing at least as many in the same place.');
  }
  parts.push(GUIDANCE);
  return { action: mode === 'warn' ? 'allow' : 'deny', reason: parts.join(' '), wouldDeny: true };
}

const advisory = (blocks) =>
  `Existing large comment at lines ${blocks.map(([a, b]) => `${a}–${b}`).join(', ')}; `
  + 'offer the user a more concise version (net count must still decrease).';

const GIT_PLUMBING_RE = /^git\s+(checkout|switch|mv|restore|merge|rebase|cherry-pick|pull|reset|stash(\s+(apply|pop))?)\b/;
const IN_PLACE_RE = /(^|[\s;&|(])(sed\s+(-[a-zA-Z]*i|--in-place)|perl\s+-[a-zA-Z]*i)/m;
const INTERP_RE = /(^|[\s;&|(])(python3?|py|node|ruby|perl|pwsh|powershell)(\.exe)?\s+(-[ceE]\b|-Command\b|-\s*<<|<<)/m;
const WRITE_CALL_RE = /\b(writeFileSync|writeFile|write_text|write_bytes|Set-Content|Add-Content|Out-File|File\.write|IO\.write)\b|\bopen\([^)]*['"][wax]\+?b?['"]/;

const extAlternation = () =>
  [...new Set([...FAMILY_BY_EXT.keys(), ...Object.keys(state.extraExtensions)])].join('|');

export function isGitPlumbingOnly(command) {
  if (typeof command !== 'string') return false;
  const parts = command.split(/&&|\|\||;/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => GIT_PLUMBING_RE.test(p));
}

export function bashWriteIntent(command) {
  if (typeof command !== 'string') return null;
  const m = command.match(IN_PLACE_RE);
  if (m) return m[2].split(/\s+/).slice(0, 2).join(' ');
  const exts = extAlternation();
  const target = `["']?([^\\s"'|;&<>]+\\.(${exts}))(?=["']?(\\s|$|[;&|)]))`;
  const redirect = command.match(new RegExp(`(^|[^>&\\d<])>{1,2}\\s*${target}`, 'm'));
  if (redirect && familyFor(redirect[2]) !== null) return `redirect to ${redirect[2]}`;
  const tee = command.match(new RegExp(`(^|[\\s;&|(])tee\\s+(-[ai]\\s+)*${target}`, 'm'));
  if (tee && familyFor(tee[3]) !== null) return `tee ${tee[3]}`;
  if (INTERP_RE.test(command) && WRITE_CALL_RE.test(command)) return 'a script that writes a file';
  return null;
}

function gitOut(cwd, args, extra = {}) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10000, ...extra,
  }).trim();
}

const normalise = (s) => s.replace(/\r\n/g, '\n');

export function headBlobFor(path) {
  try {
    const fileDir = dirname(resolve(path));
    const prefix = gitOut(fileDir, ['rev-parse', '--show-prefix']);
    const rel = (prefix + basename(path)).replace(/\\/g, '/');
    return gitOut(fileDir, ['show', `HEAD:${rel}`]);
  } catch {
    return null;
  }
}

export function commentLineMovedFromElsewhere(cwd, text) {
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  try {
    const root = gitOut(cwd, ['rev-parse', '--show-toplevel']);
    gitOut(root, ['grep', '-F', '-q', '--', trimmed]);
    return true;
  } catch {
    return false;
  }
}

export function snapshotTree(cwd) {
  let root;
  let indexPath;
  try {
    root = gitOut(cwd, ['rev-parse', '--show-toplevel']);
    indexPath = resolve(cwd, gitOut(cwd, ['rev-parse', '--git-path', 'index']));
  } catch {
    return null;
  }
  const tmpIndex = join(tmpdir(), `swc-index-${process.pid}-${Date.now()}`);
  try {
    if (existsSync(indexPath)) copyFileSync(indexPath, tmpIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    gitOut(root, ['add', '-A', '--', '.'], { env });
    return gitOut(root, ['write-tree'], { env });
  } catch {
    return null;
  } finally {
    if (existsSync(tmpIndex)) unlinkSync(tmpIndex);
  }
}

export function auditChanges(cwd, tree) {
  let root;
  const changed = new Set();
  try {
    root = gitOut(cwd, ['rev-parse', '--show-toplevel']);
    for (const p of gitOut(root, ['diff-index', '--name-only', tree]).split('\n')) if (p) changed.add(p);
    for (const p of gitOut(root, ['ls-files', '--others', '--exclude-standard']).split('\n')) if (p) changed.add(p);
  } catch {
    return [];
  }
  const out = [];
  for (const rel of [...changed].sort()) {
    const abs = join(root, rel);
    if (familyFor(abs) === null || !existsSync(abs) || !statSync(abs).isFile()) continue;
    let oldText = '';
    try {
      oldText = execFileSync('git', ['show', `${tree}:${rel}`], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 4000,
      });
    } catch {
      oldText = '';
    }
    const newText = readFileSync(abs, 'utf8');
    if (normalise(oldText) === normalise(newText)) continue;
    const oldLines = analyse(oldText, abs);
    const newLines = analyse(newText, abs);
    const violations = hunkViolations(oldText, newText, abs);
    if (newLines.length <= oldLines.length && violations.length === 0) continue;
    out.push({ path: rel, lines: violations.length ? violations : newLines });
  }
  return out;
}

const snapshotFile = (session) =>
  join(tmpdir(), 'stop-writing-comments', `${String(session || 'default').replace(/[^\w.-]/g, '_')}.json`);

function preBash(data, mode) {
  const command = data.tool_input?.command;
  if (typeof command !== 'string') return;
  const cwd = data.cwd || process.cwd();
  const intent = bashWriteIntent(command);
  if (intent) {
    log(process.env.STOP_WRITING_COMMENTS_LOG, 'bash', 0, 0, mode === 'warn' ? 'warn-deny' : 'deny');
    if (mode === 'warn') return;
    const reason = `This command edits files in place (${intent}). `
      + 'File edits go through Edit/Write so the comment policy can see them; use those tools instead.';
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
    } }) + '\n');
    return;
  }
  if (isGitPlumbingOnly(command)) return;
  const file = snapshotFile(data.session_id);
  const tree = existsSync(cwd) ? snapshotTree(cwd) : null;
  if (tree) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ tree, cwd }));
  } else if (existsSync(file)) {
    unlinkSync(file);
  }
}

function postBash(data, mode) {
  const file = snapshotFile(data.session_id);
  if (!existsSync(file)) return;
  let snap;
  try {
    snap = JSON.parse(readFileSync(file, 'utf8'));
  } finally {
    unlinkSync(file);
  }
  const cwd = data.cwd || snap.cwd;
  const found = auditChanges(cwd, snap.tree);
  if (!found.length) return;
  const outcome = mode === 'warn' ? 'warn-deny' : 'deny';
  for (const f of found) log(process.env.STOP_WRITING_COMMENTS_LOG, f.path, 0, f.lines.length, outcome);
  if (mode === 'warn') return;
  const list = found.map((f) => `${f.path} (line${f.lines.length > 1 ? 's' : ''} ${ranges(f.lines)})`).join('; ');
  const reason = `The command added comment lines to ${list}. ${GUIDANCE} Revert them with Edit before continuing.`;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
}

function relaxForMovedOrRestoredComments(decision, newLines, newText, path, cwd, isNewFile) {
  if (newLines.length === 0) return decision;
  const nSplit = splitLines(newText);
  const headText = isNewFile ? null : headBlobFor(path);
  if (headText !== null) {
    const headLineSet = new Set(splitLines(normalise(headText)));
    if (newLines.every((ln) => headLineSet.has(nSplit[ln - 1]))) {
      return { action: 'allow', reason: '', wouldDeny: false };
    }
  }
  if (isNewFile && newLines.every((ln) => commentLineMovedFromElsewhere(cwd, nSplit[ln - 1]))) {
    return { action: 'allow', reason: '', wouldDeny: false };
  }
  return decision;
}

function oldNew(tool, inp) {
  const path = inp.file_path;
  if (tool === 'Write') return [[existsSync(path) ? readFileSync(path, 'utf8') : '', inp.content]];
  if (tool === 'MultiEdit') return inp.edits.map((e) => [e.old_string, e.new_string]);
  return [[inp.old_string, inp.new_string]];
}

function log(path, file, oldN, newN, outcome) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${new Date().toISOString()}\t${file}\t${oldN}\t${newN}\t${outcome}\n`);
}

export function main() {
  const data = JSON.parse(readFileSync(0, 'utf8'));
  const tool = data?.tool_name;
  if (tool === 'Bash') {
    const cfg = loadConfig(data.cwd || process.cwd());
    configure(cfg);
    const mode = (process.env.STOP_WRITING_COMMENTS_MODE || cfg.mode || 'deny').toLowerCase();
    if (mode === 'off') return;
    return data.hook_event_name === 'PostToolUse' ? postBash(data, mode) : preBash(data, mode);
  }
  if (!['Edit', 'Write', 'MultiEdit'].includes(tool)) return;
  const inp = data.tool_input || {};
  const path = inp.file_path;
  if (!path) return;

  const cfg = loadConfig(data.cwd || dirname(resolve(path)));
  configure(cfg);
  const mode = (process.env.STOP_WRITING_COMMENTS_MODE || cfg.mode || 'deny').toLowerCase();
  if (mode === 'off' || familyFor(path) === null) return;

  const pairs = oldNew(tool, inp);
  if (pairs.some(([o, n]) => typeof o !== 'string' || typeof n !== 'string')) return;
  const cwd = data.cwd || dirname(resolve(path));
  const isNewFile = tool === 'Write' && !existsSync(path);
  const perEdit = pairs.map(([o, n]) => {
    const oldLines = analyse(o, path);
    const newLines = analyse(n, path);
    let decision = decide(oldLines, newLines, mode, hunkViolations(o, n, path));
    if (decision.wouldDeny) decision = relaxForMovedOrRestoredComments(decision, newLines, n, path, cwd, isNewFile);
    return { oldLines, newLines, decision };
  });
  const oldLines = perEdit.flatMap((e) => e.oldLines);
  const newLines = perEdit.flatMap((e) => e.newLines);
  const failing = perEdit.find((e) => e.decision.wouldDeny);
  const d = failing ? failing.decision : { action: 'allow', reason: '', wouldDeny: false };

  const touchesComments = oldLines.length > 0 || newLines.length > 0;
  let fileText = tool === 'Write' ? pairs[0][0] : null;
  if (fileText === null && existsSync(path) && statSync(path).isFile()) fileText = readFileSync(path, 'utf8');
  const blocks = touchesComments && fileText ? largeBlocks(fileText, path) : [];

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
