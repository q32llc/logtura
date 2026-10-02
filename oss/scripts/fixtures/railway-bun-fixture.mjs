import assert from "node:assert/strict";
import {mkdirSync,writeFileSync} from "node:fs";

const vectorMode=process.env.LOGT_RAILWAY_VECTOR === "1";
const modes = vectorMode ? ["vector"] : ["account", "project", "broker", "broker-error", "missing"];
const fixture = "fixture-private-response";
for (const mode of modes) {
  let connections = 0, pongs = 0, brokerCalls = 0, protocolFailure;
  const events = [], errors = [], deliveries = [];
  let attempts=0;
  const row = {timestamp:"2026-10-02T00:00:00Z", message:"Fixture delivery", severity:"error", tags:{serviceId:"api", deploymentId:"dep", deploymentInstanceId:"instance"}, attributes:[{key:"count",value:"3"},{key:"structured",value:'{"ok":true}'}]};
  const server = Bun.serve({
    hostname:"127.0.0.1", port:vectorMode ? 9001 : 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      try {
        if(url.pathname === "/events") {
          assert.ok(vectorMode);
          assert.equal(req.method,"POST");
          assert.equal(req.headers.get("content-type"),"application/json");
          const text=await req.text();
          attempts++;
          if(attempts === 1) return new Response("fixture retry",{status:503});
          deliveries.push(...(text.trim().startsWith("[") ? JSON.parse(text) : text.trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))));
          return new Response("ok");
        }
        if (url.pathname === "/broker") {
          brokerCalls++;
          assert.equal(req.method,"POST");
          assert.equal(req.headers.get("authorization"),"Bearer fixture-tail");
          assert.equal(url.hash,"");
          return mode === "broker-error" ? new Response(fixture,{status:503}) : Response.json({access_token:"fixture-oauth",expires_in:300});
        }
        assert.equal(url.pathname,"/graphql/v2");
        assert.equal(req.headers.get("sec-websocket-protocol"),"graphql-transport-ws");
        if (mode === "project") {
          assert.equal(req.headers.get("project-access-token"),"p_fixture");
          assert.equal(req.headers.get("authorization"),null);
        } else {
          assert.equal(req.headers.get("authorization"),`Bearer ${mode === "broker" ? "fixture-oauth" : "fixture-account"}`);
          assert.equal(req.headers.get("project-access-token"),null);
        }
        return server.upgrade(req,{data:{number:++connections}}) ? undefined : new Response(null,{status:400});
      } catch (error) { protocolFailure=error; return new Response(null,{status:500}); }
    },
    websocket: {
      message(ws, bytes) {
        try {
          const message=JSON.parse(String(bytes));
          if (message.type === "connection_init") { ws.send(JSON.stringify({type:"connection_ack"})); return; }
          if (message.type === "pong") { assert.deepEqual(message.payload,{fixture:true}); pongs++; return; }
          if (message.type === "complete") { ws.close(); return; }
          assert.equal(message.type,"subscribe");
          assert.equal(message.id,"railway_env_logs");
          assert.equal(message.payload.variables.environmentId,"production");
          assert.equal(message.payload.variables.afterLimit,500);
          assert.ok(message.payload.query.includes("environmentLogs(environmentId:"));
          assert.ok(Date.parse(message.payload.variables.afterDate)-Date.parse(message.payload.variables.anchorDate)>=3_600_000);
          ws.send(JSON.stringify({type:"ping",payload:{fixture:true}}));
          const rows=ws.data.number === 1 ? (vectorMode ? [row,row,{...row,severity:"warning",message:"Filtered warning"},{...row,tags:{serviceId:"unselected"}},{...row,tags:{...row.tags,environmentId:"staging"},message:"Wrong environment"}] : [row,row,{...row,tags:{serviceId:"unselected"}}]) : [row,{...row,message:"After reconnect"}];
          ws.send(JSON.stringify({type:"next",payload:{data:{environmentLogs:rows}}}));
          // Real close/reconnect, retaining the process's replay cache.
          if(!vectorMode || ws.data.number === 1) setTimeout(()=>ws.close(),100);
        } catch(error) { protocolFailure=error; ws.close(); }
      },
    },
  });
  const url=`ws://127.0.0.1:${server.port}/graphql/v2`;
  writeFileSync(`/fixture/redirect-${mode}.mjs`, `import assert from "node:assert/strict";\nconst NativeWebSocket=globalThis.WebSocket;\nglobalThis.WebSocket=class extends NativeWebSocket { constructor(url, options) { assert.equal(url,"wss://backboard.railway.com/graphql/v2"); super(${JSON.stringify(url)},options); this.addEventListener("open",()=>assert.equal(this.protocol,"graphql-transport-ws")); } };\n`);
  const token=mode === "missing" ? "" : mode.startsWith("broker") ? `http://127.0.0.1:${server.port}/broker#fixture-tail` : mode === "project" ? "p_fixture" : "fixture-account";
  if(vectorMode) {
    mkdirSync("/fixture/bin",{recursive:true});
    writeFileSync("/fixture/bin/bun",`#!/bin/sh\nexec /usr/local/bin/bun --preload /fixture/redirect-${mode}.mjs "$@"\n`,{mode:0o755});
  }
  const child=Bun.spawn(vectorMode ? ["/usr/bin/vector","--config","/etc/vector/vector.yaml"] : ["bun","--preload",`/fixture/redirect-${mode}.mjs`,"/fixture/railway.mjs","production",'[{"id":"api","name":"API"}]'],{env:{...process.env,RAILWAY_API_TOKEN:token,...(vectorMode?{PATH:`/fixture/bin:${process.env.PATH}`}:{})},stdout:"pipe",stderr:"pipe"});
  async function read(stream, target) {
    let pending="";
    for await (const chunk of stream) {
      pending+=new TextDecoder().decode(chunk);
      let index;
      while((index=pending.indexOf("\n"))>=0) { const line=pending.slice(0,index); pending=pending.slice(index+1); if(line) target.push(line); }
    }
  }
  const readers=[read(child.stdout,events),read(child.stderr,errors)];
  try {
    const deadline=Date.now()+(vectorMode?45_000:20_000);
    while(Date.now()<deadline) {
      if(protocolFailure) throw protocolFailure;
      if(vectorMode && deliveries.length>=2 && pongs>=2) break;
      if(mode === "missing" && child.exitCode!==null) break;
      if(mode === "broker-error" && events.length) break;
      if(!vectorMode && !["missing","broker-error"].includes(mode) && events.length>=2 && pongs>=2) break;
      await Bun.sleep(25);
    }
    if(vectorMode) {
      if(process.env.LOGT_RAILWAY_INJECT_FAILURE === "after-delivery") throw new Error("Injected Railway delivery failure");
      assert.equal(connections,2,JSON.stringify({deliveries,errors,pongs})); assert.equal(pongs,2);
      assert.equal(attempts,2); assert.equal(deliveries.length,2);
      assert.deepEqual(deliveries.map(event=>event.message),["[API] Fixture delivery","[API] After reconnect"]);
      for(const event of deliveries) {
        assert.equal(event.environmentId,"production"); assert.equal(event.serviceId,"api");
        assert.equal(event.error,true); assert.equal(event.error_reason,"railway_log");
        assert.equal(event.logtura_connection_id,"con"); assert.equal(event.logtura_provider,"railway-logs");
        assert.deepEqual(event.attrs,{count:3,structured:{ok:true}});
        assert.equal(event.exceptions[0].name,"Error");
      }
      child.kill("SIGTERM");
      assert.equal(await child.exited,0);
    } else if(mode === "missing") {
      assert.equal(await child.exited,1); assert.equal(connections,0); assert.equal(brokerCalls,0);
      assert.deepEqual(errors,["RAILWAY_API_TOKEN is required"]);
    } else if(mode === "broker-error") {
      assert.equal(connections,0); assert.equal(brokerCalls,1);
      assert.equal(JSON.parse(events[0]).message,"railway environment log tail: Railway token refresh failed: HTTP 503");
      assert.ok(!events.join("\n").includes(fixture));
    } else {
      assert.equal(connections,2,JSON.stringify({events,errors,pongs})); assert.equal(pongs,2);
      assert.equal(brokerCalls,mode === "broker" ? 1 : 0);
      assert.equal(events.length,2);
      const parsed=events.map(line=>JSON.parse(line));
      assert.deepEqual(parsed.map(event=>event.message),["Fixture delivery","After reconnect"]);
      for(const event of parsed) {
        assert.equal(event.serviceId,"api"); assert.equal(event.serviceName,"API"); assert.equal(event.environmentId,"production");
        assert.deepEqual(event.attrs,{count:3,structured:{ok:true}});
      }
      assert.deepEqual(errors,[]);
    }
    console.log(vectorMode ? "Actual Railway Bun → generated Vector → webhook: normalization, filtering, reconnect deduplication, HTTP retry and graceful shutdown passed" : `Real Bun Railway helper: ${mode} passed`);
  } finally {
    child.kill(); await child.exited; await Promise.all(readers); server.stop(true);
  }
}
