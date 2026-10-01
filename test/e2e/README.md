# Shared HTTP lifecycle tests

`lifecycle.ts` exercises the application through HTTP requests without direct
database access. The workerd test seeds an isolated identity and runs this same
scenario against `SELF`. The HTTP runner accepts a local or remote URL and an
authenticated disposable test account.

```sh
LOGT_E2E_URL=https://staging.example.com \
LOGT_E2E_USER_ID=your-disposable-test-user-id \
LOGT_E2E_ALLOW_REMOTE=1 \
pnpm test:e2e:http
```

Supply `LOGT_E2E_SESSION_COOKIE` through your local environment or secret store;
it is a complete authenticated cookie header. Do not put it in command history
or committed files. The account ID is checked before any mutation. Remote
selection requires `LOGT_E2E_ALLOW_REMOTE=1`; localhost does not.

The current scenario creates a webhook destination, monitor, and sink; verifies
validation, updates and deletion; and removes its resources after failures as
well as success. It records ownership in memory and preserves pre-existing
resources. It does not deploy paid infrastructure. Do not use your normal
production account: mutations can affect deployment-outdated flags. Persistent
cleanup ledgers and the complete provider/deployment/browser matrix remain
planned work in `docs/oss-service-convergence-plan.md`.

The suite fails when credentials are missing, rather than silently skipping.
Run the workerd scenario with:

```sh
pnpm exec vitest run --project workerd test/workerd/e2e-lifecycle.test.ts
```
