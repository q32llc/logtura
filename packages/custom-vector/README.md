# @logtura/custom-vector

Custom Vector source and destination drivers for Logtura.

Use this package when the managed Logtura drivers do not cover your platform
yet, but Vector already has the source, transform, or sink you need.

## Source

```yaml
sources:
  bob:
    provider: custom-vector
    display_name: Bob
    vector:
      include: ./vector/bob.yaml
      feed: bob_norm
```

The included file may define `sources` and `transforms`. `feed` names the source
or transform component Logtura should read from. It can also select a named output,
such as `route.errors`, or output ports with `route.error_*`.

## Destination

```yaml
sinks:
  joe:
    type: custom-vector
    vector:
      include: ./vector/joe.yaml
```

The included file may define `transforms` and `sinks`. Logtura rewrites the
single dangling input reference to the monitor output. If the graph has multiple
dangling inputs, set `vector.input` explicitly.

References to named outputs (`route.errors`) and output-port wildcards (`route.*`)
retain their port names. Graphs with component wildcards preserve original component
names inside a fragment-specific namespace. Vector expands patterns against complete
output IDs: `rout?.*` selects named ports, while `rout?` selects only a matching default
output. Supported patterns include `*`, `?`, bracket classes and recursive `**` path
components. Expansion stays inside the fragment; Vector validates actual matches and
cycles. A scoped destination alias makes the supplied monitor input available to
local patterns. Existing exact-reference graphs keep their generated identities.
Malformed patterns and provably unmatched local patterns fail during generation;
Vector rejects patterns that have no matching actual outputs during validation.
Component names containing dots are rejected in wildcard graphs, matching Vector's
component-name restriction. Named feeds and component patterns are also supported
in `vector.feed`.

`pnpm build && pnpm test:custom-vector-flow` from the monorepo root round-trips a
portable manifest, builds its complete public install bundle and verifies actual
Vector delivery. Two graphs reuse local component names, consume named feeds and
component/output wildcards, and send matched events through an inferred custom
destination to an HTTP receiver. The fixture checks prefix-neighbor isolation,
normalization/context, filtering, retry, shutdown and cleanup after injected failure.
The suite also checks 12 wildcard grammar cases against Vector’s actual graph edges.
Private/public CI and the public release workflow require this suite.
