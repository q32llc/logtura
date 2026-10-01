import { describe, expect, it } from "vitest";
import { parseConfigDocument as parse, normalizeConfigDocument as normalize, canonicalConfigJson, hashConfigDocument, ensureSection, ensureListSection, safeId, defaultProviderName } from "../src/config";

const fixture = () => ({
  providers: {cf: {provider: "cloudflare", account_id: "account", credentials: {api_token: "env:CF_TOKEN"}}},
  sources: {workers: {source: "cloudflare-worker-tail", scripts: ["api", "web"]}},
  sinks: {alerts: {sink: "webhook", url: "env:ALERT_URL"}},
  monitors: [{name: "errors", source: "workers", sinks: ["alerts"]}],
});
const options = {env: {CF_TOKEN: "token", ALERT_URL: "https://fixture.test"}};

describe("portable configuration identities and revisions", () => {
  it("normalizes legacy identities without changing rendering inputs", () => {
    const doc = fixture(); const stable = normalize(doc, options);
    expect(parse(stable, options)).toEqual(parse(doc, options));
    expect(stable.schema_version).toBe(1);
    expect(doc.sources.workers).not.toHaveProperty("id");
    expect(normalize(stable, options)).toEqual(stable);
  });
  it("preserves all identities through renaming keys and labels", () => {
    const stable = normalize(fixture(), options); const before = parse(stable,options).input;
    const sources = stable.sources as Record<string, unknown>; sources.renamed = sources.workers; delete sources.workers;
    const sinks = stable.sinks as Record<string, unknown>; sinks.renamed = sinks.alerts; delete sinks.alerts;
    const monitor = (stable.monitors as Record<string, unknown>[])[0]!;
    monitor.sinks = ["renamed"]; monitor.name = "Renamed monitor";
    const after = parse(stable,options).input;
    expect(after.connections[0]!.connection.id).toBe(before.connections[0]!.connection.id);
    expect(after.connections[0]!.selectedSources).toEqual(before.connections[0]!.selectedSources);
    expect(after.monitors[0]!.monitor.id).toBe(before.monitors[0]!.monitor.id);
    expect(after.monitors[0]!.monitor.connectionId).toBe(before.monitors[0]!.monitor.connectionId);
    expect(after.monitors[0]!.monitor.filterSteps).toEqual(before.monitors[0]!.monitor.filterSteps);
    expect(after.monitors[0]!.sinks[0]!.sink.id).toBe(before.monitors[0]!.sinks[0]!.sink.id);
    expect(after.monitors[0]!.sinks[0]!.destination.id).toBe(before.monitors[0]!.sinks[0]!.destination.id);
  });
  it("hashes normalized refs independent of object order and resolved secrets", async () => {
    const doc = fixture(); const reversed = Object.fromEntries(Object.entries(doc).reverse());
    const first = await hashConfigDocument(doc,options);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await hashConfigDocument(reversed,{env:{CF_TOKEN:"different",ALERT_URL:"different"}})).toBe(first);
    expect(await hashConfigDocument(normalize(doc,options),options)).toBe(first);
    doc.sources.workers.scripts.push("new-site");
    expect(await hashConfigDocument(doc,options)).not.toBe(first);
  });
  it("canonicalizes JSON without mutating or collapsing ordered arrays", () => {
    expect(canonicalConfigJson({z:[2,1],a:{c:null,b:true}})).toBe('{"a":{"b":true,"c":null},"z":[2,1]}');
    expect(canonicalConfigJson(Object.create(null))).toBe("{}");
    const reused = {a:1}; expect(canonicalConfigJson([reused,reused])).toBe('[{"a":1},{"a":1}]');
  });
  it.each([undefined, NaN, Infinity, () => 1, Symbol("x"), 1n, new Date(), new Map()])("rejects non-JSON values: %s", value => {
    expect(() => canonicalConfigJson({value})).toThrow("Configuration");
  });
  it("rejects cyclic documents", () => {const doc: Record<string,unknown> = {};doc.self=doc;expect(() => normalize(doc)).toThrow("cycle");});
  it.each([0,2,"1",null])("rejects unsupported schema versions: %s", version => {expect(() => parse({schema_version:version})).toThrow("unsupported schema_version");});
  it.each([null,[],"text",false])("rejects non-object config: %s", doc => {expect(() => parse(doc)).toThrow("expected object");});
  it("rejects duplicate sanitized source identities", () => {
    const source = {source:"custom-vector",vector:{include:"x",feed:"in"}};
    expect(() => parse({sources:{"a.b":source,"a b":source}},{readInclude:()=>({sources:{}})})).toThrow("duplicate identity");
  });
  it("rejects duplicate monitor identities and repeated selections/sinks", () => {
    const doc = fixture(); doc.monitors.push({...doc.monitors[0]!}); expect(() => parse(doc)).toThrow("duplicate identity");
    const selections = fixture(); selections.sources.workers.scripts.push("api"); expect(() => parse(selections)).toThrow("duplicate identity");
    const routes = fixture(); routes.monitors[0]!.sinks.push("alerts"); expect(() => parse(routes)).toThrow("duplicate identity");
  });
  it("allows duplicate labels when identities differ", () => {
    const doc = fixture(); const stable = normalize(doc);
    (stable.monitors as unknown[]).push({...((stable.monitors as object[])[0]),id:"mon_second"});
    expect(parse(stable).input.monitors).toHaveLength(2);
  });
  it.each([12,"bad id","dst_wrong",""])("rejects malformed explicit IDs: %s", id => {
    const doc = fixture() as any;doc.sources.workers.id=id;expect(() => parse(doc)).toThrow("sources.workers.id");
  });
});

