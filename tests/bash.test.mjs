import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as hook from '../stop-writing-comments/hooks/stop-writing-comments.mjs';
const { bashWriteIntent, isGitPlumbingOnly, snapshotTree, auditChanges } = hook;

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'stop-writing-comments', 'hooks', 'stop-writing-comments.mjs');

const tmp = () => mkdtempSync(join(tmpdir(), 'swc-bash-'));
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function repo() {
  const d = tmp();
  git(d, 'init', '-q');
  git(d, 'config', 'user.email', 't@example.com');
  git(d, 'config', 'user.name', 't');
  git(d, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(d, 'a.py'), 'x = 1  # why\ny = 2\n');
  writeFileSync(join(d, 'notes.md'), '<!-- md is never analysed -->\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'init');
  return d;
}

function run(payload, env = {}) {
  const e = { ...process.env, STOP_WRITING_COMMENTS_LOG: '' };
  delete e.STOP_WRITING_COMMENTS_MODE;
  Object.assign(e, env);
  const r = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(payload), encoding: 'utf8', env: e });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

let seq = 0;
const bash = (command, cwd, event = 'PreToolUse', session) =>
  ({ hook_event_name: event, session_id: session, cwd, tool_name: 'Bash', tool_input: { command } });
const session = () => `swc-test-${process.pid}-${++seq}`;

const writeCommands = [
  "sed -i 's/a/b/' src/a.py",
  "sed -i'' -e 's/a/b/' a.ts",
  "sed --in-place 's/a/b/' a.rs",
  "perl -pi -e 's/a/b/' lib/a.ex",
  'echo "x = 1" > src/a.py',
  "printf '%s\\n' x >> lib/a.ex",
  "cat <<'EOF' > a.ts\nconst x = 1;\nEOF",
  'tee src/a.go <<EOF\npackage x\nEOF',
  "python - <<'PY'\nopen('a.py', 'w').write('x')\nPY",
  'python -c "from pathlib import Path; Path(\'a.py\').write_text(\'x\')"',
  'node -e "require(\'fs\').writeFileSync(\'a.js\', \'x\')"',
  'pwsh -c "Set-Content a.ps1 \'x\'"',
  'pwsh -c "\'x\' | Out-File a.ps1"',
  'ruby -e "File.write(\'a.rb\', \'x\')"',
  'echo x > /tmp/a.py; echo y > src/b.py',
  'echo x > /tmp/../repo/a.py',
  "sed -i 's/a/b/' /tmp/a.py",
];

const readCommands = [
  'git status',
  'pnpm test',
  'echo hi > out.txt',
  'cmd 2>&1 | tee log.txt',
  'cat a.py',
  'grep -n "# x" a.py',
  "sed -n '1,5p' a.py",
  'node script.mjs > /dev/null',
  "python - <<'PY'\nprint(open('a.py').read())\nPY",
  "echo 'a -> b'",
  'git diff HEAD >/dev/null',
  'npm run build 2> err.log',
  'ls src/*.py',
  "cat > \"$TMPDIR/x.py\" <<'EOF'\nx = 1  # scratch\nEOF",
  'echo x > ${TMPDIR}/a.ts',
  'echo x > /tmp/a.py',
  'tee -a $TEMP/notes.sh <<EOF\nls\nEOF',
  `echo x > "${tmpdir()}${tmpdir().includes('\\') ? '\\' : '/'}claude${tmpdir().includes('\\') ? '\\' : '/'}a.py"`,
  `echo x > ${tmpdir().replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)}/s/a.ex`,
];

for (const c of writeCommands) {
  test(`bashWriteIntent flags: ${c.split('\n')[0]}`, () => {
    assert.equal(typeof bashWriteIntent(c), 'string');
  });
}

for (const c of readCommands) {
  test(`bashWriteIntent allows: ${c.split('\n')[0]}`, () => {
    assert.equal(bashWriteIntent(c), null);
  });
}

test('bashWriteIntent honours configured extensions', () => {
  assert.equal(bashWriteIntent('echo x > a.nix'), null);
  hook.configure({ extensions: { nix: 'hash' } });
  assert.equal(typeof bashWriteIntent('echo x > a.nix'), 'string');
  hook.configure({});
});

test('main: pre bash with in-place edit denies and redirects to Edit/Write', () => {
  const r = run(bash("sed -i 's/a/b/' a.py", tmp()));
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /Edit/);
  assert.match(out.permissionDecisionReason, /sed -i/);
});

