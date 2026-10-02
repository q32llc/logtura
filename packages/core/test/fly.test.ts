import {expect,it,vi} from "vitest";
import {FlyMachinesClient,FlyMachineError,applyFlyMachine,validateFlyMachine,immutableFlyImage,flyRollbackConfig,matchesFlyConfig,type FlyMachine} from "../src/fly";
const image=`registry.test/forwarder@sha256:${"a".repeat(64)}`;
function machine():FlyMachine{return {id:"machine123",instance_id:"version1",state:"started",region:"ord",config:{image:"registry.test/forwarder:old",env:{PRIVATE:"never-log"}},image_ref:{registry:"registry.test",repository:"forwarder",digest:`sha256:${"b".repeat(64)}`}};}
function fixture(){
 let current=machine(),mode="normal",updates=0,starts=0,releases=0;
 const calls:Array<{url:string;init:RequestInit}>=[];
 const fetcher=vi.fn<typeof fetch>(async(url,init)=>{
  calls.push({url:String(url),init:init!});
  const path=new URL(String(url)).pathname;
  if(path.endsWith("/lease")){if(init!.method==="DELETE"){releases++;if(mode==="release-error")return new Response("never-log",{status:500});return new Response(null,{status:204});}return Response.json({data:{nonce:"lease-secret"}});}
  if(path.endsWith("/start")){starts++;current.state="started";return new Response(null,{status:204});}
  if(init!.method==="POST"){updates++;const body=JSON.parse(init!.body as string);expect(body.current_version).toBe("version1");current={...current,instance_id:"version2",config:body.config};if(mode==="loss")throw new TypeError("acknowledgement lost");if(mode==="no-install")current.config=machine().config;return Response.json(current);}
  if(path.endsWith("/volumes"))return Response.json([{id:"vol_test",region:"ord",state:"created",encrypted:true,attached_machine_id:null}]);
  if(path.endsWith("/machines"))return Response.json([current]);
  if(path.endsWith("/machine123"))return Response.json(current);
  return Response.json({name:"app",organization:{slug:"personal"}});
 });
 const client=new FlyMachinesClient({token:"private-token",fetch:fetcher}),plan={app:"app",machineId:"machine123",version:"version1",before:structuredClone(current.config),after:{...current.config,image}};
 return {client,plan,fetcher,calls,get current(){return current;},set current(value){current=value;},set mode(value:string){mode=value;},get updates(){return updates;},get starts(){return starts;},get releases(){return releases;}};
}
it("pins rollback to the actual previous digest, validates complete snapshots and compares all planned fields",()=>{
 const m=machine();expect(flyRollbackConfig(m)).toEqual({...m.config,image:`registry.test/forwarder@${m.image_ref.digest}`});expect(m.config.image).toContain(":old");
 expect(immutableFlyImage(image)).toBe(image);for(const invalid of ["latest","registry.test/forwarder:latest",image.toUpperCase(),image.replace("/forwarder","/../forwarder"),image.replace("/forwarder","//forwarder"),image.replace("sha256:","sha512:")])expect(()=>immutableFlyImage(invalid)).toThrow("pinned");
 for(const value of [null,[],{}, {...m,id:"bad/id"},{...m,instance_id:""},{...m,state:1},{...m,region:"invalid"},{...m,config:null},{...m,config:{image:2}},{...m,image_ref:null},{...m,image_ref:{...m.image_ref,digest:"bad"}},{...m,image_ref:{...m.image_ref,registry:1}},{...m,incomplete_config:m.config},{...m,host_status:"unreachable"}])expect(()=>validateFlyMachine(value)).toThrow();
 expect(validateFlyMachine({...m,host_status:"ok"})).toMatchObject(m);
 expect(matchesFlyConfig({...m.config,dns:{}},m.config)).toBe(true);expect(matchesFlyConfig({...m.config,env:{PRIVATE:"changed"}},m.config)).toBe(false);expect(matchesFlyConfig({image:m.config.image},m.config)).toBe(false);
});
it("uses bounded authenticated requests with explicit origin, manual redirects and nonce/version fences",async()=>{
 const f=fixture();expect(await f.client.app("app")).toEqual({name:"app",organization:{slug:"personal"}});expect(await f.client.machines("app")).toEqual([f.current]);expect(await f.client.volumes("app")).toHaveLength(1);
 await applyFlyMachine(f.client,f.plan);expect(f.updates).toBe(1);expect(f.releases).toBe(1);expect(f.starts).toBe(0);
 for(const {url,init} of f.calls){expect(new URL(url).origin).toBe("https://api.machines.dev");expect(init).toMatchObject({credentials:"omit",redirect:"manual"});expect(init.signal).toBeInstanceOf(AbortSignal);expect((init.headers as Record<string,string>).authorization).toBe("Bearer private-token");}
 const write=f.calls.find(call=>call.init.method==="POST" && !call.url.endsWith("/lease"))!;expect(write.init.headers).toMatchObject({"fly-machine-lease-nonce":"lease-secret"});expect(JSON.parse(write.init.body as string)).toEqual({config:f.plan.after,current_version:"version1"});
 for(const token of ["fm1r_secret","fm2_secret","token,fm2_secret"]){const capture=vi.fn<typeof fetch>(async()=>Response.json({name:"app",organization:{slug:"personal"}}));await new FlyMachinesClient({token,fetch:capture}).app("app");expect(capture.mock.calls[0]![1]!.headers).toMatchObject({authorization:`FlyV1 ${token}`});}
});
it("recovers lost update acknowledgement without issuing another update and starts stopped machines",async()=>{
 const f=fixture();f.mode="loss";await expect(applyFlyMachine(f.client,f.plan)).rejects.toThrow("lost");expect(f.releases).toBe(1);f.mode="normal";f.current.state="stopped";await applyFlyMachine(f.client,f.plan);expect(f.updates).toBe(1);expect(f.starts).toBe(1);expect(f.releases).toBe(2);
 for(const state of ["created","suspended"]){f.current.state=state;await applyFlyMachine(f.client,f.plan);}expect(f.starts).toBe(3);
});
it("rejects competing edits and failed installation, retaining the primary error when releasing fails",async()=>{
 for(const mutation of [(f:ReturnType<typeof fixture>)=>{f.current.instance_id="version-other";},(f:ReturnType<typeof fixture>)=>{f.current.config.env={PRIVATE:"changed"};},(f:ReturnType<typeof fixture>)=>{f.current.config.extra=true;}]){const f=fixture();mutation(f);await expect(applyFlyMachine(f.client,f.plan)).rejects.toThrow("changed");expect(f.updates).toBe(0);expect(f.releases).toBe(1);}
 const f=fixture();f.mode="no-install";await expect(applyFlyMachine(f.client,f.plan)).rejects.toThrow("did not install");
 const release=fixture();release.mode="release-error";await expect(applyFlyMachine(release.client,release.plan)).rejects.toThrow("HTTP 500");release.current.config.env={PRIVATE:"external"};await expect(applyFlyMachine(release.client,release.plan)).rejects.toThrow("changed");
});
it("rejects invalid tokens, request identities, schemas and lease values without emitting response contents",async()=>{
 for(const token of ["","private token","private\nsecret","x".repeat(65_537)])expect(()=>new FlyMachinesClient({token})).toThrow("Invalid Fly API token");for(const timeoutMs of [0,NaN,0.1,120_001])expect(()=>new FlyMachinesClient({token:"token",timeoutMs})).toThrow("timeout");
 const f=fixture();await expect(f.client.app("bad/app")).rejects.toThrow("identity");await expect(f.client.release("app","machine123","bad\nnonce")).rejects.toThrow("nonce");await expect(f.client.release("app","machine123","")).rejects.toThrow("nonce");
 for(const response of [null,[],{name:"other",organization:{slug:"personal"}},{name:"app",organization:{}},{name:"app",organization:[]}])await expect(new FlyMachinesClient({token:"token",fetch:async()=>Response.json(response)}).app("app")).rejects.toThrow("identity");
 for(const response of [{},[{}],[{id:"vol_test",region:"invalid",state:"created",encrypted:true,attached_machine_id:null}],[{id:"vol_test",region:"ord",state:"created",encrypted:1,attached_machine_id:null}],[{id:"bad",region:"ord",state:"created",encrypted:true,attached_machine_id:null}],[{id:"vol_test",region:"ord",state:"created",encrypted:true,attached_machine_id:1}]])await expect(new FlyMachinesClient({token:"token",fetch:async()=>Response.json(response)}).volumes("app")).rejects.toThrow("inventory");
 await expect(new FlyMachinesClient({token:"token",fetch:async()=>Response.json({})}).machines("app")).rejects.toThrow("inventory");
 await expect(new FlyMachinesClient({token:"token",fetch:async()=>Response.json({...machine(),id:"other"})}).machine("app","machine123")).rejects.toThrow("identity");
 for(const response of [null,{}, {data:{}},{data:{nonce:""}},{data:{nonce:"bad\nnonce"}}])await expect(new FlyMachinesClient({token:"token",fetch:async()=>Response.json(response)}).lease("app","machine123")).rejects.toThrow("lease");
 for(const status of [301,401,429,500]){const client=new FlyMachinesClient({token:"token",fetch:async()=>new Response("private-server-response",{status})});const error=await client.app("app").catch(error=>error);expect(error).toBeInstanceOf(FlyMachineError);expect(error.message).not.toContain("private");expect(error.status).toBe(status);}
});
it("bounds streamed response bytes, validates UTF-8/JSON, handles empty bodies and cancels failed readers",async()=>{
 for(const response of [new Response("private broken json"),new Response(new Uint8Array([255])),new Response(null),new Response("")])await expect(new FlyMachinesClient({token:"token",fetch:async()=>response}).app("app")).rejects.toThrow();
 let cancelled=false;const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(4_194_305));},cancel(){cancelled=true;}});await expect(new FlyMachinesClient({token:"token",fetch:async()=>new Response(stream)}).app("app")).rejects.toThrow("size limit");expect(cancelled).toBe(true);
 const readerError=new ReadableStream({pull(controller){controller.error(new Error("reader failed"));}});await expect(new FlyMachinesClient({token:"token",fetch:async()=>new Response(readerError)}).app("app")).rejects.toThrow("reader failed");
});
it("creates a single immutable machine without automatic retries and validates exact provider identity",async()=>{
 const current={...machine(),name:"forwarder",region:"ord",config:{image,env:{PRIVATE:"never-log"}}},calls:RequestInit[]=[];
 const fetcher=vi.fn<typeof fetch>(async(url,init)=>{expect(url).toBe("https://api.machines.dev/v1/apps/app/machines");calls.push(init!);return Response.json(current);});
 const client=new FlyMachinesClient({token:"fo1_scoped",authorizationScheme:"FlyV1",fetch:fetcher}),options={name:"forwarder",region:"ord",config:current.config};
 expect(await client.create("app",options)).toEqual(current);expect(calls[0]!.headers).toMatchObject({authorization:"FlyV1 fo1_scoped"});expect(JSON.parse(calls[0]!.body as string)).toEqual(options);
 for(const bad of [{...options,name:"bad/name"},{...options,region:"invalid"},{...options,config:{image:"latest"}}])await expect(client.create("app",bad)).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
 for(const result of [{...current,name:"other"},{...current,region:"iad"},{...current,config:{image}}]){fetcher.mockResolvedValueOnce(Response.json(result));await expect(client.create("app",options)).rejects.toThrow("different machine configuration");}
 fetcher.mockRejectedValueOnce(new TypeError("lost response"));await expect(client.create("app",options)).rejects.toThrow("lost response");expect(fetcher).toHaveBeenCalledTimes(5);
 expect(()=>new FlyMachinesClient({token:"token",authorizationScheme:"Basic" as "Bearer"})).toThrow("authorization scheme");
});
it("combines caller cancellation with the bounded provider request budget",async()=>{
 const stop=new AbortController(),fetcher=vi.fn<typeof fetch>(async(_,init)=>{expect(init!.signal!.aborted).toBe(false);stop.abort(new Error("cancelled"));expect(init!.signal!.aborted).toBe(true);return Response.json({name:"app",organization:{slug:"personal"}});});
 const client=new FlyMachinesClient({token:"token",signal:stop.signal,fetch:fetcher});await client.app("app");await expect(client.app("app")).rejects.toThrow("cancelled");expect(fetcher).toHaveBeenCalledTimes(1);
});