describe("injected configuration adapters", () => {
  it("does not read process environment or inherited credentials", () => {
    process.env.CF_TOKEN="ambient";
    const result=parse(fixture(),{env:Object.create({CF_TOKEN:"inherited",ALERT_URL:"inherited"})});
    expect(result.missingEnv).toEqual(["ALERT_URL","CF_TOKEN"]);
    expect(result.requiredEnv).toEqual(["ALERT_URL","CF_TOKEN"]);
    expect(result.input.connections[0]!.credentials).toEqual({apiToken:""});
    delete process.env.CF_TOKEN;
  });
  it.each(["env:","env:A B","env:1KEY","env:X;bad"])("rejects malformed env refs: %s", ref => {const doc=fixture();doc.providers.cf.credentials.api_token=ref;expect(() => parse(doc)).toThrow("Invalid environment reference");});
  it("preserves explicitly empty values as missing", () => {expect(parse(fixture(),{env:{CF_TOKEN:"",ALERT_URL:""}}).missingEnv).toHaveLength(2);});
  it("requires caller-supplied includes and validates their content", () => {
    const doc={sources:{custom:{source:"custom-vector",vector:{include:"fragment.yaml",feed:"normalized"}}},sinks:{custom:{sink:"custom-vector",vector:{include:"sink.yaml",input:"incoming"}}},monitors:[{sinks:["custom"]}]};
    expect(() => parse(doc)).toThrow("No include reader");
    expect(() => parse(doc,{readInclude:()=>[]})).toThrow("included file must be a YAML object");
    const paths:string[]=[]; const result=parse(doc,{readInclude:path=>{paths.push(path);return {sources:{},sinks:{}};}});
    expect(paths).toEqual(["fragment.yaml","sink.yaml"]);
    expect(result.input.connections[0]!.selectedSources[0]!.metadata).toHaveProperty("customVector.feed","normalized");
  });
});

