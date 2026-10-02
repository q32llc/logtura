import {createHash} from "node:crypto";
// Config blobs, platform manifests and indexes have distinct content identities.
const digest=(bytes:string)=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const configDigest=`sha256:${"a".repeat(64)}`;
export const manifest=JSON.stringify({schemaVersion:2,mediaType:"application/vnd.oci.image.manifest.v1+json",config:{mediaType:"application/vnd.oci.image.config.v1+json",digest:configDigest,size:12},layers:[]});
export const platformDigest=digest(manifest),image=`registry.test/forwarder@${platformDigest}`;
export const index=JSON.stringify({schemaVersion:2,mediaType:"application/vnd.oci.image.index.v1+json",manifests:[{mediaType:"application/vnd.oci.image.manifest.v1+json",digest:platformDigest,size:Buffer.byteLength(manifest),platform:{os:"linux",architecture:"amd64"}}]});
export const indexDigest=digest(index),indexImage=`registry.test/forwarder@${indexDigest}`;
export function registryBody(path:string):string|null {
 return path===`/v2/forwarder/manifests/${platformDigest}`?manifest:path===`/v2/forwarder/manifests/${indexDigest}`?index:null;
}
