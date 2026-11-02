'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shellBlock, withBlock, shellQuote } = require('../src/wt.js');

test('shellQuote: single quotes, with embedded ones escaped', () => {
  assert.equal(shellQuote('/a/b'), "'/a/b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test('shellBlock: a marked block defining the function and completion, per shell', () => {
  const zsh = shellBlock('zsh', '/x/bin/wt');
  assert.ok(zsh.startsWith('# >>> wt >>>\n'));
  assert.ok(zsh.endsWith('# <<< wt <<<'));
  assert.match(zsh, /WT_SHELL=zsh '\/x\/bin\/wt' "\$@"/);
  assert.match(zsh, /compdef _wt wt/);

  const bash = shellBlock('bash', '/x/bin/wt');
  assert.match(bash, /WT_SHELL=bash '\/x\/bin\/wt' "\$@"/);
  assert.match(bash, /complete -F _wt wt/);
});

test('withBlock: appended to an rc file, replaced when already there', () => {
  const block = shellBlock('zsh', '/x/bin/wt');
  assert.equal(withBlock('', block), `${block}\n`);
  assert.equal(withBlock('export A=1\n', block), `export A=1\n\n${block}\n`);

  const old = shellBlock('zsh', '/old/wt');
  const rc = `export A=1\n\n${old}\n\nexport B=2\n`;
  const updated = withBlock(rc, block);
  assert.equal(updated, `export A=1\n\n${block}\n\nexport B=2\n`);
  assert.equal(withBlock(updated, block), updated);
});

test('withBlock: the bash block survives being used as a replacement (it contains $\')', () => {
  const bash = shellBlock('bash', '/x/bin/wt');
  const rc = withBlock('', shellBlock('bash', '/old/wt'));
  assert.ok(withBlock(rc, bash).includes("local IFS=$'\\n'"));
});
