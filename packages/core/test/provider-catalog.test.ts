import { expect, it } from "vitest";
import { PROVIDER_CATALOG, providerDescriptor, providerFamily, defaultSourceSelection, providerDefaultCredentials, decodeProviderCredentials, validateProviderCatalog } from "../src/provider-catalog";
import { parseConfigDocument, normalizeConfigDocument } from "../src/config";

it("keeps built-in credential refs, selections and optional overrides compatible", () => {
  validateProviderCatalog(PROVIDER_CATALOG);
  expect(providerDescriptor("unknown")).toBeNull(); expect(providerFamily("unknown")).toBeNull();
  expect(defaultSourceSelection("unknown")).toEqual({ sources: [] }); expect(providerDefaultCredentials("unknown")).toEqual({});
  expect(defaultSourceSelection("supabase-edge-logs")).toEqual({ functions: [], gateway: true });
  expect(providerDefaultCredentials("railway")).toEqual({ api_token: "env:RAILWAY_API_TOKEN" });
  expect(decodeProviderCredentials("railway", { credentials: { api_token: "secret", project_id: "p" } }, value => value)).toEqual({ apiToken: "secret", projectId: "p", environmentId: null });
  expect(decodeProviderCredentials("railway", { credentials: { project_id: "", environment_id: "" } }, value => value)).toEqual({ apiToken: "", projectId: "", environmentId: "" });
  expect(decodeProviderCredentials("fly", { api_token: "top" }, value => value)).toEqual({ apiToken: "top" });
  expect(decodeProviderCredentials("supabase", { credentials: [] }, value => value)).toEqual({ pat: "" });
  expect(decodeProviderCredentials("outside", { credentials: { custom: "ref" } }, value => `${value}-resolved`)).toEqual({ custom: "ref-resolved" });
  expect(decodeProviderCredentials("outside", {}, value => value)).toEqual({});
});
it("rejects ambiguous registrations and unusable credential fields", () => {
  const descriptor = PROVIDER_CATALOG[0]!;
  for (const id of ["Bad ID", descriptor.id]) {
    expect(() => validateProviderCatalog([descriptor, { ...descriptor, id }])).toThrow("provider id");
  }
  expect(() => validateProviderCatalog([{ ...descriptor, family: "" }])).toThrow("Incomplete");
  expect(() => validateProviderCatalog([descriptor, { ...descriptor, id: "new-source" }])).toThrow("alias");
  for (const credentials of [[{ config: "", runtime: "token" }], [{ config: "token", runtime: "" }], [{ config: "token", runtime: "token" }, { config: "token", runtime: "other" }]]) {
    expect(() => validateProviderCatalog([{ ...descriptor, credentials }])).toThrow("credential field");
  }
});
it.each(PROVIDER_CATALOG.filter(entry => entry.id !== "custom-vector"))("preserves legacy source alias identities for $id", descriptor => {
  const selection = descriptor.selection.codec === "railway" ? [{ id: "resource", environment_id: "production" }] : descriptor.selection.codec === "supabase" ? [{ slug: "resource", function_id: "fn" }] : ["resource"];
  const document = { providers: { account: { provider: descriptor.family, account_id: "account", credentials: Object.fromEntries(descriptor.credentials.map(field => [field.config, `env:${field.env ?? field.config}`])) } }, sources: { [descriptor.aliases[0]!]: { provider: "account", [descriptor.selection.field]: selection } } };
  const options = { env: Object.fromEntries(descriptor.credentials.map(field => [field.env ?? field.config, "fixture"])) };
  expect(parseConfigDocument(normalizeConfigDocument(document), options)).toEqual(parseConfigDocument(document, options));
});
it("retains Railway source overrides and Vercel personal/team account precedence", () => {
  const document = { providers: { r: { provider: "railway", credentials: { project_id: "parent", environment_id: "parent-env" } }, v: { provider: "vercel", account_id: "parent-team" } }, sources: { railway: { provider: "r", projectId: "child", environmentId: "child-env", services: ["service"] }, vercel: { provider: "v", teamId: "child-team", projects: ["project"] } } };
  const parsed = parseConfigDocument(document).input.connections;
  expect(parsed[0]!.credentials).toEqual({ apiToken: "", projectId: "child", environmentId: "child-env" });
  expect(parsed[0]!.connection.externalAccountId).toBe("child-env");
  expect(parsed[1]!.connection.externalAccountId).toBe("child-team");
});
