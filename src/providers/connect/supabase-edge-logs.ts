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
        "Issue at supabase.com/dashboard/account/tokens. Supabase PATs are full-account scope. We'll show your projects after you submit so you can pick which one to forward logs from.",
      required: true,
    },
  ],
  parseFormData(form) {
    const pat = String(form.get("pat") ?? "").trim();
    if (!pat) throw new ProviderError("Missing pat", 400);
    // Project ref is picked on the connection detail page, not here.
    // One connection = one project; the picker shows every project
    // the PAT can see + each project's edge-function count.
    return {
      credentials: { pat },
      explicitAccountId: null,
    };
  },
};