it("creates an encrypted checkpoint volume once with explicit placement and validates its stable identity",async()=>{
 const options={name:"logtura_checkpoint",region:"ord",sizeGb:1,compute:{cpu_kind:"shared" as const,cpus:2,memory_mb:4096}},volume={id:"vol_checkpoint",name:options.name,region:"ord",size_gb:1,state:"created",encrypted:true,attached_machine_id:null},calls:RequestInit[]=[];
 const fetcher=vi.fn<typeof fetch>(async(url,init)=>{expect(url).toBe("https://api.machines.dev/v1/apps/app/volumes");calls.push(init!);return Response.json(volume);});
 const client=new FlyMachinesClient({token:"private",fetch:fetcher});expect(await client.createVolume("app",options)).toEqual(volume);
 expect(calls[0]).toMatchObject({method:"POST",redirect:"manual",credentials:"omit"});expect(JSON.parse(calls[0]!.body as string)).toEqual({name:options.name,region:"ord",size_gb:1,compute:options.compute,encrypted:true,machines_only:true,require_unique_zone:true});
 for(const bad of [{...options,name:"bad/name"},{...options,region:"invalid"},{...options,sizeGb:0},{...options,sizeGb:1.5},{...options,compute:null as unknown as typeof options.compute},{...options,compute:{...options.compute,cpu_kind:"bad" as "shared"}},{...options,compute:{...options.compute,cpus:0}},{...options,compute:{...options.compute,cpus:1.5}},{...options,compute:{...options.compute,memory_mb:0}},{...options,compute:{...options.compute,memory_mb:1.5}}])await expect(client.createVolume("app",bad)).rejects.toThrow("request");
 expect(fetcher).toHaveBeenCalledTimes(1);
 for(const change of [{name:"other"},{region:"iad"},{size_gb:2},{encrypted:false},{state:"deleting"},{attached_machine_id:"machine123"}]){fetcher.mockResolvedValueOnce(Response.json({...volume,...change}));await expect(client.createVolume("app",options)).rejects.toThrow("different checkpoint");}
 for(const change of [{name:1},{size_gb:0},{size_gb:1.5},{state:1}]){fetcher.mockResolvedValueOnce(Response.json({...volume,...change}));await expect(client.createVolume("app",options)).rejects.toThrow("inventory");}
 fetcher.mockRejectedValueOnce(new TypeError("lost volume response"));await expect(client.createVolume("app",options)).rejects.toThrow("lost volume response");expect(fetcher).toHaveBeenCalledTimes(12);
 expect(await new FlyMachinesClient({token:"token",fetch:async()=>Response.json([volume,volume])}).volumes("app")).toEqual([volume,volume]); // Names are not unique; callers must reject ambiguous recovery candidates.
});
