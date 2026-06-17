# Zero-knowledge credential redesign

## Goal & non-goals

**Why this exists.** The current architecture, where users hand
provider/deploy/destination credentials to logtura so the server can
verify, discover, and deploy on their behalf, needs to die. It asks for
more trust than the product actually needs. Users do not want to give us
cloud credentials, we do not want to be responsible for holding them,
and the browser can do the credential-bearing work directly.

**Goal.** Provider credentials never sit in plaintext on a logtura
server, and never sit on a logtura server in any form we can
decrypt. Server side holds at most short-lived status-only tokens
for the duration of in-flight operations, and (optionally) a
passphrase/passkey-encrypted vault blob the user controls.

**Not in scope.** Telemetry data plane (logs ingest endpoint stays
as-is; not a credential). Team workspaces (deferred). Background
polling jobs (we don't do this). Account login auth (unchanged).

## Target architecture

- **ProviderDriver execution moves to the browser.**
  `verifyCredentials` and `discoverSources` run in browser code with
  credentials held in JS memory (or unlocked from the vault).
  `generatePipeline` is pure rendering and stays server-side only for
  the non-secret bundle structure. Credential-bearing env values are
  not generated or resolved server-side; the browser tacks them onto
  the final deploy/export artifact after `getCreds(...)`.

- **`connections.credentials_encrypted` goes away.** Replaced by an
  optional client-encrypted vault blob attached to the user, not
  per-connection. A connection row holds only `provider`,
  `external_account_id`, `display_name`, and a vault-key pointer
  (which vault entry holds its creds). If no vault, no stored
  creds, and the user re-pastes per session.

- **Discovery becomes a browser-side operation.** No more
  `discovery` Queue job. The browser calls
  `driver.discoverSources()` directly, then POSTs the resulting
  source list to `/connections/:id/sources` for the server to
  persist. Server validates shape but trusts the client (the
  alternative is the server holding the credential, which is the
  thing we're getting rid of).

- **Deploy happens in the browser.** Browser drives the create-app,
  set-secrets, create-machine/update-machine API calls with the
  user's deploy token. The server never stores a deploy target
  credential and never receives provider or destination secret values
  for the deployment. It can receive status-only identifiers such as
  app name and machine id, and may poll read-only health/status if the
  browser hands it a short-lived status token.

- **Server-side deploy verification is allowed with status-only
  credentials.** The credential-bearing write path stays in the
  browser/user-controlled executor: create app, set secrets, create or
  update machine. After that, the browser can hand logtura a
  short-lived read-only token plus non-secret identifiers so the server
  can verify app/machine existence, machine state, health checks, image
  digest, and rollout completion. That token must not be able to read
  provider/destination secret values. For Fly specifically, this means
  using Fly's secret mechanism for runtime secrets rather than placing
  sensitive values directly in readable machine config env.

- **Destination credentials are out of server bundle assembly.**
  Destination secrets follow the same rule as provider credentials:
  browser memory or the client-encrypted vault only. The server emits
  config shape and env-var names; the browser attaches the actual
  values during in-browser deployment or self-deploy export.

- **Vault.** Optional, post-deploy, separate passphrase from
  account login. Primary unlock is a WebAuthn passkey with the PRF
  extension; passphrase is the recovery path. Whole-blob JSON,
  AES-GCM, key derived from passkey-PRF or Argon2id(passphrase).
  Lives in a new `user_vaults` table:
  `{ user_id, salt, blob, kdf, created_at, updated_at }`.

- **Action-triggered unlock.** Single `getCreds(provider)`
  chokepoint in the web app. Order: session cache, then vault
  (prompt unlock if locked), then paste form. After paste, offer
  "save to vault" if vault exists.

## Feasibility constraints

The architecture works only when credential-bearing calls execute in a
place the user controls, or against provider APIs that allow browser
CORS. A logtura-hosted credential proxy is not an acceptable fallback:
even if it is stateless, the credential still transits our server and
quietly recreates the trust problem this redesign removes.

Initial browser-CORS probe, run 2026-05-14:

- Vercel REST preflight returned permissive CORS (`access-control-allow-origin: *`).
- Supabase Management API returned a CORS preflight, but needs a real
  browser/auth probe per endpoint before treating it as supported.
- Railway GraphQL is callable from non-browser/user-controlled code, but
  the browser CORS preflight for logtura's app origin only allowed
  `https://railway.com`, not the logtura origin.
- Cloudflare API endpoints did not return usable CORS preflight headers
  for logtura's app origin.
- Fly GraphQL and Machines API did not return usable CORS preflight
  headers for logtura's app origin.

So "browser-side" has two execution modes:

1. Direct in-browser provider calls for providers whose APIs support
   CORS from the logtura app.
2. User-controlled execution for the rest: local CLI/helper, browser
   extension, or customer-hosted relay. The secret can pass through
   that component because it is controlled by the user, not logtura.

Fly managed deploy falls into mode 2 unless Fly enables browser CORS for
the required Machines/GraphQL endpoints. The hosted app can still drive
the UX, assemble the non-secret bundle, and hand exact operations to the
user-controlled executor, but logtura's server cannot be the executor
without breaking the zero-knowledge claim.

## Ideas to get around CORS

CORS is a hosted-browser constraint, not a reason to abandon the
zero-knowledge architecture. Options that keep credentials out of
logtura servers:

- **Browser extension as credential executor.** The hosted app talks to
  an installed extension. The extension has host permissions for
  Cloudflare/Fly/Railway/etc. and performs provider API calls from the
  extension context. Secrets stay in extension memory/storage or the
  vault, not logtura.

- **Local companion over localhost.** A small local daemon/CLI started
  by the user listens on `127.0.0.1`; the web app hands it an operation
  plan, and the helper performs provider calls with local credentials.
  Avoids extension-store friction, but adds install/run friction and
  needs careful local auth.

- **Provider OAuth with PKCE where possible.** Browser obtains provider
  tokens directly and uses them directly when the provider's token and
  API endpoints allow browser CORS. Useful for providers that support
  this cleanly; not universal.

- **Generated scripts / provider-native CLIs.** For APIs blocked by
  CORS, the browser can generate exact commands or scripts the user runs
  locally (`flyctl`, `wrangler`, provider CLI/API calls). Less seamless,
  but still zero-knowledge and a good fallback.

- **User-hosted relay.** The user runs a tiny relay in their own infra.
  The secret can transit that relay because it is user-controlled, not
  logtura-controlled. Good for teams; likely too much friction for
  individual first-run.

- **Native messaging extension.** Browser extension plus native host.
  More capable than a plain extension, but significantly more install
  complexity; likely v2 unless normal extension permissions are
  insufficient.

## Open decisions deferred

These don't block starting; pick before the work that needs them.

- **PRF salt scoping.** One salt per vault, or one per credential
  entry? One per vault is simpler and matches whole-blob; defer the
  more granular option to v2 if ever.

- **Multi-passkey UX details.** How many passkeys at minimum
  (recommend at least two), how to enroll a backup, copy that
  pushes users toward enrolling at least one synced plus one
  hardware key.

- **Existing-account migration deadline.** Pick a calendar window
  for purging server-stored credentials after a migration banner
  has been live, once user count is known.

- **User-controlled executor shape.** Pick the default for APIs that do
  not allow browser CORS: local CLI/helper, browser extension, or
  customer-hosted relay. This replaces the earlier idea of a
  logtura-hosted CORS proxy, which is incompatible with the trust goal.

## Risks

- **CORS blockers per provider.** Some provider APIs cannot be called
  from logtura's hosted web origin. Mitigated by a per-provider CORS
  audit and the user-controlled executor path above.

- **Passkey/PRF coverage gaps.** Some browsers/authenticators don't
  support PRF. The passphrase fallback covers them; just need to
  feature-detect and not promise passkey-only.

- **Migration friction.** Some users will skip the migration prompt
  repeatedly and lose their saved creds at the deadline. Mitigated
  by clear in-app banner, email warnings, and the fact that
  re-pasting a Fly token takes 30 seconds.

- **Marketing-claim drift.** Easy for someone to add a "logging
  credentials for debugging" line that quietly breaks the
  zero-knowledge claim. Mitigated by a CI grep against any server
  code path that takes a credential as a parameter, plus the
  threat model doc as a reviewable contract.

## OSS verifiability

The client-side crypto module is the part that holds the whole
zero-knowledge claim together, so the verifiability story matters
as much as the code itself.

- Reproducible web bundle build: pinned dependencies, fixed
  timestamps, deterministic bundler config. CI publishes the
  bundle hash and signs releases.
- SRI on the served bundle's `<script>` tags so a stale CDN can't
  substitute a malicious build.
- Public documentation: threat model, what the client does, how to
  verify the bundle in the user's browser matches the published
  source.
- A small CLI (`logtura verify-bundle <url>`) that fetches the
  page, extracts SRI hashes, compares to the latest GitHub
  release.
