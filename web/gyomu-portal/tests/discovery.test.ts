import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { mkdir,mkdtemp,writeFile,rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Store } from '../src/db.js';
import { Catalog } from '../src/repository.js';
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

test('fixed event hierarchy validates pairings, supports common/unset and permits only administrators to add scopes',()=>{
 const f=fixture();try{
  assert.deepEqual(f.catalog.masters(f.users[1]).events.map(e=>e.name),['共通','JOPT','SPADIE','U-30','戦国','JOPT GAMES']);
  const created=f.catalog.create(f.users[1],link('大会用',{event:'jopt',event_scope_id:'jopt-tokyo'}));assert.equal(created.event,'JOPT');assert.equal(created.event_scope_name,'Tokyo');
  assert.equal(f.catalog.list(f.users[1],new URLSearchParams({event:'JOPT',event_scope:'jopt-tokyo'})).total,1);
  assert.throws(()=>f.catalog.create(f.users[1],link('wrong',{event:'SPADIE',event_scope_id:'jopt-tokyo'})),/組み合わせ/);
  assert.throws(()=>f.catalog.create(f.users[1],link('wrong',{event_scope_id:'jopt-tokyo'})),/組み合わせ/);
  assert.equal(f.catalog.create(f.users[1],link('共通',{event:'共通'})).event_scope_id,null);
  assert.equal(f.catalog.create(f.users[1],link('未設定')).event,null);
  assert.throws(()=>f.catalog.addEventScope(f.users[1],'JOPT','Yokohama'));
  const added=f.catalog.addEventScope(f.users[0],'JOPT','Yokohama');assert.equal(added.event,'JOPT');
  assert.throws(()=>f.catalog.addEventScope(f.users[0],'JOPT',' ＹＯＫＯＨＡＭＡ '),/同じ/);
 }finally{f.store.close();}
});

test('optional tags reuse visible spellings, normalize duplicates and never reveal private tag suggestions',()=>{
 const f=fixture();try{
  const first=f.catalog.create(f.users[1],link('tagged',{tags:['Ticket',' ticket ','Ｔｉｃｋｅｔ','当日運営']}));assert.deepEqual(first.tags,['Ticket','当日運営']);
  assert.deepEqual(f.catalog.create(f.users[2],link('tagged two',{tags:['TICKET','新しい特殊タグ']})).tags,['Ticket','新しい特殊タグ']);
  f.catalog.create(f.users[1],link('secret',{tags:['private-only-tag'],visibility:'private'}));
  assert.ok(!f.catalog.masters(f.users[2]).tags.some(t=>t.name==='private-only-tag'));
  assert.equal(f.catalog.list(f.users[2],new URLSearchParams({tag:'ticket'})).total,2);
  f.catalog.create(f.users[1],link('both tags',{tags:['Ticket','当日運営']}));
  const multi=new URLSearchParams();multi.append('tag','ticket');multi.append('tag','当日運営');assert.equal(f.catalog.list(f.users[2],multi).total,2);
 }finally{f.store.close();}
});

test('multi-tournament resources appear once in each matching list, retain classifications on ordinary edits, and respect scoped filters and privacy',()=>{
 const f=fixture();try{
  const events=[{event:'SPADIE',event_scope_id:'spadie-tokyo'},{event:'JOPT GAMES',event_scope_id:null}];
  const item=f.catalog.create(f.users[1],link('joint announcement',{events,tags:['Ticket','告知']}));
  assert.equal(item.events.length,2);
  for(const event of ['SPADIE','JOPT GAMES'])assert.equal(f.catalog.list(f.users[2],new URLSearchParams({event})).items[0].id,item.id);
  const both=new URLSearchParams();both.append('event','SPADIE');both.append('event','JOPT GAMES');assert.equal(f.catalog.list(f.users[2],both).total,1);
  assert.equal(f.catalog.list(f.users[2],new URLSearchParams({event:'JOPT GAMES',event_scope:'spadie-tokyo'})).total,0);
  assert.equal(f.catalog.list(f.users[2],new URLSearchParams({event:'SPADIE',event_scope:'spadie-tokyo'})).total,1);
  const tags=new URLSearchParams('tag=Ticket&tag=告知');assert.equal(f.catalog.list(f.users[2],tags).total,1);tags.append('tag','missing');assert.equal(f.catalog.list(f.users[2],tags).total,0);
  const updated=f.catalog.update(item.id,f.users[1],link(item.title,{event:item.event,event_scope_id:item.event_scope_id,version:item.version}));assert.equal(updated.events.length,2);
  assert.throws(()=>f.catalog.create(f.users[1],link('duplicate',{events:[{event:'SPADIE'},{event:'spadie'}]})),/1回/);
  assert.throws(()=>f.catalog.create(f.users[1],link('unknown',{events:[{event:'Not a master'}]})),/一覧/);
  f.catalog.create(f.users[1],link('private joint',{events,visibility:'private'}));
  assert.equal(f.catalog.list(f.users[2],both).total,1);assert.equal(f.catalog.masters(f.users[2]).events.find(e=>e.name==='JOPT GAMES')?.count,1);
  const cleared=f.catalog.update(item.id,f.users[1],link(item.title,{events:[],version:updated.version}));assert.deepEqual(cleared.events,[]);assert.equal(cleared.event,null);
 }finally{f.store.close();}
});

