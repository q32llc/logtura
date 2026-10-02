import { expect, it, vi } from "vitest";
import { resolveFlyImage } from "../src/oci-image";
const manifestType="application/vnd.oci.image.manifest.v1+json",indexType="application/vnd.oci.image.index.v1+json";
const manifest={schemaVersion:2,mediaType:manifestType,config:{digest:`sha256:${"b".repeat(64)}`},layers:[]};
async function encoded(value:unknown){const body=JSON.stringify(value),hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(body));return {body,digest:`sha256:${[...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,"0")).join("")}`};}
async function fixture(root?:unknown){const child=await encoded(manifest),index=await encoded(root??{schemaVersion:2,mediaType:indexType,manifests:[{digest:child.digest,size:Buffer.byteLength(child.body),mediaType:manifestType,platform:{os:"linux",architecture:"amd64"}},{digest:`sha256:${"c".repeat(64)}`,size:100,mediaType:manifestType,platform:{os:"unknown",architecture:"unknown"}}]});const image=`registry.test/repo/forwarder@${index.digest}`,fetcher=vi.fn<typeof fetch>(async(url)=>{const body=String(url).endsWith(child.digest)?child.body:index.body;return new Response(body,{headers:{"docker-content-digest":String(url).split("/").at(-1)!}});});return {child,index,image,fetcher};}
it("hash-verifies the root and unique platform bytes, ignores attestation digests, and scopes credentials",async()=>{
 const f=await fixture();expect(await resolveFlyImage(f.image,{fetch:f.fetcher,token:"private-token"})).toEqual({requestedImage:f.image,image:`registry.test/repo/forwarder@${f.child.digest}`,rootDigest:f.index.digest,platformDigest:f.child.digest});expect(f.fetcher).toHaveBeenCalledTimes(2);
 for(const [url,init] of f.fetcher.mock.calls){expect(new URL(String(url)).origin).toBe("https://registry.test");expect(init).toMatchObject({credentials:"omit",redirect:"manual",headers:{authorization:"Bearer private-token"}});expect(init!.signal).toBeInstanceOf(AbortSignal);}
});
it.each([manifestType,"application/vnd.docker.distribution.manifest.v2+json"])("accepts a verified direct %s manifest without substituting its config digest",async mediaType=>{
 const f=await fixture({...manifest,mediaType});const result=await resolveFlyImage(f.image,{fetch:f.fetcher});expect(result.image).toBe(f.image);expect(result.platformDigest).not.toBe(manifest.config.digest);expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it.each(["token","access_token"])("acquires anonymous scoped bearer %s on the same registry without sending caller credentials to a realm",async field=>{
 const f=await fixture();let calls=0;const fetcher=vi.fn<typeof fetch>(async(url,init)=>{calls++;if(calls===1)return new Response(null,{status:401,headers:{"www-authenticate":'Bearer realm="https://registry.test/token?scope=administrator",service="registry.test"'}});if(String(url).includes("/token")){expect(new URL(String(url)).searchParams.get("scope")).toBe("repository:repo/forwarder:pull");expect(init!.headers).not.toHaveProperty("authorization");return Response.json({[field]:"scoped-token"});}expect(init!.headers).toHaveProperty("authorization","Bearer scoped-token");return f.fetcher(url,init);});
 expect((await resolveFlyImage(f.image,{fetch:fetcher})).platformDigest).toBe(f.child.digest);expect(calls).toBe(4);
});
it("allows Docker Hub's documented separate anonymous token origin",async()=>{
 const f=await fixture(manifest),image=f.image.replace("registry.test","registry-1.docker.io");let calls=0;const fetcher:typeof fetch=async(url,init)=>{calls++;if(calls===1)return new Response(null,{status:401,headers:{"www-authenticate":'Bearer realm="https://auth.docker.io/token"'}});if(String(url).startsWith("https://auth.docker.io"))return Response.json({token:"docker-scoped"});return f.fetcher(url,init);};expect((await resolveFlyImage(image,{fetch:fetcher})).image).toBe(image);
});
it("refuses redirects, malformed challenges, unsafe/cross-origin realms and provider bodies",async()=>{
 const f=await fixture();for(const challenge of ["",'Basic realm="private"','Bearer','Bearer realm="invalid"','Bearer realm="http://registry.test/token"','Bearer realm="https://other.test/token"','Bearer realm="https://user:secret@registry.test/token"','Bearer realm="https://registry.test/token#fragment"']){const fetcher=vi.fn<typeof fetch>(async()=>new Response("private-response",{status:401,headers:{"www-authenticate":challenge}}));const error=await resolveFlyImage(f.image,{fetch:fetcher}).catch(error=>error);expect(error.message).not.toContain("private-response");expect(fetcher).toHaveBeenCalledTimes(1);}
 for(const status of [302,403,404,429,500]){const error=await resolveFlyImage(f.image,{token:"token",fetch:async()=>new Response("private-response",{status})}).catch(error=>error);expect(error.message).toContain(`HTTP ${status}`);expect(error.message).not.toContain("private-response");}
});
it("refuses failed or invalid anonymous grants and does not retry rejected explicit credentials",async()=>{
 const f=await fixture();for(const value of [null,[],{}, {token:""},{token:"bad token"},{token:1},{token:"x".repeat(65_537)}]){let calls=0;await expect(resolveFlyImage(f.image,{fetch:async()=>++calls===1?new Response(null,{status:401,headers:{"www-authenticate":'Bearer realm="https://registry.test/token"'}}):Response.json(value)})).rejects.toThrow();expect(calls).toBe(2);}
 let calls=0;await expect(resolveFlyImage(f.image,{fetch:async()=>++calls===1?new Response(null,{status:401,headers:{"www-authenticate":'Bearer realm="https://registry.test/token"'}}):new Response("private",{status:403})})).rejects.toThrow("token request failed (HTTP 403)");
 const fetcher=vi.fn<typeof fetch>(async()=>new Response(null,{status:401}));await expect(resolveFlyImage(f.image,{fetch:fetcher,token:"explicit"})).rejects.toThrow("HTTP 401");expect(fetcher).toHaveBeenCalledTimes(1);
});
it("validates image pins, timeout intervals and credential tokens before requests",async()=>{
 for(const image of ["latest","registry.test/image:latest"])await expect(resolveFlyImage(image)).rejects.toThrow("pinned");const f=await fixture();for(const timeoutMs of [0,NaN,0.1,120_001])await expect(resolveFlyImage(f.image,{fetch:f.fetcher,timeoutMs})).rejects.toThrow("timeout");for(const token of ["","token\nsecret","token secret","x".repeat(65_537)])await expect(resolveFlyImage(f.image,{fetch:f.fetcher,token})).rejects.toThrow("token");expect(f.fetcher).not.toHaveBeenCalled();
});
it("rejects swapped manifest bytes and mismatched declared digest headers",async()=>{
 const f=await fixture();await expect(resolveFlyImage(f.image,{fetch:async()=>Response.json(manifest)})).rejects.toThrow("digest mismatch");await expect(resolveFlyImage(f.image,{fetch:async()=>new Response(f.index.body,{headers:{"docker-content-digest":f.child.digest}})})).rejects.toThrow("digest mismatch");
 const swapped=await fixture();await expect(resolveFlyImage(swapped.image,{fetch:async url=>String(url).endsWith(swapped.index.digest)?new Response(swapped.index.body):Response.json({...manifest,config:{digest:`sha256:${"c".repeat(64)}`}})})).rejects.toThrow("digest mismatch");
});
it("rejects invalid schema, indexes, ambiguous/missing platforms and malformed child descriptors",async()=>{
 for(const root of [{...manifest,schemaVersion:1},{...manifest,mediaType:0},{schemaVersion:2,mediaType:indexType,manifests:{}},{schemaVersion:2,mediaType:indexType,manifests:Array(1001).fill({})},{...manifest,config:null},{...manifest,config:{digest:"bad"}},{...manifest,layers:null},{...manifest,mediaType:"other"}]){const f=await fixture(root);await expect(resolveFlyImage(f.image,{fetch:f.fetcher})).rejects.toThrow();}
 const child=await encoded(manifest),descriptor={digest:child.digest,size:Buffer.byteLength(child.body),mediaType:manifestType,platform:{os:"linux",architecture:"amd64"}};
 for(const descriptors of [[],[null,{}],[{...descriptor,platform:{os:"linux",architecture:"arm64"}}],[{...descriptor,platform:{...descriptor.platform,variant:"v2"}}],[descriptor,descriptor],[{...descriptor,digest:1}],[{...descriptor,digest:"bad"}],[{...descriptor,mediaType:indexType}],[{...descriptor,size:0}],[{...descriptor,size:1_048_577}],[{...descriptor,size:1.5}]]){const f=await fixture({schemaVersion:2,mediaType:indexType,manifests:descriptors});await expect(resolveFlyImage(f.image,{fetch:f.fetcher})).rejects.toThrow();}
 const f=await fixture({schemaVersion:2,mediaType:"application/vnd.docker.distribution.manifest.list.v2+json",manifests:[{...descriptor,platform:{...descriptor.platform,variant:"v1"}}]});expect((await resolveFlyImage(f.image,{fetch:f.fetcher})).platformDigest).toBe(child.digest);
});
it("bounds and cancels manifest/grant streams and rejects invalid UTF-8/JSON without exposing their contents",async()=>{
 const f=await fixture();let cancelled=false;const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(1_048_577));},cancel(){cancelled=true;}});await expect(resolveFlyImage(f.image,{fetch:async()=>new Response(stream)})).rejects.toThrow("size limit");expect(cancelled).toBe(true);
 await expect(resolveFlyImage(f.image,{fetch:async()=>new Response(null)})).rejects.toThrow("Invalid registry response");
 for(const response of [new Response("private broken JSON"),new Response(new Uint8Array([255]))]){let calls=0;await expect(resolveFlyImage(f.image,{fetch:async()=>++calls===1?new Response(null,{status:401,headers:{"www-authenticate":'Bearer realm="https://registry.test/token"'}}):response})).rejects.toThrow("Invalid registry JSON");}
 let calls=0;await expect(resolveFlyImage(f.image,{fetch:async()=>++calls===1?new Response(null,{status:401,headers:{"www-authenticate":'Bearer realm="https://registry.test/token"'}}):new Response("x".repeat(65_537))})).rejects.toThrow("size limit");
 const broken=new ReadableStream({pull(controller){controller.error(new Error("reader failure"));}});await expect(resolveFlyImage(f.image,{fetch:async()=>new Response(broken)})).rejects.toThrow("reader failure");
});
it("rejects an index descriptor whose size does not match its verified child bytes",async()=>{
 const child=await encoded(manifest),f=await fixture({schemaVersion:2,mediaType:indexType,manifests:[{digest:child.digest,size:Buffer.byteLength(child.body)+1,mediaType:manifestType,platform:{os:"linux",architecture:"amd64"}}]});await expect(resolveFlyImage(f.image,{fetch:f.fetcher})).rejects.toThrow("platform size mismatch");
});
it("uses the default fetch transport and safely rejects a challenge with no header",async()=>{
 const f=await fixture();vi.stubGlobal("fetch",f.fetcher);try{expect((await resolveFlyImage(f.image)).platformDigest).toBe(f.child.digest);}finally{vi.unstubAllGlobals();}
 await expect(resolveFlyImage(f.image,{fetch:async()=>new Response(null,{status:401})})).rejects.toThrow("explicit pull credentials");
});
