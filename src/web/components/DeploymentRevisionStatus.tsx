import { useEffect,useState } from "react";
import { Alert,Badge,Button,Card,Group,Loader,Stack,Text } from "@mantine/core";
import type { DeploymentConfigurationState } from "@logtura/core";
import { api } from "../api";
export function revisionStatus(state:DeploymentConfigurationState):{label:string;color:string;description:string}{
 if(state.stale)return {label:"Configuration changed",color:"orange",description:"Configuration changed since the last recorded revision. Sync before updating the forwarder."};
 if(!state.activeInstanceId || state.lastReportSequence===0 || !state.applied)return {label:"Waiting for forwarder",color:"yellow",description:"The current forwarder has not reported its loaded configuration."};
 if(state.applied.sequence<state.desired.sequence)return {label:"Update pending",color:"orange",description:"The forwarder reports an older configuration than the desired revision."};
 return {label:"In sync",color:"teal",description:"The current forwarder reports the desired configuration."};
}
function reportTime(at:number):string {const date=new Date(at);return Number.isFinite(date.getTime())?date.toLocaleString():"Unknown time";}
/** Separate status failures from the rest of the deployment page. No polling:
 * refresh after a website save or explicitly after an external CLI update. */
export function DeploymentRevisionStatus({deploymentId,refreshKey=0}:{deploymentId:string;refreshKey?:number}){
 const [retry,setRetry]=useState(0),[result,setResult]=useState<{key:string;state:DeploymentConfigurationState|null;failed:boolean}|null>(null);
 const key=JSON.stringify([deploymentId,refreshKey,retry]);
 useEffect(()=>{
  let active=true;
  api.getDeploymentConfigurationState(deploymentId).then(state=>{if(active)setResult({key,state,failed:false});}).catch(()=>{if(active)setResult({key,state:null,failed:true});});
  return ()=>{active=false;};
 },[deploymentId,key]);
 const loading=result?.key!==key,state=loading?null:result.state,failed=loading?false:result.failed;
 const status=state?revisionStatus(state):null;
 return <Card withBorder mb="md" component="section" aria-label="Configuration revisions">
  <Group justify="space-between" mb="xs"><Text fw={600}>Configuration revisions</Text><Button size="xs" variant="subtle" disabled={loading} onClick={()=>setRetry(n=>n+1)}>Refresh configuration status</Button></Group>
  {loading?<Group><Loader size="xs" aria-label="Loading configuration status"/><Text size="sm">Loading configuration status…</Text></Group>:failed?<Alert color="orange">Configuration status unavailable. Refresh to try again.</Alert>:state?<Stack gap="xs">
   <Badge color={status!.color} w="fit-content">{status!.label}</Badge><Text size="sm">{status!.description}</Text>
   <Text size="sm" title={state.desired.revision}>Desired revision #{state.desired.sequence} · {state.desired.revision.slice(7,19)}</Text>
   {state.applied?<><Text size="sm" title={state.applied.revision}>Last applied revision #{state.applied.sequence} · {state.applied.revision.slice(7,19)}</Text><Text size="xs" c="dimmed">Reported {reportTime(state.applied.at)}</Text></>:<Text size="sm" c="dimmed">Applied revision: not reported</Text>}
  </Stack>:<Text size="sm" c="dimmed">No configuration revision has been recorded for this deployment.</Text>}
 </Card>;
}
