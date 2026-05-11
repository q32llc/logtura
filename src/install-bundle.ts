/**
 * Compose the self-deploy install bundle for one deployment.
 *
 * Output: a single gzipped tarball the user can download, untar, and
 * run with one command. Contains:
 *   - Dockerfile      generated from the provider driver's deps
 *   - vector.yaml     the assembled config
 *   - .env            prefilled with every value we already know;
 *                     missing values are left blank for the user
 *                     to fill (or install.sh will prompt)
 *   - install.sh      preflight + .env loading + docker build + run
 *   - README.md       what this is, how to update, how to stop
 *
 * Everything inside the archive lives under `logtura-<deployment-id>/`
 * so an untar puts a single tidy directory in CWD.
 */

import { assembleDeploymentBundle } from "./bundle-assembly";
import type { Env } from "./env";
import { type TarFile, buildTar, gzipBytes } from "./tar";

export interface InstallBundle {
  filename: string;
  bytes: Uint8Array;
}

export async function buildInstallBundle(
  env: Env,
  userId: string,
  deploymentId: string,
): Promise<InstallBundle> {
  const { deployment, bundle } = await assembleDeploymentBundle(
    env,
    userId,
    deploymentId,
  );

  const dirName = `logtura-${deployment.id.replace(/^dep_/, "").toLowerCase()}`;

  const envFile = renderEnvFile(bundle.envVars);
  const readme = renderReadme(deployment.display_name, bundle.envVars);
  const installSh = renderInstallSh(dirName, bundle.envVars);

  const files: TarFile[] = [
    {
      name: `${dirName}/Dockerfile`,
      content: bundle.dockerfile,
    },
    {
      name: `${dirName}/vector.yaml`,
      content: bundle.vectorYaml,
    },
    { name: `${dirName}/.env`, content: envFile, mode: 0o600 },
    { name: `${dirName}/install.sh`, content: installSh, mode: 0o755 },
    { name: `${dirName}/README.md`, content: readme },
  ];

  const tarBytes = buildTar(files);
  const gz = await gzipBytes(tarBytes);
  return { filename: `${dirName}.tgz`, bytes: gz };
}

interface BundleEnvVar {
  name: string;
  description: string;
  source: string;
  value: string | null;
  staleReason?: string;
}

/** Render a .env file. Known values are inlined; unknown values are
 *  commented placeholders so the user (or install.sh) can fill them. */
