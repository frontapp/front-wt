#!/usr/bin/env node
// wt — switch between the git worktrees of the current repo.
//
//   wt [query]            open the picker, pre-filtered; jumps directly when the query names one worktree
//   wt install [shell…]   set up the `wt` shell function in bash and/or zsh (asks before changing anything; --yes skips)
//   wt uninstall          remove it
//   wt update             install the latest release now (it also happens by itself, in the background)
//   wt --complete         print worktree names, for shell completion
//   wt --version          print the version
//
// A program can't change its parent shell's directory, so `wt install` adds a small `wt` shell function
// that runs this script and cds into the path it prints on stdout.
//
// In the picker: type to filter (readline editing keys work), ⇥ completes, esc quits.
// ⏎ opens the actions menu of the selected worktree: go to it (⏎ again), open its PR on GitHub, reveal it, open it in
// $EDITOR, delete it.
//
// No dependencies: node core modules and git only (gh optional, for PRs). Keep it that way, startup must stay < 100ms.
//
// This is the source; `scripts/build.js` writes `dist/wt`, the same file with VERSION set from package.json. That file
// is what the release ships and what the installer and the updater download.
'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const tty = require('tty');

const VERSION = '0.0.0-dev'; // set by the build
const DEV_VERSION = '0.0.0-dev';
const REPO = 'frontapp/front-wt';
const PACKAGE = '@frontapp/front-wt';
const RELEASES = `https://github.com/${REPO}/releases`;

const CLAUDE_PREFIX = 'worktree-'; // added by `claude --worktree` to branch names
const GAP = '   ';
const MAX_ROWS = 15;
const TERMINAL_EDITORS = new Set(['vi', 'vim', 'nvim', 'nano', 'pico', 'emacs', 'hx', 'helix', 'micro', 'kak', 'joe', 'ne', 'mg']);
const EDITOR_NAMES = {
  code: 'VS Code', 'code-insiders': 'VS Code Insiders', cursor: 'Cursor', windsurf: 'Windsurf', zed: 'Zed',
  subl: 'Sublime Text', mate: 'TextMate', idea: 'IntelliJ IDEA', webstorm: 'WebStorm',
  vi: 'vi', vim: 'Vim', nvim: 'Neovim', emacs: 'Emacs', hx: 'Helix', helix: 'Helix',
};
// Coding agents that make worktrees to work in: where each keeps them, and the names of its processes, to tell the
// worktree it's running in by their working directory. Claude Code also locks its worktree while it runs, naming its
// pid. Claude Code's worktrees live in the repo, Codex's and Cursor's in the home directory.
const AGENTS = {
  claude: { name: 'Claude Code', procs: ['claude'], roots: (repo) => [path.join(repo, '.claude', 'worktrees')] },
  codex: { name: 'Codex', procs: ['codex'], roots: () => [codexWorktreeRoot()] },
  cursor: { name: 'Cursor', procs: ['cursor-agent'], roots: () => [path.join(os.homedir(), '.cursor', 'worktrees')] },
};
const CODEX_MARKER = 'codex-thread.json'; // in the git directory of each worktree Codex made

const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'wt');
const PR_CACHE = path.join(CACHE_DIR, 'prs.json');
const UPDATE_STATE = path.join(CACHE_DIR, 'update.json');
const UPDATE_CHECK_INTERVAL = 24 * 3600 * 1000; // between two looks at the latest release

// Styles (SGR parameters)
const S = {
  bold: '1', dim: '2', red: '31', green: '32', yellow: '33', blue: '34', magenta: '35', cyan: '36',
  match: '1;4;93',
  selected: '7', // reverse video: the terminal's own text and background colors, swapped
};

// On the selected row: plain text in reverse video (no cursor mark: ❯ is the prompt's), only the filter matches stay
// underlined.
const plain = (style) => style.split(';').filter((c) => c === '4').join(';');

