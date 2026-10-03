import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const load=name=>import(pathToFileURL(join(process.cwd(),'packages',name,'dist/index.js')));
const {generateBundle}=await load('core');
const {cloudflareAiGatewayDriver}=await load('driver-cloudflare-ai-gateway');
const {webhookDriver}=await load('destination-webhook');
const {slackDriver}=await load('destination-slack');
const temporary=mkdtempSync(join(tmpdir(),'logtura-ai-gateway-flow-'));
const container=`logtura-ai-gateway-flow-${crypto.randomUUID()}`;
const account='a'.repeat(32),createdAt='2026-10-03T12:00:00.000Z';
const rows=[
 {id:'unsuccessful',provider:'openai',model:'fixture-failed',success:false,status_code:400,created_at:createdAt},
 {id:'server-error',provider:'anthropic',model:'fixture-server',success:true,status_code:503,created_at:createdAt},
 {id:'healthy',provider:'openai',model:'fixture-healthy',success:true,status_code:200,created_at:createdAt},
];
const expectedRows=[...rows,{id:'legacy-row',success:false,created_at:createdAt},{id:'bare-array-row',provider:'bare',model:'fixture-bare',success:true,status_code:503,created_at:createdAt}];
const requested=new Set();
const probes=[],events=[],slack=[],rejected={};const attempts={webhook:0,slack:0};let polls=0,failure;
const server=createServer(async(request,response)=>{
 try{
  const url=new URL(request.url,'http://fixture.invalid');
  const match=new RegExp(`^/client/v4/accounts/${account}/ai-gateway/gateways/(fixture-gateway|legacy-row|bare-array|empty-list|malformed-list)/logs$`).exec(url.pathname);
  if(match){
   assert.equal(request.method,'GET');assert.equal(request.headers.authorization,'Bearer fixture-cloudflare-token');requested.add(match[1]);
   if(match[1]==='fixture-gateway')polls++;
   if(match[1]==='fixture-gateway' && polls===1){response.writeHead(503);response.end('retry fixture');return;}
   response.writeHead(200,{'content-type':'application/json'});
   // Actual list response: API request success and per-log success differ.
   const payload=match[1]==='legacy-row'?expectedRows[3]:match[1]==='bare-array'?[expectedRows[4]]:match[1]==='empty-list'?{success:true,result:[]}:match[1]==='malformed-list'?{success:false,result:'invalid-list'}:{success:true,result:[...rows,null,12,'invalid-row'],errors:[],messages:[],result_info:{count:rows.length,page:1,per_page:50,total_count:rows.length}};
   response.end(JSON.stringify(payload));return;
  }
  assert.equal(request.method,'POST');assert.match(request.headers['content-type'],/^application\/json/);
  const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;assert.ok(size<=1048576);chunks.push(chunk);}
  const decoded=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(url.pathname==='/probe'){assert.ok(Array.isArray(decoded));probes.push(...decoded);}
  else{
   const kind=url.pathname==='/webhook'?'webhook':'slack';assert.ok(['/webhook','/slack'].includes(url.pathname));attempts[kind]++;
   if(kind==='slack'){assert.ok(!Array.isArray(decoded));assert.equal(typeof decoded.text,'string');}else assert.ok(Array.isArray(decoded));
   if(attempts[kind]===1){rejected[kind]=decoded;response.writeHead(503);response.end('retry fixture');return;}
   if(kind==='slack')slack.push(decoded);else events.push(...decoded);
  }
  response.writeHead(200);response.end('ok');
 }catch(error){failure=error;response.writeHead(400);response.end('fixture protocol mismatch');}
});
function docker(args,optional=false){const r=spawnSync('docker',args,{encoding:'utf8',timeout:30000});if(!optional)assert.equal(r.status,0,`Docker command failed: ${r.stderr}`);return r;}
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 const sink=(id,kind)=>({sink:{id,filterSteps:[]},destination:{id:'dest_'+id,kind,displayName:id},destinationConfig:kind==='slack'?{webhookUrl:origin+'/slack',teamName:null,channel:null}:{url:origin+'/'+id}});
 const bundle=generateBundle({providers:[cloudflareAiGatewayDriver],destinations:[webhookDriver,slackDriver],
  connections:[{connection:{id:'con_fixture',provider:cloudflareAiGatewayDriver.id,displayName:'AI Gateway fixture',externalAccountId:account},credentials:{apiToken:'fixture-cloudflare-token'},selectedSources:['fixture-gateway','legacy-row','bare-array','empty-list','malformed-list'].map((externalId,i)=>({id:'src_'+i,externalId,displayName:externalId,sourceKind:'cf_ai_gateway',metadata:null}))}],
  monitors:[{monitor:{id:'all',connectionId:'con_fixture',displayName:'All logs',enabled:true,filterSteps:[]},sinks:[sink('probe','webhook')]},
   {monitor:{id:'errors',connectionId:'con_fixture',displayName:'Errors',enabled:true,filterSteps:[{kind:'errors'}]},sinks:[sink('webhook','webhook'),sink('slack','slack')]}]});
 assert.equal(bundle.vectorYaml.split('https://api.cloudflare.com').length-1,5);
 const yaml=bundle.vectorYaml.replaceAll('https://api.cloudflare.com',origin).replace('0.0.0.0:8686','127.0.0.1:0');
 writeFileSync(join(temporary,'vector.yaml'),yaml);
 const env=bundle.envVars.flatMap(v=>v.value===null?[]:['--env',`${v.name}=${v.value}`]);
 docker(['run','--detach','--name',container,'--network','host','--mount',`type=bind,src=${temporary},dst=/etc/vector,readonly`,...env,'timberio/vector:0.55.0-debian','--config','/etc/vector/vector.yaml']);
 const errorIds=['unsuccessful','server-error','legacy-row','bare-array-row'];
 const expectedText=['[openai] ai_gateway fixture-failed status=400','[anthropic] ai_gateway fixture-server status=503','[ai-gateway] ai_gateway ? status=200','[bare] ai_gateway fixture-bare status=503'];
 const complete=()=>expectedRows.every(r=>probes.some(e=>e.id===r.id)) && errorIds.every(id=>events.some(e=>e.id===id)) && expectedText.every(text=>slack.some(e=>e.text===text));
 const deadline=Date.now()+85000;let nextStateCheck=0;
 while(!complete() && Date.now()<deadline){
  if(failure)throw failure;
  if(Date.now()>=nextStateCheck){nextStateCheck=Date.now()+2000;assert.equal(docker(['inspect','--format','{{.State.Running}}',container]).stdout.trim(),'true',`AI Gateway runtime exited: ${docker(['logs',container],true).stderr}`);}
  assert.ok(!probes.some(e=>Array.isArray(e.result)),'AI Gateway response envelope was emitted instead of individual logs');
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 assert.ok(complete(),`AI Gateway delivery timed out: ${docker(['logs',container],true).stderr}`);assert.ok(polls>=2);assert.equal(failure,undefined);assert.equal(requested.size,5);
 for(const event of probes){
  const row=expectedRows.find(r=>r.id===event.id);assert.ok(row,'Envelope or unknown log emitted');
  assert.equal(event.script,row.provider??'ai-gateway');assert.equal(event.timestamp,createdAt);assert.equal(event.logtura_connection_id,'con_fixture');
  assert.equal(event.error,row.id!=='healthy');assert.equal(event.level,row.id==='healthy'?'info':'error');
  assert.equal(event.message,`[${row.provider??'ai-gateway'}] ai_gateway ${row.model??'?'} status=${row.status_code??200}`);
 }
 for(const event of events)assert.ok(errorIds.includes(event.id),'Successful log escaped error filter');
 for(const event of slack)assert.ok(expectedText.includes(event.text));
 assert.ok(slack.some(e=>e.text===rejected.slack.text));assert.ok(rejected.webhook.every(e=>events.some(d=>d.id===e.id)));
 console.log('Real Vector AI Gateway list-envelope fanout, per-log success/status filtering, webhook and Slack delivery and retries passed');
}finally{
 docker(['rm','--force',container],true);assert.equal(docker(['ps','--all','--filter',`name=${container}`,'--format','{{.Names}}']).stdout.trim(),'','Owned AI Gateway container leaked');
 await new Promise(resolve=>server.close(resolve));rmSync(temporary,{recursive:true,force:true});
 console.log('Owned AI Gateway runtime container, fixture receiver and temporary configuration cleaned');
}
