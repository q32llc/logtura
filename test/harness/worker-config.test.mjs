import assert from "node:assert/strict";
import { test } from "node:test";
import { unstable_readConfig, unstable_getMiniflareWorkerOptions } from "wrangler";
import { mergeWorkerOptions } from "miniflare";
import { assertTestQueues } from "../../scripts/assert-test-queues.mjs";

test("actual parsed native test config preserves producer and disables automatic delivery", () => {
  const config = unstable_readConfig({ config: "./wrangler.test.toml", env: "test" });
  const { workerOptions } = unstable_getMiniflareWorkerOptions(config, "test");
  assert.doesNotThrow(() => assertTestQueues(workerOptions));
  assert.equal(workerOptions.queueProducers.JOBS_QUEUE.queueName, "logtura-jobs");
  assert.deepEqual(workerOptions.queueConsumers, {});
});
test("empty Miniflare overrides retain consumers and the startup guard rejects them", () => {
  const options = mergeWorkerOptions({ queueProducers: { JOBS_QUEUE: "logtura-jobs" }, queueConsumers: { "logtura-jobs": { maxBatchSize: 5 } } }, { queueConsumers: {} });
  assert.deepEqual(Object.keys(options.queueConsumers), ["logtura-jobs"]);
  assert.throws(() => assertTestQueues(options), /no automatic queue consumers/);
});
test("removing the native producer is also rejected", () => {
  assert.throws(() => assertTestQueues({}), /real JOBS_QUEUE producer/);
});
