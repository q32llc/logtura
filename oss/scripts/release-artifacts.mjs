import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export function inventory(root){
 const packages=readdirSync(join(root,'packages'),{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort().map(directory=>({directory,...JSON.parse(readFileSync(join(root,'packages',directory,'package.json'),'utf8'))})).filter(p=>!p.private);
 assert.ok(packages.length,'No public packages');
 assert.equal(new Set(packages.map(p=>p.name)).size,packages.length,'Duplicate package name');
 for(const p of packages)assert.match(p.name,/^@logtura\/[a-z0-9-]+$/);
 return packages;
}
export function checkTag(packages,tag){
 assert.match(tag??'',/^v\d+\.\d+\.\d+$/,'Use a stable vX.Y.Z release tag');
 for(const p of packages)assert.equal(p.version,tag.slice(1),`${p.name} does not match the release tag`);
 return tag.slice(1);
}
export function publishOrder(packages){
 const pending=new Map(packages.map(p=>[p.name,p])),ordered=[];
 while(pending.size){const ready=[...pending.values()].filter(p=>!Object.keys({...p.dependencies,...p.optionalDependencies,...p.peerDependencies}).some(name=>pending.has(name))).sort((a,b)=>a.name.localeCompare(b.name));assert.ok(ready.length,'Public package dependency cycle');for(const p of ready){ordered.push(p);pending.delete(p.name);}}
 return ordered;
}
export const integrity=bytes=>'sha512-'+createHash('sha512').update(bytes).digest('base64');
export function validateManifest(manifest,packages,tag,readArchive){
 const version=checkTag(packages,tag);
 assert.equal(manifest.schemaVersion,1);assert.equal(manifest.version,version);
 assert.match(manifest.sourceCommit,/^[a-f0-9]{40}$/);assert.equal(manifest.sourceClean,true,'Release requires a clean source snapshot');
 assert.equal(manifest.packages.length,packages.length);
 const rows=new Map();for(const row of manifest.packages){assert.ok(!rows.has(row.name),'Duplicate manifest entry');assert.match(row.file,/^logtura-[a-z0-9-]+-\d+\.\d+\.\d+\.tgz$/);assert.equal(row.version,version);assert.equal(integrity(readArchive(row.file)),row.integrity,'Tarball changed after consumer validation');rows.set(row.name,row);}
 for(const p of packages)assert.ok(rows.has(p.name),`Missing ${p.name}`);
 return publishOrder(packages).map(p=>rows.get(p.name));
}
export function assertRegistryMatch(row,remote){
 if(remote===null)return false;
 assert.equal(remote.name,row.name);assert.equal(remote.version,row.version);
 assert.equal(remote.dist?.integrity,row.integrity,`Published ${row.name}@${row.version} differs from the tested archive`);
 return true;
}
function command(program,args,cwd){const result=spawnSync(program,args,{cwd,encoding:'utf8',timeout:120000,env:{...process.env,NODE_OPTIONS:''}});assert.equal(result.status,0,`${program} failed: ${result.stderr}`);return result.stdout.trim();}
export async function run(args,options={}){
 const mode=args[0];assert.ok(['--check-tag','--publish','--verify'].includes(mode),'Usage: release-artifacts.mjs --check-tag | --publish <manifest> | --verify <manifest>');
 assert.equal(args.length,mode==='--check-tag'?1:2);
 const root=options.root??process.cwd(),packages=inventory(root),tag=options.tag??process.env.LOGT_RELEASE_TAG??process.env.GITHUB_REF_NAME;
 checkTag(packages,tag);
 if(mode==='--check-tag'){console.log(`Release ${tag}: all ${packages.length} public versions match`);return;}
 const file=resolve(args[1]),directory=dirname(file),manifest=JSON.parse(readFileSync(file,'utf8'));
 const rows=validateManifest(manifest,packages,tag,name=>readFileSync(join(directory,name)));
 assert.equal(manifest.sourceCommit,command('git',['rev-parse','HEAD'],root),'Release artifacts belong to another commit');
 assert.equal(command('git',['status','--porcelain','--','packages','scripts','pnpm-lock.yaml','package.json'],root),'','Release source changed after validation');
 const receipt={schemaVersion:1,tag,sourceCommit:manifest.sourceCommit,status:'checking',packages:[],attempts:[]};
 const receiptFile=join(directory,'registry-receipt.json');const save=()=>writeFileSync(receiptFile,JSON.stringify(receipt,null,2)+'\n');save();
 async function registry(row){const response=await (options.fetch??fetch)(`https://registry.npmjs.org/${encodeURIComponent(row.name)}/${row.version}`,{redirect:'error',signal:AbortSignal.timeout(30000),headers:{accept:'application/json','cache-control':'no-cache'}});if(response.status===404){await response.body?.cancel();return null;}assert.equal(response.status,200,'Registry observation failed');return response.json();}
 try{
  // Inspect every immutable version before any publish; never skip a collision.
  const existing=new Set();for(const row of rows)if(assertRegistryMatch(row,await registry(row)))existing.add(row.name);
  receipt.status=mode==='--publish'?'publishing':'verifying';save();
  for(const row of rows){
   if(!existing.has(row.name)){
    assert.equal(mode,'--publish',`Missing published ${row.name}@${row.version}`);
    const args=['publish',join(directory,row.file),'--access','public','--provenance','--registry','https://registry.npmjs.org/'];
    const attempt={name:row.name,version:row.version,integrity:row.integrity,phase:'dispatching'};receipt.attempts.push(attempt);save();
    if(options.publish)await options.publish(args);else command('npm',args,root);
    attempt.phase='acknowledged';save();console.log(`npm acknowledged ${row.name}@${row.version}; waiting for registry visibility`);
   }
   const visibleDeadline=Date.now()+180000;let remote;
   for(let attempt=0;attempt<90&&Date.now()<visibleDeadline;attempt++){remote=await registry(row);if(remote!==null)break;await (options.sleep??(ms=>new Promise(r=>setTimeout(r,ms))))(2000);}
   assert.ok(assertRegistryMatch(row,remote),`Publication is not visible for ${row.name}`);
   receipt.packages.push({name:row.name,version:row.version,integrity:row.integrity,reused:existing.has(row.name)});save();
  }
  receipt.status='verified';save();console.log(`Registry verified ${rows.length} exact tested archives for ${tag}`);
 }catch(error){receipt.status='incomplete';save();throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)run(process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
