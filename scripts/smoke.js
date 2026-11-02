#!/usr/bin/env node
// Runs the built script, dist/wt, the way the release ships it: version, help, completion in this checkout (a git
// repo), and the error outside one. No network: `wt update` is covered by the install script's own run.
'use strict';
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const wt = path.join(root, 'dist', 'wt');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function run(args, opts = {}) {
  const r = cp.spawnSync(process.execPath, [wt, ...args], { encoding: 'utf8', env: { ...process.env, WT_NO_UPDATE: '1', ...opts.env }, cwd: opts.cwd });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function check(what, ok, detail) {
  if (!ok) {
    console.error(`FAIL ${what}${detail ? `\n${detail}` : ''}`);
    process.exit(1);
  }
  console.log(`ok   ${what}`);
}

check('dist/wt is executable', (fs.statSync(wt).mode & 0o111) !== 0);
check('dist/wt starts with the shebang', fs.readFileSync(wt, 'utf8').startsWith('#!/usr/bin/env node\n'));
check(`dist/wt exports VERSION ${version}`, require(wt).VERSION === version);

let r = run(['--version']);
check(`--version prints "wt ${version}" on stderr`, r.code === 0 && r.err === `wt ${version}\n` && r.out === '', r.err);

r = run(['--help']);
check('--help prints the usage', r.code === 0 && r.err.startsWith('usage: wt') && r.err.includes(version), r.err);

r = run(['--complete'], { cwd: root });
check('--complete lists this checkout\'s worktrees', r.code === 0 && r.out.trim().length > 0, r.err);

const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-smoke-'));
r = run(['--complete'], { cwd: outside });
check('--complete outside a repo fails with a reason', r.code === 1 && /not in a git repository/.test(r.err), r.err);

// The updater checks its download with `node --check` under this name before moving it into place: the name must be
// one Node accepts (it refuses extensions it doesn't know, such as `.tmp`).
const staged = path.join(outside, `.wt-${process.pid}-update`);
fs.copyFileSync(wt, staged);
const checked = cp.spawnSync(process.execPath, ['--check', staged], { encoding: 'utf8' });
check('node --check accepts the file under the updater\'s staging name', checked.status === 0, checked.stderr);
fs.rmSync(outside, { recursive: true, force: true });

console.log('smoke: all good');
