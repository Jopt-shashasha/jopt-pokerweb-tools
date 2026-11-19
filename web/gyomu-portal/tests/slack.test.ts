import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { Store } from '../src/db.js';
import { Catalog } from '../src/repository.js';
import { createApp } from '../src/app.js';
import { applySlackChannels } from '../scripts/apply-slack-channels.js';
import { digest,type BlobStore } from '../src/storage.js';
import { now,type Config,type User } from '../src/model.js';

const blobStub:BlobStore={put:async()=>{throw Error('unused');},get:async()=>{throw Error('unused');},remove:async()=>{}};
const CS='10000000-0000-4000-8000-000000000005',CH='C0924RS04CU',ALL='C089M13F08H';
type Call={channel:string;text:string;blocks:any[]};
function fixture(opts:{token?:boolean;respond?:(n:number)=>Promise<Response>|Response;origin?:string}={}){
 const store=new Store(':memory:'),calls:Call[]=[];
 const config:Config={origin:opts.origin??'http://127.0.0.1:8788',localDev:true,dataDir:'unused',adminEmail:'admin@japanopenpoker.com',allowedDomains:['japanopenpoker.com'],newsFeeds:[],slackBotToken:opts.token===false?undefined:'xoxb-test',slackWorkspaceUrl:'https://jopthq.slack.com'};
 store.run('INSERT INTO departments(id,name,sort_order) VALUES (?,?,0)',CS,'カスタマー');
 const users=['admin','a'].map((name,i)=>{const id=randomUUID();store.run('INSERT INTO users(id,email,name,role,created_at) VALUES (?,?,?,?,?)',id,name+'@japanopenpoker.com',name,i===0?'admin':'user',now());return store.one<User>('SELECT * FROM users WHERE id=?',id)!;});
 const sessions=users.map(u=>{const token=randomBytes(32).toString('hex'),csrf=randomUUID(),t=Math.floor(Date.now()/1000);store.run('INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at,renewed_at) VALUES (?,?,?,?,?,?)',digest(token),u.id,csrf,t+86400,t,t);return {cookie:'portal-session='+token,csrf};});
 const apiCalls:string[]=[];
 const fake=(async(url:any,init:any)=>{const method=String(url).split('/api/')[1];apiCalls.push(method);
  if(method==='users.lookupByEmail'){const email=new URLSearchParams(init.body).get('email')!;return email.startsWith('ghost')?Response.json({ok:false,error:'users_not_found'}):Response.json({ok:true,user:{id:'U'+email.split('@')[0].toUpperCase().replace(/[^A-Z0-9]/g,'').padEnd(8,'X')}});}
  if(method==='conversations.open'){const body=JSON.parse(init.body);return Response.json({ok:true,channel:{id:'D'+body.users.slice(1)}});}
  calls.push(JSON.parse(init.body));return opts.respond?opts.respond(calls.length):Response.json({ok:true,ts:'1.'+calls.length});}) as typeof fetch;
 const {app}=createApp(config,store,blobStub,undefined,{slackFetch:fake}),catalog=new Catalog(store);
 const req=(path:string,i=0,init:RequestInit={})=>app.request(config.origin+path,{...init,headers:{cookie:sessions[i].cookie,origin:config.origin,'x-csrf-token':sessions[i].csrf,'content-type':'application/json',...init.headers}});
 const json=async(path:string,i=0,init:RequestInit={})=>{const r=await req(path,i,init);return {status:r.status,body:await r.json() as any};};
 const enable=()=>json('/api/admin/slack/departments/'+CS,0,{method:'PUT',body:JSON.stringify({channel_id:CH,channel_name:'cs_カスタマーチーム',enabled:true})});
 const publish=(title:string,extra:Record<string,unknown>={})=>catalog.create(users[1],{title,url:'https://drive.example/'+title,department_id:CS,visibility:'company',status:'published',description:'Voucherの照合作業を、まとめて確認できます。',...extra});
 return {store,config,users,catalog,req,json,enable,publish,calls,apiCalls,app};
}
const send=(f:ReturnType<typeof fixture>,id:string,body:Record<string,unknown>={channel_id:CH})=>f.json('/api/admin/slack/intro/'+id,0,{method:'POST',body:JSON.stringify(body)});

