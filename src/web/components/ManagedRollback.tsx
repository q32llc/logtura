import {useEffect,useRef,useState} from "react";
import {Alert,Button,Stack,Text} from "@mantine/core";
import {api} from "../api";
import type {ApiJob,ApiManagedRollbackState} from "../types";
/** Health of a restored legacy runtime cannot establish a portable revision. */
export function ManagedRollback({deploymentId,targetId,job,onJob,onPending}:{deploymentId:string;targetId:string;job:ApiJob|null;onJob:(job:ApiJob)=>void;onPending:(pending:boolean)=>void}){
 const [state,setState]=useState<ApiManagedRollbackState|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),inFlight=useRef(false);
 useEffect(()=>{
  let cancelled=false;
  api.getManagedRollback(deploymentId).then(value=>{if(!cancelled){setState(value);onPending(value.rollback?.status==="pending");setError(null);}}).catch(()=>{if(!cancelled)setError("Restoration status unavailable. Refresh to try again.");});
  return()=>{cancelled=true;};
 },[deploymentId,job?.id,job?.status,onPending]);
 async function restore(){
  if(inFlight.current || !state?.availableReplacementId)return;
  inFlight.current=true;setBusy(true);setError(null);
  try{
   const current=await api.getManagedRollback(deploymentId);
   if(current.availableReplacementId!==state.availableReplacementId){setState(current);setError("Replacement changed. Review the current forwarder before restoring.");return;}
   const result=await api.restoreManagedForwarder(deploymentId,{replacementId:current.availableReplacementId,configurationVersion:current.configurationVersion,deployTargetId:targetId});
   onPending(true);onJob(result.job);
  }catch{setError("Could not start restoration. Refresh and try again.");}
  finally{inFlight.current=false;setBusy(false);}
 }
 if(!state?.availableReplacementId && !state?.rollback && !error)return null;
 const running=job?.status==="queued" || job?.status==="running";
 return <Stack gap="xs">
  {error && <Alert color="red">{error}</Alert>}
  {state?.rollback?.status==="completed"?<Alert color="yellow">Previous forwarder restored. Its portable configuration revision is unknown.</Alert>:<>
   <Text size="sm">Restore the retained previous forwarder. The current forwarder will stop before the previous one starts. Both machines and the checkpoint are retained for recovery.</Text>
   {state?.rollback?.status==="pending" && <Text size="sm">Restoration is pending. The current instance can no longer report an applied revision.</Text>}
   {state?.availableReplacementId && <Button variant="default" loading={busy} disabled={busy || running} onClick={()=>void restore()}>{state.rollback?.status==="pending"?"Retry restoration":"Restore previous forwarder"}</Button>}
  </>}
 </Stack>;
}
