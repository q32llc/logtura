# Agent package publication

The owned GitHub marketplaces and release archives are the primary distribution
paths. The package is skills-only: no MCP server, app binding, hooks, or new
authentication service. Native installation tests make no model calls.

## Release artifacts

After building the public packages:

```sh
node scripts/agent-artifacts.mjs --check
node scripts/test-agent-install.mjs
node scripts/agent-artifacts.mjs --archive .tmp/agents
```

The release workflow attaches the ZIP, standalone tarball, and SHA-256 inventory.
Both client packages contain the same instructions. A normal package version
bump also updates manifest and capability-snapshot versions. Catalog changes
require regenerating metadata (`--write`) after building, then committing it.

## Vendor directory drafts

Listing title: **Logtura**. Subtitle: **Set up log forwarding**.

Draft description: Set up or update Logtura log forwarding from Cloudflare,
Fly.io, Railway, Vercel, or Supabase. Configure selected sources, filters, and
destinations through the open-source CLI, with no Logtura account needed for
standalone use. Existing website-linked forwarders can be updated through the
CLI while retaining deployment identity. Requires a local shell, Node.js 22+,
the Logtura CLI, and credentials for live hosts. Source project setup and forwarder
deployment are separate capabilities; available tools depend on the client surface.

Example prompts:

- Set up standalone Logtura forwarding for my Cloudflare Worker errors.
- Update my website-linked forwarder to include this new site and verify delivery.
- Connect this Railway environment and forward only the selected service's logs.

Publisher display name: **Logtura** (owner-confirmed). Availability: **all supported
countries**, represented by an explicit empty country restriction list. The skill
has no purchase flow; provider charges and the optional hosted service are separate.
The package reuses Logtura's inspected 512 × 512 PNG logo for both listing icons.

Listing destinations:

- Website: https://logtura.com/docs/agent-skills
- Support: https://logtura.com/support
- Privacy: https://logtura.com/privacy
- Terms: https://logtura.com/terms

These are owned website routes; verify the deployed content and anonymous access
before submitting. The privacy page describes the skill, standalone CLI, linked
service, and third-party processing; it promises no invented retention interval.
The owner must review policy adequacy and complete any legal attestations.
The portal may require a verified publisher identity; package display metadata
cannot substitute for verification. Confirm its supported category and commerce
field choices there. No claim of vendor directory approval is made.

OpenAI requires a package upload, validation and review, then owner-controlled
publication. Skill-only plugins need no MCP test cases, demo, or reviewer login.
Claude's official flow accepts a GitHub-hosted package for validation/review.
Neither owned-marketplace installation nor uploading a draft proves approval.

- [OpenAI submission](https://developers.openai.com/plugins/deploy/submission)
- [Claude publishing](https://claude.com/blog/build-plugins-for-claude)

No vendor-directory submission, account-save operation, legal attestation, or
publication approval is performed by the build/release scripts.

## Behavior evaluation

Deterministic CI covers native install/update/removal, actual skill discovery,
package references, provider contracts, CLI fixtures, runtime delivery, and linked
manifest synchronization. These checks do not measure model instruction-following.

Use the task matrix in `docs/agent-skills-and-provider-contributions.md` in the
service repository for budgeted baseline-versus-skill evaluations before directory
submission. Record client/model versions, task inputs, traces, verified output,
and cost. Include negative activation cases. Model evaluations and vendor-native
resource creation have not been represented as passing by these scripts.
