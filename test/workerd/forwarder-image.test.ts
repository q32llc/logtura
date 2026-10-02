import { expect, it } from "vitest";
import {resolveForwarderDigest,forwarderImageRef} from "../../src/forwarder-image";
import {mockFetch} from "./_setup";
const mediaType="application/vnd.oci.image.manifest.v1+json",body=JSON.stringify({schemaVersion:2,mediaType,config:{digest:`sha256:${"b".repeat(64)}`},layers:[]});
const digest=`sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(body)))].map(byte=>byte.toString(16).padStart(2,"0")).join("")}`;
it.each(["token","access_token"])("resolves a tag using %s and verifies immutable registry bytes before returning a platform pin",async field=>{
 mockFetch("https://ghcr.io/token", req=>{expect(req.redirect).toBe("manual");expect(req.signal.aborted).toBe(false);return Response.json({[field]:"fixture-token"});});
 mockFetch("https://ghcr.io/v2/",req=>{expect(req.redirect).toBe("manual");expect(req.headers.get("authorization")).toBe("Bearer fixture-token");if(req.method==="HEAD"){expect(new URL(req.url).pathname.endsWith("release%2Ftest")).toBe(true);return new Response(null,{headers:{"docker-content-digest":digest}});}expect(new URL(req.url).pathname.endsWith(digest)).toBe(true);return new Response(body);});expect(await resolveForwarderDigest("release/test")).toBe(digest);expect(forwarderImageRef(digest)).toBe(`ghcr.io/q32llc/logtura-forwarder@${digest}`);
});
it("uses the default latest tag",async()=>{
 mockFetch("https://ghcr.io/token",()=>Response.json({token:"fixture"}));mockFetch("https://ghcr.io/v2/",req=>req.method==="HEAD"?new Response(null,{headers:{"docker-content-digest":digest}}):new Response(body));expect(await resolveForwarderDigest()).toBe(digest);
});
it("rejects token HTTP/JSON/schema failures without returning provider response bodies",async()=>{
 for(const response of [new Response("private provider detail",{status:503}),new Response("private broken JSON"),Response.json(null),Response.json([]),Response.json({}),Response.json({token:1}),Response.json({token:""})]){mockFetch("https://ghcr.io/token",()=>response);const error=await resolveForwarderDigest().catch(error=>error);expect(error).toBeInstanceOf(Error);expect(error.message).not.toContain("private");}
});
it("rejects failed HEAD responses and invalid digest headers",async()=>{
 mockFetch("https://ghcr.io/token",()=>Response.json({token:"fixture"}));for(const response of [new Response("private details",{status:500}),new Response(null),new Response(null,{headers:{"docker-content-digest":"sha256:bad"}})]){mockFetch("https://ghcr.io/v2/",()=>response);const error=await resolveForwarderDigest().catch(error=>error);expect(error).toBeInstanceOf(Error);expect(error.message).not.toContain("private details");}
});
