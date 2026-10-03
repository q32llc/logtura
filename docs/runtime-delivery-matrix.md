# Runtime delivery acceptance matrix

The convergence baseline requires representative events to pass through actual
generated runtime topologies. Unit coverage, provider API fixtures and
`vector validate` do not by themselves prove delivery. This matrix records those
distinctions and remains part of the [acceptance audit](convergence-acceptance.md).

| Source or destination | Runtime evidence | Remaining scope |
| --- | --- | --- |
| Custom Vector → webhook | `test:flow` runs generated standalone contexts and the supervisor, verifies normalized filtering, webhook retry and loaded-runtime report retry/restart. `test:custom-vector-flow` exercises named output ports and wildcard edges through Vector. | Existing CI checks remain required. |
| Railway → webhook | `test:railway-runtime` runs the generated helper under actual Bun and the generated Vector exec source through controlled WebSocket/API fixtures. | This is not a live Railway account test. |
| Vercel → webhook | `test:vercel-runtime` runs the generated helper under actual Bun and full generated Vector context, checks delivery and rejects an injected post-delivery failure. | This is not a live Vercel account test. |
| Cloudflare Worker tail → webhook | Reusable `test:e2e:live-source` passes against actual npm 0.3.1, real owned Worker traces and generated standalone Vector; owned resources and repeated cleanup are verified. | Live source acceptance is selected, rather than claiming live access to every provider. |
| Supabase PAT function and gateway polling → webhook and Slack | `test:supabase-runtime` runs generated HTTP polling, SQL, bearer interpolation, JSON decoding, source selection, normalization, error filters and both sinks through Vector 0.55.0. Only the API origin is redirected to a local fixture. It rejects unselected-function/info/warning delivery, verifies timestamps and identity, Slack single-object framing, provider failure recovery and sink retries. | Local runs pass independently in both layouts; protected public PR 5 passed exact CI 37121454039 and merged as `f2810dc`. Private exact-head CI 37121377341 is also green. Refreshable sidecar delivery is not proved by the PAT fixture. |
| Cloudflare AI Gateway → webhook and Slack | `test:ai-gateway-runtime` reproduces the documented list response through actual generated HTTP polling and Vector. It verifies envelope fanout, row-level failure/status classification, healthy-log filtering, identity/timestamps, Slack framing and provider/sink retries. Empty/malformed envelopes and non-object array entries do not become events; individual rows and bare arrays remain compatible. | Local runtime, all 12 package tests and the full 1,712-test backend suite pass. Aggregate coverage is 97.52% lines, 97.14% statements and 94.61% branches, with module floors preserved. Exact private CI 37122235299 and public CI 37122442615 are green. The parser correction is unreleased and needs a new coordinated package release, not a retag of 0.3.1. |
| Fly log tail → webhook and Slack | `test:fly-source-runtime` builds the generated standalone image and runs the unmodified Vector exec source, shell, stdbuf and real jq against controlled Fly CLI output. It checks two app identities, pretty JSON framing, structured numeric/string severity overrides, timestamp preservation, stderr suppression, error filtering and both sink retries. | Public protected PR 7 passed exact CI 37123551312 and merged as `c1ab85d`; private CI 37123438844 remains pending. The remote CLI transport is a fixture, rather than a live Fly logs subscription. |
| Datadog metrics | `test:metrics-runtime` runs native Vector v2 intake into a controlled receiver, checks the API-key header, Zstandard compression, protobuf series/component tags and timestamps, and exact rejected-payload retry. | Local positive-counter runtime passes; exact private/public CI remains required; the intake is a fixture, rather than a live Datadog account. |
| Prometheus remote write | `test:metrics-runtime` sends generated internal metrics with bearer auth, remote-write headers and Snappy compression through a retry proxy into an actual digest-pinned Prometheus receiver. A query verifies positive counters, component labels and timestamps after decoding/storage. | Local runtime passes; exact private/public CI remains required. |

The Supabase fixture preserves both emitted provider paths, their SQL and the
thirty-second polling interval. Its first function poll returns 503, and each sink
rejects its first delivery with 503; success requires later accepted events and
the same rejected Slack message/webhook batch. The owned container is removed and
verified absent in `finally`, the local receiver closes, and temporary files are
removed. An initial assertion used the wrong identity field and failed after actual
delivery; cleanup still completed. The corrected assertion verifies the existing
`logtura_connection_id` wire field. No production code or credentials were changed.

The AI Gateway fixture exposed a production parser defect: its generated remap
read the API envelope as a single row and treated request-level `success: true`
as log success. Cloudflare's [list API](https://developers.cloudflare.com/api/resources/ai_gateway/subresources/logs/methods/list/)
returns individual entries inside `result`. The regression fails explicitly when
the envelope reaches the receiver; cleanup still runs. The correction fans out
objects and preserves each row's fields before classification. The runtime fixture
retains the generated thirty-second interval, auth and endpoint path, redirecting
only the API origin. It also fails promptly if Vector exits during configuration
load, rather than waiting out the delivery deadline. The first parser candidate
used an unsupported VRL expression; actual `vector validate` rejected it, and the
corrected candidate passes both compilation and delivery. No failed result is
reported as acceptance evidence.

The AI Gateway correction at private `bbefa1e` also passes all 306 UI tests,
typechecking, packed-service/native-D1 isolation checks and owned reporting.
After rebuilding the public checkout's ignored compiled artifacts, all 1,035
public tests pass with 99.13% line and 96.67% branch coverage, and all fifteen
isolated packed consumers pass. Four compiled-CLI crash tests failed with stale
bundles before that rebuild; assertions and source were not weakened. Public
[PR 6](https://github.com/logtura/logtura/pull/6) passed exact required CI
`37122442615` and merged through protected main; private code CI `37122235299` is also green.
The VRL edit changes configuration literals, so the JavaScript patch gate reports
no changed instrumented lines. Actual remap execution evidence comes from the
required native runtime regression, rather than an invented patch percentage.

Do not mark the full delivery baseline complete until the remaining runtime rows
have appropriate evidence. Keep local API-origin redirection explicit, verify
unmodified parser/filter/sink behavior, and keep live sandbox claims separate.

The metrics fixture retains the generated thirty-second internal scrape interval.
Only the Datadog endpoint origin is redirected; native v2 encoding and compression
remain in effect. Its bounded decoder follows Vector 0.55.0's [pinned protobuf schema](https://github.com/vectordotdev/vector/blob/v0.55.0/proto/vector/dd_metric.proto).
Prometheus validates and stores the native remote-write payload itself, rather
than relying on a test implementation of Snappy or its protobuf protocol. Both
receivers reject their first request and require a subsequent byte-identical
payload. All owned containers, receivers and files are cleaned and checked. The
first fixture run detected a host port collision; the corrected fixture uses
isolated published container ports and does not report that failure as evidence.

Datadog counters require a sample after their initial baseline. The positive-counter
assertion initially timed out when the fixture sent traffic only before that
baseline. Bounded follow-up source events now prove positive increments without
changing native scraping or normalization. The corrected final runtime passes
both destinations, including cleanup; the timed-out run is not acceptance.
