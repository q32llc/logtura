import { validateDeploymentConfigurationState,type DeploymentConfigurationState } from "@logtura/core";
import type {
  ApiBundle,
  ApiConnection,
  ApiDeployTarget,
  ApiDeployTargetDriver,
  ApiDeployment,
  ApiDestination,
  ApiDestinationDriver,
  ApiJob,
  ApiMonitor,
  ApiProvider,
  ApiSinkRecord,
  ApiSource,
  ApiTargetBundle,
  ApiUser,
  FilterStep,
} from "../web/types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(init?.body && !(init.body instanceof FormData)
        ? { "content-type": "application/json" }
        : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // ignore
  }
  if (!res.ok) {
    const data = json as { error?: string; message?: string } | null;
    throw new ApiError(
      data?.message ?? data?.error ?? `HTTP ${res.status}`,
      res.status,
      data?.error,
    );
  }
  return json as T;
}

export interface CliDevice {userCode: string;label: string;expiresAt: number;decision: "pending" | "approved" | "denied";scope: string;}
export interface CliAccountToken {id: string;label: string;created_at: number;expires_at: number;revoked_at: number | null;}

export const api = {
  getDeploymentConfigurationState: async(id:string):Promise<DeploymentConfigurationState|null> => {
    const result=await request<{state:unknown}>(`/deployments/${encodeURIComponent(id)}/config/state`,{signal:AbortSignal.timeout(20_000)});
    if(!result || typeof result!=="object" || Array.isArray(result) || Object.keys(result).some(key=>key!=="state") || !("state" in result))throw new ApiError("Invalid configuration status",200,"invalid_config_state");
    try{return result.state===null?null:await validateDeploymentConfigurationState(result.state);}catch{throw new ApiError("Invalid configuration status",200,"invalid_config_state");}
  },
  cliDevice: (code: string) => request<CliDevice>(`/cli/devices/${encodeURIComponent(code)}`),
  decideCliDevice: (code: string, approve: boolean) => request<{ok: boolean}>(`/cli/devices/${encodeURIComponent(code)}/decision`, {method: "POST",body: JSON.stringify({approve})}),
  cliTokens: () => request<{tokens: CliAccountToken[]}>("/cli/tokens"),
  revokeCliToken: (id: string) => request<{ok: boolean}>(`/cli/tokens/${encodeURIComponent(id)}`, {method: "DELETE"}),
  me: () => request<{ user: ApiUser | null }>("/me"),
  providers: () => request<{ providers: ApiProvider[] }>("/providers"),
  listConnections: () =>
    request<{ connections: ApiConnection[] }>("/connections"),
  getConnectionByProviderInstallation: (
    provider: string,
    providerInstallationId: string,
  ) =>
    request<{ connection: ApiConnection | null }>(
      `/connections/by-provider-installation?provider=${encodeURIComponent(provider)}&provider_installation_id=${encodeURIComponent(providerInstallationId)}`,
    ),
  createConnection: (form: FormData) =>
    request<{ connection: ApiConnection }>("/connections", {
      method: "POST",
      body: form,
    }),
  createConnectionFromBootstrap: (body: {
    deployTargetId: string;
    providerId: string;
    displayName: string;
    scope?: string;
  }) =>
    request<{ connection: ApiConnection }>("/connections/from-bootstrap", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  reconnectConnection: (id: string, form: FormData) =>
    request<{ connection: ApiConnection }>(
      `/connections/${id}/reconnect`,
      { method: "POST", body: form },
    ),
  getConnection: (id: string) =>
    request<{
      connection: ApiConnection;
      sources: ApiSource[];
      latestDiscoveryJob: ApiJob | null;
    }>(`/connections/${id}`),
  setSourceSelections: (id: string, selectedSourceIds: string[]) =>
    request<{ sources: ApiSource[] }>(`/connections/${id}/sources`, {
      method: "POST",
      body: JSON.stringify({ selectedSourceIds }),
    }),
  rediscover: (id: string) =>
    request<{ job: ApiJob; deduped: boolean }>(
      `/connections/${id}/discover`,
      { method: "POST" },
    ),
  listSupabaseProjects: (id: string) =>
    request<{
      projects: Array<{
        ref: string;
        name: string;
        organizationId: string | null;
        functionCount: number | null;
      }>;
    }>(`/connections/${id}/supabase-projects`),
  pickSupabaseProject: (id: string, projectRef: string) =>
    request<{ connection: ApiConnection }>(
      `/connections/${id}/supabase-pick-project`,
      {
        method: "POST",
        body: JSON.stringify({ projectRef }),
      },
    ),
  listRailwayEnvironments: (id: string) =>
    request<{
      projects: Array<{
        id: string;
        name: string;
        environments: Array<{
          id: string;
          name: string;
          serviceCount: number | null;
        }>;
      }>;
    }>(`/connections/${id}/railway-environments`),
  pickRailwayEnvironment: (
    id: string,
    input: { projectId: string; environmentId: string },
  ) =>
    request<{ connection: ApiConnection }>(
      `/connections/${id}/railway-pick-environment`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  getJob: (id: string) => request<{ job: ApiJob }>(`/jobs/${id}`),
  deleteConnection: (id: string) =>
    request<{ ok: true }>(`/connections/${id}`, { method: "DELETE" }),
  getBundle: (id: string) => request<ApiBundle>(`/connections/${id}/bundle`),
  /** Every source across every connection the user owns. Powers the
   *  deployment configure tab's cross-connection picker — UI groups
   *  by connection id, derives "this deployment uses these
   *  connections" from whatever's selected. */
  listAllSources: () =>
    request<{
      connections: Array<{
        id: string;
        displayName: string;
        provider: string;
        externalAccountId: string | null;
      }>;
      sources: Array<{
        id: string;
        connectionId: string;
        sourceKind: string;
        externalId: string;
        displayName: string;
      }>;
    }>("/sources"),

  // ----- Destinations / Monitors / Sinks ------------------------------
  destinationDrivers: () =>
    request<{ drivers: ApiDestinationDriver[] }>("/destinations/drivers"),
  listDestinations: () =>
    request<{ destinations: ApiDestination[] }>("/destinations"),
  createDestination: (form: FormData) =>
    request<{ destination: ApiDestination }>("/destinations", {
      method: "POST",
      body: form,
    }),
  deleteDestination: (id: string) =>
    request<{ ok: true }>(`/destinations/${id}`, { method: "DELETE" }),

  listMonitors: () =>
    request<{ monitors: ApiMonitor[]; sinks: ApiSinkRecord[] }>("/monitors"),
  createMonitor: (body: {
    displayName: string;
    filterSteps?: FilterStep[];
    connectionId?: string | null;
    enabled?: boolean;
  }) =>
    request<{ monitor: ApiMonitor }>("/monitors", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateMonitor: (
    id: string,
    body: {
      displayName?: string;
      filterSteps?: FilterStep[];
      connectionId?: string | null;
      enabled?: boolean;
    },
  ) =>
    request<{ monitor: ApiMonitor }>(`/monitors/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteMonitor: (id: string) =>
    request<{ ok: true }>(`/monitors/${id}`, { method: "DELETE" }),
  addSink: (
    monitorId: string,
    body: {
      destinationId: string;
      filterSteps?: FilterStep[];
    },
  ) =>
    request<{ sink: ApiSinkRecord }>(`/monitors/${monitorId}/sinks`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateSinkSteps: (id: string, filterSteps: FilterStep[]) =>
    request<{ ok: true }>(`/sinks/${id}`, {
      method: "PUT",
      body: JSON.stringify({ filterSteps }),
    }),
  deleteSink: (id: string) =>
    request<{ ok: true }>(`/sinks/${id}`, { method: "DELETE" }),

  // ----- Deploy targets ------------------------------------------------
  deployTargetDrivers: () =>
    request<{ drivers: ApiDeployTargetDriver[] }>("/deploy-targets/drivers"),
  listDeployTargets: () =>
    request<{ deployTargets: ApiDeployTarget[] }>("/deploy-targets"),
  flyConnectStart: () =>
    request<{ sessionId: string; authUrl: string }>(
      "/deploy-targets/fly/start",
      { method: "POST" },
    ),
  flyConnectPoll: (sessionId: string) =>
    request<
      | { status: "pending" }
      | {
          status: "connected";
          deployTargetId: string;
          displayName: string;
        }
    >(
      `/deploy-targets/fly/poll?session_id=${encodeURIComponent(sessionId)}`,
    ),

  // ----- Deployments ---------------------------------------------------
  listDeployments: () =>
    request<{ deployments: ApiDeployment[] }>("/deployments"),
  listDeploymentsForConnection: (connectionId: string) =>
    request<{ deployments: ApiDeployment[] }>(
      `/connections/${connectionId}/deployments`,
    ),
  getDeployment: (id: string) =>
    request<{
      deployment: ApiDeployment;
      latestDeployJob: ApiJob | null;
      connections: Array<{
        id: string;
        displayName: string;
        provider: string;
        externalAccountId: string | null;
      }>;
    }>(`/deployments/${id}`),
  createDeployment: (body: {
    connectionId: string;
    displayName: string;
    targetKind: string;
    managed?: boolean;
    sourceIds?: string[] | null;
    monitorIds?: string[] | null;
    heartbeatTarget?: string | null;
  }) =>
    request<{ deployment: ApiDeployment }>("/deployments", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateDeployment: (
    id: string,
    body: Partial<{
      displayName: string;
      managed: boolean;
      sourceIds: string[] | null;
      monitorIds: string[] | null;
      heartbeatTarget: string | null;
      metricsTarget: string | null;
      status: string;
      externalId: string | null;
    }>,
  ) =>
    request<{ deployment: ApiDeployment }>(`/deployments/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteDeployment: (id: string) =>
    request<{ ok: true }>(`/deployments/${id}`, { method: "DELETE" }),
  getDeploymentBundle: (
    deploymentId: string,
    target?: string,
    region?: string,
  ) => {
    const params = new URLSearchParams();
    if (target) params.set("target", target);
    if (region) params.set("region", region);
    const qs = params.toString();
    return request<ApiTargetBundle>(
      `/deployments/${deploymentId}/bundle${qs ? `?${qs}` : ""}`,
    );
  },
  deployNow: (
    deploymentId: string,
    body: { deployTargetId: string; region?: string },
  ) =>
    request<{ job: ApiJob; deduped: boolean }>(
      `/deployments/${deploymentId}/deploy`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  markDeploymentDeployed: (deploymentId: string) =>
    request<{ deployment: ApiDeployment | null }>(
      `/deployments/${deploymentId}/mark-deployed`,
      { method: "POST" },
    ),
  /** URL for the session-authed install bundle download. The browser
   *  hits it directly via an <a> tag with download attribute; no
   *  JSON wrapper. Returning the path lets the UI render the link. */
  installBundleUrl: (deploymentId: string) =>
    `/api/deployments/${deploymentId}/install-bundle.tgz`,
  /** Mint an HMAC-signed one-shot URL for the curl one-liner. Caller
   *  is expected to surface it within ~60s before it expires. */
  signInstallBundle: (deploymentId: string) =>
    request<{ url: string; expiresAt: number }>(
      `/deployments/${deploymentId}/install-bundle/sign`,
      { method: "POST" },
    ),
};
