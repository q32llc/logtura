import { serializeBundleFiles } from "./bundle-files";
import { flySelfDeployFiles } from "@logtura/core";
import {
  createLimitedAccessToken,
  flyAuthHeader,
  listFlyOrgs,
} from "./fly-machines";
import { attenuateBundleOrgReadOnly, dischargeBundle } from "./fly-macaroon";
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
 * Managed installs run through the service's durable queue/issued-runtime chain.
 * This adapter supplies self-deploy files and hosted target authentication.
 */
export const flyDriver: DeployTargetDriver<FlyCredentials> = {
  id: "fly",
  displayName: "Fly.io",
  description:
    "Always-on Machines, ~$2/month for a tiny shared-cpu VM. Designed for exactly this kind of workload. Pick a region close to your sources.",
  supportsManaged: true,
  mintsForProviders: ["fly-log-tail"],
  connectFlow: {
    kind: "cli_session",
    startPath: "/api/deploy-targets/fly/start",
    pollPath: "/api/deploy-targets/fly/poll",
    buttonLabel: "Connect Fly",
    buttonDescription:
      "Opens Fly's auth page in a new tab. Approve, and we capture the access token automatically (same flow flyctl uses for `fly auth login`).",
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
    const language: Record<string, string> = {Dockerfile: "dockerfile", "vector.yaml": "yaml", "fly.toml": "toml", "deploy.sh": "bash"};
    const files = serializeBundleFiles(flySelfDeployFiles({bundle: sourceBundle, appName, region}), language);

    const instructions = [
      "1. Save these files to an empty directory, preserving the shown assets/ subdirectories.",
      "2. Install flyctl if you haven't:  brew install flyctl   (or see fly.io/docs/flyctl/install)",
      "3. Sign in:                         flyctl auth login",
      "   Set any missing credential environment variables listed in fly.toml before running.",
      `4. Run the deploy script:           bash deploy.sh`,
      "   Preserve runtime asset permission modes when saving files.",
      "",
      "deploy.sh creates a Fly app named " +
        appName +
        ", sets the env-var secrets, and deploys a single Machine. Edit fly.toml to change region or VM size before running.",
    ].join("\n");

    return { files, selfDeployInstructions: instructions };
  },

  async mintConnectionCredentials({ bootstrapCredentials, providerId, scope }) {
    if (providerId !== "fly-log-tail") {
      throw new DeployTargetError(
        `Fly bootstrap can only mint credentials for the fly-log-tail source provider, got: ${providerId}`,
        400,
      );
    }
    // The bootstrap token from cli_session has third-party caveats
    // that need fresh discharge tickets before the GraphQL endpoint
    // will honor it. Cached discharges from approval-time go stale.
    const authHeader = await dischargeBundle(
      flyAuthHeader(bootstrapCredentials.apiToken),
    );
    const orgs = await listFlyOrgs(authHeader);
    // `scope` (when set) selects which org to mint against; we use
    // the slug for the same reason the deploy_target row does. With
    // no scope hint, prefer "personal" then fall through to the
    // first visible org — matches resolveFlyOrgSlug's selection.
    const org = scope === undefined
      ? orgs.find(o => o.slug === "personal") ?? orgs[0]
      : orgs.find(o => o.slug === scope);
    if (!org) {
      throw new DeployTargetError(
        "Fly bootstrap has no visible org matching the requested scope",
        400,
      );
    }
    // Step 1: mint a fresh org-scoped token. Fly's GraphQL
    // `createLimitedAccessToken` doesn't expose a "read_only" profile
    // — flyctl's `fly tokens create readonly` starts with
    // `deploy_organization` and attenuates locally. Same pattern
    // here.
    const tokenHeader = await createLimitedAccessToken(authHeader, {
      name: `logtura-source-${org.slug}`,
      organizationId: org.id,
      profile: "deploy_organization",
    });
    // Step 2: client-side attenuate to read-only. Appends an
    // `Organization{Mask: ActionRead}` caveat to the permission
    // macaroon and recomputes the HMAC chain (anyone holding the
    // macaroon can attenuate without the issuer key — that's the
    // whole point of macaroons). Discharge tokens pass through.
    const readOnlyHeader = await attenuateBundleOrgReadOnly(tokenHeader);
    return { apiToken: readOnlyHeader, externalAccountId: org.slug };
  },
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
