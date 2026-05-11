#!/usr/bin/env bash
#
# One-way snapshot from the private logtura monorepo to the public
# github.com/logtura/logtura repo. Run after any change under
# packages/* or oss/*. Push-to-master until contributors arrive;
# future state is option (a) in the OSS plan (public repo is the
# source of truth, this script becomes a one-shot bootstrap).
#
# Layout: a sibling clone of logtura/logtura at $PUBLIC_REPO (default
# ../logtura-public). The script:
#   1. rsyncs the staged root files from oss/ into the public clone
#      root (LICENSE, README.md, CONTRIBUTING.md, package.json,
#      pnpm-workspace.yaml, vitest.config.ts, tsconfig.json,
#      .github/, .gitignore)
#   2. rsyncs packages/* from the private monorepo into the public
#      clone's packages/ — deletes any package no longer present
#      privately
#   3. shows a `git status` in the public clone so you can review
#      before committing
#
# Idempotent. Doesn't commit, doesn't push — Erik does that manually
# until the workflow shifts to PR-driven.
#
# Usage:
#   scripts/sync-oss.sh              # uses ../logtura-public
#   PUBLIC_REPO=/path/to/clone scripts/sync-oss.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC_REPO="${PUBLIC_REPO:-$ROOT/../logtura-public}"

if [[ ! -d "$PUBLIC_REPO/.git" ]]; then
  echo "✗ $PUBLIC_REPO doesn't look like a git clone."
  echo "  Bootstrap with:"
  echo "    gh repo create logtura/logtura --public --description 'Logtura OSS driver packages'"
  echo "    git clone git@github.com:logtura/logtura.git $PUBLIC_REPO"
  exit 1
fi

if ! command -v rsync >/dev/null; then
  echo "✗ rsync not installed."
  exit 1
fi

echo "→ syncing root files from oss/ → $PUBLIC_REPO/"
# rsync the staged root files. --delete-excluded would nuke anything
# the public repo carries that we don't ship from oss/, so we DON'T
# pass --delete here — public-only things (e.g. a hand-written FUNDING
# file someone adds later) survive a sync.
rsync -a \
  --exclude='.git/' \
  --exclude='node_modules/' \
  "$ROOT/oss/" "$PUBLIC_REPO/"

echo "→ syncing packages/ → $PUBLIC_REPO/packages/ (mirror, --delete)"
mkdir -p "$PUBLIC_REPO/packages"
rsync -a --delete \
  --exclude='node_modules/' \
  --exclude='*.log' \
  --exclude='coverage/' \
  --exclude='.turbo/' \
  "$ROOT/packages/" "$PUBLIC_REPO/packages/"

echo
echo "✓ sync complete. Diff in $PUBLIC_REPO:"
echo
cd "$PUBLIC_REPO"
git status --short
echo
echo "Next:"
echo "  cd $PUBLIC_REPO"
echo "  pnpm install"
echo "  pnpm vitest run            # confirm tests pass in the public layout"
echo "  git add . && git commit -m 'Sync from monorepo'"
echo "  git push origin main"
echo "  # First release: pnpm publish -r --access public"
