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
    const scope = hasComponentGlobs(config.fragment, defined) || wildcardReferences(config.feed, defined).length && !localReference(config.feed, defined) ? graphScope(connection.id) : undefined;
    const keyMap = prefixedKeyMap(defined, prefix, scope);
    const outputKey = mappedReference(config.feed, keyMap) ?? (scope && wildcardReferences(config.feed, defined).length ? scope + config.feed : null);
    if (!outputKey) {
      throw new Error(
        `custom-vector source feed "${config.feed}" must name a source or transform in the included Vector fragment`,
      );
    }
    const components: VectorComponent[] = [
      ...componentEntries(config.fragment.sources, "source", keyMap, scope),
      ...componentEntries(config.fragment.transforms, "transform", keyMap, scope),
    ];
    return {
      components,
      outputKey,
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
    const prefix = `custom_${safeKey(sinkKey)}`;
    const upstream = definedKeys(config.fragment, ["transforms"]);
    const scope = hasComponentGlobs(config.fragment, upstream) ? graphScope(sinkKey) : undefined;
    const keyMap = prefixedKeyMap(defined, prefix, scope);
    const inputPlaceholder = config.input ?? inferSingleDanglingInput(config.fragment, keyMap, upstream);
    if (mappedReference(inputPlaceholder, keyMap) || wildcardReferences(inputPlaceholder, upstream).length) {
      throw new Error("custom-vector input must name an external placeholder, not a defined component");
    }
    const alias = scope ? externalAlias(inputPlaceholder, inputs[0]!, scope) : null;
    keyMap.set(inputPlaceholder, alias?.reference ?? inputs[0]!);
    return {
      preSinkTransforms: [...(alias ? [{key: alias.key, yaml: renderComponentYaml(alias.component)}] : []), ...componentEntries(
        config.fragment.transforms,
        "transform",
        keyMap,
        scope,
      ).map(({ key, yaml }) => ({ key, yaml }))],
      sinks: componentEntries(config.fragment.sinks, "sink", keyMap, scope).map(
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
  scope?: string,
): Array<{ key: string; kind: VectorComponent["kind"]; yaml: string }> {
  if (!raw) return [];
  return Object.entries(raw).map(([key, value]) => {
    const mappedKey = keyMap.get(key);
    if (!mappedKey) throw new Error(`missing mapped key for ${key}`);
    const rewritten = rewriteInputs(value, keyMap, scope);
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

/** Exact component identities take precedence over dotted output references. */
function mappedReference(input: string, keyMap: Map<string, string>): string | null {
  const exact = keyMap.get(input);
  if (exact) return exact;
  // Longest identity wins if an included component itself contains dots.
  for (const key of [...keyMap.keys()].sort((a, b) => b.length - a.length)) {
    if (input.startsWith(`${key}.`)) return keyMap.get(key)! + input.slice(key.length);
  }
  return null;
}

/** Inputs are matched against complete output IDs, including named ports. */
function wildcardReferences(input: string, upstream: Set<string>, current?: string): string[] {
  if (!/[*?[]/.test(input)) return [];
  const pattern = globPattern(input);
  return [...upstream].filter(key => key !== current && (pattern.test(key) || pattern.test(key + ".", true)));
}

function localReference(input: string, upstream: Set<string>): boolean {
  return upstream.has(input) || [...upstream].some(key => input.startsWith(key + "."));
}

function graphScope(identity: string): string {
  // RFC3986 escaping keeps the namespace literal to Vector's glob engine and
  // distinguishes connection/sink identities that normalize to the same text.
  return `custom_${encodeURIComponent(identity).replace(/[.!'()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase())}/`;
}

function externalAlias(input: string, monitor: string, scope: string) {
  const dot = input.indexOf("."), name = dot < 0 ? input : input.slice(0, dot), port = input.slice(dot + 1);
  const key = scope + name;
  const component = dot < 0 ? {type: "remap", inputs: [monitor], source: ". = ."}
    : port === "_unmatched" ? {type: "route", inputs: [monitor], route: {logtura_unused: "false"}, reroute_unmatched: true}
    : {type: "exclusive_route", inputs: [monitor], routes: [{name: port, condition: "true"}]};
  return {key, reference: scope + input, component};
}

/** Vector 0.55 uses Rust glob patterns, including ? and bracket classes. */
function globPattern(value: string): { test(candidate: string, prefix?: boolean): boolean } {
  type Token = string | { kind: "star" } | { kind: "any" } | { kind: "directories" } | { kind: "class"; pattern: RegExp };
  const characters = Array.from(value), tokens: Token[] = [];
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index]!;
    if (character === "*") {
      if (characters[index + 1] === "*") {
        if ((index > 0 && characters[index - 1] !== "/") || (index + 2 < characters.length && characters[index + 2] !== "/")) {
          throw new Error("Invalid custom-vector wildcard pattern");
        }
        index++;
        if (characters[index + 1] === "/") { tokens.push({kind: "directories"}); index++; }
        else tokens.push({kind: "star"});
      } else tokens.push({kind: "star"});
    } else if (character === "?") tokens.push({kind: "any"});
    else if (character === "[") {
      const start = index + (characters[index + 1] === "!" ? 2 : 1);
      const end = characters.indexOf("]", start + (characters[start] === "]" ? 1 : 0));
      if (end < 0 || end === index + 1) throw new Error("Invalid custom-vector wildcard character class");
      let content = characters.slice(index + 1, end).join("");
      const negated = content.startsWith("!");
      if (negated) content = content.slice(1);
      try {
        const escaped = content.replace(/[\\^[\]]/g, "\\$&");
        tokens.push({kind: "class", pattern: new RegExp(`^[${negated ? "^" : ""}${escaped}]$`, "us")});
      } catch { throw new Error("Invalid custom-vector wildcard pattern"); }
      index = end;
    } else tokens.push(character);
  }
  return { test(candidate, prefix = false) {
    // Polynomial matching avoids backtracking when hosted configuration contains
    // long sequences of stars. State tracks matched prefixes, never recursion.
    const input = Array.from(candidate);
    let state = Array<boolean>(input.length + 1).fill(false);
    state[0] = true;
    let extendable = false;
    for (const token of tokens) {
      const next = Array<boolean>(input.length + 1).fill(false);
      let reachable = false;
      for (let index = 0; index <= input.length; index++) {
        reachable ||= state[index]!;
        if (typeof token !== "string" && token.kind === "star") next[index] = reachable;
        else if (typeof token !== "string" && token.kind === "directories") {
          next[index] = state[index]! || (reachable && index > 0 && input[index - 1] === "/");
        } else if (index < input.length && state[index]) {
          next[index + 1] = typeof token === "string" ? token === input[index]
            : token.kind === "any" || token.pattern.test(input[index]!);
        }
      }
      state = next;
      extendable ||= state[input.length]!;
    }
    return prefix ? extendable : state[input.length]!;
  }};
}

function hasComponentGlobs(fragment: CustomVectorFragment, upstream: Set<string>): boolean {
  const visit = (value: unknown, current: string): boolean => {
    if (Array.isArray(value)) return value.some(child => visit(child, current));
    if (!isRecord(value)) return false;
    return collectInputs(value).some(input => !localReference(input, upstream) && wildcardReferences(input, upstream, current).length > 0)
      || Object.entries(value).some(([key, child]) => key !== "inputs" && visit(child, current));
  };
  return ["sources", "transforms", "sinks"].some(section =>
    Object.entries(fragment[section as ComponentSection] ?? {}).some(([key, value]) => visit(value, key)));
}

function rewriteInputs(value: unknown, keyMap: Map<string, string>, scope?: string): unknown {
  if (Array.isArray(value)) return value.map(item => rewriteInputs(item, keyMap, scope));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "inputs" && Array.isArray(child)) {
      out[key] = child.map(input => {
        if (typeof input !== "string") return input;
        const mapped = mappedReference(input, keyMap);
        if (mapped) return mapped;
        if (/[*?[]/.test(input)) {
          globPattern(input);
          if (scope) return scope + input;
          throw new Error(`custom-vector wildcard input "${input}" has no matching included components`);
        }
        return input;
      });
    } else out[key] = rewriteInputs(child, keyMap, scope);
  }
  return out;
}

function inferSingleDanglingInput(
  fragment: CustomVectorFragment,
  keyMap: Map<string, string>,
  upstream: Set<string>,
): string {
  const dangling = new Set<string>();
  for (const section of ["transforms", "sinks"] as const) {
    for (const [key, component] of Object.entries(fragment[section] ?? {})) {
      for (const input of collectInputs(component)) {
        if (!mappedReference(input, keyMap) && !wildcardReferences(input, upstream, key).length) dangling.add(input);
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

function prefixedKeyMap(keys: Set<string>, prefix: string, scope?: string): Map<string, string> {
  const out = new Map<string, string>();
  const mapped = new Set<string>();
  for (const key of keys) {
    if (scope && key.includes(".")) throw new Error("custom-vector component names cannot contain dots in a wildcard graph");
    const target = scope ? scope + key : `${prefix}_${safeKey(key)}`;
    if (mapped.has(target)) throw new Error("custom-vector component keys collide after normalization");
    mapped.add(target);
    out.set(key, target);
  }
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
