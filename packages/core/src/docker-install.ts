import type { BundleEnvVar } from "./types";
import { shellQuote } from "./install";

/** A literal-safe generic build/run command. Unknown values are inherited
 * explicitly and checked before Docker receives any operation. */
export function renderDockerRunCommand(envVars: Pick<BundleEnvVar, "name" | "value">[]): string {
  for (const variable of envVars) {
    if (typeof variable.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name)) throw new Error("Invalid Docker environment name");
    if (variable.value !== null && (typeof variable.value !== "string" || variable.value.includes("\0"))) throw new Error("Invalid Docker environment value");
  }
  const missing = envVars.filter(variable => variable.value === null || variable.value === "");
  const flags = envVars.map(variable => `  -e ${variable.value === null || variable.value === "" ? `"${variable.name}=\${${variable.name}}"` : shellQuote(`${variable.name}=${variable.value}`)}`);
  return [
    ...missing.map(variable => `: "\${${variable.name}:?Set ${variable.name} before running run.sh}"`),
    "docker build -t logtura-forwarder .",
    "",
    "docker run --rm \\",
    ...flags.map(flag => `${flag} \\`),
    "  logtura-forwarder",
  ].join("\n");
}
