# Live Cloudflare source delivery canary

This exercises the **published npm 0.3.0 packages**, a real Cloudflare Worker
tail, the generated standalone Vector image, and a local webhook receiver. It
requires Docker on Linux with host networking and a Cloudflare token that can
read/write Workers and open tails. It creates one uniquely named test Worker,
one local container and one local image. It does not use the Logtura service or
change an existing deployment, connection, selection or destination.

Install the registry consumer once, then run from the private repository root:

```sh
mkdir -m 700 -p .tmp/live-source-canary
npm install --prefix .tmp/live-source-canary --ignore-scripts --no-audit --no-fund \
  @logtura/core@0.3.0 @logtura/driver-cloudflare-worker-tail@0.3.0 \
  @logtura/destination-webhook@0.3.0
LOGT_E2E_ALLOW_CLOUDFLARE=1 pnpm test:e2e:live-source
```

Credentials come from `BOOTSTRAP_CLOUDFLARE_ACCOUNT_ID` and
`BOOTSTRAP_CLOUDFLARE_API_TOKEN` in the process environment or the root `.env`.
They are inherited by Docker through its environment rather than command
arguments. No credentials are sent to GitHub. The consumer can be elsewhere
with `LOGT_E2E_LIVE_CONSUMER`; workspace package links are rejected.

The receiver must get the random run marker from an actual Worker trace and
verify the normalized Worker name, error level, error flag and message. The
test emits `console.error` deliberately; its HTTP handler succeeds. It allows
two minutes for delivery and at most 150 direct management requests over ten
minutes. The helper also makes its own bounded tail-session requests. Delivery
counts may vary because requests continue while the webhook batch flushes.

Every run prints its private ledger directory under `.tmp/live-source-canary`.
The ledger records upload/container/image intentions before dispatch; Docker
children wait until their PID is saved. The Docker subprocess has a finite
timeout. Failed or uncertain mutation responses are never blindly replayed.
Diagnostics remain in the private run directory with the token redacted.

Cleanup stops the owned container, verifies its removal, deletes the Worker
only when its random ownership binding matches, verifies the Worker is absent,
then removes and verifies the labeled image. Removing the Worker also removes
its script-scoped tails. Name matches alone never authorize deletion. An
unresolved upload with an absent Worker requires investigation instead of
claiming cleanup. After an interrupted run, inspect its ledger and use:

```sh
LOGT_E2E_ALLOW_CLOUDFLARE=1 \
  LOGT_E2E_LIVE_LEDGER=/absolute/path/to/private/run-directory \
  pnpm test:e2e:live-source --cleanup
```

Cleanup uses an exclusive process lock, refuses a live recorded child, and
does not upload another Worker or restart the forwarder. Repeating successful
cleanup only verifies absence. Do not edit a ledger to acquire ownership of
an unrelated resource.

On October 3, 2026 the first registry-installed consumer delivered three events
from four successful Worker invocations. The reusable harness subsequently
passed delivery, normalization and removal checks. This is evidence for real
standalone source delivery; existing production forwarder upgrades and browser
↔ CLI synchronization have their own acceptance checks.
