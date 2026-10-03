#!/usr/bin/env bash
#
# Configure npm Trusted Publishing for every @logtura/* package so the
# GitHub Actions release.yml workflow can publish via OIDC instead of
# needing a long-lived NPM_TOKEN. One-time setup.
#
# Usage: scripts/setup-trusted-publishers.sh <otp>
#
# Pass the current npm 2FA OTP as the first arg or in the OTP environment.
# A failed authentication/expired OTP stops setup; rerun with a fresh OTP.
#
# Requirements (per `npm help trust`):
#   - npm >= 11.10.0 (we have 11.11.0)
#   - 2FA enabled on the npm account
#   - The npm session token in ~/.npmrc must NOT be a GAT with the
#     bypass-2FA option (those don't work for `npm trust`).
#   - Each @logtura/* package must already exist on the registry.
set -euo pipefail

# Accept OTP as first arg or environment variable. Do not persist it in source.
OTP="${1:-${OTP:-}}"
if [ -z "$OTP" ]; then
  echo "Need an OTP. Pass as arg, set \$OTP, or put OTP=<code> in ./.env" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mapfile -t PACKAGES < <(node --input-type=module - "$ROOT" <<'JS'
import {inventory} from './oss/scripts/release-artifacts.mjs';
for(const p of inventory(process.argv[2]))console.log(p.name);
JS
)
if [ "${#PACKAGES[@]}" -eq 0 ]; then
  echo "No public package inventory; publisher setup refused." >&2
  exit 1
fi

for pkg in "${PACKAGES[@]}"; do
  echo "→ $pkg"
  npm trust github "$pkg" \
    --file release.yml \
    --repo logtura/logtura \
    --allow-publish \
    --yes \
    --otp="$OTP" 2>&1 | sed 's/^/    /'
  sleep 2
done

echo
echo "✓ Done. Verify on any package page, eg:"
echo "  https://www.npmjs.com/package/@logtura/core/access"
