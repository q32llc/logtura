import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'logtura-legacy-guard-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const worker=join(root,'worker'),backup=join(root,'backup');for(const directory of [worker,backup])mkdirSync(directory,{mode:0o700});
 for(const [directory,names]of [[worker,['rollback.json','worker-content.bin','worker-content-type.txt']],[backup,['schema-17.sql','backup-receipt.json']]])for(const name of names)writeFileSync(join(directory,name),'fixture',{mode:0o600});
 writeFileSync(join(worker,'rollback.json'),JSON.stringify({sourceDigest:'0'.repeat(64)}));
 writeFileSync(join(backup,'backup-receipt.json'),JSON.stringify({sha256:'0'.repeat(64)}));
 const run=()=>spawnSync(process.execPath,[resolve('scripts/verify-legacy-worker-snapshot.mjs'),worker,backup],{encoding:'utf8',timeout:20000,env:{...process.env,NODE_OPTIONS:''}});
 return {worker,backup,run};
}
test('native production-data replay refuses readable directories and snapshot files',t=>{
 const x=fixture(t);chmodSync(x.worker,0o755);let result=x.run();assert.notEqual(result.status,0);assert.match(result.stderr,/owned private directories/);
 chmodSync(x.worker,0o700);chmodSync(join(x.backup,'schema-17.sql'),0o644);result=x.run();assert.notEqual(result.status,0);assert.match(result.stderr,/owned private files/);
});
test('changed retained Worker bytes fail before executing the snapshot',t=>{
 const x=fixture(t),result=x.run();assert.notEqual(result.status,0);assert.match(result.stderr,/ERR_ASSERTION/);assert.doesNotMatch(result.stdout,/"status":"passed"/);
});
