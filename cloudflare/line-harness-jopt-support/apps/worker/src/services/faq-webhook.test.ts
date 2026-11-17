import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { Hono } from 'hono';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import { webhook } from '../routes/webhook.js';
import { chats } from '../routes/chats.js';
import { deployFaq, importFaq } from './faq-store.js';
const dispatch=vi.hoisted(()=>vi.fn());
const automation=vi.hoisted(()=>vi.fn());
const keyword=vi.hoisted(()=>vi.fn());
vi.mock('./event-bus.js',()=>({fireEvent:automation}));
vi.mock('./auto-reply.js',()=>({matchAndReply:keyword}));
vi.mock('./local-line-proxy.js',()=>({dispatchLineProxyLocally:dispatch}));
afterEach(()=>vi.restoreAllMocks());
it('signed LINE webhooks execute published test FAQ and change the real chats table',async()=>{
  const {db,sqlite}=sqliteD1();sqlite.exec(readFileSync(new URL('../../../../packages/db/bootstrap.sql',import.meta.url),'utf8'));sqlite.exec(readFileSync(new URL('../../../../packages/db/migrations/076_faq_handoff_contexts.sql',import.meta.url),'utf8'));
  sqlite.prepare('INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES(?,?,?,?,?)').run('test-account','synthetic-channel','Test account','synthetic-token','synthetic-secret');
  sqlite.prepare('INSERT INTO friends(id,line_user_id,line_account_id,display_name,metadata) VALUES(?,?,?,?,?)').run('test-friend','synthetic-user','test-account','Test friend','{}');
  db.batch=async ss=>{sqlite.exec('BEGIN');try{const result=[];for(const s of ss)result.push(await s.run());sqlite.exec('COMMIT');return result as any;}catch(e){sqlite.exec('ROLLBACK');throw e;}};
  const messages:any[]=[];
  automation.mockReset();keyword.mockReset();dispatch.mockReset();dispatch.mockImplementation(async(request:Request)=>{messages.push((await request.json() as any).messages[0]);return new Response('{}',{status:200});});
  const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No real LINE network'));
  const data={nodes:{root:{id:'root',label:'トップ',type:'menu',body:'案内',status:'確認済'},sub:{id:'sub',parent:'root',label:'カテゴリ',type:'menu',body:'カテゴリ案内',status:'確認済'},a:{id:'a',parent:'sub',label:'質問',type:'answer',body:'回答',status:'確認済'}},messages:Object.fromEntries(['msg_root','msg_followup','msg_handoff_in','msg_handoff_out','msg_resolved'].map(id=>[id,{id,text:'確認用原文'}]))};
  const release=await importFaq(db,'test-account',data,'admin');await deployFaq(db,'test-account',release.id,'test',[],'admin',true);
  const app=new Hono();app.route('/',webhook);app.route('/',chats);
  async function post(value:string,postback=false){
    const event={type:postback?'postback':'message',source:{type:'user',userId:'synthetic-user'},replyToken:crypto.randomUUID(),webhookEventId:crypto.randomUUID(),timestamp:Date.now(),mode:'active',...(postback?{postback:{data:value}}:{message:{type:'text',id:crypto.randomUUID(),text:value}})};
    const body=JSON.stringify({destination:'synthetic-bot',events:[event]});const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('synthetic-secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);const digest=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body));const signature=btoa(String.fromCharCode(...new Uint8Array(digest)));
    const pending:Promise<unknown>[]=[];
    const response=await app.request('/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Line-Signature':signature},body},{DB:db,LINE_CHANNEL_SECRET:'synthetic-secret',LINE_CHANNEL_ACCESS_TOKEN:'synthetic-token'},{waitUntil(p:Promise<unknown>){pending.push(p);},passThroughOnException(){},props:{}});
    await Promise.all(pending);expect(response.status).toBe(200);
  }
  try{
    // Every free-text input, including old keywords and other automation triggers,
    // must be stored exactly and sent to the human inbox without any bot transport.
    for(const text of ['こんにちは','FAQ','FAQテスト','faqv1:start','体験を完了する']){
      await post(text);
      expect(sqlite.prepare("SELECT content FROM messages_log WHERE direction='incoming' ORDER BY rowid DESC LIMIT 1").get()).toEqual({content:text});
      expect((sqlite.prepare('SELECT status FROM chats WHERE friend_id=?').get('test-friend') as any).status).toBe('unread');
    }
    expect(messages).toHaveLength(0);expect(keyword).not.toHaveBeenCalled();expect(automation).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT count(*) AS n FROM faq_sessions').get()).toEqual({n:0});
    sqlite.prepare("UPDATE chats SET status='in_progress',notes='担当者対応中' WHERE friend_id=?").run('test-friend');
    await post('担当者への追加情報');
    expect(sqlite.prepare('SELECT status,notes FROM chats WHERE friend_id=?').get('test-friend')).toEqual({status:'in_progress',notes:'担当者対応中'});
    await post('faqv1:test',true);expect(messages.length).toBe(1);
    const category=messages.at(-1).contents.body.contents.find((c:any)=>c.action?.data?.endsWith(':node:sub')).action.data;
    await post(category,true);
    const node=messages.at(-1).contents.body.contents.find((c:any)=>c.action?.data?.endsWith(':node:a')).action.data;
    await post(node,true);const handoff=messages.at(-1).contents.body.contents.find((c:any)=>c.action?.data?.includes(':handoff:')).action.data;
    await post(handoff,true);expect((sqlite.prepare('SELECT status FROM chats WHERE friend_id=?').get('test-friend') as any).status).toBe('in_progress');
    expect(sqlite.prepare('SELECT account_id,friend_id,classification FROM faq_handoff_contexts').all()).toEqual([{account_id:'test-account',friend_id:'test-friend',classification:'カテゴリ → 質問'}]);
    const detail=await app.request('/api/chats/test-friend',{}, {DB:db});
    expect(detail.status).toBe(200);
    expect((await detail.json() as any).data.faqHandoffContexts).toEqual([expect.objectContaining({classification:'カテゴリ → 質問'})]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM messages_log WHERE direction='outgoing'").get()).toEqual({n:4});expect(network).not.toHaveBeenCalled();
    await post('faqv1:test',true);
    await post(messages.at(-1).contents.body.contents.find((c:any)=>c.action?.data?.endsWith(':node:sub')).action.data,true);
    const next=messages.at(-1).contents.body.contents.find((c:any)=>c.action?.data?.endsWith(':node:a')).action.data;
    await post(next,true);const done=messages.at(-1).contents.body.contents.find((c:any)=>c.action?.data?.includes(':resolved:')).action.data;
    await post(done,true);expect((sqlite.prepare('SELECT status FROM chats WHERE friend_id=?').get('test-friend') as any).status).toBe('resolved');
    expect(sqlite.prepare("SELECT count(*) AS n FROM faq_sessions WHERE outcome='handoff'").get()).toEqual({n:0});
    await post('解決後の別件');expect(messages).toHaveLength(8);
    expect((sqlite.prepare('SELECT status FROM chats WHERE friend_id=?').get('test-friend') as any).status).toBe('unread');
    await post('faqv1:test',true);
    await post(messages.at(-1).contents.body.contents.find((c:any)=>c.action?.data?.endsWith(':node:sub')).action.data,true);
    const child=messages.at(-1).contents.body.contents.find((c:any)=>c.action?.data?.endsWith(':node:a')).action.data;
    await post(child,true);
    const confirm=messages.at(-1).contents.body.contents.find((c:any)=>c.action?.data?.includes(':resolved:')).action.data;
    const back=messages.at(-1).contents.body.contents.find((c:any)=>c.action?.data?.endsWith(':node:root')).action.data;
    await post('FAQ閲覧中の新規相談');
    await post(confirm,true);
    expect((sqlite.prepare('SELECT status FROM chats WHERE friend_id=?').get('test-friend') as any).status).toBe('unread');
    await post(back,true);expect(messages.at(-1).contents.body.contents[0].text).toBe('案内');
    expect(keyword).not.toHaveBeenCalled();expect(automation).not.toHaveBeenCalled();expect(network).not.toHaveBeenCalled();
  }finally{sqlite.close();}
});
