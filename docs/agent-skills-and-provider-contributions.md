# Logtura skills and provider contributions

Research date: 2026-10-06. Status: researched proposal, not a released skill or plugin. Installation examples below describe the intended release and must not be advertised as working until the package and consumer tests ship.

## Implementation progress

The 0.3.6 candidate now implements the portable skill, five provider recipes,
native marketplaces/manifests, CLI-bundled skill files, release archives,
provider catalog and generic connector path, public registry consumed by the
service, an external-provider example/contract harness, and the website install
page. Native lifecycle tests discover the actual Codex plugin name
`logtura:logtura` and verify updates load changed instruction bytes.

Local validation passed 1,932 backend tests, 310 UI tests, both native client
lifecycle checks, all 15 packed npm consumers, and the service's isolated
packed-package Worker/website/D1 checks. Backend lines/branches measured
97.77%/94.28%; UI lines/branches measured 94.97%/90.75%. Required CI and public
release verification still determine shipping readiness.

Directory drafts are in `oss/AGENT_PUBLICATION.md`. Vendor submission/review,
account-specific legal/listing facts, paid model behavior evaluations, and fresh
vendor-native project provisioning tests remain distinct, unclaimed milestones.
The research below records the original proposal; the public installation guide
is the maintained source for released install commands and tested client names.

## Recommendation

Publish one portable Logtura onboarding skill in the public OSS repository. Package the same files as a native Claude Code plugin and a native Codex plugin. Provide an owned GitHub marketplace for each client, a downloadable skill folder for manual installation, and a short installation page linked from the README and website. Submit the tested release to both vendors' directories afterwards. Offer the third-party `skills` installer as an alternative, rather than making it a dependency.

The skill should help an agent take a new or existing project through provider setup, source discovery, forwarder configuration, deployment, and verified delivery. It must also teach the existing website → CLI → website update workflow. Standalone use remains fully functional without a Logtura account.

Make provider onboarding data a shared, typed catalog instead of maintaining independent lists in the CLI, service, documentation, and skill. Preserve the existing pure driver interface and keep web forms and OAuth routes in the service. A contributor should implement a driver, describe its credentials and capabilities, add a tested recipe, and register it once. A new transport can need substantial implementation; registration should not require knowledge of every application layer.

No MCP server, hosted agent backend, or automatic shell hook is needed for the initial skill. The existing CLI is the execution interface. Installing instructions does not install the CLI or supply provider credentials.

## What is portable, and what differs

