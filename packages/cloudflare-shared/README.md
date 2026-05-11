# @logtura/cloudflare-shared

Shared helpers for Cloudflare-* logtura provider drivers. Handles the bits that are the same regardless of which Cloudflare surface (Workers tail, AI Gateway, …) you're consuming: API-token verification, freshness check, the `Bearer …` fetch helper, and the runtime env-var spec the forwarder needs.

Not useful on its own — depend on it from a `@logtura/driver-cloudflare-*` package. If you're writing a third Cloudflare driver, this is what you import.

```bash
npm install @logtura/cloudflare-shared @logtura/core
```

## What's exported

- `cfFetch(path, token, init?)` — JSON-aware fetch against `api.cloudflare.com/client/v4`, throws `ProviderError` with the API's own error message on non-2xx.
- `verifyCfCredentials(creds)` → `ProviderAccount[]` — verifies the token + lists accessible accounts. Drivers wire this as `ProviderDriver.verifyCredentials`.
- `checkCfCredentialFreshness(creds)` → `{ fresh, reason?, expiresAt? }` — checks token status + expiry. Drivers wire this as `ProviderDriver.checkCredentialFreshness`.
- `cfRuntimeSpec({ helpUrl, extraDockerInstall? })` → `{ envVars, dockerfileDeps }` — declares `CLOUDFLARE_API_TOKEN` (credential) + `CLOUDFLARE_ACCOUNT_ID` (external_account_id). Drivers call this from `runtimeSpec`.
- `safeKey(s)` / `shellQuoteCfWorkerName(s)` — small string helpers for naming Vector components + shell-quoting worker names in exec commands.

## License

[Apache 2.0](./LICENSE).
