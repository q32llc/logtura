#!/usr/bin/env -S pnpm tsx
/**
 * Generate the kitchen-sink forwarder Dockerfile from every registered
 * provider driver's dockerfileDeps. Same renderer the per-deploy
 * bundle uses, just fed the union of every driver's deps.
 *
 * Why this exists:
 *   - The managed-deploy forwarder image used to hand-maintain its
 *     own apt-install list. It drifted from what drivers actually
 *     emit, which caused real bugs (Vector running a vector.yaml
 *     that called `logtura-http-client` while the kitchen-sink had
 *     no binary).
 *   - We don't have build-per-deploy infra yet (no buildkit broker,
 *     no GH Actions builder wired up). Instead, every CI build that
 *     touches driver code re-runs this script, regenerates the
 *     Dockerfile, rebuilds the kitchen-sink image. Same code path
 *     drives self-deploy bundles, so the two surfaces stay aligned.
 *
 * Mock-connection probe: we don't have a `staticDockerfileDeps`
 * contract on drivers yet. So we call `generatePipeline()` with
 * inputs designed to provoke every conditional dep — refreshable
 * credentials + an "all" or single-placeholder selection.
 *
 * Output: containers/forwarder/Dockerfile.generated. The
 * build-forwarder workflow consumes this file.
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderDockerfile } from "@logtura/core";
import { listProviders } from "../src/providers/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, "..", "containers", "forwarder", "Dockerfile.generated");

/** Try a sequence of `generatePipeline` invocations until one
 *  doesn't throw, capturing the dockerfileDeps. We want the widest
 *  set, so we prefer refreshable credentials and try "all" first
 *  (most drivers' deps don't depend on selection contents). */
function harvestDeps(driver) {
  const baseConnection = {
    id: "con_kitchen_sink",
    externalAccountId: "acct_kitchen_sink",
    displayName: "Kitchen-sink probe",
    credentialKind: "refreshable",
  };
  const placeholderSource = {
    id: "src_kitchen_sink",
    externalId: "kitchen-sink-probe",
    displayName: "kitchen-sink-probe",
    sourceKind: "kitchen_sink",
    metadata: { function_id: "00000000-0000-0000-0000-000000000000" },
  };
  const attempts = [
    { kind: "all" },
    { kind: "list", sources: [] },
    { kind: "list", sources: [placeholderSource] },
  ];
  let lastErr = null;
  for (const selection of attempts) {
    if (
      selection.kind === "all" &&
      driver.capabilities?.selection === "list"
    ) {
      continue;
    }
    try {
      const pipe = driver.generatePipeline({
        connection: baseConnection,
        selection,
      });
      return pipe.dockerfileDeps ?? [];
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `harvest failed for driver ${driver.id}: ${lastErr?.message ?? "unknown"}`,
  );
}

function dedupeDeps(deps) {
  // Same `directive` line or same `install` command de-dupes.
  // aptPackages get unioned by the renderer already, but we also
  // collapse exact-duplicate entries here.
  const seen = new Set();
  const out = [];
  for (const d of deps) {
    const key = JSON.stringify({
      install: d.install ?? null,
      directive: d.directive ?? null,
      aptPackages: d.aptPackages ?? null,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

const providers = listProviders();
console.log(`harvesting deps from ${providers.length} providers...`);

const allDeps = [];
for (const p of providers) {
  let deps;
  try {
    deps = harvestDeps(p);
  } catch (err) {
    console.error(`  ✗ ${p.id}: ${err.message}`);
    process.exit(2);
  }
  console.log(
    `  ✓ ${p.id} → ${deps.length} dep(s)`,
  );
  allDeps.push(...deps);
}

const deduped = dedupeDeps(allDeps);
console.log(`\n${allDeps.length} deps → ${deduped.length} after dedup`);

// vector.yaml is mounted at runtime by the Fly machine config, not
// COPYed into the image.
const dockerfile = renderDockerfile(deduped, { mountVectorYamlAtRuntime: true });
writeFileSync(OUTPUT, dockerfile);
console.log(`\nwrote ${OUTPUT} (${dockerfile.length} bytes)`);