The shared unit is a directory containing `SKILL.md` with `name` and `description` frontmatter, plus optional references, scripts, and assets. Use the common Agent Skills format and keep client-specific invocation syntax outside the shared procedures. [Agent Skills specification](https://agentskills.io/specification).

| Concern | Claude Code | Codex |
| --- | --- | --- |
| Personal standalone skill | `~/.claude/skills/logtura/SKILL.md` | Current official documentation: `~/.agents/skills/logtura/SKILL.md` |
| Project standalone skill | `.claude/skills/logtura/SKILL.md` | `.agents/skills/logtura/SKILL.md` |
| Explicit standalone invocation | `/logtura` | `$logtura` |
| Plugin skill invocation | Namespaced, e.g. `/logtura:logtura` | Confirm the installed skill's selector/name in consumer tests |
| Native distribution | Claude marketplace and plugin manifests | Codex marketplace and plugin manifest |

Claude discovers personal, project, and plugin skills, with plugin namespacing. Local terminal files do not automatically become account-synced skills for cloud surfaces. [Claude skills](https://code.claude.com/docs/en/skills).

Codex discovers repository skills under `.agents/skills`, including applicable ancestor directories, and personal skills under `~/.agents/skills`. Its current documentation recommends plugins for reusable distribution. Duplicate skill names are not merged. [OpenAI skill documentation](https://learn.chatgpt.com/docs/build-skills).

There is a migration wrinkle: the installed skill-installer instructions and the third-party `skills` CLI README still describe `~/.codex/skills` for Codex. Do not silently assume those paths are interchangeable. Test actual discovery on supported client versions and use current native distribution as the default. Older clients may need a documented compatibility path. [Third-party installer source](https://github.com/vercel-labs/skills).

Support terminal/local coding clients first. A cloud directory listing must describe what is possible on that surface: a plugin containing instructions does not imply access to the user's local shell, Docker, project files, or provider login. Avoid claiming identical project provisioning behavior across terminal, desktop, IDE, and cloud merely because the files share a format.

## Installation experience

### Preferred: native plugin installation

Proposed marketplace name and plugin name: `logtura`. Proposed public source: `logtura/logtura`.

Claude Code:

```sh
claude plugin marketplace add logtura/logtura
claude plugin install logtura@logtura --scope user
```

Codex:

```sh
codex plugin marketplace add logtura/logtura
codex plugin add logtura@logtura
```

The local binaries support these command shapes: Claude Code 2.1.291 and codex-cli 0.160.1. This investigation checked their help output; it did not install a Logtura package, change the user's plugin settings, or prove a minimum compatible version.

Claude also supports project/local scopes; document when a user wants team-shared configuration. Project enablement settings do not eliminate the need for collaborators to install the plugin. Interactive `/plugin` management is different from a shell installation command; don't put plugin management slash commands into a headless `claude -p` workflow. [Claude plugin installation](https://code.claude.com/docs/en/discover-plugins).

Codex supports adding GitHub or local marketplaces, including a selected Git ref. A repository marketplace lives at `.agents/plugins/marketplace.json`; local plugin source paths are relative to the marketplace repository root. Its portable root `plugin.json` can carry OpenAI extensions; `.codex-plugin/plugin.json` is a compatibility format. Choose one authoritative OpenAI configuration rather than expecting both formats to merge. [Codex plugin packaging](https://developers.openai.com/plugins/build/plugins).

The release installation page should offer one recommended route per client, followed by invocation, a short example request, verification, update, and uninstall instructions. Verify update/uninstall commands against the supported client version during implementation; don't invent symmetric verbs between clients.

### Fallback: a complete standalone skill folder

Ship an archive containing `logtura/SKILL.md` and all referenced files. Explain copying the whole folder into the relevant personal or project directory. Copying only `SKILL.md` breaks progressive references. Personal installation is convenient; project installation can pin the team's instructions to a reviewed repository commit.

Do not overwrite an existing edited skill folder without an explicit user choice. Prefer a versioned backup or a new destination, and explain how to remove duplicate installations. A plugin and a standalone copy should not both be recommended as simultaneous defaults.

A custom `logtura skill install` command is not necessary for v1: native installers already exist. If demand warrants an owned installer later, require atomic writes, an installation receipt, version pinning, conflict detection, dry-run, and an uninstall that removes only files it owns. Do not rewrite `AGENTS.md`, `CLAUDE.md`, shell profiles, or general agent settings as a side effect.

### Optional: the cross-agent installer

After validating discovery of our eventual repository layout:

```sh
npx skills add logtura/logtura --skill logtura --agent claude-code --agent codex
```

This is a third-party convenience route. Test its chosen installation paths against actual client discovery, including the Codex path discrepancy above. Keep default selection/review available instead of encouraging unattended confirmation flags. Its anonymous installation telemetry can be disabled with the documented environment controls. [Installer commands and configuration](https://github.com/vercel-labs/skills).

Skills.sh is an additional discovery channel: its FAQ says leaderboard entries derive from installation telemetry, not a vendor directory submission. Publishing a repository alone does not establish a ranking or official endorsement. Do not generate artificial installs to improve visibility. [Skills.sh FAQ](https://www.skills.sh/docs/faq).

## Package layout and ownership

Proposed public-repository layout:

```text
.claude-plugin/marketplace.json
.agents/plugins/marketplace.json
plugins/logtura/
  plugin.json
  .claude-plugin/plugin.json
  skills/logtura/
    SKILL.md
    agents/openai.yaml
    references/
      standalone.md
      linked-service.md
      verify-and-recover.md
      provider-capabilities.json
      providers/
        cloudflare.md
        fly.md
        railway.md
        vercel.md
        supabase.md
```

Use a portable root plugin manifest with its OpenAI extension and a Claude compatibility manifest. Generate matching names, versions, repository URLs, and licenses from release metadata; validate both schemas. A compatibility manifest is packaging, not a second copy of the instructions. Claude's native manifest location is `.claude-plugin/plugin.json`. [Claude manifest reference](https://code.claude.com/docs/en/plugins-reference).

The Claude marketplace's local source should point to `./plugins/logtura`, relative to the repository root. Validate actual installation as well as JSON shape: a structurally valid marketplace can still contain a nonexistent source path. [Claude marketplace documentation](https://code.claude.com/docs/en/plugin-marketplaces).

In this workspace, public root files originate under `oss/` and are exported by `scripts/sync-oss.sh`. Place canonical public plugin files under `oss/plugins/logtura` and marketplace files under the corresponding `oss/` root directories, or extend the exporter with an explicit allowlist if generated files are built elsewhere. Test the exported public tree, not only the service workspace. Never bundle `.env`, local deployment receipts, private configuration, or unrelated workspace contents.

Keep references inside the skill directory. Archives and cached plugin installs must be self-contained: no links back to service-only files, external workspace paths, or symlinks that escape the package. Generate a compact capability snapshot from the public provider catalog; maintain explanatory provider recipes alongside it. Validate both against the released CLI and drivers.

Use the OSS release version for plugin and skill artifacts initially. Include the minimum supported CLI/client versions and the recipe verification date in release metadata. Release notes should distinguish instruction changes, new provider support, and runtime changes. A new skill must not silently assume an unreleased CLI command.

## Skill behavior and content

Keep `SKILL.md` a short procedure router, targeting roughly 150–250 lines. The important permanent context is Logtura's configuration/identity model, standalone default, linked deployment synchronization, and delivery verification. Load a host reference only when that host is relevant. Avoid generic explanations of Git, Docker, HTTP, or tokens. This follows the standard's guidance on focused skills, progressive detail, and learning from execution failures. [Skill authoring best practices](https://agentskills.io/skill-creation/best-practices).

Proposed description intent: use for setting up or changing Logtura log forwarding, onboarding supported hosts, configuring sources/destinations, and synchronizing a Logtura-linked forwarder. Do not trigger on every deployment, database task, general Cloudflare question, or log-analysis request.

Common procedure:

1. Identify the project, source platforms, destination, existing forwarder, and standalone versus linked mode. Reuse an existing configuration and credentials where applicable.
2. Inspect installed CLI help and configuration before choosing a recipe. Check required tools; install a missing CLI only within the user's task authorization. Do not assume `--version` exists: the current Logtura CLI does not expose it.
3. For a new project, follow the host's native setup/deployment procedure, then discover the resulting resource IDs. For an existing project, go directly to connection and discovery. Keep provider project creation separate from deploying the Logtura forwarder.
4. Connect credentials, discover and select sources, configure sinks and filters, and validate. Use environment references or secure prompts; keep secrets out of transcripts, command arguments, committed config, and skill artifacts.
5. Generate a bundle, inspect the change, and deploy through a supported forwarder target. Preserve source and deployment identities when changing an existing installation.
6. Exercise an identifiable test event and verify source ingestion, sink delivery, and error metrics. A successful build or HTTP response alone is not delivery proof.
7. For linked installations, finish manifest/config synchronization and check website state. Report what changed, resource/deployment identifiers, verification evidence, and any remaining limitation.

The instruction package inherits the user's authorization and the host's permissions. It should not add confirmation to every reversible step, or treat installing a skill as permission to create paid resources, change unrelated deployments, or send notifications to other people.

### Required workflow coverage

| Workflow | Required outcome |
| --- | --- |
| New project on a supported host | Native host setup produces a working resource; Logtura discovers it and delivers a test event |
| Existing project, standalone | Working config and bundle without website login or service calls |
| Existing website deployment → CLI | Pull, edit, validate, push/deploy as appropriate; website reflects the updated manifest and selected sources |
| Add a second host or destination | Existing selections, stable identities, and secret references survive the change |
| Change source selections or filters | Intended difference is applied and observed at the sink |
| Failure and recovery | Clear diagnosis; retry/resume/rollback uses the existing operation protocol |

Current CLI help includes `init`, `connect`, `source add/select/remove`, `sink add`, `validate`, `bundle`, `deploy fly`, `login`, `pull`, `push`, `diff`, configuration operations, and `stats`. Exact arguments belong in tested recipes, not this research document. Provider onboarding support does **not** mean Logtura currently has native forwarder deployers for every source host: `deploy fly` is the current CLI deploy command.

Host-specific references must resolve these details from current official documentation and actual tests:

| Host | Recipe concerns |
| --- | --- |
| Cloudflare | Workers and AI Gateway are distinct source drivers; account/resource selection, token permissions, tail access, and native Wrangler project setup |
| Fly | Application selection, log-tail access, native application creation, forwarder app/volume lifecycle, and credential scope/expiry |
| Railway | Project/environment/service identities, token type, native project setup, and multiplexed log-stream behavior |
| Vercel | Team/project identity, native project deployment, runtime-log transport and retention/plan limits; do not describe this driver as a Log Drain |
| Supabase | Project reference, management credential versus application keys, function/gateway source selection, and native function/project setup |

For example, Fly distinguishes scoped automation tokens from the short-lived token returned by `fly auth token`; a durable forwarder recipe must account for that distinction. [Fly token documentation](https://docs.fly.io/security/tokens).

Do not encode unverified provider plan limits in the shared skill. Record vendor references and verification dates per recipe, and exercise expiry, access denial, rate limiting, and empty discovery using fixtures. Live host provisioning tests need isolated resources and reliable cleanup; local tests cannot prove a vendor entitlement exists.

## Provider architecture investigation

The existing `ProviderDriver<TCreds>` in `packages/core/src/types.ts` is already a useful boundary: credential verification, source discovery, optional freshness checking, and pipeline generation. It deliberately keeps web UX outside the driver. Preserve it.

The main extension friction is duplicated integration knowledge:

| Current location | Knowledge duplicated there | Proposed destination |
| --- | --- | --- |
| `packages/cli/src/registry.ts` and `src/providers/index.ts` | Static driver registration | Shared public registry; service applies an explicit supported-provider policy |
| `packages/cli/src/source-metadata.ts` | Host families, source types, auth hints/scopes | Provider catalog descriptors |
| `packages/cli/src/provider-connectors.ts` | Credential acquisition and host-specific token/account handling | Generic connector from catalog fields, with narrow custom hooks where necessary |
| `packages/cli/src/main.ts` | Source defaults, credential references, provider-specific branches | Descriptor defaults and credential codecs |
| `packages/core/src/config.ts` | Credential decoding, source-account mapping, driver/host mapping, legacy aliases, source row expansion | Explicit codecs and selection adapters; retain compatibility aliases |
| `src/providers/connect/` | Web form/OAuth/connection UX | Keep service-owned adapters; consume shared data where appropriate |
| `oss/CONTRIBUTING.md` | Driver-copy guidance and manual registration knowledge | Complete contributor recipe and reusable contract suite |

The CLI has seven provider drivers, including custom Vector; the service registry has six native providers. Different supported sets can be intentional. Do not make registry unification enable every public driver on the service, or require a SaaS form for a standalone-only provider.

Current contributor instructions suggest copying Fly into a Railway package even though Railway already exists. They also still refer to the service repository as private. Update these examples while making the new path concrete.

### Proposed descriptor contract

Add a public typed descriptor beside a driver, covering:

- Stable driver ID and provider family, display metadata, and source kind.
- Credential field names, environment-reference mapping, required versus optional fields, and a codec that produces the driver's typed credentials.
- Account/resource identity rules and source-selection defaults/codecs.
- Supported selection modes and transport/runtime dependencies.
- Auth acquisition metadata and official documentation links; optional specialized connector behavior.
- Separate capabilities for log ingestion, provider project setup recipes, and forwarder deployment targets.
- Recipe reference and verification metadata, plus optional availability restrictions that can be reported without exposing credentials.

Keep provider-family credentials distinct from source-specific overrides: Railway environment/project fields and Vercel team selection are examples. Preserve existing config aliases, IDs, source selections, environment references, and normalized hashes where behavior is unchanged. Do not discard old fields because a descriptor uses a tidier spelling.

Keep the catalog in a public package/module that both CLI and service can import. Choose its final package boundary based on dependency direction: core should not import all driver packages or introduce a circular dependency. Registration remains explicit reviewed code, not arbitrary npm modules loaded from user configuration.

Do not make a descriptor a second renderer or put provider secrets into documentation metadata. Optional custom hooks are preferable to an increasingly complicated generic OAuth interpreter. A provider requiring unusual auth or streaming may need a custom connector/runtime implementation, but its general registration and reference generation should remain uniform.

### Contributor experience

Provide one example provider with realistic fixtures and an executable contract harness. A proposed scaffold command may generate the package, descriptor, fixture skeleton, and recipe template, but should not generate fake passing tests. If a CLI scaffold adds little value, a maintained example plus a single registration change is enough.

The guide must list exactly which changes enable standalone use, and which optional service adapter enables website onboarding. Document event normalization, namespaced component IDs, output wiring, runtime assets, environment variables, selection behavior, and credential freshness. Separate a new log-source driver from a new forwarder deployment target and a new destination driver.

Shared contract checks should cover deterministic generation, all/list/empty selection, component collisions, stable manifest identities, valid output wiring, secret references without secret values, account scoping, and actionable auth failures. Provider-specific tests must still cover pagination, protocol framing, retries/rate limits, reconnect/checkpoint behavior, and cleanup where applicable.

## Validation and evaluation

Use owned CI coverage/report artifacts and the existing required coverage gates. No external Codecov service is necessary. Instruction files themselves are not meaningful line-coverage targets: test the executable catalog, packaging, contracts, CLI workflows, and runtime behavior, and separately evaluate agent outcomes.

### Required deterministic CI

- Parse frontmatter and validate plugin/marketplace manifests; ensure unique IDs and matching versions.
- Resolve every bundled reference and local marketplace source from an exported public checkout and release archive. Reject missing files or escaping links.
- Verify the archive contains only the intended public files and that npm/release packaging includes the advertised artifacts.
- Run reusable provider contract tests plus genuine provider-specific tests.
- Run actual CLI fixture workflows and generated Vector/native-helper runtime validation using the existing delivery matrix. Preserve local/workerd service tests and linked-manifest synchronization coverage.
- Exercise standalone setup without a Logtura account and linked pull/edit/push with a local service. Use controlled provider fixtures for routine CI.
- Test an existing config and deployment identity through the descriptor migration. Include old aliases, literal and referenced credentials, multiple hosts, selected-resource overrides, and resumed operations.

### Consumer installation tests

On isolated client configurations, install the built marketplace through each native CLI, enumerate/discover the skill, resolve its references, and exercise update/removal. Repeat against the immutable public release, not just a local source directory. Use documented isolation facilities; do not repurpose the operator's real home or change their installed skills during tests.

Record tested client versions and OS environments. Start with Linux and test macOS/Windows path behavior before promising support there. A zero installer exit code is insufficient if the agent cannot discover the skill. Validate third-party installation separately and make it optional if its path handling lags a native client.

### Agent behavior evaluations

Compare the same tasks with and without the skill, using recorded client/model versions, traces, and outcome assertions. Test description activation separately from the quality of an explicitly invoked skill. Include adjacent tasks where it should not activate. [Evaluating skills](https://agentskills.io/skill-creation/evaluating-skills), [description optimization](https://agentskills.io/skill-creation/optimizing-descriptions).

Initial evaluation cases:

1. Existing Cloudflare Worker → standalone webhook delivery.
2. New Fly application → selected logs → Slack test channel fixture.
3. Existing Railway environment with two services → only one selected.
4. Vercel team project → runtime logs without assuming a Log Drain.
5. Supabase function plus gateway selection → normalized events.
6. Existing website-linked forwarder → add a host → website manifest changes.
7. Existing standalone config → change filters without losing IDs or credentials.
8. Expired or insufficient credential → useful recovery without logging the token.
9. Interrupted deployment → resume without duplicating the forwarder.
10. Unsupported host → identify the gap without inventing a supported driver.
11. General host deployment with no log-forwarding request → no unnecessary Logtura onboarding.
12. Log analysis or database migration → no unrelated skill activation.

Score valid config, correct resources, successful delivery, preserved identity, linked sync, appropriate recovery, and unnecessary actions. Avoid judging success solely through generated prose or exact command strings. Account for cost, latency, and repeated attempts when deciding whether the skill improves the baseline.

Keep model evaluations budgeted and reproducible, run before initial release and substantive instruction changes, and publish sanitized summaries. Do not add paid model calls to every pull request by default. Live provider provisioning belongs in an explicitly configured test run with resource receipts and cleanup, not an implicit dependency of normal CI.

## Publishing and discovery

1. **Owned public release:** merge the tested payload and marketplace manifests, cut a versioned archive, and verify a clean install from the public tag. The GitHub release and README must link to the exact same version and installation page.
2. **Website:** add an “Use with Claude Code or Codex” entry alongside ordinary CLI onboarding, with two client choices and a standalone example. State required tools and account-free use plainly.
3. **OpenAI directory:** submit the reviewed plugin ZIP, address validation/review findings, then choose publication. Skill-only submissions do not need the MCP app's demo and positive/negative MCP tool-case requirements. Skills/metadata changes require a new package version and review. [OpenAI submission process](https://developers.openai.com/plugins/deploy/submission).
4. **Claude directory:** use the current official submission flow for a GitHub-hosted bundle. Anthropic's September 25 announcement describes automated validation, review, and owner-controlled publication, with discovery rolling out across Claude surfaces. It says submission is available on paid plans; check the actual account's eligibility before promising a listing date. [Anthropic publishing announcement](https://claude.com/blog/build-plugins-for-claude).
5. **Additional discovery:** document the optional `skills` command, then link to an actual Skills.sh listing if one appears. Add useful GitHub topics and an installation example to the public docs; don't make a ranking or approval a release dependency.

An owned GitHub marketplace and an official vendor directory are different things. We can ship installable packages independently of review; review completion is an external publishing milestone. Prepare complete submission artifacts and listing text before requesting any account-specific action or accepting new agreements. No directory submission or agreement acceptance was performed during this investigation.

The OpenAI documentation also describes adapting Claude plugin assets for its directory, supporting shared instruction content with platform packaging. [Claude plugin conversion guide](https://developers.openai.com/plugins/guides/submit-claude-plugin). Validate the final package rather than assuming either client will accept the other's manifest unchanged.

## Coherent implementation slices

These are AI-sized units: each may span several packages and substantial code. Each ends with a concrete tested change that can be reviewed, merged, and pushed independently.

### Slice 1 — Shared catalog and compatibility migration

Introduce descriptors and a shared public registry; migrate CLI registry, metadata, credential codecs, and source defaults. Adapt service registration to consume the catalog with its explicit availability policy. Preserve web-specific connection adapters and old config behavior.

**Merge gate:** representative old/new configurations normalize identically where semantics are unchanged; CLI/service source discovery and bundle tests pass; existing deployment manifests retain identities; owned coverage gates pass. No plugin required to use the CLI.

### Slice 2 — Complete provider contribution path

Add the reusable contract harness, example provider, registration/recipe guidance, and optional scaffold if useful. Demonstrate a fixture-only example through CLI connection/configuration/bundling without adding another provider-specific branch in core. Update contributor docs and exported public files.

**Merge gate:** a new contributor can follow the documented example; contract failures are meaningful; rendered output validates; bespoke provider hooks remain covered; service adapter requirements are explicit and optional for standalone use.

### Slice 3 — Portable skill and host recipes

Write the common procedure and references for Cloudflare, Fly, Railway, Vercel, and Supabase; generate the capability snapshot from Slice 1. Cover new/existing projects, standalone setup, linked synchronization, updates, delivery proof, and recovery. Verify provider-native creation steps against current official docs before adding executable recipes.

**Merge gate:** every claimed workflow maps to released or same-release executable behavior; fixture runs validate concrete CLI sequences; references are self-contained; no unsupported deployment targets or commands are advertised. Initial behavior evaluation produces recorded findings and fixes.

### Slice 4 — Native packages and release installation

Add both marketplace manifests, portable/compatibility plugin manifests, archives, release version checks, and consumer install/update/remove tests. Export from the service workspace to the public repository through the normal release process. Add optional third-party installation only after discovery tests pass.

**Merge gate:** both supported native clients discover and load the same payload from a clean public release installation; updates select the new version; removal respects ownership; packaging contains no private files. Publish precise compatibility evidence.

### Slice 5 — End-to-end acceptance and owned reports

Complete the provider fixture/runtime matrix and baseline-versus-skill evaluations across both clients. Exercise linked manifest updates against local/workerd and a controlled remote smoke environment. Verify new project recipes on selected live accounts with explicit receipts/cleanup; state which paths remain fixture-only.

**Merge gate:** documented required outcomes pass; standalone does not require the service; website → CLI → website synchronization passes; existing production deployment identities survive; CI publishes owned coverage/runtime/install reports. No blanket live-provider claim based solely on fixtures.

### Slice 6 — Public discovery and directory publication

Publish the installation page, README entry, release assets, and supported-client examples. Prepare the two directory submissions, resolve review findings, and publish when approved. Keep owned installation available while external review proceeds.

**Merge gate:** public links and native install commands work from the released tree; website examples match that release; submission packages/listings are concrete and reviewable. Track submitted, approved, and publicly listed separately; do not mark review-dependent publication complete while still pending.

## Completion evidence

The implementation is finished when a fresh user on either supported native client can find the instructions, install them, complete a documented standalone setup, and update a website-linked forwarder with observable website synchronization; a contributor can add a provider through the public extension path; and public releases contain the same tested payload and owned reports.

At the time it was written, this investigation verified repository architecture, contributor/release export paths, current Logtura CLI help, native client installation command syntax, and the primary documentation linked above. It did not create a plugin, execute model evaluations, install a plugin into the user's account, provision host resources, or submit a directory listing. Implementation and initial acceptance are now recorded in [the 0.3.6 release evidence](agent-skills-release-0.3.6.md); that record distinguishes shipped capabilities from broader evaluations and directory review.
