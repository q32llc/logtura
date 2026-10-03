import assert from 'node:assert/strict';

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
