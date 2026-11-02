'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AGENTS, agentOf, codexWorktreeRoot, gitDirOf, worktreeHolding, parsePs, parseLsof } = require('../src/wt.js');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-agents-')));

test('codexWorktreeRoot: $CODEX_HOME/worktrees, or the root config.toml sets', () => {
  const home = tmp();
  assert.equal(codexWorktreeRoot({ CODEX_HOME: home }), path.join(home, 'worktrees'));
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "x"\n\n[desktop]\ngit-worktree-root = "/srv/trees"\n');
  assert.equal(codexWorktreeRoot({ CODEX_HOME: home }), '/srv/trees');
  fs.writeFileSync(path.join(home, 'config.toml'), 'desktop.git-worktree-root = "~/trees"\n');
  assert.equal(codexWorktreeRoot({ CODEX_HOME: home }), path.join(os.homedir(), 'trees'));
});

test('agentOf: by the directory a worktree is in, or by the marker Codex leaves', () => {
  const home = tmp();
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  process.env.CODEX_HOME = path.join(home, '.codex');

  assert.equal(agentOf(path.join(repo, '.claude', 'worktrees', 'fix'), repo, null), 'claude');
  assert.equal(agentOf(path.join(home, '.codex', 'worktrees', 'ab12', 'repo'), repo, null), 'codex');
  assert.equal(agentOf(path.join(home, 'elsewhere', 'repo'), repo, null), null);
  assert.equal(agentOf(repo, repo, null), null);

  // The marker wins over the directory: a Codex worktree under a root wt doesn't know
  const gitDir = path.join(home, 'gitdir');
  fs.mkdirSync(gitDir);
  assert.equal(agentOf(path.join(home, 'elsewhere', 'repo'), repo, gitDir), null);
  fs.writeFileSync(path.join(gitDir, 'codex-thread.json'), '{"version":1,"ownerThreadId":"t"}');
  assert.equal(agentOf(path.join(home, 'elsewhere', 'repo'), repo, gitDir), 'codex');
  delete process.env.CODEX_HOME;
});

test('gitDirOf: a linked worktree\'s .git file; null for a .git directory', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'linked'));
  fs.writeFileSync(path.join(dir, 'linked', '.git'), 'gitdir: /repo/.git/worktrees/linked\n');
  assert.equal(gitDirOf(path.join(dir, 'linked')), '/repo/.git/worktrees/linked');
  fs.mkdirSync(path.join(dir, 'main', '.git'), { recursive: true });
  assert.equal(gitDirOf(path.join(dir, 'main')), null);
  assert.equal(gitDirOf(path.join(dir, 'missing')), null);
});

test('worktreeHolding: the deepest worktree a directory is in', () => {
  const paths = ['/repo', '/repo/.claude/worktrees/a', '/other'];
  assert.equal(worktreeHolding(paths, '/repo/src'), 0);
  assert.equal(worktreeHolding(paths, '/repo/.claude/worktrees/a/src'), 1);
  assert.equal(worktreeHolding(paths, '/repo/.claude/worktrees/a'), 1);
  assert.equal(worktreeHolding(paths, '/other'), 2);
  assert.equal(worktreeHolding(paths, '/repository'), -1);
  assert.equal(worktreeHolding(paths, '/'), -1);
});

test('parsePs and parseLsof', () => {
  assert.deepEqual(parsePs('  123 claude\n 4567 /Applications/Codex.app/Contents/MacOS/codex\nbad line\n'), [
    ['123', 'claude'], ['4567', 'codex'],
  ]);
  assert.deepEqual(parseLsof('p123\nfcwd\nn/repo/a\np456\nfcwd\nn/repo/b\n'), [['123', '/repo/a'], ['456', '/repo/b']]);
  assert.deepEqual(parseLsof(''), []);
});

test('every agent names its processes and where its worktrees live', () => {
  for (const agent of Object.values(AGENTS)) {
    assert.ok(agent.name && agent.procs.length > 0);
    assert.ok(agent.roots('/repo').every((r) => path.isAbsolute(r)));
  }
});
