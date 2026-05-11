/**
 * Re-exports the destination-driver contract from @logtura/core
 * so existing SaaS imports don't break.
 */
export type {
  DestinationDriver,
  DestinationFlow,
  SinkBundle,
} from "@logtura/core";

export { DestinationError } from "@logtura/core";

/** SinkBlock + PreSinkTransform aren't in the public @logtura/core
 *  surface (they're shape-equivalent to {key,yaml} pairs). Re-export
 *  inline types so existing SaaS code keeps compiling. */
export interface SinkBlock {
  key: string;
  yaml: string;
}
export interface PreSinkTransform {
  key: string;
  yaml: string;
}