const git = (args) => cp.execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function die(msg) {
  fs.writeSync(2, `wt: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Data

function readWorktrees() {
  let out;
  try {
    out = git(['worktree', 'list', '--porcelain', '-z']);
  } catch {
    die('not in a git repository');
  }
  const raw = [];
  let cur = null;
  for (const field of out.split('\0')) {
    if (field === '') { cur = null; continue; }
    const sp = field.indexOf(' ');
    const key = sp < 0 ? field : field.slice(0, sp);
    const val = sp < 0 ? '' : field.slice(sp + 1);
    if (key === 'worktree') raw.push(cur = { path: val });
    else if (cur) cur[key] = val;
  }

  const cwd = realpath(process.cwd());
  let current = null;
  const items = raw.filter((w) => !('bare' in w)).map((w, i) => {
    const branch = w.branch ? w.branch.replace(/^refs\/heads\//, '') : null;
    const prefixLen = branch && branch.startsWith(CLAUDE_PREFIX) ? CLAUDE_PREFIX.length : 0;
    const agent = i === 0 ? null : agentOf(w.path, raw[0].path, gitDirOf(w.path));
    const it = {
      path: w.path,
      sha: w.HEAD,
      branch,
      label: branch ?? `(detached ${(w.HEAD || '').slice(0, 7)})`,
      key: branch ? branch.slice(prefixLen) : null,
      prefixLen,
      isMain: i === 0,
      // Codex names every worktree after the repo: the bucket it's in tells them apart.
      name: i === 0 ? '(main)' : agent === 'codex' ? `codex/${path.basename(path.dirname(w.path))}` : path.basename(w.path),
      locked: 'locked' in w ? w.locked || 'no reason given' : null,
      agent, // the agent that made it
      busy: 'locked' in w && /claude/.test(w.locked) && isAlive(w.locked) ? 'claude' : null, // the agent running in it
      order: i,
    };
    const p = realpath(w.path);
    if ((cwd === p || cwd.startsWith(p + '/')) && (!current || p.length > current.len)) current = { it, len: p.length };
    return it;
  });
  if (current) current.it.current = true;
  return { items, root: raw[0].path };
}

function realpath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

function isAlive(lockReason) {
  const m = /pid (\d+)/.exec(lockReason);
  if (!m) return true;
  try { process.kill(Number(m[1]), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Where a linked worktree's git directory is, from its `.git` file; null for the main worktree, whose `.git` is a directory.
function gitDirOf(wtPath) {
  const m = /^gitdir: (.+)$/m.exec(readText(path.join(wtPath, '.git')));
  return m ? path.resolve(wtPath, m[1].trim()) : null;
}

// $CODEX_HOME/worktrees, unless Codex's config.toml sets desktop.git-worktree-root (under [desktop], or dotted).
function codexWorktreeRoot(env = process.env) {
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const m = /^\s*(?:desktop\.)?git-worktree-root\s*=\s*"([^"]+)"/m.exec(readText(path.join(home, 'config.toml')));
  return m ? m[1].replace(/^~(?=\/|$)/, os.homedir()) : path.join(home, 'worktrees');
}

// Which agent made a worktree: Codex marks its own in their git directory; otherwise the directory it's in says.
function agentOf(wtPath, repoRoot, gitDir) {
  if (gitDir && fs.existsSync(path.join(gitDir, CODEX_MARKER))) return 'codex';
  const p = realpath(wtPath);
  for (const [key, agent] of Object.entries(AGENTS)) {
    if (agent.roots(repoRoot).some((root) => root && p.startsWith(realpath(root) + '/'))) return key;
  }
  return null;
}

// The deepest of `paths` holding `cwd`, as an index, or -1: a worktree can sit inside another, as Claude Code's do.
function worktreeHolding(paths, cwd) {
  let best = -1;
  paths.forEach((p, i) => {
    if ((cwd === p || cwd.startsWith(p + '/')) && (best < 0 || p.length > paths[best].length)) best = i;
  });
  return best;
}

// `ps -axo pid=,comm=` lines, as [pid, process name]: the name can be a full path.
function parsePs(text) {
  return text.split('\n').map((l) => /^\s*(\d+)\s+(.+?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], path.basename(m[2])]);
}

// `lsof -F pn` output, as [pid, path]: a `p` line starts each process, `n` lines follow with its files.
function parseLsof(text) {
  const out = [];
  let pid = null;
  for (const line of text.split('\n')) {
    if (line[0] === 'p') pid = line.slice(1);
    else if (line[0] === 'n' && pid) out.push([pid, line.slice(1)]);
  }
  return out;
}

// Which worktree each coding agent is running in, from its processes' working directories: /proc on Linux, ps and
// lsof on macOS. After the first render, like the statuses; Claude Code's lock already says so without it.
function loadAgents(items, children, onUpdate) {
  const byProc = new Map(Object.entries(AGENTS).flatMap(([key, a]) => a.procs.map((p) => [p, key])));
  const paths = items.map((it) => realpath(it.path));
  const mark = (found) => { // [[agent, cwd]]
    let changed = false;
    for (const [key, cwd] of found) {
      const it = items[worktreeHolding(paths, realpath(cwd))];
      if (it && it.busy !== key) { it.busy = key; changed = true; }
    }
    if (changed) onUpdate();
  };

  if (process.platform === 'linux') {
    const found = [];
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      const key = byProc.get(readText(`/proc/${pid}/comm`).trim());
      if (!key) continue;
      try { found.push([key, fs.readlinkSync(`/proc/${pid}/cwd`)]); } catch {} // another user's: not ours to see
    }
    return mark(found);
  }
  if (process.platform !== 'darwin') return;
  const lsof = ['/usr/sbin/lsof', '/usr/bin/lsof'].find(isExecutable) ?? (onPath('lsof') ? 'lsof' : null);
  if (!lsof) return;
  // ps names the processes; lsof gives their working directories (its own names are the binaries', which can differ).
  const collect = (cmd, args, cb) => {
    const child = cp.spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (buf += d));
    child.on('error', () => {});
    child.on('close', () => cb(buf));
    children.push(child);
  };
  collect('ps', ['-axo', 'pid=,comm='], (out) => {
    const agents = new Map(parsePs(out).filter(([, comm]) => byProc.has(comm)).map(([pid, comm]) => [pid, byProc.get(comm)]));
    if (!agents.size) return;
    collect(lsof, ['-a', '-d', 'cwd', '-p', [...agents.keys()].join(','), '-F', 'pn'], (out2) => {
      mark(parseLsof(out2).map(([pid, cwd]) => [agents.get(pid), cwd]).filter(([key]) => key));
    });
  });
}

// The branch we compare against: origin's default branch, else the main worktree's branch.
function baseRef(root, items) {
  for (const dir of [path.join(root, '.git'), root]) {
    try {
      const m = /^ref: refs\/remotes\/(.+)$/m.exec(fs.readFileSync(path.join(dir, 'refs/remotes/origin/HEAD'), 'utf8'));
      if (m) return m[1];
    } catch {}
  }
  return items[0]?.branch ?? null;
}

// One git call for the age, subject and ahead/behind of every branch.
function loadCommits(items, base) {
  const byRef = new Map(items.filter((it) => it.branch).map((it) => [`refs/heads/${it.branch}`, it]));
  if (byRef.size) {
    const fields = ['%(refname)', '%(committerdate:unix)', '%(subject)'];
    let out;
    try {
      out = git(['for-each-ref', `--format=${[...fields, `%(ahead-behind:${base})`].join('%00')}`, ...byRef.keys()]);
    } catch {
      out = git(['for-each-ref', `--format=${fields.join('%00')}`, ...byRef.keys()]);
    }
    for (const line of out.split('\n')) {
      const [ref, date, subject, ab] = line.split('\0');
      const it = byRef.get(ref);
      if (!it) continue;
      it.date = Number(date);
      it.subject = subject;
      if (ab && base && ref !== `refs/heads/${base}`) [it.ahead, it.behind] = ab.split(' ').map(Number);
    }
  }
  const detached = items.filter((it) => !it.branch && it.sha);
  if (detached.length) {
    const out = git(['log', '--no-walk=unsorted', '--format=%H%x00%ct%x00%s', ...detached.map((it) => it.sha)]);
    for (const line of out.split('\n')) {
      const [sha, date, subject] = line.split('\0');
      for (const it of detached) if (it.sha === sha) Object.assign(it, { date: Number(date), subject });
    }
  }
}

// `git status` takes 50–150ms per worktree: run them in parallel, after the first render.
function loadStatuses(items, onUpdate) {
  const children = [];
  for (const it of items) {
    if (!fs.existsSync(it.path)) { it.status = { missing: true }; continue; }
    const child = cp.spawn('git', ['--no-optional-locks', '-C', it.path, 'status', '--porcelain'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let buf = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (buf += d));
    child.on('close', (code) => {
      it.status = code === 0 ? parseStatus(buf) : { error: true };
      onUpdate();
    });
    children.push(child);
  }
  return children;
}

function parseStatus(porcelain) {
  const lines = porcelain.split('\n').filter(Boolean);
  const untracked = lines.filter((l) => l.startsWith('??')).length;
  return { changed: lines.length - untracked, untracked };
}

// Read cached PRs, so the PR column fills in on the first render; loadPRs refreshes them.
function cachedPRs(items, root) {
  let cache;
  try { cache = JSON.parse(fs.readFileSync(PR_CACHE, 'utf8'))[root]; } catch { return; }
  for (const it of items) if (it.branch && cache && it.branch in cache) it.pr = cache[it.branch];
}

// The latest PR of every branch, in one GitHub API call (~1s) made after the first render.
// `it.pr` is { number, state: open|draft|merged|closed, url, head }, null when there's no PR, undefined if unknown.
function loadPRs(items, root, base, onUpdate) {
  const baseBranch = base?.replace(/^origin\//, '');
  const branches = [...new Set(items.map((it) => it.branch).filter((b) => b && b !== baseBranch))];
  if (!branches.length || !onPath('gh')) return null;
  const query = `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${branches.map((b, i) =>
    `b${i}: pullRequests(headRefName: ${JSON.stringify(b)}, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) ` +
    '{ nodes { number state isDraft url headRefOid } }').join(' ')} } }`;
  // gh fills in {owner} and {repo} from the repo's remote
  const child = cp.spawn('gh', ['api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}', '-f', `query=${query}`], {
    cwd: root, stdio: ['ignore', 'pipe', 'ignore'],
  });
  let buf = '';
  child.stdout.setEncoding('utf8').on('data', (d) => (buf += d));
  child.on('error', () => onUpdate(false));
  child.on('close', (code) => {
    let repo;
    try { repo = code === 0 && JSON.parse(buf).data.repository; } catch {}
    if (!repo) return onUpdate(false);
    const prs = {};
    branches.forEach((b, i) => {
      const n = repo[`b${i}`]?.nodes[0];
      prs[b] = n ? {
        number: n.number, url: n.url, head: n.headRefOid,
        state: n.isDraft && n.state === 'OPEN' ? 'draft' : n.state.toLowerCase(),
      } : null;
    });
    for (const it of items) if (it.branch in prs) it.pr = prs[it.branch];
    try {
      let cache = {};
      try { cache = JSON.parse(fs.readFileSync(PR_CACHE, 'utf8')); } catch {}
      cache[root] = prs;
      fs.mkdirSync(path.dirname(PR_CACHE), { recursive: true });
      fs.writeFileSync(PR_CACHE, JSON.stringify(cache));
    } catch {}
    onUpdate(true);
  });
  return child;
}

function onPath(cmd) {
  return (process.env.PATH || '').split(':').some((dir) => dir && isExecutable(path.join(dir, cmd)));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// What deleting a worktree (and its branch) would lose, checked fresh: [icon, text, style] lines for the confirmation.
function deletionRisks(it, root, base, prPending) {
  const count = (args) => { try { return Number(git(['-C', root, ...args])); } catch { return null; } };
  const risks = [];

  let st = { missing: true };
  if (fs.existsSync(it.path)) {
    try { st = parseStatus(git(['--no-optional-locks', '-C', it.path, 'status', '--porcelain'])); } catch { st = { error: true }; }
  }
  if (st.missing) risks.push(['·', 'its directory is already gone', S.dim]);
  else if (st.error) risks.push(['!', 'couldn\'t check for uncommitted changes', S.yellow]);
  else if (st.changed || st.untracked) {
    const files = [st.changed && plural(st.changed, 'modified file'), st.untracked && plural(st.untracked, 'untracked file')];
    risks.push(['!', `${files.filter(Boolean).join(' and ')} will be lost`, S.red]);
  } else risks.push(['✓', 'no uncommitted changes', S.green]);

  // Commits reachable from nothing else once the branch is gone: not pushed, not on another branch or tag.
  // A PR's commits stay on GitHub (refs/pull/N/head) after its branch is deleted, as it usually is once merged.
  const tip = it.branch ? `refs/heads/${it.branch}` : it.sha;
  const others = it.branch ? [`--exclude=${it.branch}`, `--exclude=${tip}`, '--branches'] : ['--branches'];
  const prHead = it.pr && count(['cat-file', '-e', `${it.pr.head}^{commit}`]) !== null ? [it.pr.head] : [];
  const unique = count(['rev-list', '--count', tip, '--not', ...others, '--remotes', '--tags', ...prHead]);
  if (unique) risks.push(['!', `${plural(unique, 'commit')} not pushed anywhere will be lost`, S.red]);

  // Merged? PRs are often squash-merged, so a merged PR whose head is the branch tip counts, whatever ↑ says.
  const into = base ? path.basename(base) : null;
  const pr = it.pr;
  const sinceMerge = pr?.state === 'merged'
    ? (pr.head === it.sha ? 0 : count(['rev-list', '--count', `${pr.head}..${tip}`]))
    : null;
  if (sinceMerge === 0) risks.push(['✓', `PR #${pr.number} is merged`, S.green]);
  else if (sinceMerge) risks.push(['!', `${plural(sinceMerge, 'commit')} added after PR #${pr.number} was merged`, S.yellow]);
  else if (prPending && it.branch && pr === undefined) risks.push(['…', 'checking for a merged PR', S.dim]);
  else if (it.ahead) {
    const open = pr && pr.state !== 'merged' ? ` (PR #${pr.number} is ${pr.state})` : '';
    risks.push(['!', `${plural(it.ahead, 'commit')} not merged into ${into}${open}`, S.yellow]);
  } else if (it.ahead === 0) risks.push(['✓', `merged into ${into}`, S.green]);

  if (it.locked && !/claude/.test(it.locked)) risks.push(['!', `it's locked: ${it.locked}`, S.yellow]);
  if (it.agent && !it.busy) risks.push(['·', `made by ${AGENTS[it.agent].name}, which isn't running in it`, S.dim]);
  return risks;
}

