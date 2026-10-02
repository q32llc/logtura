/** Shared, runtime-neutral install file composition. Compression and file I/O
 * belong to the caller (Node CLI or Workers service). */
import type { BundleEnvVar, GeneratedBundle } from "./types";
import type { TarFile } from "./tar";
import { runtimeAssetFiles } from "./runtime-assets";

export function installBundleFiles(bundle: GeneratedBundle, name = "logtura-forwarder", displayName = name): TarFile[] {
  const dirName = name.replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "logtura";
  return [
    { name: `${dirName}/Dockerfile`, content: bundle.dockerfile },
    { name: `${dirName}/vector.yaml`, content: bundle.vectorYaml },
    ...runtimeAssetFiles(bundle.runtimeAssets).map(file => ({...file, name: `${dirName}/${file.name}`})),
    { name: `${dirName}/manifest.json`, content: JSON.stringify(bundle.componentManifest, null, 2) },
    { name: `${dirName}/.env`, content: renderEnvFile(bundle.envVars), mode: 0o600 },
    { name: `${dirName}/install.sh`, content: renderInstallSh(dirName, bundle.envVars), mode: 0o755 },
    { name: `${dirName}/README.md`, content: renderReadme(displayName, bundle.envVars) },
  ];
}

/** Render a .env file. Known values are inlined; unknown values are
 *  commented placeholders so the user (or install.sh) can fill them. */
export function renderEnvFile(envVars: BundleEnvVar[]): string {
  for (const variable of envVars) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name)) throw new Error(`Invalid environment variable name: ${variable.name}`);
    if (variable.value?.includes("\0")) throw new Error(`Environment variable ${variable.name} contains a NUL`);
  }
  const lines: string[] = [];
  lines.push("# Logtura forwarder — generated config");
  lines.push("# This file contains the credentials Vector needs to reach");
  lines.push("# your sources and destinations. Do not check into git or");
  lines.push("# share. The bundle's install.sh will source this file at");
  lines.push("# `docker run` time via exported environment variables.");
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

export function shellQuote(v: string): string {
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
  pipeline needs (small Logtura tail helpers, provider CLIs, etc.).
- \`vector.yaml\` — the generated pipeline (sources, transforms,
  monitors, sinks).
- \`.env\` — credentials Vector needs to reach your sources and
  destinations. written here in
  plain text so Docker can read them.
- \`install.sh\` — preflight + build + run wrapper.
`;
}

function renderInstallSh(dirName: string, envVars: BundleEnvVar[]): string {
  const required = envVars.map((v) => v.name);
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

# Check every generated key, including values that have been cleared
# since generation. Missing values go through prompt-or-fail below.
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
    # Prompted values are exported directly; persist only generated .env values.
    export "$key=$val"
  done
fi

# Inherit exported values. Docker --env-file does not understand shell
# quoting, and would change secrets containing spaces, quotes or newlines.
ENV_FILE_FLAG="${envVars.map((v) => `-e ${v.name}`).join(" ")}"

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
# Splitting $ENV_FILE_FLAG intentionally — only validated key names.
# shellcheck disable=SC2086
$RUNTIME run -d --name "$CONTAINER_NAME" --restart=always $ENV_FILE_FLAG "$IMAGE_TAG"

echo "[install.sh] running. Tail with:  $RUNTIME logs -f $CONTAINER_NAME"
echo "[install.sh] stop with:           $RUNTIME rm -f $CONTAINER_NAME"
`;
}

/** Generic self-deploy build context used by the hosted Other target. */
export function selfDeployFiles(bundle: GeneratedBundle): TarFile[] {
  return [
    {name: "Dockerfile", content: bundle.dockerfile},
    {name: "vector.yaml", content: bundle.vectorYaml},
    {name: "run.sh", content: `#!/usr/bin/env bash\nset -euo pipefail\n\n${bundle.runCommand}\n`, mode: 0o600},
    ...runtimeAssetFiles(bundle.runtimeAssets).map(file => ({...file, mode: file.mode ?? 0o644})),
  ];
}
