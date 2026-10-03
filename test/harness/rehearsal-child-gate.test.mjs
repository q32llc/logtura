import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
function child(){const c=spawn(process.execPath,['--import',resolve('scripts/rehearsal-child-gate.mjs'),resolve('node_modules/wrangler/wrangler-dist/cli.js'),'--version'],{env:{...process.env,NODE_OPTIONS:'',WRANGLER_SEND_METRICS:'false'},stdio:['pipe','pipe','pipe']});let text='';c.stdout.on('data',b=>text+=b);c.stderr.on('data',b=>text+=b);const timer=setTimeout(()=>c.kill('SIGKILL'),5000);const result=new Promise((r,j)=>{c.once('error',j);c.once('close',(code,signal)=>{clearTimeout(timer);r({code,signal,text});});});return {c,result,text:()=>text};}
test('actual Wrangler main waits for the durable PID acknowledgement and runs after go',async()=>{const x=child();await new Promise(r=>setTimeout(r,150));assert.equal(x.text(),'');x.c.stdin.end('go\n');const result=await x.result;assert.equal(result.code,0,result.text);assert.match(result.text,/3\.114\.17/);});
test('a parent disappearing before acknowledgement prevents all Wrangler execution',async()=>{const x=child();x.c.stdin.end();const result=await x.result;assert.equal(result.code,1);assert.equal(result.text,'');});
