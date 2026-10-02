import type { TarFile } from "./tar";
export { FORWARDER_NODE_IMAGE } from "./versions";

/** Trusted packaged executable bytes come from the Node/build adapter.
 * Private artifacts and deployment credentials stay outside image layers. */
export function runtimeImageFiles(executable: string | Uint8Array): TarFile[] {
  if ((typeof executable !== "string" && !(executable instanceof Uint8Array)) || executable.length === 0) {
    throw new Error("Runtime image requires packaged executable bytes");
  }
  return [
    { name: "runtime/runtime-bin.mjs", content: executable, mode: 0o644 },
    { name: "runtime/entrypoint.sh", content: runtimeImageEntrypoint(), mode: 0o755 },
  ];
}

export function runtimeImageEntrypoint(): string {
  return `#!/bin/sh
set -eu
artifact=/etc/vector/logtura-runtime.json
# Absence preserves unissued installations. Invalid files or dangling links
# enter validation and fail; they must never silently downgrade to legacy.
if [ -e "$artifact" ] || [ -L "$artifact" ]; then
  if [ "$#" -ne 0 ]; then
    if [ "$#" -ne 2 ] || [ "$1" != "--config" ] || [ "$2" != "/etc/vector/vector.yaml" ]; then
      echo "Issued runtime requires its bound configuration" >&2
      exit 64
    fi
  fi
  exec /usr/local/bin/node /opt/logtura/runtime/runtime-bin.mjs --artifact "$artifact"
fi
exec /usr/bin/vector "$@"
`;
}
