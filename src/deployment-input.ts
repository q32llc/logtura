import { validateDeploymentTarget } from "@logtura/core";
import type { DeploymentStatus } from "./db";
export class DeploymentInputError extends Error {
 constructor(readonly code: "invalid_form" | "missing_fields" | "missing_deploy_target" = "invalid_form") {super(code);}
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
 if(!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key=>!keys.includes(key))) throw new DeploymentInputError();
 return value as Record<string,unknown>;
}
function text(value: unknown): string {if(typeof value !== "string" || !value.trim()) throw new DeploymentInputError();return value;}
function selection(value: unknown): string[] | null {
 if(value === null) return null;
 if(!Array.isArray(value) || value.some(id=>typeof id !== "string" || !id.trim()) || new Set(value).size !== value.length) throw new DeploymentInputError();
 return [...value] as string[];
}
export interface DeploymentMutation {
 displayName?: string;managed?: boolean;sourceIds?: string[] | null;monitorIds?: string[] | null;
 heartbeatTarget?: string | null;metricsTarget?: string | null;status?: DeploymentStatus;externalId?: string | null;
}
export function parseDeploymentMutation(value: unknown): DeploymentMutation {
 const row=object(value,["displayName","managed","sourceIds","monitorIds","heartbeatTarget","metricsTarget","status","externalId"]);
 const result: DeploymentMutation={};
 if(row.displayName !== undefined) result.displayName=text(row.displayName);
 if(row.managed !== undefined) {if(typeof row.managed !== "boolean") throw new DeploymentInputError();result.managed=row.managed;}
 for(const field of ["sourceIds","monitorIds"] as const) if(row[field] !== undefined) result[field]=selection(row[field]);
 if(row.heartbeatTarget !== undefined) {if(![null,"none","logtura"].includes(row.heartbeatTarget as string | null)) throw new DeploymentInputError();result.heartbeatTarget=row.heartbeatTarget as string | null;}
 if(row.metricsTarget !== undefined) result.metricsTarget=row.metricsTarget === null ? null : text(row.metricsTarget);
 if(row.status !== undefined) {if(!["pending","running","crashed","stopped","detached"].includes(row.status as string)) throw new DeploymentInputError();result.status=row.status as DeploymentStatus;}
 if(row.externalId !== undefined) {if(row.externalId !== null && typeof row.externalId !== "string") throw new DeploymentInputError();result.externalId=row.externalId as string | null;}
 return result;
}
export function parseDeploymentCreation(value: unknown): DeploymentMutation & {connectionId:string;displayName:string;targetKind:string} {
 const row=object(value,["connectionId","displayName","targetKind","managed","sourceIds","monitorIds","heartbeatTarget"]);
 if(row.connectionId === undefined || row.displayName === undefined || row.targetKind === undefined) throw new DeploymentInputError("missing_fields");
 const {connectionId,targetKind,...mutation}=row;
 const result=parseDeploymentMutation(mutation);
 const kind=text(targetKind);
 try {validateDeploymentTarget({kind,managed:result.managed ?? false,imageDigest:null,fly:null});} catch {throw new DeploymentInputError();}
 return {...result,connectionId:text(connectionId),displayName:text(row.displayName),targetKind:kind};
}
export function parseManagedDeployInput(value: unknown): {deployTargetId:string;region?:string} {
 const row=object(value,["deployTargetId","region"]);
 if(row.deployTargetId === undefined) throw new DeploymentInputError("missing_deploy_target");
 const result={deployTargetId:text(row.deployTargetId),...(row.region === undefined ? {} : {region:text(row.region)})};
 try {validateDeploymentTarget({kind:"fly",managed:true,imageDigest:null,fly:{appName:"validation",...(result.region === undefined ? {} : {region:result.region})}});} catch {throw new DeploymentInputError();}
 return result;
}
