# @logtura/supabase-shared

Shared helpers for Supabase-* logtura provider drivers. Handles Personal Access Token auth against the Management API, the `Bearer …` fetch helper, project listing for `verifyCredentials`, and the runtime env-var spec.

Today only `@logtura/driver-supabase-edge-logs` consumes this — when a second Supabase surface lands (postgres logs, auth logs, storage logs all hang off the same PAT) the shared bits stay here and the driver-side surface stays slim.

```bash
npm install @logtura/supabase-shared @logtura/core
```

## What's exported

- `sbFetch<T>(path, pat, init?)` → `T` — JSON-aware fetch against `api.supabase.com`, throws `ProviderError` on non-2xx with the Management API's error message.
- `listSupabaseProjects(pat)` → `SupabaseProject[]` — lists every project the PAT can see; used by `verifyCredentials`.
- `verifySupabaseCredentials(creds)` → `ProviderAccount[]` — drivers wire this as `ProviderDriver.verifyCredentials`. Returns each project's `ref` as the account id.
- `sbRuntimeSpec({ helpUrl, extraEnvVars? })` → `{ envVars, dockerfileDeps }` — declares `SUPABASE_PAT` (credential) + `SUPABASE_PROJECT_REF` (external_account_id).
- `safeKey(s)` — Vector-component-name sanitizer.

## License

[Apache 2.0](./LICENSE).
