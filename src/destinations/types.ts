// Destination driver contract.
//
// Adding a new destination type (Datadog, Better Stack, S3, etc.) is a
// single new file under `src/destinations/<name>.ts` plus a one-line
// registry entry. No schema change.
//
// The driver owns:
//   1. Form fields (or an OAuth redirect flow) for capturing config
//   2. Parsing the form into the stored config shape
//   3. Generating a Vector sink YAML block targeting this destination
//   4. Declaring the env vars the container needs to reach the destination
//   5. Mapping stored config to those env var values at bundle time

import type { ConnectFlow, EnvVarSpec, FormField } from "../providers/types";

export interface SinkBlock {
  /** Vector sink key (must be a valid YAML key). */
  key: string;
  /** YAML body for `sinks.<key>:` (without the key itself). */
  yaml: string;
}

export interface PreSinkTransform {
  /** Vector transform key (must be a valid YAML key). */
  key: string;
  /** YAML body for `transforms.<key>:` (without the key itself). */
  yaml: string;
}

export interface SinkBundle {
  /**
   * Optional Vector transforms applied between the upstream filter
   * and the actual sink. Slack uses this to remap events into the
   * `{text: "..."}` shape Slack incoming-webhooks expect.
   */
  preSinkTransforms?: PreSinkTransform[];
  sink: SinkBlock;
}

export interface DestinationDriver<TConfig = unknown> {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;

  /**
   * Optional structured connect flow (e.g. real OAuth for Slack).
   * If absent, the UI shows a simple form built from `formFields`.
   */
  readonly connectFlow?: ConnectFlow;
  readonly formFields: readonly FormField[];

  /**
   * Parse submitted form data into the credential/config shape.
   * Throws on missing/malformed input.
   */
  parseFormData(form: FormData): { config: TConfig };

  /**
   * Optional: verify the config works (e.g., test ping). Not required.
   */
  verifyConfig?(config: TConfig): Promise<void>;

  /**
   * Render the Vector pipeline contribution for a single sink: zero
   * or more pre-sink transforms followed by exactly one sink. `inputs`
   * is the list of upstream transform names feeding the first stage
   * (typically a per-sink filter transform). `sinkKey` is the unique
   * key the bundle assigned; `envVarName` is the runtime env var
   * holding any sensitive URL or token (so we don't bake secrets into
   * the image).
   */
  generateSinkBundle(input: {
    config: TConfig;
    inputs: string[];
    sinkKey: string;
    envVarName: string;
  }): SinkBundle;

  /**
   * Env vars the running container needs in order to reach this
   * destination. Typically one var per sink instance (the URL or
   * token). The bundle generator uses `envVarValue` to populate them
   * at deploy time.
   */
  runtimeEnvVars(input: {
    config: TConfig;
    envVarName: string;
    displayName: string;
  }): EnvVarSpec[];

  /**
   * Returns the value the bundle should set for the env var. For
   * webhook this is the URL; for Slack the incoming-webhook URL.
   * Returning a value here means the bundle UI can fill the
   * `docker run -e` flag with the actual secret rather than a
   * placeholder, since the user already provided it.
   */
  envVarValue(config: TConfig, envVarName: string): string;
}

export class DestinationError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "DestinationError";
  }
}
