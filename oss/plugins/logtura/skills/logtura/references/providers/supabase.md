# Supabase

`supabase-edge-logs` selects `functions` of kind `supabase_edge_fn` and optionally
the HTTP `gateway` of kind `supabase_gateway`. It supports native all-selection
as well as explicit lists; choose only the scope requested by the user.

For a new Edge Function project, follow the native Supabase setup: initialize
locally, create a function, link the intended cloud project, and deploy that
function when authorized. Typical commands include `supabase init`,
`supabase functions new NAME`, `supabase link --project-ref PROJECT_REF`, and
`supabase functions deploy NAME`. Creating a cloud project is separate from
initializing local files; follow the current provider flow when none exists.
[Edge Function setup](https://supabase.com/docs/guides/functions/quickstart).

Logtura uses the management personal access token `SUPABASE_PAT` and the project
reference, not an application's anonymous or service-role database key.

```sh
logtura connect supabase --account-id PROJECT_REF
```

Review discovered functions and the gateway selection. Function objects can
contain `slug` and `function_id`; preserve discovered identifiers. Gateway
selection is distinct from a function named `gateway`; its external ID is
`_gateway_`. The connector can discover gateway and function logs together.

For service-linked refreshable credentials, keep the generated credential
sidecar/runtime assets rather than substituting an unrelated application key.
For a standalone management PAT, validate expiry and project access directly.

Invoke the selected function or gateway with a unique test marker and verify
destination delivery. A function deploy alone does not prove access to its log
surface. Recipe reviewed 2026-10-06.
