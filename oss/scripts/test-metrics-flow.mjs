import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {zstdDecompressSync} from 'node:zlib';
const load=name=>import(pathToFileURL(join(process.cwd(),'packages',name,'dist/index.js')));
const {generateBundle}=await load('core');
const {customVectorProvider}=await load('custom-vector');
const {datadogMetricsDriver}=await load('destination-datadog-metrics');
const {prometheusRemoteWriteDriver}=await load('destination-prometheus-remote-write');
const {webhookDriver}=await load('destination-webhook');
const prometheusImage='prom/prometheus@sha256:6927e0919a144aa7616fd0137d4816816d42f6b816de3af269ab065250859a62';
const vectorImage='timberio/vector:0.55.0-debian';
const temporary=mkdtempSync(join(tmpdir(),'logtura-metrics-'));
const prefix=`logtura-metrics-${crypto.randomUUID()}`;
const owned=[];let server,protocolFailure;
function docker(args,optional=false){const r=spawnSync('docker',args,{encoding:'utf8',timeout:120000});if(!optional)assert.equal(r.status,0,`Docker failed: ${r.stderr}`);return r;}
async function waitFor(check,label,container){const until=Date.now()+100000;while(Date.now()<until){if(protocolFailure)throw protocolFailure;if(await check())return;if(container)assert.equal(docker(['inspect','--format','{{.State.Running}}',container]).stdout.trim(),'true',docker(['logs',container],true).stderr);await new Promise(r=>setTimeout(r,500));}throw Error(`${label} timed out: ${container?docker(['logs',container],true).stderr:''}`);}
// Decode only the wire types needed by Vector's pinned dd_metric.proto.
// https://github.com/vectordotdev/vector/blob/v0.55.0/proto/vector/dd_metric.proto
function fields(bytes){
 let offset=0;const out=[];
 const varint=()=>{let result=0n;for(let shift=0n;shift<70n;shift+=7n){assert.ok(offset<bytes.length,'Truncated varint');const b=bytes[offset++];result|=BigInt(b&127)<<shift;if(!(b&128))return result;}throw Error('Oversized varint');};
 while(offset<bytes.length){assert.ok(out.length<100000);const key=Number(varint()),id=key>>>3,type=key&7;assert.ok(id>0);let value;
  if(type===0)value=varint();else if(type===1){assert.ok(offset+8<=bytes.length);value=bytes.readDoubleLE(offset);offset+=8;}
  else if(type===2){const size=Number(varint());assert.ok(Number.isSafeInteger(size)&&size<=bytes.length-offset,'Truncated length-delimited field');value=bytes.subarray(offset,offset+size);offset+=size;}
  else if(type===5){assert.ok(offset+4<=bytes.length);value=bytes.subarray(offset,offset+4);offset+=4;}
  else throw Error('Unsupported protobuf wire type');out.push({id,type,value});
 }return out;
}
assert.throws(()=>fields(Buffer.from([10,5,1])),/Truncated length-delimited/);
assert.throws(()=>fields(Buffer.from([128])),/Truncated/);
const hash=body=>createHash('sha256').update(body).digest('hex');
try{
 writeFileSync(join(temporary,'prometheus.yml'),'global:\n  scrape_interval: 1m\nscrape_configs: []\n');
 const prometheus=prefix+'-receiver';owned.push(prometheus);
 docker(['run','--detach','--name',prometheus,'--publish','127.0.0.1::9090','--mount',`type=bind,src=${join(temporary,'prometheus.yml')},dst=/etc/prometheus/prometheus.yml,readonly`,prometheusImage,'--config.file=/etc/prometheus/prometheus.yml','--web.enable-remote-write-receiver']);
 const prometheusOrigin='http://'+docker(['port',prometheus,'9090/tcp']).stdout.trim();
 await waitFor(async()=>{try{return(await fetch(prometheusOrigin+'/-/ready',{signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}},'Prometheus readiness',prometheus);
 for(const kind of ['prometheus','datadog']){
  let attempts=0,rejectedHash;const acceptedHashes=[],series=[],logs=[];
  server=createServer(async(request,response)=>{
   try{
    const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;assert.ok(size<=8388608);chunks.push(chunk);}const body=Buffer.concat(chunks);
    if(request.url==='/logs'){assert.match(request.headers['content-type'],/^application\/json/);const batch=JSON.parse(body);assert.ok(Array.isArray(batch));logs.push(...batch);response.end('ok');return;}
    assert.equal(request.method,'POST');assert.match(request.headers['content-type'],/^application\/x-protobuf/);
    if(kind==='prometheus'){assert.equal(request.url,'/write');assert.equal(request.headers.authorization,'Bearer fixture-prometheus-token');assert.equal(request.headers['content-encoding'],'snappy');assert.equal(request.headers['x-prometheus-remote-write-version'],'0.1.0');}
    else{
     assert.equal(request.headers['dd-api-key'],'fixture-datadog-key');assert.equal(request.headers['content-encoding'],'zstd');assert.ok(['/api/v2/series','/api/beta/sketches'].includes(request.url));
     const decoded=zstdDecompressSync(body,{maxOutputLength:16777216});
     for(const field of fields(decoded).filter(f=>f.id===1&&f.type===2)){
      const row=fields(field.value);
      if(request.url==='/api/v2/series'){
       const name=row.find(f=>f.id===2)?.value.toString();assert.ok(name);
       const tags=row.filter(f=>f.id===3).map(f=>f.value.toString());
       const points=row.filter(f=>f.id===4).map(f=>fields(f.value));assert.ok(points.length);
       for(const point of points){const value=point.find(f=>f.id===1)?.value??0;const timestamp=point.find(f=>f.id===2)?.value;assert.ok(Number.isFinite(value));assert.ok(typeof timestamp==='bigint'&&timestamp>0n);}
       series.push({name,tags,values:points.map(point=>point.find(f=>f.id===1)?.value??0)});
      }
     }
    }
    attempts++;if(attempts===1){rejectedHash=hash(body);response.writeHead(503);response.end('retry fixture');return;}
    acceptedHashes.push(hash(body));
    if(kind==='prometheus'){
     const forwarded=await fetch(prometheusOrigin+'/api/v1/write',{method:'POST',headers:{'content-type':request.headers['content-type'],'content-encoding':'snappy','x-prometheus-remote-write-version':'0.1.0'},body,signal:AbortSignal.timeout(5000)});assert.equal(forwarded.status,204,await forwarded.text());response.writeHead(204);response.end();
    }else{response.writeHead(202);response.end('{}');}
   }catch(error){protocolFailure=error;response.writeHead(400);response.end('fixture protocol mismatch');}
  });
  server.keepAliveTimeout=100;await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));const origin=`http://host.docker.internal:${server.address().port}`;
  const driver=kind==='prometheus'?prometheusRemoteWriteDriver:datadogMetricsDriver;
  const bundle=generateBundle({providers:[customVectorProvider],destinations:[driver,webhookDriver],
   connections:[{connection:{id:'fixture',provider:'custom-vector',displayName:'Metric source',externalAccountId:null},credentials:{},selectedSources:[{id:'src_fixture',externalId:'ingress',displayName:'Ingress',sourceKind:'custom_vector',metadata:{customVector:{feed:'ingress',fragment:{sources:{ingress:{type:'http_server',address:'0.0.0.0:9000',decoding:{codec:'json'}}}}}}}]}],
   monitors:[{monitor:{id:'all',connectionId:'fixture',displayName:'Logs',enabled:true,filterSteps:[]},sinks:[{sink:{id:'logs',filterSteps:[]},destination:{id:'logs',kind:'webhook',displayName:'Logs'},destinationConfig:{url:origin+'/logs'}}]}],
   metrics:{kind:'destination',destination:{id:'fixture',kind:driver.id,displayName:'Metrics fixture'},destinationConfig:kind==='prometheus'?{endpoint:origin+'/write',bearerToken:'fixture-prometheus-token'}:{apiKey:'fixture-datadog-key',site:'datadoghq.com'}}});
  // Only the Datadog origin is redirected; retain native v2 encoding and compression.
  const yaml=kind==='datadog'?bundle.vectorYaml.replace('    type: datadog_metrics\n',`    type: datadog_metrics\n    endpoint: "${origin}"\n`):bundle.vectorYaml;
  writeFileSync(join(temporary,'vector.yaml'),yaml);const container=prefix+'-'+kind;owned.push(container);
  docker(['run','--detach','--name',container,'--add-host=host.docker.internal:host-gateway','--publish','127.0.0.1::9000','--mount',`type=bind,src=${join(temporary,'vector.yaml')},dst=/etc/vector/vector.yaml,readonly`,...bundle.envVars.flatMap(v=>v.value===null?[]:['--env',`${v.name}=${v.value}`]),vectorImage,'--config','/etc/vector/vector.yaml']);
  const ingress='http://'+docker(['port',container,'9000/tcp']).stdout.trim();
  await waitFor(async()=>{try{const r=await fetch(ingress,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify([{message:'metrics-one'},{message:'metrics-two'},{message:'metrics-three'}]),signal:AbortSignal.timeout(1000)});return r.ok;}catch{return false;}},'Source readiness',container);
  await waitFor(()=>logs.length>=3,'Log delivery',container);
  let stored,nextProbe=Date.now()+15000;
  await waitFor(async()=>{
   if(kind==='datadog'&&Date.now()>=nextProbe){nextProbe=Date.now()+15000;const response=await fetch(ingress,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:'metrics-after-baseline'}),signal:AbortSignal.timeout(3000)});assert.equal(response.status,200);}
   if(!rejectedHash||!acceptedHashes.includes(rejectedHash))return false;
   if(kind==='datadog')return series.some(s=>s.name.endsWith('component_received_events_total')&&s.tags.includes('component_id:custom_fixture_ingress')&&s.values.some(value=>value>0));
   const r=await fetch(prometheusOrigin+'/api/v1/query?query='+encodeURIComponent('vector_component_received_events_total{component_id="custom_fixture_ingress"}'),{signal:AbortSignal.timeout(3000)});assert.equal(r.status,200);const result=await r.json();assert.equal(result.status,'success');stored=result.data.result;return stored.some(row=>Number(row.value[1])>=3);
  },`${kind} decoded metrics and retry`,container).catch(error=>{console.error(JSON.stringify({kind,attempts,retried:acceptedHashes.includes(rejectedHash),series:series.filter(s=>s.tags.includes('component_id:custom_fixture_ingress')).slice(-12)}));throw error;});
  assert.equal(protocolFailure,undefined);assert.ok(attempts>=2);assert.ok(acceptedHashes.includes(rejectedHash));
  if(kind==='prometheus')for(const sample of stored){assert.equal(sample.metric.component_type,'http_server');assert.ok(Number.isFinite(Number(sample.value[1])));assert.ok(sample.value[0]>0);}
  docker(['rm','--force',container]);await new Promise(resolve=>server.close(resolve));server=undefined;
  console.log(`${kind}: generated internal metrics reached native encoded sink with authentication, decoded component identity and exact rejected-payload retry`);
 }
}finally{
 for(const container of owned){docker(['rm','--force',container],true);assert.equal(docker(['ps','--all','--filter',`name=${container}`,'--format','{{.Names}}']).stdout.trim(),'','Owned metrics container leaked');}
 if(server)await new Promise(resolve=>server.close(resolve));rmSync(temporary,{recursive:true,force:true});console.log('Owned metrics Vector containers, Prometheus receiver, HTTP fixture and temporary files cleaned');
}
