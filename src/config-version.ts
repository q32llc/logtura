import { newId } from "./crypto";

export class ConfigurationConflict extends Error {
  constructor(public readonly expectedVersion:number,public readonly currentVersion:number){super("Configuration changed; pull and reconcile before retrying");this.name="ConfigurationConflict";}
}
export async function readConfigurationVersion(db:D1Database,userId:string):Promise<number>{
  const row=await db.prepare("SELECT version FROM configuration_versions WHERE user_id=?").bind(userId).first<{version:number}>();
  if(!row)throw new Error("Configuration owner not found");return row.version;
}

/** The guard and all caller-prepared, ownership-checked graph mutations share a
 * D1 batch transaction. Website writes are tracked by SQL triggers too. This is
 * a storage primitive, not an authorization boundary or a SQL input endpoint. */
export async function commitConfiguration(db:D1Database,userId:string,expectedVersion:number,statements:D1PreparedStatement[]):Promise<{version:number;results:D1Result[]}>{
  if(!Number.isSafeInteger(expectedVersion) || expectedVersion<0)throw new Error("Invalid configuration version");
  const guardId=newId("cfg");
  let batch:D1Result[];
  try{
    batch=await db.batch([
      db.prepare("INSERT INTO configuration_write_guards(id,user_id,expected_version) VALUES (?,?,?)").bind(guardId,userId,expectedVersion),
      ...statements,
      db.prepare("SELECT version FROM configuration_versions WHERE user_id=?").bind(userId),
      db.prepare("DELETE FROM configuration_write_guards WHERE id=?").bind(guardId),
    ]);
  }catch(error){
    if(error instanceof Error && error.message.includes("LOGT_CONFIG_CONFLICT"))throw new ConfigurationConflict(expectedVersion,await readConfigurationVersion(db,userId));
    throw error;
  }
  const version=(batch[batch.length-2]!.results[0] as {version:number}).version;
  return {version,results:batch.slice(1,-2)};
}

/** Prevent exporting a graph assembled from different configuration versions.
 * Callers choose a loader; credential refresh or first token creation may make
 * its initial attempt change the version. Other errors are never swallowed. */
export async function readStableConfiguration<T>(db:D1Database,userId:string,load:()=>Promise<T>):Promise<{version:number;value:T}>{
  let before=0,after=0;
  for(let attempt=0;attempt<3;attempt++){
    before=await readConfigurationVersion(db,userId);const value=await load();after=await readConfigurationVersion(db,userId);
    if(before===after)return {version:after,value};
  }
  throw new ConfigurationConflict(before,after);
}
