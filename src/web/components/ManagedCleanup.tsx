import {useEffect,useRef,useState} from "react";
import {Alert,Button,Checkbox,Stack,Text} from "@mantine/core";
import {api} from "../api";
import type {ApiJob,ApiManagedCleanupState} from "../types";
/** An explicit irreversible owner decision; private provider plans stay server-side. */
export function ManagedCleanup({deploymentId,targetId,job,onJob,onPending}:{deploymentId:string;targetId:string;job:ApiJob|null;onJob:(job:ApiJob)=>void;onPending:(pending:boolean)=>void}){
 const [state,setState]=useState<ApiManagedCleanupState|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false),inFlight=useRef(false);
 useEffect(()=>{
  let cancelled=false;api.getManagedCleanup(deploymentId).then(value=>{if(!cancelled){setState(value);onPending(value.cleanup?.status==="pending");setError(null);setConfirmed(false);}}).catch(()=>{if(!cancelled){setError("Retained machine status unavailable. Refresh to try again.");onPending(true);}});return()=>{cancelled=true;};
 },[deploymentId,job?.id,job?.status,onPending]);
 async function retire(){
  if(inFlight.current || !state?.availableReplacementId || !(confirmed || state.cleanup?.status==="pending"))return;
  inFlight.current=true;setBusy(true);setError(null);
  try{
   const current=await api.getManagedCleanup(deploymentId);
   if(current.availableReplacementId!==state.availableReplacementId){setState(current);setConfirmed(false);setError("Replacement changed. Review the retained machine before removing it.");return;}
   const result=await api.retireManagedForwarder(deploymentId,{replacementId:current.availableReplacementId,configurationVersion:current.configurationVersion,deployTargetId:targetId,confirmRetirement:true});onPending(true);onJob(result.job);
  }catch{setError("Could not start machine removal. Refresh and try again.");}finally{inFlight.current=false;setBusy(false);}
 }
 if(!state?.availableReplacementId && !state?.cleanup && !error)return null;
 const pending=state?.cleanup?.status==="pending",running=job?.status==="queued" || job?.status==="running";
 return <Stack gap="xs">
  {error && <Alert color="red">{error}</Alert>}
  {state?.cleanup?.status==="completed" && !state.availableReplacementId?<Alert color="blue">Retained machine removed. The surviving forwarder and checkpoint storage are preserved.</Alert>:<>
   <Text size="sm">Permanently remove the retained stopped machine. This cannot be undone. The surviving forwarder and checkpoint storage stay in place.</Text>
   {pending?<Text size="sm">Machine removal is pending. Deployment and restoration are blocked until its outcome is confirmed. Retry observes the saved decision.</Text>:state?.availableReplacementId && <Checkbox checked={confirmed} onChange={event=>setConfirmed(event.currentTarget.checked)} label="I understand that the retained machine will be permanently deleted."/>}
   {state?.availableReplacementId && <Button color="red" variant="outline" loading={busy} disabled={busy || running || (!confirmed && !pending)} onClick={()=>void retire()}>{pending?"Observe machine removal":"Remove retained machine"}</Button>}
  </>}
 </Stack>;
}