const providers = [
  ["cloudflare","cloudflare-worker-tail","scripts","cf_worker"],
  ["cloudflare","cloudflare-ai-gateway","gateways","cf_ai_gateway"],
  ["fly","fly-log-tail","apps","fly_app"],
  ["vercel","vercel-logs","projects","vercel_project"],
] as const;
describe("provider and selection formats", () => {
  it.each(providers)("parses %s / %s", (provider, driver, field, kind) => {
    const doc={providers:{account:{provider,credentials:{api_token:"token"}}},sources:{logs:{driver,provider:"account",[field]:["service"],displayName:"Logs",accountId:"explicit",all:true}}};
    const connection=parse(doc).input.connections[0]!;
    expect(connection.connection).toMatchObject({provider:driver,displayName:"Logs",externalAccountId:"explicit"});
    expect(connection.selectedSources[0]!.sourceKind).toBe(kind);expect(connection.selectAll).toBe(true);
  });
  it.each(["workers","cloudflare_workers","ai_gateway","cloudflare_ai_gateway","fly","fly_apps","edge","supabase_edge","railway","railway_logs","vercel","vercel_logs"])("supports legacy alias %s", alias => {
    const provider=alias.includes("fly")?"fly":alias.includes("edge")?"supabase":alias.includes("railway")?"railway":alias.includes("vercel")?"vercel":"cloudflare";
    expect(parse({providers:{[provider]:{}},sources:{[alias]:{}}}).input.connections[0]!.connection.provider).toBeTruthy();
  });
  it("parses Railway service objects and Supabase functions/gateway", () => {
    const railway=parse({providers:{r:{provider:"railway",project_id:"project",environment_id:"environment",api_token:"token"}},sources:{r:{source:"railway-logs",project_id:"override",environment_id:"override-env",services:["plain",{service_id:"svc",name:"named",environmentId:"selected"}]}}}).input.connections[0]!;
    expect(railway.credentials).toEqual({apiToken:"token",projectId:"override",environmentId:"override-env"});
    expect(railway.selectedSources[1]).toMatchObject({displayName:"named",metadata:{environment_id:"selected"}});
    const supabase=parse({providers:{supabase:{pat:"pat",account_id:"project"}},sources:{edge:{functions:["plain",{name:"fn",function_id:"uuid"}],gateway:true}}}).input.connections[0]!;
    expect(supabase.credentials).toEqual({pat:"pat"});expect(supabase.selectedSources).toHaveLength(3);
    expect(supabase.selectedSources[1]!.metadata).toEqual({function_id:"uuid"});
    expect(supabase.selectedSources[2]!.sourceKind).toBe("supabase_gateway");
  });
  it.each([
    [{sources:{unknown:{}}},"source is required"],
    [{sources:{logs:{source:"unknown"}}},"unknown source driver"],
    [{sources:{workers:{scripts:[]}}},"run logt connect"],
    [{providers:{cloudflare:{}},sources:{workers:{provider:"missing"}}},"unknown provider"],
    [{providers:{fly:{}},sources:{workers:{provider:"fly"}}},"cloudflare provider"],
    [{providers:{a:{provider:"cloudflare"},b:{provider:"cloudflare"}},sources:{workers:{}}},"multiple cloudflare"],
    [{providers:{supabase:{}},sources:{edge:{functions:[{}]}}},"slug is required"],
    [{providers:{railway:{}},sources:{railway:{services:[{}]}}},"id is required"],
    [{providers:{cloudflare:{}},sources:{workers:{scripts:[42]}}},"expected string item"],
    [{sources:{x:{source:"custom-vector",vector:{}}}},"include is required"],
    [{sources:{x:{source:"custom-vector",vector:{include:"x"}}}},"feed is required"],
  ])("rejects invalid selection %#", (doc,error) => {expect(() => parse(doc)).toThrow(error);});
});

