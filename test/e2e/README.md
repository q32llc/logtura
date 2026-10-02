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
pnpm build
PLAYWRIGHT_BROWSERS_PATH=.tmp/playwright pnpm exec playwright install chromium
pnpm typecheck:e2e
pnpm test:e2e:local
LOGT_E2E_INJECT_FAILURE=after-create pnpm test:e2e:local
LOGT_E2E_INJECT_FAILURE=after-runtime pnpm test:e2e:local
```

This requires Linux Docker host networking, Node 22+, pinned Playwright Chromium,
npm/pnpm, and access to package/base-image registries. Missing Docker or unsupported platforms fail; the
scenario does not silently skip runtime checks. Private CI pins the verified Ubuntu
24.04 baseline and requires the happy path and both injected failure paths. `after-push` is also available for diagnosis.

CI installs Chromium and its system libraries using `playwright install --with-deps chromium`. On a local Linux host missing browser libraries, use the same `--with-deps` option. See the [official Playwright CI setup](https://playwright.dev/docs/ci).

The runner packs every public package and installs them in a private temporary
consumer. It starts the real bundled service in workerd with a fresh D1 database,
applies all migrations, and seeds only a disposable identity and signed session.
The native Workers Assets plugin serves the real built React UI.
Connection and deployment creation through the actual browser forms, device approval, configuration changes,
reporting and deletion use HTTP endpoints. Its queue actually runs discovery.
Provider requests use strict fixtures and unexpected requests fail verification.
It never loads `.env` or uses an existing CLI account or production database.

A real Chromium browser checks the anonymous CLI access page and creates the
Cloudflare connection through the actual provider form, typing both the connection
name and a private fixture token. It creates the self-managed Fly deployment
through the website wizard and verifies navigation/reload. HTTP then binds the
disposable existing-machine fixture and sets explicit empty source selection for
this configuration/runtime case. The strict provider fixture validates the exact
Bearer credential received; it does not accept arbitrary input. The browser approves an installed
CLI login, and observes the pulled/edited/pushed connection label after sign-out,
a fresh authenticated context and reload. A second CLI login is denied without
replacing the saved account. The browser re-discovers sources, reloads while the
strict provider fixture holds that real queue job, and must render the active job
before release and completion. It reconnects through manual token entry using a
replacement credential; the provider fixture rejects the retired token. CLI pull
must capture the replacement private payload and changed secret version without
exposing the credential in public state. The website creates a connection-scoped monitor with errors and dedup filters,
types a comma-separated field list normally, and reopens the saved filter after
reload. CLI pull/push must capture the exact monitor ID, connection scope and
filter parameters. The browser also creates an HTTPS webhook destination and
attaches a sink to the monitor; both routing IDs and the default per-sink filters
must survive reload and CLI synchronization. The destination payload must remain
absent from public state/YAML and present in the private mode-0600 companion env
file. This tests configuration topology, not webhook event delivery.
The website also enables metrics through Configure/Save;
the revision card becomes stale, and CLI pull/push establishes a new desired
revision before apply. Configure tab selection and metrics settings survive reload.
After actual runtime apply, the browser shows matching desired/applied revisions
and “In sync” across reload. Browser client revocation persists across reload and
the saved CLI token receives HTTP 401. The separately authenticated forwarder
continues reporting after a container restart. Unhandled browser JavaScript errors
fail the scenario. Only identity/session establishment is seeded; GitHub OAuth and
other provider login flows are separate requirements.

An installed CLI applies the synchronized self-managed Fly forwarder. A Fly HTTP
fixture installs the actual planned files into a packaged Docker runtime image. The CLI-only fetch interceptor redirects Machines API requests;
it does not replace service responses or runtime observations. The supervisor is
the image's PID 1 and owns real Vector, which sends heartbeat/metrics to real
workerd. Assertions require accepted applied state, matching desired revision,
checkpoint recovery after a container restart and graceful shutdown. The runtime
executable comes from the installed CLI tarball, with no host Node/package mount.

This case has an explicitly empty provider source selection. It proves heartbeat/
metrics, connection-label/metrics-target synchronization and the browser flows above. Provider event delivery, source/site update behavior,
complete browser/provider flows and actual Fly resources remain required.
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
