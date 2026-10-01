import type { ApiDeployment } from "./types";
export function deploymentSourceSummary(deployment:Pick<ApiDeployment,"graphSelection"|"sourceIds">):string{
  const graph=deployment.graphSelection;
  if(graph && !graph.legacySources){
    const all=graph.connections.filter(c=>c.selectAll).length,explicit=graph.connections.filter(c=>!c.selectAll).reduce((count,c)=>count+c.sourceIds.length,0);
    if(all>0)return `All current and future sources from ${all} connection${all===1?"":"s"}${explicit>0?`, plus ${explicit} selected`:""}`;
    return `${explicit} selected source${explicit===1?"":"s"}`;
  }
  if(deployment.sourceIds===null)return "All discovered sources from the connection";
  return `${deployment.sourceIds.length} selected source${deployment.sourceIds.length===1?"":"s"}`;
}
