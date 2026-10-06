# Contributing a provider

Contribute through `https://github.com/logtura/logtura`. Read `CONTRIBUTING.md`
and `examples/provider/README.md` in that checkout. The installed skill does not
contain the entire source repository.

Implement the public `ProviderDriver<TCredentials>` interface: verify accounts,
discover resources, render a normalized pipeline, and optionally check freshness.
Register a typed descriptor in core's provider catalog and the driver in the
CLI's public registry. Credential and selection codecs consume descriptors;
ordinary single-token providers use the generic connector. Specialized auth or
streaming can need custom implementation.

Use the example's reusable contract harness and add genuine provider-specific
fixtures for auth, account scoping, pagination, rate limiting and streaming.
Validate generated output with the actual Vector/runtime dependency. Add a host
recipe and regenerate skill capability metadata. Keep secrets out of manifests.

The website consumes the public registry but enables providers through explicit
service connection adapters. A web form/OAuth adapter is optional for standalone
support. New source hosts, forwarder deployment targets, and destinations are
different extension types; don't advertise one as the other.
