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
