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
#   3. copies the required release-note-grade commit message into
#      the public clone's .git/ directory
#   4. shows a `git status` in the public clone so you can review
#      before committing
#
# Idempotent. Doesn't commit, doesn't push — Erik does that manually
# until the workflow shifts to PR-driven.
#
# Usage:
#   scripts/sync-oss.sh --commit-message-file /tmp/logtura-oss-release.md
#   PUBLIC_REPO=/path/to/clone scripts/sync-oss.sh --commit-message-file /tmp/logtura-oss-release.md

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC_REPO="${PUBLIC_REPO:-$ROOT/../logtura-public}"
COMMIT_MESSAGE_FILE=""

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/sync-oss.sh --commit-message-file <path>

Required:
  --commit-message-file
      Path to the public OSS commit message to use after syncing.

      GitHub release notes are generated from the public repo history.
      Do not use a generic message like "Sync from monorepo" or
      "Bump packages"; write a release-note-grade summary of the OSS
      changes that should appear in the generated GitHub release.

Example:
  cat >/tmp/logtura-oss-release.md <<'MSG'
  Release v0.X.Y

  Added:
  - Add Railway log driver.

  Changed:
  - Demux source metrics for broad log streams.
  MSG

  scripts/sync-oss.sh --commit-message-file /tmp/logtura-oss-release.md
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit-message-file)
      if [[ $# -lt 2 ]]; then
        echo "✗ --commit-message-file needs a path." >&2
        usage
        exit 1
      fi
      COMMIT_MESSAGE_FILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "✗ Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$COMMIT_MESSAGE_FILE" ]]; then
  echo "✗ Missing --commit-message-file." >&2
  echo >&2
  usage
  exit 1
fi

if [[ ! -f "$COMMIT_MESSAGE_FILE" ]]; then
  echo "✗ Commit message file not found: $COMMIT_MESSAGE_FILE" >&2
  exit 1
fi

if [[ ! -s "$COMMIT_MESSAGE_FILE" ]]; then
  echo "✗ Commit message file is empty: $COMMIT_MESSAGE_FILE" >&2
  exit 1
fi

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

# This formerly exported configuration was explicitly retired. Preserve other
# public-only files; do not use a blanket --delete on the root sync.
rm -f "$PUBLIC_REPO/codecov.yml"

echo "→ syncing packages/ → $PUBLIC_REPO/packages/ (mirror, --delete)"
mkdir -p "$PUBLIC_REPO/packages"
rsync -a --delete \
  --exclude='node_modules/' \
  --exclude='*.log' \
  --exclude='coverage/' \
  --exclude='.turbo/' \
  --exclude='dist/' \
  --exclude='/cli/logt.yaml' \
  "$ROOT/packages/" "$PUBLIC_REPO/packages/"

cp "$COMMIT_MESSAGE_FILE" "$PUBLIC_REPO/.git/logtura-oss-commit-message"

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
echo "  git add . && git commit -F .git/logtura-oss-commit-message"
echo "  git push origin main"
echo "  # First release: pnpm publish -r --access public"
