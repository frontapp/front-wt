'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tty = require('node:tty');

// The picker calls this undocumented method on its own /dev/tty stream when the terminal is resized (see resize() in
// src/wt.js), through `?.()`: if Node renames or removes it, the picker silently keeps drawing at its starting size.
test('tty.WriteStream still has _refreshSize, which the picker needs on resize', () => {
  // oxlint-disable-next-line no-underscore-dangle
  assert.equal(typeof tty.WriteStream.prototype._refreshSize, 'function');
});
