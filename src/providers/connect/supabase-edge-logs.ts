/**
 * Connect-UX adapter for the `supabase-edge-logs` OSS driver.
 *
 * Supabase PATs are full-account and can't be scope-pre-selected
 * via URL params today, so the connect URL is the bare token page.
 * A future OAuth integration (Supabase's "Build a Supabase
 * Integration" program) would switch this to a kind: "oauth_redirect"
 * flow without touching the OSS driver.
 */
import { ProviderError } from "@logtura/core";
import type { SupabaseCredentials } from "@logtura/supabase-shared";
import type { ProviderConnectAdapter } from "./types";

const TOKEN_TEMPLATE_URL = "https://supabase.com/dashboard/account/tokens";

export const supabaseEdgeLogsConnect: ProviderConnectAdapter<SupabaseCredentials> = {
  driverId: "supabase-edge-logs",
  connectFlow: {
    kind: "external_token",
    url: TOKEN_TEMPLATE_URL,
    buttonLabel: "Open Supabase token page",
    buttonDescription:
      "Create a Personal Access Token at supabase.com/dashboard/account/tokens and paste it below. The token has full account scope — mint a fresh one specifically for log forwarding and revoke when done.",
    pasteFieldName: "pat",
    manualInstructions:
      "Tokens issued there are full-account; Supabase doesn't offer per-project PATs yet. Treat this token like a password.",
  },
  formFields: [
    {
      name: "pat",
      label: "Supabase Personal Access Token",
      type: "password",
      placeholder: "sbp_...",
      description:
        "Issue at supabase.com/dashboard/account/tokens. The token has full account scope — Supabase doesn't offer per-project PATs today, so prefer using a token created specifically for log-forwarding and revoke it when you're done.",
      required: true,
    },
    {
      name: "project_ref",
      label: "Project ref (optional)",
      type: "text",
      placeholder: "auto-detect from the first project the token can reach",
      description:
        "20-character lowercase id like `edzvfyvdtvwrnaoyupqq`. Leave blank to auto-pick the first project the token sees.",
      required: false,
    },
  ],
  parseFormData(form) {
    const pat = String(form.get("pat") ?? "").trim();
    const projectRef = String(form.get("project_ref") ?? "").trim();
    if (!pat) throw new ProviderError("Missing pat", 400);
    return {
      credentials: { pat },
      explicitAccountId: projectRef || null,
    };
  },
};
