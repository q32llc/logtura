import type {LogturaServiceClient,ServiceJob} from "@logtura/core";

export async function redeployHostedDeployment(client:LogturaServiceClient,deploymentId:string,options:{targetId?:string;region?:string;waitMs?:number;pollMs?:number;sleep?:(ms:number)=>Promise<void>;now?:()=>number}={}):Promise<{targetId:string;deduped:boolean;job:ServiceJob}>{
  const exported=await client.pullDeploymentConfig(deploymentId);
  if(!exported.target)throw new Error("Hosted deployment has no deploy target");
  const targets=(await client.listDeployTargets()).filter(target=>target.kind===exported.target!.kind);
  let target;
  if(options.targetId){
    target=targets.find(candidate=>candidate.id===options.targetId);
    if(!target)throw new Error("Deploy target does not match the hosted deployment");
  }else{
    const personal=targets.filter(candidate=>candidate.externalAccountId==="personal");
    if(personal.length===1)target=personal[0];
    else if(targets.length===1)target=targets[0];
    else throw new Error(targets.length?"Multiple deploy targets match; pass --target":"No connected deploy target matches this deployment");
  }
  if(!target)throw new Error("No connected deploy target matches this deployment");
  const started=await client.deployDeployment(deploymentId,{deployTargetId:target.id,...(options.region?{region:options.region}:{})});
  const waitMs=options.waitMs??600_000;
  if(!Number.isSafeInteger(waitMs) || waitMs<0 || waitMs>3_600_000)throw new Error("Invalid redeploy wait interval");
  if(waitMs===0)return {targetId:target.id,...started};
  const sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms))),now=options.now??Date.now,deadline=now()+waitMs,pollMs=options.pollMs??2000;
  let job=started.job;
  while(job.status==="queued" || job.status==="running"){
    if(now()>=deadline)throw new Error(`Redeploy ${job.id} is still ${job.status}`);
    await sleep(Math.min(pollMs,Math.max(0,deadline-now())));
    job=await client.getJob(job.id);
  }
  if(job.status==="failed")throw new Error(job.error ? `Redeploy failed: ${job.error}` : "Redeploy failed");
  return {targetId:target.id,deduped:started.deduped,job};
}
