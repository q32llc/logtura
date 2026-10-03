# Coordinated releases

Release all public packages at the same stable version. Start from a clean public
`main` checkout with successful CI. Update every public `packages/*/package.json`,
regenerate the lockfile, build and run the complete public checks. Commit and push
the candidate before tagging it. The tag must be `vX.Y.Z` and match every package;
an unbumped package fails before publication.

The tag workflow builds the packages, installs their tarballs in an isolated
consumer, checks both CLI aliases and declarations, and runs real runtime tests
and enforced coverage. Only after those checks succeed does it publish the exact
tested archives with npm's OIDC client. It never repacks the workspace for publish.

The packed gate exports `.tmp/release/manifest.json`, all tarballs and their SHA-512
integrities. The manifest records the clean source commit. Registry checks inspect
every intended immutable version before any publish. An existing version with
different bytes fails the release; it must never be overwritten or silently
skipped. Matching versions can be reused after a partial release. Publication is
ordered by public dependencies, and every registry integrity must match before
the workflow creates a GitHub release with the tarballs and receipts attached.

There is no atomic multi-package npm transaction. If publication stops midway,
inspect the `release-evidence` Actions artifact and its `registry-receipt.json`.
An `incomplete` receipt is not a release. Rerun the **same tag and commit**; the
runner checks all existing versions and publishes only missing ones. Do not delete
and retarget the tag, rebuild a different candidate under the same version, or
claim success from a partial registry inventory. A changed archive requires a new
coordinated version. The supported recovery requires byte-identical archives;
otherwise the integrity guard deliberately stops.

The workflow uses GitHub-hosted Ubuntu and Node 24's npm client, with repository
`id-token: write` permission. Every public package needs an npm trusted publisher
for `logtura/logtura`, workflow `release.yml`, with publishing allowed. There is no
environment name or stored npm token in this workflow. npm's
[trusted-publishing documentation](https://docs.npmjs.com/trusted-publishers/)
describes this identity and its client/runtime requirements. Keep permissions
aligned with the actual workflow; a valid local npm session does not prove OIDC
configuration, and a failed local `npm whoami` does not disprove it.

For a local artifact check (replace the version with the committed candidate):

```sh
pnpm install --frozen-lockfile
pnpm build
GITHUB_REF_NAME=vX.Y.Z node scripts/release-artifacts.mjs --check-tag
LOGT_PACKED_ARTIFACTS=.tmp/release-X.Y.Z pnpm test:packed
# Read-only registry proof, after publication:
GITHUB_REF_NAME=vX.Y.Z node scripts/release-artifacts.mjs --verify .tmp/release-X.Y.Z/manifest.json
```

An output directory must be new. Keep the archives and manifest together. These
artifacts contain public package code, not application credentials. Publishing
remains a workflow action; normal test/PR jobs run guard tests without registry
mutations. Service deployment and forwarder upgrade remain separate rollouts with
their own migration, compatibility, image/configuration and rollback evidence.
