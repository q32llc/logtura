import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseConfigDocument, normalizeConfigDocument, hashConfigDocument, type ParsedConfig } from "@logtura/core";
export { ensureSection, ensureListSection, safeId, defaultProviderName } from "@logtura/core";
export type { ParsedConfig } from "@logtura/core";
import { readDotEnvFile } from "./local-env";
import { listDestinations, listProviders } from "./registry";

type UnknownRecord = Record<string, unknown>;

export const CONFIG_FILENAMES = [
  "logt.yaml",
  "logt.yml",
  "logtura.yaml",
  "logtura.yml",
] as const;

export interface ConfigFileRef {
  path: string;
  existed: boolean;
}

export function findConfigPath(explicit?: string): ConfigFileRef {
  if (explicit) return { path: explicit, existed: existsSync(explicit) };
  const fromEnv = process.env.LOGT_CONFIG;
  if (fromEnv) return { path: fromEnv, existed: existsSync(fromEnv) };
  for (const name of CONFIG_FILENAMES) {
    if (existsSync(name)) return { path: name, existed: true };
  }
  return { path: "logt.yaml", existed: false };
}

export function loadConfigFile(path: string): ParsedConfig {
  return parseConfig(readFileSync(path, "utf8"), path);
}

export function readConfigDoc(path: string): UnknownRecord {
  if (!existsSync(path)) return {};
  const parsed = parseYaml(readFileSync(path, "utf8")) as unknown;
  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) throw new Error(`${path}: expected a YAML object`);
  return parsed;
}

export function writeConfigDoc(path: string, doc: UnknownRecord): void {
  writeFileSync(path, stringifyYaml(doc, { lineWidth: 96 }));
}

export function parseConfig(text: string, filename = "logt.yaml"): ParsedConfig {
  const baseDir = dirname(resolve(filename));
  const values = readConfigEnvironment(filename);
  return parseConfigDocument(parseYaml(text), {
    filename, env: values, providers: listProviders(), destinations: listDestinations(),
    readInclude: (include) => parseYaml(readFileSync(resolve(baseDir, include), "utf8")),
  });
}

export function readConfigEnvironment(path:string):Record<string,string>{
  const values=Object.fromEntries(readDotEnvFile(resolve(dirname(resolve(path)),".env")));
  for(const [key,value] of Object.entries(process.env))if(value!==undefined)values[key]=value;
  return values;
}

export function normalizeConfigFile(path: string): UnknownRecord {
  if (!existsSync(path)) throw new Error(`Configuration not found: ${path}`);
  return normalizeConfigDocument(readConfigDoc(path), includeOptions(path));
}

export async function hashConfigFile(path: string): Promise<string> {
  if (!existsSync(path)) throw new Error(`Configuration not found: ${path}`);
  return hashConfigDocument(readConfigDoc(path), includeOptions(path));
}

function includeOptions(path: string) {
  return {filename: path, readInclude: (include: string) => parseYaml(readFileSync(resolve(dirname(resolve(path)), include), "utf8"))};
}

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
