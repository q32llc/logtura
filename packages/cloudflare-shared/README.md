# @logtura/cloudflare-shared

Shared helpers for Cloudflare-* logtura provider drivers. Handles the bits that are the same regardless of which Cloudflare surface (Workers tail, AI Gateway, and future drivers) you are consuming: API-token verification, freshness check, the `Bearer ...` fetch helper, and the runtime env-var spec the forwarder needs.

Not useful on its own. Depend on it from a `@logtura/driver-cloudflare-*` package. If you are writing a third Cloudflare driver, this is what you import.

```bash
npm install @logtura/cloudflare-shared @logtura/core
```

## What's exported

- `cfFetch(path, token, init?)`. JSON-aware fetch against `api.cloudflare.com/client/v4`. Throws `ProviderError` with the API's own error message on non-2xx.
- `verifyCfCredentials(creds)` returning `ProviderAccount[]`. Verifies the token and lists accessible accounts. Drivers wire this as `ProviderDriver.verifyCredentials`.
- `checkCfCredentialFreshness(creds)` returning `{ fresh, reason?, expiresAt? }`. Checks token status and expiry. Drivers wire this as `ProviderDriver.checkCredentialFreshness`.
- `cfRuntimeSpec({ helpUrl, extraDockerInstall? })` returning `{ envVars, dockerfileDeps }`. Declares `CLOUDFLARE_API_TOKEN` (credential) and `CLOUDFLARE_ACCOUNT_ID` (external_account_id). Drivers call this from `runtimeSpec`.
- `safeKey(s)` and `shellQuoteCfWorkerName(s)`. Small string helpers for naming Vector components and shell-quoting worker names in exec commands.

## License

[Apache 2.0](./LICENSE).
