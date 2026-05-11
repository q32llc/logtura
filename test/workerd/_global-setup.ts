import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import type { TestProject } from "vitest/node";

// Read migrations once at process start, pass into workerd tests via
// vitest's provide/inject channel. We can't read from disk inside
// workerd (no fs), and we don't want to re-parse every test.
export default async function setup({ provide }: TestProject) {
  const migrations = await readD1Migrations("./migrations");
  provide("migrations", migrations);
}

declare module "vitest" {
  export interface ProvidedContext {
    migrations: Array<{ name: string; queries: string[] }>;
  }
}
