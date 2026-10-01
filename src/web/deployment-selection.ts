import type { ApiDeployment } from "./types";
export function deploymentSourceSummary(deployment:Pick<ApiDeployment,"graphSelection"|"sourceIds">):string{
  const graph=deployment.graphSelection;
  if(graph && !graph.legacySources){
    const all=graph.connections.filter(c=>c.selectAll).length,discovered=graph.connections.filter(c=>c.discoverSources).length,explicit=graph.connections.filter(c=>!c.selectAll && !c.discoverSources).reduce((count,c)=>count+c.sourceIds.length,0);
    const modes:string[]=[];
    if(all>0)modes.push(`All current and future sources from ${all} connection${all===1?"":"s"}`);
    if(discovered>0)modes.push(`All discovered sources on refresh from ${discovered} connection${discovered===1?"":"s"}`);
    if(modes.length)return `${modes.join(", plus ")}${explicit>0?`, plus ${explicit} selected`:""}`;
    return `${explicit} selected source${explicit===1?"":"s"}`;
  }
  if(deployment.sourceIds===null)return "All discovered sources from the connection";
  return `${deployment.sourceIds.length} selected source${deployment.sourceIds.length===1?"":"s"}`;
}
