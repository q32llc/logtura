# Product Idea: Managed Log Source Forwarder

## Thesis

Most teams do not need another log database. They already have or can choose a
destination: Datadog, Better Stack, Axiom, New Relic, Grafana Loki, Honeycomb,
S3, or another storage and alerting system.

What is still annoying is the plumbing before that point:

- Which services produce logs?
- How do I discover all of them?
- Which log streams are pull-based, push-based, sampled, retained, or live-only?
- How do I deploy the right forwarder configuration?
- How do I know the forwarder is still connected?
- How do I avoid accidentally retaining customer logs in yet another vendor?

This product is a managed control plane for discovering log-producing resources
and generating/deploying streaming log consumers. It has zero log retention
and forwards only to customer-selected, well-known destinations.

The collector itself is open source — Vector, with logtura-published
transforms wired in: Rust ports of Drain log clustering and Isolation
Forest contributed back to the Vector ecosystem, plus a research-grade
token-novelty transform paired with a published paper. The hosted control
plane is the proprietary differentiator: provider discovery, config
generation, deploy orchestration, and source health are not solved by any
single OSS project, even though the building blocks (CloudQuery, Steampipe,
Vector) are all OSS.

## One-Line Pitch

Connect your cloud accounts, discover every log source, and deploy zero-retention
streaming forwarders to Datadog, Better Stack, Axiom, New Relic, Loki, or S3.

## Customer

Indie operators and small studios running fleets of small services across
multiple platforms — the bottom of the market that enterprise pipeline
tools (Cribl, Edge Delta, Calyptia) cannot profitably reach with their
per-GB pricing and sales-led motion.

Concrete personas:

- agency owner maintaining 30 customer sites across Cloudflare + Vercel +
  AWS Lambda + a few VMs, paying for monitoring out of pocket between
  client invoices
- indie hacker shipping 5–20 micro-SaaS apps, each with its own log mess
- AI builder running 50+ rapid prototypes for clients on Supabase Edge
  Functions, Fly machines, and Cloudflare Workers
- small studio inheriting customer projects (10 stacks, 8 vendors) and
  trying to keep them all monitored
- bootstrapped SaaS team with logs scattered across one destination, a
  few provider-native drains, and CLI scripts

Common shape:

- under 10 engineers, often solo
- combined log volume well under what justifies an enterprise pipeline
- monthly observability budget in tens of dollars, not thousands
- self-serve or bounce; sales calls are a non-starter
- already pays for at least one destination (Better Stack, Axiom,
  Datadog free tier) and still has blind spots
- reads Hacker News, Twitter, dev podcasts; trusts OSS

The motto for the wedge: *"I spun up 100 websites and I need to keep
track of them."*

Secondary audience reached through the research paper and OSS
contributions — SREs at larger companies, observability-curious
engineers, conference attendees — is top-of-funnel for eventual
prosumer/team tiers, but is not the primary product audience.

## Problem

Modern apps emit logs from many places:

- Cloudflare Workers
- Supabase Edge Functions
- AWS Lambda, ECS, CloudWatch Logs
- DigitalOcean Apps, Droplets, Kubernetes
- Fly.io machines
- Vercel functions
- Render/Railway apps
- GitHub Actions
- managed Postgres or queue providers

Each platform exposes logs differently. Some have historical query APIs. Some
are live-tail only. Some require polling. Some support log drains. Some require
a CLI. Some charge for retained logs. Some sample logs in ways that make rare
errors invisible.

The result: teams either overpay for broad log ingestion, miss important sources,
and build fragile one-off scripts.

## Proposed Product

A hosted dashboard and deployment system that:

1. Authenticates into log-producing hosts, with minimal needed scoping.
2. Discovers available log sources automatically.
3. Generates streaming consumer configurations for each source.
4. Deploys or guides deployment of collectors/forwarders onto customers infra.
     - happy to deploy-for you
     - or will literally give you a Dockerfile and a fly, doctl, glcoud or aws command
5. Shows all sources in one dashboard with status, filters, volume estimates,
   and destination mappings.
6. Retains no customer logs, except optionally tiny operational metadata needed
   for health, billing, and deduplication.
