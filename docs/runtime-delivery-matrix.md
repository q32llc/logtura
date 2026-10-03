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
| Cloudflare AI Gateway → webhook and Slack | `test:ai-gateway-runtime` reproduces the documented list response through actual generated HTTP polling and Vector. It verifies envelope fanout, row-level failure/status classification, healthy-log filtering, identity/timestamps, Slack framing and provider/sink retries. Empty/malformed envelopes and non-object array entries do not become events; individual rows and bare arrays remain compatible. | Local runtime, all 12 package tests and the full 1,712-test backend suite pass. Aggregate coverage is 97.52% lines, 97.14% statements and 94.61% branches, with module floors preserved. Exact new private/public CI remains required. The parser correction is unreleased and needs a new coordinated package release, not a retag of 0.3.1. |
| Fly log tail | API/auth/parser/configuration tests exist. Disposable live Fly deployment tests prove runtime hosting and Cloudflare event delivery. | Those deployment tests do not prove the Fly log-source transport; generated exec-source delivery remains open. |
| Datadog metrics | Generated sink and Vector configuration validation exist. | Actual metrics intake request, authentication, encoded payload and retry acceptance remain open. |
| Prometheus remote write | Generated sink, bearer options and Vector configuration validation exist. | Actual compressed protobuf request and retry acceptance remain open. |

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
[PR 6](https://github.com/logtura/logtura/pull/6) awaits its exact required CI
`37122442615`; private code CI `37122235299` is also still pending at this record.
The VRL edit changes configuration literals, so the JavaScript patch gate reports
no changed instrumented lines. Actual shader execution evidence comes from the
required native runtime regression, rather than an invented patch percentage.

Do not mark the full delivery baseline complete until the remaining runtime rows
have appropriate evidence. Keep local API-origin redirection explicit, verify
unmodified parser/filter/sink behavior, and keep live sandbox claims separate.
