import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { readFileSync, existsSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import { faq } from '../routes/faq.js';
import { expandFaq, faqHash, normalizeFaq, validateFaq } from './faq-data.js';
import { deployFaq, getFaqRelease, importFaq } from './faq-store.js';
import { closeFaqSessions, handleFaq } from './faq-runtime.js';
import { faqLineMessage, faqView } from './faq-render.js';

function fixture(){return {
  nodes:{root:{id:'root',label:'トップ',type:'menu',body:'{{msg_root}}',status:'確認済'},a:{id:'a',parent:'root',label:'質問',type:'answer',body:'回答です。\n日本語です。',status:'確認済'},h:{id:'h',parent:'root',label:'担当者',type:'handoff',body:'受付',handoff:'H',status:'確認済'},r:{id:'r',parent:'root',label:'他のLINE',type:'redirect',body:'案内',channel:'C',status:'確認済'}},
  channels:{C:{id:'C',name:'窓口',url:'https://line.me/example',status:'確認済'}},handoffs:{H:{id:'H',fields:['GameID']}},vars:{},events:{},
  messages:Object.fromEntries(['msg_root','msg_followup','msg_handoff_in','msg_handoff_out','msg_resolved'].map(id=>[id,{id,text:id==='msg_handoff_in'||id==='msg_handoff_out'?'受付しました。{{fields}}':'テスト文面'}])),
};}
let db:D1Database,sqlite:ReturnType<typeof sqliteD1>['sqlite'];
beforeEach(()=>{
  ({db,sqlite}=sqliteD1());
  sqlite.exec(`CREATE TABLE line_accounts(id TEXT PRIMARY KEY,is_active INTEGER);INSERT INTO line_accounts VALUES('account',1),('other',1);
    CREATE TABLE friends(id TEXT PRIMARY KEY,line_account_id TEXT);INSERT INTO friends VALUES('tester','account'),('customer','account'),('outsider','other');
    CREATE TABLE chats(id TEXT PRIMARY KEY,friend_id TEXT UNIQUE,status TEXT,notes TEXT,last_message_at TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE messages_log(id TEXT PRIMARY KEY,friend_id TEXT,direction TEXT,message_type TEXT,content TEXT,source TEXT,line_account_id TEXT,created_at TEXT);`);
  sqlite.exec(readFileSync(new NodeURL('../../../../packages/db/migrations/073_faq_releases.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new NodeURL('../../../../packages/db/migrations/075_faq_test_menu_members.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new NodeURL('../../../../packages/db/migrations/076_faq_handoff_contexts.sql',import.meta.url),'utf8'));
  db.batch=async(statements)=>{sqlite.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sqlite.exec('COMMIT');return results as any;}catch(e){sqlite.exec('ROLLBACK');throw e;}};
});
afterEach(()=>sqlite.close());
function app(role='admin'){
  const a=new Hono<any>();a.use('*',async(c,next)=>{c.set('staff',{id:'admin',role});await next();});a.route('/',faq);return a;
}
async function req(url:string,body?:unknown,method='POST',role='admin'){
  return app(role).request(url,{method:body===undefined?'GET':method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},{DB:db});
}
async function setup(){const release=await importFaq(db,'account',fixture(),'admin');await deployFaq(db,'account',release.id,'test',['tester'],'admin');return release;}
const messages:any[]=[];
function sendInput(value:string,kind:'text'|'postback'='text',friendId='tester',eventId=crypto.randomUUID()){
  return handleFaq(db,{accountId:'account',friendId,kind,value,eventId,send:async m=>{messages.push(m);}});
}
function button(kind:string,node?:string){return messages.at(-1).contents.body.contents.find((c:any)=>c.type==='button'&&c.action.type==='postback'&&(node?c.action.data.endsWith(`:${kind}:${node}`):c.action.data.includes(`:${kind}:`))).action.data;}

describe('FAQ import and staged release',()=>{
  it('filters event choices and validation by ancestor brand, including stale selections',()=>{
    const d=normalizeFaq(fixture());
    d.nodes.brand={id:'brand',parent:'root',type:'menu',label:'SPADIE',body:'選択',brand:'SPADIE',status:'確認済'};
    d.nodes.category={id:'category',parent:'brand',type:'menu',label:'大会',body:'選択',status:'確認済'};
    d.nodes.question={id:'question',parent:'category',type:'answer',label:'日程',body:'【大会名】',per_event:true,status:'確認済'};
    d.events.sp={id:'sp',name:'SPADIE',brand:'SPADIE',active:true};
    d.events.jp={id:'jp',name:'JOPT',brand:'JOPT',active:true};
    expect(faqView(d,'question').buttons.filter(b=>b.action==='event').map(b=>b.eventId)).toEqual(['sp']);
    expect(faqView(d,'question','jp').eventId).toBeNull();
    expect(faqView(d,'question','sp').text).toContain('SPADIE');
    expect(validateFaq(d).warnings.filter(x=>x.startsWith('question/'))).toEqual([]);
  });
  it('keeps registered test-menu members authorized when activating another private test release',async()=>{
    const release=await setup();
    sqlite.prepare('INSERT INTO faq_test_menu_members(account_id,friend_id,group_id,rich_menu_id,created_at) VALUES(?,?,?,?,?)').run('account','tester','group','menu','2026-10-26');
    const r=await req(`/api/faq/accounts/account/releases/${release.id}/activate`,{audience:'test',openTest:false,friendIds:[]});
    expect(r.status).toBe(200);expect((await r.json() as any).data.friendIds).toEqual(['tester']);
  });
  it('labels every answer follow-up as 担当者に相談 even when the human category is その他',()=>{
    const d=normalizeFaq(fixture());
    d.nodes.human={id:'human',parent:'root',label:'その他',type:'menu',body:'分類',status:'確認済'};
    d.nodes.a2={...d.nodes.a,id:'a2',label:'別の質問'};
    for(const n of Object.values(d.nodes).filter(n=>n.type==='answer')){
      const view=faqView(d,n.id);
      expect(view.buttons.filter(b=>b.action==='handoff')).toEqual([{label:'担当者に相談',action:'handoff'}]);
      expect(JSON.stringify(faqLineMessage(view,'release','session'))).toContain('担当者に相談');
      expect(view.buttons.find(b=>b.action==='resolved')).toBeDefined();
    }
    expect(d.nodes.human.label).toBe('その他');
  });
  it('expands current App reservation deadlines and custom event fields without losing empty age notes',()=>{
    const d=normalizeFaq(fixture());d.events.ev={id:'ev',name:'大会 #03',active:true,preentry_deadline:'#04 10/26 23:59まで',age_note:'',extra:JSON.stringify({'予約URL':'https://example.com/reserve'})};
    expect(expandFaq(d,'【大会名】 【事前予約期限】 【予約URL】【年齢制限】','ev')).toBe('大会 #03 #04 10/26 23:59まで https://example.com/reserve');
    expect(expandFaq(d,'【予約URL】','missing')).toBe('【予約URL】');
  });
  it('check branches create a pending human chat without resolution buttons',async()=>{
    const payload=fixture();payload.nodes.h.type='check' as any;
    const release=await importFaq(db,'account',payload,'admin');await deployFaq(db,'account',release.id,'test',['tester'],'admin');
    await sendInput('faqv1:test','postback');await sendInput(button('node','h'),'postback');
    expect((sqlite.prepare('SELECT status FROM chats').get() as any).status).toBe('unread');
    expect(messages.at(-1).contents.body.contents.some((b:any)=>b.type==='button')).toBe(false);
    expect(messages.at(-1).contents.body.contents[0].text).toContain('GameID');
  });
  it('imports an actual draft idempotently without enabling a deployment',async()=>{
    const a=await importFaq(db,'account',fixture(),'admin'),b=await importFaq(db,'account',{data:fixture(),schemaVersion:1},'admin');
    expect(a.id).toBe(b.id);expect(sqlite.prepare('SELECT count(*) AS n FROM faq_deployments').get()).toEqual({n:0});
    expect(JSON.parse(a.payload).nodes.a.body).toBe('回答です。\n日本語です。');
  });
  it('content hash is independent of object-key order',async()=>{
    const d=normalizeFaq(fixture());expect(await faqHash(d)).toBe(await faqHash({...d,nodes:Object.fromEntries(Object.entries(d.nodes).reverse())}));
  });
  it('rejects malformed parent/cycle/link and action-list JSON',()=>{
    expect(()=>normalizeFaq([{type:'add_tag'}])).toThrow();
    const d=normalizeFaq(fixture());d.nodes.a.parent='missing';expect(validateFaq(d).errors.length).toBeGreaterThan(0);
    d.nodes.a.parent='a';expect(validateFaq(d).errors.join()).toContain('循環');
    expect(()=>normalizeFaq({nodes:[{id:'root'},{id:'root'}]})).toThrow();
  });
  it('HTTP draft import, preview, and account isolation work without sending LINE',async()=>{
    const r=await req('/api/faq/accounts/account/releases',{payload:fixture()});expect(r.status).toBe(201);const id=(await r.json() as any).data.id;
    const p=await req(`/api/faq/accounts/account/releases/${id}/preview`,{nodeId:'a'});expect(p.status).toBe(200);expect((await p.json() as any).data.view.text).toContain('日本語');
    expect((await req(`/api/faq/accounts/other/releases/${id}`)).status).toBe(404);
    expect(sqlite.prepare('SELECT count(*) AS n FROM messages_log').get()).toEqual({n:0});
  });
  it('staff cannot mutate FAQ releases',async()=>{expect((await req('/api/faq/accounts/account/releases',{payload:fixture()},'POST','staff')).status).toBe(403);});
  it('requires production confirmation and validates test membership',async()=>{
    const r=await importFaq(db,'account',fixture(),'admin');
    expect((await req(`/api/faq/accounts/account/releases/${r.id}/activate`,{audience:'production'})).status).toBe(400);
    await expect(deployFaq(db,'account',r.id,'test',['outsider'],'admin')).rejects.toThrow();
    expect(sqlite.prepare('SELECT count(*) AS n FROM faq_deployments').get()).toEqual({n:0});
  });
  it('bad import or blocked release leaves the previous deployment intact',async()=>{
    const old=await setup();const d=fixture();d.nodes.a.status='要確認';const next=await importFaq(db,'account',d,'admin');
    await expect(deployFaq(db,'account',next.id,'production',[],'admin')).rejects.toThrow();
    const invalid=fixture();invalid.nodes.a.parent='missing';await expect(importFaq(db,'account',invalid,'admin')).rejects.toThrow();
    expect((sqlite.prepare('SELECT release_id FROM faq_deployments').get() as any).release_id).toBe(old.id);
  });
  it('production activation and rollback select only the chosen account',async()=>{
    const a=await importFaq(db,'account',fixture(),'admin');await deployFaq(db,'account',a.id,'production',[],'admin');
    const d=fixture();d.nodes.a.body='改訂';const b=await importFaq(db,'account',d,'admin');await deployFaq(db,'account',b.id,'production',[],'admin');await deployFaq(db,'account',a.id,'production',[],'admin');
    expect((sqlite.prepare("SELECT release_id FROM faq_deployments WHERE audience='production'").get() as any).release_id).toBe(a.id);
    expect(await getFaqRelease(db,'other',a.id)).toBeNull();
  });
});

describe('FAQ real database chat transitions with stubbed LINE transport',()=>{
  beforeEach(()=>{messages.length=0;});
  it('does not match customers outside the test allowlist or arbitrary text',async()=>{
    await setup();for(const text of ['FAQ','FAQテスト','faqv1:start','faqv1:test'])expect(await sendInput(text)).toBe(false);expect(await sendInput('faqv1:test','postback','customer')).toBe(true);expect(await sendInput('こんにちは')).toBe(false);expect(messages).toHaveLength(0);
  });
  it('open testing is available to anyone only through the test postback',async()=>{
    const release=await importFaq(db,'account',fixture(),'admin');await deployFaq(db,'account',release.id,'test',[],'admin',true);
    expect(await sendInput('faqv1:start','postback','customer')).toBe(true);
    expect(await sendInput('FAQテストをしたい','text','customer')).toBe(false);
    expect(await sendInput('こんにちは','text','customer')).toBe(false);
    expect(await sendInput('faqv1:test','postback','customer')).toBe(true);
    await sendInput(button('node','a'),'postback','customer');expect(messages.at(-1).contents.body.contents[0].text).toContain('日本語');
    expect(sqlite.prepare('SELECT count(*) AS n FROM chats').get()).toEqual({n:0});
  });
  it('public test and production keep separate entry points and stop invalidates test controls',async()=>{
    const release=await importFaq(db,'account',fixture(),'admin');await deployFaq(db,'account',release.id,'production',[],'admin');
    const data=fixture();data.nodes.a.body='テスト専用文面';const test=await importFaq(db,'account',data,'admin');await deployFaq(db,'account',test.id,'test',[],'admin',true);
    await sendInput('faqv1:start','postback','customer');await sendInput(button('node','a'),'postback','customer');expect(messages.at(-1).contents.body.contents[0].text).toContain('日本語');
    await sendInput('faqv1:test','postback','customer');const next=button('node','a');await sendInput(next,'postback','customer');expect(messages.at(-1).contents.body.contents[0].text).toContain('テスト専用文面');
    sqlite.exec("DELETE FROM faq_deployments WHERE audience='test'");const count=messages.length;await sendInput(next,'postback','customer');expect(messages.length).toBe(count);
  });
  it('Rich Menu human entry opens only the existing consultation category',async()=>{
    const data=fixture();(data.nodes as any).human={id:'human',parent:'root',label:'担当者に相談',type:'menu',body:'内容をお選びください。',status:'確認済'};data.nodes.h.parent='human';
    const release=await importFaq(db,'account',data,'admin');await deployFaq(db,'account',release.id,'test',['tester'],'admin');
    expect(await sendInput('faqv1:test:human','text')).toBe(false);
    await sendInput('faqv1:test:human','postback');expect(messages.at(-1).contents.body.contents[0].text).toBe('内容をお選びください。');
    await sendInput(button('node','h'),'postback');expect((sqlite.prepare('SELECT status FROM chats').get() as any).status).toBe('unread');
  });
  it('navigates and marks resolved only after explicit confirmation',async()=>{
    await setup();await sendInput('faqv1:test','postback');await sendInput(button('node','a'),'postback');
    expect((sqlite.prepare('SELECT outcome FROM faq_sessions').get() as any).outcome).toBe('answered');
    await sendInput(button('resolved'),'postback');expect((sqlite.prepare('SELECT outcome FROM faq_sessions').get() as any).outcome).toBe('resolved');
    expect((sqlite.prepare('SELECT status FROM chats').get() as any).status).toBe('resolved');
  });
  it('unresolved button creates an unread chat and a useful note, duplicated event does not duplicate',async()=>{
    await setup();await sendInput('faqv1:test','postback');await sendInput(button('node','a'),'postback');const control=button('handoff');
    await sendInput(control,'postback','tester','same-event');const sent=messages.length;await sendInput(control,'postback','tester','same-event');
    expect(messages.length).toBe(sent);const chat=sqlite.prepare('SELECT * FROM chats').get() as any;expect(chat.status).toBe('unread');expect(chat.notes).toContain('質問');
  });
  it('direct human branch becomes unread and operator completion clears pending consultations',async()=>{
    await setup();await sendInput('faqv1:test','postback');await sendInput(button('node','h'),'postback');expect((sqlite.prepare('SELECT status FROM chats').get() as any).status).toBe('unread');
    expect(messages.at(-1).contents.body.contents.some((b:any)=>b.type==='button')).toBe(false);
    expect(messages.at(-1).contents.body.contents[0].text).toContain('GameID');await closeFaqSessions(db,'tester');expect((sqlite.prepare('SELECT outcome FROM faq_sessions').get() as any).outcome).toBe('resolved');
  });
  it('customer resolution completes the chat and its earlier pending FAQ handoffs',async()=>{
    await setup();await sendInput('faqv1:test','postback');await sendInput(button('node','h'),'postback');await sendInput('faqv1:test','postback');await sendInput(button('node','a'),'postback');await sendInput(button('resolved'),'postback');
    expect((sqlite.prepare('SELECT status FROM chats').get() as any).status).toBe('resolved');
    expect(sqlite.prepare("SELECT count(*) AS n FROM faq_sessions WHERE outcome='handoff'").get()).toEqual({n:0});
  });
  it('customer resolution changes an existing in-progress chat to completed',async()=>{
    sqlite.exec("INSERT INTO chats(id,friend_id,status,notes) VALUES('chat','tester','in_progress','既存案件')");
    await setup();await sendInput('faqv1:test','postback');await sendInput(button('node','a'),'postback');await sendInput(button('resolved'),'postback');
    expect((sqlite.prepare('SELECT status FROM chats').get() as any).status).toBe('resolved');
  });
  it('does not clear a new human message arriving while the FAQ is open',async()=>{
    await setup();await sendInput('faqv1:test','postback');await sendInput(button('node','a'),'postback');const done=button('resolved');
    sqlite.exec("INSERT INTO chats(id,friend_id,status,notes) VALUES('chat','tester','unread','別件の相談'); INSERT INTO messages_log(id,friend_id,direction,message_type,content) VALUES('incoming-new','tester','incoming','text','別件の相談')");
    await sendInput(done,'postback');expect((sqlite.prepare('SELECT status FROM chats').get() as any).status).toBe('unread');
  });
  it('rejects another friend/session controls and old completion controls after release changes',async()=>{
    const release=await setup();await sendInput('faqv1:test','postback');await sendInput(button('node','a'),'postback');const old=button('resolved');
    await sendInput(old,'postback','customer');expect((sqlite.prepare('SELECT outcome FROM faq_sessions').get() as any).outcome).toBe('answered');
    const d=fixture();d.nodes.a.body='次版';const next=await importFaq(db,'account',d,'admin');await deployFaq(db,'account',next.id,'test',['tester'],'admin');await sendInput(old,'postback');
    expect((sqlite.prepare('SELECT outcome FROM faq_sessions WHERE release_id=?').get(release.id) as any).outcome).toBe('answered');
  });
  it('redirect retains its audit outcome but completes this accounts chat after delivery',async()=>{
    await setup();await sendInput('faqv1:test','postback');await sendInput(button('node','r'),'postback');
    expect(messages.at(-1).contents.body.contents.some((b:any)=>b.action?.type==='uri')).toBe(true);expect((sqlite.prepare('SELECT outcome FROM faq_sessions').get() as any).outcome).toBe('redirected');expect((sqlite.prepare('SELECT status FROM chats').get() as any).status).toBe('resolved');expect(messages.at(-1).contents.body.contents.some((b:any)=>b.action?.data?.includes(':handoff:'))).toBe(false);
  });
  it('completes an existing unread chat when the customer confirms resolution',async()=>{
    sqlite.exec("INSERT INTO chats(id,friend_id,status,notes) VALUES('chat','tester','unread','既存の問い合わせ')");
    await setup();await sendInput('faqv1:test','postback');await sendInput(button('node','a'),'postback');await sendInput(button('resolved'),'postback');
    expect((sqlite.prepare('SELECT status FROM chats').get() as any).status).toBe('resolved');
  });
  it('check replies with collection fields and enters the human queue without more choices',async()=>{
    const d=fixture();d.nodes.a={...d.nodes.a,type:'check',handoff:'H'} as any;
    const r=await importFaq(db,'account',d,'admin');await deployFaq(db,'account',r.id,'test',['tester'],'admin');
    await sendInput('faqv1:test','postback');await sendInput(button('node','a'),'postback');
    expect((sqlite.prepare('SELECT status FROM chats').get() as any).status).toBe('unread');
    expect(messages.at(-1).contents.body.contents[0].text).toContain('GameID');
    expect(messages.at(-1).contents.body.contents.some((b:any)=>b.type==='button')).toBe(false);
  });
  it('does not complete a redirect that has no destination',async()=>{
    const d=normalizeFaq(fixture());d.channels.C.url='';const view=faqView(d,'r');
    expect(view.outcome).toBe('handoff');expect(view.buttons).toEqual([]);
  });
  it('reply failure is visible in unread inbox and does not trigger paid push or repeated sends',async()=>{
    await setup();const send=vi.fn().mockRejectedValue(new Error('LINE unavailable')),log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const input={accountId:'account',friendId:'tester',kind:'postback' as const,value:'faqv1:test',eventId:'failure',send};
    await handleFaq(db,input);await handleFaq(db,input);expect(send).toHaveBeenCalledTimes(1);expect((sqlite.prepare('SELECT status FROM chats').get() as any).status).toBe('unread');log.mockRestore();
  });
});

it.skipIf(!existsSync(new NodeURL('../../../../work/faq-test-release/release.json',import.meta.url)))('current user FAQ imports all 75 nodes without rewriting data or enabling replies',async()=>{
  const raw=JSON.parse(readFileSync(new NodeURL('../../../../work/faq-test-release/release.json',import.meta.url),'utf8'));
  const r=await importFaq(db,'account',raw,'admin'),d=JSON.parse(r.payload);
  expect(Object.keys(d.nodes)).toHaveLength(75);expect(d.nodes).toEqual(raw.data.nodes);expect(validateFaq(d).productionReady).toBe(false);
  for(const node of Object.values(d.nodes) as any[]){const view=faqView(d,node.id);expect(faqLineMessage(view,r.id,'preview').type).toBe('flex');}
});
