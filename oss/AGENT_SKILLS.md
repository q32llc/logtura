# Use Logtura with Claude Code or Codex

The Logtura skill helps an agent set up project log forwarding, connect supported
hosts, change sources/filters/destinations, and update a website-linked forwarder.
It includes Cloudflare, Fly.io, Railway, Vercel, and Supabase recipes.

The skill runs through the open-source CLI. Standalone use requires no Logtura
account. Install Node.js 22+ and `@logtura/cli` 0.3.6 or later; installing the skill alone does
not install the CLI or give the agent provider credentials.

## Quick install from skills.sh

The public [skills.sh listing](https://skills.sh/logtura/logtura) discovers the
same portable skill from this repository and installs it into a supported local
agent:

```sh
npx skills add logtura/logtura --skill logtura
```

Use the native marketplace instructions below when you prefer client-managed
plugin updates or want to pin an immutable release checkout.

Install Git LFS and run `git lfs install` once before cloning a marketplace.
Release archives include image bytes directly and do not require Git LFS.
Claude Code 2.1.291 skips LFS hydration when it clones a GitHub marketplace;
use the hydrated checkout below so its installed icon contains actual PNG bytes.

## Claude Code

```sh
git clone https://github.com/logtura/logtura.git "$HOME/.local/share/logtura-agent-skills"
claude plugin marketplace add "$HOME/.local/share/logtura-agent-skills"
claude plugin install logtura@logtura --scope user
claude plugin details logtura
```

In a new session, invoke `/logtura:logtura` or ask:

> Set up Logtura for this project's Cloudflare Worker logs and deliver errors to
> my webhook. Keep it standalone, and verify a test event reaches the destination.

Use `--scope project` instead of user scope when committing team enablement
settings is desired. Collaborators still need to install the plugin. This guide
targets local Claude Code; terminal files do not automatically sync to cloud sessions.

Update or remove:

```sh
git -C "$HOME/.local/share/logtura-agent-skills" pull --ff-only
claude plugin marketplace update logtura
claude plugin update logtura@logtura
claude plugin uninstall logtura@logtura
```

## Codex

```sh
codex plugin marketplace add logtura/logtura
codex plugin add logtura@logtura
codex plugin list --marketplace logtura --json
```

In a new session select `logtura:logtura` from the skill picker, or invoke
`$logtura:logtura` with the task. Example:

> Use $logtura:logtura to pull my existing website deployment, add this Worker to
> its selections, push the update, and verify the website and forwarder agree.

Refresh the marketplace and reinstall the latest plugin, or remove it:

```sh
codex plugin marketplace upgrade logtura
codex plugin add logtura@logtura
codex plugin remove logtura@logtura
```

Native lifecycle checks currently cover Claude Code 2.1.291 and codex-cli 0.160.1
on Linux. See the CI `agent-reports` artifact for the actual tested versions and
checks. Older clients may require the standalone folder fallback.

## Standalone folder and version pinning

GitHub releases attach `logtura-skill-VERSION.tar.gz` and a SHA-256 receipt
`agent-artifacts.json`. Extract the complete `logtura/` folder into:

| Client | Personal | Project |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| Current Codex | `~/.agents/skills/` | `.agents/skills/` |

Use `/logtura` or `$logtura` for a standalone installation. Keep references and
`agents/` alongside `SKILL.md`; don't copy just the entrypoint. Check client
discovery, especially on older Codex versions that use `~/.codex/skills`.
Keep only one installation route active to avoid duplicate skill entries.

For a reviewed version, install from a checkout of an immutable `vVERSION` tag:
add that checkout as the native marketplace or copy its skill folder. New
marketplace installs from the default branch can differ from a previous release.
Do not overwrite a locally edited standalone folder; back it up and review the
new release before replacing it. Remove only the folder you installed manually.

The npm CLI package also contains the matching skill under
`dist/skills/logtura`, for offline/manual distribution.

## What it can do

The skill guides native host setup for new projects and connects existing ones.
Provider project creation, log ingestion, and deploying the forwarder are
different capabilities. The CLI's native forwarder deploy command is `deploy fly`;
generated Docker bundles can run on another Docker host. It does not claim native
`deploy railway` or `deploy vercel` commands.

Website-linked config updates use existing graph IDs and the CLI's pull/edit/push
protocol. A website revision and a running forwarder's applied revision are
separate checks. Instructions teach both, plus actual test-event delivery.

The package has no MCP server, executable hooks, bundled credentials, or hosted
agent service. Normal execution uses the agent client's own shell permissions
and model service, and the provider/destination credentials the user chooses.

## Contribute and publish

See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[provider example](examples/provider/README.md). Recipes are in
`plugins/logtura/skills/logtura/references/providers/`; the capability snapshot is
generated from the public core catalog and checked against registered drivers.

Native marketplace availability is separate from vendor-directory approval.
This repository is the owned installation source. Directory submission readiness
and review-dependent publication are tracked in [agent publication notes](AGENT_PUBLICATION.md).
