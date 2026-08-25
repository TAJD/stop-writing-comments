import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as hook from '../stop-writing-comments/hooks/stop-writing-comments.mjs';
const { analyse, decide, largeBlocks } = hook;

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'stop-writing-comments', 'hooks', 'stop-writing-comments.mjs');

const tmp = () => mkdtempSync(join(tmpdir(), 'swc-'));

const analyseCases = [
  ['// a\n// b\n// c\nconst x = 1;\n', 'a.ts', [1, 2, 3]],
  ['const x = 1; // trailing why\n', 'a.ts', [1]],
  ['/* one\n two\n three */\nlet y;\n', 'a.ts', [1, 2, 3]],
  ['/**\n * jsdoc\n */\nfunction f() {}\n', 'a.ts', []],
  ['const u = \'http://x.com\';\nconst v = "a // b";\n', 'a.ts', []],
  ['// eslint-disable-next-line\n// @ts-expect-error\n// biome-ignore lint: x\n// prettier-ignore\n// cofferdam-ignore Foo\n', 'a.ts', []],
  ['/// doc\n//! crate doc\n// plain\n', 'a.rs', [3]],
  ['// Foo does things.\nfunc Foo() {}\n\n// stray\nx := 1\n', 'a.go', [4]],
  ['a { color: red; } /* why */\n', 'a.css', [1]],
  ['#!/usr/bin/env python\n# -*- coding: utf-8 -*-\nx = 1  # what\n', 'a.py', [3]],
  ['def f():\n    """docstring\n    # not a comment\n    """\n    return 1\n', 'a.py', []],
  ["x = '#nope'\ny = 2  # noqa\nz = 3  # type: ignore\n", 'a.py', []],
  ['    # indented fragment\n    if x:\n        pass\n', 'a.py', [1]],
  ['foo(\n    # inside\n    1,\n', 'a.py', [2]],
  ['s = f"{x}#tag"\n', 'a.py', []],
  ['@moduledoc """\n# heading in doc\n"""\n# real\n', 'a.ex', [4]],
  ['# shellcheck disable=SC2086\n# real\necho hi\n', 'a.sh', [2]],
  ['# syntax=docker/dockerfile:1\n# hadolint ignore=DL3008\n# real\nFROM x\n', 'Dockerfile', [3]],
  ['key: 1 # why\n# top\n', 'a.yml', [1, 2]],
  ['SELECT 1; -- why\n-- top\n', 'a.sql', [1, 2]],
  ['<!-- one\n two -->\n<p>x</p>\n', 'a.html', [1, 2]],
  ['<# block\n more #>\n# line\nWrite-Host 1\n', 'a.ps1', [1, 2, 3]],
  ['# HUMAN-APPROVED keep this\n# other\n', 'a.py', [2]],
  ['// Copyright 2026 Foo\n// Licensed under MIT\n\n// real\n', 'a.ts', [4]],
  ['# pragma once-ish\n', 'a.py', []],
  ['# comment\n', 'a.md', []],
  ['# comment\n', '.gitignore', []],
  ['# comment\n', '.env.local', []],
  ['# comment\n', 'noext', []],
  ['', 'a.py', []],
];

for (const [text, path, expected] of analyseCases) {
  test(`analyse ${path}: ${JSON.stringify(text).slice(0, 40)}`, () => {
    assert.deepEqual(analyse(text, path), expected);
  });
}

test('largeBlocks finds runs', () => {
  assert.deepEqual(largeBlocks('// a\n// b\n// c\nx\n// d\n// e\ny\n', 'a.ts'), [[1, 3]]);
});

test('largeBlocks ignores docstrings', () => {
  assert.deepEqual(largeBlocks('def f():\n    """\n    a\n    b\n    c\n    """\n', 'a.py'), []);
});

const decideCases = [
  [[1, 2, 3], [1, 2], 'allow'],
  [[1, 2, 3], [1, 2, 3], 'deny'],
  [[], [1], 'deny'],
  [[1, 2], [], 'allow'],
  [[], [], 'allow'],
  [[1], [1], 'deny'],
];

