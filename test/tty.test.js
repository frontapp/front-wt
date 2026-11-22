'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tty = require('node:tty');

// resize() in src/wt.js calls it through `?.()`, so a rename in Node would fail silently.
test('tty.WriteStream still has _refreshSize, which the picker needs on resize', () => {
  // oxlint-disable-next-line no-underscore-dangle
  assert.equal(typeof tty.WriteStream.prototype._refreshSize, 'function');
});