test('main: pre bash read-only command is silent', () => {
  const r = run(bash('git status', tmp()));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('main: pre bash in-place edit allowed in warn mode', () => {
  const r = run(bash("sed -i 's/a/b/' a.py", tmp()), { STOP_WRITING_COMMENTS_MODE: 'warn' });
  assert.equal(r.stdout, '');
});

test('main: pre bash in-place edit ignored in off mode', () => {
  const r = run(bash("sed -i 's/a/b/' a.py", tmp()), { STOP_WRITING_COMMENTS_MODE: 'off' });
  assert.equal(r.stdout, '');
});

test('snapshotTree returns null outside a git repo', () => {
  assert.equal(snapshotTree(tmp()), null);
});

test('snapshotTree returns a tree id and a clean audit', () => {
  const d = repo();
  const tree = snapshotTree(d);
  assert.match(tree, /^[0-9a-f]{40,64}$/);
  assert.deepEqual(auditChanges(d, tree), []);
});

test('audit flags a comment added to a tracked file', () => {
  const d = repo();
  const tree = snapshotTree(d);
  writeFileSync(join(d, 'a.py'), 'x = 1  # why\n# new\ny = 2\n');
  const v = auditChanges(d, tree);
  assert.equal(v.length, 1);
  assert.equal(v[0].path, 'a.py');
  assert.deepEqual(v[0].lines, [2]);
});

test('audit ignores a same-count reflow', () => {
  const d = repo();
  const tree = snapshotTree(d);
  writeFileSync(join(d, 'a.py'), 'x = 1  # why indeed\ny = 2\n');
  assert.deepEqual(auditChanges(d, tree), []);
});

test('audit ignores a touch that leaves content unchanged', () => {
  const d = repo();
  const tree = snapshotTree(d);
  writeFileSync(join(d, 'a.py'), 'x = 1  # why\ny = 2\n');
  assert.deepEqual(auditChanges(d, tree), []);
});

test('audit flags a comment moved to a hunk that removed none', () => {
  const d = repo();
  writeFileSync(join(d, 'a.py'), '# top\nx = 1\ny = 2\nz = 3\nw = 4\n');
  git(d, 'commit', '-qam', 'top');
  const tree = snapshotTree(d);
  writeFileSync(join(d, 'a.py'), 'x = 1\ny = 2\nz = 3\nw = 4\n# bottom\n');
  const v = auditChanges(d, tree);
  assert.equal(v.length, 1);
  assert.deepEqual(v[0].lines, [5]);
});

test('audit sees pre-existing untracked files', () => {
  const d = repo();
  writeFileSync(join(d, 'b.ts'), '// one\nconst a = 1;\n');
  const tree = snapshotTree(d);
  writeFileSync(join(d, 'b.ts'), '// one\nconst a = 1;\nconst b = 2;\n');
  assert.deepEqual(auditChanges(d, tree), []);
  writeFileSync(join(d, 'b.ts'), '// one\nconst a = 1;\n// two\n');
  assert.deepEqual(auditChanges(d, tree).map((v) => v.path), ['b.ts']);
});

test('audit flags a new file that contains comments', () => {
  const d = repo();
  const tree = snapshotTree(d);
  writeFileSync(join(d, 'c.rs'), 'fn main() {}\n');
  assert.deepEqual(auditChanges(d, tree), []);
  writeFileSync(join(d, 'c.rs'), '// why\nfn main() {}\n');
  assert.deepEqual(auditChanges(d, tree).map((v) => v.path), ['c.rs']);
});

test('audit does not blame uncommitted comments that predate the snapshot', () => {
  const d = repo();
  writeFileSync(join(d, 'a.py'), 'x = 1  # why\n# human\ny = 2\n');
  const tree = snapshotTree(d);
  writeFileSync(join(d, 'a.py'), 'x = 1  # why\n# human\ny = 2\nz = 3\n');
  assert.deepEqual(auditChanges(d, tree), []);
});

test('audit ignores deleted, ignored and non-source files', () => {
  const d = repo();
  writeFileSync(join(d, '.gitignore'), 'build/\n');
  const tree = snapshotTree(d);
  unlinkSync(join(d, 'a.py'));
  writeFileSync(join(d, 'notes.md'), '<!-- more -->\n<!-- md -->\n');
  writeFileSync(join(d, 'build'), '');
  assert.deepEqual(auditChanges(d, tree), []);
});

test('audit paths are repo-relative from a nested cwd', () => {
  const d = repo();
  const nested = join(d, 'pkg');
  execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(nested)})`]);
  const tree = snapshotTree(nested);
  writeFileSync(join(nested, 'n.py'), '# nested\n');
  assert.deepEqual(auditChanges(nested, tree).map((v) => v.path), ['pkg/n.py']);
});

test('audit does not blame a file too large for the default git show buffer', () => {
  const d = repo();
  const big = '// existing\n' + 'const x = 1;\n'.repeat(200_000);
  writeFileSync(join(d, 'big.ts'), big);
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'big');
  const tree = snapshotTree(d);
  writeFileSync(join(d, 'big.ts'), big + 'const y = 2;\n');
  assert.deepEqual(auditChanges(d, tree), []);
});

test('main: post bash blocks when the command added comments', () => {
  const d = repo();
  const s = session();
  assert.equal(run(bash('some-formatter a.py', d, 'PreToolUse', s)).stdout, '');
  writeFileSync(join(d, 'a.py'), 'x = 1  # why\n# added by script\ny = 2\n');
  const r = run(bash('some-formatter a.py', d, 'PostToolUse', s));
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /a\.py/);
  assert.match(out.reason, /line 2/);
  assert.match(out.reason, /written by humans/);
  assert.match(out.reason, /Edit/);
});

test('main: post bash is silent when nothing changed and the snapshot is consumed', () => {
  const d = repo();
  const s = session();
  run(bash('git status', d, 'PreToolUse', s));
  assert.equal(run(bash('git status', d, 'PostToolUse', s)).stdout, '');
  writeFileSync(join(d, 'a.py'), '# late\n');
  assert.equal(run(bash('git status', d, 'PostToolUse', s)).stdout, '');
});

test('main: post bash without a prior snapshot is silent', () => {
  const d = repo();
  writeFileSync(join(d, 'a.py'), '# orphan\n');
  assert.equal(run(bash('x', d, 'PostToolUse', session())).stdout, '');
});

test('main: post bash in warn mode does not block', () => {
  const d = repo();
  const s = session();
  const env = { STOP_WRITING_COMMENTS_MODE: 'warn' };
  run(bash('x', d, 'PreToolUse', s), env);
  writeFileSync(join(d, 'a.py'), '# warn\n');
  assert.equal(run(bash('x', d, 'PostToolUse', s), env).stdout, '');
});

test('main: post bash outside a git repo is silent', () => {
  const d = tmp();
  const s = session();
  run(bash('x', d, 'PreToolUse', s));
  writeFileSync(join(d, 'a.py'), '# nowhere\n');
  assert.equal(run(bash('x', d, 'PostToolUse', s)).stdout, '');
  rmSync(d, { recursive: true, force: true });
});

const plumbingCommands = [
  'git checkout main',
  'git checkout -b feature',
  'git mv a.py b.py',
  'git switch main',
  'git restore a.py',
  'git stash pop',
  'git checkout main && git checkout -b feature',
];

for (const c of plumbingCommands) {
  test(`isGitPlumbingOnly recognises: ${c}`, () => {
    assert.equal(isGitPlumbingOnly(c), true);
  });
}

const nonPlumbingCommands = [
  'git commit -m "x"',
  'echo "// x" >> a.ts',
  'git checkout main && echo "// x" >> a.ts',
  'pnpm test',
];

for (const c of nonPlumbingCommands) {
  test(`isGitPlumbingOnly rejects: ${c}`, () => {
    assert.equal(isGitPlumbingOnly(c), false);
  });
}

test('main: git checkout revealing pre-existing comments is not flagged', () => {
  const d = repo();
  git(d, 'branch', 'other');
  git(d, 'checkout', '-q', 'other');
  writeFileSync(join(d, 'a.py'), 'x = 1  # why\n# newly visible on this branch\ny = 2\n');
  git(d, 'commit', '-qam', 'other branch content');
  git(d, 'checkout', '-q', 'master');
  const s = session();
  run(bash('git checkout other', d, 'PreToolUse', s));
  git(d, 'checkout', '-q', 'other');
  assert.equal(run(bash('git checkout other', d, 'PostToolUse', s)).stdout, '');
});

test('main: pre bash snapshot leaves the real index untouched', () => {
  const d = repo();
  writeFileSync(join(d, 'u.py'), 'u = 1\n');
  run(bash('x', d, 'PreToolUse', session()));
  assert.equal(git(d, 'status', '--porcelain'), '?? u.py');
});

test('main: post bash is silent when cwd moved to a different worktree (DEV-57)', () => {
  const d = repo();
  git(d, 'branch', 'other');
  const wt = join(dirname(d), `swc-wt-${process.pid}-${++seq}`);
  git(d, 'worktree', 'add', '-q', wt, 'other');
  const s = session();
  run(bash('git log --oneline', d, 'PreToolUse', s));
  const r = run(bash('git status -sb', wt, 'PostToolUse', s));
  assert.equal(r.stdout, '');
  git(d, 'worktree', 'remove', '--force', wt);
});

test('main: post bash is silent when a mixed command moves HEAD to another branch (DEV-57)', () => {
  const d = repo();
  git(d, 'branch', 'other');
  git(d, 'checkout', '-q', 'other');
  writeFileSync(join(d, 'a.py'), 'x = 1  # why\n# pre-existing on other\ny = 2\n');
  git(d, 'commit', '-qam', 'other branch content');
  git(d, 'checkout', '-q', 'master');
  const s = session();
  run(bash('git status -sb', d, 'PreToolUse', s));
  git(d, 'checkout', '-q', 'other');
  const r = run(bash('git status -sb && git fetch && git checkout other', d, 'PostToolUse', s));
  assert.equal(r.stdout, '');
});

test('main: post bash still blocks when the tree and HEAD have not moved (DEV-57)', () => {
  const d = repo();
  const s = session();
  run(bash('npm run fake-codegen', d, 'PreToolUse', s));
  writeFileSync(join(d, 'a.py'), 'x = 1  # why\n# added by fake codegen\ny = 2\n');
  const r = run(bash('npm run fake-codegen', d, 'PostToolUse', s));
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /a\.py/);
});
