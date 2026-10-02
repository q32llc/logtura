# @logtura/driver-vercel-logs

Vercel Runtime Logs source driver for Logtura.

This driver uses Vercel's REST API runtime log stream, not Vercel Drains, so it
works for Hobby accounts within Vercel's Runtime Logs retention window.

```yaml
sources:
  vercel:
    provider: vercel-logs
    # Optional for team-owned projects.
    team_id: env:VERCEL_TEAM_ID
    api_token: env:VERCEL_API_TOKEN
    projects:
      - prj_xxx
```

The generated Bun helper polls the latest READY production deployment, decodes
streamed UTF-8 log rows, keeps final rows without a newline, and deduplicates
replayed row identities across reconnects. Normal EOF and failures back off before
reconnecting; deployment discovery has a 30-second deadline. Helper failures contain stable status/protocol messages, with
repeated error events suppressed for five minutes; upstream response bodies are
excluded from helper diagnostics.

From the monorepo root, `pnpm build && pnpm test:vercel-runtime` runs the emitted
helper under its declared Bun image against a controlled HTTP endpoint, then
builds the public install context and verifies actual Vector/webhook delivery.
The fixture checks personal/team requests, stream restart and cancellation,
normalization, filters, retry, shutdown, and owned-resource cleanup after an
injected failure. It uses no Vercel credentials or live Vercel account.
