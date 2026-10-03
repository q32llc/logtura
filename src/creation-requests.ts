import {Hono, type MiddlewareHandler} from "hono";
import type {AppContext} from "./env";
export type CreationKind="monitor"|"destination"|"sink";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function identity(kind:CreationKind,id:string){return `${{monitor:"mon",destination:"dst",sink:"snk"}[kind]}_req_${id}`;}
/** Opt-in single-dispatch identities. Reusing a request ID never creates again.
 * D1 INSERT triggers serialize creation against the cancellation transaction. */
export const creationRequestMiddleware:MiddlewareHandler<AppContext>=async(c,next)=>{
 const id=c.req.header("X-Logtura-Request-Id");if(!id)return next();
 const path=c.req.path.replace(/^\/api/,"");
 const kind:CreationKind|null=c.req.method!=="POST"?null:path==="/monitors"?"monitor":path==="/destinations"?"destination":/^\/monitors\/[^/]+\/sinks$/.test(path)?"sink":null;
 if(!kind || !uuid.test(id))return c.json({error:"invalid_creation_request"},400);
 c.header("cache-control","no-store");
 const result=await c.env.DB.prepare(`INSERT INTO resource_creation_requests (request_id,user_id,kind,resource_id,status,created_at) VALUES (?,?,?,?,'pending',?) ON CONFLICT(request_id) DO NOTHING`).bind(id,c.get("user")!.id,kind,identity(kind,id),Date.now()).run();
 if(result.meta.changes!==1)return c.json({error:"creation_request_used"},409);
 c.set("creationResourceId",identity(kind,id));
 await next();
 if(c.error?.message.includes("creation_request_cancelled"))c.res=c.json({error:"creation_request_cancelled"},409);
};
export function creationRequestRoutes(){const routes=new Hono<AppContext>();
 routes.get("/creation-requests",c=>{c.header("cache-control","no-store");return c.json({protocolVersion:1});});
 routes.delete("/creation-requests/:id",async c=>{
  c.header("cache-control","no-store");const id=c.req.param("id"),kind=c.req.query("kind");
  if(!uuid.test(id) || !["monitor","destination","sink"].includes(kind??""))return c.json({error:"invalid_creation_request"},400);
  const user=c.get("user")!.id,resourceId=identity(kind as CreationKind,id);
  const results=await c.env.DB.batch([
   c.env.DB.prepare(`INSERT INTO resource_creation_requests (request_id,user_id,kind,resource_id,status,created_at) VALUES (?,?,?,?,'cancelled',?) ON CONFLICT(request_id) DO NOTHING`).bind(id,user,kind,resourceId,Date.now()),
   c.env.DB.prepare(`UPDATE resource_creation_requests SET status='cancelled' WHERE request_id=? AND user_id=? AND kind=? AND status='pending'`).bind(id,user,kind),
   c.env.DB.prepare(`SELECT request_id AS requestId,kind,resource_id AS resourceId,status FROM resource_creation_requests WHERE request_id=? AND user_id=? AND kind=?`).bind(id,user,kind),
  ]);
  const receipt=results[2]!.results[0];if(!receipt)return c.json({error:"creation_request_conflict"},409);return c.json({receipt});
 });return routes;}
