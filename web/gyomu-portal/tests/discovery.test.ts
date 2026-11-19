import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Store } from '../src/db.js';
import { Catalog } from '../src/repository.js';
import { indexResource,htmlText } from '../src/discovery.js';
import { createApp } from '../src/app.js';
import { digest,type BlobStore } from '../src/storage.js';
import { now,type User,type Config } from '../src/model.js';

function fixture(){
 const store=new Store(':memory:'),catalog=new Catalog(store),data=new Map<string,Uint8Array<ArrayBuffer>>();
 const blobs:BlobStore={put:async bytes=>{const id=randomUUID();data.set(id,new Uint8Array(bytes));return id;},get:async id=>data.get(id)!,remove:async id=>{data.delete(id);}};
 const config:Config={origin:'http://127.0.0.1:8788',localDev:true,dataDir:'unused',adminEmail:'admin@japanopenpoker.com',allowedDomains:['japanopenpoker.com'],newsFeeds:[]};
 const users=['admin','a','b'].map((name,i)=>{const id=randomUUID();store.run('INSERT INTO users(id,email,name,role,created_at) VALUES (?,?,?,?,?)',id,name+'@japanopenpoker.com',name,i===0?'admin':'user',now());return store.one<User>('SELECT * FROM users WHERE id=?',id)!;});
 const sessions=users.map(u=>{const token=randomBytes(32).toString('hex'),csrf=randomUUID(),t=Math.floor(Date.now()/1000);store.run('INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at,renewed_at) VALUES (?,?,?,?,?,?)',digest(token),u.id,csrf,t+86400,t,t);return {cookie:'portal-session='+token,'x-csrf-token':csrf,origin:config.origin,'content-type':'application/json'};});
 const {app}=createApp(config,store,blobs);
 return {store,catalog,users,sessions,app,config,data,blobs,request:(path:string,init?:RequestInit)=>app.request(config.origin+path,init)};
}
const link=(title:string,extra:Record<string,unknown>={})=>({title,url:'https://example.com/tool',...extra});

test('fixed event hierarchy validates pairings, supports common/unset and permits only administrators to add scopes',async ()=>{
 const f=fixture();try{
  assert.deepEqual((await f.catalog.masters(f.users[1])).events.map(e=>e.name),['共通','JOPT','SPADIE','U-30','戦国','JOPT GAMES']);
  const created=(await f.catalog.create(f.users[1],link('大会用',{event:'jopt',event_scope_id:'jopt-tokyo'})));assert.equal(created.event,'JOPT');assert.equal(created.event_scope_name,'Tokyo');
  assert.equal((await f.catalog.list(f.users[1],new URLSearchParams({event:'JOPT',event_scope:'jopt-tokyo'}))).total,1);
  await assert.rejects(()=>f.catalog.create(f.users[1],link('wrong',{event:'SPADIE',event_scope_id:'jopt-tokyo'})),/組み合わせ/);
  await assert.rejects(()=>f.catalog.create(f.users[1],link('wrong',{event_scope_id:'jopt-tokyo'})),/組み合わせ/);
  assert.equal((await f.catalog.create(f.users[1],link('共通',{event:'共通'}))).event_scope_id,null);
  assert.equal((await f.catalog.create(f.users[1],link('未設定'))).event,null);
  await assert.rejects(()=>f.catalog.addEventScope(f.users[1],'JOPT','Yokohama'));
  const added=(await f.catalog.addEventScope(f.users[0],'JOPT','Yokohama'));assert.equal(added.event,'JOPT');
  await assert.rejects(()=>f.catalog.addEventScope(f.users[0],'JOPT',' ＹＯＫＯＨＡＭＡ '),/同じ/);
 }finally{f.store.close();}
});

