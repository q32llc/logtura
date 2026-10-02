import { coverage } from "../oss/scripts/test-coverage.mjs";
process.exitCode = await coverage();
