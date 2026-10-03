# @logtura/cloudflare-shared

Shared helpers for Cloudflare-* logtura provider drivers. Handles the bits that are the same regardless of which Cloudflare surface (Workers tail, AI Gateway, and future drivers) you are consuming: API-token verification, freshness check, the `Bearer ...` fetch helper, and the runtime env-var spec the forwarder needs.

Import these helpers directly or use a `@logtura/driver-cloudflare-*` package that calls them. Verification and discovery use Cloudflare APIs and do not require the Logtura service.

```bash
npm install @logtura/cloudflare-shared @logtura/core
```

## What's exported

- `cfFetch(path, token, init?)`. JSON-aware fetch against `api.cloudflare.com/client/v4`. Throws `ProviderError` with the API's own error message on non-2xx.
- `verifyCfCredentials(creds)` returning `ProviderAccount[]`. Verifies the token and lists accessible accounts. Drivers wire this as `ProviderDriver.verifyCredentials`.
- `checkCfCredentialFreshness(creds)` returning `{ fresh, reason?, expiresAt? }`. Checks token status and expiry. Drivers wire this as `ProviderDriver.checkCredentialFreshness`.
- `cfRuntimeSpec({ helpUrl, extraDockerInstall? })` returning `{ envVars, dockerfileDeps }`. Declares `CLOUDFLARE_API_TOKEN` (credential) and `CLOUDFLARE_ACCOUNT_ID` (external_account_id). Drivers call this from `runtimeSpec`.
- `safeKey(s)` and `shellQuoteCfWorkerName(s)`. Small string helpers for naming Vector components and shell-quoting worker names in exec commands.

User-owned tokens are verified at the user-token endpoint and return their
accessible accounts. For account-owned tokens, user-endpoint HTTP 401/403 triggers
account discovery and verification at the account-token endpoint; only the
verified owning account is returned. The token must support listing its accessible
accounts. Fallback considers at most 50 accounts within a shared 60-second
deadline. Inactive tokens are rejected, and freshness retains the verified expiry.
Rate limits, server errors and network failures remain failures.

## License

[Apache 2.0](./LICENSE).
