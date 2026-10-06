# Logtura agent skill release 0.3.6

Recorded October 6, 2026. This is evidence of completed stages, not a claim that
external vendor review or the wider live-provider evaluation matrix is complete.

## Published public package

[Public PR 25](https://github.com/logtura/logtura/pull/25) merged as
`ac9bc1c3f69b1927d617c9311d349fd862cea647`. Exact-main CI run 37475179941 passed;
immutable release run 37476672435 published all 15 npm packages and the
[0.3.6 archives and integrity receipts](https://github.com/logtura/logtura/releases/tag/v0.3.6).

The release includes native Claude Code and Codex marketplaces, a standalone
skill folder archive, and the same instructions inside the CLI npm package.
A fresh disposable client installed from the actual public GitHub repository,
discovered the skill, refreshed the marketplace, and uninstalled it successfully.
Tested clients: Claude Code 2.1.291 and codex-cli 0.160.1 on Linux.

The shared typed catalog, public registry, generic token connector, compatibility
codecs, example provider, and reusable contract harness are implemented. The
service consumes the public registry through `@logtura/cli/providers` while
retaining its explicit six-provider website policy. Contributor documentation
separates a standalone source driver from optional website adapters.

## Tests and owned reports

Backend/workerd validation passed 1,939 tests with all existing coverage gates.
Local owned coverage measured public packages at 99.41% lines and 95.74%
branches, service backend at 95.78% lines and 91.95% branches, and web UI at
95.00% lines and 90.75% branches. The 95% changed-line gate passed at 100%.
CI retains JSON, HTML, and LCOV without an external Codecov service.

The installed-CLI/local-workerd journey verifies website approval and CLI access,
creation/deletion, website → CLI → website manifest edits, actual Vector delivery,
restart/checkpoint persistence, native Fly fixtures, apply/rollback, and cleanup.
Both normal execution and injected-failure cleanup are required CI gates.

[The initial model smoke summary](https://github.com/logtura/logtura/releases/download/v0.3.6/agent-behavior-summary-0.3.6.json)
records 12 final passing fixture outcomes across baseline/skill conditions and both
clients. It does not establish broad model quality, all-host live provisioning,
or complete activation accuracy. The full twelve-task matrix in the plan remains
separate evaluation work. No paid model calls are required in ordinary CI.

## Website and image repair

[Service PR 3](https://github.com/q32llc/logtura/pull/3) passed required CI run
37475119222 and merged as `10a7f356e0018423bbfff7e4349324020d52694a`.
It adds `/docs/agent-skills`, `/privacy`, `/terms`, and `/support` with anonymous
route tests. Publisher display name is Logtura; availability is all supported
countries. Policy pages describe actual instruction/CLI/linked-service behavior
and invent no fixed retention promise. Publisher legal review and attestations
remain the owner's responsibility before directory submission.

The isolated packed-service build had omitted `public/`. It now copies that
folder, rejects unresolved LFS pointers, and verifies original image bytes and
image content types through workerd. Every logo and screenshot is tested.

An immediate image-only repair deployed Worker version
`70121525-c2d4-484b-84b4-831d3c14156a` at 100%. Verification at 14:29 UTC found
all eight original public images served with their exact hashes. The Worker code
remained byte-identical to the accepted 0.3.5 runtime
(`sha256:aab25be01f3ba14819e8fdadd7805b06e0706924c6f437b249539241e1813baa`),
with unchanged bindings. Browser reload confirmed the logo and all six Hosted UX
screenshots load. The original deployment remained running and in sync at
revision 3. The complete registry-backed 0.3.6 website/service rollout follows
its exact-default validation separately.

## Correct Git LFS handling

Small PNGs were briefly committed as ordinary Git blobs during the repair. The
follow-up restores LFS pointers at the repository tips, hydrates asset-sensitive
CI checkouts, verifies pointer/object integrity with `git lfs fsck`, and tests that
both installed native plugins contain actual PNG bytes. The public repository
carries its own attributes and native-consumer Git LFS prerequisite.

Historical ordinary-image commits and immutable release tags are retained;
no history or published release was rewritten. Release ZIP/tar/npm artifacts
contain actual image/content bytes rather than LFS placeholders.

## External publication status

Owned marketplace installation and immutable GitHub/npm releases are shipped.
The listing has an actual inspected 512-square brand icon and concrete website,
support, privacy, and terms routes. Verify the deployed anonymous content before
submitting. Vendor-directory submission, verified publisher selection, legal
attestations, approval, and public listing are distinct outstanding stages.
