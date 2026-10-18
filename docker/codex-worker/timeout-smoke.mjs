import http from 'node:http';
import assert from 'node:assert/strict';
import {applyUpstreamTimeout,UPSTREAM_IDLE_TIMEOUT_MS,transportFailureCode} from './transport-policy.mjs';
assert.equal(UPSTREAM_IDLE_TIMEOUT_MS,600000);
const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>setTimeout(()=>{if(!res.destroyed)res.end('delayed response')},150));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
async function run(idle){return new Promise(resolve=>{let failure=null;const q=http.request({hostname:'127.0.0.1',port:server.address().port,method:'POST'},r=>{let out='';r.on('data',d=>out+=d);r.on('end',()=>resolve({out,failure}));});applyUpstreamTimeout(q,code=>failure=code,idle);q.on('error',e=>resolve({failure,code:transportFailureCode(e)}));q.end('{}');});}
try{const old=await run(120);assert.equal(old.failure,'UPSTREAM_IDLE_TIMEOUT');assert.equal(old.code,'ETIMEDOUT');const fixed=await run(600);assert.equal(fixed.out,'delayed response');assert.equal(fixed.failure,null);console.log('SCALED_REAL_SOCKET_TIMEOUT_REPRODUCED_AND_FIXED');console.log(JSON.stringify({old,fixed,productionIdleMs:UPSTREAM_IDLE_TIMEOUT_MS}));}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
