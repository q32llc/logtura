import {resolve} from "node:path";
import {runRoutingLifecycle,cleanupRoutingLifecycle} from "../test/e2e/lifecycle";
import {FileRunLedger} from "../test/e2e/file-ledger";
import {targetOrigin} from "../test/e2e/run-ledger";
const baseUrl=process.env.LOGT_E2E_URL,sessionCookie=process.env.LOGT_E2E_SESSION_COOKIE,expectedUserId=process.env.LOGT_E2E_USER_ID;
if(!baseUrl || !sessionCookie || !expectedUserId)throw new Error("Set LOGT_E2E_URL, LOGT_E2E_SESSION_COOKIE and LOGT_E2E_USER_ID for a disposable test account");
const origin=targetOrigin(baseUrl),url=new URL(origin),remote=!["localhost","127.0.0.1","[::1]"].includes(url.hostname);
if(remote && (process.env.LOGT_E2E_ALLOW_REMOTE!=="1" || url.protocol!=="https:"))throw new Error("Remote E2E requires HTTPS and LOGT_E2E_ALLOW_REMOTE=1");
const cleanup=process.argv.includes("--cleanup");if(process.argv.slice(2).some(arg=>arg!=="--cleanup"))throw new Error("Usage: e2e-http.ts [--cleanup]");if(cleanup && !process.env.LOGT_E2E_LEDGER)throw new Error("Cleanup requires LOGT_E2E_LEDGER");
const runId=crypto.randomUUID(),path=resolve(process.env.LOGT_E2E_LEDGER??`.tmp/e2e-ledgers/${runId}.json`),ledger=new FileRunLedger(path);
console.log(`Routing ${cleanup?"cleanup":"lifecycle"} target: ${origin}. Private run ledger: ${path}`);
await ledger.runExclusive(async()=>{
 const saved=cleanup?await ledger.read():null;if(cleanup && !saved)throw new Error("E2E cleanup ledger not found");
 const target={baseUrl:origin,sessionCookie,expectedUserId,runId:saved?.runId??runId,ledger,fetch:(request:Request)=>fetch(request)};
 if(cleanup)await cleanupRoutingLifecycle(target);else await runRoutingLifecycle(target);
});
console.log(`Routing ${cleanup?"cleanup":"lifecycle"} passed. Private run ledger: ${path}`);
