/**
 * SaaS-side connect-UX adapter contract.
 *
 * The OSS provider driver (@logtura/core's `ProviderDriver`) only
 * carries the pieces that turn credentials into a Vector config
 * (renderer + API client). Web-shaped UX bits — what button to
 * show, what form to render, how to coerce browser FormData into a
 * credential — live in this adapter, which is SaaS-only and never
 * imported by any driver package. That keeps the OSS surface
 * narrow enough for outside contributors to ship driver PRs
 * without touching SaaS routing.
 */

/** UI form-field declaration. Lives here, not in @logtura/core,
 *  because nothing in the renderer cares about form schemas. */
export interface FormField {
  name: string;
  label: string;
  type: "text" | "password";
  placeholder?: string;
  description?: string;
  required?: boolean;
}

/** Discriminated union describing how the host should help the
 *  user mint / connect a credential. The host route layer
 *  switches on `kind` to render the right UI flow. */
export type ConnectFlow =
  | {
      kind: "external_token";
      url: string;
      buttonLabel: string;
      buttonDescription: string;
      pasteFieldName: string;
      manualInstructions?: string;
    }
  | {
      kind: "cli_session";
      startPath: string;
      pollPath: string;
      buttonLabel: string;
      buttonDescription: string;
    }
  | {
      kind: "oauth_redirect";
      startPath: string;
      buttonLabel: string;
      buttonDescription: string;
    };

/** Provider-side adapter. Per driver, the SaaS keeps one of these
 *  bound to the driver's `id`. */
export interface ProviderConnectAdapter<TCreds = unknown> {
  /** Matches a `ProviderDriver.id` from @logtura/core. */
  readonly driverId: string;
  readonly connectFlow?: ConnectFlow;
  readonly formFields: readonly FormField[];
  /** Coerce browser FormData into the credential shape the driver
   *  expects. Throws ProviderError on missing/invalid input. */
  parseFormData(form: FormData): {
    credentials: TCreds;
    explicitAccountId: string | null;
  };
}
