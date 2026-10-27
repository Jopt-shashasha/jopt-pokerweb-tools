import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import { faqTestMembers } from './faq-test-members.js';
import { faq } from './faq.js';

describe('self-service FAQ test menu members', () => {
  let fixture: ReturnType<typeof sqliteD1>, app: Hono<any>;
  let current: Map<string,string>, calls: string[], failUser: string, failRead: string;
  let role: string | null;
  const root='/api/accounts/account-a/faq-test-members';
  beforeEach(() => {
    fixture=sqliteD1();fixture.sqlite.exec(readFileSync(new URL('../../../../packages/db/bootstrap.sql',import.meta.url),'utf8'));
    fixture.db.batch=async statements=>{fixture.sqlite.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());fixture.sqlite.exec('COMMIT');return out as any;}catch(e){fixture.sqlite.exec('ROLLBACK');throw e;}};
    for(const id of ['a','b']){
      fixture.sqlite.prepare('INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES(?,?,?,?,?)').run(`account-${id}`,`channel-${id}`,id,`token-${id}`,'secret');
      fixture.sqlite.prepare('INSERT INTO friends(id,line_user_id,line_account_id,display_name) VALUES(?,?,?,?)').run(`friend-${id}`,`user-${id}`,`account-${id}`,`同僚${id}`);
    }
    fixture.sqlite.exec(`INSERT INTO friends(id,line_user_id,line_account_id,display_name) VALUES('friend-c','user-c','account-a','同僚c');
      INSERT INTO rich_menu_groups(id,account_id,name,chat_bar_text,size,status,default_page_id) VALUES('test','account-a','テスト','メニュー','large','published','test-page'),('prod','account-a','正式','メニュー','large','published','prod-page');
      INSERT INTO rich_menu_pages(id,group_id,order_index,name,alias_id,line_richmenu_id) VALUES('test-page','test',0,'テスト','test-alias','menu-test'),('prod-page','prod',0,'正式','prod-alias','menu-prod');
      INSERT INTO faq_releases(id,account_id,content_hash,payload,validation,created_by,created_at) VALUES('release','account-a','hash','{}','{}','owner','2026-10-26');
      INSERT INTO faq_deployments(account_id,audience,release_id,test_friend_ids,test_open,updated_by,updated_at) VALUES('account-a','test','release','[]',1,'owner','2026-10-26');`);
    current=new Map([['user-a','menu-old']]);calls=[];failUser='';failRead='';role='staff';
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Real network forbidden'));
    vi.spyOn(LineClient.prototype,'getRichMenuList').mockImplementation(async()=>({richmenus:[
      {richMenuId:'menu-test',areas:[{action:{type:'postback',data:'faqv1:test'}}]},
      {richMenuId:'menu-prod',areas:[{action:{type:'postback',data:'faqv1:start'}}]},
      {richMenuId:'menu-old',areas:[]},
    ]} as any));
    vi.spyOn(LineClient.prototype,'getRichMenuIdOfUser').mockImplementation(async user=>{if(user===failRead)throw Error('500 upstream');if(!current.has(user))throw Error('404 not found');return {richMenuId:current.get(user)!};});
    vi.spyOn(LineClient.prototype,'linkRichMenuToUser').mockImplementation(async(user,menu)=>{calls.push(`link:${user}:${menu}`);if(user===failUser)throw Error('LINE failure');current.set(user,menu);return {};});
    vi.spyOn(LineClient.prototype,'unlinkRichMenuFromUser').mockImplementation(async user=>{calls.push(`unlink:${user}`);current.delete(user);return {};});
    app=new Hono();app.use('*',async(c,next)=>{if(role)c.set('staff',{id:'staff-a',name:'担当者',role});await next();});app.route('/',faqTestMembers);app.route('/',faq);
  });
  afterEach(()=>{expect(fetch).not.toHaveBeenCalled();fixture.sqlite.close();vi.restoreAllMocks();});
  function request(method='GET',body?:unknown,suffix='') {return app.request(root+suffix,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},{DB:fixture.db});}
  function member(){return fixture.sqlite.prepare('SELECT * FROM faq_test_menu_members WHERE friend_id=?').get('friend-a') as any;}
  function allowlist(){return JSON.parse((fixture.sqlite.prepare('SELECT test_friend_ids FROM faq_deployments').get() as any).test_friend_ids);}
  const add=(friendIds=['friend-a'],groupId='test')=>request('POST',{friendIds,groupId});
  it('lets authenticated staff add a colleague, persist the previous menu, and repeat safely',async()=>{
    expect((await add()).status).toBe(200);expect(member()).toMatchObject({previous_menu_id:'menu-old',rich_menu_id:'menu-test',added_by:'staff-a'});
    expect(allowlist()).toEqual(['friend-a']);await add();expect(calls).toEqual(['link:user-a:menu-test']);
    const r=await request();const d=(await r.json() as any).data;expect(d.groups.map((x:any)=>x.id)).toEqual(['test']);expect(d.members[0].state).toBe('active');
  });
  it('requires authentication for reading and mutation',async()=>{role=null;expect((await request()).status).toBe(401);expect((await add()).status).toBe(401);expect(calls).toEqual([]);});
  it('rejects another account, blocked friends, and production menus before any binding',async()=>{
    expect((await add(['friend-b'])).status).toBe(400);fixture.sqlite.exec("UPDATE friends SET is_following=0 WHERE id='friend-a'");expect((await add()).status).toBe(400);
    fixture.sqlite.exec("UPDATE friends SET is_following=1 WHERE id='friend-a'");expect((await add(['friend-a'],'prod')).status).toBe(400);expect(calls).toEqual([]);
  });
  it('requires an active FAQ test deployment',async()=>{fixture.sqlite.exec('DELETE FROM faq_deployments');expect((await add()).status).toBe(409);expect(calls).toEqual([]);});
  it('restores the previous individual menu and removes the allowlist entry',async()=>{
    await add();expect((await request('DELETE',undefined,'/friend-a')).status).toBe(200);expect(current.get('user-a')).toBe('menu-old');expect(member()).toBeUndefined();expect(allowlist()).toEqual([]);
  });
  it('unlinks the test menu to use the official default when no previous individual menu exists',async()=>{
    current.clear();await add();await request('DELETE',undefined,'/friend-a');expect(current.has('user-a')).toBe(false);expect(calls).toContain('unlink:user-a');
  });
  it('preserves a menu changed elsewhere on removal, and blocks silent overwrite on re-add',async()=>{
    await add();current.set('user-a','someone-else');const r=await add();expect((await r.json() as any).data.results[0].success).toBe(false);
    await request('DELETE',undefined,'/friend-a');expect(current.get('user-a')).toBe('someone-else');expect(calls).toEqual(['link:user-a:menu-test']);
  });
  it('reports partial LINE failures per person and records only successful additions',async()=>{
    failUser='user-c';const r=await add(['friend-a','friend-c']);expect((await r.json() as any).data.results.map((x:any)=>x.success)).toEqual([true,false]);
    expect(fixture.sqlite.prepare('SELECT friend_id FROM faq_test_menu_members').all()).toEqual([{friend_id:'friend-a'}]);expect(allowlist()).toEqual(['friend-a']);
  });
  it('keeps records and labels LINE lookup failures as unavailable',async()=>{
    await add();failRead='user-a';const r=await request();expect((await r.json() as any).data.members[0].state).toBe('unavailable');
    expect((await request('DELETE',undefined,'/friend-a')).status).toBe(502);expect(member()).toBeDefined();
  });
  it('atomically rolls back membership and restores LINE when DB registration fails',async()=>{
    fixture.sqlite.exec("CREATE TRIGGER reject_member BEFORE INSERT ON faq_test_menu_members BEGIN SELECT RAISE(ABORT,'test failure'); END;");
    const r=await add();expect((await r.json() as any).data.results[0].success).toBe(false);expect(current.get('user-a')).toBe('menu-old');expect(allowlist()).toEqual([]);expect(member()).toBeUndefined();
  });
  it('enforces the private-test member limit without LINE changes',async()=>{
    fixture.sqlite.prepare('UPDATE faq_deployments SET test_open=0,test_friend_ids=?').run(JSON.stringify(Array.from({length:30},(_,i)=>'other-'+i)));
    expect((await add()).status).toBe(400);expect(calls).toEqual([]);
  });
});
