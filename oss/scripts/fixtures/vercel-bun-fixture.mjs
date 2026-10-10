import assert from "node:assert/strict";
import {writeFileSync} from "node:fs";

const vectorMode=process.env.LOGT_VERCEL_VECTOR === "1";
const modes=vectorMode ? ["vector"] : ["personal","team","missing","discovery-http","discovery-json","discovery-shape","deployment-id","stream-http","stream-fetch","stream-reset","row-json","row-shape","empty","abort","discovery-abort"];
const privateText="private-vercel-fixture-body";
const row=(id,message="Fixture 🦊 delivery",extra={})=>({rowId:id,message,level:"error",timestampInMs:1790899200000,requestPath:"/api/fixture",...extra});
for(const mode of modes) {
  let discovery=0,streams=0,protocolFailure,firstAt,secondAt,attempts=0,cancellations=0;
  const output=[],errors=[],deliveries=[];
  const team=mode === "personal" ? "" : "team_fixture";
  function openFailure(request,status) {
    let cancelled=false;
    const cancel=()=>{if(!cancelled){cancelled=true;cancellations++;}};
    request.signal.addEventListener("abort",cancel,{once:true});
    return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(privateText));},cancel}),{status});
  }
  const server=Bun.serve({hostname:"127.0.0.1",port:vectorMode?9001:0,
    async fetch(request) {
      const url=new URL(request.url);
      try {
        if(url.pathname === "/events") {
          assert.ok(vectorMode); assert.equal(request.method,"POST");
          assert.equal(request.headers.get("content-type"),"application/json");
          const text=await request.text(); attempts++;
          if(attempts===1) return new Response("fixture retry",{status:503});
          deliveries.push(...(text.trim().startsWith("[")?JSON.parse(text):text.trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))));
          return new Response("ok");
        }
        assert.equal(request.headers.get("authorization"),"Bearer fixture-vercel-token");
        assert.equal(request.headers.get("accept"),"application/json");
        assert.equal(url.searchParams.get("teamId"),team || null);
        if(url.pathname === "/v6/deployments") {
          discovery++;
          assert.equal(url.searchParams.get("projectId"),"prj_fixture");
          assert.equal(url.searchParams.get("target"),"production");
          assert.equal(url.searchParams.get("state"),"READY");
          assert.equal(url.searchParams.get("limit"),"1");
          if(mode === "discovery-http") return openFailure(request,403);
          if(mode === "discovery-abort") return new Response(new ReadableStream({start(){}}));
          if(mode === "discovery-json") return new Response(privateText);
          if(mode === "discovery-shape") return Response.json({deployments:{privateText}});
          if(mode === "deployment-id") return Response.json({deployments:[{uid:"../"+privateText}]});
          if(mode === "empty") return Response.json({deployments:[]});
          return Response.json({deployments:[{uid:discovery===1?"dpl_first":"dpl_next"}]});
        }
        assert.equal(url.pathname,`/v1/projects/prj_fixture/deployments/${discovery===1?"dpl_first":"dpl_next"}/runtime-logs`);
        assert.equal(url.searchParams.get("format"),"lines");
        streams++;
        if(streams===1) firstAt=Date.now(); else if(streams===2) secondAt=Date.now();
        if(mode === "stream-http") return openFailure(request,429);
        if(mode === "abort") return new Response(new ReadableStream({start(){}}));
        if(mode === "stream-reset") return new Response(new ReadableStream({start(controller){setTimeout(()=>controller.error(new Error(privateText)),25);}}));
        if(mode === "row-json") {
          let cancelled=false;
          const cancel=()=>{if(!cancelled){cancelled=true;cancellations++;}};
          request.signal.addEventListener("abort",cancel,{once:true});
          return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(privateText+"\n"));},cancel}));
        }
        if(mode === "row-shape") return new Response("null\n");
        const rows=streams===1 ? [row("first"),row("first"),{message:"No row identity"},...(vectorMode?[row("warning","Filtered warning",{level:"warning"})]:[])] : [row("first"),row("next","After reconnect")];
        // Real HTTP chunks split a multibyte UTF-8 sequence. The final row has
        // no newline, exercising decoder flush and EOF row delivery.
        const bytes=new TextEncoder().encode("\n"+rows.map(value=>JSON.stringify(value)).join("\n"));
        const split=bytes.indexOf(0xf0)+2;
        return new Response(new ReadableStream({start(controller){
          controller.enqueue(bytes.slice(0,split));
          setTimeout(()=>{controller.enqueue(bytes.slice(split));controller.close();},25);
        }}));
      } catch(error) { protocolFailure=error;return new Response(null,{status:500}); }
    }
  });
  const preload=`/fixture/redirect-${mode}.mjs`;
  writeFileSync(preload,`import assert from "node:assert/strict";\nconst nativeFetch=globalThis.fetch;\nglobalThis.fetch=(input,options)=>{const url=new URL(String(input));assert.equal(url.origin,"https://api.vercel.com");${mode==="stream-fetch"?`if(url.pathname.includes("/runtime-logs"))return Promise.reject(new Error("${privateText}"));`:""}url.host="127.0.0.1:${server.port}";url.protocol="http:";return nativeFetch(url,options);};\n`+(["abort","discovery-abort"].includes(mode)?`const nativeTimeout=globalThis.setTimeout;globalThis.setTimeout=(callback,delay,...args)=>nativeTimeout(callback,delay===300000||delay===30000?100:delay,...args);\n`:""));
  if(vectorMode)writeFileSync("/fixture/bin/bun",`#!/bin/sh\nexec /usr/local/bin/bun --preload ${preload} "$@"\n`,{mode:0o755});
  const child=Bun.spawn(vectorMode?["/usr/bin/vector","--config","/etc/vector/vector.yaml"]:["bun","--preload",preload,"/fixture/vercel.mjs",team,JSON.stringify([{id:"prj_fixture",name:"Fixture"}])],{env:{...process.env,...(!vectorMode?{VERCEL_API_TOKEN:mode==="missing"?"":"fixture-vercel-token"}:{}),...(vectorMode?{PATH:`/fixture/bin:${process.env.PATH}`}:{})},stdout:"pipe",stderr:"pipe"});
  async function read(stream,target) {
    const decoder=new TextDecoder();let pending="";
    for await(const chunk of stream){pending+=decoder.decode(chunk,{stream:true});let index;while((index=pending.indexOf("\n"))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);if(line)target.push(line);}}
    pending+=decoder.decode();if(pending)target.push(pending);
  }
  const readers=[read(child.stdout,output),read(child.stderr,errors)];
  try {
    const deadline=Date.now()+(vectorMode?45000:15000);
    while(Date.now()<deadline) {
      if(protocolFailure)throw protocolFailure;
      if(mode==="missing"&&child.exitCode!==null)break;
      if(mode==="empty"&&discovery===1){await Bun.sleep(300);break;}
      if(mode==="abort"&&streams>=2)break;
      if(mode==="discovery-abort"&&discovery>=2){await Bun.sleep(200);break;}
      if(vectorMode&&deliveries.length>=2)break;
      if(["personal","team"].includes(mode)&&output.length>=2)break;
      if(!["personal","team","missing","empty","abort","discovery-abort","vector"].includes(mode)&&discovery>=2){await Bun.sleep(100);break;}
      await Bun.sleep(25);
    }
    if(protocolFailure)throw protocolFailure;
    assert.ok(!output.join("\n").includes(privateText));assert.ok(!errors.join("\n").includes(privateText));
    if(mode==="missing") {
      assert.equal(await child.exited,1);assert.equal(discovery,0);assert.deepEqual(errors,["VERCEL_API_TOKEN is required"]);
    } else if(mode==="empty") {
      assert.equal(discovery,1);assert.equal(streams,0);assert.deepEqual(output,[]);assert.deepEqual(errors,[]);
    } else if(mode==="discovery-abort") {
      assert.equal(discovery,2);assert.equal(streams,0);assert.deepEqual(output,[]);assert.deepEqual(errors,[]);
    } else if(mode==="abort") {
      assert.equal(streams,2);assert.deepEqual(output,[]);assert.deepEqual(errors,[]);
      assert.ok(secondAt-firstAt>=3000);
    } else if(mode==="stream-reset") {
      assert.equal(streams,2);assert.deepEqual(output,[]);assert.deepEqual(errors,[]);
      assert.ok(secondAt-firstAt>=2900,"Rejected stream reads must back off before reconnecting");
    } else if(vectorMode) {
      assert.equal(streams,2,JSON.stringify({deliveries,errors}));assert.equal(attempts,2);
      assert.deepEqual(deliveries.map(event=>event.message),["[/api/fixture] Fixture 🦊 delivery","[/api/fixture] After reconnect"]);
      for(const event of deliveries){assert.equal(event.projectId,"prj_fixture");assert.equal(event.projectName,"Fixture");assert.equal(event.error,true);assert.equal(event.error_reason,"vercel_runtime_log");assert.equal(event.logtura_connection_id,"con");assert.equal(event.logtura_provider,"vercel-logs");assert.equal(event.exceptions[0].name,"Error");}
      assert.equal(deliveries[0].deploymentId,"dpl_first");assert.equal(deliveries[1].deploymentId,"dpl_next");
      if(process.env.LOGT_VERCEL_INJECT_FAILURE === "after-delivery")throw new Error("Injected Vercel delivery failure");
      child.kill("SIGTERM");assert.equal(await child.exited,0);
    } else if(["personal","team"].includes(mode)) {
      assert.equal(streams,2);assert.ok(secondAt-firstAt>=2900,"Successful EOF must back off before reconnecting");
      const events=output.map(line=>JSON.parse(line));assert.equal(events.length,2);
      assert.deepEqual(events.map(event=>event.message),["Fixture 🦊 delivery","After reconnect"]);
      assert.deepEqual(events.map(event=>event.deploymentId),["dpl_first","dpl_next"]);
      assert.ok(events.every(event=>event.projectId==="prj_fixture"&&event.projectName==="Fixture"));assert.deepEqual(errors,[]);
    } else {
      const expected={"discovery-http":"Vercel request failed: HTTP 403","discovery-json":"Invalid Vercel JSON response","discovery-shape":"Invalid Vercel deployment inventory","deployment-id":"Invalid Vercel deployment identity","stream-http":"Vercel request failed: HTTP 429","stream-fetch":"Vercel runtime log request failed","row-json":"Invalid Vercel runtime log JSON","row-shape":"Invalid Vercel runtime log row"}[mode];
      assert.equal(discovery,2);if(["row-json","discovery-http","stream-http"].includes(mode))assert.equal(cancellations,2,"Failed open HTTP requests must be aborted");assert.equal(output.length,1,"Repeated helper errors must be cooldown suppressed");
      const event=JSON.parse(output[0]);assert.equal(event.source,"logtura_vercel_helper");assert.equal(event.projectId,"prj_fixture");assert.equal(event.message,`vercel tail prj_fixture: ${expected}`);assert.equal(event.helperErrorSuppressed,0);assert.equal(event.helperErrorCooldownMs,300000);
      assert.equal(errors.length,2);assert.ok(errors.every(line=>line===`vercel tail prj_fixture: ${expected}`));
    }
    console.log(vectorMode?"Actual Vercel Bun → generated Vector → webhook delivery, normalization, filtering, replay dedup, retry and shutdown passed":`Real Bun Vercel helper: ${mode} passed`);
  } finally { child.kill();await child.exited;await Promise.all(readers);server.stop(true); }
}