describe("destinations, routing and helpers", () => {
  it("parses Slack, Datadog and generic nested destination settings", () => {
    const result=parse({sinks:{s:{sink:"slack",config:{webhookUrl:"env:URL",teamName:"Team",maxMessageChars:null}},d:{type:"datadog_metrics",api_key:"env:KEY"},p:{kind:"prometheus_remote_write",config:{endpoint_url:"env:URL",headers:[{auth_token:"env:KEY"}]}}},monitors:[{name:"m",sinks:["s","d","p"],enabled:false,filter:[{rollup:{window_secs:60,group_by:["message"],max_samples:2}}]}],metrics:{sink:"d"}},{env:{URL:"url",KEY:"key"}});
    const m=result.input.monitors[0]!;
    expect(m.sinks[0]!.destinationConfig).toMatchObject({webhookUrl:"url",teamName:"Team",maxMessageChars:null});
    expect(m.sinks[1]!.destinationConfig).toEqual({apiKey:"key",site:"datadoghq.com"});
    expect(m.sinks[2]!.destinationConfig).toEqual({endpointUrl:"url",headers:[{authToken:"key"}]});
    expect(m.monitor.enabled).toBe(false);expect(m.monitor.filterSteps).toEqual([{kind:"rollup",window_secs:60,group_by:["message"],max_samples:2}]);
    expect(result.input.metrics).toMatchObject({kind:"destination",destination:{id:"dst_d"}});
  });
  it("emits credential placeholders and default rollups", () => {
    const r=parse({sinks:{s:{sink:"slack"},w:{sink:"webhook"},d:{sink:"datadog_metrics"}},monitors:[{sinks:["s","w","d"],filter:[{rollup:{}}]}]});
    expect(r.requiredEnv).toEqual(["DATADOG_D_API_KEY","SLACK_S_WEBHOOK_URL","WEBHOOK_W_URL"]);
    expect(r.input.monitors[0]!.monitor.filterSteps).toEqual([{kind:"rollup",window_secs:30,group_by:[],max_samples:5}]);
    expect(parse({monitors:[{filter:[{kind:"errors"}]}]}).input.monitors[0]!.monitor.filterSteps).toEqual([{kind:"errors"}]);
  });
  it.each([undefined,null,"none",false,{},"logtura"])("parses metrics %s", metrics => {expect(parse({metrics}).input.metrics?.kind).toBe(metrics==="logtura"?"logtura":"none");});
  it.each([
    [{sinks:{x:{}}},"sink is required"],
    [{sinks:{x:{sink:"custom-vector",vector:{}}}},"include is required"],
    [{monitors:[{sinks:["missing"]}]},"unknown sink"],
    [{monitors:[{source:"missing"}]},"unknown source"],
    [{monitors:[{connection_id:"con_missing"}]},"unknown connection"],
    [{providers:{cloudflare:{}},sources:{workers:{}},monitors:[{source:"workers",connection_id:"con_workers"}]},"choose source"],
    [{monitors:[{filter:["unknown"]}]},"unknown shorthand"],
    [{monitors:[{filter:[{kind:"unknown"}]}]},"unsupported filter"],
    [{metrics:{sink:"missing"}},"unknown sink"],
    [{sources:[]},"expected object"],
    [{monitors:{}},"expected array"],
  ])("rejects invalid routing %#", (doc,error) => {expect(() => parse(doc)).toThrow(error);});
  it("creates editing sections and chooses unused provider names", () => {
    const doc:Record<string,unknown>={}; expect(ensureSection(doc,"providers")).toEqual({});expect(ensureListSection(doc,"monitors")).toEqual([]);
    expect(ensureSection(doc,"providers")).toBe(doc.providers);expect(ensureListSection(doc,"monitors")).toBe(doc.monitors);
    expect(defaultProviderName("cloudflare",{})).toBe("cloudflare");expect(defaultProviderName("cloudflare",{cloudflare:{},"cloudflare-2":{}})).toBe("cloudflare-3");
    expect(safeId("???")).toBe("x");expect(safeId(".hello world.")).toBe("hello_world");
  });
});

describe("portable custom fragments", () => {
  it("inlines local includes and hashes their actual contents", async () => {
    const doc={sources:{custom:{source:"custom-vector",vector:{include:"source.yaml",feed:"events"}}},sinks:{custom:{sink:"custom-vector",config:{vector:{include:"sink.yaml"}}}},monitors:[{sinks:["custom"]}]};
    const fragment={sources:{events:{type:"stdin"}}};
    const readInclude=(path:string)=>path==="source.yaml"?fragment:{sinks:{out:{type:"blackhole"}}};
    const normalized=normalize(doc,{readInclude});
    expect(canonicalConfigJson(normalized)).not.toContain("include");
    expect(parse(normalized).input.connections[0]!.selectedSources[0]!.metadata).toHaveProperty("customVector.fragment",fragment);
    const first=await hashConfigDocument(doc,{readInclude});
    expect(await hashConfigDocument(normalized)).toBe(first);
    fragment.sources.events.type="http_server";
    expect(await hashConfigDocument(doc,{readInclude})).not.toBe(first);
  });
  it("validates inline fragments and disallows ambiguous definitions", () => {
    const source={source:"custom-vector",vector:{feed:"events",fragment:{sources:{}}}};
    expect(parse({sources:{source}}).input.connections).toHaveLength(1);
    expect(() => parse({sources:{source:{...source,vector:{...source.vector,include:"x"}}}})).toThrow("choose fragment or include");
    expect(() => parse({sources:{source:{...source,vector:{fragment:[],feed:"events"}}}})).toThrow("expected object");
    expect(() => normalize({sources:{source:{source:"custom-vector",vector:{feed:"events",include:"x"}}}})).toThrow("No include reader");
  });
});

it("preserves legacy keys and labels that already start with entity prefixes",()=>{
 const doc=fixture();const sources=doc.sources as Record<string,unknown>;sources.con_workers=sources.workers;delete sources.workers;
 doc.monitors[0]!.source="con_workers";doc.monitors[0]!.name="mon_errors";
 const before=parse(doc,options);expect(before.input.connections[0]!.selectedSources[0]!.id).toBe("src_con_workers_api");
 expect(before.input.monitors[0]!.sinks[0]!.sink.id).toBe("snk_mon_errors_alerts");
 expect(parse(normalize(doc,options),options)).toEqual(before);
});
