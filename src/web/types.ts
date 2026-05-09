// API response shapes — mirrors what src/index.ts emits. Kept as plain
// types so both the worker and the React app can import them.

export interface ApiUser {
  id: string;
  githubLogin: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface ApiConnection {
  id: string;
  provider: string;
  displayName: string;
  externalAccountId: string | null;
  createdAt: number;
  updatedAt: number;
  lastDiscoveredAt: number | null;
}

export interface ApiSource {
  id: string;
  sourceKind: string;
  sourceKindLabel: string;
  externalId: string;
  displayName: string;
  metadata: Record<string, unknown> | null;
  selected: boolean;
  discoveredAt: number;
}

export interface ApiFormField {
  name: string;
  label: string;
  type: "text" | "password";
  placeholder?: string;
  description?: string;
  required: boolean;
}

export type ApiConnectFlow =
  | {
      kind: "external_token";
      url: string;
      buttonLabel: string;
      buttonDescription: string;
      pasteFieldName: string;
      manualInstructions?: string;
    }
  | {
      kind: "oauth_redirect";
      startPath: string;
      buttonLabel: string;
      buttonDescription: string;
    };

export interface ApiProvider {
  id: string;
  displayName: string;
  connectFlow: ApiConnectFlow | null;
  formFields: ApiFormField[];
}

export interface ApiEnvVar {
  name: string;
  description: string;
  source: "credential" | "external_account_id" | "destination" | "manual";
  credentialPath?: string;
}

export interface ApiBundle {
  vectorYaml: string;
  dockerfile: string;
  runCommand: string;
  envVars: ApiEnvVar[];
  selectedCount: number;
}
