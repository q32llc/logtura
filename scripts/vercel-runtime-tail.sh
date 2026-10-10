#!/usr/bin/env bash
set -euo pipefail

if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl is required" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 1
fi

usage() {
  cat <<'EOF'
Usage:
  scripts/vercel-runtime-tail.sh [project_id] [deployment_id]

Env:
  VERCEL_API_TOKEN   (required; VERCEL_API_KEY is also accepted)
  VERCEL_TEAM_ID     (optional; required for team-scoped projects)
  VERCEL_PROJECT_ID  (optional if project_id arg provided)

Behavior:
  - If deployment_id is provided, tail that deployment.
  - Otherwise, resolves latest READY production deployment and tails it.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

PROJECT_ID="${1:-${VERCEL_PROJECT_ID:-}}"
DEPLOYMENT_ID="${2:-}"
TEAM_ID="${VERCEL_TEAM_ID:-}"
TOKEN="${VERCEL_API_TOKEN:-${VERCEL_API_KEY:-}}"

if [[ -z "$TOKEN" ]]; then
  echo "error: VERCEL_API_TOKEN or VERCEL_API_KEY is required" >&2
  exit 1
fi

if [[ -z "$PROJECT_ID" ]]; then
  echo "error: project_id arg or VERCEL_PROJECT_ID is required" >&2
  exit 1
fi

api_get() {
  local url="$1"
  curl -fsSL \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/json" \
    "$url"
}

team_qs() {
  if [[ -n "$TEAM_ID" ]]; then
    printf '&teamId=%s' "$TEAM_ID"
  fi
}

if [[ -z "$DEPLOYMENT_ID" ]]; then
  DEPLOYMENT_ID="$(
    api_get "https://api.vercel.com/v6/deployments?projectId=${PROJECT_ID}&target=production&state=READY&limit=1$(team_qs)" \
      | jq -r '.deployments[0].uid // empty'
  )"
fi

if [[ -z "$DEPLOYMENT_ID" ]]; then
  echo "error: could not resolve deployment id" >&2
  exit 1
fi

echo "Tailing project=${PROJECT_ID} deployment=${DEPLOYMENT_ID}${TEAM_ID:+ team=${TEAM_ID}}" >&2

exec curl -N \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json" \
  "https://api.vercel.com/v1/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/runtime-logs?format=lines$(team_qs)"
