#!/usr/bin/env bash
# Installs wt, the git worktree switcher. Copy this into a terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/frontapp/front-wt/main/install.sh | bash
#
# It downloads the latest release of wt, a single Node script, to ~/.local/bin/wt, then runs `wt install --yes`, which
# adds the `wt` shell function and its completion to your shell's startup file (~/.zshrc; ~/.bashrc, or ~/.bash_profile
# on macOS). The function calls the script by its full path, so ~/.local/bin needn't be on your PATH. wt then keeps
# itself up to date. Run this again to update now, or `wt update`. WT_BIN_DIR picks another directory.
set -euo pipefail

REPO=frontapp/front-wt
BIN_DIR="${WT_BIN_DIR:-$HOME/.local/bin}"
NODE_MIN=18

say() { printf '%s\n' "$*" >&2; }
fail() {
  printf '\nwt was not installed: %s\n' "$*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin | Linux) ;;
  *) fail "wt runs on macOS and Linux (on Windows, in WSL)." ;;
esac
for tool in curl git; do
  command -v "$tool" >/dev/null || fail "it needs $tool."
done

# Node, from the PATH: the shell function runs the script with `/usr/bin/env node`, so the Node your interactive shell
# sees (nvm's, Homebrew's…) is the one that counts.
command -v node >/dev/null ||
  fail "it needs Node.js $NODE_MIN or newer on your PATH. Install it (brew install node, or nvm install --lts) and run this again."
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "$node_major" -ge "$NODE_MIN" ] ||
  fail "it needs Node.js $NODE_MIN or newer; node on your PATH is $(node --version). Update it and run this again."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

url="https://github.com/$REPO/releases/latest/download/wt"
say "Downloading the latest wt..."
curl -fsSL "$url" -o "$work/wt" || fail "couldn't download $url"
head -c 19 "$work/wt" | grep -q '^#!/usr/bin/env node' || fail "the download isn't wt."
node --check "$work/wt" || fail "the download doesn't run on Node $(node --version)."

# Into place in one move, so a `wt` running meanwhile never reads half a file.
mkdir -p "$BIN_DIR"
cp "$work/wt" "$BIN_DIR/wt.tmp.$$"
chmod 755 "$BIN_DIR/wt.tmp.$$"
mv -f "$BIN_DIR/wt.tmp.$$" "$BIN_DIR/wt"
version="$(node "$BIN_DIR/wt" --version 2>&1)" || fail "wt doesn't start: node $BIN_DIR/wt --version failed."
say "$version is in $BIN_DIR/wt."
say ""

# The shell function and completion; it says what it changes. --yes: you ran this to install it.
node "$BIN_DIR/wt" install --yes