test('optional tags reuse visible spellings, normalize duplicates and never reveal private tag suggestions',async ()=>{
 const f=fixture();try{
  const first=(await f.catalog.create(f.users[1],link('tagged',{tags:['Ticket',' ticket ','Ｔｉｃｋｅｔ','当日運営']})));assert.deepEqual(first.tags,['Ticket','当日運営']);
  assert.deepEqual((await f.catalog.create(f.users[2],link('tagged two',{tags:['TICKET','新しい特殊タグ']}))).tags,['Ticket','新しい特殊タグ']);
  (await f.catalog.create(f.users[1],link('secret',{tags:['private-only-tag'],visibility:'private'})));
  assert.ok(!(await f.catalog.masters(f.users[2])).tags.some(t=>t.name==='private-only-tag'));
  assert.equal((await f.catalog.list(f.users[2],new URLSearchParams({tag:'ticket'}))).total,2);
  (await f.catalog.create(f.users[1],link('both tags',{tags:['Ticket','当日運営']})));
  const multi=new URLSearchParams();multi.append('tag','ticket');multi.append('tag','当日運営');assert.equal((await f.catalog.list(f.users[2],multi)).total,2);
 }finally{f.store.close();}
});

test('multi-tournament resources appear once in each matching list, retain classifications on ordinary edits, and respect scoped filters and privacy',async ()=>{
 const f=fixture();try{
  const events=[{event:'SPADIE',event_scope_id:'spadie-tokyo'},{event:'JOPT GAMES',event_scope_id:null}];
  const item=(await f.catalog.create(f.users[1],link('joint announcement',{events,tags:['Ticket','告知']})));
  assert.equal(item.events.length,2);
  for(const event of ['SPADIE','JOPT GAMES'])assert.equal((await f.catalog.list(f.users[2],new URLSearchParams({event}))).items[0].id,item.id);
  const both=new URLSearchParams();both.append('event','SPADIE');both.append('event','JOPT GAMES');assert.equal((await f.catalog.list(f.users[2],both)).total,1);
  assert.equal((await f.catalog.list(f.users[2],new URLSearchParams({event:'JOPT GAMES',event_scope:'spadie-tokyo'}))).total,0);
  assert.equal((await f.catalog.list(f.users[2],new URLSearchParams({event:'SPADIE',event_scope:'spadie-tokyo'}))).total,1);
  const tags=new URLSearchParams('tag=Ticket&tag=告知');assert.equal((await f.catalog.list(f.users[2],tags)).total,1);tags.append('tag','missing');assert.equal((await f.catalog.list(f.users[2],tags)).total,0);
  const updated=(await f.catalog.update(item.id,f.users[1],link(item.title,{event:item.event,event_scope_id:item.event_scope_id,version:item.version})));assert.equal(updated.events.length,2);
  await assert.rejects(()=>f.catalog.create(f.users[1],link('duplicate',{events:[{event:'SPADIE'},{event:'spadie'}]})),/1回/);
  await assert.rejects(()=>f.catalog.create(f.users[1],link('unknown',{events:[{event:'Not a master'}]})),/一覧/);
  (await f.catalog.create(f.users[1],link('private joint',{events,visibility:'private'})));
  assert.equal((await f.catalog.list(f.users[2],both)).total,1);assert.equal((await f.catalog.masters(f.users[2])).events.find(e=>e.name==='JOPT GAMES')?.count,1);
  const cleared=(await f.catalog.update(item.id,f.users[1],link(item.title,{events:[],version:updated.version})));assert.deepEqual(cleared.events,[]);assert.equal(cleared.event,null);
 }finally{f.store.close();}
});

test('content search finds untagged documents using readable body and small alias groups with permission checks',async ()=>{
 const f=fixture();try{
  const r=(await f.catalog.create(f.users[1],link('運営メモ',{search_text:'チケットの販売数を日付ごとに整理します。'})));
  assert.equal((await f.catalog.list(f.users[2],new URLSearchParams({q:'Ticket sales'}))).items[0].id,r.id);
  const sentence=(await f.catalog.list(f.users[2],new URLSearchParams({q:'チケットの売上を確認したい'})));assert.equal(sentence.total,1);assert.ok(sentence.items[0].search_excerpt);
  (await f.catalog.create(f.users[1],link('secret',{search_text:'機密専用ワード',visibility:'private'})));
  assert.equal((await f.catalog.list(f.users[2],new URLSearchParams({q:'機密専用ワード'}))).total,0);
  assert.equal((await f.catalog.list(f.users[2],new URLSearchParams({q:'%_'}))).total,0);
 }finally{f.store.close();}
});