test('only admins; nothing is sent until a channel is configured and enabled; preview mode never sends',async()=>{
 const f=fixture({token:false});try{
  const r=(await f.publish('Voucher照合ツール',{impact:{audience:'カスタマー',task:'Voucher照合',before:'5分',after:'30秒'}}));
  assert.equal((await f.json('/api/admin/slack',1)).status,403);assert.equal((await f.json('/api/admin/slack/intro/'+r.id,1)).status,403);
  const before=(await f.json('/api/admin/slack/intro/'+r.id)).body;assert.equal(before.channel,null);assert.ok(before.blockers[0].includes('チャンネル'));
  assert.equal((await f.json('/api/admin/slack/departments/'+CS,0,{method:'PUT',body:JSON.stringify({channel_id:null,enabled:true})})).status,400);
  assert.equal((await f.json('/api/admin/slack/departments/'+CS,0,{method:'PUT',body:JSON.stringify({channel_id:'#general',enabled:false})})).status,400);
  await f.enable();
  const p=(await f.json('/api/admin/slack/intro/'+r.id)).body;
  assert.equal(p.mode,'preview');assert.equal(p.can_send,false);assert.equal(p.channel.id,CH);assert.equal(p.channel.link,'https://jopthq.slack.com/archives/'+CH);
  assert.equal(p.card.label,'カスタマー向け｜Voucher照合ツール');assert.equal(p.card.effect,'Voucher照合が 5分 → 30秒');assert.equal(p.card.creator,'a');
  assert.ok(!JSON.stringify(p.message).includes('AI'),'no AI label');
  assert.ok(p.warnings.some((w:string)=>w.includes('127.0.0.1')));assert.ok(p.warnings.some((w:string)=>w.includes('プレビュー')));
  assert.equal((await send(f,r.id)).status,503);assert.equal(f.calls.length,0);
 }finally{f.store.close();}
});

test('intro: re-checks sharing, blocks duplicates and the weekly cap, escapes text, links via /go',async()=>{
 const f=fixture({origin:'https://portal.example.jp'});try{
  await f.enable();
  const draft=(await f.catalog.create(f.users[1],{title:'下書き',url:'https://drive.example/d',department_id:CS,status:'draft'}));
  const priv=(await f.catalog.create(f.users[1],{title:'私用',url:'https://drive.example/p',department_id:CS,visibility:'private'}));
  assert.equal((await f.json('/api/admin/slack/intro/'+draft.id)).status,409);assert.equal((await send(f,priv.id)).status,409);
  const a=(await f.publish('<b>A&B</b>')),b=(await f.publish('B')),c=(await f.publish('C'));
  assert.equal((await send(f,a.id,{channel_id:'C000000000'})).status,400,'only enabled channels');
  const ok=await send(f,a.id);assert.equal(ok.body.state,'sent');assert.equal(f.calls.length,1);
  const call=f.calls[0];assert.equal(call.channel,CH);assert.ok(call.blocks[0].text.text.includes('&lt;b&gt;A&amp;B&lt;/b&gt;'));
  assert.equal(call.blocks[2].elements[0].url,`https://portal.example.jp/go/${a.id}?p=${ok.body.post_id}`);
  const dup=await send(f,a.id);assert.equal(dup.status,409);assert.ok(dup.body.error.includes('紹介済み'));
  assert.equal((await send(f,b.id)).body.state,'sent');
  const capped=await send(f,c.id);assert.equal(capped.status,409);assert.ok(capped.body.error.includes('上限'));
  assert.equal((await send(f,c.id,{channel_id:CH,force:true})).body.state,'sent','admin can override with force');
  // Unshared after preview: re-checked at send time.
  const d=(await f.publish('D'));f.store.run("UPDATE resources SET visibility='private' WHERE id=?",d.id);assert.equal((await send(f,d.id,{channel_id:CH,force:true})).status,409);
  const history=(await f.json('/api/admin/slack/posts')).body.items;assert.equal(history.length,3);assert.equal(history[0].forced,true);
 }finally{f.store.close();}
});