// ---------------------------------------------------------------------------
// Matching

// Substring matches win, then tight subsequences. Returns { score, pos, substring } or null.
function fuzzy(q, s) {
  const ql = q.toLowerCase();
  const sl = s.toLowerCase();
  const at = sl.indexOf(ql);
  if (at >= 0) {
    const boundary = at === 0 || /[-_/. ]/.test(sl[at - 1]);
    return { score: 1000 + (boundary ? 200 : 0) - at, pos: range(at, at + ql.length), substring: true };
  }
  let i = 0;
  let end = -1;
  for (let j = 0; j < sl.length; j++) {
    if (sl[j] === ql[i] && ++i === ql.length) { end = j; break; }
  }
  if (end < 0) return null;
  const pos = [];
  for (let j = end, k = ql.length - 1; k >= 0; j--) if (sl[j] === ql[k]) { pos.unshift(j); k--; }
  return { score: 500 - 5 * (end - pos[0] + 1 - ql.length) - pos[0], pos, substring: false };
}

function range(a, b) {
  return Array.from({ length: b - a }, (_, i) => a + i);
}

// Every space-separated term must match the branch (without its prefix) or the worktree name.
function match(it, query) {
  const res = { it, score: 0, branchPos: new Set(), namePos: new Set(), substring: true };
  for (const term of query.split(/\s+/).filter(Boolean)) {
    const b = fuzzy(term, it.key ?? it.label);
    const n = it.name !== it.key ? fuzzy(term, it.name) : null;
    if (!b && !n) return null;
    const best = (b?.score ?? -Infinity) >= (n?.score ?? -Infinity) ? b : n;
    res.score += best.score;
    res.substring &&= best.substring;
    const off = it.key ? it.prefixLen : 0;
    b?.pos.forEach((p) => res.branchPos.add(p + off));
    (it.name === it.key ? b : n)?.pos.forEach((p) => res.namePos.add(p));
  }
  return res;
}

// Scattered-letter matches only show up when nothing contains the query as typed.
function filter(items, query) {
  let res = items.map((it) => match(it, query)).filter(Boolean);
  if (res.some((r) => r.substring)) res = res.filter((r) => r.substring);
  if (query.trim()) res.sort((a, b) => b.it.isMain - a.it.isMain || b.score - a.score || a.it.order - b.it.order);
  return res;
}

// Names you can type to reach a worktree: its branch (without prefix) and its directory.
function keysOf(it) {
  return [...new Set([it.key, it.isMain ? null : it.name].filter(Boolean))];
}

function exactMatch(items, query) {
  const q = query.trim().toLowerCase();
  return items.find((it) => keysOf(it).some((k) => k.toLowerCase() === q) || it.branch?.toLowerCase() === q);
}

// ---------------------------------------------------------------------------
// Formatting

function age(sec) {
  if (!sec) return '';
  const d = Date.now() / 1000 - sec;
  if (d < 60) return 'now';
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 7 * 86400) return `${Math.floor(d / 86400)}d`;
  if (d < 30 * 86400) return `${Math.floor(d / (7 * 86400))}w`;
  if (d < 365 * 86400) return `${Math.floor(d / (30 * 86400))}mo`;
  return `${Math.floor(d / (365 * 86400))}y`;
}

