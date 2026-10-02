import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {spawnSync,execFile} from "node:child_process";
const root=process.cwd();
const load=name=>import(pathToFileURL(join(root,"packages",name,"dist/index.js")));
const {generateBundle,selfDeployFiles,exportDeploymentManifest,createSecretVersioner,compileForwarderRuntime,hashConfigDocument}=await load("core");
const {customVectorProvider,customVectorDestination}=await load("custom-vector");
const temporary=mkdtempSync(join(tmpdir(),"logtura-custom-graph-"));
const container=`logtura-custom-graph-${crypto.randomUUID()}`,image=`${container}-image`;
const deliveries=[];let attempts=0,protocolFailure;
const server=createServer(async(request,response)=>{
  try {
    assert.equal(request.url,"/events");assert.equal(request.method,"POST");
    assert.match(request.headers["content-type"],/^application\/x-ndjson/);
    let body="";for await(const chunk of request)body+=chunk;
    const events=body.trim().startsWith("[")?JSON.parse(body):body.trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));
    attempts++;if(attempts===1){response.writeHead(503);response.end("retry fixture");return;}
    deliveries.push(...events);response.end("ok");
  }catch(error){protocolFailure=error;response.writeHead(500);response.end("fixture error");}
});
server.keepAliveTimeout=100;
await new Promise(resolve=>server.listen(0,"0.0.0.0",resolve));
function docker(args,acceptFailure=false){
  const result=spawnSync("docker",args,{encoding:"utf8",timeout:args[0]==="build"?180000:30000});
  if(!acceptFailure)assert.equal(result.status,0,`Docker ${args[0]} failed: ${result.stderr}`);
  return result;
}
async function waitFor(check,label){const deadline=Date.now()+30000;while(Date.now()<deadline){if(protocolFailure)throw protocolFailure;if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(`${label} timed out: ${docker(["logs",container],true).stderr}`);}
try {
  const connections=["alpha","beta"].map((id,index)=>({connection:{id,provider:"custom-vector",externalAccountId:null,displayName:id},selectedSources:[{id:`${id}-source`,externalId:index===0?'final "one".selected':'final "one".sel*',sourceKind:"custom_vector",displayName:id,metadata:{customVector:{feed:index===0?'final "one".selected':'final "one".sel*',fragment:{
    sources:{"ingress one":{type:"http_server",address:`0.0.0.0:${9000+index}`,decoding:{codec:"json"}}},
    transforms:{
      normalize:{type:"remap",inputs:["ingress *"],source:`.connection_tag = "${id}"\n.error = (string(.level) ?? "info") == "error"`},
      route:{type:"route",inputs:["normalize"],reroute_unmatched:false,route:{error_one:'.error == true && .kind == "one"',error_two:'.error == true && .kind == "two"',info:'.error != true'}},
      route_extra:{type:"remap",inputs:["normalize"],source:".would_leak = true"},
      all_ports:{type:"remap",inputs:["rout?.*"],source:".component_port_wildcard = true"},
      classified:{type:"route",inputs:["all_ports"],reroute_unmatched:false,route:{error_one:'.error == true && .kind == "one"',error_two:'.error == true && .kind == "two"'}},
      merged:{type:"remap",inputs:["classified.error_*"],source:".source_port_wildcard = true"},
      'final "one"':{type:"route",inputs:["merged"],reroute_unmatched:false,route:{selected:"true"}},
    }
  }}}}]}));
  const fragment={transforms:{
    route:{type:"route",inputs:["upstream.raw"],reroute_unmatched:false,route:{one:'.kind == "one"',two:'.kind == "two"'}},
    stamp_one:{type:"remap",inputs:["route.one"],source:'.custom_destination = "one"'},
    stamp_two:{type:"remap",inputs:["route.two"],source:'.custom_destination = "two"'},
    merged:{type:"remap",inputs:["stamp_[ot]*"],source:".destination_component_wildcard = true"},
  },sinks:{output:{type:"http",inputs:["merged"],uri:`http://host.docker.internal:${server.address().port}/events`,method:"post",encoding:{codec:"json"},framing:{method:"newline_delimited"},batch:{max_events:1,timeout_secs:1},healthcheck:{enabled:false}}}};
  const input={providers:[customVectorProvider],destinations:[customVectorDestination],connections,monitors:[{monitor:{id:"errors",connectionId:null,displayName:"Errors",enabled:true,filterSteps:[{kind:"errors"}]},sinks:[{sink:{id:"delivery",filterSteps:[]},destination:{id:"custom",kind:"custom-vector",displayName:"Custom HTTP"},destinationConfig:{fragment}}]}]};
  const direct=generateBundle(input);
  const exported=await exportDeploymentManifest(input,await createSecretVersioner(crypto.randomUUID()));
  const {bundle}=await compileForwarderRuntime({service:`http://127.0.0.1:${server.address().port}`,deploymentId:"dep_custom_fixture",document:exported.document,instance:{requestId:crypto.randomUUID(),instanceId:crypto.randomUUID(),configurationVersion:0,sequence:1,revision:await hashConfigDocument(exported.document)},env:exported.secretValues,providers:input.providers,destinations:input.destinations});
  assert.deepEqual(bundle.componentManifest.map(component=>component.id).sort(),direct.componentManifest.map(component=>component.id).sort());
  for(const file of selfDeployFiles(bundle)){const path=join(temporary,file.name);mkdirSync(join(path,".."),{recursive:true});writeFileSync(path,file.content,{mode:file.mode});}
  docker(["build","--quiet","--tag",image,temporary]);
  const grammarCases=[
    ["a?",["a1","a2","long"],["a1","a2"]],
    ["a[12]",["a1","a2","a3"],["a1","a2"]],
    ["a[!2]",["a1","a2","a3"],["a1","a3"]],
    ["a[?]",["a?","a1"],["a?"]],
    ["a[[]b",["a[b","ab"],["a[b"]],
    ["a[]]b",["a]b","ab"],["a]b"]],
    ["a[!]]",["a]","a1"],["a1"]],
    ["a[^]",["a^","a1"],["a^"]],
    ["a[-1]",["a-","a1","a2"],["a-","a1"]],
    ["**/foo",["foo","path/foo","other"],["foo","path/foo"]],
    ["**",["one","two"],["one","two"]],
    ["u?",["u🦊","u1","other"],["u🦊","u1"]],
  ];
  for(const [pattern,keys,expected] of grammarCases){
    const grammarFragment={sources:Object.fromEntries(keys.map(key=>[key,{type:"demo_logs",format:"json"}])),transforms:{merged:{type:"remap",inputs:[pattern],source:". = ."}}};
    const grammarBundle=generateBundle({providers:[customVectorProvider],destinations:[],connections:[{connection:{id:"grammar",provider:"custom-vector",externalAccountId:null,displayName:"Grammar"},selectedSources:[{id:"grammar",externalId:"merged",displayName:"Grammar",sourceKind:"custom_vector",metadata:{customVector:{fragment:grammarFragment,feed:"merged"}}}]}],monitors:[]});
    const path=join(temporary,"grammar.yaml");writeFileSync(path,grammarBundle.vectorYaml);
    const graph=docker(["run","--rm","--volume",`${path}:/tmp/grammar.yaml:ro`,image,"graph","--config","/tmp/grammar.yaml"]).stdout;
    const edges=[...graph.matchAll(/("(?:[^"\\]|\\.)*") -> ("(?:[^"\\]|\\.)*")/g)].filter(match=>JSON.parse(match[2])==="custom_grammar/merged").map(match=>JSON.parse(match[1]).slice("custom_grammar/".length)).sort();
    assert.deepEqual(edges,[...expected].sort(),`Native Vector output expansion for ${pattern}`);
  }
  console.log("Pinned Vector graph expansion passed all 12 wildcard grammar cases");
  docker(["run","--rm",image,"validate","--skip-healthchecks","/etc/vector/vector.yaml"]);
  docker(["run","--detach","--name",container,"--add-host=host.docker.internal:host-gateway","--publish","127.0.0.1::9000","--publish","127.0.0.1::9001","--publish","127.0.0.1::8686",image]);
  const api=`http://${docker(["port",container,"8686/tcp"]).stdout.trim()}`;
  await waitFor(async()=>{const state=JSON.parse(docker(["inspect",container]).stdout)[0].State;if(!state.Running)throw new Error(docker(["logs",container],true).stderr);try{return(await fetch(`${api}/health`,{signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}},"Vector readiness");
  for(const [index,id] of ["alpha","beta"].entries()) {
    const ingress=`http://${docker(["port",container,`${9000+index}/tcp`]).stdout.trim()}`;
    const response=await fetch(ingress,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify([{message:`${id}-one`,level:"error",kind:"one"},{message:`${id}-two`,level:"error",kind:"two"},{message:`${id}-drop`,level:"info",kind:"one"},{message:`${id}-unmatched`,level:"error",kind:"other"}]),signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200);
  }
  await waitFor(()=>deliveries.length>=4,"Custom graph webhook delivery");
  assert.equal(deliveries.length,4);assert.equal(new Set(deliveries.map(event=>event.message)).size,4);assert.ok(attempts>=5,"HTTP retry must succeed");
  assert.deepEqual(deliveries.map(event=>event.message).sort(),["alpha-one","alpha-two","beta-one","beta-two"]);
  for(const event of deliveries){assert.equal(event.connection_tag,event.message.split("-")[0]);assert.equal(event.logtura_connection_id,event.connection_tag);assert.equal(event.logtura_provider,"custom-vector");assert.equal(event.custom_destination,event.kind);assert.equal(event.error,true);assert.equal(event.would_leak,undefined);assert.equal(event.component_port_wildcard,true);assert.equal(event.source_port_wildcard,true);assert.equal(event.destination_component_wildcard,true);}
  if(process.env.LOGT_CUSTOM_GRAPH_INJECT_FAILURE==="after-delivery")throw new Error("Injected custom graph delivery failure");
  await new Promise((resolve,reject)=>execFile("docker",["stop","--time","15",container],{timeout:20000},error=>error?reject(error):resolve()));
  assert.equal(JSON.parse(docker(["inspect",container]).stdout)[0].State.ExitCode,0);
  console.log("Actual custom Vector named feeds/ports and local component/output globs: two isolated source graphs → inferred custom destination → HTTP retry delivery and shutdown passed");
} finally {
  docker(["rm","--force",container],true);docker(["image","rm","--force",image],true);
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  rmSync(temporary,{recursive:true,force:true});assert.equal(existsSync(temporary),false);
  assert.equal(docker(["ps","--all","--filter",`name=${container}`,"--format","{{.Names}}" ]).stdout.trim(),"");
  assert.equal(docker(["image","ls","--filter",`reference=${image}`,"--format","{{.Repository}}" ]).stdout.trim(),"");
  console.log("Owned custom graph container, image, HTTP server and temporary files cleaned");
}