test('legacy MD remains readable and searchable under the resource permissions',async()=>{
 const f=fixture();
 try{
  const content='# 運営手順\n\n特殊検索語アルファ\n\n<script>bad()</script>\n\n![bad](https://example.com/unused.png)';
  const resource=(await f.catalog.create(f.users[1],link('集計',{visibility:'private'})));
  const file=new TextEncoder().encode(content),blob=await f.blobs.put(file);
  f.store.run('INSERT INTO resource_markdown VALUES (?,?,?,?,?,?,?,?)',resource.id,blob,'README.md',file.byteLength,digest(file),'特殊検索語アルファ',f.users[1].id,now());
  indexResource(f.store,resource.id);
  const r=f.catalog.view((await f.catalog.get(resource.id,f.users[1])),f.users[1]);
  assert.equal((await f.catalog.list(f.users[1],new URLSearchParams({q:'特殊検索語アルファ'}))).total,1);
  assert.equal((await f.catalog.list(f.users[2],new URLSearchParams({q:'特殊検索語アルファ'}))).total,0);
  const response=await f.request(r.markdown!.view_url,{headers:f.sessions[1]});
  const rendered=await response.json() as {rendered_html:string};
  assert.equal(response.status,200);
  assert.match(rendered.rendered_html,/<h1>/);
  assert.doesNotMatch(rendered.rendered_html,/<script|<img/i);
  assert.equal(await (await f.request(r.markdown!.download_url,{headers:f.sessions[1]})).text(),content);
  assert.equal((await f.request(r.markdown!.view_url,{headers:f.sessions[2]})).status,404);
  const updated=(await f.catalog.update(r.id,f.users[1],link('集計',{visibility:'private',version:r.version})));
  assert.equal(updated.markdown?.filename,'README.md');
 }finally{f.store.close();}
});

test('legacy HTML extraction indexes visible text only',()=>{
 const text=htmlText('<main>公開本文<script>scriptOnlySecret</script><p hidden>hiddenSecret</p></main>');
 assert.equal(text,'公開本文');
});

test('real stdio MCP registers URLs and searchable purpose without a file attachment',async()=>{
 const f=fixture();
 const client=new Client({name:'link-test',version:'1.0.0'});
 let server:ReturnType<typeof serve>|undefined;
 try{
  await new Promise<void>(ready=>{
   server=serve({fetch:f.app.fetch,hostname:'127.0.0.1',port:0},info=>{f.config.origin='http://127.0.0.1:'+info.port;ready();});
  });
  await client.connect(new StdioClientTransport({command:process.execPath,args:['--import',pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,resolve('src/mcp.ts')],env:{...process.env as Record<string,string>,PORTAL_ORIGIN:f.config.origin},stderr:'pipe'}));
  const listed=(await client.listTools()).tools.find(t=>t.name==='portal_register_link')!;
  assert.ok(listed.inputSchema.required?.includes('url'));
  assert.ok(!listed.inputSchema.properties?.markdown_path&&!listed.inputSchema.properties?.markdown);
  async function call(name:string,args:Record<string,unknown>={}){
   const result=await client.callTool({name,arguments:args});
   assert.ok(!result.isError,JSON.stringify(result.content));
   return JSON.parse((result.content as {text:string}[])[0].text);
  }
  async function execute(id:string){
   const res=await fetch(f.config.origin+'/api/agent/requests/'+id+'/execute',{method:'POST',headers:{...f.sessions[1],origin:f.config.origin}});
   assert.equal(res.status,200);
   return call('portal_result',{request_id:id});
  }
  const url='https://example.com/README.md';
  const pending=await call('portal_register_link',{title:'MCPリンク',url,description:'限定キーワードOMEGA',event:'JOPT',event_scope_id:'jopt-osaka'});
  const registered=await execute(pending.request_id);
  assert.equal(registered.state,'done');
  assert.equal(registered.result.url,url);
  assert.equal(registered.result.status,'draft');
  assert.equal(registered.result.visibility,'private');
  const ordinary=await execute((await call('portal_read',{id:registered.result.id})).request_id);
  assert.equal(ordinary.result.url,url);
  assert.equal(ordinary.result.markdown,null);
  assert.equal(f.data.size,0);
  assert.equal((await f.catalog.list(f.users[1],new URLSearchParams({q:'OMEGA'}))).total,1);
 }finally{
  await client.close();
  if(server)await new Promise<void>((done,fail)=>server!.close(e=>e?fail(e):done()));
  f.store.close();
 }
});
