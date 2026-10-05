# Local production smoke access

Normal CI uses workerd/Miniflare and fixtures. Production smoke tests are a local
operator command and require no Cloudflare or GitHub Actions credentials.

Sign in with the published CLI using a separate client name and private local file:

```sh
mkdir -p .local/logtura
chmod 700 .local/logtura
LOGT_AUTH_FILE="$PWD/.local/logtura/production-smoke.json" \
  logt login --service https://logtura.com --name local-production-smoke --no-browser
```

Approve the matching device code through the ordinary website account session.
The new grant starts with the normal 90-day expiry. Under **CLI access → Authorized
clients**, choose **Keep until revoked** for this client to retain access permanently.
This is an explicit browser-owner decision; a CLI credential cannot extend its own
lifetime, approve other clients, or revive revoked/expired credentials.

The account credential retains its account read/write scope, including provider
credentials needed by forwarders. The smoke command itself only sends GET requests.
The token is stored locally with mode 0600 in a mode-0700 directory; `.local/` is
excluded from Git. Never include it in releases, reports or ordinary CI artifacts.
The database stores the token hash, not its plaintext value.

Published CLIs retain a numeric expiry in their local file. After the website
confirms **Does not expire; revoke to remove access**, update only `expiresAt` in
that private file to `253402300799999` (the compatible year-9999 sentinel). Do not
change the token, account scope or service origin. That local update alone cannot
extend server authorization. Until the server feature is deployed and this decision
is acknowledged, the file must retain the actual issued 90-day expiry.

```sh
pnpm smoke:production
# Use another explicit private credential file:
LOGT_SMOKE_AUTH_FILE=/private/path/production-smoke.json pnpm smoke:production
```

The command verifies the production account, original deployment identity, running
status and a heartbeat within ten minutes. It reports desired/applied sequences
and `configurationCurrent` separately: a running legacy forwarder can pass liveness
while still lacking a loaded-manifest acknowledgement. It follows no redirects,
requires the bound production origin, and excludes credentials/provider payloads
from output and errors. Nonzero exit means a probe failed; it never mutates the
account, configuration or running forwarder.

Revoke the dedicated client through the website or `logt logout` with its
`LOGT_AUTH_FILE`. Ordinary temporary validation clients are revoked separately.
