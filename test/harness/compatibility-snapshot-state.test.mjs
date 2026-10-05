import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {backupSqlFile,restoredMigrationCount,validateRegistryCandidate,capturedMainModule,readApplicationSnapshot,assertApplicationSnapshot} from '../../scripts/compatibility-snapshot-state.mjs';
const migrations=Array.from({length:32},(_,i)=>({name:String(i+1).padStart(4,'0')+'_fixture.sql'}));
function nativeAdapter(db){return {prepare(sql){return {all:async()=>({results:db.prepare(sql).all()})};},batch:async statements=>Promise.all(statements.map(s=>s.all()))};}
test('real application snapshot preserves all original values while allowing additive tables and columns',async()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY,opaque BLOB);INSERT INTO accounts VALUES('owner',x'0001ff');CREATE TABLE empty(id TEXT);CREATE TABLE _cf_metadata(internal TEXT);INSERT INTO _cf_metadata VALUES('ignored');CREATE TABLE d1_migrations(name TEXT);INSERT INTO d1_migrations VALUES('old');");
  const adapter=nativeAdapter(db),snapshot=await readApplicationSnapshot(adapter);assert.deepEqual(snapshot.map(t=>t.name),['accounts','empty']);
  db.exec('ALTER TABLE accounts ADD COLUMN extra TEXT;CREATE TABLE added(id TEXT);');
  assert.deepEqual(await assertApplicationSnapshot(adapter,snapshot),{tables:2,rows:1});
  db.exec("UPDATE accounts SET opaque=x'0102'");await assert.rejects(assertApplicationSnapshot(adapter,snapshot),/Original application rows changed: accounts/);
  db.exec("UPDATE accounts SET opaque=x'0001ff';INSERT INTO empty VALUES('unexpected')");await assert.rejects(assertApplicationSnapshot(adapter,snapshot),/Original application rows changed: empty/);
  db.exec('DELETE FROM empty;DELETE FROM accounts;');await assert.rejects(assertApplicationSnapshot(adapter,snapshot),/Original application rows changed: accounts/);
 }finally{db.close();}
});
test('snapshot identifiers are bounded to actual supported application names before SQL construction',async()=>{
 const db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE "unsafe-name"(id TEXT);');await assert.rejects(readApplicationSnapshot(nativeAdapter(db)));await assert.rejects(assertApplicationSnapshot(nativeAdapter(db),[{name:'accounts; DROP TABLE accounts',columns:['id'],rows:[]}]))}finally{db.close();}
});
test('captures the actual supported main module while rejecting extra executable modules',()=>{
  assert.equal(capturedMainModule(['index.js']),'index.js');assert.equal(capturedMainModule(['dist/index.html','worker.js']),'worker.js');
  for(const names of [[],['index.js','worker.js'],['worker.js','worker.js'],['worker.js','other.js'],['dist/index.html'],['worker.js','../other.html']])assert.throws(()=>capturedMainModule(names));
});
test('keeps legacy backup compatibility and rejects path/filename substitutions',()=>{
  assert.equal(backupSqlFile({}),'schema-17.sql');assert.equal(backupSqlFile({sqlFile:'schema-32.sql'}),'schema-32.sql');
  for(const sqlFile of ['../schema-32.sql','schema-0.sql','schema-0032.sql','schema-32.sql/other',null,32])assert.throws(()=>backupSqlFile({sqlFile}));
});
test('restored schema must prove the exact migration prefix and filename count',()=>{
  for(const count of [17,32])assert.equal(restoredMigrationCount(migrations.slice(0,count).map(m=>m.name),migrations,`schema-${count}.sql`),count);
  const names=migrations.slice(0,17).map(m=>m.name);
  for(const file of ['schema-32.sql','schema-33.sql','other.sql'])assert.throws(()=>restoredMigrationCount(names,migrations,file));
  assert.throws(()=>restoredMigrationCount([...names.slice(0,16),'0017_foreign.sql'],migrations,'schema-17.sql'));
  assert.throws(()=>restoredMigrationCount([...names].reverse(),migrations,'schema-17.sql'));
});
test('candidate must identify all fifteen matching registry versions without mixed families',()=>{
  const packages=Array.from({length:15},(_,i)=>({name:`@logtura/fixture-${i}`,version:'0.3.1'}));
  const value={candidateSourceClean:true,packages,registryRelease:{version:'0.3.1',packages:structuredClone(packages)}};
  validateRegistryCandidate(value);
  for(const patch of [{candidateSourceClean:false},{packages:packages.slice(1)},{registryRelease:{...value.registryRelease,version:'latest'}},{registryRelease:{...value.registryRelease,packages:packages.slice(1)}}])assert.throws(()=>validateRegistryCandidate({...value,...patch}));
  for(const mutation of [v=>v.registryRelease.packages[0].version='0.3.0',v=>v.packages[0].version='0.3.0',v=>v.registryRelease.packages[0].name='@logtura/foreign',v=>v.registryRelease.packages[0].name=v.registryRelease.packages[1].name,v=>v.packages[0].name=v.packages[1].name]){const copy=structuredClone(value);mutation(copy);assert.throws(()=>validateRegistryCandidate(copy));}
});
