import assert from 'node:assert/strict';
import {normalizePackedArchives} from '../oss/scripts/normalize-packed.mjs';
import {downloadRegistryArchives} from '../oss/scripts/registry-artifacts.mjs';
import {inventory} from '../oss/scripts/release-artifacts.mjs';
import {mkdtempSync,mkdirSync,readdirSync,readFileSync,writeFileSync,cpSync,rmSync,existsSync,realpathSync,lstatSync,symlinkSync} from 'node:fs';
import {join,resolve,relative,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {build as workerBuild} from 'esbuild';
import {build as websiteBuild} from 'vite';
import {startLocalService} from '../test/e2e/local-workerd.ts';
import {runRoutingLifecycle} from '../test/e2e/lifecycle.ts';
import {localHttpFetch} from '../test/e2e/local-http.mjs';

const root=process.cwd(),temporary=mkdtempSync(join(tmpdir(),'logtura-packed-service-'));
const consumer=join(temporary,'service'),artifacts=join(temporary,'packages'),report=join(root,'.tmp/packed-service-report.json');
rmSync(report,{force:true});
mkdirSync(consumer);mkdirSync(artifacts);
function run(command,args,cwd=consumer){return new Promise((accept,reject)=>{
 const child=spawn(command,args,{cwd,env:{...process.env,NODE_OPTIONS:''},stdio:['ignore','pipe','pipe']});let output='';
 child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>output+=bytes);
 const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
 child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',(code,signal)=>{clearTimeout(timer);code===0?accept(output):reject(new Error(`${command} failed (${signal??code}): ${output.slice(-4000)}`));});
});}
const sha256=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const inside=(parent,path)=>{const rel=relative(parent,path);return rel===''||!rel.startsWith('..')&&!rel.startsWith('/');};
const publicModules=new Set();
function auditModule(path){
 if(!path||path.startsWith('\0')||path.startsWith('node:')||path.startsWith('cloudflare:'))return;
 const file=path.split('?')[0];if(!existsSync(file))return;
 const actual=realpathSync(file);assert.ok(!inside(join(root,'packages'),actual),`Workspace package leaked into the service build: ${actual}`);
 const marker='/node_modules/@logtura/';
 if(actual.includes(marker)){
  assert.ok(inside(join(consumer,'node_modules/@logtura'),actual),'Public dependency escaped the installed consumer');
  const subpath=actual.split(marker)[1],name=subpath.split('/')[0];
  assert.ok(subpath.startsWith(`${name}/dist/`),`Service consumed unbuilt public source: ${subpath}`);publicModules.add(`@logtura/${name}`);
 }
}
let local;
try{
 const packages=readdirSync(join(root,'packages'),{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name).map(directory=>({directory,manifest:JSON.parse(readFileSync(join(root,'packages',directory,'package.json'),'utf8'))})).filter(p=>p.manifest.name.startsWith('@logtura/'));
 assert.equal(new Set(packages.map(p=>p.manifest.name)).size,packages.length);
 const registryManifest=process.env.LOGT_PACKED_REGISTRY_MANIFEST;
 const registryReceipt=registryManifest?await downloadRegistryArchives(resolve(registryManifest),inventory(root),artifacts):null;
 if(!registryManifest)for(const p of packages)await run('pnpm',['pack','--pack-destination',artifacts],join(root,'packages',p.directory));
 const archives=readdirSync(artifacts).filter(name=>name.endsWith('.tgz')).sort();assert.equal(archives.length,packages.length);
 if(!registryManifest)await normalizePackedArchives(archives.map(name=>join(artifacts,name)),temporary,artifacts,run);
 const externalVersions={};
 for(const p of packages)for(const name of Object.keys({...p.manifest.dependencies,...p.manifest.optionalDependencies})){
  if(name.startsWith('@logtura/'))continue;
  const version=JSON.parse(readFileSync(join(root,'packages',p.directory,'node_modules',name,'package.json'),'utf8')).version;
  assert.ok(!externalVersions[name]||externalVersions[name]===version,'Candidate public packages use inconsistent third-party versions');externalVersions[name]=version;
 }
 writeFileSync(join(consumer,'package.json'),JSON.stringify({private:true,type:'module',overrides:externalVersions}));
 await run('npm',['install','--ignore-scripts','--no-audit','--no-fund',...archives.map(name=>join(artifacts,name))]);
 const installedLock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));
 for(const [name,version] of Object.entries(externalVersions))assert.equal(installedLock.packages[`node_modules/${name}`].version,version);
 for(const p of packages){
  const path=join(consumer,'node_modules',p.manifest.name);assert.ok(!lstatSync(path).isSymbolicLink());assert.ok(inside(consumer,realpathSync(path)));assert.equal(JSON.parse(readFileSync(join(path,'package.json'),'utf8')).version,p.manifest.version);
  const locked=installedLock.packages[`node_modules/${p.manifest.name}`];assert.ok(locked.resolved.startsWith('file:'));
  const archive=realpathSync(resolve(consumer,decodeURIComponent(locked.resolved.slice(5))));assert.ok(inside(artifacts,archive));
  assert.equal(locked.integrity,`sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`);
  for(const entry of [p.manifest.main,p.manifest.types])assert.equal(sha256(readFileSync(join(path,entry))),sha256(readFileSync(join(root,'packages',p.directory,entry))),'Installed package entry differs from the built candidate');
 }
 // Reuse only declared third-party tools/dependencies from the locked installation.
 // Every @logtura package is a real npm-installed tarball, never an overlay link.
 const rootManifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
 for(const name of Object.keys({...rootManifest.dependencies,...rootManifest.devDependencies})){
  if(name.startsWith('@logtura/'))continue;const target=join(consumer,'node_modules',name);
  if(!existsSync(target)){mkdirSync(dirname(target),{recursive:true});const source=realpathSync(join(root,'node_modules',name));assert.ok(!inside(join(root,'packages'),source));symlinkSync(source,target,'dir');}
 }
 for(const directory of ['src','migrations','public'])cpSync(join(root,directory),join(consumer,directory),{recursive:true,filter:path=>!(/\.test\.[cm]?[tj]sx?$/.test(path))});
 for(const name of ['tsconfig.json','vite.config.ts','index.html'])cpSync(join(root,name),join(consumer,name));
 assert.ok(!existsSync(join(consumer,'packages')));assert.ok(!existsSync(join(consumer,'.env')));assert.ok(!existsSync(join(consumer,'.dev.vars')));
 const options={absWorkingDir:consumer,entryPoints:['src/index.ts'],bundle:true,write:false,metafile:true,format:'esm',platform:'browser',conditions:['browser','import','default'],external:['node:*','cloudflare:*'],logLevel:'silent'};
 // Negative control: workspace source remains available, but a missing packed
 // compiled entry must break this exact build instead of falling back to it.
 const coreEntry=join(consumer,'node_modules/@logtura/core/dist/index.js'),coreBytes=readFileSync(coreEntry);
 rmSync(coreEntry);let missingRejected=false;
 try{await workerBuild(options);}catch(error){missingRejected=error.errors?.some(e=>e.text.includes('@logtura/core'));}finally{writeFileSync(coreEntry,coreBytes);}
 assert.ok(missingRejected,'Missing packed core entry did not fail the Worker build');
 await run(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--noEmit','-p',join(consumer,'tsconfig.json')]);
 const worker=await workerBuild(options);for(const input of Object.keys(worker.metafile.inputs))auditModule(resolve(consumer,input));
 assert.ok(publicModules.has('@logtura/core'),'Worker did not use the installed core package');
 await websiteBuild({root:consumer,configFile:join(consumer,'vite.config.ts'),logLevel:'warn',plugins:[{name:'audit-packed-public-dependencies',moduleParsed(info){auditModule(info.id);}}]});
 const script=worker.outputFiles[0].text;local=await startLocalService({serviceRoot:consumer,compiledWorker:script});
 await runRoutingLifecycle({baseUrl:local.url,fetch:localHttpFetch,sessionCookie:local.cookie,expectedUserId:local.userId,runId:randomUUID()});
 assert.deepEqual(local.unexpected,[]);
 const homepage=await localHttpFetch(local.url+'/');assert.equal(homepage.status,200);const html=await homepage.text();assert.match(html,/<div id="root"><\/div>/);
 for(const match of html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)){const response=await localHttpFetch(local.url+match[1]);assert.equal(response.status,200);assert.ok((await response.arrayBuffer()).byteLength>0);}
 // Test unbundled assets against the original checkout, not the copied tree:
 // a missing image can otherwise return the SPA HTML with a misleading 200.
 const publicFiles=readdirSync(join(root,'public'),{recursive:true}).filter(file=>lstatSync(join(root,'public',file)).isFile()).sort();
 assert.ok(publicFiles.includes('logo.svg'));assert.ok(publicFiles.includes('docs-screenshots/connections.png'));
 for(const file of publicFiles){
  const expected=readFileSync(join(root,'public',file));
  assert.ok(!expected.subarray(0,80).toString().startsWith('version https://git-lfs.github.com/spec/'),`Unresolved LFS asset: ${file}`);
  assert.deepEqual(readFileSync(join(consumer,'dist',file)),expected,`Public asset missing or changed in release: ${file}`);
  const response=await localHttpFetch(local.url+'/'+file);assert.equal(response.status,200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),expected,`Public asset did not serve original bytes: ${file}`);
  const contentType=file.endsWith('.svg')?/image\/svg\+xml/:file.endsWith('.png')?/image\/png/:file.endsWith('.xml')?/xml/:/text\/plain/;
  assert.match(response.headers.get('content-type')??'',contentType);
 }
 const evidence={schemaVersion:1,sourceCommit:(await run('git',['rev-parse','HEAD'],root)).trim(),candidateSourceClean:(await run('git',['status','--porcelain','--','src','packages','migrations'],root)).trim()==='',lockfileDigest:sha256(readFileSync(join(root,'pnpm-lock.yaml'))),installedLockfileDigest:sha256(readFileSync(join(consumer,'package-lock.json'))),publicExternalVersions:externalVersions,packages:packages.map(p=>({name:p.manifest.name,version:p.manifest.version,mainDigest:sha256(readFileSync(join(consumer,'node_modules',p.manifest.name,p.manifest.main))),declarationsDigest:sha256(readFileSync(join(consumer,'node_modules',p.manifest.name,p.manifest.types)))})).sort((a,b)=>a.name.localeCompare(b.name)),tarballs:archives.map(file=>({file,digest:sha256(readFileSync(join(artifacts,file)))})),publicModules:[...publicModules].sort(),workerDigest:sha256(script),migrations:readdirSync(join(consumer,'migrations')).filter(file=>file.endsWith('.sql')).sort().map(file=>({file,digest:sha256(readFileSync(join(consumer,'migrations',file)))})),websiteArtifacts:readdirSync(join(consumer,'dist/assets')).sort().map(file=>({file,digest:sha256(readFileSync(join(consumer,'dist/assets',file)))})),checks:{noWorkspacePackages:true,installedIntegrityVerified:true,compiledPublicEntries:true,missingEntryRejected:true,productionSourceTypes:true,websiteBuild:true,nativeD1RoutingLifecycle:true,websiteAssets:true,publicAssets:true},thirdPartyDependencies:'Reused declared dependencies from the frozen-lockfile installation; public dependencies npm-installed from candidate tarballs.'};
 evidence.publicArtifacts=publicFiles.map(file=>({file,digest:sha256(readFileSync(join(consumer,'dist',file)))}));
 if(registryReceipt){evidence.registryRelease=registryReceipt;evidence.thirdPartyDependencies='Reused declared dependencies from the frozen-lockfile installation; public dependencies downloaded from npm and installed with hashes matching the original tested immutable release archives.';}
 mkdirSync(dirname(report),{recursive:true});writeFileSync(report,JSON.stringify(evidence,null,2)+'\n');
 if(process.env.LOGT_PACKED_SERVICE_OUTPUT){
  const output=resolve(process.env.LOGT_PACKED_SERVICE_OUTPUT);assert.ok(inside(join(root,'.tmp'),output)||inside(tmpdir(),output),'Release output must be a temporary artifact directory');
  mkdirSync(dirname(output),{recursive:true,mode:0o700});mkdirSync(output,{mode:0o700});
  writeFileSync(join(output,'worker.js'),script,{mode:0o600});cpSync(join(consumer,'dist'),join(output,'dist'),{recursive:true});cpSync(join(consumer,'migrations'),join(output,'migrations'),{recursive:true});writeFileSync(join(output,'manifest.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
  assert.equal(sha256(readFileSync(join(output,'worker.js'))),evidence.workerDigest);
 }
 console.log(`Packed service passed: ${packages.length} installed public tarballs, Worker and website builds, native D1 HTTP lifecycle, missing-entry negative control. Evidence: ${report}`);
}finally{try{await local?.service.dispose();}finally{rmSync(temporary,{recursive:true,force:true});}}
