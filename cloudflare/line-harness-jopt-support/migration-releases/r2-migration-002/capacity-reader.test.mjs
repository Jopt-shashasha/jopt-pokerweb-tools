import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const text=fs.readFileSync(new URL('./r2-capacity.mjs',import.meta.url),'utf8').replace(/^export .*;\r?$/mg,'');
class Failure extends Error { constructor(status){super(status);this.status=status;} }
function readerWith(request,billingWindow=()=>null){
  const metric=(id,label,used,limit,unit,resetAt)=>({id,label,used,limit,unit,resetAt});
  return new Function('billingWindow','json','capacityMetric','CapacityFailure',text+'\nreturn createHarnessR2CapacityReader();')(billingWindow,request,metric,Failure);
}
const env={CF_ANALYTICS_ACCOUNT_ID:'account',CF_ANALYTICS_TOKEN:'test-only-placeholder'};
test('analytics permissions and malformed/truncated responses never turn into zero usage',async()=>{
  for(const response of [{errors:[{message:'not allowed'}]}, {data:{viewer:{accounts:[]}}}, {data:{viewer:{accounts:[{operations:[],storage:undefined}]}}},
    {data:{viewer:{accounts:[{operations:new Array(1000).fill({}),storage:[]}]}}}]){
    const result=await readerWith(async()=>response)(env);assert.equal(result.status,'unavailable');assert.deepEqual(result.metrics,[]);
  }
  assert.equal((await readerWith(async()=>{throw new Failure('permission_error')})(env)).status,'permission_error');
});
test('unconfirmed billing window is explicitly a 31-day reference with no invented reset timestamp',async()=>{
  let request;
  const read=readerWith(async(url,init)=>{request=JSON.parse(init.body);return {data:{viewer:{accounts:[{operations:[{sum:{requests:4},dimensions:{actionType:'PutObject'}}],storage:[]}]}}};});
  const result=await read(env);assert.equal(result.status,'ready');assert.equal(result.billingPeriodConfirmed,false);
  assert.equal(result.metrics[1].used,4);assert.equal(result.metrics[1].resetAt,null);assert.equal(result.metrics[0].used,null);
  assert.equal(Date.parse(request.variables.to)-Date.parse(request.variables.from),31*86400000);
});
test('confirmed cycle, native account totals and a cache refresh retain their scopes',async()=>{
  let calls=0;const cycle={from:'2026-11-17T00:00:00.000Z',to:'2026-12-17T00:00:00.000Z'};
  const read=readerWith(async()=>{calls++;return {data:{viewer:{accounts:[{operations:[{sum:{requests:8},dimensions:{actionType:'GetObject',storageClass:'Standard'}}],storage:[{max:{payloadSize:100},dimensions:{bucketName:'bucket',datetime:new Date().toISOString()}}]}]}}};},()=>cycle);
  const result=await read(env);assert.equal(result.billingPeriodConfirmed,true);assert.equal(result.metrics[2].used,8);assert.equal(result.metrics[0].used,100);assert.equal(result.metrics[2].resetAt,cycle.to);
  await read(env);assert.equal(calls,1);await read({...env,CF_ANALYTICS_TOKEN:'rotated-test-placeholder'});assert.equal(calls,2);
});
