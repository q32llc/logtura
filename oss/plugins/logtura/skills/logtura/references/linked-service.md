# Website → CLI → website

Use this workflow for an existing service deployment. First authenticate and pull
its current configuration rather than creating a new deployment:

```sh
logtura login
logtura whoami
logtura pull DEPLOYMENT_ID -o logt.yaml
logtura -c logt.yaml config status
```

Pull writes a portable `kind: logtura.deployment` graph, a private environment
file, and a private deployment link. Preserve all three. The link binds the
config to its service, owner, deployment, and base revision. Use `--service` only
for the intended service origin, consistently; don't redirect a linked push.

Add a resource to an existing connection using its opaque connection identity:

```sh
logtura -c logt.yaml source select CONNECTION_ID RESOURCE_ID --kind SOURCE_KIND
```

Read current graph sources and the host recipe to choose the actual resource ID
and source kind. Railway selections may need a private metadata JSON file via
`--metadata-file`; retain the environment ID. Existing selections keep their IDs.
Removing a source uses `source remove SOURCE_ID`.

For filters, destinations, or a second host, create a private JSON array of graph
operations and use `config edit operations.json`. Operations include
`connection.add/update`, `source.add/update`, `monitor.update`, and `sink.add`.
Inspect the installed `@logtura/core` `ManifestEdit` type to construct complete
operations; never guess fields or put credentials into a public edit file.
Credential payloads are separate from the public manifest and are versioned by
the CLI. Adding a host requires verified credentials and concrete resource IDs.
Shorthand `connect` and `source add` intentionally reject a portable graph.

Example filter edit, with an actual monitor ID substituted:

```json
[{"kind":"monitor.update","id":"MONITOR_ID","patch":{"filterSteps":[{"kind":"errors"}]}}]
```

```sh
logtura -c logt.yaml config edit operations.json
logtura -c logt.yaml validate
logtura -c logt.yaml diff DEPLOYMENT_ID --json
logtura -c logt.yaml push
```

Use `push --upload-secrets` when changed private payloads need service upload and
that upload is authorized. A revision conflict requires examining the remote
change; don't silently force it away. `push --resume` recovers a pending push.
`config status` and `config recover` expose interrupted local writes.

For a self-managed Fly target, deploy/apply the accepted bundle using the linked
Fly workflow and actual immutable image and volume identities. Inspect CLI help
for `deploy fly --image DIGEST_REF --volume VOLUME_ID` and recovery options.
For a service-managed target, observe its rollout rather than launching a second
forwarder. Preserve reporting credentials and the supervisor runtime.

Reload the website deployment and confirm selected sources/configuration revision,
then verify the running forwarder's applied revision and recent heartbeat. These
are separate checks. Finish with an identifiable delivered event. A stale heartbeat
or old applied revision means the deployment is not fully updated yet.