function tilde(p) {
  const home = os.homedir();
  return p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

function changesSegs(st) {
  if (!st) return [['·', S.dim]]; // still loading: same as clean, so most rows don't change when it lands
  if (st.missing) return [['missing', S.red]];
  if (st.error) return [['?', S.dim]];
  if (!st.changed && !st.untracked) return [['·', S.dim]];
  return [[[st.changed && `~${st.changed}`, st.untracked && `+${st.untracked}`].filter(Boolean).join(' '), S.yellow]];
}

// A squash-merged branch stays ahead of master by its own commits: once its PR is merged with the branch tip
// as head, show ✓ for "its changes are in master" instead.
function aheadBehindSegs(it) {
  if (it.ahead === undefined) return [];
  if (!it.ahead && !it.behind) return [['·', S.dim]];
  const segs = [];
  if (it.ahead && it.pr?.state === 'merged' && it.pr.head === it.sha) segs.push(['✓', S.magenta]);
  else if (it.ahead) segs.push([`↑${it.ahead}`, S.green]);
  if (it.ahead && it.behind) segs.push([' ', '']);
  if (it.behind) segs.push([`↓${it.behind}`, S.red]);
  return segs;
}

const PR_STYLES = { open: S.green, draft: S.dim, merged: S.magenta, closed: S.red };

function prSegs(pr) {
  if (pr === undefined) return [];
  if (pr === null) return [['·', S.dim]];
  return [[`#${pr.number} ${pr.state}`, PR_STYLES[pr.state]]];
}

const segsLen = (segs) => segs.reduce((n, [t]) => n + t.length, 0);

// The width a painted line takes on screen: its text without the escape codes.
const visibleLen = (line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;

// How many rows up the top of the picker is after the terminal became `cols` wide. Terminals rewrap their lines when
// narrowed, so a line drawn on one row may now take several: `widths` are the lines drawn above the cursor's, `col`
// the cursor's column in its own line.
const rowsAbove = (widths, col, cols) =>
  widths.reduce((n, len) => n + Math.max(1, Math.ceil(len / cols)), 0) + Math.floor(col / cols);

// A fixed-width cell, truncated with '…'. Highlighted positions are styled per char.
function cell(text, w, style = '', hl = null) {
  const cut = text.length > w;
  if (cut) text = text.slice(0, Math.max(0, w - 1)) + '…';
  const segs = [];
  for (let i = 0; i < text.length; i++) {
    const st = hl?.has(i) && !(cut && i === text.length - 1) ? S.match : style;
    const last = segs[segs.length - 1];
    if (last && last[1] === st) last[0] += text[i];
    else segs.push([text[i], st]);
  }
  segs.push([' '.repeat(Math.max(0, w - text.length)), '']);
  return segs;
}

function pad(segs, w) {
  return [...segs, [' '.repeat(Math.max(0, w - segsLen(segs))), '']];
}

// Render segments as one terminal line, truncated to `width` so it never wraps.
function paint(segs, width, base = '') {
  let out = '';
  let used = 0;
  for (const [text, style] of segs) {
    if (used >= width) break;
    const t = text.slice(0, width - used);
    used += t.length;
    const codes = [base, style].filter(Boolean).join(';');
    out += codes ? `\x1b[${codes}m${t}\x1b[0m` : t;
  }
  if (base) out += `\x1b[${base}m${' '.repeat(width - used)}\x1b[0m`;
  return out;
}

function spread(left, right, width) {
  const room = width - segsLen(left) - segsLen(right);
  return paint(room > 0 ? [...left, [' '.repeat(room), ''], ...right] : left, width);
}

function columns(items, width, showPR) {
  const w = {
    branch: Math.max(6, ...items.map((it) => it.label.length)),
    name: Math.max(8, ...items.map((it) => it.name.length)),
    changes: 8,
    ab: Math.max(6, ...items.map((it) => segsLen(aheadBehindSegs(it)))),
    pr: showPR ? Math.max(13, ...items.map((it) => segsLen(prSegs(it.pr)))) : 0, // fits '#12345 merged': no jump when PRs load
    age: 4,
    agent: items.some((it) => it.agent || it.busy || it.deleting) ? GAP.length + 10 : 0,
  };
  const fixed = 4 + 4 * GAP.length + w.changes + w.ab + (showPR ? GAP.length + w.pr : 0) + w.age + w.agent;
  // Too wide: shrink the worktree column first, the branch leads.
  let over = w.branch + w.name - (width - fixed);
  if (over > 0) {
    const cut = Math.min(over, Math.max(0, w.name - 12));
    w.name -= cut;
    over -= cut;
    w.branch -= Math.min(over, Math.max(0, w.branch - 20));
  }
  return w;
}

// ---------------------------------------------------------------------------
// Picker

// `startNotice` is [message, style] shown in the header once the picker is up: an update that landed, say.
function pick(items, root, base, initialQuery, startNotice = null) {
  let input, out;
  try {
    input = new tty.ReadStream(fs.openSync('/dev/tty', 'r'));
    out = new tty.WriteStream(fs.openSync('/dev/tty', 'w'));
  } catch {
    die('needs a terminal');
  }

  const repo = path.basename(root);
  const baseLabel = base ? path.basename(base).toUpperCase() : '';
  const size = () => out.getWindowSize().map((n, i) => n || [80, 24][i]);
  // The list's height: what fits under the header, prompt, blank and column titles, above the blank, subject and path
  const fitList = () => Math.max(1, Math.min(items.length, MAX_ROWS, size()[1] - 8));
  let listH = fitList();
  const PROMPT_ROW = 1;
  let drawn = []; // the widths of the lines on screen, to find our top again after a resize

  let query = initialQuery;
  let caret = query.length; // text cursor position in the query
  let killed = ''; // last text cut by ctrl-w/ctrl-k/ctrl-u, pasted back by ctrl-y
  let results = [];
  let cursor = 0;
  let offset = 0;
  let row = 0; // terminal row (within our area) the cursor is on
  let done = false;
  let notice = null; // [message, style] shown in place of the shortcuts for a few seconds
  let noticeTimer = null;
  let menu = null; // { r, cursor, confirm }: the actions menu of one worktree; `confirm` is { risks, cursor } while
  // confirming a delete, a menu within the menu
  let prPending = false; // the PR request is in flight
  let showPR = items.some((it) => it.pr !== undefined);

  function setQuery(q) {
    query = q;
    results = filter(items, query);
    // Start on the current worktree, else on master (always first)
    cursor = query.trim() ? 0 : Math.max(0, results.findIndex((r) => r.it.current));
    offset = 0;
  }

  // Re-filter after the list changed, staying on the same worktree if it's still there.
  function refilter() {
    const sel = results[cursor]?.it;
    results = filter(items, query);
    const i = results.findIndex((r) => r.it === sel);
    cursor = i >= 0 ? i : Math.max(0, Math.min(cursor, results.length - 1));
  }

  function move(delta) {
    cursor = Math.max(0, Math.min(results.length - 1, cursor + delta));
  }

  // Readline-style editing: the query becomes `before + after`, with the caret in between.
  function edit(before, after = query.slice(caret)) {
    caret = before.length;
    if (before + after !== query) setQuery(before + after);
  }

  function cut(from, to) {
    if (from === to) return;
    killed = query.slice(from, to);
    edit(query.slice(0, from), query.slice(to));
  }

  // Words are separated by spaces and the separators found in branch names.
  const isSep = (ch) => /[-_/.\s]/.test(ch);

  function wordLeft() {
    let i = caret;
    while (i > 0 && isSep(query[i - 1])) i--;
    while (i > 0 && !isSep(query[i - 1])) i--;
    return i;
  }

  function wordRight() {
    let i = caret;
    while (i < query.length && isSep(query[i])) i++;
    while (i < query.length && !isSep(query[i])) i++;
    return i;
  }

  function transpose() {
    const i = caret === query.length ? caret - 1 : caret;
    if (i < 1) return;
    edit(query.slice(0, i - 1) + query[i] + query[i - 1], query.slice(i + 1));
  }

  function complete() {
    const q = query.toLowerCase();
    const keys = [...new Set(results.flatMap((r) => keysOf(r.it)))];
    let cands = keys.filter((k) => k.toLowerCase().startsWith(q));
    if (!cands.length && results.length === 1) cands = keysOf(results[0].it).slice(0, 1);
    if (!cands.length) return;
    let prefix = cands[0];
    for (const c of cands) while (!c.toLowerCase().startsWith(prefix.toLowerCase())) prefix = prefix.slice(0, -1);
    if (prefix.length > query.length || !prefix.toLowerCase().startsWith(q)) edit(prefix, '');
  }

  // ---- Rendering

  function rowLine(r, sel, width, w) {
    const it = r.it;
    // The you-are-here mark, kept outside the selected row's reverse video so it keeps its color
    const marks = [[' ', ''], [it.current ? '●' : ' ', S.green], [' ', '']];
    const segs = [
      [' ', ''], // the selection bar starts one column before the text
      ...cell(it.label, w.branch, it.branch && !it.deleting ? S.bold : S.dim, r.branchPos), [GAP, ''],
      ...cell(it.name, w.name, S.blue, r.namePos), [GAP, ''],
      ...pad(changesSegs(it.status), w.changes), [GAP, ''],
      ...pad(aheadBehindSegs(it), w.ab), [GAP, ''],
      ...(showPR ? [...pad(prSegs(it.pr), w.pr), [GAP, '']] : []),
      ...cell(age(it.date), w.age, S.dim),
    ];
    if (it.deleting) segs.push([GAP, ''], ['deleting…', S.red]);
    else if (it.busy) segs.push([GAP, ''], [`◆ ${it.busy}`, S.magenta]); // an agent is running in it
    else if (it.agent) segs.push([GAP, ''], [`◇ ${it.agent}`, S.dim]); // an agent made it
    const rest = width - segsLen(marks);
    return paint(marks, width) + (sel ? paint(segs.map(([t, st]) => [t, plain(st)]), rest, S.selected) : paint(segs, rest));
  }

  function listRows(width, w) {
    if (cursor < offset) offset = cursor;
    if (cursor >= offset + listH) offset = cursor - listH + 1;
    const rows = [];
    for (let i = offset; i < offset + listH; i++) {
      const r = results[i];
      if (r) rows.push(rowLine(r, i === cursor, width, w));
      else rows.push(i === 0 ? paint([['    no match', S.dim]], width) : '');
    }
    return rows;
  }

  // The selected worktree's row, then its actions or the delete confirmation. Only the selected item is in reverse
  // video: one highlight on screen, where the keys go.
  function menuRows(width, w) {
    const it = menu.r.it;
    const rows = [rowLine(menu.r, false, width, w), ''];
    if (menu.confirm) {
      const what = it.branch ? [['Delete this worktree and its branch ', S.bold], [it.branch, `${S.bold};${S.cyan}`], ['?', S.bold]]
        : [['Delete this worktree?', S.bold]];
      rows.push(paint([['    ', ''], ...what], width));
      for (const [icon, text, style] of menu.confirm.risks) {
        rows.push(paint([['      ', ''], [`${icon} `, style], [text, style === S.green ? '' : style]], width));
      }
      rows.push('', ...itemRows(confirmActions(it), menu.confirm.cursor, width));
    } else rows.push(...itemRows(actionsFor(it), menu.cursor, width));
    while (rows.length < listH) rows.push('');
    return rows;
  }

  // A menu's items, in bars of one width so the notes line up after them. A dangerous item keeps its color selected.
  function itemRows(acts, cursor, width) {
    const labelW = Math.max(...acts.map((a) => a.label.length));
    return acts.map((a, i) => {
      const item = [
        [' ', ''], [a.key, a.disabled ? S.dim : a.style ?? S.cyan], ['  ', ''], [a.label, a.disabled ? S.dim : a.style ?? ''],
        [' '.repeat(labelW - a.label.length + 1), ''],
      ];
      const note = a.disabled ? [a.disabled, S.dim] : a.note;
      const selected = [S.selected, a.style].filter(Boolean).join(';');
      return paint([
        ['   ', ''], ...(i === cursor ? item.map(([t]) => [t, selected]) : item),
        ...(note ? [['  ', ''], note] : []),
      ], width);
    });
  }

  function render() {
    if (done) return;
    const width = size()[0] - 1;
    const w = columns(items, width, showPR);
    const hint = menu ? '↑↓ ⏎ run · esc back' : '⏎ actions';

    const lines = [];
    lines.push(spread(
      [[` ${repo}`, S.bold], [` · ${plural(items.length, 'worktree')}`, S.dim]],
      notice ? [[`${notice[0]} `, notice[1]]] : [[`${hint} `, S.dim]], width));
    lines.push(spread(
      [[' ❯ ', `${S.bold};${S.cyan}`], [query, menu ? S.dim : '']],
      [[`${results.length}/${items.length} `, S.dim]], width));
    lines.push('');
    lines.push(paint([
      ['    ', ''], ...cell('BRANCH', w.branch), [GAP, ''], ...cell('WORKTREE', w.name), [GAP, ''],
      ...cell('CHANGES', w.changes), [GAP, ''], ...cell(baseLabel, w.ab), [GAP, ''],
      ...(showPR ? [...cell('PR', w.pr), [GAP, '']] : []), ...cell('AGE', w.age),
    ], width, S.dim));
    lines.push(...(menu ? menuRows(width, w) : listRows(width, w)));

    lines.push('');
    const it = menu ? menu.r.it : results[cursor]?.it;
    lines.push(it ? paint([['   └ ', S.dim], [it.subject ?? '', '']], width - 1) : '');
    lines.push(it ? paint([[`     ${tilde(it.path)}`, S.dim], [it.current ? '  · you are here' : '', S.green]], width) : '');

    // Overwrite each line in place (clearing only its tail) rather than blanking the area first: no flicker.
    // The menu can be taller than the list: clear what's left below when it closes.
    let s = '\x1b[?25l' + (row > 0 ? `\x1b[${row}A` : '') + '\r' + lines.map((l) => l + '\x1b[K').join('\r\n') + '\x1b[J';
    s += `\x1b[${lines.length - 1 - PROMPT_ROW}A\r\x1b[${3 + caret}C` + (menu ? '' : '\x1b[?25h');
    row = PROMPT_ROW;
    drawn = lines.map(visibleLen);
    out.write(s);
  }

  function resize() {
    if (done) return;
    row = rowsAbove(drawn.slice(0, PROMPT_ROW), 3 + caret, size()[0]);
    listH = fitList();
    render();
  }

  setQuery(query);
  const H = 4 + listH + 3;
  out.write('\n'.repeat(H - 1) + `\x1b[${H - 1}A`); // make room below the prompt, scrolling if needed
  const prChild = loadPRs(items, root, base, () => {
    prPending = false;
    showPR = items.some((it) => it.pr !== undefined); // hide the column if gh failed and nothing was cached
    if (menu?.confirm) menu.confirm.risks = deletionRisks(menu.r.it, root, base, false);
    render();
  });
  if (prChild) prPending = showPR = true;
  render();
  const children = loadStatuses(items, render);
  if (prChild) children.push(prChild);
  loadAgents(items, children, render);
  process.on('SIGWINCH', resize);
  if (startNotice) notify(...startNotice);

  // Close the picker; prints `it`'s path for the shell to cd into. `after` runs once the screen is clean.
  function finish(it, after) {
    // Quitting while the worktree you're in is being deleted: go to the main one instead.
    if (!it && !after && items.find((x) => x.current)?.deleting) it = items[0];
    done = true;
    for (const c of children) c.kill();
    input.setRawMode(false);
    input.pause();
    let s = '\x1b[?25h' + (row > 0 ? `\x1b[${row}A` : '') + '\r\x1b[J';
    if (it) s += paint([['→ ', S.dim], [it.label, S.bold], ['  ', ''], [tilde(it.path), S.blue]], size()[0] - 1) + '\n';
    out.write(s, () => {
      if (it) fs.writeSync(1, it.path + '\n');
      process.exit(after ? after() : it ? 0 : 1);
    });
  }

  function notify(message, style) {
    notice = [message, style];
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice = null; render(); }, 3000);
    render();
  }

  // ---- Actions

  // The actions menu of a worktree, opened with ⏎. Each runs from its key, or from ⏎ once selected: going to the
  // worktree comes first, so ⏎ ⏎ does it.
  function actionsFor(it) {
    const editor = (process.env.EDITOR || '').split(/\s+/).filter(Boolean)[0];
    const name = editor && path.basename(editor);
    const isBase = base && it.branch === path.basename(base);
    const pr = isBase ? null : it.pr;
    return [
      {
        key: '⏎',
        label: 'Go to worktree',
        note: it.current ? ['you are here', S.green] : null,
        run: () => finish(it),
      },
      {
        key: 'g',
        label: !it.branch ? 'Open commit on GitHub' : pr ? `Open PR #${pr.number} on GitHub`
          : pr === null ? 'Open branch on GitHub' : 'Open PR on GitHub',
        note: pr ? [pr.state, PR_STYLES[pr.state]] : pr === null && it.branch && !isBase ? ['no PR', S.dim] : null,
        run: () => openGithub(it, pr),
      },
      {
        key: 'r',
        label: process.platform === 'darwin' ? 'Reveal in Finder' : 'Open in file manager',
        run: () => reveal(it),
      },
      {
        key: 'e',
        label: name ? `Open in ${EDITOR_NAMES[name] ?? name}` : 'Open in editor',
        disabled: !name && '$EDITOR is not set',
        run: () => openEditor(it),
      },
      !it.isMain && {
        key: 'd',
        label: 'Delete worktree…',
        disabled: it.busy && `${AGENTS[it.busy].name} is running in it`,
        // The confirmation opens on "Cancel", so ⏎ ⏎ ⏎ can't delete
        run: (m) => (menu = { ...m, confirm: { risks: deletionRisks(it, root, base, prPending), cursor: 1 } }),
      },
    ].filter(Boolean);
  }

  // The delete confirmation's choices, under what deleting would lose.
  function confirmActions(it) {
    return [
      { key: 'y', label: 'Delete', style: S.red, run: () => remove(it) },
      { key: 'n', label: 'Cancel', run: (m) => (menu = { ...m, confirm: null }) },
    ];
  }

  function runAction(a) {
    if (a.disabled) return notify(a.disabled, S.red);
    const m = menu;
    menu = null;
    a.run(m);
  }

  // Run a command in the background, reporting how it went. `onFail` replaces the error notice.
  function run(cmd, args, cwd, okMessage, onFail) {
    let failed = false;
    const child = cp.spawn(cmd, args, { cwd, detached: true, stdio: 'ignore' });
    child.on('error', () => {
      failed = true;
      notify(`couldn't run ${cmd}`, S.red);
    });
    child.on('close', (code) => {
      if (failed) return;
      if (code === 0) notify(okMessage, S.green);
      else if (onFail) onFail();
      else notify(`${cmd} failed`, S.red);
    });
  }

  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';

  // The branch's PR if it has one, else the branch itself.
  function openGithub(it, pr) {
    if (!it.branch) return run('gh', ['browse', it.sha], it.path, 'opened the commit on GitHub');
    if (pr) return run(opener, [pr.url], undefined, `opened PR #${pr.number} on GitHub`);
    const branch = () => run('gh', ['browse', '--branch', it.branch], it.path, 'opened the branch on GitHub');
    if (pr === null) return branch();
    notify(`looking for a PR on ${it.label}…`, S.dim);
    run('gh', ['pr', 'view', it.branch, '--web'], it.path, 'opened the PR on GitHub', () => {
      notify('no PR: opening the branch…', S.dim);
      branch();
    });
  }

  function reveal(it) {
    if (process.platform === 'darwin') run('open', ['-R', it.path], undefined, 'revealed in Finder');
    else run('xdg-open', [it.path], undefined, 'opened in the file manager');
  }

  function openEditor(it) {
    const [cmd, ...args] = (process.env.EDITOR || '').split(/\s+/).filter(Boolean);
    if (!cmd) return notify('$EDITOR is not set', S.red);
    const name = path.basename(cmd);
    if (!TERMINAL_EDITORS.has(name)) return run(cmd, [...args, it.path], it.path, `opened in ${EDITOR_NAMES[name] ?? name}`);
    // A terminal editor needs the screen: close the picker and hand it the tty.
    finish(null, () => {
      const fd = fs.openSync('/dev/tty', 'r+');
      cp.spawnSync(cmd, [...args, it.path], { cwd: it.path, stdio: [fd, fd, fd] });
      return 1;
    });
  }

  // Delete the worktree and its branch in the background (a big worktree takes seconds): the row says so
  // meanwhile and the picker stays usable. Detached, so quitting doesn't interrupt it.
  function remove(it) {
    it.deleting = true;
    // Move on to the next worktree (else the previous one), so the row being deleted shows it isn't selected anymore.
    if (results[cursor]?.it === it) {
      const next = results.findIndex((r, j) => j > cursor && !r.it.deleting);
      const prev = results.findLastIndex((r, j) => j < cursor && !r.it.deleting);
      if (next >= 0 || prev >= 0) cursor = next >= 0 ? next : prev;
    }
    const cmds = [fs.existsSync(it.path)
      ? ['worktree', 'remove', '--force', ...(it.locked ? ['--force'] : []), it.path]
      : ['worktree', 'prune']];
    if (it.branch) cmds.push(['branch', '-D', it.branch]);
    const script = cmds.map((args) => ['git', '-C', root, ...args].map(shellQuote).join(' ')).join(' && ');
    const child = cp.spawn('sh', ['-c', script], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    child.on('close', (code) => {
      if (done) return;
      if (code !== 0 && fs.existsSync(it.path)) {
        it.deleting = false;
        return notify(`couldn't delete ${it.name}: ${err.trim().split('\n').pop() || 'git failed'}`, S.red);
      }
      items.splice(items.indexOf(it), 1);
      if (it.current) return finish(items[0]); // the shell was in it: go to the main worktree
      refilter();
      if (code !== 0) notify(`deleted ${it.name}, but not its branch: ${err.trim().split('\n').pop()}`, S.yellow);
      else notify(`deleted ${it.name}`, S.green);
    });
  }

  // ---- Keys

  // The actions menu, or the delete confirmation within it: same keys, esc goes back one level.
  function menuKey(key) {
    const { confirm } = menu;
    const m = confirm ?? menu;
    const acts = confirm ? confirmActions(menu.r.it) : actionsFor(menu.r.it);
    switch (key) {
      case '\x1b': case 'q': case '\x1b[D': case '\x1bOD':
        if (confirm) menu.confirm = null;
        else menu = null;
        return;
      case '\x1b[A': case '\x1bOA': case '\x10': case 'k': m.cursor = (m.cursor + acts.length - 1) % acts.length; return;
      case '\x1b[B': case '\x1bOB': case '\x0e': case 'j': m.cursor = (m.cursor + 1) % acts.length; return;
      case '\r': case '\n': case '\x1b[C': case '\x1bOC': return runAction(acts[m.cursor]);
    }
    const a = acts.find((x) => x.key === key.toLowerCase());
    if (a) runAction(a);
  }

  function listKey(key) {
    const it = results[cursor]?.it;
    switch (key) {
      case '\r': case '\n': // the actions menu, on "Go to worktree"
        if (it?.deleting) notify(`${it.name} is being deleted`, S.red);
        else if (it) menu = { r: results[cursor], cursor: 0, confirm: null };
        break;
      case '\x1b':
        return finish(null);

      case '\x04': // ctrl-d: quit on an empty query, else delete forward
        if (!query) return finish(null);
        edit(query.slice(0, caret), query.slice(caret + 1));
        break;
      case '\t': complete(); break;

      // List
      case '\x1b[A': case '\x1bOA': case '\x10': move(-1); break;
      case '\x1b[B': case '\x1bOB': case '\x0e': move(1); break;
      case '\x1b[5~': move(-listH); break;
      case '\x1b[6~': move(listH); break;

      // Caret: ctrl-a/e, home/end, ctrl-b/f, arrows, alt-b/f and alt/ctrl-arrows by word
      case '\x01': case '\x1b[H': case '\x1bOH': case '\x1b[1~': case '\x1b[7~': caret = 0; break;
      case '\x05': case '\x1b[F': case '\x1bOF': case '\x1b[4~': case '\x1b[8~': caret = query.length; break;
      case '\x02': case '\x1b[D': case '\x1bOD': caret = Math.max(0, caret - 1); break;
      case '\x06': case '\x1b[C': case '\x1bOC': caret = Math.min(query.length, caret + 1); break;
      case '\x1bb': case '\x1b[1;3D': case '\x1b[1;5D': case '\x1b[1;9D': caret = wordLeft(); break;
      case '\x1bf': case '\x1b[1;3C': case '\x1b[1;5C': case '\x1b[1;9C': caret = wordRight(); break;

      // Deleting: backspace/ctrl-h, delete, ctrl-w and alt-backspace, alt-d, ctrl-k, ctrl-u, ctrl-y, ctrl-t
      case '\x7f': case '\b': if (caret > 0) edit(query.slice(0, caret - 1)); break;
      case '\x1b[3~': edit(query.slice(0, caret), query.slice(caret + 1)); break;
      case '\x17': case '\x1b\x7f': case '\x1b\b': cut(wordLeft(), caret); break;
      case '\x1bd': case '\x1b[3;3~': cut(caret, wordRight()); break;
      case '\x0b': cut(caret, query.length); break;
      case '\x15': cut(0, caret); break;
      case '\x19': edit(query.slice(0, caret) + killed); break;
      case '\x14': transpose(); break;

      default:
        if (key.length && key >= ' ' && !key.startsWith('\x1b')) edit(query.slice(0, caret) + key);
    }
  }

  input.setRawMode(true);
  input.setEncoding('utf8');
  input.on('data', (data) => {
    for (const key of keys(data)) {
      if (done) return;
      if (key === '\x03') return finish(null); // ctrl-c quits from anywhere
      if (menu) menuKey(key);
      else listKey(key);
    }
    render();
  });
}

// Split raw tty input into keys: escape sequences, alt-chords and single characters.
function* keys(s) {
  for (let i = 0; i < s.length;) {
    if (s[i] === '\x1b' && i + 1 < s.length) {
      const m = /^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Za-z]|.)/su.exec(s.slice(i));
      yield m[0];
      i += m[0].length;
    } else {
      const ch = String.fromCodePoint(s.codePointAt(i));
      yield ch;
      i += ch.length;
    }
  }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shell setup: `wt install` / `wt uninstall`

