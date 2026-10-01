import { canonicalConfigJson,exportDeploymentManifest,type GenerateInput,type SecretVersioner } from "@logtura/core";

/** OAuth versions identify the owner's grant, not renewable access tokens or
 * runtime broker envelopes. Explicit credential changes rotate this identity.
 * Other secret references retain the public library's payload-based versions. */
export async function exportHostedManifest(input:GenerateInput,credentialVersions:Map<string,string>,versioner:SecretVersioner){
  const shape=await exportDeploymentManifest(input,async()=>"shape");
  const identities=new Map<string,string>();
  for(const [index,c] of input.connections.entries()){
    if((c.connection.provider==="supabase-edge-logs" || c.connection.provider==="railway-logs") && typeof c.credentials?.refreshToken==="string"){
      const identity=credentialVersions.get(c.connection.id);
      if(!identity)throw new Error("Missing stored OAuth credential identity");
      identities.set(shape.document.connections[index]!.credentials!.env,canonicalConfigJson({credentialIntent:identity}));
    }
  }
  return exportDeploymentManifest(input,(name,value)=>versioner(name,identities.get(name)??value));
}