function renderEnvFile(envVars: BundleEnvVar[]): string {
  const lines: string[] = [];
  lines.push("# Logtura forwarder — generated config");
  lines.push("# This file contains the credentials Vector needs to reach");
  lines.push("# your sources and destinations. Do not check into git or");
  lines.push("# share. The bundle's install.sh will source this file at");
  lines.push("# `docker run` time via --env-file.");
  lines.push("");
  for (const v of envVars) {
    if (v.description) {
      for (const line of v.description.split("\n")) {
        lines.push(`# ${line}`);
      }
    }
    if (v.value !== null && v.value !== "") {
      lines.push(`${v.name}=${shellQuote(v.value)}`);
    } else {
      lines.push(`# ${v.name}=`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function shellQuote(v: string): string {
  // .env files are commonly read with various parsers. Single-quote
  // the value if it contains anything funky; bare otherwise.
  if (/^[A-Za-z0-9_./:@\-]+$/.test(v)) return v;
  // Escape single quotes by closing/opening — POSIX-portable.
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

function renderReadme(displayName: string, envVars: BundleEnvVar[]): string {
  const missing = envVars
    .filter((v) => v.value === null || v.value === "")
    .map((v) => v.name);
  return `# ${displayName}

This is a logtura forwarder install bundle. Running this container
will tail the log sources you selected in logtura and route them
through your configured monitors and destinations.

## Quick start

\`\`\`
./install.sh
\`\`\`

That preflights Docker, sources \`.env\`, builds the image, and
starts the container with \`--restart=always\`.

${
  missing.length > 0
    ? `## Missing values

\`.env\` is missing these keys (install.sh will prompt if you run it
on a terminal, or fail loudly if you're in CI):

${missing.map((m) => `- \`${m}\``).join("\n")}
`
    : ""
}

## Update the config

logtura generates a fresh bundle every time you change anything. When
your deployment shows the "out of date" badge:

1. Open the deployment in logtura.
2. Click **Download install bundle** again.
3. Re-run \`./install.sh\` (it'll \`docker stop\` the old container
   and start a new one with the new bundle).

## Stop the container

\`\`\`
docker rm -f logtura-forwarder
\`\`\`

## What's inside

- \`Dockerfile\` — pinned to \`timberio/vector\` plus any deps your
  pipeline needs (wrangler for Cloudflare Workers tail, etc.).
- \`vector.yaml\` — the generated pipeline (sources, transforms,
  monitors, sinks).
- \`.env\` — credentials Vector needs to reach your sources and
  destinations. AES-encrypted at rest in logtura; written here in
  plain text so Docker can read them.
- \`install.sh\` — preflight + build + run wrapper.
`;
}

function renderInstallSh(dirName: string, envVars: BundleEnvVar[]): string {
  const required = envVars
    .filter((v) => v.value === null || v.value === "")
    .map((v) => v.name);
  return `#!/bin/sh
# logtura install.sh — generated. Re-running is safe; it replaces
# any existing logtura-forwarder container with a fresh build.

set -eu

IMAGE_TAG="logtura-${dirName.replace(/[^a-z0-9-]/g, "-")}:latest"
CONTAINER_NAME="logtura-forwarder"

NONINTERACTIVE=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --non-interactive) NONINTERACTIVE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      cat <<'HELP'
Usage: ./install.sh [--non-interactive] [--dry-run]

  --non-interactive  Fail rather than prompt for missing env values.
                     Use in CI.
  --dry-run          Print what would happen; don't build or run.
HELP
      exit 0
      ;;
    *)
      echo "unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

# Preflight: docker (or compatible) on PATH.
if command -v docker >/dev/null 2>&1; then
  RUNTIME=docker
elif command -v podman >/dev/null 2>&1; then
  RUNTIME=podman
elif command -v nerdctl >/dev/null 2>&1; then
  RUNTIME=nerdctl
else
  echo "[install.sh] Error: docker (or compatible: podman, nerdctl) not found in PATH." >&2
  echo "  Install Docker: https://docs.docker.com/get-docker/" >&2
  exit 1
fi
echo "[install.sh] container runtime: $RUNTIME"

# Load .env (if present) into the current shell so we can check
# which keys are still missing before invoking docker.
if [ -f .env ]; then
  # shellcheck disable=SC2046
  set -a
  . ./.env
  set +a
  echo "[install.sh] loaded .env"
fi

# Required keys — these came from the bundle's envVars at generate
# time. Anything that already had a value in logtura is prefilled in
# .env; the rest go through the prompt-or-fail path below.
REQUIRED_KEYS="${required.join(" ")}"

missing=""
for key in $REQUIRED_KEYS; do
  eval "val=\\\${$key:-}"
  if [ -z "$val" ]; then
    missing="$missing $key"
  fi
done

if [ -n "$missing" ]; then
  if [ "$NONINTERACTIVE" = "1" ]; then
    echo "[install.sh] Error: missing env keys (non-interactive mode):$missing" >&2
    exit 1
  fi
  if [ ! -t 0 ]; then
    echo "[install.sh] Error: missing env keys and no TTY for prompts:$missing" >&2
    echo "  Set them in .env or run with --non-interactive after exporting." >&2
    exit 1
  fi
  echo "[install.sh] missing env keys — prompting..."
  for key in $missing; do
    printf '  %s: ' "$key"
    # -s would hide the input but isn't POSIX; trust the user.
    read -r val
    if [ -z "$val" ]; then
      echo "[install.sh] Error: $key is required, got empty input." >&2
      exit 1
    fi
    # Append to .env so the user doesn't have to retype on re-run.
    {
      echo ""
      echo "$key=$val"
    } >> .env
    eval "$key=\\"\\$val\\""
    export "$key"
  done
fi

# Recompute env-file flags now that .env is complete.
ENV_FILE_FLAG="--env-file .env"

if [ "$DRY_RUN" = "1" ]; then
  echo "[install.sh] dry run — would build and run:"
  echo "  $RUNTIME build -t $IMAGE_TAG ."
  echo "  $RUNTIME rm -f $CONTAINER_NAME 2>/dev/null || true"
  echo "  $RUNTIME run -d --name $CONTAINER_NAME --restart=always $ENV_FILE_FLAG $IMAGE_TAG"
  exit 0
fi

echo "[install.sh] building image: $IMAGE_TAG"
$RUNTIME build -t "$IMAGE_TAG" .

echo "[install.sh] removing previous container (if any)"
$RUNTIME rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

echo "[install.sh] starting container: $CONTAINER_NAME"
# Splitting $ENV_FILE_FLAG intentionally — it's two tokens.
# shellcheck disable=SC2086
$RUNTIME run -d --name "$CONTAINER_NAME" --restart=always $ENV_FILE_FLAG "$IMAGE_TAG"

echo "[install.sh] running. Tail with:  $RUNTIME logs -f $CONTAINER_NAME"
echo "[install.sh] stop with:           $RUNTIME rm -f $CONTAINER_NAME"
`;
}
