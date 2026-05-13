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
or transform component Logtura should read from.

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
