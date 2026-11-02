#!/usr/bin/env node
// Writes dist/wt: src/wt.js with VERSION set from package.json, executable. That file is the package's bin and the
// release's asset. `pnpm build`; prepack runs it too.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const src = fs.readFileSync(path.join(root, 'src', 'wt.js'), 'utf8');

const marker = "const VERSION = '0.0.0-dev'; // set by the build";
if (!src.includes(marker)) throw new Error(`src/wt.js: no "${marker}" line to set the version in`);
const out = src.replace(marker, `const VERSION = '${version}';`);

const dist = path.join(root, 'dist', 'wt');
fs.mkdirSync(path.dirname(dist), { recursive: true });
fs.writeFileSync(dist, out);
fs.chmodSync(dist, 0o755);
console.log(`dist/wt: wt ${version}`);
