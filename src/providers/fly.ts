import {
  flyAuthHeader,
  listFlyOrgs,
} from "../deploy-targets/fly-machines";
import type {
  ConnectionRef,
  DiscoveredSource,
  ProviderDriver,
  SourceBlock,
  SourceRef,
} from "./types";
import { ProviderError } from "./types";

export interface FlyCredentials {
  apiToken: string;
}

/**
 * Fly.io source provider.
 *
 * Same identity model the deploy_target driver uses — a Fly API
 * token (or read-only macaroon minted from one). Difference is
 * what we do with it: list apps to discover sources, then run
 * `flyctl logs --json -a <app>` in the forwarder to tail them.
 *
 * For the connect surface we offer paste-token only. The
 * bootstrap-mediated path ("use your existing Fly connection")
 * comes for free via deploy_target.mintConnectionCredentials —
 * the New Connection UI already wires it when a Fly bootstrap
 * exists. The cli_session OAuth-style flow belongs on the
 * deploy_target (where logtura holds + uses the token), not on
 * the source connection (where the credential lives in the user's
 * forwarder container and should be narrowly scoped).
 */
export const flyDriver: ProviderDriver<FlyCredentials> = {
  id: "fly",
  displayName: "Fly.io",

  connectFlow: {
    kind: "external_token",
    // Fly doesn't have a click-through scope template like Cloudflare;
    // tokens are minted via `fly tokens create readonly -o <org>` or
    // (in our world) via the bootstrap mint button on this page.
    url: "https://fly.io/user/personal_access_tokens",
    buttonLabel: "Open Fly tokens page",
    buttonDescription:
      "Run `fly tokens create readonly -o <your-org>` and paste the resulting `FlyV1 …` token below. (Easier: if you already linked Fly for a managed deploy, use the bootstrap option above — we'll mint a read-only token for you.)",
    pasteFieldName: "api_token",
    manualInstructions:
      "Tokens are also visible at fly.io/user/personal_access_tokens — but the dashboard only mints full-account tokens. For source connections prefer the CLI's `tokens create readonly` so the credential can't write to your account.",
  },

  formFields: [
    {
      name: "api_token",
      label: "Fly API token (FlyV1 …)",
      type: "password",
      placeholder: "FlyV1 fm2_…,fm2_…",
      description:
        "Used to discover apps + tail their logs. Read-only is recommended; `fly tokens create readonly -o <org>` produces one. Revokable from the Fly dashboard.",
      required: true,
    },
    {
      name: "org_slug",
      label: "Fly organization (optional)",
      type: "text",
      placeholder: "personal",
      description:
        "Defaults to your personal org if blank. Used to scope discovery.",
      required: false,
    },
  ],

  parseFormData(form) {
    const apiToken = String(form.get("api_token") ?? "").trim();
    const orgSlug = String(form.get("org_slug") ?? "").trim();
    if (!apiToken) throw new ProviderError("Missing api_token", 400);
    return {
      credentials: { apiToken },
      explicitAccountId: orgSlug || null,
    };
  },

  async verifyCredentials(creds) {
    // Resolves the org list via the same GraphQL endpoint the deploy
    // target uses. Token validity is implicit in a successful org
    // list; we don't have a dedicated /verify endpoint to hit.
    const orgs = await listFlyOrgs(flyAuthHeader(creds.apiToken));
    if (orgs.length === 0) {
      throw new ProviderError("Fly token has no visible orgs", 403);
    }
    return orgs.map((o) => ({ id: o.slug, name: o.slug }));
  },

  async discoverSources({ credentials, accountId }) {
    // Apps live under an org. accountId is the org slug; we list
    // apps and treat each as one source. Machines API exposes
    // /v1/apps?org_slug=… for this.
    const url = `https://api.machines.dev/v1/apps?org_slug=${encodeURIComponent(accountId)}`;
    const res = await fetch(url, {
      headers: { authorization: flyAuthHeader(credentials.apiToken) },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ProviderError(
        `Fly apps list failed: ${res.status} ${body.slice(0, 200)}`,
        res.status,
      );
    }
    const data = (await res.json()) as {
      apps?: Array<{ id?: string; name?: string; machine_count?: number }>;
    };
    const apps = data.apps ?? [];
    const sources: DiscoveredSource[] = [];
    for (const app of apps) {
      const name = app.name ?? app.id;
      if (!name) continue;
      sources.push({
        sourceKind: "fly_app",
        externalId: name,
        displayName: name,
        metadata: { machine_count: app.machine_count ?? null },
      });
    }
    return sources;
  },

  generateSourceBlock({ source }: { source: SourceRef; connection: ConnectionRef }): SourceBlock {
    if (source.sourceKind !== "fly_app") {
      throw new Error(`Unknown fly source kind: ${source.sourceKind}`);
    }
    const key = `fly_app_${safeKey(source.externalId)}`;
    // `flyctl logs --json -a <app>` emits one JSON event per line,
    // but the app name isn't in the event payload (flyctl knows it
    // from `-a` and doesn't repeat it). We tag at the source via a
    // shell pipeline:  flyctl … | jq -c '. + {app: "<app>"}'
    // so every event carries .app before reaching the consolidated
    // normalize transform — the downstream filters need .script set
    // correctly per-app, and we know the name at bundle time. jq +
    // unbuffered output both ship in our kitchen-sink image, same
    // as the wrangler-tail path.
    const appJq = JSON.stringify(source.externalId).replace(/"/g, '\\"');
    const command = `flyctl logs --json -a ${shellQuote(source.externalId)} | jq -c --unbuffered '. + {app: "${appJq.slice(1, -1)}"}'`;
    const yaml = [
      `    type: exec`,
      `    command: ["sh", "-c", ${JSON.stringify(command)}]`,
      `    mode: streaming`,
      `    decoding:`,
      `      codec: json`,
    ].join("\n");
    return { key, yaml, normalizeKind: "fly_app" };
  },

  generateNormalize({ kind, inputKeys }) {
    if (inputKeys.length === 0) return null;
    if (kind !== "fly_app") return null;
    return {
      key: "fly_app_norm",
      yaml: flyAppNormalizeYaml(inputKeys),
    };
  },

  runtimeSpec() {
    return {
      envVars: [
        {
          name: "FLY_API_TOKEN",
          description:
            "Fly token used by flyctl logs to tail each selected app. Read-only is enough; the forwarder never writes to your account.",
          source: "credential",
          credentialPath: "apiToken",
          helpUrl: "https://fly.io/user/personal_access_tokens",
        },
      ],
      dockerfileDeps: [
        // flyctl already ships in our kitchen-sink forwarder image;
        // declaring the dep here is mostly self-documentation and a
        // belt for self-deploy users who build their own image.
        {
          install:
            "curl -L https://fly.io/install.sh | sh && cp /root/.fly/bin/flyctl /usr/local/bin/flyctl",
          aptPackages: ["curl", "ca-certificates"],
        },
      ],
    };
  },

  sourceKindLabel(kind) {
    if (kind === "fly_app") return "App";
    return kind;
  },
};

function safeKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Refuse anything that could break out of the shell quoting. App
 *  names are validated by Fly to a strict charset (lowercase
 *  alphanum + hyphen) and we discovered them via our own API call,
 *  so anything weirder than that means tampering or a Fly change we
 *  haven't seen. Better to fail loudly. */
function shellQuote(s: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) {
    throw new Error(`unsafe fly app name for shell: ${s}`);
  }
  return s;
}

/**
 * Normalize fly log events to the uniform shape (.message, .level,
 * .error, .script, .timestamp) so downstream filters can be
 * provider-agnostic. flyctl logs --json shape (per emitted line):
 *   { timestamp, level, message, region, instance, ... }
 * The source wrapper around `flyctl logs` pre-tags every event with
 * `.app = "<app>"` (the app name isn't in flyctl's payload — it
 * knows from `-a` and doesn't repeat it), so .script is always
 * populated here. Mirrors cloudflare's .scriptName → .script
 * convention so per-app/per-worker monitor filters use the same
 * field.
 */
function flyAppNormalizeYaml(inputKeys: string[]): string {
  const vrl = [
    `.script = string(.app) ?? "fly"`,
    `.timestamp = .timestamp`,
    `level_str = string(.level) ?? "info"`,
    `.level = level_str`,
    `.error = level_str == "error" || level_str == "fatal" || level_str == "panic"`,
    `msg = string(.message) ?? ""`,
    `if msg == "" {`,
    `  msg = "[" + .script + "]"`,
    `}`,
    `.message = msg`,
  ];
  return [
    "    type: remap",
    `    inputs: [${inputKeys.map((k) => `"${k}"`).join(", ")}]`,
    "    source: |-",
    ...vrl.map((line) => `      ${line}`),
  ].join("\n");
}