7. Supports monitoring and alarm configurations.
8. Supports automatic anomaly detection in the collector via three
   logtura-published Vector transforms: `vector-transform-drain` (Rust
   port of the Drain log clustering algorithm), `vector-transform-isolation-forest`
   (Rust port of Isolation Forest), and `logtura-novelty` (token-frequency
   novelty under zero-retention, paired with a research paper). All
   bounded-memory and zero-retention. See "Streaming Anomaly Detection:
   Research and Publication" for the work split and venue strategy.
9. Forwards logs only to approved customer destinations.


## Core Workflow

1. Customer signs in.
2. Customer connects a provider:
   - Cloudflare
   - Supabase
   - AWS
   - DigitalOcean
   - Fly.io
   - Vercel
   - Render
   - GitHub
3. System discovers log sources:
   - functions
   - workers
   - services
   - apps
   - ai gateways
   - projects
   - log groups
   - queues/jobs where relevant
4. Customer chooses a destination:
   - Datadog
   - Better Stack
   - Axiom
   - New Relic
   - Grafana Loki
   - Honeycomb
   - S3/R2
   - generic HTTPS endpoint
   - None (monitor only)
5. System generates a monitoring and forwarding plan:
   - source name
   - source type
   - collection method
   - required credentials
   - expected cost/volume risk
   - destination mapping
   - filters/transforms
   - selected detector pipeline (`vector-transform-drain` +
     `vector-transform-isolation-forest` + `logtura-novelty`) where
     applicable
   - heartbeat strategy (direct to destination or via control plane)
6. Customer deploys the collector:
   - copy/paste Docker
   - Fly.io deploy
   - Kubernetes Helm chart
   - systemd unit
   - Terraform module
   - GitHub Actions workflow for sources that only need polling
7. Dashboard shows:
   - source connected/disconnected
   - last log seen
   - forwarder heartbeat
   - destination delivery success/failure
   - estimated volume
   - dropped/suppressed count
   - auth expiration/permission issues

## Product Boundaries

This is not a full log management product.

It should not compete directly with Datadog, Better Stack, Axiom, or New Relic
at first. The job is to get logs out of fragmented hosts and into those tools
reliably.

The product should not retain full log bodies by default. Retention changes the
security posture, pricing model, and buyer expectation.

The well-published algorithms (Drain log clustering, Isolation Forest)
exist as production runtimes in OTel contrib but not as Vector transforms.
We port both to Rust as Vector ecosystem contributions —
`vector-transform-drain` and `vector-transform-isolation-forest`. This
serves the customer (pure Vector pipeline, no second binary) and puts the
logtura name in every `vector.yaml` that imports them. The genuine
research gap is streaming token-frequency novelty under zero-retention,
which we publish as `logtura-novelty` paired with a paper. Plus the
log-source taxonomy (`logtura-discovery`). See "Open Source Strategy" for
the full publishing list.


## Zero Retention Model

- full log body is streamed through the collector to the destination
- hosted control plane does not receive full logs unless explicitly configured
- collector may keep a local memory/disk buffer for short retry windows
- collector may keep stats, histograms and tracking metrics for anomaly detection
- collector may send alarm, asynchronously and with configurable dedup
- dashboard stores only metadata:
  - source id
  - source type
  - connection status
  - last seen timestamp
  - counters
  - destination delivery status
  - error signatures generated locally, if enabled

Optional advanced mode:

- local collector can run filters and deterministic deduplication
- local collector can run monitors and analysis
- customer can choose to send only error-like logs to destination
- customer can choose to mirror operational samples for support, off by default
- customer can choose fixed alarm triggers, destinations

## Open Source Strategy

### Posture

The product builds on, contributes to, and where necessary creates new MIT- or
Apache-2.0-licensed projects. This is deliberate:

- buyers of a zero-retention log forwarder are skeptical of black boxes — an
  auditable collector lowers the trust barrier
- the collector runs on customer infrastructure, so customers should be able to
  read the code that touches their logs
- collector-side innovations (anomaly detection, redaction, dedup) generalize
  well; keeping them OSS lets us co-evolve with Vector and OpenTelemetry instead
  of maintaining private forks
- the moat is the control plane (discovery, config generation, routing,
  dashboards), not the bytes on the wire

### License posture

