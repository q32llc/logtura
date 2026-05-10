// Provider driver contract.
//
// Adding a new provider (e.g. Fly, AWS, Supabase) means implementing this
// interface in a new `src/providers/<name>.ts` file and registering it in
// `src/providers/index.ts`. No schema change, no route change, no view change.
//
// The driver owns:
//   1. Form fields shown to the user when adding a connection
//   2. Parsing those fields into the credential shape it stores
//   3. Verifying credentials against the upstream API
//   4. Discovering log sources for an authenticated account
//   5. Generating Vector source-block YAML for each selected source
//   6. Declaring runtime env vars and Dockerfile dependencies for the bundle

export interface ProviderAccount {
  id: string;
  name: string;
}

export interface DiscoveredSource {
  sourceKind: string; // namespaced per provider, e.g. "cf_worker", "fly_app"
  externalId: string;
  displayName: string;
  metadata?: Record<string, unknown>;
}

export interface FormField {
  name: string;
  label: string;
  type: "text" | "password";
  placeholder?: string;
  description?: string;
  required: boolean;
}

/**
 * How the user grants access to their provider account. Drivers declare
 * a `connectFlow` so the UI can render a "Connect with X" affordance
 * before the bare paste-a-credential form. Future providers with real
 * OAuth use kind="oauth_redirect"; providers without a public OAuth
 * server (Cloudflare today) use kind="external_token" pointing at a
 * prefilled token-creation page.
 */
export type ConnectFlow =
  | {
      kind: "external_token";
      /** Where to send the user to create the credential. */
      url: string;
      /** Primary button label, e.g. "Connect with Cloudflare". */
      buttonLabel: string;
      /** Short helper text shown under the button. */
      buttonDescription: string;
      /** Field name (in formFields) where the resulting token is pasted. */
      pasteFieldName: string;
      /** Optional manual instructions for users who'd rather DIY. */
      manualInstructions?: string;
    }
  | {
      kind: "oauth_redirect";
      /** logtura-side path that begins the OAuth flow. */
      startPath: string;
      buttonLabel: string;
      buttonDescription: string;
    };

export interface EnvVarSpec {
  name: string;
  description: string;
  // How the bundle generator should suggest a value to the user. We never
  // bake secrets into the image — these are placeholders shown in the
  // `docker run` command on the bundle page.
  source: "credential" | "external_account_id" | "destination" | "manual";
  // Optional path within the credentials JSON, e.g. "apiToken". Only
  // meaningful when source === "credential".
  credentialPath?: string;
  // Optional URL the user can visit to create a fresh value (e.g. a
  // Cloudflare token-template URL). Surfaced in the bundle UI as
  // "create a new one →" so credential rotation is one click.
  helpUrl?: string;
}

export interface DockerfileDep {
  // Bash snippet appended into a single RUN block in the generated
  // Dockerfile. Should be apt-get-friendly and idempotent.
  install: string;
  // apt packages required to support the install step (added to the
  // base apt-get install line).
  aptPackages?: string[];
}

export interface SourceBlock {
  // The Vector source key (must be a valid YAML key).
  key: string;
  // The YAML body for `sources.<key>:` (without the key itself).
  yaml: string;
  // Optional normalize transform applied immediately after the source.
  // Lets each provider flatten its native event shape into a uniform
  // one (.message, .level, .error, .script, .timestamp) so downstream
  // filters can be provider-agnostic. The transform's inputs is
  // implicit — the source's key. If present, downstream pipeline
  // reads from normalize.key instead of key.
  normalize?: { key: string; yaml: string };
}

// Minimal subset of ConnectionRow that drivers need. Avoids importing the
// DB layer into provider modules.
export interface ConnectionRef {
  id: string;
  externalAccountId: string | null;
  displayName: string;
}

// Minimal subset of LogSourceRow that drivers need.
export interface SourceRef {
  externalId: string;
  displayName: string;
  sourceKind: string;
  metadata: Record<string, unknown> | null;
}

export interface ProviderDriver<TCreds = unknown> {
  readonly id: string;
  readonly displayName: string;

  /**
   * Preferred way to grant access. The UI renders this as the primary
   * affordance; `formFields` show as the "alt" path or for the resulting
   * paste-back step.
   */
  readonly connectFlow?: ConnectFlow;

  /** Form fields rendered on the "Add connection" page. */
  readonly formFields: readonly FormField[];

  /**
   * Parse submitted form data into the credential shape (and optional
   * explicit account id). Throws if required fields are missing or
   * malformed.
   */
  parseFormData(form: FormData): {
    credentials: TCreds;
    explicitAccountId: string | null;
  };

  /** Verify credentials and return accessible accounts. */
  verifyCredentials(credentials: TCreds): Promise<ProviderAccount[]>;

  /**
   * Optional freshness check for stored credentials. Called at bundle
   * generation time so we don't inline a value that's actually
   * expired (which would be worse than no value — the user copies
   * something that fails when their container starts). When this
   * returns `fresh: false`, the bundle UI surfaces the help URL
   * prominently and treats the stored value as unusable. Drivers that
   * don't implement this are assumed to always be fresh.
   */
  checkCredentialFreshness?(credentials: TCreds): Promise<{
    fresh: boolean;
    reason?: string;
    /** ms epoch when the credential expires, if known. */
    expiresAt?: number | null;
  }>;

  /** Enumerate log sources for an authenticated account. */
  discoverSources(input: {
    credentials: TCreds;
    accountId: string;
  }): Promise<DiscoveredSource[]>;

  /**
   * Render a single Vector source block for a selected source. The bundle
   * generator concatenates these into the final `sources:` map.
   */
  generateSourceBlock(input: {
    source: SourceRef;
    connection: ConnectionRef;
  }): SourceBlock;

  /**
   * Runtime spec — env vars and Dockerfile install steps the bundle
   * needs in order to run. Per provider, not per source: if any source
   * for this provider is selected, all of these apply.
   */
  runtimeSpec(connection: ConnectionRef): {
    envVars: EnvVarSpec[];
    dockerfileDeps: DockerfileDep[];
  };

  /** Friendly label for a discovered source's kind. UI only. */
  sourceKindLabel(sourceKind: string): string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
