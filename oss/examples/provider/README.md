# Provider example

The [example driver](../../packages/core/examples/provider.ts) and
[contract harness](../../packages/core/test/provider-contract.ts) form a fixture-only extension example, not a new live integration. It emits
normalized JSON from stdin; replace that transport and normalization for a real
host. It exercises a provider not known to the built-in config parser.

From the public repository, run:

```sh
pnpm vitest run --project @logtura/cli test/provider-extension.test.ts
```

The test uses the generic connector, descriptor-driven credentials/selections,
the public contract harness, and complete core bundle generation. It verifies
credential rejection and account isolation, rather than declaring fake network
support. Real provider fixtures must also cover auth, pagination, retries and the
transport's actual protocol.

For a real driver:

1. Create `packages/driver-YOUR-HOST` with `ProviderDriver<TCredentials>`, package
   metadata, build/declaration config, and protocol/runtime tests. Copy a current
   driver's package structure, retaining its workspace dependency conventions.
2. Add its descriptor to `packages/core/src/provider-catalog.ts`, then import and
   register the driver once in `packages/cli/src/registry.ts`. The CLI and service
   share that public registry. Plain string-list selection and single-token
   credentials need no new host branch in the config parser or connector.
3. For unusual selection data/auth, extend the typed codec/connector deliberately
   and add compatibility fixtures. Do not overload display names as resource IDs.
4. Add `providerContract` to the driver tests and validate real generated output
   using the existing Vector/runtime test pattern. Register its test project in
   the root Vitest configs and keep owned coverage requirements.
5. Add the provider's skill recipe and regenerate metadata with
   `node scripts/agent-artifacts.mjs --write` after building. Include its recipe
   in the skill's workflow router.
6. If website onboarding is desired, add a service connection adapter in the
   service repository. Web UX and OAuth routes stay outside public drivers.

Public consumers can pass `providerDescriptors` and `providers` explicitly to
`parseConfigDocument` to use an external provider without editing core. Custom
modules are explicitly imported by the host application; config files do not
cause automatic untrusted module loading.
