// Deploy target driver contract.
//
// A deploy target answers "where is the forwarder going to run?" Each
// named target generates a target-tailored bundle (fly.toml,
// app.spec.yaml, CloudFormation, gcloud script, etc.) wrapping the
// generic Dockerfile + vector.yaml from the source bundle.
//
// Two orthogonal axes (see memory: Deploy target vs management):
//   1. The target itself (Fly, DO, AWS, GCP, Other)
//   2. Whether logtura manages the deploy (per-deployment; only
//      meaningful for named targets and for drivers that set
//      supportsManaged = true)
//
// CF Containers is intentionally not on the list — its Worker-coupled
// request-driven lifecycle doesn't fit our always-on Vector tail.

import type {
  ConnectFlow,
  FormField,
  ProviderAccount,
} from "../providers/types";
import type { GeneratedBundle } from "../generator";

export interface BundleFile {
  name: string;
  content: string;
  /** Optional language hint for syntax highlighting in the UI. */
  language?: string;
}

export interface TargetBundle {
  /** All files the user receives (or that we use for managed deploy). */
  files: BundleFile[];
  /** Human-readable, terminal-oriented self-deploy steps. */
  selfDeployInstructions: string;
}

export interface DeployStatus {
  status: "pending" | "running" | "crashed" | "stopped" | "detached";
  metadata?: Record<string, unknown>;
}

export interface DeployTargetDriver<TCreds = unknown> {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  /** True when logtura can deploy on the user's behalf (Flavor B). */
  readonly supportsManaged: boolean;

  /** Connect flow + form fields when a managed deploy is offered. */
  readonly connectFlow?: ConnectFlow;
  readonly formFields: readonly FormField[];

  /** Parse credentials from the connect form (managed only). */
  parseFormData?(form: FormData): {
    credentials: TCreds;
    explicitAccountId: string | null;
  };

  /** Verify credentials (managed only). */
  verifyCredentials?(creds: TCreds): Promise<ProviderAccount[]>;

  /**
   * Build the target-tailored bundle. For named targets this includes
   * an extra config file (fly.toml, app.spec.yaml, …) on top of the
   * generic Dockerfile/vector.yaml. For Other this is just the
   * generic bundle.
   */
  generateTargetBundle(input: {
    sourceBundle: GeneratedBundle;
    deploymentName: string;
    region?: string;
    connectionId: string;
  }): TargetBundle;

  /**
   * Execute a managed deploy (managed only). Returns a target-side
   * external id (Fly app name, DO app id, …) that we record on the
   * deployments row.
   */
  deploy?(input: {
    credentials: TCreds;
    sourceBundle: GeneratedBundle;
    deploymentName: string;
    region?: string;
  }): Promise<{ externalId: string; status: DeployStatus["status"] }>;

  getStatus?(input: {
    credentials: TCreds;
    externalId: string;
  }): Promise<DeployStatus>;

  destroy?(input: {
    credentials: TCreds;
    externalId: string;
  }): Promise<void>;
}

export class DeployTargetError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "DeployTargetError";
  }
}
