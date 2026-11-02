'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { parseStatus, age, tilde, cell, paint, columns } = require('../src/wt.js');

test('parseStatus: modified and untracked counts from porcelain output', () => {
  assert.deepEqual(parseStatus(''), { changed: 0, untracked: 0 });
  assert.deepEqual(parseStatus(' M a.js\n?? b.js\n?? c/\nA  d.js\n'), { changed: 2, untracked: 2 });
});

test('age: the coarsest unit that fits', () => {
  const now = Date.now() / 1000;
  assert.equal(age(0), '');
  assert.equal(age(now - 10), 'now');
  assert.equal(age(now - 125), '2m');
  assert.equal(age(now - 3 * 3600), '3h');
  assert.equal(age(now - 2 * 86400), '2d');
  assert.equal(age(now - 15 * 86400), '2w');
  assert.equal(age(now - 70 * 86400), '2mo');
  assert.equal(age(now - 800 * 86400), '2y');
});

test('tilde: home becomes ~', () => {
  const home = os.homedir();
  assert.equal(tilde(home), '~');
  assert.equal(tilde(`${home}/x`), '~/x');
  assert.equal(tilde('/opt/x'), '/opt/x');
  assert.equal(tilde(`${home}2/x`), `${home}2/x`);
});

test('cell and paint: fixed width, truncated with an ellipsis, highlights kept', () => {
  assert.equal(paint(cell('abcdef', 4), 80), 'abc…');
  assert.equal(paint(cell('ab', 4), 80), 'ab  ');
  const styled = paint(cell('abc', 3, '', new Set([1])), 80);
  assert.equal(styled, 'a\x1b[1;4;93mb\x1b[0mc');
  // Never wider than the line
  assert.equal(paint([['abcdef', '']], 3), 'abc');
});

test('columns: the worktree column shrinks before the branch', () => {
  const items = [{ label: 'a'.repeat(40), name: 'b'.repeat(40) }];
  const wide = columns(items, 200, false);
  assert.equal(wide.branch, 40);
  assert.equal(wide.name, 40);
  const narrow = columns(items, 80, false);
  assert.ok(narrow.name < narrow.branch);
  assert.ok(narrow.name >= 12);
});