const SHELLS = ['bash', 'zsh'];
const BLOCK_RE = /# >>> wt >>>[\s\S]*?# <<< wt <<</;
const say = (s = '') => fs.writeSync(2, s + '\n'); // stdout is reserved for the path to cd into

function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function rcFile(shell) {
  if (shell === 'zsh') return path.join(process.env.ZDOTDIR || os.homedir(), '.zshrc');
  // Terminals on macOS start login shells, which read .bash_profile rather than .bashrc.
  return path.join(os.homedir(), process.platform === 'darwin' ? '.bash_profile' : '.bashrc');
}

function shellBlock(shell, bin) {
  const q = shellQuote(bin);
  const lines = ['# >>> wt >>>', '# Added by `wt install`, removed by `wt uninstall`.'];
  if (shell === 'zsh') {
    lines.push(
      'wt() {',
      '  local dir',
      `  dir=$(WT_SHELL=zsh ${q} "$@") && [[ -n $dir ]] && cd -- "$dir"`,
      '}',
      `_wt() { compadd -- \${(f)"$(${q} --complete 2>/dev/null)"}; }`,
      '(( $+functions[compdef] )) && compdef _wt wt',
    );
  } else {
    lines.push(
      'wt() {',
      '  local dir',
      `  dir=$(WT_SHELL=bash ${q} "$@") && [ -n "$dir" ] && cd -- "$dir"`,
      '}',
      `_wt() { local IFS=$'\\n'; COMPREPLY=($(compgen -W "$(${q} --complete 2>/dev/null)" -- "\${COMP_WORDS[COMP_CWORD]}")); }`,
      'complete -F _wt wt',
    );
  }
  lines.push('# <<< wt <<<');
  return lines.join('\n');
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function withBlock(content, block) {
  if (BLOCK_RE.test(content)) return content.replace(BLOCK_RE, () => block); // a function: the bash block contains `$'`
  return content.trim() ? `${content.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

function currentShell() {
  const name = path.basename(process.env.SHELL || '');
  return SHELLS.includes(name) ? name : null;
}

function isExecutable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
}

// Keep the script where it is if it's already on PATH, else copy it to ~/.local/bin. `invoked` is the path it was run
// as, kept as is: npm's global bin is a symlink into node_modules, and the shell function should keep following it.
function installTarget(invoked) {
  const dir = realpath(path.dirname(invoked));
  const onPath = (process.env.PATH || '').split(':').some((d) => d && realpath(d) === dir);
  return onPath ? invoked : path.join(os.homedir(), '.local', 'bin', 'wt');
}

function ask(question) {
  fs.writeSync(2, question);
  try {
    const fd = fs.openSync('/dev/tty', 'r');
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    return /^y(es)?$/i.test(buf.toString('utf8', 0, n).trim());
  } catch {
    return false;
  }
}

// Show each change and why, then apply them all after one confirmation (none with `yes`: the installer's one-liner).
function applySteps(steps, prompt, yes) {
  for (const step of steps) {
    say(`  • ${step.what}`);
    if (step.why) say(`    \x1b[2m${step.why}\x1b[0m`);
    if (step.preview) say(step.preview.replace(/^/gm, '      \x1b[36m').replace(/$/gm, '\x1b[0m'));
  }
  say();
  if (!yes && !ask(`${prompt} [y/N] `)) {
    say('Nothing changed.');
    return false;
  }
  for (const step of steps) step.apply();
  return true;
}

function install(args) {
  const yes = args.some((a) => a === '--yes' || a === '-y');
  args = args.filter((a) => a !== '--yes' && a !== '-y');
  const shells = args.length ? args : [currentShell()].filter(Boolean);
  if (!shells.length) die(`can't tell your shell from $SHELL; run \`wt install bash\` or \`wt install zsh\``);
  for (const sh of shells) if (!SHELLS.includes(sh)) die(`unsupported shell: ${sh} (supported: ${SHELLS.join(', ')})`);

  const invoked = path.resolve(process.argv[1]);
  const self = realpath(invoked);
  const bin = installTarget(invoked);
  const steps = [];
  if (bin !== invoked && readText(bin) !== readText(self)) {
    steps.push({
      what: `${fs.existsSync(bin) ? 'Replace' : 'Copy this script to'} ${tilde(bin)}`,
      why: 'A fixed location for your shell config to point to, so wt keeps working if this file moves.',
      apply: () => {
        fs.mkdirSync(path.dirname(bin), { recursive: true });
        fs.copyFileSync(self, bin);
        fs.chmodSync(bin, 0o755);
      },
    });
  } else if (!isExecutable(bin)) {
    steps.push({ what: `Make ${tilde(bin)} executable`, apply: () => fs.chmodSync(bin, 0o755) });
  }
  for (const sh of shells) {
    const rc = rcFile(sh);
    const content = readText(rc);
    const block = shellBlock(sh, bin);
    const updated = withBlock(content, block);
    if (updated === content) continue;
    steps.push({
      what: `${BLOCK_RE.test(content) ? 'Update' : 'Add'} the wt block in ${tilde(rc)}`,
      why: 'A program can\'t change the directory of the shell that runs it, so `wt` has to be a shell function: ' +
        'it runs the picker and cds into the worktree you choose. It also adds tab completion.',
      preview: block,
      apply: () => fs.writeFileSync(rc, updated),
    });
  }

  if (!steps.length) {
    say(`wt is already installed for ${shells.join(' and ')}.`);
    return;
  }
  say(yes ? 'Installing wt:' : 'To install wt, this will:');
  if (!applySteps(steps, 'Go ahead?', yes)) process.exit(1);
  const rc = tilde(rcFile(shells.includes(currentShell()) ? currentShell() : shells[0]));
  say(`\nDone. Open a new terminal, or run \`source ${rc}\` in this one, then use \`wt\`.`);
}

function uninstall() {
  const steps = [];
  for (const sh of SHELLS) {
    const rc = rcFile(sh);
    const content = readText(rc);
    if (!BLOCK_RE.test(content)) continue;
    const rest = content.replace(new RegExp(`\\n*${BLOCK_RE.source}\\n?`), '\n');
    steps.push({ what: `Remove the wt block from ${tilde(rc)}`, apply: () => fs.writeFileSync(rc, rest.trim() ? rest : '') });
  }
  // The copy `wt install` makes; checked to be this script, not another tool named wt.
  const copy = path.join(os.homedir(), '.local', 'bin', 'wt');
  if (readText(copy).includes('wt install')) steps.push({ what: `Delete ${tilde(copy)}`, apply: () => fs.unlinkSync(copy) });
  if (fs.existsSync(CACHE_DIR)) {
    steps.push({ what: `Delete ${tilde(CACHE_DIR)} (cached PRs and update checks)`, apply: () => fs.rmSync(CACHE_DIR, { recursive: true, force: true }) });
  }
  if (!steps.length) {
    say('wt is not installed.');
    return;
  }
  say('To uninstall wt, this will:');
  if (!applySteps(steps, 'Go ahead?', false)) process.exit(1);
  say('\nDone. Open a new terminal for it to take effect.');
}

// Run directly rather than through the shell function: the cd can't happen, explain why and offer the setup.
function notSetUp() {
  const sh = currentShell();
  if (sh && BLOCK_RE.test(readText(rcFile(sh)))) {
    say(`wt is set up in ${tilde(rcFile(sh))}, but this shell hasn't loaded it yet.`);
    say(`Open a new terminal or run \`source ${tilde(rcFile(sh))}\`, then use \`wt\`.`);
    process.exit(1);
  }
  say('wt needs a small shell function to change your directory, and it isn\'t set up in this shell yet.\n');
  if (!sh) die('run `wt install bash` or `wt install zsh` to set it up');
  install([sh]);
}

// ---------------------------------------------------------------------------
// Updates: `wt update`, and the same in the background
//
// Each release of wt is a GitHub release with this script attached, so no token is needed to get it. Once a day, a
// launch spawns `wt update --background`, which looks at the latest release and, when it's newer, downloads it over
// this file: the next launch runs it and says so. WT_NO_UPDATE=1 turns that off. A copy installed with npm, or run
// from a checkout, is left to npm or git.

// `major.minor.patch`, with an optional `-prerelease` that sorts before the release.
function compareVersions(a, b) {
  const [coreA, preA] = a.trim().replace(/^v/, '').split('-', 2);
  const [coreB, preB] = b.trim().replace(/^v/, '').split('-', 2);
  const pa = coreA.split('.').map(Number);
  const pb = coreB.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA < preB ? -1 : 1;
}

const isNewer = (candidate, current) => compareVersions(candidate, current) > 0;

// The release the "latest" page redirects to: `…/releases/tag/v1.2.3`.
function releaseVersion(location) {
  const m = /\/releases\/tag\/v?([^/?#]+)$/.exec(location || '');
  return m ? decodeURIComponent(m[1]) : null;
}

function readUpdateState() {
  try { return JSON.parse(fs.readFileSync(UPDATE_STATE, 'utf8')) || {}; } catch { return {}; }
}

function writeUpdateState(state) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(UPDATE_STATE, JSON.stringify(state));
  } catch {}
}

// How this copy was installed: the file to replace, or why it can't be.
function installation() {
  const file = realpath(process.argv[1]);
  if (VERSION === DEV_VERSION || fs.existsSync(path.join(path.dirname(file), '..', '.git'))) return { file, how: 'checkout' };
  if (file.includes(`/node_modules/${PACKAGE}/`)) return { file, how: 'npm' };
  return { file, how: 'file' };
}

async function latestRelease() {
  const res = await fetch(`${RELEASES}/latest`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  const version = releaseVersion(res.headers.get('location'));
  if (!version) throw new Error(`no release at ${RELEASES}/latest (HTTP ${res.status})`);
  return version;
}

// Downloads release `version`'s script over `file`: checked to be wt at that version and valid JavaScript, then
// renamed into place, so a reader never sees half a file.
async function download(version, file) {
  const res = await fetch(`${RELEASES}/download/v${version}/wt`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`downloading wt ${version} failed (HTTP ${res.status})`);
  const text = await res.text();
  if (!text.startsWith('#!/usr/bin/env node') || !text.includes(`const VERSION = '${version}';`)) {
    throw new Error(`the download isn't wt ${version}`);
  }
  // No extension: `node --check` refuses one it doesn't know (`.tmp`).
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}-${process.pid}-update`);
  let mode = 0o755;
  try { mode = fs.statSync(file).mode & 0o777; } catch {}
  fs.writeFileSync(tmp, text, { mode });
  try {
    cp.execFileSync(process.execPath, ['--check', tmp], { stdio: 'ignore' });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error(`the download doesn't run: ${e.message}`, { cause: e });
  }
}

// `wt update`: the latest release over this file. `background`: silent, for the launch that spawned it.
async function update(background) {
  const state = readUpdateState();
  const report = (msg) => { if (!background) say(msg); };
  const fail = (msg) => {
    writeUpdateState({ ...state, checked: Date.now(), error: msg });
    if (background) process.exit(1);
    die(msg);
  };
  if (typeof fetch !== 'function') return fail(`updating needs Node 18 or newer (this is ${process.versions.node})`);
  const self = installation();
  let latest;
  try { latest = await latestRelease(); } catch (e) { return fail(`couldn't check the latest release: ${e.message}`); }
  state.checked = Date.now();
  state.latest = latest;
  delete state.error;
  if (!isNewer(latest, VERSION)) {
    writeUpdateState(state);
    return report(`wt ${VERSION} is the latest version.`);
  }
  if (self.how === 'checkout') {
    writeUpdateState(state);
    return report(`wt ${latest} is out. This copy runs from a checkout: update it with git.`);
  }
  if (self.how === 'npm') {
    writeUpdateState(state);
    return report(`wt ${latest} is out. This copy was installed with npm:\n\n  npm install -g ${PACKAGE}@latest`);
  }
  report(`Updating wt ${VERSION} → ${latest}…`);
  try { await download(latest, self.file); } catch (e) { return fail(`${e.message} (${tilde(self.file)})`); }
  state.installed = latest;
  writeUpdateState(state);
  report(`Updated wt to ${latest}. What's new: ${RELEASES}/tag/v${latest}`);
}

// Once a day, from a launch: the check and the update, detached, so the picker never waits on the network.
function checkForUpdateInBackground() {
  if (process.env.WT_NO_UPDATE === '1' || process.env.CI || VERSION === DEV_VERSION || typeof fetch !== 'function') return;
  const state = readUpdateState();
  if (state.checked && Date.now() - state.checked < UPDATE_CHECK_INTERVAL) return;
  writeUpdateState({ ...state, checked: Date.now() });
  try {
    cp.spawn(process.execPath, [process.argv[1], 'update', '--background'], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

// What the picker says in its header on launch: that an update landed (once), or that one is out but couldn't be
// installed here.
function updateNotice() {
  const state = readUpdateState();
  if (state.installed === VERSION && state.announced !== VERSION) {
    writeUpdateState({ ...state, announced: VERSION });
    return [`updated to wt ${VERSION} · ${RELEASES}/tag/v${VERSION}`, S.green];
  }
  if (state.latest && isNewer(state.latest, VERSION) && VERSION !== DEV_VERSION) {
    const how = installation().how;
    return [how === 'npm' ? `wt ${state.latest} is out: npm install -g ${PACKAGE}@latest` : `wt ${state.latest} is out: wt update`, S.yellow];
  }
  return null;
}

// ---------------------------------------------------------------------------

const USAGE = `usage: wt [query]             pick a worktree of the current repo and cd into it
       wt install [bash|zsh]  set up the wt shell function (asks first; --yes doesn't)
       wt uninstall           remove it
       wt update              install the latest release now
       wt --version           print the version (${VERSION})
`;

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '-h' || args[0] === '--help') return void fs.writeSync(2, USAGE);
  // stdout is the path the shell function cds into, so these print to stderr like everything else.
  if (args[0] === '-v' || args[0] === '--version') return void fs.writeSync(2, `wt ${VERSION}\n`);
  if (args[0] === 'install') return install(args.slice(1));
  if (args[0] === 'uninstall') return uninstall();
  if (args[0] === 'update') return void update(args[1] === '--background');
  if (args[0] !== '--complete' && !process.env.WT_SHELL && process.stdout.isTTY) return notSetUp();

  const { items, root } = readWorktrees();
  if (args[0] === '--complete') {
    fs.writeSync(1, [...new Set(items.flatMap(keysOf))].join('\n') + '\n');
    return;
  }
  checkForUpdateInBackground();

  const query = args.join(' ').trim();
  if (query) {
    const hit = exactMatch(items, query) ?? (() => {
      const res = filter(items, query);
      return res.length === 1 ? res[0].it : null;
    })();
    if (hit) {
      fs.writeSync(2, `\x1b[2m→\x1b[0m \x1b[1m${hit.label}\x1b[0m  \x1b[34m${tilde(hit.path)}\x1b[0m\n`);
      fs.writeSync(1, hit.path + '\n');
      return;
    }
  }

  const base = baseRef(root, items);
  loadCommits(items, base);
  items.sort((a, b) => b.isMain - a.isMain || (b.date ?? 0) - (a.date ?? 0) || a.order - b.order);
  items.forEach((it, i) => (it.order = i));
  cachedPRs(items, root);
  pick(items, root, base, query, updateNotice());
}

if (require.main === module) main();
else {
  // For the tests: the pure parts.
  module.exports = {
    VERSION, fuzzy, match, filter, exactMatch, keysOf, parseStatus, age, tilde, keys, cell, paint, columns, visibleLen, rowsAbove,
    shellBlock, withBlock, rcFile, shellQuote, compareVersions, isNewer, releaseVersion,
    AGENTS, agentOf, codexWorktreeRoot, gitDirOf, worktreeHolding, parsePs, parseLsof, loadAgents,
  };
}
