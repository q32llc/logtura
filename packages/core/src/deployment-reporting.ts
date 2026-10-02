import { normalizeServiceUrl,ServiceError } from "./service-client";
import { validateDeploymentAppliedReport,type DeploymentAppliedReport } from "./deployment-state";
/** Ingest-only transport. Account credentials are deliberately rejected. */
export class DeploymentReportingClient {
 readonly url:string;
 constructor(private readonly options:{url:string;token:string;fetch:typeof fetch}){
  this.url=normalizeServiceUrl(options.url);
  if(!options.token || /[\s\u0000-\u001f\u007f]/.test(options.token) || options.token.startsWith("lt_cli_"))throw new Error("Invalid deployment reporting token");
 }
 async reportApplied(deploymentId:string,value:DeploymentAppliedReport):Promise<boolean>{
  if(!deploymentId)throw new Error("Deployment identity is required");const report=validateDeploymentAppliedReport(value);
  const response=await this.options.fetch(`${this.url}/api/applied/${encodeURIComponent(deploymentId)}`,{method:"POST",headers:{accept:"application/json","content-type":"application/json",authorization:`Bearer ${this.options.token}`},body:JSON.stringify(report),redirect:"manual",credentials:"omit",signal:AbortSignal.timeout(20_000)});
  const body=await response.json().catch(()=>null) as {accepted?:unknown;error?:unknown}|null;
  if(!response.ok)throw new ServiceError(response.status,typeof body?.error==="string"?body.error:"request_failed");
  if(!body || typeof body!=="object" || Array.isArray(body) || Object.keys(body).some(key=>key!=="accepted") || typeof body.accepted!=="boolean")throw new ServiceError(200,"invalid_applied_response");
  return body.accepted;
 }
}