test('content search finds untagged documents using readable body and small alias groups with permission checks',()=>{
 const f=fixture();try{
  const r=f.catalog.create(f.users[1],link('運営メモ',{search_text:'チケットの販売数を日付ごとに整理します。'}));
  assert.equal(f.catalog.list(f.users[2],new URLSearchParams({q:'Ticket sales'})).items[0].id,r.id);
  const sentence=f.catalog.list(f.users[2],new URLSearchParams({q:'チケットの売上を確認したい'}));assert.equal(sentence.total,1);assert.ok(sentence.items[0].search_excerpt);
  f.catalog.create(f.users[1],link('secret',{search_text:'機密専用ワード',visibility:'private'}));
  assert.equal(f.catalog.list(f.users[2],new URLSearchParams({q:'機密専用ワード'})).total,0);
  assert.equal(f.catalog.list(f.users[2],new URLSearchParams({q:'%_'})).total,0);
 }finally{f.store.close();}
});

test('MD attaches to a link, renders safely, downloads original content, enters search and follows resource permissions',async()=>{
 const f=fixture();try{
  const content='# 運営手順\n\n来場者アンケートを集計するための説明です。\n\n## 操作\n特殊検索語アルファで結果を確認。\n\n<script>alert(1)</script>\n\n![bad](https://evil.test/img)\n\n[bad](javascript:alert(1))';
  const response=await f.request('/api/resources',{method:'POST',headers:f.sessions[1],body:JSON.stringify(link('集計',{visibility:'private',markdown:{filename:'README.md',content}}))});assert.equal(response.status,201);
  const r=await response.json() as any;assert.equal(r.markdown.filename,'README.md');assert.equal(r.description,'来場者アンケートを集計するための説明です。');assert.ok(!JSON.stringify(r).includes('特殊検索語アルファ'));
  assert.equal(f.catalog.list(f.users[1],new URLSearchParams({q:'特殊検索語アルファ'})).total,1);assert.equal(f.catalog.list(f.users[2],new URLSearchParams({q:'特殊検索語アルファ'})).total,0);
  const md=await f.request(r.markdown.view_url,{headers:f.sessions[1]}),rendered=await md.json() as any;assert.match(rendered.rendered_html,/<h1>/);assert.doesNotMatch(rendered.rendered_html,/<script|<img|href="javascript:/i);
  assert.equal(await (await f.request(r.markdown.download_url,{headers:f.sessions[1]})).text(),content);
  assert.equal((await f.request(r.markdown.view_url,{headers:f.sessions[2]})).status,404);assert.equal((await f.request(r.markdown.download_url,{headers:f.sessions[2]})).status,404);
  const before=f.data.size;
  assert.equal((await f.request('/api/resources/'+r.id,{method:'PUT',headers:f.sessions[1],body:JSON.stringify(link('集計',{visibility:'private',version:99,markdown:{filename:'README.md',content:'new'}}))})).status,409);assert.equal(f.data.size,before);
  const replaced=await f.request('/api/resources/'+r.id,{method:'PUT',headers:f.sessions[1],body:JSON.stringify(link('集計',{visibility:'private',version:r.version,markdown:{filename:'README.md',content:'新しい説明文です。\n\n特殊検索語ベータ'}}))});assert.equal(replaced.status,200);
  assert.equal(f.catalog.list(f.users[1],new URLSearchParams({q:'特殊検索語アルファ'})).total,0);assert.equal(f.catalog.list(f.users[1],new URLSearchParams({q:'特殊検索語ベータ'})).total,1);
 }finally{f.store.close();}
});

test('HTML and MD multipart registration indexes visible content without executing scripts or indexing hidden data',async()=>{
 const f=fixture();try{
  const fd=new FormData();fd.append('metadata',JSON.stringify({title:'HTMLツール',event:'戦国',event_scope_id:'sengoku-autumn'}));fd.append('file',new File(['<main><p>本文だけのユニーク用語XYZ</p><script>scriptOnlySecret</script><p hidden>hiddenSecret</p></main>'],'index.html',{type:'text/html'}));fd.append('markdown_file',new File(['# 説明\n\n本文MD用語QRS'],'README.md',{type:'text/markdown'}));
  const {['content-type']:ignored,...headers}=f.sessions[1];const response=await f.request('/api/resources/upload',{method:'POST',headers,body:fd});assert.equal(response.status,201);const r=await response.json() as any;assert.equal(r.status,'draft');assert.ok(r.markdown);
  assert.equal(f.catalog.list(f.users[1],new URLSearchParams({q:'ユニーク用語XYZ'})).total,1);assert.equal(f.catalog.list(f.users[1],new URLSearchParams({q:'本文MD用語QRS'})).total,1);
  assert.equal(f.catalog.list(f.users[1],new URLSearchParams({q:'scriptOnlySecret'})).total,0);assert.equal(f.catalog.list(f.users[1],new URLSearchParams({q:'hiddenSecret'})).total,0);
  const bad=await f.request('/api/resources',{method:'POST',headers:f.sessions[1],body:JSON.stringify(link('bad',{markdown:{filename:'README.md',content:'x'.repeat(256*1024+1)}}))});assert.equal(bad.status,400);
 }finally{f.store.close();}
});

test('real MCP client attaches a local README and retrieves it only on demand in bounded chunks',async()=>{
 const f=fixture(),parent=resolve('.local');await mkdir(parent,{recursive:true});const dir=await mkdtemp(resolve(parent,'md-mcp-test-'));
 const client=new Client({name:'md-test',version:'1.0.0'});let server:ReturnType<typeof serve>|undefined;
 try{
  const content='# README\n\nツールの使用方法です。\n\n'+'確認事項です。'.repeat(500)+'\n限定キーワードOMEGA';const path=resolve(dir,'README.md');await writeFile(path,content);
  await new Promise<void>(ready=>{server=serve({fetch:f.app.fetch,hostname:'127.0.0.1',port:0},info=>{f.config.origin='http://127.0.0.1:'+info.port;ready();});});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['--import',pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,resolve('src/mcp.ts')],env:{...process.env as Record<string,string>,PORTAL_ORIGIN:f.config.origin},stderr:'pipe'}));
  async function call(name:string,args:Record<string,unknown>){const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r.content));return JSON.parse((r.content as {text:string}[])[0].text);}
  async function execute(id:string){const res=await fetch(f.config.origin+'/api/agent/requests/'+id+'/execute',{method:'POST',headers:{...f.sessions[1],origin:f.config.origin}});assert.equal(res.status,200);return call('portal_result',{request_id:id});}
  const pending=await call('portal_register_link',{title:'MCP添付',url:'https://example.com/tool',markdown_path:path,event:'JOPT',event_scope_id:'jopt-osaka'});
  const preview=await (await fetch(f.config.origin+'/api/agent/requests/'+pending.request_id,{headers:f.sessions[1]})).json() as any;assert.ok(preview.input.markdown.excerpt.length<=800);assert.ok(!JSON.stringify(preview).includes('OMEGA'));
  const registered=await execute(pending.request_id);assert.equal(registered.state,'done');assert.equal(registered.result.markdown.filename,'README.md');const id=registered.result.id;
  const ordinary=await execute((await call('portal_read',{id})).request_id);assert.ok(!JSON.stringify(ordinary).includes('OMEGA'));
  let offset=0,joined='';do{const part=await execute((await call('portal_read',{id,include_markdown:true,markdown_offset:offset})).request_id);assert.equal(part.state,'done');assert.ok(part.result.markdown.content.length<=2000);joined+=part.result.markdown.content;offset=part.result.markdown.has_more?part.result.markdown.next_offset:-1;}while(offset>=0);
  assert.equal(joined,content);assert.equal(f.catalog.list(f.users[1],new URLSearchParams({q:'OMEGA'})).total,1);
 }finally{await client.close();if(server)await new Promise<void>((done,fail)=>server!.close(e=>e?fail(e):done()));f.store.close();assert.equal(resolve(dir,'..'),parent);await rm(dir,{recursive:true,force:true});}
});
