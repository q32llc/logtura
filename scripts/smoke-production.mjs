import {lstatSync,readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';

export const PRODUCTION_ORIGIN='https://logtura.com';
export const PRODUCTION_DEPLOYMENT='dep_Zs5ETbGsU1hiKHGoKczrJw';
/** Read-only production probe. Credential data and provider configuration never
 * enter its result or error messages. This is an operator command, not PR CI. */
export async function smokeProduction({authFile=process.env.LOGT_SMOKE_AUTH_FILE??'.local/logtura/production-smoke.json',fetch:fetchImpl=fetch,now=Date.now()}={}) {
  let credential;
  try {
    const file=lstatSync(authFile),directory=lstatSync(dirname(authFile));
    if(!file.isFile() || file.isSymbolicLink() || !directory.isDirectory() || directory.isSymbolicLink() || (process.platform!=='win32' && ((file.mode&0o077)!==0 || (directory.mode&0o077)!==0)) || file.size>4096)throw new Error();
    credential=JSON.parse(readFileSync(authFile,'utf8'));
    if(credential.service!==PRODUCTION_ORIGIN || !/^lt_cli_[A-Za-z0-9_-]{43}$/.test(credential.token) || credential.scope!=='account:read account:write' || !Number.isSafeInteger(credential.expiresAt) || credential.expiresAt<=now)throw new Error();
  }catch{throw new Error('Production smoke credential is missing, expired or not a private production account file');}
  async function get(path){
    let response;
    try{response=await fetchImpl(`${PRODUCTION_ORIGIN}/api${path}`,{method:'GET',redirect:'manual',credentials:'omit',headers:{authorization:`Bearer ${credential.token}`,accept:'application/json'},signal:AbortSignal.timeout(20000)});}catch{throw new Error('Production smoke request failed');}
    if(!response.ok)throw new Error(`Production smoke request returned HTTP ${response.status}`);
    try{return await response.json();}catch{throw new Error('Production smoke response is not JSON');}
  }
  const identity=await get('/me');if(!identity?.user?.id || !identity.user.githubLogin)throw new Error('Production smoke account identity is missing');
  const {deployment}=await get(`/deployments/${PRODUCTION_DEPLOYMENT}`);
  if(!deployment || deployment.id!==PRODUCTION_DEPLOYMENT || deployment.status!=='running' || !Number.isSafeInteger(deployment.lastSeenAt) || now-deployment.lastSeenAt>10*60_000 || deployment.lastSeenAt>now+60_000)throw new Error('Production forwarder is not running with a recent heartbeat');
  const {state}=await get(`/deployments/${PRODUCTION_DEPLOYMENT}/config/state`);
  if(state!==null && (!state || !state.desired || !Number.isSafeInteger(state.desired.sequence)))throw new Error('Production configuration state is malformed');
  return {service:PRODUCTION_ORIGIN,deploymentId:PRODUCTION_DEPLOYMENT,status:deployment.status,heartbeatAgeSeconds:Math.floor((now-deployment.lastSeenAt)/1000),desiredSequence:state?.desired.sequence??null,appliedSequence:state?.applied?.sequence??null,configurationCurrent:!!state && !state.stale && state.lastReportSequence>0 && state.applied?.sequence===state.desired.sequence && state.applied?.revision===state.desired.revision};
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{console.log(JSON.stringify(await smokeProduction()));}catch(error){console.error(error.message);process.exitCode=1;}
}