test('timeouts become unknown, are never retried, and block resending until an admin resolves them',async()=>{
 const f=fixture({respond:n=>{if(n===1)throw Object.assign(Error('timed out'),{name:'TimeoutError'});if(n===2)return new Response('oops',{status:502});return Response.json({ok:false,error:'channel_not_found'});}});try{
  await f.enable();const a=(await f.publish('A')),b=(await f.publish('B')),c=(await f.publish('C'));
  const first=await send(f,a.id);assert.equal(first.body.state,'unknown');assert.ok(first.body.message.includes('自動では再送しません'));
  const again=await send(f,a.id,{channel_id:CH,force:true});assert.equal(again.status,409,'force cannot bypass an unconfirmed post');assert.equal(f.calls.length,1);
  assert.equal((await send(f,b.id)).body.state,'unknown','5xx is ambiguous');
  assert.equal((await f.json(`/api/admin/slack/posts/${first.body.post_id}/resolve`,1,{method:'POST',body:JSON.stringify({outcome:'failed'})})).status,403);
  assert.equal((await f.json(`/api/admin/slack/posts/${first.body.post_id}/resolve`,0,{method:'POST',body:JSON.stringify({outcome:'failed'})})).status,200);
  assert.equal((await f.json(`/api/admin/slack/posts/${first.body.post_id}/resolve`,0,{method:'POST',body:JSON.stringify({outcome:'sent'})})).status,409,'resolved once');
  const rejected=await send(f,c.id,{channel_id:CH,force:true});assert.equal(rejected.body.state,'failed');assert.ok(rejected.body.message.includes('channel_not_found'));
 }finally{f.store.close();}
});

test('weekly digest: previous 7 JST days, shared items only, most-read item, once per period',async()=>{
 const f=fixture({origin:'https://portal.example.jp'});try{
  const items=await Promise.all(['新1','新2','新3'].map(async t=>(await f.publish(t))));const hidden=(await f.catalog.create(f.users[1],{title:'非公開',url:'https://drive.example/x',visibility:'private'}));
  const day=86400000,yesterday=new Date(Date.now()-day).toISOString(),old=new Date(Date.now()-20*day).toISOString();
  f.store.run('UPDATE resources SET created_at=?',yesterday);f.store.run('UPDATE resources SET created_at=? WHERE id=?',old,items[2].id);
  f.store.run("INSERT INTO resource_usage(id,user_id,resource_id,via,action,created_at) VALUES (?,?,?,'codex','read',?)",randomUUID(),f.users[0].id,items[2].id,Math.floor((Date.now()-day)/1000));
  let p=(await f.json('/api/admin/slack/digest')).body;assert.ok(p.blockers[0].includes('まとめ用'));
  assert.equal((await f.json('/api/admin/slack',0,{method:'PUT',body:JSON.stringify({digest_enabled:true})})).status,400);
  await f.json('/api/admin/slack',0,{method:'PUT',body:JSON.stringify({digest_channel_id:ALL,digest_channel_name:'全社',digest_enabled:true})});
  p=(await f.json('/api/admin/slack/digest')).body;
  assert.deepEqual(p.items.map((x:any)=>x.label).sort(),['カスタマー向け｜新1','カスタマー向け｜新2']);assert.equal(p.popular.label,'カスタマー向け｜新3');
  assert.ok(!JSON.stringify(p).includes(hidden.title));assert.match(p.period.label,/^\d\d\/\d\d〜\d\d\/\d\d$/);
  assert.equal((await f.json('/api/admin/slack/digest',0,{method:'POST',body:'{}'})).body.state,'sent');
  assert.equal(f.calls[0].channel,ALL);assert.ok(f.calls[0].blocks[0].text.text.includes('/go/'));
  assert.equal((await f.json('/api/admin/slack/digest',0,{method:'POST',body:'{}'})).status,409,'once per period');
 }finally{f.store.close();}
});

test('/go records human clicks only and always lands on the portal detail page',async()=>{
 const f=fixture();try{
  await f.enable();const a=(await f.publish('A'));const post=(await send(f,a.id)).body.post_id;
  const go=(ua:string|null,q='')=>f.app.request(f.config.origin+'/go/'+a.id+q,{headers:ua?{'user-agent':ua}:{}});
  const r=await go('Mozilla/5.0 Chrome/140','?p='+post);assert.equal(r.status,302);assert.equal(r.headers.get('location'),'/#/resource/'+a.id);
  await go('Slackbot-LinkExpanding 1.0','?p='+post);await go(null);
  await go('Mozilla/5.0','?p=https://evil.test');assert.equal((await go('Mozilla/5.0','?to=https://evil.test')).headers.get('location'),'/#/resource/'+a.id);
  const rows=f.store.all<{post_id:string|null}>('SELECT post_id FROM link_clicks');assert.equal(rows.length,3);assert.equal(rows.filter(x=>x.post_id===post).length,1);
  assert.equal((await f.app.request(f.config.origin+'/go/'+randomUUID())).status,404);
  assert.equal((await f.json('/api/admin/slack/posts')).body.items[0].clicks,1);
 }finally{f.store.close();}
});

