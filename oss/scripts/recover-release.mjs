import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,copyFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {inventory,validateManifest} from './release-artifacts.mjs';
import {verifyAgentArchives} from './agent-artifacts.mjs';

export const validationSteps=['require every package version to match the release tag','release artifact and recovery guards','build public packages','packed consumer checks','typecheck','real Bun Railway WebSocket helper and delivery','real Bun Vercel streaming helper and delivery','custom Vector named outputs and isolated wildcards','real Supabase polling and Slack delivery','real Supabase refresh sidecar token rotation and delivery','real AI Gateway list fanout and delivery','real Fly CLI transport and structured log delivery','real Prometheus and Datadog encoded metrics delivery','real Vector delivery flow','test'];
export function requiredValidationSteps(tag){
 assert.match(tag??'',/^v\d+\.\d+\.\d+$/);
 const [major,minor,patch]=tag.slice(1).split('.').map(Number);
 if(major>0||minor>3||(minor===3&&patch>=6))return [...validationSteps,'native Claude Code and Codex packages','archive tested skill and plugin release assets'];
 // These gates first shipped in 0.3.2. Retain recovery of older immutable
 // releases using the complete set of gates their workflow actually provided.
 return major>0||minor>3||(minor===3&&patch>=2)?validationSteps:validationSteps.filter(name=>!['real Supabase polling and Slack delivery','real Supabase refresh sidecar token rotation and delivery','real AI Gateway list fanout and delivery','real Fly CLI transport and structured log delivery','real Prometheus and Datadog encoded metrics delivery'].includes(name));
}
export function verifyEvidenceRun(meta,jobs,commit,tag){
 assert.equal(meta.repository.full_name,'logtura/logtura');assert.equal(meta.head_repository.full_name,'logtura/logtura');
 assert.equal(meta.event,'push');assert.equal(meta.status,'completed');assert.equal(meta.head_sha,commit);assert.equal(meta.head_branch,tag);
 assert.equal(meta.path.split('@')[0],'.github/workflows/release.yml');
 const job=jobs.jobs.find(j=>j.name==='release');assert.ok(job,'Missing release job');
 for(const name of requiredValidationSteps(tag))assert.ok(job.steps.some(s=>s.name===name&&s.conclusion==='success'),`Evidence did not pass ${name}`);
}
function command(args){const result=spawnSync(args[0],args.slice(1),{encoding:'utf8',timeout:120000});assert.equal(result.status,0,`${args[0]} failed: ${result.stderr}`);return result.stdout.trim();}
export function recover(runId){
 assert.match(runId??'',/^[1-9]\d*$/);assert.equal(process.env.GITHUB_REPOSITORY,'logtura/logtura');
 const tag=process.env.LOGT_RELEASE_TAG;assert.match(tag??'',/^v\d+\.\d+\.\d+$/);
 const commit=command(['git','rev-parse','HEAD']);
 const meta=JSON.parse(command(['gh','api',`repos/logtura/logtura/actions/runs/${runId}`]));
 const jobs=JSON.parse(command(['gh','api',`repos/logtura/logtura/actions/runs/${runId}/jobs?per_page=100`]));
 verifyEvidenceRun(meta,jobs,commit,tag);
 mkdirSync('.tmp',{recursive:true});const download=mkdtempSync(resolve('.tmp/recovery-evidence-'));
 command(['gh','run','download',runId,'--repo','logtura/logtura','--name','release-evidence','--dir',download]);
 const source=join(download,'.tmp/release'),manifest=JSON.parse(readFileSync(join(source,'manifest.json'),'utf8'));
 assert.equal(manifest.sourceCommit,commit);
 const rows=validateManifest(manifest,inventory(process.cwd()),tag,file=>readFileSync(join(source,file)));
 const target=resolve('.tmp/release');assert.ok(!existsSync(target),'Recovery refuses an existing release output directory');mkdirSync(target);
 for(const row of rows)copyFileSync(join(source,row.file),join(target,row.file));
 copyFileSync(join(source,'manifest.json'),join(target,'manifest.json'));
 if(requiredValidationSteps(tag).includes('archive tested skill and plugin release assets')){
  const agents=verifyAgentArchives(join(source,'agents'),tag.slice(1));
  mkdirSync(join(target,'agents'));
  for(const file of [...Object.keys(agents.files),'agent-artifacts.json'])copyFileSync(join(source,'agents',file),join(target,'agents',file));
 }
 writeFileSync(join(target,'recovery-evidence.json'),JSON.stringify({schemaVersion:1,sourceRun:runId,tag,sourceCommit:commit,validatedSteps:requiredValidationSteps(tag),archives:rows.length},null,2)+'\n');
 console.log(`Recovered ${rows.length} exact tested archives from validated tag run ${runId}`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){assert.equal(process.argv.length,3);recover(process.argv[2]);}
