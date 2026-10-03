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
| Supabase PAT function and gateway polling → webhook and Slack | `test:supabase-runtime` runs generated HTTP polling, SQL, bearer interpolation, JSON decoding, source selection, normalization, error filters and both sinks through Vector 0.55.0. Only the API origin is redirected to a local fixture. It rejects unselected-function/info/warning delivery, verifies timestamps and identity, Slack single-object framing, provider failure recovery and sink retries. | Local run passes; exact new private and public CI results remain required. Refreshable sidecar delivery is not proved by the PAT fixture. |
| Cloudflare AI Gateway | Discovery, request/response and configuration validation tests exist. | Actual polling → Vector → destination fixture delivery remains open. |
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

Do not mark the full delivery baseline complete until the remaining runtime rows
have appropriate evidence. Keep local API-origin redirection explicit, verify
unmodified parser/filter/sink behavior, and keep live sandbox claims separate.
