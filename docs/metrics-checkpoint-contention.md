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
All 306 UI tests also pass, and the owned changed-line coverage gate covers
8/8 changed lines. No schema, token or forwarder configuration change is
needed for this fix.

The actual npm-backed 0.3.1 service passed disposable Cloudflare staging and
native replay of fresh schema-32 production data before deployment. It was
deployed at 11:29 UTC on October 3, with the previous Worker and fresh database
backup retained privately. The uploaded Worker and all served website assets
match the tested artifact; existing bindings and deployment fields are preserved.

The first 45-second post-rollout observation saw 29 metrics requests, all HTTP
204, with zero checkpoint-contention failures or metrics exceptions. At 11:36
UTC, natural traffic had advanced the persisted checkpoint and heartbeat by
330,001 ms relative to the deployment preflight snapshot. The original forwarder
remained running with its original process start, Vector 0.55.0, 97 components
and nonnegative counters. This is bounded recovery evidence; longer monitoring
is still appropriate. The earlier Cloudflare overload error remains a separate
diagnostic question, not evidence resolved by this compare-and-swap correction.

A second 45-second window at 11:49 UTC, about twenty minutes after deployment,
saw 28 metrics requests, all HTTP 204, with zero contention failures or metrics
exceptions. Both received and sent totals had advanced naturally; the original
process start, running state, Vector version and 97 components remained stable.

A third 45-second window at 12:34 UTC, about 65 minutes after deployment,
saw 29 metrics requests, all HTTP 204, with zero contention failures or metrics
exceptions. A fresh D1 read found the original deployment running, its heartbeat
one second old, naturally advancing traffic totals, zero component errors and
the same process start, Vector version and component count. This is bounded
observation, rather than proof that the earlier D1 overload can never recur.

At 13:05 UTC the original deployment still had advancing persisted traffic,
zero component errors and the same process/version/component identities. Its
heartbeat age was sixty seconds, within the five-minute persistence interval
and ten-minute silence threshold. A fresh insights sample was too sparse to
prove a checkpoint-write reduction; its scheduled silence statements wrote
zero notification rows. The separate overload diagnosis remains open.

A native D1 regression advances twenty minutes of heartbeat-only and discarded
traffic through the actual scheduled silence capture. Each case requires five
liveness writes and no notice for its deployment, then proves a genuine notice
after cessation at the strict ten-minute boundary. All 57 focused ingest/silence
tests pass. The initial assertion counted notices for unrelated retained fixtures;
scoping it to the tested deployment corrected the test without changing behavior.
