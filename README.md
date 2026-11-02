# wt — switch between git worktrees

`wt` opens an interactive table of the current repo's worktrees and `cd`s into the one you pick.

```
 front · 7 worktrees                                                                     ⏎ actions
 ❯ cal                                                                                         2/7

    BRANCH                         WORKTREE                     CHANGES   MASTER   PR              AGE
    copilot-calendar-timezones     copilot-calendar-timezones   +2        ↑10      #68959 open     9m    ◆ claude
    copilot-teammate-calendars     copilot-teammate-calendars   ·         ↑7 ↓74   #68772 merged   3d
```

## Install

Copy this into a terminal (macOS or Linux, with bash or zsh, git and [Node.js](https://nodejs.org) 18 or newer):

```sh
curl -fsSL https://raw.githubusercontent.com/frontapp/front-wt/main/install.sh | bash
```

Then open a new terminal (or `source ~/.zshrc`) and run `wt`.

The installer downloads the [latest release](https://github.com/frontapp/front-wt/releases/latest) of `wt`, a single file with no dependencies, to `~/.local/bin/wt`, then runs `wt install --yes`, which adds a marked `# >>> wt >>>` block to your shell's startup file (`~/.zshrc`; `~/.bashrc`, or `~/.bash_profile` on macOS). The block defines the `wt` shell function and its tab completion: a program can't change the directory of the shell that runs it, so `wt` has to be a function that runs the picker and `cd`s into the worktree you pick. It calls the script by its full path, so `~/.local/bin` needn't be on your `PATH`. Optional: [`gh`](https://cli.github.com), signed in, for the PR column and opening things on GitHub.

**Updates.** Once a day, a launch of `wt` looks at the latest release in the background and, when it's newer, downloads it over `~/.local/bin/wt`; the next launch runs it and says so in the header. `wt update` does it now; `WT_NO_UPDATE=1` turns the background check off.

**Uninstall.** `wt uninstall` removes the shell block, the script and its cache (`~/.cache/wt`), after asking.

## Usage

```
wt            open the picker
wt cal        open it pre-filtered, or jump straight there if only one worktree matches
wt <TAB>      complete branch and worktree names
wt update     install the latest release now
```

| Key | Action |
|---|---|
| type | filter by branch or worktree name |
| ⇥ | complete the filter as far as the matching names share it |
| ↑ ↓ / ⌃p ⌃n | move |
| ⏎ | open the actions menu for the selected worktree: ⏎ again cds into it |
| esc / ⌃c | quit |

The selected row, and in the menu the selected action, is shown in reverse video.

The actions menu (↑ ↓ and ⏎, or press the action's key; esc goes back). It opens on the first action, so ⏎ ⏎ switches:

| Key | Action |
|---|---|
| ⏎ | Go to worktree (cd into it) |
| g | Open PR on GitHub (or the branch, if there's no PR) |
| r | Reveal in Finder (macOS) or open in the file manager (`xdg-open`) |
| e | Open in `$EDITOR` (named in the menu, e.g. "Open in VS Code") |
| d | Delete worktree… |

**Delete** removes the worktree and deletes its local branch, after a confirmation menu (`y` Delete, `n` Cancel; it opens on Cancel, esc goes back) that says what you'd lose: uncommitted changes, commits that aren't pushed anywhere, and whether the branch is merged. Squash-merged branches count as merged when their PR is merged and its head is the branch tip. It runs in the background (big worktrees take a few seconds), and if you were in that worktree, `wt` takes you to the main one. It's not offered for the main worktree, and is blocked while Claude Code is running in the worktree.

The filter supports readline editing: ⌃a ⌃e, ⌃b ⌃f, ⌥b ⌥f, ⌃w, ⌥d, ⌃k, ⌃u, ⌃y, ⌃t, ⌃d.

Columns: `●` is the worktree you're in, CHANGES is `~modified +untracked`, MASTER is commits ahead ↑ / behind ↓ `origin/master` (`✓` instead of ↑ once the branch's PR is merged, since squash-merged commits never show up in master's history), PR is the branch's latest pull request (open, draft, merged or closed; `·` for none), and `◆ claude` marks a worktree with a running Claude Code session.

PRs come from one GitHub API call per launch (about a second), made after the picker opens. They're cached in `~/.cache/wt/prs.json`, so the column shows the last known state right away and refreshes in place.

## Develop

`wt` is one file, [`src/wt.js`](src/wt.js): Node's core modules and git only, no dependencies, and startup must stay under 100ms. Keep it that way.

```sh
nvm use                       # Node 22, from .nvmrc; any Node 18+ runs it
pnpm install                  # oxlint, the only dev dependency
WT_SHELL=zsh node src/wt.js   # the picker, from the source (prints the chosen path instead of cd-ing)
pnpm test                     # node --test, on the pure parts the script exports
pnpm lint                     # oxlint
pnpm build && pnpm smoke      # dist/wt, with the version from package.json, then run as the release ships it
```

To use your checkout as your `wt`: `node src/wt.js install` points the shell function at it. A checkout reports version `0.0.0-dev` and never updates itself.

### Releases

Every PR bumps the version in `package.json` (`pnpm version patch|minor|major`; the Version Check workflow insists). Merging to `main` runs CI, then the Publish workflow builds `dist/wt`, publishes the package to GitHub Packages, tags the commit `vX.Y.Z` and creates the GitHub release with the script attached as `wt` and notes generated from the merged PRs. That asset is what the installer and `wt update` download, with no token, the repo being public. A run that failed after publishing can be re-run: a version already published or released is skipped.
