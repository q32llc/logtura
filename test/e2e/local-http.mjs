import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';

// Each local workerd exchange owns one socket. A closed keep-alive socket must
// never turn a mutation into an implicit retry or a misleading EPIPE failure.
export async function localHttpFetch(input,init){
 const request=input instanceof Request&&!init?input:new Request(input,init);
 const url=new URL(request.url);
 assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');
 assert.equal(url.username,'');assert.equal(url.password,'');
 const body=request.body?Buffer.from(await request.arrayBuffer()):null;
 const headers=Object.fromEntries(request.headers);headers.connection='close';
 if(body)headers['content-length']=String(body.length);
 return new Promise((resolve,reject)=>{
  const outgoing=httpRequest(url,{method:request.method,headers,agent:false,signal:request.signal},incoming=>{
   const chunks=[];let size=0;
   incoming.on('error',reject);
   incoming.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024)incoming.destroy(new Error('Local HTTP response exceeds limit'));else chunks.push(chunk);});
   incoming.on('end',()=>{
    const headers=new Headers();for(let i=0;i<incoming.rawHeaders.length;i+=2)headers.append(incoming.rawHeaders[i],incoming.rawHeaders[i+1]);
    const status=incoming.statusCode;
    resolve(new Response(request.method==='HEAD'||[204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers}));
   });
  });
  outgoing.on('error',reject);outgoing.end(body);
 });
}
