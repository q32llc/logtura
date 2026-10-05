import assert from 'node:assert/strict';

/** Preserve complete migration SQL and its receipt. D1's /query parser rejects
 * some valid trigger bodies that native SQLite accepts; use Wrangler's file
 * import transport for trigger migrations. Never replay an uncertain write.
 */
export function cloudflareMigration(name,sql){
 assert.match(name,/^\d{4}_[a-z0-9_]+\.sql$/);
 assert.ok(typeof sql==='string'&&sql.trim().length>0&&Buffer.byteLength(sql)<=500_000,'Invalid migration source');
 // A final comment may follow the last statement. The new line makes the
 // receipt independent of that comment and missing final newline.
 return {requiresImport:/\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(sql),sql:`${sql}\nINSERT INTO d1_migrations(name) VALUES('${name}');\n`};
}
