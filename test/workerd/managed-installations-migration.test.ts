import { applyD1Migrations, env } from "cloudflare:test";
import { expect, inject, it } from "vitest";
it("adds empty private managed intent storage without rewriting schema-26 forwarders or configuration versions", async () => {
  const migrations = inject("migrations"), index = migrations.findIndex(m => m.name === "0027_managed_installations.sql");
  expect(index).toBeGreaterThan(-1); await applyD1Migrations(env.DB, migrations.slice(0, index));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users(id,github_id,github_login,created_at,updated_at) VALUES('legacy-user','legacy-github','legacy',1,1)"),
    env.DB.prepare("INSERT INTO connections(id,user_id,provider,display_name,credentials_encrypted,created_at,updated_at) VALUES('legacy-con','legacy-user','cloudflare-worker-tail','Existing','unchanged-ciphertext',1,1)"),
    env.DB.prepare(`INSERT INTO deployments(id,user_id,connection_id,target_kind,display_name,managed,status,heartbeat_token,last_seen_at,last_alert_sent_at,metrics_snapshot_json,created_at,updated_at)
      VALUES('legacy-dep','legacy-user','legacy-con','fly','Existing forwarder',0,'running','unchanged-token',123,456,'{"updatedAt":123}',1,1)`),
  ]);
  const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%migrations%' AND name NOT GLOB '_cf_*' ORDER BY name").all<{name:string}>()).results.map(row=>row.name), before = await Promise.all(tables.map(table => env.DB.prepare(`SELECT * FROM ${table}`).all()));
  await applyD1Migrations(env.DB, [migrations[index]!]);
  for (const [i, table] of tables.entries()) expect((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results).toEqual(before[i]!.results);
  expect((await env.DB.prepare("SELECT * FROM managed_installations").all()).results).toEqual([]);
  expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='managed_installation_active'").first("name")).toBe("managed_installation_active");
});
