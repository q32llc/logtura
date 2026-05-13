import {
  type ConnectionRef,
  type DestinationDriver,
  type DiscoveredSource,
  type DriverPipeline,
  type ProviderAccount,
  type ProviderDriver,
  type ProviderSelection,
  type SinkBundle,
  type VectorComponent,
} from "@logtura/core";
import { stringify } from "yaml";

export interface CustomVectorFragment {
  sources?: Record<string, unknown>;
  transforms?: Record<string, unknown>;
  sinks?: Record<string, unknown>;
}

export interface CustomVectorSourceConfig {
  fragment: CustomVectorFragment;
  feed: string;
}

export interface CustomVectorDestinationConfig {
  fragment: CustomVectorFragment;
  input?: string | null;
}

type ComponentSection = "sources" | "transforms" | "sinks";

export const customVectorProvider: ProviderDriver<CustomVectorSourceConfig> = {
  id: "custom-vector",
  displayName: "Custom Vector",
  sourceLabel: "Vector feed",
  capabilities: { selection: "list" },

  async verifyCredentials(): Promise<ProviderAccount[]> {
    return [{ id: "custom-vector", name: "Custom Vector" }];
  },

  async discoverSources(): Promise<DiscoveredSource[]> {
    return [];
  },

  generatePipeline({
    connection,
    selection,
  }: {
    connection: ConnectionRef;
    selection: ProviderSelection;
  }): DriverPipeline {
    const config = readCustomSourceConfig(selection);
    const prefix = `custom_${safeKey(connection.id)}`;
    validateOnly(config.fragment, ["sources", "transforms"], "custom-vector source");
    const defined = definedKeys(config.fragment, ["sources", "transforms"]);
    if (!defined.has(config.feed)) {
      throw new Error(
        `custom-vector source feed "${config.feed}" must name a source or transform in the included Vector fragment`,
      );
    }
    const keyMap = prefixedKeyMap(defined, prefix);
    const components: VectorComponent[] = [
      ...componentEntries(config.fragment.sources, "source", keyMap),
      ...componentEntries(config.fragment.transforms, "transform", keyMap),
    ];
    return {
      components,
      outputKey: keyMap.get(config.feed)!,
      envVars: [],
      dockerfileDeps: [],
      manifest: components.map((c) => ({
        id: c.key,
        role: c.kind === "source" ? "source" : "normalize",
        category: c.kind === "source" ? "primary" : "plumbing",
        label: c.kind === "source" ? "Custom Vector source" : "Custom Vector transform",
        links: { connectionId: connection.id },
      })),
    };
  },
};

export const customVectorDestination: DestinationDriver<CustomVectorDestinationConfig> = {
  id: "custom-vector",
  displayName: "Custom Vector",
  description:
    "Route matched events into user-owned Vector transforms and sinks.",
  flows: ["logs", "metrics"],

  generateSinkBundle({ config, inputs, sinkKey }): SinkBundle {
    validateOnly(config.fragment, ["transforms", "sinks"], "custom-vector sink");
    if (inputs.length !== 1) {
      throw new Error("custom-vector sink expects exactly one Logtura input");
    }
    const defined = definedKeys(config.fragment, ["transforms", "sinks"]);
    const inputPlaceholder = config.input ?? inferSingleDanglingInput(config.fragment, defined);
    const prefix = `custom_${safeKey(sinkKey)}`;
    const keyMap = prefixedKeyMap(defined, prefix);
    keyMap.set(inputPlaceholder, inputs[0]!);
    return {
      preSinkTransforms: componentEntries(
        config.fragment.transforms,
        "transform",
        keyMap,
      ).map(({ key, yaml }) => ({ key, yaml })),
      sinks: componentEntries(config.fragment.sinks, "sink", keyMap).map(
        ({ key, yaml }) => ({ key, yaml }),
      ),
    };
  },

  runtimeEnvVars() {
    return [];
  },

  envVarValue() {
    return null;
  },
};

function readCustomSourceConfig(selection: ProviderSelection): CustomVectorSourceConfig {
  if (selection.kind === "all") {
    throw new Error("custom-vector source does not support all-selection");
  }
  const raw = selection.sources[0]?.metadata?.customVector;
  if (!isRecord(raw)) {
    throw new Error("custom-vector source requires a parsed vector config");
  }
  const fragment = raw.fragment;
  const feed = raw.feed;
  if (!isFragment(fragment) || typeof feed !== "string" || feed === "") {
    throw new Error("custom-vector source requires vector.include and vector.feed");
  }
  return { fragment, feed };
}

function componentEntries(
  raw: Record<string, unknown> | undefined,
  kind: VectorComponent["kind"] | "sink",
  keyMap: Map<string, string>,
): Array<{ key: string; kind: VectorComponent["kind"]; yaml: string }> {
  if (!raw) return [];
  return Object.entries(raw).map(([key, value]) => {
    const mappedKey = keyMap.get(key);
    if (!mappedKey) throw new Error(`missing mapped key for ${key}`);
    const rewritten = rewriteInputs(value, keyMap);
    return {
      key: mappedKey,
      kind: kind === "sink" ? "source" : kind,
      yaml: renderComponentYaml(rewritten),
    };
  });
}

function renderComponentYaml(component: unknown): string {
  return stringify(component).trimEnd().split("\n").map((line) => `    ${line}`).join("\n");
}

function rewriteInputs(value: unknown, keyMap: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteInputs(item, keyMap));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "inputs" && Array.isArray(child)) {
      out[key] = child.map((input) =>
        typeof input === "string" ? (keyMap.get(input) ?? input) : input,
      );
    } else {
      out[key] = rewriteInputs(child, keyMap);
    }
  }
  return out;
}

function inferSingleDanglingInput(
  fragment: CustomVectorFragment,
  defined: Set<string>,
): string {
  const dangling = new Set<string>();
  for (const section of ["transforms", "sinks"] as const) {
    for (const component of Object.values(fragment[section] ?? {})) {
      for (const input of collectInputs(component)) {
        if (!defined.has(input)) dangling.add(input);
      }
    }
  }
  if (dangling.size !== 1) {
    throw new Error(
      `custom-vector sink requires vector.input when the included graph has ${dangling.size} dangling inputs`,
    );
  }
  return [...dangling][0]!;
}

function collectInputs(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const inputs = value.inputs;
  if (!Array.isArray(inputs)) return [];
  return inputs.filter((input): input is string => typeof input === "string");
}

function validateOnly(
  fragment: CustomVectorFragment,
  allowed: ComponentSection[],
  label: string,
) {
  const allowedSet = new Set(allowed);
  for (const section of ["sources", "transforms", "sinks"] as const) {
    const value = fragment[section];
    if (value !== undefined && !allowedSet.has(section)) {
      throw new Error(`${label} include cannot define ${section}`);
    }
    if (value !== undefined && !isRecord(value)) {
      throw new Error(`${label} ${section} must be a component map`);
    }
  }
}

function definedKeys(
  fragment: CustomVectorFragment,
  sections: ComponentSection[],
): Set<string> {
  const out = new Set<string>();
  for (const section of sections) {
    for (const key of Object.keys(fragment[section] ?? {})) {
      if (out.has(key)) throw new Error(`duplicate custom-vector component key: ${key}`);
      out.add(key);
    }
  }
  return out;
}

function prefixedKeyMap(keys: Set<string>, prefix: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of keys) out.set(key, `${prefix}_${safeKey(key)}`);
  return out;
}

function isFragment(value: unknown): value is CustomVectorFragment {
  if (!isRecord(value)) return false;
  return ["sources", "transforms", "sinks"].some((key) => key in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "x";
}
