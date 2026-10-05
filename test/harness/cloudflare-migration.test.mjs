import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {cloudflareMigration} from '../../scripts/cloudflare-migration.mjs';

test('complete migration requests preserve real schema and canonical history through trigger migrations',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE);');
  const names=readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort();
  for(const name of names)db.exec(cloudflareMigration(name,readFileSync(`migrations/${name}`,'utf8')).sql);
  assert.deepEqual(db.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map(x=>x.name),names);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'linked_fly_%'").get().n,22);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});

test('complete request keeps CASE statements inside a terminated trigger and records migration after final comments',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE d1_migrations(name TEXT UNIQUE); CREATE TABLE t(id INTEGER PRIMARY KEY);');
  const source="CREATE TRIGGER guard BEFORE INSERT ON t\nBEGIN\n SELECT CASE WHEN NEW.id<1 THEN RAISE(ABORT,'guarded') END;\nEND;\n-- trailing comment without newline";
  const migration=cloudflareMigration('0033_fixture.sql',source),request=migration.sql;assert.equal(migration.requiresImport,true);
  assert.ok(request.startsWith(source));assert.match(request,/END;/);
  db.exec(request);db.exec('INSERT INTO t VALUES(1)');assert.throws(()=>db.exec('INSERT INTO t VALUES(0)'),/guarded/);
  assert.equal(db.prepare('SELECT name FROM d1_migrations').get().name,'0033_fixture.sql');
 }finally{db.close();}
});

test('migration request rejects untrusted history names and invalid source before dispatch',()=>{
 for(const name of ['../0033_bad.sql',"0033_bad.sql');DROP TABLE t;--",'latest.sql'])assert.throws(()=>cloudflareMigration(name,'SELECT 1;'));
 for(const sql of ['',null,'x'.repeat(500_001)])assert.throws(()=>cloudflareMigration('0033_fixture.sql',sql));
 assert.equal(cloudflareMigration('0033_fixture.sql','CREATE TABLE t(id INTEGER);').requiresImport,false);
 for(const prefix of ['create trigger','CREATE TEMP TRIGGER','CREATE TEMPORARY TRIGGER'])assert.equal(cloudflareMigration('0033_fixture.sql',`${prefix} t AFTER INSERT ON x BEGIN SELECT 1; END;`).requiresImport,true);
});