test('channel map import copies verified IDs only, never enables sending, and checks names',()=>{
 const store=new Store(':memory:');try{
  store.run('INSERT INTO departments(id,name,sort_order) VALUES (?,?,0)',CS,'カスタマー');
  const map={channels:[{department:'カスタマー',department_id:CS,channel_name:'cs_カスタマーチーム',channel_id:CH,status:'identified'},{department:'全社用',department_id:null,channel_name:null,channel_id:null,status:'confirmation_required'}]};
  const dry=applySlackChannels(store,map);assert.equal(dry.changed.length,1);assert.equal(store.one<{c:string|null}>('SELECT slack_channel_id c FROM departments')!.c,null);
  applySlackChannels(store,map,true);const d=store.one<{slack_channel_id:string;slack_enabled:number}>('SELECT slack_channel_id,slack_enabled FROM departments')!;
  assert.equal(d.slack_channel_id,CH);assert.equal(d.slack_enabled,0);assert.deepEqual(applySlackChannels(store,map).skipped_needs_confirmation,['全社用']);
  assert.throws(()=>applySlackChannels(store,{channels:[{...map.channels[0],department:'営業'}]}),/mismatch/);
 }finally{store.close();}
});

test('test channel: every send goes only there; dedupe and caps become warnings; clearing restores departments',async()=>{
 const f=fixture({origin:'https://portal.example.jp'});try{
  await f.enable();const TEST='C0TESTCHAN1';
  assert.equal((await f.json('/api/admin/slack',0,{method:'PUT',body:JSON.stringify({test_channel_id:'bad'})})).status,400);
  await f.json('/api/admin/slack',0,{method:'PUT',body:JSON.stringify({test_channel_id:TEST,test_channel_name:'portal-test'})});
  const a=(await f.publish('A'));const p=(await f.json('/api/admin/slack/intro/'+a.id)).body;
  assert.deepEqual(p.channels.map((c:any)=>c.id),[TEST]);assert.equal(p.channel.id,TEST);assert.ok(p.warnings[0].includes('テストモード'));
  assert.equal((await send(f,a.id,{channel_id:CH})).status,400,'department channels are not selectable during a test');
  for(let i=0;i<3;i++)assert.equal((await send(f,a.id,{channel_id:TEST})).body.state,'sent','repeat sends allowed in test');
  assert.ok(f.calls.every(c=>c.channel===TEST));
  const d=(await f.json('/api/admin/slack/digest')).body;assert.equal(d.channel.id,TEST);assert.equal(d.test,true);
  await f.json('/api/admin/slack',0,{method:'PUT',body:JSON.stringify({test_channel_id:null})});
  const after=(await f.json('/api/admin/slack/intro/'+a.id)).body;assert.equal(after.channel.id,CH);assert.equal((await f.json('/api/admin/slack')).body.test_channel,null);
 }finally{f.store.close();}
});

test('DM: chosen people only, Slack ID matched by email and cached, per-person dedupe/cap, test mode redirects',async()=>{
 const f=fixture({origin:'https://portal.example.jp'});try{
  const extra=['taro','ghost'].map(name=>{const id=randomUUID();f.store.run('INSERT INTO users(id,email,name,role,created_at) VALUES (?,?,?,?,?)',id,name+'@japanopenpoker.com',name,'user',now());return id;});
  const a=(await f.publish('A'));const dm=(ids:string[],force=false)=>f.json('/api/admin/slack/intro/'+a.id+'/dm',0,{method:'POST',body:JSON.stringify({user_ids:ids,force})});
  assert.equal((await f.json('/api/admin/slack/people',1)).status,403);
  const people=(await f.json('/api/admin/slack/people')).body.items;assert.ok(people.some((p:any)=>p.name==='taro'));assert.ok(!JSON.stringify(people).includes('slack_user_id'));
  assert.equal((await dm([])).status,400);assert.equal((await dm(Array.from({length:31},()=>randomUUID()))).status,400);assert.equal((await dm([randomUUID()])).status,400);
  const r=(await dm([extra[0],extra[1]])).body;
  assert.deepEqual(r.results.map((x:any)=>x.state),['sent','failed']);assert.ok(r.results[1].message.includes('見つかりません'));
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].channel,'DTAROXXXX');
  assert.equal(f.store.one<{s:string}>('SELECT slack_user_id s FROM users WHERE id=?',extra[0])!.s,'UTAROXXXX');
  const lookups=f.apiCalls.filter(m=>m==='users.lookupByEmail').length;
  assert.equal((await dm([extra[0]])).body.results[0].state,'skipped','same resource is not DMed twice');
  assert.equal((await dm([extra[0]],true)).body.results[0].state,'sent');assert.equal(f.apiCalls.filter(m=>m==='users.lookupByEmail').length,lookups,'cached Slack ID');
  // DMs do not count against the channel cap.
  await f.enable();assert.equal((await f.json('/api/admin/slack/intro/'+a.id)).body.blockers.length,0);
  // Test mode: one message to the test channel naming would-be recipients.
  await f.json('/api/admin/slack',0,{method:'PUT',body:JSON.stringify({test_channel_id:'C0TESTCHAN1'})});
  const t=(await dm([extra[0]])).body;assert.equal(t.test,true);const last=f.calls.at(-1)!;assert.equal(last.channel,'C0TESTCHAN1');assert.ok(last.blocks[0].elements[0].text.includes('taro'));
 }finally{f.store.close();}
});

