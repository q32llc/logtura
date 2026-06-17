export interface CloudflarePermissionGroup {
  key: string;
  type: "read" | "edit";
}

export interface SourceConnectMetadata {
  provider: string;
  /**
   * Opaque provider-owned metadata. The CLI does not interpret this
   * globally; it only passes metadata for source drivers that refer
   * to a provider into that provider connector. Cloudflare happens
   * to read `permissionGroups`, but other providers can define any
   * shape they want.
   */
  metadata?: Record<string, unknown>;
}

const SOURCE_METADATA: Record<string, SourceConnectMetadata> = {
  "cloudflare-worker-tail": {
    provider: "cloudflare",
    metadata: {
      permissionGroups: [
      { key: "workers_scripts", type: "read" },
      { key: "workers_tail", type: "read" },
      ],
    },
  },
  "cloudflare-ai-gateway": {
    provider: "cloudflare",
    metadata: {
      permissionGroups: [{ key: "ai_gateway", type: "read" }],
    },
  },
  "fly-log-tail": { provider: "fly" },
  "railway-logs": { provider: "railway" },
  "supabase-edge-logs": { provider: "supabase" },
  "vercel-logs": { provider: "vercel" },
};

export function sourceConnectMetadata(source: string): SourceConnectMetadata | null {
  return SOURCE_METADATA[source] ?? null;
}

export function allSourceConnectMetadata(): Record<string, SourceConnectMetadata> {
  return SOURCE_METADATA;
}