for (const [o, n, action] of decideCases) {
  test(`decide old=${o.length} new=${n.length} -> ${action}`, () => {
    assert.equal(decide(o, n, 'deny').action, action);
  });
}

test('decide deny reason names new lines and redirects explanation to commits/PRs', () => {
  const d = decide([], [3, 4, 5, 9], 'deny');
  assert.equal(d.action, 'deny');
  assert.ok(d.reason.includes('3–5') && d.reason.includes('9'));
  assert.ok(d.reason.includes('written by humans'));
  assert.ok(d.reason.includes('commit message'));
  assert.ok(d.reason.includes('PR description'));
});

test('decide warn mode allows but flags', () => {
  const d = decide([], [1], 'warn');
  assert.equal(d.action, 'allow');
  assert.equal(d.wouldDeny, true);
});

test('decide no comments is silent allow', () => {
  const d = decide([], [], 'deny');
  assert.equal(d.action, 'allow');
  assert.equal(d.wouldDeny, false);
});

function run(payload, env = {}, raw) {
  const e = { ...process.env, STOP_WRITING_COMMENTS_LOG: '' };
  delete e.STOP_WRITING_COMMENTS_MODE;
  Object.assign(e, env);
  const input = raw !== undefined ? raw : JSON.stringify(payload);
  const r = spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', env: e });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const edit = (path, old, nu, tool = 'Edit') =>
  ({ tool_name: tool, tool_input: { file_path: path, old_string: old, new_string: nu } });

const outOf = (r) => JSON.parse(r.stdout).hookSpecificOutput;

test('main: edit adding comment denies', () => {
  const r = run(edit(join(tmp(), 'a.ts'), 'x = 1;', 'x = 1; // what\n'));
  assert.equal(r.code, 0);
  const out = outOf(r);
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.ok(out.permissionDecisionReason.includes('written by humans'));
});

test('main: edit removing comment allows silently', () => {
  const p = join(tmp(), 'a.ts');
  writeFileSync(p, 'x = 1;\n');
  const r = run(edit(p, '// a\n// b\nx', '// a\nx'));
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('main: same-count rewrite denies', () => {
  const r = run(edit(join(tmp(), 'a.py'), '# old\nx = 1', '# new\nx = 1'));
  assert.equal(outOf(r).permissionDecision, 'deny');
});

test('main: write new file with license header only allows', () => {
  const r = run({ tool_name: 'Write', tool_input: { file_path: join(tmp(), 'n.ts'), content: '// Copyright 2026\n// MIT License\nexport {};\n' } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('main: write new file with comment denies', () => {
  const r = run({ tool_name: 'Write', tool_input: { file_path: join(tmp(), 'n.ts'), content: '// what\nexport {};\n' } });
  assert.equal(outOf(r).permissionDecision, 'deny');
});

test('main: write existing file with fewer comments allows', () => {
  const p = join(tmp(), 'e.py');
  writeFileSync(p, '# a\nx = 1\n# b\ny = 2\n# c\nz = 3\n# d\n');
  const r = run({ tool_name: 'Write', tool_input: { file_path: p, content: '# a\nx = 1\n# b\ny = 2\nz = 3\n' } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('main: multiedit netting positive denies', () => {
  const r = run({ tool_name: 'MultiEdit', tool_input: { file_path: join(tmp(), 'm.ts'), edits: [
    { old_string: 'x', new_string: 'x // one' },
    { old_string: 'y', new_string: 'y // two' },
  ] } });
  assert.equal(outOf(r).permissionDecision, 'deny');
});

test('main: HUMAN-APPROVED excluded on both sides', () => {
  const r = run(edit(join(tmp(), 'a.py'), 'x = 1', '# HUMAN-APPROVED: load-bearing\nx = 1'));
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('main: advisory on allow when file has large block', () => {
  const p = join(tmp(), 'big.ts');
  writeFileSync(p, '// one\n// two\n// three\n// four\n// five\nx\n');
  const r = run(edit(p, '// one\n// two\n// three\n// four\n// five\nx', '// one\n// two\nx'));
  const out = outOf(r);
  assert.equal(out.permissionDecision, 'allow');
  assert.ok(out.additionalContext.includes('1–5'));
  assert.ok(out.additionalContext.includes('net count must still decrease'));
});

test('main: advisory folded into deny reason', () => {
  const p = join(tmp(), 'big.ts');
  writeFileSync(p, '// one\n// two\n// three\nx\n');
  const r = run(edit(p, 'x', 'x // what'));
  const out = outOf(r);
  assert.equal(out.permissionDecision, 'deny');
  assert.ok(out.permissionDecisionReason.includes('1–3'));
});

test('main: condensation allows', () => {
  const p = join(tmp(), 'c.py');
  writeFileSync(p, '# 1\n# 2\n# 3\n# 4\n# 5\nx = 1\n');
  assert.deepEqual(largeBlocks(readFileSync(p, 'utf8'), p), [[1, 5]]);
  const r = run(edit(p, '# 1\n# 2\n# 3\n# 4\n# 5\n', '# 1-5 condensed\n# second\n'));
  assert.equal(outOf(r).permissionDecision, 'allow');
});

const silentPayloads = [
  { tool_name: 'Read', tool_input: { file_path: 'a.ts' } },
  { tool_name: 'Edit', tool_input: { file_path: 'a.md', old_string: '', new_string: '# x' } },
  { tool_name: 'Edit', tool_input: { file_path: 'a.ts' } },
  { tool_name: 'Edit' },
  {},
];

for (const payload of silentPayloads) {
  test(`main: non-applicable payload is silent ${JSON.stringify(payload).slice(0, 40)}`, () => {
    const r = run(payload);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '');
  });
}

for (const raw of ['', 'not json', '{', '[1,2]']) {
  test(`main: fails open on bad stdin ${JSON.stringify(raw)}`, () => {
    const r = run(null, {}, raw);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '');
  });
}

test('main: write to directory path fails open', () => {
  const d = join(tmp(), 'dir.ts');
  mkdirSync(d);
  const r = run({ tool_name: 'Write', tool_input: { file_path: d, content: '// x\n' } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('main: warn mode allows and logs', () => {
  const dir = tmp();
  const log = join(dir, 'hook.log');
  const r = run(edit(join(dir, 'a.ts'), 'x', 'x // what'), { STOP_WRITING_COMMENTS_MODE: 'warn', STOP_WRITING_COMMENTS_LOG: log });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
  const line = readFileSync(log, 'utf8').trim().split('\n').at(-1);
  assert.equal(line.split('\t').at(-1), 'warn-deny');
  assert.ok(line.includes('a.ts'));
});

test('main: deny mode logs when log path set', () => {
  const dir = tmp();
  const log = join(dir, 'hook.log');
  run(edit(join(dir, 'a.ts'), 'x', 'x // what'), { STOP_WRITING_COMMENTS_LOG: log });
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').at(-1).split('\t').at(-1), 'deny');
});

test('main: no log file when log path unset', () => {
  const dir = tmp();
  const r = run(edit(join(dir, 'a.ts'), 'x', 'x // what'));
  assert.equal(outOf(r).permissionDecision, 'deny');
  assert.equal(existsSync(join(dir, 'hook.log')), false);
});

test('main: off mode does nothing', () => {
  const dir = tmp();
  const log = join(dir, 'hook.log');
  const r = run(edit(join(dir, 'a.ts'), 'x', 'x // what'), { STOP_WRITING_COMMENTS_MODE: 'off', STOP_WRITING_COMMENTS_LOG: log });
  assert.equal(r.stdout.trim(), '');
  assert.equal(existsSync(log), false);
});

test('main: latency on 2000-line write under 1s', () => {
  let content = '';
  for (let i = 0; i < 2000; i++) content += `const v${i} = ${i};\n`;
  const t = performance.now();
  run({ tool_name: 'Write', tool_input: { file_path: join(tmp(), 'big.ts'), content } });
  assert.ok(performance.now() - t < 1000);
});

test('main: advisory silent when edit does not touch comments', () => {
  const p = join(tmp(), 'hdr.ts');
  writeFileSync(p, '// one\n// two\n// three\nconst a = 1;\n');
  const r = run(edit(p, 'const a = 1;', 'const a = 2;'));
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('main: multiedit with one adding edit denies even when net negative', () => {
  const p = join(tmp(), 'm.ts');
  writeFileSync(p, '// a\nx\n// b\nw\ny\n');
  const r = run({ tool_name: 'MultiEdit', tool_input: { file_path: p, edits: [
    { old_string: '// a\nx\n// b\nw', new_string: 'x\nw' },
    { old_string: 'y', new_string: 'y // new' },
  ] } });
  assert.equal(outOf(r).permissionDecision, 'deny');
  assert.ok(outOf(r).permissionDecisionReason.includes('same place'));
});

test('main: multiedit where every edit decreases allows', () => {
  const r = run({ tool_name: 'MultiEdit', tool_input: { file_path: join(tmp(), 'm.ts'), edits: [
    { old_string: '// a\nx', new_string: 'x' },
    { old_string: '// b\n// c\ny', new_string: '// bc\ny' },
  ] } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('main: single edit that deletes comments in one place and adds in another denies', () => {
  const r = run(edit(join(tmp(), 'a.ts'), '// a\n// b\n// c\nx\ny', 'x\ny // new'));
  const out = outOf(r);
  assert.equal(out.permissionDecision, 'deny');
  assert.ok(out.permissionDecisionReason.includes('2'));
});

test('hunkViolations: condensation in one hunk is not a violation', () => {
  assert.deepEqual(hook.hunkViolations('# 1\n# 2\n# 3\n# 4\n# 5\nx = 1\n', '# 1-5\n# rest\nx = 1\n', 'a.py'), []);
});

test('hunkViolations: added comment far from deletions is reported at its new-text line', () => {
  assert.deepEqual(hook.hunkViolations('// a\n// b\nx\ny\nz\n', 'x\ny\nz // why\n', 'a.ts'), [3]);
});

function project(config) {
  const root = tmp();
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude', 'stop-writing-comments.json'), JSON.stringify(config));
  return root;
}

test('config: mode off from project config silences the hook', () => {
  const root = project({ mode: 'off' });
  const r = run({ ...edit(join(root, 'a.ts'), 'x', 'x // what'), cwd: root });
  assert.equal(r.stdout.trim(), '');
});

test('config: env mode overrides project config', () => {
  const root = project({ mode: 'off' });
  const r = run({ ...edit(join(root, 'a.ts'), 'x', 'x // what'), cwd: root }, { STOP_WRITING_COMMENTS_MODE: 'deny' });
  assert.equal(outOf(r).permissionDecision, 'deny');
});

test('config: extra directives are exempt', () => {
  const root = project({ directives: ['SAFETY:'] });
  const r = run({ ...edit(join(root, 'a.rs'), 'x', '// SAFETY: ptr is non-null\nx'), cwd: root });
  assert.equal(r.stdout.trim(), '');
});

test('config: extra extensions map to a family', () => {
  const root = project({ extensions: { foo: 'slash' } });
  const r = run({ ...edit(join(root, 'a.foo'), 'x', 'x // what'), cwd: root });
  assert.equal(outOf(r).permissionDecision, 'deny');
});

test('config: skip path substrings are ignored', () => {
  const root = project({ skip: ['vendor/'] });
  mkdirSync(join(root, 'vendor'));
  const r = run({ ...edit(join(root, 'vendor', 'a.ts'), 'x', 'x // what'), cwd: root });
  assert.equal(r.stdout.trim(), '');
});

test('config: found by walking up from a nested cwd', () => {
  const root = project({ mode: 'off' });
  const nested = join(root, 'src', 'deep');
  mkdirSync(nested, { recursive: true });
  const r = run({ ...edit(join(nested, 'a.ts'), 'x', 'x // what'), cwd: nested });
  assert.equal(r.stdout.trim(), '');
});

test('config: malformed config file fails open to defaults', () => {
  const root = tmp();
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude', 'stop-writing-comments.json'), '{not json');
  const r = run({ ...edit(join(root, 'a.ts'), 'x', 'x // what'), cwd: root });
  assert.equal(outOf(r).permissionDecision, 'deny');
});
