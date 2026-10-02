import { run } from "../oss/scripts/coverage-report.mjs";
import { appendFileSync } from "node:fs";
try { run(process.argv.slice(2)); }
catch (error) {
  const message = `Coverage reporting failed: ${error.message}`;
  console.error(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n**${message.replaceAll("\n", " ")}**\n`);
  process.exitCode = 1;
}
