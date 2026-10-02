# Shared HTTP lifecycle tests

`lifecycle.ts` exercises the application through HTTP requests without direct
database access. The workerd test seeds an isolated identity and runs this same
scenario against `SELF`. The HTTP runner accepts a local or remote URL and an
authenticated disposable test account.

```sh
LOGT_E2E_URL=https://staging.example.com \
LOGT_E2E_USER_ID=your-disposable-test-user-id \
LOGT_E2E_ALLOW_REMOTE=1 \
pnpm test:e2e:http
```

Supply `LOGT_E2E_SESSION_COOKIE` through your local environment or secret store;
it is a complete authenticated cookie header. Do not put it in command history
or committed files. The account ID is checked before any mutation. Remote
selection requires `LOGT_E2E_ALLOW_REMOTE=1`; localhost does not.

The current scenario creates a webhook destination, monitor, and sink; verifies
validation, updates and deletion; and removes its resources after failures as
well as success. It records ownership in memory and preserves pre-existing
resources. It does not deploy paid infrastructure. Do not use your normal
production account: mutations can affect deployment-outdated flags. Persistent
cleanup ledgers and the complete provider/deployment/browser matrix remain
planned work in `docs/oss-service-convergence-plan.md`.

The suite fails when credentials are missing, rather than silently skipping.
Run the workerd scenario with:

```sh
pnpm exec vitest run --project workerd test/workerd/e2e-lifecycle.test.ts
```


## Installed CLI and real local runtime

Run from the private repository root after building the public packages:

```sh
pnpm build:packages
pnpm typecheck:e2e
pnpm test:e2e:local
LOGT_E2E_INJECT_FAILURE=after-create pnpm test:e2e:local
LOGT_E2E_INJECT_FAILURE=after-runtime pnpm test:e2e:local
```

This requires Linux Docker host networking, Node 22+, npm/pnpm, and access to
package/base-image registries. Missing Docker or unsupported platforms fail; the
scenario does not silently skip runtime checks. Private CI requires the happy path
and both injected failure paths. `after-push` is also available for diagnosis.

The runner packs every public package and installs them in a private temporary
consumer. It starts the real bundled service in workerd with a fresh D1 database,
applies all migrations, and seeds only a disposable identity and signed session.
Connection and deployment creation, device approval, configuration changes,
reporting and deletion use HTTP endpoints. Its queue actually runs discovery.
Provider requests use strict fixtures and unexpected requests fail verification.
It never loads `.env` or uses an existing CLI account or production database.

An installed CLI signs in through device approval, pulls a self-managed Fly
forwarder, edits its connection label, pushes the desired revision and applies
it. A Fly HTTP fixture installs the actual planned files into a packaged Docker
runtime image. The CLI-only fetch interceptor redirects Machines API requests;
it does not replace service responses or runtime observations. The supervisor is
the image's PID 1 and owns real Vector, which sends heartbeat/metrics to real
workerd. Assertions require accepted applied state, matching desired revision,
checkpoint recovery after a container restart and graceful shutdown. The runtime
executable comes from the installed CLI tarball, with no host Node/package mount.

This case has an explicitly empty provider source selection. It proves a
heartbeat/metrics topology and connection-label synchronization, not provider event
delivery, source/site update behavior, browser rendering or actual Fly resources.
The fixture maps an immutable-looking image reference to a verified Docker image
configuration ID; real Fly registry/index/platform digest behavior remains a
separate required check. The existing standalone Vector flow tests exercise actual
custom-source event delivery separately.

Cleanup deletes and verifies HTTP resources, stops/removes child processes,
removes the unique container/checkpoint volume/image tag, disposes workerd, and
removes private temporary files. Cleanup failure fails the scenario. Injected
failure cases pass only if their specified boundary is reached and cleanup passes.
They demonstrate teardown on interruption paths, not SIGKILL recovery of the E2E
runner itself; persistent remote ledgers remain planned work.
