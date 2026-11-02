'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, isNewer, releaseVersion, VERSION } = require('../src/wt.js');

test('a checkout runs as the dev version', () => {
  assert.equal(VERSION, '0.0.0-dev');
});

test('compareVersions: numeric parts, a v prefix, prereleases before releases', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3', '1.2.10'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
});

test('isNewer', () => {
  assert.ok(isNewer('0.2.0', '0.1.9'));
  assert.ok(!isNewer('0.1.9', '0.1.9'));
  assert.ok(!isNewer('0.1.0', '0.0.0-dev') === false); // a dev checkout is older than any release
  assert.ok(isNewer('0.1.0', '0.0.0-dev'));
});

test('releaseVersion: the tag the latest-release page redirects to', () => {
  assert.equal(releaseVersion('https://github.com/frontapp/front-wt/releases/tag/v0.2.0'), '0.2.0');
  assert.equal(releaseVersion('https://github.com/frontapp/front-wt/releases/tag/1.0.0-rc.1'), '1.0.0-rc.1');
  assert.equal(releaseVersion('https://github.com/frontapp/front-wt/releases'), null);
  assert.equal(releaseVersion(null), null);
  assert.equal(releaseVersion(''), null);
});
