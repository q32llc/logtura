# Vercel

`vercel-logs` selects `projects` of kind `vercel_project`. It reads runtime logs
for the latest ready production deployment through the bundled Bun helper. It
is not a Vercel Log Drain.

For a new source project, use the native Vercel CLI from the application
directory, select the correct account/team and project, and deploy production
when authorized (`vercel deploy --prod`). Reuse existing project linkage.
Record the concrete project ID and optional team ID. A preview-only deployment
does not exercise this driver's production-deployment path. [Vercel deploy](https://vercel.com/docs/cli/deploy).

Logtura uses `VERCEL_API_TOKEN`, separate from local Vercel CLI session state.

```sh
logtura connect vercel
```

For team projects, use `--account-id TEAM_ID`; personal projects use no team
scope. A returned user identity is not a team ID. Review the generated project
selection and retain actual project IDs.

The helper depends on runtime-log endpoint access and a ready production
deployment. Check the account's current entitlement and log retention with
Vercel before diagnosing an empty stream as a broken filter; do not assume Log
Drain plan requirements apply to this transport.

There is no native `logtura deploy vercel` command. Deploy the forwarder through
the chosen Docker/Fly path. Exercise a production request that logs a unique
marker and verify the matching event at the sink. Recipe reviewed 2026-10-06.
