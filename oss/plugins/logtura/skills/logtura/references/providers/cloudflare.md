# Cloudflare Workers and AI Gateway

Two source drivers share Cloudflare credentials: `cloudflare-worker-tail` selects
`scripts` and emits `cf_worker`; `cloudflare-ai-gateway` selects `gateways` and
emits `cf_ai_gateway`. Both use explicit lists, not native all-selection.

For a new Worker, follow the project's framework and Wrangler configuration. A
new application can start with `npm create cloudflare@latest`; use Wrangler login
and deploy from the chosen project. Keep the resulting account and Worker name.
Do not scaffold over existing source files. AI Gateway is a separate resource;
a Worker deployment does not create a gateway automatically. [Official Worker
setup](https://developers.cloudflare.com/workers/get-started/guide/).

Logtura reads `CLOUDFLARE_API_TOKEN` and an account ID. Worker discovery/tailing
requires the catalog's Workers Scripts Read and Workers Tail Read groups; AI
Gateway uses its separate read permission. The connector builds a permission
template from the selected drivers; review the account scope. A Wrangler login
alone does not populate Logtura's explicit API token reference.

```sh
logtura connect cloudflare --account-id ACCOUNT_ID
```

Use a secure prompt or existing environment token. Review the generated source
arrays and retain the intended Worker/gateway names. Multiple Cloudflare accounts
need separate named provider entries. Test a Worker request that logs a unique
marker and verify it at the sink; gateway logging needs a real gateway request.

Native real-time tailing is distinct from persisted Workers Logs and Logpush.
Check actual token/resource access when tailing fails. [Real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/).

Recipe reviewed 2026-10-06. Native provisioning is vendor-guided; release fixture
tests cover Logtura discovery/rendering and runtime tests cover the transport.
