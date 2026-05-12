#!/usr/bin/env bash
#
# Configure npm Trusted Publishing for every @logtura/* package so the
# GitHub Actions release.yml workflow can publish via OIDC instead of
# needing a long-lived NPM_TOKEN. One-time setup.
#
# Usage: scripts/setup-trusted-publishers.sh <otp>
#
# Pass the 6-digit npm 2FA OTP as the first arg. The first request
# enables npm's "skip 2FA for the next 5 minutes" window, which lets
# the remaining 10 trust-publisher calls go through without another
# OTP. (Docs: ~80 packages per 5-minute window.)
#
# Requirements (per `npm help trust`):
#   - npm >= 11.10.0 (we have 11.11.0)
#   - 2FA enabled on the npm account
#   - The npm session token in ~/.npmrc must NOT be a GAT with the
#     bypass-2FA option (those don't work for `npm trust`).
#   - Each @logtura/* package must already exist on the registry.
set -euo pipefail

# Accept OTP as first arg, env var, or a .env in the cwd. The .env
# path lets you stash a fresh OTP without piping it through shell
# history.
OTP="${1:-${OTP:-}}"
if [ -z "$OTP" ]; then
  echo "Need an OTP. Pass as arg, set \$OTP, or put OTP=<code> in ./.env" >&2
  exit 1
fi

PACKAGES=(
  core
  cloudflare-shared
  supabase-shared
  driver-cloudflare-worker-tail
  driver-cloudflare-ai-gateway
  driver-fly-log-tail
  driver-supabase-edge-logs
  destination-slack
  destination-webhook
  destination-datadog-metrics
  destination-prometheus-remote-write
)

for pkg in "${PACKAGES[@]}"; do
  echo "→ @logtura/$pkg"
  npm trust github "@logtura/$pkg" \
    --file release.yml \
    --repo logtura/logtura \
    --yes \
    --otp="$OTP" 2>&1 | sed 's/^/    /'
  sleep 2
done

echo
echo "✓ Done. Verify on any package page, eg:"
echo "  https://www.npmjs.com/package/@logtura/core/access"
