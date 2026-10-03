import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {assertRegistryMatch,integrity,validateManifest} from './release-artifacts.mjs';

// Observe public registry bytes without credentials or a workspace fallback.
export async function downloadRegistryArchives(file,packages,output,request=fetch){
 const manifest=JSON.parse(readFileSync(file,'utf8'));
 const rows=validateManifest(manifest,packages,`v${manifest.version}`,name=>readFileSync(join(dirname(file),name)));
 const receipt={schemaVersion:1,sourceCommit:manifest.sourceCommit,version:manifest.version,packages:[]};
 for(const row of rows){
  const options={redirect:'error',signal:AbortSignal.timeout(30000)};
  const response=await request(`https://registry.npmjs.org/${encodeURIComponent(row.name)}/${row.version}`,options);
  assert.equal(response.status,200,`Missing registry version ${row.name}@${row.version}`);
  const remote=await response.json();assert.ok(assertRegistryMatch(row,remote));
  const url=new URL(remote.dist.tarball);
  assert.equal(url.origin,'https://registry.npmjs.org','Untrusted archive origin');
  assert.equal(url.username,'');assert.equal(url.password,'');
  const archive=await request(url.href,{...options,signal:AbortSignal.timeout(30000)});
  assert.equal(archive.status,200,'Registry archive download failed');
  const bytes=Buffer.from(await archive.arrayBuffer());
  assert.ok(bytes.length<=10*1024*1024,'Registry archive exceeds the package budget');
  assert.equal(integrity(bytes),row.integrity,'Downloaded registry bytes differ from the tested archive');
  writeFileSync(join(output,row.file),bytes);
  receipt.packages.push({...row,tarball:url.href});
 }
 writeFileSync(join(output,'registry-download-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
 return receipt;
}
