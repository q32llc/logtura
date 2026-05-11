# @logtura/supabase-shared

Shared helpers for Supabase-* logtura provider drivers. Handles Personal Access Token auth against the Management API, the `Bearer ...` fetch helper, project listing for `verifyCredentials`, and the runtime env-var spec.

Today only `@logtura/driver-supabase-edge-logs` consumes this. When a second Supabase surface lands (postgres logs, auth logs, or storage logs all hang off the same PAT), the shared bits stay here and the driver-side surface stays slim.

```bash
npm install @logtura/supabase-shared @logtura/core
```

## What's exported

- `sbFetch<T>(path, pat, init?)` returning `T`. JSON-aware fetch against `api.supabase.com`. Throws `ProviderError` on non-2xx with the Management API's error message.
- `listSupabaseProjects(pat)` returning `SupabaseProject[]`. Lists every project the PAT can see. Used by `verifyCredentials`.
- `verifySupabaseCredentials(creds)` returning `ProviderAccount[]`. Drivers wire this as `ProviderDriver.verifyCredentials`. Returns each project's `ref` as the account id.
- `sbRuntimeSpec({ helpUrl, extraEnvVars? })` returning `{ envVars, dockerfileDeps }`. Declares `SUPABASE_PAT` (credential) and `SUPABASE_PROJECT_REF` (external_account_id).
- `safeKey(s)`. Vector-component-name sanitizer.

## License

[Apache 2.0](./LICENSE).
