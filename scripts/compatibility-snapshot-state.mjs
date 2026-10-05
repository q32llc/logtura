import assert from 'node:assert/strict';

function identifier(name){assert.match(name,/^[A-Za-z_][A-Za-z0-9_]*$/);return `"${name}"`;}
/** Compare every preexisting application column and row before sending runtime
 * traffic. Cloudflare metadata is inaccessible, and migration history has its
 * own canonical-prefix check. None of these private values enter the receipt.
 */
export async function readApplicationSnapshot(database){
 const names=(await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' AND name<>'d1_migrations' ORDER BY name").all()).results.map(x=>x.name);
 const results=await database.batch(names.flatMap(name=>[database.prepare(`PRAGMA table_info(${identifier(name)})`),database.prepare(`SELECT * FROM ${identifier(name)} ORDER BY rowid`)]));
 return names.map((name,i)=>({name,columns:results[i*2].results.map(x=>{identifier(x.name);return x.name;}),rows:results[i*2+1].results}));
}
export async function assertApplicationSnapshot(database,snapshot){
 const current=await database.batch(snapshot.map(table=>database.prepare(`SELECT ${table.columns.map(identifier).join(',')} FROM ${identifier(table.name)} ORDER BY rowid`)));
 for(const [i,table]of snapshot.entries())assert.deepEqual(current[i].results,table.rows,`Original application rows changed: ${table.name}`);
 return {tables:snapshot.length,rows:snapshot.reduce((total,table)=>total+table.rows.length,0)};
}

export function capturedMainModule(names) {
  const scripts = names.filter(name => name === 'index.js' || name === 'worker.js');
  assert.equal(scripts.length, 1, 'Snapshot requires one supported main module');
  assert.equal(new Set(names).size, names.length, 'Duplicate snapshot module');
  for (const name of names) assert.ok(name === scripts[0] || name === 'dist/index.html', 'Unknown snapshot module');
  return scripts[0];
}

export function backupSqlFile(receipt) {
  const file = Object.hasOwn(receipt, 'sqlFile') ? receipt.sqlFile : 'schema-17.sql';
  assert.match(file, /^schema-[1-9]\d{0,3}\.sql$/, 'Invalid backup SQL filename');
  return file;
}

export function restoredMigrationCount(names, migrations, sqlFile) {
  const count = Number(/^schema-([1-9]\d{0,3})\.sql$/.exec(sqlFile)?.[1]);
  assert.ok(Number.isSafeInteger(count) && count <= migrations.length, 'Unknown backup schema');
  assert.equal(names.length, count, 'Backup schema does not match its filename');
  assert.deepEqual(names, migrations.slice(0, count).map(m => m.name), 'Backup migrations are not the canonical prefix');
  return count;
}

export function validateRegistryCandidate(manifest) {
  assert.equal(manifest.candidateSourceClean, true);
  assert.match(manifest.registryRelease?.version ?? '', /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.registryRelease.packages.length, 15);
  assert.equal(new Set(manifest.registryRelease.packages.map(p => p.name)).size, 15);
  assert.equal(manifest.packages.length, 15);
  assert.equal(new Set(manifest.packages.map(p => p.name)).size, 15);
  for (const p of manifest.packages) {
    const remote = manifest.registryRelease.packages.find(r => r.name === p.name);
    assert.ok(remote, 'Missing registry package');
    assert.equal(p.version, manifest.registryRelease.version);
    assert.equal(remote.version, p.version);
  }
}
