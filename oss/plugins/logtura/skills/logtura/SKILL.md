---
name: logtura
description: Configure and operate the open-source Logtura CLI, library, and forwarder for Cloudflare, Fly.io, Railway, Vercel, Supabase, and supported destinations. Use for standalone log forwarding, source and filter changes, forwarder deployment, delivery verification, or provider contributions. A Logtura account is optional; use website synchronization only when the user requests a linked deployment.
license: Apache-2.0
metadata:
  requires: Local shell, Node.js 22+, Logtura CLI 0.3.6+; provider credentials for discovery; Docker or Fly for deployment.
---

# Logtura onboarding

Take the user's project from source selection to verified log delivery. Logtura's
CLI, library, and forwarder work without a Logtura account. Website login is only
needed when the user chooses a service-linked deployment.

## Choose the workflow

- For a new standalone installation, read [standalone.md](references/standalone.md).
- For an existing website deployment, read [linked-service.md](references/linked-service.md)
  before editing. Preserve the deployment and graph identities.
- For delivery verification or recovery, read [verify-and-recover.md](references/verify-and-recover.md).
- Read the relevant provider recipe when setting up or connecting that host:
  [Cloudflare](references/providers/cloudflare.md), [Fly](references/providers/fly.md),
  [Railway](references/providers/railway.md), [Vercel](references/providers/vercel.md),
  or [Supabase](references/providers/supabase.md).
- [provider-capabilities.json](references/provider-capabilities.json) is the bundled
  release's catalog. Prefer `logtura providers list --json` from the installed CLI
  when it is newer. For contributing an unsupported provider, read
  [contributing.md](references/contributing.md).

## Establish the starting point

Inspect the project and any existing `logt.yaml` or `logtura.yaml`. Identify the
requested source hosts/resources, destination, and existing forwarder. Keep the
user's chosen platform and mode. Reuse working credentials and project setup.

Check `logtura --help` and required tools. If the CLI is missing, install
`@logtura/cli` (0.3.6 or later) using the project's package manager or run its `logtura` executable
through that package manager. Node.js 22+ is required. Installing this skill does
not install the CLI. CLI package versions can be inspected through the package
manager; don't assume Logtura implements `--version`.

For a new project, follow the provider's native setup flow first. Record the
actual account/project/environment/resource IDs from its output and Logtura
discovery. Creating a source project and deploying the Logtura forwarder are
separate operations: source support for Railway or Vercel does not imply a
`logtura deploy railway` or `logtura deploy vercel` command.

## Configure and validate

Use shorthand CLI commands for a standalone shorthand config. A pulled
`kind: logtura.deployment` document is a portable graph: use graph edit/selection
commands, not shorthand `connect`/`source add` commands.

Review discovered sources and retain only the requested selections. Configure
the destination and filters deliberately; don't forward every discovered
resource merely because discovery returned it. Validate before generating the
bundle. Use `-c <file>` when operating on a nondefault config.

Prefer secure prompts or existing environment variables to tokens in command
arguments. Commit environment references rather than secrets. Bundles and
private graph-edit payloads can contain secrets; preserve their file permissions
and don't attach them to issues, transcripts, or public artifacts.

Keep IDs when changing an existing configuration. Renaming a label or adding a
site must not create a second deployment, replace unrelated selections, or reset
the runtime checkpoint. See the linked workflow for manifest synchronization.

## Deploy and prove delivery

Choose an available forwarder target. The CLI has a native Fly deployment path;
a standalone generated Docker bundle can run on a Docker host. Follow the user's
existing deployment method when updating a forwarder.

Emit a uniquely identifiable test event from the selected source, verify it
arrives at the destination, and inspect component errors/metrics. Building a
valid bundle or seeing a successful deploy response does not prove delivery.
Test filters with both a matching and a nonmatching event when changing them.

For linked deployments, verify both the accepted website configuration and the
forwarder's applied configuration/heartbeat. A successful `push` does not by
itself prove that a self-managed process is running the new bundle.

Use the CLI's pending-operation status and recovery paths after interruption.
Retry only when it is safe to resume the recorded operation. Don't repeat
project creation or deployment creation to work around a missing receipt.

## Report the result

Report source selections, destination, config location, forwarder/deployment
identity, and actual verification evidence. Include any missing credential,
unsupported capability, or unverified live-provider step. Do not claim a live
host workflow was tested when only a fixture or generated config was checked.

The skill follows the user's task authorization and the client's permissions.
It does not authorize unrelated resource creation, purchases, or messages to
others. Continue already-authorized work without adding repetitive approvals.
