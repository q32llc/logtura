import { defineConfig } from "vitest/config";

// Per-driver vitest. Two kinds of tests live here:
//
//   unit.test.ts            — pure renderer / form-parser assertions
//                             (fast, no I/O).
//   vector-validate.test.ts — black-box "the YAML this driver emits
//                             passes `vector validate`" check. Spawns
//                             `docker run timberio/vector:latest …`,
//                             so it's skipped when docker isn't
//                             available (eg. CI containers that don't
//                             expose the docker socket).
//
// Vector validation runs from the driver's own package so contributors
// adding a driver only need this directory; no central fixture file
// to update.
export default defineConfig({
  test: {
    name: "@logtura/driver-cloudflare-worker-tail",
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