- collector-side code and any shared libraries: Apache-2.0 or MIT
  (compatible with Vector's MPL-2.0 and OTel's Apache-2.0)
- control plane (UI, discovery orchestration, deploy automation): closed
  source / source-available — that is our differentiator
- Terraform modules and Helm charts: Apache-2.0
- avoid SSPL, BSL, or "open core with a big paywall" licenses — we are
  downstream of MPL/Apache projects and need to stay welcome there

### Tools we adopt

Streaming and transport
- **Vector** (MPL-2.0, vector.dev) — the collector, full stop. Mature
  sources/sinks for our target destinations, native transforms, disk-buffered
  retry, VRL for filtering and redaction. `exec` source covers arbitrary CLI
  tailing (e.g. `wrangler tail`); `http_client` covers HTTPS-polling provider
  APIs; `internal_metrics` source plus `prometheus_exporter` sink covers
  heartbeat natively. Most provider integrations are config-generation, not
  new plugins.
- **Fluent Bit** (Apache-2.0) — Kubernetes DaemonSet path; lighter than
  Vector for node-level collection. Used opportunistically when the customer
  is already running it.
- **Bento** (MIT, formerly Benthos pre-Redpanda fork) — last-resort routing
  layer when stream-processing logic exceeds what Vector can express. Use
  Bento, not Redpanda Connect, to stay MIT.

Resource discovery
- **CloudQuery** (MPL-2.0) — syncs cloud and SaaS configuration into a
  queryable store. 70+ sources including AWS, GCP, Azure, Kubernetes,
  Cloudflare. Covers the "enumerate cloud resources" half of provider
  discovery.
- **Steampipe** (AGPL/MPL mixed) — SQL-over-cloud-APIs via Postgres FDWs.
  150+ plugins. Lighter footprint than CloudQuery for ad-hoc enumeration.
- These cover *what exists* in a cloud account. Mapping each enumerated
  resource to "is this a log source, and how do we tail it?" is the layer
  we add (see `logtura-discovery` below).

Config generation
- Vector's `vector validate` provides config-time validation; we generate
  YAML directly and rely on it.
- **Terraform Plugin Framework** (MPL-2.0) — emits Terraform modules
  customers can import.
- **Helm** (Apache-2.0) — Kubernetes deploy bundles.

