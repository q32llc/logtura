# logtura conventions for AI agents

## UX-submitted jobs must rehydrate on page mount

Any UI page that submits a job via the queue (discovery, fly_deploy,
future ones) must re-attach to an in-flight job on page mount.

**The problem:** the obvious implementation stores the returned job
id in React state and polls it. On a hard refresh, that state is
gone — the queue keeps running the job, but the page no longer
knows which id to poll, so progress, errors, and the success state
all disappear from the user's view.

**The pattern:**

1. Enqueue with a stable `lock_key` derived from the resource id —
   e.g. `lockKeyForFlyDeploy(deploymentId)`,
   `lockKeyForDiscovery(connectionId)`. This is the same key the
   `enqueue()` dedup uses, so a re-click while one is in flight
   returns the existing job instead of spawning a duplicate.
2. The resource's GET endpoint (`/deployments/:id`,
   `/connections/:id`, …) returns the latest active job for that
   lock key alongside the resource:
   ```ts
   const jobs = new JobDriver(db, queue);
   const activeJob = await jobs.activeForLockKey(
     lockKeyForFlyDeploy(id),
   );
   return c.json({ deployment, latestDeployJob: activeJob });
   ```
   Use `activeForLockKey` (queued/running only), not
   `latestForLockKey` — surfacing a long-ago failed job makes the
   "Deploy failed" banner sticky across reloads.
3. The page seeds its job state from that field on mount and lets
   the existing polling effect take over.

Existing reference implementations:
- `/connections/:id` → `latestDiscoveryJob` →
  `ConnectionDetail.tsx` (`setLatestJob(conn.latestDiscoveryJob)`)
- `/deployments/:id` → `latestDeployJob` →
  `DeploymentDetail.tsx` (`ManagedDeployCard` seeded via
  `initialDeployJob` prop)

When adding a new UX-triggered job kind, do this in the same PR as
the enqueue path — don't ship a "lose track on reload" version
first.
