import type {
  ApiBundle,
  ApiConnection,
  ApiProvider,
  ApiSource,
  ApiUser,
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

export const api = {
  me: () => request<{ user: ApiUser | null }>("/me"),
  providers: () => request<{ providers: ApiProvider[] }>("/providers"),
  listConnections: () =>
    request<{ connections: ApiConnection[] }>("/connections"),
  createConnection: (form: FormData) =>
    request<{ connection: ApiConnection }>("/connections", {
      method: "POST",
      body: form,
    }),
  getConnection: (id: string) =>
    request<{ connection: ApiConnection; sources: ApiSource[] }>(
      `/connections/${id}`,
    ),
  setSourceSelections: (id: string, selectedSourceIds: string[]) =>
    request<{ sources: ApiSource[] }>(`/connections/${id}/sources`, {
      method: "POST",
      body: JSON.stringify({ selectedSourceIds }),
    }),
  rediscover: (id: string) =>
    request<{ sources: ApiSource[] }>(`/connections/${id}/discover`, {
      method: "POST",
    }),
  deleteConnection: (id: string) =>
    request<{ ok: true }>(`/connections/${id}`, { method: "DELETE" }),
  getBundle: (id: string) => request<ApiBundle>(`/connections/${id}/bundle`),
};
