import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const load = name => import(pathToFileURL(join(process.cwd(), 'packages', name, 'dist/index.js')));
const {generateBundle,selfDeployFiles} = await load('core');
const {supabaseEdgeLogsDriver} = await load('driver-supabase-edge-logs');
const {webhookDriver} = await load('destination-webhook');
const {slackDriver} = await load('destination-slack');
const refreshable=process.env.LOGT_SUPABASE_FIXTURE_AUTH==='refreshable';
const issued=new Set();let tokenRequests=0;
const image=refreshable?`logtura-supabase-refresh-${crypto.randomUUID()}`:'timberio/vector:0.55.0-debian';
const temporary = mkdtempSync(join(tmpdir(), 'logtura-supabase-flow-'));
const container = `logtura-supabase-flow-${crypto.randomUUID()}`;
const selectedFunction = '11111111-1111-4111-8111-111111111111';
const functionRows = [
  {id:'selected-error',function_id:selectedFunction,event_message:'error: selected fixture',timestamp:1791020000000000,execution_time_ms:12,deployment_id:'fixture-deployment'},
  {id:'selected-info',function_id:selectedFunction,event_message:'ordinary fixture',timestamp:1791020000000000},
  {id:'unselected-error',function_id:'22222222-2222-4222-8222-222222222222',event_message:'error: unselected fixture',timestamp:1791020000000000},
];
const gatewayRows = [
  {id:'gateway-error',status_code:503,method:'GET',path:'/rest/v1/fixture',event_message:'gateway fixture',timestamp:1791020000000000},
  {id:'gateway-warning',status_code:401,method:'POST',path:'/auth/v1/token',event_message:'warning fixture',timestamp:1791020000000000},
  {id:'gateway-info',status_code:200,method:'GET',path:'/storage/v1/fixture',event_message:'healthy fixture',timestamp:1791020000000000},
];
const polls = {functions:0,gateway:0}, attempts = {webhook:0,slack:0};
const deliveries = [], slack = [], rejected = {}, queries = new Set();
let failure;
const server = createServer(async (request,response) => {
  try {
    const url = new URL(request.url,'http://fixture.invalid');
    if(url.pathname==='/tokens'){assert.ok(refreshable);assert.equal(request.method,'POST');assert.equal(request.headers.authorization,'Bearer fixture-tail-token');const token=`refreshed-fixture-${++tokenRequests}`;issued.add(token);response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({access_token:token,expires_in:1}));return;}
    if (url.pathname === '/v1/projects/fixture-project/analytics/endpoints/logs.all') {
      assert.equal(request.method,'GET');if(refreshable)assert.ok(issued.has(request.headers.authorization?.replace(/^Bearer /,'')),'Sidecar used an unissued access token');else assert.equal(request.headers.authorization,'Bearer fixture-supabase-pat');
      const sql=url.searchParams.get('sql');assert.ok(sql.includes('LIMIT 100') && sql.includes('interval 90 second'));
      const channel=sql.includes('FROM function_edge_logs')?'functions':'gateway';
      assert.ok(channel==='functions' || sql.includes('FROM edge_logs'));
      queries.add(channel);polls[channel]++;
      if(channel==='functions' && polls[channel]===1){response.writeHead(503);response.end('retry fixture');return;}
      response.writeHead(200,{'content-type':'application/json'});
      response.end(JSON.stringify({result:channel==='functions'?functionRows:gatewayRows,error:null}));return;
    }
    assert.equal(request.method,'POST');assert.match(request.headers['content-type'],/^application\/json/);
    const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;assert.ok(size<=1048576);chunks.push(chunk);}
    const decoded=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const kind=url.pathname==='/webhook'?'webhook':'slack';assert.ok(['/webhook','/slack'].includes(url.pathname));
    attempts[kind]++;
    if(kind==='slack'){assert.ok(!Array.isArray(decoded));assert.equal(typeof decoded.text,'string');assert.ok(decoded.text.length>0);}
    else assert.ok(Array.isArray(decoded));
    if(attempts[kind]===1){rejected[kind]=decoded;response.writeHead(503);response.end('retry fixture');return;}
    if(kind==='slack')slack.push(decoded);else deliveries.push(...decoded);
    response.writeHead(200);response.end('ok');
  } catch(error){failure=error;response.writeHead(400);response.end('fixture protocol mismatch');}
});
function docker(args,optional=false){
  const result=spawnSync('docker',args,{encoding:'utf8',timeout:args[0]==='build'?180000:30000});
  if(!optional)assert.equal(result.status,0,`Docker command failed: ${result.stderr}`);
  return result;
}
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const bundle=generateBundle({providers:[supabaseEdgeLogsDriver],destinations:[webhookDriver,slackDriver],
    connections:[{connection:{id:'con_fixture',provider:supabaseEdgeLogsDriver.id,displayName:'Supabase fixture',externalAccountId:'fixture-project'},credentials:refreshable?{refreshToken:'fixture-refresh-token',tailToken:'fixture-tail-token',tailTokenUrl:origin+'/tokens'}:{pat:'fixture-supabase-pat'},selectedSources:[
      {id:'src_function',externalId:'selected-function',displayName:'Selected function',sourceKind:'supabase_edge_fn',metadata:{function_id:selectedFunction}},
      {id:'src_gateway',externalId:'_gateway_',displayName:'Gateway',sourceKind:'supabase_gateway',metadata:null},
    ]}],monitors:[{monitor:{id:'errors',connectionId:'con_fixture',displayName:'Errors',enabled:true,filterSteps:[{kind:'errors'}]},sinks:[
      {sink:{id:'webhook',filterSteps:[]},destination:{id:'dest_webhook',kind:'webhook',displayName:'Webhook'},destinationConfig:{url:origin+'/webhook'}},
      {sink:{id:'slack',filterSteps:[]},destination:{id:'dest_slack',kind:'slack',displayName:'Slack'},destinationConfig:{webhookUrl:origin+'/slack',teamName:null,channel:null}},
    ]}]});
  // Redirect only the provider's API origin. Retain generated SQL, polling,
  // bearer interpolation, JSON decoding, selection, normalization and sinks.
  assert.equal(bundle.vectorYaml.split('https://api.supabase.com').length-1,2);
  const yaml=bundle.vectorYaml.replaceAll('https://api.supabase.com',origin)
    .replace('0.0.0.0:8686','127.0.0.1:0');
  assert.ok(!yaml.includes('https://api.supabase.com'));
  if(refreshable){const context=join(temporary,'image');mkdirSync(context);for(const file of selfDeployFiles(bundle)){const path=join(context,file.name);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,file.content,{mode:file.mode});}docker(['build','--quiet','--tag',image,context]);}
  writeFileSync(join(temporary,'vector.yaml'),yaml);
  const env=bundle.envVars.flatMap(v=>v.value===null?[]:['--env',`${v.name}=${v.value}`]);
  docker(['run','--detach','--name',container,'--network','host','--mount',`type=bind,src=${temporary},dst=/etc/vector,readonly`,...env,image,'--config','/etc/vector/vector.yaml']);
  const deadline=Date.now()+85000;
  const complete=()=>['selected-error','gateway-error'].every(id=>deliveries.some(e=>e.id===id)) &&
    ['[selected-function] error: selected fixture','[rest] gateway fixture'].every(text=>slack.some(e=>e.text===text));
  while(!complete() && Date.now()<deadline){if(failure)throw failure;await new Promise(resolve=>setTimeout(resolve,200));}
  if(!complete())console.error(JSON.stringify({refreshable,tokenRequests,polls,attempts}));
  assert.ok(complete(),`Supabase/Slack delivery timed out: ${docker(['logs',container],true).stderr}`);
  assert.equal(failure,undefined);assert.deepEqual([...queries].sort(),['functions','gateway']);assert.ok(polls.functions>=2);
  for(const event of deliveries){
    assert.ok(['selected-error','gateway-error'].includes(event.id),'Filtered or unselected event escaped');
    assert.equal(event.error,true);assert.equal(event.level,'error');assert.equal(event.logtura_connection_id,'con_fixture');
    assert.equal(event.timestamp,1791020000000);
    if(event.id==='selected-error'){assert.equal(event.script,'selected-function');assert.equal(event.source_kind,'function');assert.equal(event.function_id,selectedFunction);assert.equal(event.execution_time_ms,12);}
    else {assert.equal(event.script,'rest');assert.equal(event.source_kind,'gateway');assert.equal(event.status_code,503);assert.equal(event.path,'/rest/v1/fixture');}
  }
  for(const event of slack)assert.ok(['[selected-function] error: selected fixture','[rest] gateway fixture'].includes(event.text));
  assert.ok(slack.some(e=>e.text===rejected.slack.text),'Slack did not retry the rejected message');
  assert.ok(rejected.webhook.every(e=>deliveries.some(d=>d.id===e.id)),'Webhook did not retry its rejected batch');
  if(refreshable){assert.ok(tokenRequests>=3,'Refreshable channels did not reacquire short-lived access tokens');console.log('Actual Supabase refresh sidecar exchanged scoped tokens, refreshed short-lived access credentials and delivered both generated channels');}
  console.log('Real Vector Supabase polling/selection/normalization delivered errors to webhook and Slack object framing; provider and sink failures recovered');
} finally {
  docker(['rm','--force',container],true);
  const remaining=docker(['ps','--all','--filter',`name=${container}`,'--format','{{.Names}}']);
  assert.equal(remaining.stdout.trim(),'','Owned Supabase container leaked');
  if(refreshable){docker(['image','rm','--force',image],true);assert.equal(docker(['image','ls','--filter',`reference=${image}`,'--format','{{.Repository}}']).stdout.trim(),'','Owned Supabase sidecar image leaked');}
  await new Promise(resolve=>server.close(resolve));rmSync(temporary,{recursive:true,force:true});
  console.log('Owned Supabase runtime container, fixture receiver and temporary configuration cleaned');
}
