import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const load=name=>import(pathToFileURL(join(process.cwd(),'packages',name,'dist/index.js')));
const {generateBundle,selfDeployFiles}=await load('core');
const {flyLogTailDriver}=await load('driver-fly-log-tail');
const {webhookDriver}=await load('destination-webhook');
const {slackDriver}=await load('destination-slack');
const temporary=mkdtempSync(join(tmpdir(),'logtura-fly-source-'));
const container=`logtura-fly-source-${crypto.randomUUID()}`,image=container+'-image';
const apps=['fixture-alpha','fixture-beta'];
const timestamp='2026-10-03T12:00:00.000Z';
const rows=[
 {id:'plain-error',level:'error',message:'plain fixture error',timestamp},
 {id:'structured-warning',level:'error',message:JSON.stringify({level:40,msg:'structured warning'}),timestamp},
 {id:'structured-info',level:'error',message:JSON.stringify({severity:'INFO',msg:'structured info'}),timestamp},
 {id:'structured-fatal',level:'info',message:JSON.stringify({level:60,msg:'structured fatal'}),timestamp},
 {id:'structured-alert',level:'info',message:JSON.stringify({lvl:'alert',msg:'structured alert'}),timestamp},
 {id:'plain-info',level:'info',message:'plain fixture info',timestamp},
];
const expected={ 'plain-error':'error','structured-warning':'warn','structured-info':'info','structured-fatal':'fatal','structured-alert':'error','plain-info':'info'};
const probes=[],events=[],slack=[],rejected={};const attempts={webhook:0,slack:0};let failure;
const server=createServer(async(request,response)=>{
 try{
  const url=new URL(request.url,'http://fixture.invalid');assert.equal(request.method,'POST');assert.match(request.headers['content-type'],/^application\/json/);
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
function docker(args,optional=false){const r=spawnSync('docker',args,{encoding:'utf8',timeout:args[0]==='build'?180000:30000});if(!optional)assert.equal(r.status,0,`Docker command failed: ${r.stderr}`);return r;}
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 const sink=(id,kind)=>({sink:{id,filterSteps:[]},destination:{id:'dest_'+id,kind,displayName:id},destinationConfig:kind==='slack'?{webhookUrl:origin+'/slack',teamName:null,channel:null}:{url:origin+'/'+id}});
 const bundle=generateBundle({providers:[flyLogTailDriver],destinations:[webhookDriver,slackDriver],
  connections:[{connection:{id:'con_fixture',provider:flyLogTailDriver.id,displayName:'Fly source fixture',externalAccountId:'fixture-org'},credentials:{apiToken:'fixture-fly-token'},selectedSources:apps.map((externalId,i)=>({id:'src_'+i,externalId,displayName:externalId,sourceKind:'fly_app',metadata:null}))}],
  monitors:[{monitor:{id:'all',connectionId:'con_fixture',displayName:'All logs',enabled:true,filterSteps:[]},sinks:[sink('probe','webhook')]},
   {monitor:{id:'errors',connectionId:'con_fixture',displayName:'Errors',enabled:true,filterSteps:[{kind:'errors'}]},sinks:[sink('webhook','webhook'),sink('slack','slack')]}]});
 const context=join(temporary,'image');mkdirSync(context);
 for(const file of selfDeployFiles(bundle)){const path=join(context,file.name);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,file.content,{mode:file.mode});}
 docker(['build','--quiet','--tag',image,context]);
 mkdirSync(join(temporary,'bin'));writeFileSync(join(temporary,'records.json'),rows.map(row=>JSON.stringify(row,null,2)).join('\n')+'\n');
 // Replace only the remote CLI transport. Vector launches the generated sh,
 // stdbuf and real jq pipeline, including $$app escaping and JSON framing.
 writeFileSync(join(temporary,'bin/flyctl'),'#!/bin/sh\nset -eu\n[ "$#" -eq 4 ] && [ "$1" = logs ] && [ "$2" = --json ] && [ "$3" = -a ]\n[ "$FLY_API_TOKEN" = fixture-fly-token ]\ncase "$4" in fixture-alpha|fixture-beta) ;; *) exit 71 ;; esac\nprintf "fly fixture diagnostic that is not JSON\\n" >&2\nprintf "%s\\n" "$4" > "/fixture/started-$4"\ncat /fixture/records.json\nwhile :; do sleep 60; done\n',{mode:0o755});
 writeFileSync(join(temporary,'vector.yaml'),bundle.vectorYaml.replace('0.0.0.0:8686','127.0.0.1:0'));
 const env=bundle.envVars.flatMap(v=>v.value===null?[]:['--env',`${v.name}=${v.value}`]);
 docker(['run','--detach','--name',container,'--network','host','--mount',`type=bind,src=${temporary},dst=/fixture`,'--mount',`type=bind,src=${join(temporary,'vector.yaml')},dst=/etc/vector/vector.yaml,readonly`,...env,'--env','PATH=/fixture/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',image]);
 const errorRows=rows.filter(row=>['error','fatal'].includes(expected[row.id]));
 const complete=()=>apps.every(app=>rows.every(row=>probes.some(e=>e.script===app&&e.id===row.id)) && errorRows.every(row=>events.some(e=>e.script===app&&e.id===row.id)) && errorRows.every(row=>slack.some(e=>e.text===`[${app}] ${row.message}`)));
 const deadline=Date.now()+60000;let nextStateCheck=0;
 while(!complete()&&Date.now()<deadline){if(failure)throw failure;if(Date.now()>=nextStateCheck){nextStateCheck=Date.now()+2000;assert.equal(docker(['inspect','--format','{{.State.Running}}',container]).stdout.trim(),'true',docker(['logs',container],true).stderr);}await new Promise(resolve=>setTimeout(resolve,200));}
 assert.ok(complete(),`Fly source delivery timed out: ${docker(['logs',container],true).stderr}`);assert.equal(failure,undefined);
 for(const event of probes){const row=rows.find(r=>r.id===event.id);assert.ok(row);assert.ok(apps.includes(event.script));assert.equal(event.logtura_connection_id,'con_fixture');assert.equal(event.timestamp,timestamp);assert.equal(event.level,expected[row.id]);assert.equal(event.error,['error','fatal'].includes(expected[row.id]));assert.equal(event.message,`[${event.script}] ${row.message}`);}
 for(const event of events)assert.equal(event.error,true,'Structured warning/info escaped the error filter');
 for(const event of slack)assert.ok(apps.some(app=>errorRows.some(row=>event.text===`[${app}] ${row.message}`)));
 assert.ok(slack.some(e=>e.text===rejected.slack.text));assert.ok(rejected.webhook.every(e=>events.some(d=>d.id===e.id&&d.script===e.script)));
 assert.ok(!docker(['logs',container],true).stderr.includes('Failed deserializing frame'),'Diagnostic stderr entered the JSON source');
 console.log('Generated Fly exec source compacted pretty JSON with real jq, preserved per-app identity and structured severity, ignored stderr and retried webhook/Slack delivery');
}finally{
 docker(['rm','--force',container],true);assert.equal(docker(['ps','--all','--filter',`name=${container}`,'--format','{{.Names}}']).stdout.trim(),'','Owned Fly source container leaked');
 docker(['image','rm','--force',image],true);assert.equal(docker(['image','ls','--filter',`reference=${image}`,'--format','{{.Repository}}']).stdout.trim(),'','Owned Fly source image leaked');
 await new Promise(resolve=>server.close(resolve));rmSync(temporary,{recursive:true,force:true});
 console.log('Owned Fly source container, generated image, fixture receiver and files cleaned');
}
