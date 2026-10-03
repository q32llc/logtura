import {env,SELF} from "cloudflare:test";
import {expect,it} from "vitest";
import {Hono} from "hono";
import type {AppContext} from "../../src/env";
import {creationRequestMiddleware,creationRequestRoutes} from "../../src/creation-requests";
import {createMonitor,createDestination,createSink} from "../../src/db";
import {seedUser} from "./_setup";
const json=(cookie:string,id?:string,body:unknown={displayName:"Receipt monitor"})=>({method:"POST",headers:{cookie,"content-type":"application/json",...(id?{"X-Logtura-Request-Id":id}:{})},body:JSON.stringify(body)});
async function cancel(cookie:string,id:string,kind="monitor"){return SELF.fetch(`http://localhost/api/creation-requests/${id}?kind=${kind}`,{method:"DELETE",headers:{cookie}});}
it("supports ordinary authenticated creation, receipt cancellation, tombstones and one dispatch only",async()=>{
 const u=await seedUser(),id=crypto.randomUUID();
 expect((await SELF.fetch("http://localhost/api/creation-requests",{headers:{cookie:u.sessionCookie}})).status).toBe(200);
 const response=await SELF.fetch("http://localhost/api/monitors",json(u.sessionCookie,id));expect(response.status).toBe(200);const {monitor}=await response.json<any>();expect(monitor.id).toBe(`mon_req_${id}`);
 const result=await cancel(u.sessionCookie,id);expect(result.status).toBe(200);expect(await result.json()).toEqual({receipt:{requestId:id,kind:"monitor",resourceId:monitor.id,status:"completed"}});
 expect((await SELF.fetch("http://localhost/api/monitors",json(u.sessionCookie,id))).status).toBe(409);
 expect((await SELF.fetch("http://localhost/api/monitors",json(u.sessionCookie,id,{displayName:"Different payload"}))).status).toBe(409);
 await SELF.fetch(`http://localhost/api/monitors/${monitor.id}`,{method:"DELETE",headers:{cookie:u.sessionCookie}});expect((await (await cancel(u.sessionCookie,id)).json<any>()).receipt.status).toBe("deleted");
 const unseen=crypto.randomUUID();expect((await (await cancel(u.sessionCookie,unseen)).json<any>()).receipt.status).toBe("cancelled");expect((await SELF.fetch("http://localhost/api/monitors",json(u.sessionCookie,unseen))).status).toBe(409);
 const ordinary=await SELF.fetch("http://localhost/api/monitors",json(u.sessionCookie));expect(ordinary.status).toBe(200);expect((await ordinary.json<any>()).monitor.id).not.toContain("_req_");
});
it("does not disclose another user's receipts or accept malformed identities/kinds/unsupported routes",async()=>{
 const u=await seedUser(),other=await seedUser(),id=crypto.randomUUID();await cancel(u.sessionCookie,id);
 expect((await cancel(other.sessionCookie,id)).status).toBe(409);expect((await cancel(u.sessionCookie,id,"sink")).status).toBe(409);
 for(const bad of ["invalid",id.toUpperCase()]){expect((await cancel(u.sessionCookie,bad)).status).toBe(400);expect((await SELF.fetch("http://localhost/api/monitors",json(u.sessionCookie,bad))).status).toBe(400);}
 expect((await cancel(u.sessionCookie,id,"unknown")).status).toBe(400);expect((await SELF.fetch("http://localhost/api/connections",json(u.sessionCookie,crypto.randomUUID(),{}))).status).toBe(400);
 expect((await SELF.fetch("http://localhost/api/creation-requests",{redirect:"manual"})).status).toBe(303);expect((await SELF.fetch(`http://localhost/api/creation-requests/${id}?kind=monitor`,{method:"DELETE",redirect:"manual"})).status).toBe(303);
});
it("fences a real pending INSERT when cancellation wins, and observes a committed INSERT when creation wins",async()=>{
 const u=await seedUser(),id=crypto.randomUUID();let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
 const app=new Hono<AppContext>();app.use("*",async(c,next)=>{c.set("user",{id:u.userId,githubLogin:"owner",email:null,name:null,avatarUrl:null});await next();});app.use("*",creationRequestMiddleware);app.route("/",creationRequestRoutes());
 app.post("/monitors",async c=>{enter();await gate;const monitor=await createMonitor(c.env.DB,{id:c.get("creationResourceId"),userId:u.userId,connectionId:null,displayName:"Late",filterSteps:[]});return c.json({monitor});});
 app.onError(()=>new Response("error",{status:500}));
 const pending=app.request("http://localhost/monitors",json(u.sessionCookie,id),env);await entered;
 const receipt=await app.request(`http://localhost/creation-requests/${id}?kind=monitor`,{method:"DELETE"},env);expect((await receipt.json<any>()).receipt.status).toBe("cancelled");release();expect((await pending).status).toBe(409);
 expect(await env.DB.prepare("SELECT id FROM monitors WHERE id=?").bind(`mon_req_${id}`).first()).toBeNull();
 const committed=crypto.randomUUID();const response=await SELF.fetch("http://localhost/api/monitors",json(u.sessionCookie,committed));expect(response.status).toBe(200);expect((await (await cancel(u.sessionCookie,committed)).json<any>()).receipt.status).toBe("completed");
});
it("D1 guards reject missing receipts, mismatched owners/kinds, late destination/sink INSERTs and terminal rewrites",async()=>{
 const u=await seedUser(),other=await seedUser();
 const monitorInput={userId:u.userId,connectionId:null,displayName:"Parent",filterSteps:[]};
 await expect(createMonitor(env.DB,{...monitorInput,id:`mon_req_${crypto.randomUUID()}`})).rejects.toThrow("creation_request_cancelled");
 const id=crypto.randomUUID();await cancel(u.sessionCookie,id,"monitor");await expect(createMonitor(env.DB,{...monitorInput,id:`mon_req_${id}`})).rejects.toThrow("creation_request_cancelled");
 await expect(env.DB.prepare("UPDATE resource_creation_requests SET status='pending' WHERE request_id=?").bind(id).run()).rejects.toThrow("creation_request_immutable");
 for(const column of ["request_id","user_id","kind","resource_id","created_at"]){await expect(env.DB.prepare(`UPDATE resource_creation_requests SET ${column}=? WHERE request_id=?`).bind(column==="created_at"?1:column==="kind"?"sink":column==="user_id"?other.userId:"changed",id).run()).rejects.toThrow("creation_request_immutable");}
 const dstId=crypto.randomUUID();await cancel(u.sessionCookie,dstId,"destination");const destinationInput={userId:u.userId,kind:"webhook",displayName:"Destination",config:{url:"https://example.invalid"}};
 await expect(createDestination(env.DB,env as any,{...destinationInput,id:`dst_req_${dstId}`})).rejects.toThrow("creation_request_cancelled");
 const mon=await createMonitor(env.DB,monitorInput),dst=await createDestination(env.DB,env as any,destinationInput),sinkId=crypto.randomUUID();await cancel(u.sessionCookie,sinkId,"sink");await expect(createSink(env.DB,{id:`snk_req_${sinkId}`,monitorId:mon.id,destinationId:dst.id})).rejects.toThrow("creation_request_cancelled");
 // A pending receipt belonging to another user cannot authorize an INSERT.
 const foreign=crypto.randomUUID();await env.DB.prepare("INSERT INTO resource_creation_requests VALUES(?,?,?,?,'pending',1)").bind(foreign,other.userId,"monitor",`mon_req_${foreign}`).run();await expect(createMonitor(env.DB,{...monitorInput,id:`mon_req_${foreign}`})).rejects.toThrow("creation_request_cancelled");
 await env.DB.prepare("DELETE FROM users WHERE id=?").bind(other.userId).run();expect(await env.DB.prepare("SELECT * FROM resource_creation_requests WHERE request_id=?").bind(foreign).first()).toBeNull();
});
it("retains receipt identities for validation failures without storing request credentials or bodies",async()=>{
 const u=await seedUser(),id=crypto.randomUUID();expect((await SELF.fetch("http://localhost/api/monitors",json(u.sessionCookie,id,{}))).status).toBe(400);expect((await (await cancel(u.sessionCookie,id)).json<any>()).receipt.status).toBe("cancelled");
 const row=await env.DB.prepare("SELECT * FROM resource_creation_requests WHERE request_id=?").bind(id).first();expect(Object.keys(row!).sort()).toEqual(["created_at","kind","request_id","resource_id","status","user_id"]);
});
it("tracks destination and sink completion/deletion and preserves unrelated handler errors",async()=>{
 const u=await seedUser(),dstRequest=crypto.randomUUID(),sinkRequest=crypto.randomUUID();const form=new FormData();form.set("kind","webhook");form.set("display_name","Receipt destination");form.set("url","https://example.invalid/receipt");
 const dstResponse=await SELF.fetch("http://localhost/api/destinations",{method:"POST",headers:{cookie:u.sessionCookie,"X-Logtura-Request-Id":dstRequest},body:form});expect(dstResponse.status).toBe(200);const {destination}=await dstResponse.json<any>();
 const monResponse=await SELF.fetch("http://localhost/api/monitors",json(u.sessionCookie));const {monitor}=await monResponse.json<any>();
 const sinkResponse=await SELF.fetch(`http://localhost/api/monitors/${monitor.id}/sinks`,json(u.sessionCookie,sinkRequest,{destinationId:destination.id}));expect(sinkResponse.status).toBe(200);const {sink}=await sinkResponse.json<any>();
 for(const [id,kind,resourceId] of [[dstRequest,"destination",destination.id],[sinkRequest,"sink",sink.id]])expect((await (await cancel(u.sessionCookie,id!,kind!)).json<any>()).receipt).toEqual({requestId:id,kind,resourceId,status:"completed"});
 await SELF.fetch(`http://localhost/api/destinations/${destination.id}`,{method:"DELETE",headers:{cookie:u.sessionCookie}});
 for(const [id,kind] of [[dstRequest,"destination"],[sinkRequest,"sink"]])expect((await (await cancel(u.sessionCookie,id!,kind!)).json<any>()).receipt.status).toBe("deleted");
 const app=new Hono<AppContext>();app.use("*",async(c,next)=>{c.set("user",{id:u.userId,githubLogin:"owner",email:null,name:null,avatarUrl:null});await next();});app.use("*",creationRequestMiddleware);app.post("/monitors",()=>{throw new Error("unrelated");});app.onError(()=>new Response("unrelated handler error",{status:503}));
 const unrelated=await app.request("http://localhost/monitors",json(u.sessionCookie,crypto.randomUUID()),env);expect(unrelated.status).toBe(503);expect(await unrelated.text()).toBe("unrelated handler error");
});
