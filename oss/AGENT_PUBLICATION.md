# Agent package publication

The owned GitHub marketplaces and release archives are the primary distribution
paths. The package is skills-only: no MCP server, app binding, hooks, or new
authentication service. Native installation tests make no model calls.

## Public discovery status

- [skills.sh](https://skills.sh/logtura/logtura) discovers the public repository
  and exposes `npx skills add logtura/logtura --skill logtura` for supported agents.
- The owned Claude Code and Codex marketplaces are published in this repository
  and covered by native lifecycle tests.
- OpenAI directory upload currently requires developer identity verification in
  the owning Platform organization before a draft can be created.
- Claude Directory submission currently requires an organization owner, or a
  paid personal plan. The currently available Puzzle role can view submissions
  but cannot create one; the personal account is on the Free plan.

Vendor review and publication remain pending. The account owner must complete
identity or plan requirements and the vendors' legal attestations.

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

Listing title: **Logtura**. Subtitle: **Open-source log forwarding**.

Draft description: Configure and operate the open-source Logtura CLI, library,
and forwarder across Cloudflare, Fly.io, Railway, Vercel, Supabase, and supported
destinations. Set up standalone forwarding, choose sources, apply filters, deploy
or update a forwarder, verify delivery, and contribute provider integrations. No
Logtura account is required. Website synchronization is an optional workflow for
linked deployments. Requires a local shell, Node.js 22+, the Logtura CLI, and
credentials for live hosts. Source project setup and forwarder deployment are
separate capabilities; available tools depend on the client surface.

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
- Privacy: https://logtura.com/privacy/plugin
- Terms: https://logtura.com/terms

These are owned website routes; verify the deployed content and anonymous access
before submitting. The plugin-specific notice states that this skills-only package
has no MCP server or Logtura data collection and links to the general policy for
the optional website service.
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

### Initial 0.3.6 model smoke rehearsal

The release includes an owned [sanitized summary](https://github.com/logtura/logtura/releases/download/v0.3.6/agent-behavior-summary-0.3.6.json)
for three fixture cases, with and without the skill, on both native clients:
adding a Worker without losing existing identities and generating a CLI bundle;
answering an unsupported-host question; and analyzing logs without changing
forwarding configuration. All 12 final outcome assertions passed. Codex command
traces show skill reads for the forwarding/catalog tasks and none for log analysis;
Claude's result-only JSON does not establish activation accuracy.

The summary records versions, latency, usage, reported Claude cost, and test
container corrections. This is a small initial rehearsal, not evidence that the
skill outperforms the baseline or that all live host onboarding paths passed.
The wider task matrix and selected live provisioning evaluations remain separate,
budgeted acceptance work. Normal CI still makes no paid model calls.
