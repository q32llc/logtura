import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import type { TestProject } from "vitest/node";
import { unstable_readConfig, unstable_getMiniflareWorkerOptions } from "wrangler";
import { assertTestQueues } from "../../scripts/assert-test-queues.mjs";

// Read migrations once at process start, pass into workerd tests via
// vitest's provide/inject channel. We can't read from disk inside
// workerd (no fs), and we don't want to re-parse every test.
export default async function setup({ provide }: TestProject) {
  const config = unstable_readConfig({ config: "./wrangler.test.toml", env: "test" });
  const { workerOptions } = unstable_getMiniflareWorkerOptions(config, "test");
  assertTestQueues(workerOptions);
  const migrations = await readD1Migrations("./migrations");
  provide("migrations", migrations);
}

declare module "vitest" {
  export interface ProvidedContext {
    migrations: Array<{ name: string; queries: string[] }>;
  }
}
