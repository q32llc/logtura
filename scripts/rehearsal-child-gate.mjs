// Loaded by Node before Wrangler's actual main module. Provider work cannot
// begin until the parent has persisted this process's PID in its private ledger.
const go=await new Promise(resolve=>{process.stdin.once('data',bytes=>resolve(bytes.toString().trim()==='go'));process.stdin.once('end',()=>resolve(false));});
if(!go)process.exit(1);
