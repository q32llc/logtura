# Metrics checkpoint contention — October 3, 2026

The production alert `Deployment metrics checkpoint contention` was Logtura's
own exception after three failed snapshot compare-and-swap attempts. It is
different from Cloudflare's `D1 DB is overloaded` error.

Read-only inspection at 10:53 UTC found one running deployment, a heartbeat one
second old, 97 components and a 38 KB metrics snapshot. Last-hour D1 insights
reported 1,220 metrics checkpoint attempts averaging 0.47 ms and 735 snapshot
reads averaging 0.53 ms. These measurements do not demonstrate database
saturation. The private snapshot and insights are retained under
`.tmp/metrics-incident/`; they contain no exported credentials. Cloudflare
documents this query dataset in its [D1 analytics guide](https://developers.cloudflare.com/d1/observability/metrics-analytics/).

Every increase in cumulative discarded events previously forced an immediate
checkpoint. Ordinary filter traffic therefore bypassed the intended five-minute
coalescing interval. Separate Worker isolates can race their bounded snapshot
writes. After the final failed compare-and-swap, the coordinator threw even when
its readback showed another writer had already persisted the same observation.

The correction coalesces discarded counters with received/sent counters. New
errors, restarts and component identities still request immediate persistence.
After three collisions it rechecks the winning snapshot. An already accounted
sample succeeds; an unresolved sample remains buffered and the metrics endpoint
returns `503 {"error":"metrics_checkpoint_busy"}` with `Retry-After: 1`.
The forwarder's existing HTTP retry handles that response. No Worker exception
is thrown for contention; actual D1 errors still propagate as failures.

Native workerd tests exercise actual competing D1 writers, the three-attempt
bound, retained observations, successful retry, the already-persisted final
collision and zero extra D1 calls for 29 ordinary discarded-count updates.
The complete 1,712-test backend suite and all module coverage floors pass.
Deployment and post-rollout observation remain required before calling the
production incident resolved. No schema, token or forwarder configuration
change is needed for this fix.