Algorithms (used by reference, not as runtime dependencies — see "What we
publish")
- **Drain** algorithm — streaming log template miner. Reference
  implementations: `logpai/Drain3` (Python, MIT) and OTel contrib's
  `drainprocessor` (Go, Apache-2.0). We port from the algorithm spec into
  Rust; we cite both.
- **Isolation Forest** — well-published anomaly detection algorithm.
  Reference runtime: OTel contrib's `isolationforestprocessor`. Same
  posture: cite, port, do not run.
- **Drain3** as a Python library and **LogAI** (BSD-3, Salesforce) as a
  research toolkit are used for offline benchmark comparisons against our
  Rust ports and our novelty layer.
- **River** (BSD-3) and **t-digest / DDSketch / Count-Min Sketch** —
  streaming primitives our `logtura-novelty` layer composes.

Redaction and normalization
- **VRL** (MPL-2.0, ships with Vector) — sufficient for most redaction
  (UUIDs, request ids, secret regex patterns).
- **Presidio** (MIT, Microsoft) — fallback when customers want PII
  detection beyond regex; runs as a sidecar.

### What we publish

Three categories, each with a different strategic rationale.

**Vector ecosystem contributions** — community goodwill, brand surface in
every `vector.yaml` that imports them, and a public technical demonstration
that we ship production Rust. Submitted upstream to `vectordotdev/vector`
for inclusion in core; if not accepted, ship as community plugins. Either
path keeps the brand surface intact.

1. **`vector-transform-drain`** — Rust port of the Drain log clustering
   algorithm as a Vector transform. Annotates each event with a stable
   `template_id`. Reference implementation lives in OTel contrib
   (`drainprocessor`); we port from the algorithm spec rather than the
   Go source. Apache-2.0 (compatible with Vector's MPL-2.0).
2. **`vector-transform-isolation-forest`** — Rust port of Isolation Forest
   over a sliding window. Scores each event 0–1, optionally drops
   anomalies. Built on existing Rust ML crates (`smartcore`, `linfa`) for
   tree primitives. Apache-2.0.

**Product-wedge utility** — narrow audience (mostly people considering or
using logtura), broad-but-shallow value.

3. **`logtura-discovery`** — provider taxonomy. Given CloudQuery or
   Steampipe output, classifies which resources are log sources and emits
   Vector config snippets for tailing them (with the right auth shape,
   framing, and retry policy). Apache-2.0.

**Research artifact** — paper-paired, credibility-bearing,
narrow-but-deep technical claim. Different success criteria from the rest
(citations, conference acceptance, hiring signal — not user count).

4. **`logtura-novelty`** — token-frequency novelty as a Vector transform.
   The genuinely missing piece in OSS today: streaming token-novelty under
   zero-retention, bounded-memory, and no-offline-training constraints.
   Published alongside a paper; see "Streaming Anomaly Detection: Research
   and Publication" below. Apache-2.0.

That is the entire publishing list. The customer-facing pipeline is pure
Vector with our four contributions wired in as transforms — no second
binary, no sidecar, no engine choice exposed to the customer.

### What we explicitly do not write

- **Not a new collector engine.** Vector is the engine.
- **Not a new query language.** VRL covers transforms; destinations cover
  query.
- **Not a hosted log database.** That breaks zero retention and turns us
  into a competitor of our destinations.
- **Not custom Vector source plugins for CLI/HTTP wrappers.** `exec` and
  `http_client` cover these; plugins are reserved for protocols Vector
  cannot express.
- **Not novel implementations of Drain or Isolation Forest.** Both are
  well-published algorithms; we port reference implementations to Rust
  rather than inventing variants.
- **Not our own cloud resource enumerator.** CloudQuery and Steampipe
  cover the API enumeration; we add the log-source taxonomy on top.
- **Not a heartbeat sidecar.** Vector's `internal_metrics` source plus
  `prometheus_exporter` sink expose heartbeat data; wire them in config.
- **Not an OTel Collector dependency in the runtime path.** OTel's
  processors are reference implementations we port from; our customers
  run Vector, not Vector-plus-otelcol.

## Source Discovery

Discovery should start provider-by-provider. The product can launch without
every provider. Vector's `exec` source covers arbitrary command-line tailing,
and `http_client` covers HTTPS-poll provider APIs — between them, customers
can configure custom sources so we can claim universal support from day one.
Provider-specific discovery and config generation is added one provider at a
time via `logtura-discovery` (see Open Source Strategy).
 
### Cloudflare

Discover:

- Workers
- Pages Functions if available
- Logpush jobs
- Workers Observability status
- account and zone bindings relevant to logs

Collection methods:

- Workers Logs/Observability API when enabled and affordable
- Logpush where available
- `wrangler tail --format json` via collector for live-tail sources

Important caveat:

Cloudflare live-tail collection is only as reliable as the running collector.
If the collector is down, live-only logs are missed. The dashboard must make
that obvious.  Heartbeats matter.  Even for customer-deployed monitors, 
heartbeats can still optionally be aggregated to our Dash.

Or heartbeats can go directly to theor own log sink.

### Supabase

Discover:

- projects
- Edge Functions
- database logs if available through API/integration
- auth/storage/realtime logs where available

Collection methods:

- Supabase logs API where available
- CLI tail/polling where necessary
- provider-native log drains if Supabase adds or exposes them

### AWS

Discover:

- CloudWatch log groups
- Lambda functions
- ECS services
- API Gateway logs

Collection methods:

- CloudWatch Logs subscription filters
- Kinesis Firehose
- polling as a fallback

AWS is likely the most mature and easiest enterprise path, but also the most
permission-sensitive.

### DigitalOcean

Discover:

- Apps
- Droplets
- Kubernetes clusters
- Functions if applicable

Collection methods:

- provider log APIs
- agents on Droplets
- Kubernetes DaemonSet/sidecar options

## Collector Strategy

(Full tooling inventory and license posture lives in "Open Source Strategy"
above. This section is about which collector engine to pick per deployment
shape.)

Use an existing collector engine where possible.

Likely default:

- Vector for streaming collection, transforms, filtering, and destination sinks

Alternatives:

- OpenTelemetry Collector for teams already standardized on OTEL
- Fluent Bit for Kubernetes-heavy teams
- custom thin wrapper only where provider CLIs are required

The product's main value is not writing a better log collector. It is:

- provider discovery
- config generation
- deployment workflow
- source health tracking
- destination routing
- safe defaults

## Streaming Anomaly Detection: Research and Publication

The work splits into two tracks with different governance. *Product
detectors* are well-published algorithms ported to Rust as Vector
transforms — engineering, conservative, optimized for reliability.
*Research artifact* is a novelty layer published alongside a paper —
ambitious, optimized for credibility and citations. The two meet at one
config flag in the generated bundle.

### Track 1 — product detectors (port, don't invent)

These exist as production runtimes elsewhere (notably
opentelemetry-collector-contrib's `drainprocessor` and
`isolationforestprocessor`); they do not exist as Vector transforms today.
We port both:

- **Drain log clustering** — a hashed parse-tree algorithm that extracts
  a stable template id from each log line in bounded memory. Roughly 300
  lines of algorithm code; small Rust port from the original Drain paper
  with the Drain3 and OTel implementations as reference.
- **Isolation Forest** — an ensemble-of-random-trees anomaly detector
  scoring events 0–1 over a sliding window. Well-specified across multiple
  papers; existing Rust crates (`smartcore`, `linfa`) provide tree
  primitives. Larger than Drain but still a days-of-work artifact with LLM
  assistance, not a project.

The work here is engineering, not research. Both ports are submitted
upstream to `vectordotdev/vector` as `vector-transform-drain` and
`vector-transform-isolation-forest`; if accepted, they ship in core,
otherwise as community plugins. Either path puts the logtura name in
every `vector.yaml` that uses them.

License posture: write fresh from algorithm specs, cite the OTel
implementations as reference, ship Apache-2.0 (compatible with Vector's
MPL-2.0).

### Track 2 — research artifact (the publishable contribution)

The genuinely novel angle is the *operating regime*, not a new algorithm:

- **Zero retention.** No log line is stored, even briefly. The detector
  must operate purely on online state.
- **Bounded memory per source.** Multi-tenancy is the production reality;
  per-source state must fit in a configurable budget (default ~5 MB).
- **No offline training.** No pre-training corpus. Detector cold-starts
  on every new source.

Existing literature mostly assumes either retention (Drain3, LogAI) or
training (DeepLog, LogBERT) or both. Token-frequency novelty under all
three constraints simultaneously is the publishable contribution. The
algorithm itself composes existing primitives (Count-Min Sketch, t-digest,
online statistics from River) — what is novel is *formalizing the regime*
and *benchmarking against existing baselines without breaking the
constraints*.

### `logtura-novelty` — the artifact

A Vector transform implementing the novelty layer:

- input: log records already annotated with a `template_id` by
  `vector-transform-drain`
- per-source state: token Count-Min Sketch, t-digest of token-frequency
  distribution per template, exponential decay
- emits `logtura.novelty_score` and `logtura.novelty_reason` on each
  record
- emits a separate low-rate anomaly event on score > threshold, deduped
  via a moving window
- bounded memory per source (configurable; default ~5 MB)
- ships zero log content to the control plane — only `(source_id,
  template_id, score, timestamp)` tuples, and only if the customer opted
  into hosted alerting

Recommended pipeline (pure Vector, single binary):
`vector-transform-drain` → `vector-transform-isolation-forest` →
`logtura-novelty` → destination sink. Each transform does one thing.

### Publication strategy

- **Venues.** Tier-1 systems (USENIX ATC, OSDI, NSDI, EuroSys, SoCC
  industrial track) for the systems framing. KDD or ICDM for the ML
  framing. Probably one of each, plus a Monitorama or SREcon talk for
  industry visibility.
- **Benchmarks.** Standard log-anomaly datasets (HDFS, BGL, Thunderbird
  from LogPAI) plus a synthetic streaming benchmark that enforces the
  zero-retention / bounded-memory / no-offline-training constraints.
  Comparison baselines: OTel `isolationforestprocessor`, Drain3 + a
  threshold detector, LogAI's online detectors, DeepLog (with offline
  training acknowledged as out-of-regime).
- **Authorship.** One co-author with a publication track record in
  streaming systems or anomaly detection — academic advisor or a hire we
  make specifically for this work. The hiring signal alone shifts the
  company's gravity.
- **Timing.** The paper *is* the launch. Earlier publication builds
  top-of-funnel credibility; we accept that revealing the architecture
  before the control plane has a moat is the point of the move.

### Research toolkits we use only for benchmarking

- **LogAI** (BSD-3, Salesforce) — combines Drain-family parsing with
  statistical and deep-learning detectors. Research-grade, batch-oriented;
  used as a benchmark baseline, not in the hot path.
- **DeepLog / LogBERT** — research models requiring offline training.
  Run as benchmark baselines with the offline-training caveat noted.
- **AICoE log-anomaly-detector** ("Project Scorpio") — effectively
  abandoned; mention only for completeness in related work.
- **VictoriaMetrics vmanomaly** — source-available, not OSS-licensed.
  Cannot embed; useful as reference for forecast + residual scoring
  modeling choices.

### Verdict

| Layer                              | Source                                |
|------------------------------------|---------------------------------------|
| Volume / rate / latency anomalies  | `vector-transform-isolation-forest`   |
| Error-rate seasonality             | `vector-transform-isolation-forest`   |
| Template extraction                | `vector-transform-drain`              |
| Template frequency drift           | drain output + thin statistical layer |
| Token-frequency novelty (research) | `logtura-novelty` (paper-paired)      |
| Cross-source correlation           | Future work, not MVP                  |

### Explicit non-goals in MVP

- semantic similarity across sources (requires retained corpus or
  embedding model on the hot path — conflicts with zero retention)
- root-cause inference
- predictive alerting more than one window ahead
- any model training that isn't fully online
- novel implementations of Drain or Isolation Forest (well-published; we
  port, not invent)

## Dashboard

### Sources

List every discovered source:

- provider
- account/project
- source name
- source type
- collection method
- status
- last log seen
- last heartbeat
- destination
- estimated volume
- warnings

Useful filters:

- provider
- environment
- source type
- connected/disconnected
- no logs in N minutes
- high volume
- auth problem
- missing destination

### Forwarders

Show deployed collectors:

- version
- host
- region
- uptime
- last heartbeat
- config hash
- connected sources
- delivery failures
- buffered events

### Destinations

Show configured sinks:

- provider
- endpoint
- status
- last delivery
- failures
- rate limits
- estimated monthly volume/cost where knowable

## Filters and Routing

Per-source or global rules:

- forward all logs
- forward only warnings/errors
- forward only matching patterns
- drop health checks
- redact secrets
- normalize JSON fields
- route specific services to specific destinations
- sample success logs while keeping errors, if the source supports that split

Important: avoid naive request-level sampling for alerting sources. Sampling can
drop rare errors. If sampling is offered, the UI should explain that it is for
trend visibility, not reliable error detection.

## Alerting Scope

The product can provide operational alerts about the forwarding system itself:

- source disconnected
- collector down
- destination rejected events
- auth expired
- live-tail source has no heartbeat
- volume spike
- volume dropped to zero unexpectedly

It can optionally help configure alerts in the destination provider, but it
should not try to become the primary incident management system initially.

## Semantic Deduplication

Deduplication is a separate concern from anomaly detection (covered in
"Streaming Anomaly Detection: Research and Publication"). MVP keeps
deduplication deterministic: strip UUIDs, request ids, timestamps,
URL/query params, and line numbers; hash error class + normalized
message + top stack frame; group by hash. Semantic similarity is
deferred — it requires either retaining log bodies (conflicts with zero
retention) or running an embedding model on the hot path (conflicts
with bounded memory). Revisit only if deterministic normalization
proves insufficient on real workloads.

## Why This Is Not Dumb

The strong version is a zero-retention, multi-provider log control plane
priced for the bottom of the market.

There is a structural pricing gap. Cribl, Edge Delta, and Calyptia
charge per byte and run sales-led motions that start at thousands of
dollars per month. Their unit economics cannot profitably serve a
customer running 100 small sites producing a few hundred MB of logs per
month — they literally do not want that customer. Per-source pricing
inverts the curve: the indie operator pays for what they have, and
customers that eventually grow into enterprise volume graduate out of
us. We do not have to defend the top of the market.

The provider problem is real and growing. Even where provider-native
drains exist (Supabase Log Drains, Cloudflare Logpush), they only solve
the per-provider half — a team running on Supabase plus Fly plus a few
VMs still has three disconnected log stories. The cross-provider,
single-dashboard view is the actual job to be done.

OSS posture and the research paper match the audience. Scrappy
operators trust open source over pitched-by-sales SaaS, and the GTM
channels for this segment (HN, Twitter, Reddit, conference talks)
reward research credibility and OSS contribution. Incumbents
structurally cannot copy this — publishing OSS that conflicts with
their per-GB pricing model conflicts with their entire motion.

Zero retention is architectural, not a checklist feature. None of the
incumbents commit to it. For the indie operator, "we literally cannot
leak your logs because we never store them" is a more trustworthy
promise than "we have a good security posture."

## Where This Could Be Dumb

The biggest risks are not the incumbents. They are structural to the
segment.

The "I'll just deal with it" competitor is undefeated. The dominant
alternative for the scrappy operator is *not setting up logging at
all*. Until the product gets logs flowing in five minutes from landing
on the marketing page, conversion against do-nothing is roughly zero.
This is the unforgiving bar; everything else is detail.

Provider-native drains are absorbing pain we used to sell against.
Supabase shipped Log Drains in May 2026 sending logs to
Datadog/Loki/Sentry/Axiom/S3. Cloudflare has Logpush. Each provider
that solves its own log story removes one of our wedge providers. The
cross-provider unified view remains valuable, but the per-provider
hook weakens with every native drain shipped.

The unit economics are unforgiving on the small end. Per-source
pricing only works if the marginal cost of an extra source on the
control plane is genuinely small — discovery, dashboard rendering, and
heartbeat tracking must scale linearly without manual ops. Operational
overhead per customer must approach zero or the free tier eats us.

The research paper is high-leverage but slow. The credibility play
takes six to twelve months of work before it returns brand surface,
while the product must ship and survive without that fuel. Mis-timing
this — shipping the product to crickets while the paper is still
drafting — burns the team.

Second-order risks (real but not thesis-breaking): provider APIs are
inconsistent and change often; OAuth permissions can scare some
customers; some providers do not expose good streaming APIs; live-tail
sources miss logs during collector downtime; zero retention limits
debugging and support.

The wedge should stay narrow:

- start with providers that are awkward for small teams *and* do not
  yet have provider-native drains
- emphasize live-tail and edge/serverless blind spots
- generate useful configs rather than trying to own every byte of log
  delivery
- ship the product and the paper on parallel tracks; do not gate one
  on the other

## MVP

### Providers

Start with:

- Cloudflare Workers
- Supabase Edge Functions
- one generic local command/stdout source

### Destinations

Start with:

- Better Stack
- Datadog
- generic HTTPS

### Collector

Generate a Vector config plus a deployment bundle:

- Dockerfile or container image
- `vector.yaml` (validated by `vector validate` at config-gen time)
- provider auth instructions
- heartbeat via Vector's `internal_metrics` source plus
  `prometheus_exporter` sink, wired up automatically
- destination sink
- basic filters

When the customer enables anomaly detection on a source, the generated
pipeline adds `vector-transform-drain` →
`vector-transform-isolation-forest` → `logtura-novelty` as transforms in
the same Vector binary. No second runtime, no sidecar, no engine choice
exposed to the customer.

### Dashboard

MVP pages:

- connected providers
- discovered sources
- generated forwarder config
- forwarder heartbeat/status
- destination status

### Health Checks

Required from day one:

- collector heartbeat
- source stream connected
- destination accepts events
- last log seen per source
- config version/hash

### First-Run Constraint

Setup-in-five-minutes-or-bounce is the bar for the scrappy-operator
segment. Concretely: from landing page to first log line forwarded to
a destination, no more than five minutes. This forces:

- OAuth or API-token connect, never "create IAM role and paste ARN"
- default Vector configs that work without tuning
- discovery that runs in seconds and shows real source names, not IDs
- one-click destination connect for at least Better Stack and Datadog
- collector deploy via copy-paste Docker command, no Kubernetes
  prerequisite
- a free tier that covers an indie operator's full mess, so the
  decision to try is friction-free

Anything that requires a clarifying call, a quickstart deeper than one
page, or a "talk to us" button on a feature gate fails the bar.

### Research and Publication Track

Run in parallel with the product track, on a longer clock. MVP
deliverables are not the product alone but also the foundation of the
paper:

- `vector-transform-drain` shipped (community plugin in v1, upstream
  contribution submitted)
- `vector-transform-isolation-forest` shipped (same path)
- `logtura-novelty` reference implementation in a public repository
- benchmark harness running LogPAI datasets (HDFS, BGL, Thunderbird)
  plus a synthetic streaming-with-zero-retention benchmark
- co-author or academic advisor secured
- paper draft circulating with target venue(s) identified

This track does not block product launch. It is the credibility flywheel
that makes the product launch land harder when it ships.

## MVP Non-Goals

- hosted log search
- hosted long-term retention
- incident management
- universal provider support
- full semantic deduplication
- custom query language
- replacing Datadog/Better Stack/Axiom

## Pricing Sketch

Per-source, not per-GB. This is the explicit counter-position to Cribl,
Edge Delta, and Calyptia, whose volume-based pricing makes the bottom
of the market structurally unprofitable for them.

Possible tiers:

- **Free:** unlimited sources, 1 destination, basic dashboard,
  deterministic filters and dedup, no anomaly detection, no team
  access. Designed to be enough for the indie operator with 100 small
  sites *forever*; the goal is to hook the bottom of the market, not
  throttle it.
- **Pro (~$29/month):** multiple destinations, anomaly detection
  enabled, config history, longer health-check retention.
- **Team (~$99/month):** SSO, multi-user dashboards, audit logs.
- **Business (custom):** private collectors, support SLA, Terraform,
  signed agreements. Secondary; this is the upgrade path, not the
  focus.

Volume-based pricing only enters if the hosted control plane starts
processing full logs — which it should not.

The collector and all `logtura/` OSS packages
(`vector-transform-drain`, `vector-transform-isolation-forest`,
`logtura-novelty`, `logtura-discovery`) are free forever and can run
without the hosted control plane. The product sells the control plane:
discovery, config generation, deploy orchestration, source health, and
the multi-source dashboard. Customers can leave at any time and keep
the working pipeline — that exit clause is what makes the OSS posture
credible.

## Open Questions

- Can Cloudflare live-tail be run reliably in a managed collector without
  fragile browser/device auth?
- Which providers expose enough metadata for true automatic discovery?
- Should the product deploy collectors itself, or only generate deployable
  configs?
- How much destination-specific alert configuration should it own?
- Is zero retention a differentiator customers understand, or just an internal
  constraint?
- What is the first provider pair painful enough to make people pay?
- Will Vector core accept `vector-transform-drain` and
  `vector-transform-isolation-forest` upstream, or do they ship as
  community plugins? Either is fine for brand surface; upstream
  acceptance carries more prestige and reduces our maintenance burden.
- Who is the right co-author or academic advisor for the
  `logtura-novelty` paper? The hiring or partnership decision shapes the
  publication timeline more than any technical choice.
- Is the right anomaly default "score and surface" (passive) or "score
  and alert" (active)? Passive is safer for trust, but quieter products
  get ignored.

## Recommended First Experiment

Build a prototype for one real app:

1. Connect Cloudflare by API token (using CloudQuery or a direct API call to
   enumerate Workers).
2. Map enumerated Workers to log-source descriptors via `logtura-discovery`.
3. Generate a Vector config that uses the built-in `exec` source to run
   `wrangler tail --format json`, with a Better Stack sink and Vector's
   `internal_metrics` + `prometheus_exporter` for heartbeat.
4. Forward error-looking logs to Better Stack. Anomaly detection is off in
   v1 — proving the forwarding loop matters more than the novelty signal.
5. Show a dashboard with source status, heartbeat, and last log seen.

If that feels useful after a week of real use, add Supabase Edge Functions
next (Vector-native via `http_client` + `logtura-discovery`), and only
then turn on the `vector-transform-drain` +
`vector-transform-isolation-forest` + `logtura-novelty` pipeline as a
separate optional milestone.

