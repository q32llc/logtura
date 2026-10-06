import { PROVIDER_CATALOG } from "@logtura/core";
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

const SOURCE_METADATA: Record<string, SourceConnectMetadata> = Object.fromEntries(
  PROVIDER_CATALOG.filter(entry => entry.credentials.length > 0).map(entry => [entry.id, {
    provider: entry.family,
    ...(entry.connectMetadata ? { metadata: entry.connectMetadata } : {}),
  }]),
);

export function sourceConnectMetadata(source: string): SourceConnectMetadata | null {
  return SOURCE_METADATA[source] ?? null;
}

export function allSourceConnectMetadata(): Record<string, SourceConnectMetadata> {
  return SOURCE_METADATA;
}
