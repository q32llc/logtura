import { expect,it } from "vitest";
import { encode,decode } from "@msgpack/msgpack";
import { flyDriver } from "../../src/deploy-targets/fly";
import { DeployTargetError } from "../../src/deploy-targets/types";
import { parseFlyTokenSegments } from "../../src/deploy-targets/fly-macaroon";
import { renderFlyToml,type GeneratedBundle } from "@logtura/core";
import { mockFetch } from "./_setup";
const bundle:GeneratedBundle={dockerfile:"FROM scratch",vectorYaml:"sources: {}",runCommand:"",runtimeAssets:[],componentManifest:[],selectedCount:0,monitorSummary:"",envVars:[{name:"TOKEN",value:"fixture-value",source:"credential",description:"token"},{name:"MISSING",value:null,source:"credential",description:"required"}]};
it("parses target forms and verifies the supplied token without exposing provider errors", async () => {
 expect(()=>flyDriver.parseFormData(new FormData())).toThrow(DeployTargetError);
 const form=new FormData();form.set("api_token","  fo1_fixture  ");
 expect(flyDriver.parseFormData(form)).toEqual({credentials:{apiToken:"fo1_fixture"},explicitAccountId:null});
 form.set("org_slug","  team  ");expect(flyDriver.parseFormData(form).explicitAccountId).toBe("team");
 mockFetch("https://api.fly.io/api/v1/apps",req=>{expect(req.headers.get("authorization")).toBe("Bearer fo1_fixture");return Response.json({apps:[]});});
 expect(await flyDriver.verifyCredentials({apiToken:"fo1_fixture"})).toEqual([{id:"personal",name:"personal"}]);
 mockFetch("https://api.fly.io/api/v1/apps",()=>new Response("private-provider-response",{status:403}));
 await expect(flyDriver.verifyCredentials({apiToken:"fo1_fixture"})).rejects.toMatchObject({status:403,message:"Fly token verification failed: HTTP 403"});
});
it("uses the public self-deploy renderer and retains bundle files, secrets and app identity fallbacks", () => {
 const result=flyDriver.generateTargetBundle({sourceBundle:bundle,deploymentName:"  Production Forwarder! ",connectionId:"con_fallback",region:"ord"});
 expect(result.files.find(f=>f.name==="fly.toml")!.content).toBe(renderFlyToml({appName:"logtura-production-forwarder",region:"ord",envVars:["TOKEN","MISSING"]}));
 expect(result.files.map(f=>f.name)).toEqual(["Dockerfile","vector.yaml","fly.toml","deploy.sh"]);
 expect(result.files[3]!.content).toContain("'TOKEN=fixture-value'");expect(result.files[3]!.content).toContain('MISSING=${MISSING}');
 expect(result.files[3]!.content).toContain("--region ord");expect(result.selfDeployInstructions).toContain("logtura-production-forwarder");
 const fallback=flyDriver.generateTargetBundle({sourceBundle:{...bundle,envVars:[]},deploymentName:"!",connectionId:"con_ABC"});
 expect(fallback.files[2]!.content).toContain('app = "logtura-conabc"');expect(fallback.files[2]!.content).toContain('primary_region = "iad"');
 expect(fallback.files[3]!.content).not.toContain("--region");
});
function permissionToken(){const bytes=encode([[new Uint8Array([1]),new Uint8Array([2])],"https://api.fly.io/v1",[0,[7,31]],new Uint8Array(32).fill(1)]);let raw="";for(const byte of bytes)raw+=String.fromCharCode(byte);return `FlyV1 fm2_${btoa(raw)}`;}
it.each([
 {orgs:[{id:"team-id",slug:"team"},{id:"personal-id",slug:"personal"}],scope:undefined,wanted:"personal-id"},
 {orgs:[{id:"team-id",slug:"team"}],scope:undefined,wanted:"team-id"},
 {orgs:[{id:"team-id",slug:"team"},{id:"personal-id",slug:"personal"}],scope:"team",wanted:"team-id"},
])("mints an attenuated read-only credential for the selected organization: $wanted", async ({orgs,scope,wanted}) => {
 let minted=0;
 mockFetch("https://api.fly.io/graphql",async req=>{const body=await req.json() as any;
  expect(req.headers.get("authorization")).toContain("fo1_fixture");
  if(body.query.includes("organizations"))return Response.json({data:{organizations:{nodes:orgs}}});
  expect(body.variables.input).toMatchObject({organizationId:wanted,profile:"deploy_organization"});minted++;
  return Response.json({data:{createLimitedAccessToken:{limitedAccessToken:{tokenHeader:permissionToken()}}}});
 });
 const result=await flyDriver.mintConnectionCredentials!({bootstrapCredentials:{apiToken:"fo1_fixture"},providerId:"fly-log-tail",scope});
 expect(minted).toBe(1);expect(result.externalAccountId).toBe(orgs.find(o=>o.id===wanted)!.slug);
 const token=String(result.apiToken),segments=parseFlyTokenSegments(token);const permission=segments.find(s=>s.kind==="macaroon");expect(permission?.kind).toBe("macaroon");
 if(permission?.kind!=="macaroon")throw new Error("Missing permission macaroon");
 expect((decode(permission.raw) as unknown[])[2]).toEqual([0,[7,31],0,[7,1]]);
});
it("refuses unsupported providers, empty inventory and a missing explicit org before minting", async () => {
 await expect(flyDriver.mintConnectionCredentials!({bootstrapCredentials:{apiToken:"fo1_fixture"},providerId:"other"})).rejects.toMatchObject({status:400});
 for(const orgs of [[],[{id:"personal-id",slug:"personal"}]]){
  let minted=false;mockFetch("https://api.fly.io/graphql",async req=>{const body=await req.json() as any;if(!body.query.includes("organizations"))minted=true;return Response.json({data:{organizations:{nodes:orgs}}});});
  await expect(flyDriver.mintConnectionCredentials!({bootstrapCredentials:{apiToken:"fo1_fixture"},providerId:"fly-log-tail",scope:"unavailable"})).rejects.toMatchObject({status:400});expect(minted).toBe(false);
 }
 mockFetch("https://api.fly.io/graphql",()=>Response.json({data:{organizations:{nodes:[]}}}));
 await expect(flyDriver.mintConnectionCredentials!({bootstrapCredentials:{apiToken:"fo1_fixture"},providerId:"fly-log-tail"})).rejects.toMatchObject({status:400});
});
it("preserves text and binary runtime assets in the JSON self-deploy response", () => {
 const result = flyDriver.generateTargetBundle({sourceBundle: {...bundle, runtimeAssets: [
  {driverId: "custom", path: "nested/helper.bin", content: new Uint8Array([0, 255, 128, 10, 13]), mode: 0o700},
  {driverId: "custom", path: "helper.js", content: "console.log('café')"},
 ]}, deploymentName: "Test", connectionId: "fixture"});
 const json = JSON.parse(JSON.stringify(result));
 expect(json.files[4]).toEqual({name: "assets/custom/nested/helper.bin", content: "AP+ACg0=", encoding: "base64", mode: 0o700});
 expect(json.files[5]).toEqual({name: "assets/custom/helper.js", content: "console.log('café')", mode: 0o644});
 expect(json.selfDeployInstructions).toContain("assets/ subdirectories");
});
