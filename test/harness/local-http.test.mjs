import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {localHttpFetch} from '../e2e/local-http.mjs';
async function server(t,handler){const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));return `http://127.0.0.1:${server.address().port}`;}
test('local workerd transport preserves request bodies and uses distinct sockets',async t=>{
 const sockets=new Set(),requests=[];
 const url=await server(t,(request,response)=>{sockets.add(request.socket);let body='';request.on('data',bytes=>body+=bytes);request.on('end',()=>{requests.push({body,cookie:request.headers.cookie,connection:request.headers.connection});response.writeHead(201,{'content-type':'application/json'});response.end(JSON.stringify({body}));});});
 for(let i=0;i<3;i++){const response=await localHttpFetch(new Request(url,{method:'POST',headers:{cookie:'session=fixture'},body:String(i)}));assert.equal(response.status,201);assert.deepEqual(await response.json(),{body:String(i)});}
 assert.equal(sockets.size,3);assert.deepEqual(requests.map(r=>r.body),['0','1','2']);assert.ok(requests.every(r=>r.cookie==='session=fixture'&&r.connection==='close'));
});
test('an uncertain local mutation is never automatically replayed',async t=>{
 let dispatched=0;const url=await server(t,(request)=>{dispatched++;request.socket.destroy();});
 await assert.rejects(localHttpFetch(new Request(url,{method:'POST',body:'intent'})));assert.equal(dispatched,1);
});
test('local transport refuses provider origins and retains empty HTTP responses',async t=>{
 await assert.rejects(localHttpFetch('https://api.cloudflare.com/'));
 await assert.rejects(localHttpFetch('http://localhost:1234/'));
 const url=await server(t,(_,response)=>{response.writeHead(204);response.end();});
 const response=await localHttpFetch(url);assert.equal(response.status,204);assert.equal(await response.text(),'');
});
