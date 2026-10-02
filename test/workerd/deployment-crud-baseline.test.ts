import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { expect,it } from "vitest";
import worker from "../../src/index";
import { createConnection,createDeployment,createDestination,getDeployment,createMonitor,upsertSources,updateDeployment } from "../../src/db";
import { readConfigurationVersion } from "../../src/config-version";
import { JobDriver,RUNNING_JOB_STALE_MS } from "../../src/jobs/driver";
import { lockKeyForFlyDeploy } from "../../src/jobs/types";
import { getProvider,getProviderConnect,listProviders } from "../../src/providers";
import { getDestinationDriver,getDestinationConnect,listDestinationDrivers,listDestinationDriversForFlow } from "../../src/destinations";
import { getDeployTargetDriver,listDeployTargetDrivers } from "../../src/deploy-targets";
import { seedUser,seedDeployTarget } from "./_setup";
async function request(path:string,cookie?:string,method="GET",body?:unknown,raw=false){const context=createExecutionContext();const response=await worker.fetch(new Request(`http://localhost/api${path}`,{method,headers:{...(cookie?{cookie}:{}),...(body!==undefined?{"content-type":"application/json"}:{})},body:body===undefined?undefined:raw?String(body):JSON.stringify(body)}),env,context);await waitOnExecutionContext(context);return response;}
async function fixture(kind="fly"){
 const user=await seedUser(),connection=await createConnection(env.DB,env,{userId:user.userId,provider:"cloudflare-worker-tail",displayName:"Account",externalAccountId:"account",credentials:{apiToken:"private-fixture"}});
 await upsertSources(env.DB,connection.id,[{sourceKind:"worker",externalId:"site",displayName:"Site",metadata:null}]);
 const monitor=await createMonitor(env.DB,{userId:user.userId,connectionId:connection.id,displayName:"Errors",filterSteps:[{kind:"errors"}]});
 const deployment=await createDeployment(env.DB,{userId:user.userId,connectionId:connection.id,displayName:"Forwarder",targetKind:kind,managed:kind==="fly"});
 const target=await seedDeployTarget({userId:user.userId,kind,displayName:"Bootstrap",externalAccountId:"account",credentials:{apiToken:"private-bootstrap"}});
 await env.DB.prepare("UPDATE deployments SET bundle_outdated=0 WHERE id=?").bind(deployment.id).run();return {...user,connection,monitor,deployment,target};
}
it("looks up only registered own driver/connect IDs, including prototype-shaped input",async()=>{
 for(const id of ["constructor","toString","__proto__","hasOwnProperty","missing"]){expect(getProvider(id)).toBeNull();expect(getProviderConnect(id)).toBeNull();expect(getDestinationDriver(id)).toBeNull();expect(getDestinationConnect(id)).toBeNull();expect(getDeployTargetDriver(id)).toBeNull();}
 for(const driver of listProviders()){expect(getProvider(driver.id)).toBe(driver);expect(getProviderConnect(driver.id)?.driverId).toBe(driver.id);}
 for(const driver of listDestinationDrivers()){expect(getDestinationDriver(driver.id)).toBe(driver);expect(getDestinationConnect(driver.id)?.driverId).toBe(driver.id);}
 for(const driver of listDeployTargetDrivers())expect(getDeployTargetDriver(driver.id)).toBe(driver);
 for(const flow of ["logs","metrics"] as const)expect(listDestinationDriversForFlow(flow).every(driver=>driver.flows.includes(flow))).toBe(true);
 const own=await fixture();expect(await (await request("/deployments",own.sessionCookie,"POST",{connectionId:own.connection.id,displayName:"Invalid",targetKind:"constructor"})).json()).toEqual({error:"unknown_target"});
 for(const path of ["/connections","/destinations"]){const context=createExecutionContext();const form=new FormData();form.set(path==="/connections"?"provider":"kind","constructor");form.set("display_name","Invalid");const response=await worker.fetch(new Request(`http://localhost/api${path}`,{method:"POST",headers:{cookie:own.sessionCookie},body:form}),env,context);await waitOnExecutionContext(context);expect(response.status).toBe(400);}
});
it("creates default and explicit deployments, lists owned anchors and returns private-free bootstrap metadata",async()=>{
 const own=await fixture(),foreign=await fixture();
 let response=await request("/deployments",own.sessionCookie,"POST",{connectionId:own.connection.id,displayName:"Manual",targetKind:"other"});expect(response.status).toBe(200);const created=(await response.json() as any).deployment;expect(created).toMatchObject({managed:false,sourceIds:null,monitorIds:null,heartbeatTarget:"logtura",status:"pending"});
 response=await request("/deployments",own.sessionCookie,"POST",{connectionId:own.connection.id,displayName:"Explicit",targetKind:"fly",managed:true,sourceIds:[],monitorIds:[],heartbeatTarget:"none"});expect((await response.json() as any).deployment).toMatchObject({managed:true,sourceIds:[],monitorIds:[],heartbeatTarget:"none"});
 const all=await (await request("/deployments",own.sessionCookie)).json() as any;expect(all.deployments).toHaveLength(3);expect(JSON.stringify(all)).not.toContain(foreign.deployment.id);expect(JSON.stringify(all)).not.toContain("heartbeat_token");
 const anchored=await (await request(`/connections/${own.connection.id}/deployments`,own.sessionCookie)).json() as any;expect(anchored.deployments).toHaveLength(3);expect(await (await request(`/connections/${foreign.connection.id}/deployments`,own.sessionCookie)).json()).toEqual({deployments:[]});
 const targets=await (await request("/deploy-targets",own.sessionCookie)).json() as any;expect(targets.deployTargets[0].mintsForProviders).toEqual(["fly-log-tail"]);expect(JSON.stringify(targets)).not.toContain("private-bootstrap");
 await seedDeployTarget({userId:own.userId,kind:"unknown-legacy",displayName:"Legacy",externalAccountId:null,credentials:{}});const withLegacy=await (await request("/deploy-targets",own.sessionCookie)).json() as any;expect(withLegacy.deployTargets.find((target:any)=>target.kind==="unknown-legacy").mintsForProviders).toEqual([]);
 const detail=await (await request(`/deployments/${created.id}`,own.sessionCookie)).json() as any;expect(detail.connections.map((connection:any)=>connection.id)).toEqual([own.connection.id]);
 expect((await request(`/deployments/${created.id}`,own.sessionCookie,"DELETE")).status).toBe(200);expect(await getDeployment(env.DB,own.userId,created.id)).toBeNull();
});
it("updates configuration and bookkeeping separately, preserving null and empty selectors",async()=>{
 const own=await fixture(),foreign=await fixture();
 const metrics=await createDestination(env.DB,env,{userId:own.userId,kind:"prometheus_remote_write",displayName:"Metrics",config:{url:"https://metrics.test"}});
 const version=await readConfigurationVersion(env.DB,own.userId);
 let response=await request(`/deployments/${own.deployment.id}`,own.sessionCookie,"PUT",{displayName:"Updated",managed:false,sourceIds:[],monitorIds:[],heartbeatTarget:"none",metricsTarget:metrics.id});expect(response.status).toBe(200);expect((await response.json() as any).deployment).toMatchObject({displayName:"Updated",managed:false,sourceIds:[],monitorIds:[],metricsTarget:metrics.id});expect(await readConfigurationVersion(env.DB,own.userId)).toBeGreaterThan(version);
 expect((await getDeployment(env.DB,foreign.userId,foreign.deployment.id))!.bundle_outdated).toBe(0);
 response=await request(`/deployments/${own.deployment.id}/mark-deployed`,own.sessionCookie,"POST");expect((await response.json() as any).deployment.bundleOutdated).toBe(false);
 response=await request(`/deployments/${own.deployment.id}`,own.sessionCookie,"PUT",{status:"running",externalId:"fly:fixture:abc123"});expect((await response.json() as any).deployment).toMatchObject({status:"running",externalId:"fly:fixture:abc123",bundleOutdated:false});
 for(const patch of [{sourceIds:null,monitorIds:null,heartbeatTarget:null,metricsTarget:null,externalId:null},{metricsTarget:"none"},{metricsTarget:"logtura"},{managed:true},{}])expect((await request(`/deployments/${own.deployment.id}`,own.sessionCookie,"PUT",patch)).status).toBe(200);
});
it("rejects missing fields, unowned anchors and malformed deployment mutations without writing",async()=>{
 const own=await fixture(),foreign=await fixture();
 for(const body of [{},{connectionId:own.connection.id},{connectionId:own.connection.id,displayName:"Missing target"}])expect(await (await request("/deployments",own.sessionCookie,"POST",body)).json()).toEqual({error:"missing_fields"});
 expect(await (await request("/deployments",own.sessionCookie,"POST",{connectionId:foreign.connection.id,displayName:"Bad",targetKind:"other"})).json()).toEqual({error:"connection_not_found"});
 expect(await (await request("/deployments",own.sessionCookie,"POST",{connectionId:own.connection.id,displayName:"Bad",targetKind:"missing"})).json()).toEqual({error:"unknown_target"});
 const version=await readConfigurationVersion(env.DB,own.userId);
 const invalid=[null,[],42,{unexpected:"private"},{displayName:""},{displayName:42},{managed:1},{sourceIds:{}},{sourceIds:[42]},{sourceIds:[""]},{sourceIds:["same","same"]},{monitorIds:42},{heartbeatTarget:"unknown"},{metricsTarget:42},{metricsTarget:""},{status:"unknown"},{status:42},{externalId:42}];
 for(const body of invalid)expect((await request(`/deployments/${own.deployment.id}`,own.sessionCookie,"PUT",body)).status).toBe(400);
 for(const body of [null,[],42,{connectionId:own.connection.id,displayName:"Bad",targetKind:"BAD"},{connectionId:42,displayName:"Bad",targetKind:"fly"}])expect((await request("/deployments",own.sessionCookie,"POST",body)).status).toBe(400);
 for(const [path,method] of [["/deployments","POST"],[`/deployments/${own.deployment.id}`,"PUT"]])expect((await request(path!,own.sessionCookie,method,"{private-invalid-json",true)).status).toBe(400);
 expect(await readConfigurationVersion(env.DB,own.userId)).toBe(version);expect((await getDeployment(env.DB,own.userId,own.deployment.id))!.display_name).toBe("Forwarder");
 for(const id of [foreign.deployment.id,"dep_missing"]){expect((await request(`/deployments/${id}`,own.sessionCookie)).status).toBe(404);expect((await request(`/deployments/${id}`,own.sessionCookie,"PUT",{})).status).toBe(404);expect((await request(`/deployments/${id}/mark-deployed`,own.sessionCookie,"POST")).status).toBe(404);expect((await request(`/deployments/${id}/deploy`,own.sessionCookie,"POST",{})).status).toBe(404);expect((await request(`/deployments/${id}`,own.sessionCookie,"DELETE")).status).toBe(200);}
 expect(await getDeployment(env.DB,foreign.userId,foreign.deployment.id)).toBeTruthy();
});
it("checks metrics destinations for ownership and metrics capability",async()=>{
 const own=await fixture(),foreign=await fixture();
 const foreignDestination=await createDestination(env.DB,env,{userId:foreign.userId,kind:"prometheus_remote_write",displayName:"Foreign",config:{url:"https://metrics.test"}});
 const logs=await createDestination(env.DB,env,{userId:own.userId,kind:"webhook",displayName:"Logs",config:{url:"https://logs.test"}}),unknown=await createDestination(env.DB,env,{userId:own.userId,kind:"unknown",displayName:"Unknown",config:{}});
 for(const id of [foreignDestination.id,"dst_missing"])expect(await (await request(`/deployments/${own.deployment.id}`,own.sessionCookie,"PUT",{metricsTarget:id})).json()).toEqual({error:"metrics_target_not_found"});
 for(const destination of [logs,unknown])expect(await (await request(`/deployments/${own.deployment.id}`,own.sessionCookie,"PUT",{metricsTarget:destination.id})).json()).toEqual({error:"metrics_target_flow_mismatch",kind:destination.kind});
});
it("enqueues and deduplicates only compatible managed deploy requests",async()=>{
 const own=await fixture(),foreign=await fixture(),other=await fixture("other");
 for(const body of [{},{deployTargetId:42},{deployTargetId:""},{deployTargetId:own.target.id,region:42},{deployTargetId:own.target.id,region:"BAD"},{deployTargetId:own.target.id,region:"long"},{deployTargetId:own.target.id,unknown:true},null])expect((await request(`/deployments/${own.deployment.id}/deploy`,own.sessionCookie,"POST",body)).status).toBe(400);
 expect((await request(`/deployments/${own.deployment.id}/deploy`,own.sessionCookie,"POST","{invalid",true)).status).toBe(400);
 for(const deployTargetId of [foreign.target.id,"target_missing"])expect((await request(`/deployments/${own.deployment.id}/deploy`,own.sessionCookie,"POST",{deployTargetId})).status).toBe(404);
 expect((await request(`/deployments/${own.deployment.id}/deploy`,own.sessionCookie,"POST",{deployTargetId:other.target.id})).status).toBe(404);
 const mismatched=await seedDeployTarget({userId:own.userId,kind:"other",displayName:"Other",externalAccountId:null,credentials:{}});expect((await request(`/deployments/${own.deployment.id}/deploy`,own.sessionCookie,"POST",{deployTargetId:mismatched.id})).status).toBe(400);
 expect(await (await request(`/deployments/${other.deployment.id}/deploy`,other.sessionCookie,"POST",{deployTargetId:other.target.id})).json()).toEqual({error:"managed_deploy_unsupported"});
 await updateDeployment(env.DB,own.userId,own.deployment.id,{status:"stopped"});
 const first=await (await request(`/deployments/${own.deployment.id}/deploy`,own.sessionCookie,"POST",{deployTargetId:own.target.id,region:"ord"})).json() as any;expect(first.deduped).toBe(false);expect(first.job.status).toBe("queued");expect((await getDeployment(env.DB,own.userId,own.deployment.id))!.status).toBe("pending");
 const second=await (await request(`/deployments/${own.deployment.id}/deploy`,own.sessionCookie,"POST",{deployTargetId:own.target.id})).json() as any;expect(second.deduped).toBe(true);expect(second.job.id).toBe(first.job.id);
});
it.each(["queued","running","succeeded","failed","stale"])("rehydrates child-chain job state without rewriting persisted state (%s)",async state=>{
 const own=await fixture(),driver=new JobDriver(env.DB,env.JOBS_QUEUE as Queue);
 const parent=(await driver.enqueue({userId:own.userId,kind:"fly_deploy",payload:{private:"fixture-private-job"},lockKey:lockKeyForFlyDeploy(own.deployment.id)})).job;
 const parentClaim=(await driver.claim(parent.id))!;await driver.complete(parent.id,parentClaim.attemptId!,"succeeded",{});
 const kid=(await driver.enqueue({userId:own.userId,kind:"fly_deploy.wait_running",payload:{},parentJobId:parent.id})).job;
 if(state !== "queued"){const claimed=(await driver.claim(kid.id))!;await driver.setProgress(kid.id,claimed.attemptId!,{label:"Waiting",fraction:0.5});if(state === "succeeded")await driver.complete(kid.id,claimed.attemptId!,"succeeded",{result:{machineId:"abc"}});if(state === "failed")await driver.complete(kid.id,claimed.attemptId!,"failed",{error:"Provider refused"});if(state === "stale")await env.DB.prepare("UPDATE jobs SET last_heartbeat_at=? WHERE id=?").bind(Date.now()-RUNNING_JOB_STALE_MS-1000,kid.id).run();}
 const response=await request(`/jobs/${parent.id}`,own.sessionCookie);expect(response.status).toBe(200);const body=await response.json() as any;
 expect(body.job.status).toBe(state === "succeeded"?"succeeded":state === "failed"||state === "stale"?"failed":"running");expect(body.kids).toHaveLength(1);expect(JSON.stringify(body)).not.toContain("fixture-private-job");
 if(state === "succeeded")expect(body.job.result).toEqual({machineId:"abc"});if(state === "failed")expect(body.job.error).toBe("Provider refused");if(state === "stale")expect(body.job.error).toContain("appears stale");if(state !== "queued")expect(body.job.progress.label).toBe("Waiting");
 if(state === "running"||state === "queued"){const detail=await (await request(`/deployments/${own.deployment.id}`,own.sessionCookie)).json() as any;expect(detail.latestDeployJob.id).toBe(parent.id);expect(detail.latestDeployJob.status).toBe("running");}
 expect((await driver.getById(parent.id))!.status).toBe("succeeded");
});
it("shows stale standalone jobs as failed without persisting a fake terminal transition",async()=>{
 const own=await fixture(),foreign=await fixture(),driver=new JobDriver(env.DB,env.JOBS_QUEUE as Queue);
 const job=(await driver.enqueue({userId:own.userId,kind:"discovery",payload:{}})).job;
 expect((await (await request(`/jobs/${job.id}`,own.sessionCookie)).json() as any).job.status).toBe("queued");await driver.claim(job.id);
 await env.DB.prepare("UPDATE jobs SET last_heartbeat_at=? WHERE id=?").bind(Date.now()-RUNNING_JOB_STALE_MS-1000,job.id).run();
 const body=await (await request(`/jobs/${job.id}`,own.sessionCookie)).json() as any;expect(body.job.status).toBe("failed");expect(body.job.error).toContain("appears stale");expect(body.kids).toEqual([]);expect((await driver.getById(job.id))!.status).toBe("running");
 expect((await request(`/jobs/${job.id}`,foreign.sessionCookie)).status).toBe(404);expect((await request("/jobs/job_missing",own.sessionCookie)).status).toBe(404);
});
