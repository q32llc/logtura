/**
 * SaaS-side connect-UX adapter for destination drivers. Mirror of
 * src/providers/connect/types.ts — keeps form / connect-flow / form
 * parsing out of the @logtura/destination-* packages.
 */
import type { ConnectFlow, FormField } from "../../providers/connect/types";

export type { ConnectFlow, FormField };

export interface DestinationConnectAdapter<TConfig = unknown> {
  /** Matches a `DestinationDriver.id` from @logtura/core. */
  readonly driverId: string;
  readonly connectFlow?: ConnectFlow;
  readonly formFields: readonly FormField[];
  /** Coerce browser FormData into the destination config the driver
   *  expects. Throws DestinationError on missing/invalid input. */
  parseFormData(form: FormData): { config: TConfig };
}
