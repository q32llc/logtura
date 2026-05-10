import type {
  DeployTargetDriver,
  TargetBundle,
} from "./types";
import { DeployTargetError } from "./types";

export interface FlyCredentials {
  apiToken: string;
}

const FLY_API = "https://api.fly.io/api/v1";

/**
 * Fly.io target driver.
 *
 * Self-deploy: generates a `fly.toml` + Dockerfile + vector.yaml + a
 * `flyctl launch` script. User runs flyctl themselves.
 *
 * Managed (supportsManaged=true): uses Fly's Machines API to create
 * the app, set secrets, and run a Machine. Not implemented in v0.1 —
 * the driver method is left undefined so the wizard's managed flow
 * surfaces a clear "coming soon" until we wire it.
 *
 * Auth (when managed lands): a personal access token from
 * https://fly.io/user/personal_access_tokens. We treat the org slug as
 * the `external_account_id`.
 */
export const flyDriver: DeployTargetDriver<FlyCredentials> = {
  id: "fly",
  displayName: "Fly.io",
  description:
    "Always-on Machines, ~$2/month for a tiny shared-cpu VM. Designed for exactly this kind of workload. Pick a region close to your sources.",
  supportsManaged: true,
  connectFlow: {
    kind: "external_token",
    url: "https://fly.io/user/personal_access_tokens",
    buttonLabel: "Create a Fly token",
    buttonDescription:
      "Opens Fly.io's Personal Access Token page. Create one named 'logtura', then paste it below.",
    pasteFieldName: "api_token",
  },
  formFields: [
    {
      name: "api_token",
      label: "Fly personal access token",
      type: "password",
      placeholder: "fo1_...",
      description:
        "Used to create the Fly app, set secrets, and run a Machine on your behalf. Revokable from Fly's dashboard at any time.",
      required: true,
    },
    {
      name: "org_slug",
      label: "Fly organization slug (optional)",
      type: "text",
      placeholder: "personal",
      description:
        "Defaults to your personal organization if blank.",
      required: false,
    },
  ],

  parseFormData(form) {
    const apiToken = String(form.get("api_token") ?? "").trim();
    const orgSlug = String(form.get("org_slug") ?? "").trim();
    if (!apiToken) {
      throw new DeployTargetError("Missing Fly API token", 400);
    }
    return {
      credentials: { apiToken },
      explicitAccountId: orgSlug || null,
    };
  },

  async verifyCredentials(creds) {
    // Fly's REST API: GET /api/v1/apps verifies token + lists apps;
    // we use the account-shape only loosely (Fly's "org" is the
    // closest analog).
    const res = await fetch(`${FLY_API}/apps`, {
      headers: { authorization: `Bearer ${creds.apiToken}` },
    });
    if (!res.ok) {
      throw new DeployTargetError(
        `Fly token verification failed: HTTP ${res.status}`,
        res.status,
      );
    }
    // We don't enumerate orgs here — return a single placeholder
    // since Fly's "org" is what the user set as orgSlug.
    return [{ id: "personal", name: "personal" }];
  },

  generateTargetBundle({
    sourceBundle,
    deploymentName,
    region,
    connectionId,
  }): TargetBundle {
    const appName = sanitizeAppName(deploymentName, connectionId);
    const flyToml = renderFlyToml({
      appName,
      region: region ?? "iad",
      envVars: sourceBundle.envVars.map((v) => v.name),
    });

    const secretsLines = sourceBundle.envVars
      .map((v) => {
        const placeholder = v.value !== null ? v.value : `<${v.name.toLowerCase()}>`;
        return `  ${v.name}="${placeholder}"`;
      })
      .join(" \\\n");

    const launchScript = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "",
      "# Step 1: create the Fly app (no first deploy yet).",
      `flyctl launch --copy-config --no-deploy --name ${appName}${region ? ` --region ${region}` : ""}`,
      "",
      "# Step 2: set the secrets the running container needs.",
      `flyctl secrets set --app ${appName} \\`,
      secretsLines,
      "",
      "# Step 3: deploy.",
      `flyctl deploy --app ${appName}`,
      "",
    ].join("\n");

    const files = [
      { name: "Dockerfile", content: sourceBundle.dockerfile, language: "dockerfile" },
      { name: "vector.yaml", content: sourceBundle.vectorYaml, language: "yaml" },
      { name: "fly.toml", content: flyToml, language: "toml" },
      { name: "deploy.sh", content: launchScript, language: "bash" },
    ];

    const instructions = [
      "1. Save these files to an empty directory.",
      "2. Install flyctl if you haven't:  brew install flyctl   (or see fly.io/docs/flyctl/install)",
      "3. Sign in:                         flyctl auth login",
      `4. Run the deploy script:           bash deploy.sh`,
      "",
      "deploy.sh creates a Fly app named " +
        appName +
        ", sets the env-var secrets, and deploys a single Machine. Edit fly.toml to change region or VM size before running.",
    ].join("\n");

    return { files, selfDeployInstructions: instructions };
  },

  // deploy / getStatus / destroy: deferred to next pass. The managed
  // toggle in the UI surfaces a "coming soon" until these land.
};

function sanitizeAppName(name: string, fallback: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  if (cleaned.length >= 3) return `logtura-${cleaned}`;
  return `logtura-${fallback.replace(/[^a-z0-9-]/gi, "").toLowerCase().slice(0, 20)}`;
}

function renderFlyToml(input: {
  appName: string;
  region: string;
  envVars: string[];
}): string {
  const lines: string[] = [];
  lines.push("# Generated by logtura — https://logtura.dev");
  lines.push(`app = "${input.appName}"`);
  lines.push(`primary_region = "${input.region}"`);
  lines.push("");
  lines.push("[build]");
  lines.push('  dockerfile = "Dockerfile"');
  lines.push("");
  lines.push("# Vector forwarder is always-on; one Machine, no autostop.");
  lines.push("[[vm]]");
  lines.push('  cpu_kind = "shared"');
  lines.push("  cpus = 1");
  lines.push("  memory_mb = 512");
  lines.push("");
  // Heartbeat exporter port; not exposed publicly. Fly's internal
  // network can scrape it from another app.
  lines.push("[[services]]");
  lines.push("  internal_port = 9598");
  lines.push('  protocol = "tcp"');
  lines.push("  auto_stop_machines = false");
  lines.push("  auto_start_machines = true");
  lines.push("  min_machines_running = 1");
  lines.push("");
  lines.push("# Required env-var secrets (set via `flyctl secrets set`):");
  for (const name of input.envVars) lines.push(`#   ${name}`);
  return lines.join("\n");
}
