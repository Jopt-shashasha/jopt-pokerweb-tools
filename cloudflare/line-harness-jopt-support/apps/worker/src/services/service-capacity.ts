export type CapacityStatus = 'ready'|'not_configured'|'unavailable'|'permission_error'|'paused';
export interface CapacityMetric { id:string; label:string; used:number|null; limit:number|null; remaining:number|null; percent:number|null; unit:'count'|'bytes'; severity:'normal'|'warning'|'critical'|'exhausted'|'unknown'; resetAt:string|null }
export interface CapacitySection { status:CapacityStatus; scope:string; fetchedAt:string; from?:string; to?:string; metrics:CapacityMetric[]; credentialExpiry?:string }
export interface CapacityEnv {
  CF_ANALYTICS_TOKEN_EXPIRES_AT?:string; APPWRITE_USAGE_KEY_EXPIRES_AT?:string;
  CF_ANALYTICS_ACCOUNT_ID?:string; CF_ANALYTICS_TOKEN?:string; CF_CAPACITY_PLAN?:string;
  APPWRITE_ENDPOINT?:string; APPWRITE_PROJECT_ID?:string; APPWRITE_USAGE_API_KEY?:string;
  APPWRITE_BILLING_ANCHOR?:string; APPWRITE_BANDWIDTH_LIMIT_BYTES?:string; APPWRITE_STORAGE_LIMIT_BYTES?:string;
}
export function capacityMetric(id:string,label:string,used:number|null,limit:number|null,unit:'count'|'bytes',resetAt:string|null):CapacityMetric {
  const validUsed=used!==null&&Number.isFinite(used)&&used>=0?used:null;
  const validLimit=limit!==null&&Number.isFinite(limit)&&limit>0?limit:null;
  const percent=validUsed!==null&&validLimit!==null?validUsed/validLimit*100:null;
  return {id,label,used:validUsed,limit:validLimit,unit,resetAt,remaining:validUsed!==null&&validLimit!==null?Math.max(0,validLimit-validUsed):null,percent,
    severity:percent===null?'unknown':percent>=100?'exhausted':percent>=90?'critical':percent>=75?'warning':'normal'};
}
// Preserve the official billing anchor's UTC time/day; clamp short months.
export function billingWindow(anchor:string|undefined,now=new Date()):{from:string;to:string}|null {
  const initial=new Date(anchor||''); if(!Number.isFinite(initial.getTime())||initial>now)return null;
  const at=(year:number,month:number)=>new Date(Date.UTC(year,month,Math.min(initial.getUTCDate(),new Date(Date.UTC(year,month+1,0)).getUTCDate()),initial.getUTCHours(),initial.getUTCMinutes(),initial.getUTCSeconds(),initial.getUTCMilliseconds()));
  let y=now.getUTCFullYear(),m=now.getUTCMonth(),from=at(y,m);
  if(from>now){m--;from=at(y,m);}
  return {from:from.toISOString(),to:at(y,m+1).toISOString()};
}
function numeric(value:unknown):number { if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error('invalid metric');return value; }
class CapacityFailure extends Error { constructor(public status:CapacityStatus){super(status);} }
async function json(url:string,init:RequestInit) {
  let response:Response;
  try{response=await fetch(url,{...init,signal:AbortSignal.timeout(10000),redirect:'manual'});}catch{throw new CapacityFailure('unavailable');}
  let body:any;try{body=await response.json();}catch{throw new CapacityFailure('unavailable');}
  if(body?.type==='project_paused')throw new CapacityFailure('paused');
  if(response.status===401||response.status===403)throw new CapacityFailure('permission_error');
  if(!response.ok)throw new CapacityFailure('unavailable');
  return body;
}
const cloudflareQuery=`query Capacity($account:string,$from:string,$to:string,$day:Date) { viewer { accounts(filter:{accountTag:$account}) {
  workers:workersInvocationsAdaptive(limit:1,filter:{datetime_geq:$from,datetime_lt:$to}) { sum {requests} }
  d1:d1AnalyticsAdaptiveGroups(limit:1,filter:{date_geq:$day,date_leq:$day}) {sum {rowsRead rowsWritten}}
  storage:d1StorageAdaptiveGroups(limit:100,filter:{date_geq:$day,date_leq:$day}) {dimensions {databaseId} max {databaseSizeBytes}}
} } }`;
async function cloudflare(env:CapacityEnv):Promise<CapacitySection> {
  const fetchedAt=new Date().toISOString(),from=fetchedAt.slice(0,10)+'T00:00:00.000Z';
  const reset=new Date(Date.parse(from)+86400000).toISOString();
  const scope='Cloudflare アカウント全体（他のWorker・D1を含む）';
  if(!env.CF_ANALYTICS_ACCOUNT_ID||!env.CF_ANALYTICS_TOKEN)return {status:'not_configured',scope,fetchedAt,metrics:[]};
  try{
    const b=await json('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{Authorization:`Bearer ${env.CF_ANALYTICS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({query:cloudflareQuery,variables:{account:env.CF_ANALYTICS_ACCOUNT_ID,from,to:fetchedAt,day:from.slice(0,10)}})});
    if(b.errors?.length)throw new CapacityFailure('unavailable');
    if(!Array.isArray(b.data?.viewer?.accounts)||b.data.viewer.accounts.length!==1)throw new CapacityFailure('permission_error');
    const a=b.data.viewer.accounts[0];
    for(const key of ['workers','d1','storage'])if(!Array.isArray(a[key]))throw new Error('missing metric');
    if(a.workers.length>1||a.d1.length>1||a.storage.length>=100)throw new Error('truncated metric');
    const free=env.CF_CAPACITY_PLAN==='free';
    const storage=a.storage.length?a.storage.reduce((n:number,r:any)=>n+numeric(r.max?.databaseSizeBytes),0):null;
    return {status:'ready',scope,fetchedAt,from,to:fetchedAt,metrics:[
      capacityMetric('workerRequests','Workers 今日のリクエスト',a.workers.length?numeric(a.workers[0].sum?.requests):0,free?100000:null,'count',reset),
      capacityMetric('d1Reads','D1 今日の読取行数',a.d1.length?numeric(a.d1[0].sum?.rowsRead):0,free?5000000:null,'count',reset),
      capacityMetric('d1Writes','D1 今日の書込行数',a.d1.length?numeric(a.d1[0].sum?.rowsWritten):0,free?100000:null,'count',reset),
      capacityMetric('d1Storage','D1 保存容量',storage,free?5e9:null,'bytes',null),
    ]};
  }catch(e){return {status:e instanceof CapacityFailure?e.status:'unavailable',scope,fetchedAt,metrics:[]};}
}
function metricValue(body:any,name:string,gauge=false):number|null {
  if(!Array.isArray(body?.metrics))throw new Error('missing metrics');
  const series=body.metrics.find((m:any)=>m.metric===name);
  if(!series||!Array.isArray(series.points))throw new Error('missing series');
  if(!series.points.length)return gauge?null:0;
  if(series.points.length!==1)throw new Error('unexpected aggregation');
  return numeric(series.points[0].value);
}
async function appwrite(env:CapacityEnv):Promise<CapacitySection> {
  const fetchedAt=new Date().toISOString(),scope='Appwrite 対象プロジェクト（Free枠は組織共有）';
  if(!env.APPWRITE_USAGE_API_KEY||!env.APPWRITE_ENDPOINT||!env.APPWRITE_PROJECT_ID)return {status:'not_configured',scope,fetchedAt,metrics:[]};
  try{
    const endpoint=new URL(env.APPWRITE_ENDPOINT);
    if(endpoint.protocol!=='https:'||!endpoint.hostname.endsWith('.cloud.appwrite.io')||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('invalid endpoint');
    const cycle=billingWindow(env.APPWRITE_BILLING_ANCHOR);
    const start=cycle?.from||new Date(Date.now()-30*86400000).toISOString();
    const query=(metrics:string[],gauge=false)=>{
      const params=new URLSearchParams({startAt:start,endAt:fetchedAt,limit:'1'});
      for(const metric of metrics)params.append('metrics[]',metric);
      return json(`${endpoint.href.replace(/\/$/,'')}/usage/${gauge?'gauges':'events'}?${params}`,{headers:{'X-Appwrite-Project':env.APPWRITE_PROJECT_ID!,'X-Appwrite-Key':env.APPWRITE_USAGE_API_KEY!}});
    };
    const [events,gauges]=await Promise.all([query(['network.inbound','network.outbound']),query(['files.storage'],true)]);
    const bytes=metricValue(events,'network.inbound')!+metricValue(events,'network.outbound')!;
    const limit=(value:string|undefined)=>value&&Number.isFinite(Number(value))&&Number(value)>0?Number(value):null;
    return {status:'ready',scope,fetchedAt,from:start,to:fetchedAt,metrics:[
      capacityMetric('appwriteBandwidth',cycle?'Appwrite 今期の転送量':'Appwrite 過去30日の転送量',bytes,cycle?limit(env.APPWRITE_BANDWIDTH_LIMIT_BYTES):null,'bytes',cycle?.to||null),
      capacityMetric('appwriteStorage','Appwrite ファイル保存容量',metricValue(gauges,'files.storage',true),limit(env.APPWRITE_STORAGE_LIMIT_BYTES),'bytes',null),
    ]};
  }catch(e){return {status:e instanceof CapacityFailure?e.status:'unavailable',scope,fetchedAt,metrics:[]};}
}
export function createCapacityReader(){
  let cache:{key:string;until:number;value:{cloudflare:CapacitySection;appwrite:CapacitySection}}|undefined;
  return async(env:CapacityEnv)=>{
    const key=JSON.stringify(env),now=Date.now();
    if(cache&&cache.key===key&&cache.until>now)return cache.value;
    const [cf,aw]=await Promise.all([cloudflare(env),appwrite(env)]);
    cf.credentialExpiry=env.CF_ANALYTICS_TOKEN_EXPIRES_AT||'unknown';
    aw.credentialExpiry=env.APPWRITE_USAGE_KEY_EXPIRES_AT||'unknown';
    const value={cloudflare:cf,appwrite:aw};
    // Never let a cached previous-day balance cross Cloudflare's reset boundary.
    const nextDay=new Date().toISOString().slice(0,10)+'T00:00:00.000Z';
    cache={key,until:Math.min(now+60000,Date.parse(nextDay)+86400000),value};return value;
  };
}
