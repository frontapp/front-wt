'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fuzzy, match, filter, exactMatch, keysOf, keys } = require('../src/wt.js');

const item = (branch, opts = {}) => {
  const name = opts.name ?? branch;
  return { branch, label: branch, key: branch, name, prefixLen: 0, isMain: false, order: 0, ...opts };
};

test('fuzzy: a substring wins, more so at a word boundary', () => {
  const inside = fuzzy('len', 'copilot-calendar');
  const boundary = fuzzy('cal', 'copilot-calendar');
  assert.ok(inside.substring && boundary.substring);
  assert.ok(boundary.score > inside.score);
  assert.ok(inside.score > fuzzy('ctz', 'copilot-calendar-timezones').score);
  assert.deepEqual(boundary.pos, [8, 9, 10]);
});

test('fuzzy: a scattered subsequence scores below any substring', () => {
  const r = fuzzy('ctz', 'copilot-calendar-timezones');
  assert.ok(r && r.score < 1000);
  assert.equal(r.pos.length, 3);
  assert.equal(fuzzy('zzz', 'abc'), null);
});

test('fuzzy: case-insensitive', () => {
  assert.ok(fuzzy('CAL', 'copilot-calendar'));
  assert.ok(fuzzy('cal', 'Copilot-Calendar'));
});

test('match: every term must match the branch or the worktree name', () => {
  const it = item('worktree-feature-x', { name: 'feature-x', key: 'feature-x', prefixLen: 'worktree-'.length });
  assert.ok(match(it, 'feat x'));
  assert.equal(match(it, 'feat nope'), null);
  // Highlights land on the branch, after its prefix
  assert.deepEqual([...match(it, 'feat').branchPos].sort((a, b) => a - b), [9, 10, 11, 12]);
});

test('filter: substring matches hide scattered ones, main stays first, then by score', () => {
  const main = item('master', { isMain: true, name: '(main)', order: 0 });
  const sub = item('calendar', { order: 1 });
  const scattered = item('c-a-l', { order: 2 });
  assert.deepEqual(filter([main, sub, scattered], 'cal').map((r) => r.it.branch), ['calendar']);
  assert.deepEqual(filter([main, sub, scattered], 'cl').map((r) => r.it.branch), ['calendar', 'c-a-l']);
  // All three contain 'a'; the one at a word boundary scores highest, main leads regardless
  assert.deepEqual(filter([main, sub, scattered], 'a').map((r) => r.it.branch), ['master', 'c-a-l', 'calendar']);
  assert.equal(filter([main, sub, scattered], '').length, 3);
});

test('filter: a substring deep in a long name is still a substring, not hidden by a boundary match elsewhere', () => {
  const boundary = item('calendar-end', { order: 0 });
  const deep = item('backend', { order: 1 });
  assert.deepEqual(filter([boundary, deep], 'end').map((r) => r.it.branch), ['calendar-end', 'backend']);
});

test('exactMatch and keysOf: branch without its prefix, or the directory', () => {
  const it = item('worktree-fix', { name: 'fix-dir', key: 'fix', prefixLen: 9 });
  assert.deepEqual(keysOf(it), ['fix', 'fix-dir']);
  assert.equal(exactMatch([it], 'FIX'), it);
  assert.equal(exactMatch([it], 'fix-dir'), it);
  assert.equal(exactMatch([it], 'worktree-fix'), it);
  assert.equal(exactMatch([it], 'fi'), undefined);
  assert.deepEqual(keysOf(item('master', { isMain: true, name: '(main)' })), ['master']);
});

test('keys: splits raw input into escape sequences, alt chords and characters', () => {
  assert.deepEqual([...keys('\x1b[Aa\x1bb\x1b[1;5D\x1b')], ['\x1b[A', 'a', '\x1bb', '\x1b[1;5D', '\x1b']);
  assert.deepEqual([...keys('é😀')], ['é', '😀']);
});
