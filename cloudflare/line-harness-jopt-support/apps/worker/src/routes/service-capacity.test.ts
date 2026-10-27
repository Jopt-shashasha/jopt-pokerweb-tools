import {afterEach,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import {cloudflareTraffic} from './cloudflare-traffic.js';
import {billingWindow,capacityMetric,createCapacityReader,type CapacityEnv} from '../services/service-capacity.js';
const env:CapacityEnv={CF_ANALYTICS_ACCOUNT_ID:'account',CF_ANALYTICS_TOKEN:'cf-read-secret',CF_CAPACITY_PLAN:'free',APPWRITE_ENDPOINT:'https://fra.cloud.appwrite.io/v1',APPWRITE_PROJECT_ID:'project',APPWRITE_USAGE_API_KEY:'usage-read-secret',APPWRITE_BILLING_ANCHOR:'2026-10-17T00:00:00.000Z',APPWRITE_BANDWIDTH_LIMIT_BYTES:'5000000000',APPWRITE_STORAGE_LIMIT_BYTES:'2000000000'};
const cf={data:{viewer:{accounts:[{workers:[{sum:{requests:700}}],d1:[{sum:{rowsRead:110000,rowsWritten:800}}],storage:[{dimensions:{databaseId:'one'},max:{databaseSizeBytes:2000000}},{dimensions:{databaseId:'two'},max:{databaseSizeBytes:3000000}}]}]}},errors:null};
function mock(){return vi.spyOn(globalThis,'fetch').mockImplementation(async(url)=>{
  if(String(url).includes('cloudflare.com'))return new Response(JSON.stringify(cf));
  const metrics=String(url).includes('/gauges')?[{metric:'files.storage',points:[{value:3100000}]}]:[{metric:'network.inbound',points:[{value:12000000}]},{metric:'network.outbound',points:[{value:25000000}]}];
  return new Response(JSON.stringify({interval:'',metrics}));
});}
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
it('computes bounded remaining capacity and 75/90/100 percent operational states',()=>{
  expect(capacityMetric('a','a',null,100,'count',null).remaining).toBeNull();
  expect(capacityMetric('a','a',10,null,'count',null).severity).toBe('unknown');
  expect(capacityMetric('a','a',75,100,'count',null).severity).toBe('warning');
  expect(capacityMetric('a','a',90,100,'count',null).severity).toBe('critical');
  expect(capacityMetric('a','a',110,100,'count',null)).toMatchObject({remaining:0,severity:'exhausted'});
});
it('uses the actual billing anchor rather than calendar-month or JST assumptions',()=>{
  expect(billingWindow(env.APPWRITE_BILLING_ANCHOR,new Date('2026-11-16T20:00:00Z'))).toEqual({from:'2026-10-17T00:00:00.000Z',to:'2026-11-17T00:00:00.000Z'});
  expect(billingWindow('2026-01-31T06:00:00Z',new Date('2026-02-28T07:00:00Z'))).toEqual({from:'2026-02-28T06:00:00.000Z',to:'2026-03-31T06:00:00.000Z'});
  expect(billingWindow(undefined)).toBeNull();
});
it('reads account-wide official counters, not just this Worker, and keeps provider scopes distinct',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-26T06:00:00Z'));const network=mock();
  const result=await createCapacityReader()(env);
  expect(result.cloudflare.metrics[0]).toMatchObject({used:700,remaining:99300,resetAt:'2026-10-27T00:00:00.000Z'});
  expect(result.cloudflare.metrics[3]).toMatchObject({used:5000000,remaining:4995000000});
  expect(result.appwrite.metrics[0]).toMatchObject({used:37000000,remaining:4963000000});
  expect(result.appwrite.metrics[1]).toMatchObject({used:3100000,remaining:1996900000});
  const [url,init]=network.mock.calls.find(([url])=>String(url).includes('cloudflare.com'))!;
  expect(JSON.parse(init!.body as string).query).not.toContain('scriptName');
  for(const [url,init] of network.mock.calls){expect(init?.redirect).toBe('manual');if(String(url).includes('appwrite.io'))expect(init?.headers).toMatchObject({'X-Appwrite-Key':'usage-read-secret'});}
  expect(JSON.stringify(result)).not.toContain('usage-read-secret');expect(JSON.stringify(result)).not.toContain('cf-read-secret');
});
it('retains Cloudflare capacity when Appwrite is paused',async()=>{
  vi.spyOn(globalThis,'fetch').mockImplementation(async(url)=>new Response(JSON.stringify(String(url).includes('cloudflare.com')?cf:{type:'project_paused'}),{status:String(url).includes('cloudflare.com')?200:403}));
  const result=await createCapacityReader()(env);expect(result.cloudflare.status).toBe('ready');expect(result.appwrite).toMatchObject({status:'paused',metrics:[]});
});
it('a gauge with no samples is unknown, not zero storage used',async()=>{
  const network=mock();network.mockImplementation(async(url)=>new Response(JSON.stringify(String(url).includes('cloudflare.com')?cf:{metrics:String(url).includes('gauges')?[{metric:'files.storage',points:[]}]:[{metric:'network.inbound',points:[]},{metric:'network.outbound',points:[]}]})));
  const result=await createCapacityReader()(env);expect(result.appwrite.metrics[1]).toMatchObject({used:null,remaining:null,severity:'unknown'});
});
it('does not assert any remaining monthly traffic without a confirmed billing cycle',async()=>{
  mock();const result=await createCapacityReader()({...env,APPWRITE_BILLING_ANCHOR:undefined});expect(result.appwrite.metrics[0].limit).toBeNull();expect(result.appwrite.metrics[0].remaining).toBeNull();
});
it('does not assume Free plan limits when the plan is unconfirmed',async()=>{
  mock();const result=await createCapacityReader()({...env,CF_CAPACITY_PLAN:undefined});expect(result.cloudflare.metrics.every(m=>m.limit===null&&m.remaining===null)).toBe(true);
});
it('invalid/missing official counter fields do not become zero usage',async()=>{
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({data:{viewer:{accounts:[{}]}}})));const result=await createCapacityReader()(env);expect(result.cloudflare).toMatchObject({status:'unavailable',metrics:[]});
});
it('cache does not reuse yesterday\'s remaining quota after midnight UTC',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-26T23:59:50Z'));const network=mock(),read=createCapacityReader();await read(env);await read(env);expect(network).toHaveBeenCalledTimes(3);
  vi.setSystemTime(new Date('2026-10-27T00:00:01Z'));await read(env);expect(network).toHaveBeenCalledTimes(6);
});
it('the capacity endpoint requires owner/admin, including when no provider is configured',async()=>{
  for(const role of [null,'staff','admin'] as const){const app=new Hono<any>();app.use('*',async(c,next)=>{if(role)c.set('staff',{id:'a',role});await next()});app.route('/',cloudflareTraffic);expect((await app.request('/api/service-capacity',{},{})).status).toBe(role===null?401:role==='staff'?403:200);}
});
