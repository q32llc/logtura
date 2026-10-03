import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {integrity} from './release-artifacts.mjs';
import {downloadRegistryArchives} from './registry-artifacts.mjs';
function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'logtura-registry-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const output=join(directory,'download');mkdirSync(output);
 const bytes=Buffer.from('immutable tested package'),row={name:'@logtura/core',version:'0.3.0',file:'logtura-core-0.3.0.tgz',integrity:integrity(bytes)};
 const manifest={schemaVersion:1,version:row.version,sourceCommit:'a'.repeat(40),sourceClean:true,packages:[row]};
 const file=join(directory,'manifest.json');writeFileSync(file,JSON.stringify(manifest));writeFileSync(join(directory,row.file),bytes);
 const remote={...row,dist:{integrity:row.integrity,tarball:'https://registry.npmjs.org/@logtura/core/-/core-0.3.0.tgz'}};
 return {file,output,bytes,row,remote,packages:[{name:row.name,version:row.version}],request:async(url,options)=>{assert.equal(options.redirect,'error');assert.ok(!options.headers?.authorization);return url.endsWith('.tgz')?new Response(bytes):Response.json(remote);}};
}
test('registry consumers download exact immutable bytes and retain release identity',async t=>{
 const x=fixture(t),receipt=await downloadRegistryArchives(x.file,x.packages,x.output,x.request);
 assert.equal(receipt.sourceCommit,'a'.repeat(40));assert.equal(receipt.packages.length,1);
 assert.deepEqual(readFileSync(join(x.output,x.row.file)),x.bytes);
 assert.deepEqual(JSON.parse(readFileSync(join(x.output,'registry-download-receipt.json'))),receipt);
});
test('missing or mismatched registry metadata cannot fall back to local packages',async t=>{
 for(const mode of ['missing','foreign']){
  const x=fixture(t);if(mode==='foreign')x.remote.dist.integrity=integrity(Buffer.from('other'));
  await assert.rejects(downloadRegistryArchives(x.file,x.packages,x.output,mode==='missing'?async()=>new Response('',{status:404}):x.request));
  assert.equal(existsSync(join(x.output,x.row.file)),false);
 }
});
test('foreign origins and changed archive bytes cannot create a verified receipt',async t=>{
 for(const mode of ['origin','bytes']){
  const x=fixture(t);if(mode==='origin')x.remote.dist.tarball='https://foreign.test/archive.tgz';
  const request=mode==='bytes'?async(url,options)=>url.endsWith('.tgz')?new Response('changed bytes'):x.request(url,options):x.request;
  await assert.rejects(downloadRegistryArchives(x.file,x.packages,x.output,request));
  assert.equal(existsSync(join(x.output,'registry-download-receipt.json')),false);
 }
});
