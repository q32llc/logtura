/** Native queue batches are delivered explicitly by tests. Background delivery
 * races HTTP fixture teardown and can leave module-resolution RPCs pending. */
export function assertTestQueues(options) {
  if (Object.keys(options.queueConsumers ?? {}).length) {
    throw new Error("Native test config must have no automatic queue consumers; empty overrides retain merged consumers");
  }
  if (!Object.hasOwn(options.queueProducers ?? {}, "JOBS_QUEUE")) {
    throw new Error("Native test config must retain the real JOBS_QUEUE producer binding");
  }
}