function seedNews(f:ReturnType<typeof fixture>){
 const iso=(h:number)=>new Date(Date.now()-h*3600000).toISOString();
 f.store.run('INSERT INTO news_cache VALUES (1,?,?)',JSON.stringify([{title:'Codexに新機能 <b>',url:'https://news.example/1',source:'ML_Bear Times',published_at:iso(5),summary:'新しいツールが使えるようになりました。'.repeat(10),format:'story'},{title:'ChatGPTの新しい使い方',url:'https://news.example/2',source:'ML_Bear Times',published_at:iso(30),summary:'利用手順が公開されました。',format:'story'}]),Math.floor(Date.now()/1000));
}
test('news push: current feed items only, short summaries, per-channel dedupe, test mode and digest section',async()=>{
 const f=fixture();try{
  seedNews(f);
  let p=(await f.json('/api/admin/slack/news')).body;assert.ok(p.blockers[0].includes('ニュース用'));assert.equal(p.items.length,2);
  assert.ok(p.items[0].summary.length<=115,'short excerpt only');
  assert.equal((await f.json('/api/admin/slack/news',1)).status,403);
  await f.json('/api/admin/slack',0,{method:'PUT',body:JSON.stringify({news_channel_id:'C0NEWSCHAN1',news_channel_name:'ai-news',news_enabled:true})});
  p=(await f.json('/api/admin/slack/news')).body;assert.equal(p.channel.id,'C0NEWSCHAN1');
  const key=p.items[0].key,newsSend=(keys:string[],force=false)=>f.json('/api/admin/slack/news',0,{method:'POST',body:JSON.stringify({keys,force})});
  assert.equal((await newsSend(['0'.repeat(16)])).status,409,'unknown item (not in feed)');
  assert.equal((await newsSend([])).status,400);
  const sent=await newsSend([key]);assert.equal(sent.body.state,'sent');const call=f.calls.at(-1)!;assert.equal(call.channel,'C0NEWSCHAN1');
  assert.ok(call.blocks[1].text.text.includes('<https://news.example/1|Codexに新機能 &lt;b&gt;>'));assert.ok(call.blocks.at(-1).elements[0].text.includes('出典'));
  assert.equal((await f.json('/api/admin/slack/news')).body.items[0].sent,'sent');
  assert.equal((await newsSend([key])).status,409,'not twice to the same channel');
  assert.equal((await newsSend([key],true)).body.state,'sent','admin may resend with force');
  const history=(await f.json('/api/admin/slack/posts')).body.items;assert.equal(history[0].kind,'news');
  await f.json('/api/admin/slack',0,{method:'PUT',body:JSON.stringify({test_channel_id:'C0TESTCHAN1'})});
  assert.equal((await newsSend([key])).body.state,'sent','test mode allows repeats');assert.equal(f.calls.at(-1)!.channel,'C0TESTCHAN1');
  await f.json('/api/admin/slack',0,{method:'PUT',body:JSON.stringify({test_channel_id:null,digest_channel_id:'C089M13F08H',digest_enabled:true,digest_include_news:true})});
  (await f.publish('新'));f.store.run('UPDATE resources SET created_at=?',new Date(Date.now()-86400000).toISOString());
  const d=(await f.json('/api/admin/slack/digest')).body;assert.ok(d.news.length>=1);assert.ok(JSON.stringify(d.message).includes('今週のAIニュース'));
 }finally{f.store.close();}
});
