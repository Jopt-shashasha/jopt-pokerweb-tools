import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Store } from '../src/db.js';
import { Catalog } from '../src/repository.js';
import { createApp } from '../src/app.js';
import { digest,type BlobStore } from '../src/storage.js';
import { now,type Config,type User } from '../src/model.js';

const blobStub:BlobStore={put:async()=>{throw Error('unused');},get:async()=>{throw Error('unused');},remove:async()=>{}};
function fixture(port=8788,transformTemplate=(template:string)=>template){
 const store=new Store(':memory:'),config:Config={origin:'http://127.0.0.1:'+port,localDev:true,dataDir:'unused',adminEmail:'admin@japanopenpoker.com',allowedDomains:['japanopenpoker.com'],newsFeeds:[]};
 const users=['admin','a','b'].map((name,i)=>{const id=randomUUID();store.run('INSERT INTO users(id,email,name,role,created_at) VALUES (?,?,?,?,?)',id,name+'@japanopenpoker.com',name,i===0?'admin':'user',now());return store.one<User>('SELECT * FROM users WHERE id=?',id)!;});
 const sessions=users.map(u=>{const token=randomBytes(32).toString('hex'),csrf=randomUUID(),t=Math.floor(Date.now()/1000);store.run('INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at,renewed_at) VALUES (?,?,?,?,?,?)',digest(token),u.id,csrf,t+86400,t,t);return {cookie:'portal-session='+token,csrf};});
 const {app}=createApp(config,store,blobStub,undefined,{setupTemplate:transformTemplate(readFileSync(new URL('../src/codex-setup.ps1',import.meta.url),'utf8'))}),catalog=new Catalog(store);
 const request=(path:string,init?:RequestInit)=>app.request(config.origin+path,init);
 const headers=(i:number)=>({cookie:sessions[i].cookie,origin:config.origin,'x-csrf-token':sessions[i].csrf});
 async function setup(i:number,label='PC-'+i){
  const res=await request('/api/codex/setup',{method:'POST',headers:headers(i)});assert.equal(res.status,201);
  const body=await res.json() as {prompt:string;codex_url:string};const code=body.prompt.match(/code=([a-f0-9]{32})/)![1];
  return {...body,code,exchange:()=>request('/setup/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,label})})};
 }
 return {store,config,users,app,catalog,request,headers,setup};
}

test('Windows PowerShell downloads the script for inspection before local execution', {skip:process.platform!=='win32'}, async()=>{
 const local=resolve('.local');
 await mkdir(local,{recursive:true});
 const codexHome=await mkdtemp(join(local,'codex-setup-test-'));
 const port=19000+Math.floor(Math.random()*2000);
 const f=fixture(port,template=>{
  const userWrite="[Environment]::SetEnvironmentVariable($EnvName, $res.token, 'User')";
  assert.ok(template.includes(userWrite));
  return template.replace(userWrite,userWrite.replace("'User'","'Process'"));
 });
 const server=serve({fetch:f.app.fetch,hostname:'127.0.0.1',port});
 try{
  if(!server.listening)await once(server,'listening');
  const s=await f.setup(1);
  const [download]=s.prompt.match(/(?<=```powershell\n)[\s\S]*?(?=\n```)/)??[];
  assert.ok(download);
  const run=promisify(execFile);
  const powershell=(command:string)=>run('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{
   windowsHide:true,env:{...process.env,CODEX_HOME:codexHome,TEMP:codexHome,TMP:codexHome},timeout:30000
  });
  const saved=(await powershell(download.split('\n').join('; '))).stdout.trim();
  assert.equal(resolve(saved),join(codexHome,basename(saved)));
  assert.deepEqual(await readdir(codexHome),[basename(saved)]);
  assert.equal(f.store.one('SELECT id FROM agent_tokens LIMIT 1'),undefined);
  const source=await readFile(saved);
  assert.equal(source.subarray(0,3).toString('hex'),'efbbbf');
  assert.match(source.toString('utf8'),/Invoke-RestMethod -Method Post/);
  const escapedPath=saved.replaceAll("'","''");
  const result=await powershell(`if ((Get-FileHash -LiteralPath '${escapedPath}' -Algorithm SHA256).Hash -ne '${digest(source)}') { throw 'File changed after review' }; & '${escapedPath}'`);
  assert.match(result.stdout,/SETUP COMPLETE: a \(a@japanopenpoker\.com\)/);
  const config=await readFile(join(codexHome,'config.toml'),'utf8');
  assert.ok(config.includes(`url = "${f.config.origin}/mcp"`));
  assert.match(config,/bearer_token_env_var = "JOPT_PORTAL_TOKEN"/);
  assert.equal((await s.exchange()).status,404);
 }finally{
  await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));
  f.store.close();
  for(const file of await readdir(codexHome))await rm(join(codexHome,file),{force:true});
  await rmdir(codexHome);
 }
});

test('setup button yields a Codex deep link with a one-time code; the script is served only while valid',async()=>{
 const f=fixture();try{
  assert.equal((await f.request('/api/codex/setup',{method:'POST'})).status,401);
  assert.equal((await f.request('/api/codex/setup',{method:'POST',headers:{cookie:f.headers(1).cookie,origin:f.config.origin}})).status,403);
  const s=await f.setup(1);
  assert.ok(s.codex_url.startsWith('codex://new?prompt='));assert.equal(decodeURIComponent(s.codex_url.slice('codex://new?prompt='.length)),s.prompt);
  assert.ok(s.prompt.includes(`-Uri '${f.config.origin}/setup.ps1?code=${s.code}' -OutFile $setupFile -ErrorAction Stop`));
  assert.match(s.prompt,/Get-Content -LiteralPath/);
  assert.doesNotMatch(s.prompt,/Invoke-Expression|ScriptBlock|ExecutionPolicy Bypass|jpt_/i);
  const script=await f.request('/setup.ps1?code='+s.code);assert.equal(script.status,200);assert.match(script.headers.get('content-type')!,/charset=utf-8/);
  const text=await script.text();assert.ok(text.includes(f.config.origin)&&text.includes(s.code)&&!text.includes('__'));
  assert.equal((await f.request('/setup.ps1?code='+'0'.repeat(32))).status,404);
  assert.equal((await f.request('/setup.ps1?code=bad')).status,404);
  // A second press replaces the previous unused code.
  const s2=await f.setup(1);assert.equal((await s.exchange()).status,404);
  const ok=await s2.exchange();assert.equal(ok.status,200);const tok=await ok.json() as {token:string;name:string;mcp_url:string};
  assert.match(tok.token,/^jpt_[a-f0-9]{64}$/);assert.equal(tok.name,'a');assert.equal(tok.mcp_url,f.config.origin+'/mcp');
  assert.equal((await s2.exchange()).status,404,'codes are single use');
  assert.equal((await f.request('/setup.ps1?code='+s2.code)).status,404);
  assert.equal(f.store.one<{n:number}>("SELECT COUNT(*) n FROM agent_tokens WHERE token_hash=?",digest(tok.token))!.n,1);
  assert.equal(f.store.one<{n:number}>("SELECT COUNT(*) n FROM agent_tokens WHERE token_hash LIKE 'jpt_%'")!.n,0);
  const expired=await f.setup(2);f.store.run('UPDATE agent_setup_codes SET expires_at=0');assert.equal((await expired.exchange()).status,404);
  assert.equal((await f.request('/setup/exchange',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.test'},body:'{}'})).status,403);
 }finally{f.store.close();}
});

test('tokens identify the employee, can be listed and revoked, and die with the account',async()=>{
 const f=fixture();try{
  const tok=(await (await (await f.setup(1)).exchange()).json() as {token:string}).token;
  const who=(t:string)=>f.request('/setup/whoami',{headers:{authorization:'Bearer '+t}});
  assert.equal((await who(tok)).status,200);assert.equal((await (await who(tok)).json() as {email:string}).email,'a@japanopenpoker.com');
  assert.equal((await who('jpt_'+'0'.repeat(64))).status,401);
  // Re-running setup on the same PC revokes that PC's old token.
  const tok2=(await (await (await f.setup(1)).exchange()).json() as {token:string}).token;
  assert.equal((await who(tok)).status,401);assert.equal((await who(tok2)).status,200);
  const list=await (await f.request('/api/codex/tokens',{headers:f.headers(1)})).json() as {items:{id:string;label:string}[]};
  assert.equal(list.items.length,1);assert.equal(list.items[0].label,'PC-1');assert.ok(!JSON.stringify(list).includes('jpt_'));
  assert.equal((await f.request('/api/codex/tokens/'+list.items[0].id,{method:'DELETE',headers:f.headers(2)})).status,404,'cannot revoke someone else\'s token');
  assert.equal((await f.request('/api/codex/tokens/'+list.items[0].id,{method:'DELETE',headers:f.headers(1)})).status,200);
  assert.equal((await who(tok2)).status,401);
  const tok3=(await (await (await f.setup(1)).exchange()).json() as {token:string}).token;
  f.store.run('UPDATE users SET active=0 WHERE id=?',f.users[1].id);assert.equal((await who(tok3)).status,401);
 }finally{f.store.close();}
});

test('remote MCP over HTTP: shared Codex accounts still act as the token owner',async()=>{
 const port=18000+Math.floor(Math.random()*1000),f=fixture(port);
 const server=serve({fetch:f.app.fetch,hostname:'127.0.0.1',port});
 try{
  const mine=(await f.catalog.create(f.users[2],{title:'Voucher照合ツール',url:'https://example.com/v',visibility:'company',status:'published',description:'Voucher照合が5分→30秒'}));
  const secret=(await f.catalog.create(f.users[1],{title:'Voucher 秘密メモ',url:'https://example.com/s',visibility:'private'}));
  const tokA=(await (await (await f.setup(1)).exchange()).json() as {token:string}).token;
  const tokB=(await (await (await f.setup(2)).exchange()).json() as {token:string}).token;
  const connect=async(token?:string)=>{const c=new Client({name:'test',version:'1'});await c.connect(new StreamableHTTPClientTransport(new URL(f.config.origin+'/mcp'),{requestInit:{headers:token?{authorization:'Bearer '+token}:{}}}));return c;};
  await assert.rejects(connect());await assert.rejects(connect('jpt_'+'1'.repeat(64)));
  const a=await connect(tokA),b=await connect(tokB);
  const tools=(await a.listTools()).tools;
  const registration=tools.find(t=>t.name==='portal_register_link')!;
  assert.ok(registration.inputSchema.required?.includes('url'));
  assert.ok(!registration.inputSchema.properties?.markdown);
  const names=tools.map(t=>t.name).sort();
  assert.deepEqual(names,['portal_news','portal_read','portal_register_link','portal_registration_options','portal_result','portal_search','portal_whats_new','portal_whoami']);
  const parse=(r:any)=>JSON.parse(r.content[0].text);
  assert.equal(parse(await a.callTool({name:'portal_whoami',arguments:{}})).email,'a@japanopenpoker.com');
  assert.equal(parse(await b.callTool({name:'portal_whoami',arguments:{}})).email,'b@japanopenpoker.com');
  const sa=parse(await a.callTool({name:'portal_search',arguments:{q:'Voucher'}})),sb=parse(await b.callTool({name:'portal_search',arguments:{q:'Voucher'}}));
  assert.equal(sa.total,2,'owner sees own private memo');assert.equal(sb.total,1);assert.ok(!JSON.stringify(sb).includes('秘密'));
  const denied=await b.callTool({name:'portal_read',arguments:{id:secret.id}});assert.equal(denied.isError,true);
  const read=parse(await b.callTool({name:'portal_read',arguments:{id:mine.id}}));assert.equal(read.url,'https://example.com/v');
  assert.equal(f.store.one<{n:number}>("SELECT COUNT(*) n FROM resource_usage WHERE user_id=? AND resource_id=? AND action='read'",f.users[2].id,mine.id)!.n,1);
  const iso=(h:number)=>new Date(Date.now()-h*3600000).toISOString();
  f.store.run('INSERT INTO news_cache VALUES (1,?,?)',JSON.stringify([{title:'Codexに新機能',url:'https://news.example/1',source:'ML_Bear Times',published_at:iso(1),summary:'新しいツールが使えるようになりました。',format:'story'},{title:'ChatGPTの新しい使い方',url:'https://news.example/2',source:'ML_Bear Times',published_at:iso(2),summary:'利用手順が公開されました。',format:'story'},{title:'Codexの新機能（先週）',url:'https://news.example/3',source:'ML_Bear Times',published_at:iso(24*10),summary:'新機能',format:'story'}]),Math.floor(Date.now()/1000));
  const fresh=parse(await a.callTool({name:'portal_whats_new',arguments:{}}));assert.equal(fresh.items.length,1);assert.equal(fresh.items[0].title,'Voucher照合ツール');
  assert.deepEqual(fresh.news.map((n:any)=>n.title),['Codexに新機能','ChatGPTの新しい使い方'],'recent news only, max 2');
  assert.equal(parse(await a.callTool({name:'portal_news',arguments:{}})).items.length,3);
  assert.ok(!('description' in fresh.items[0])&&!('summary' in fresh.news[0]),'compact payload');
  const again=parse(await a.callTool({name:'portal_whats_new',arguments:{}}));assert.deepEqual(again,{skip:true},'once per week per PC');
  assert.ok(JSON.stringify(again).length<20,'skipped calls cost almost nothing');
  assert.equal(parse(await b.callTool({name:'portal_whats_new',arguments:{}})).news.length,2,'per PC');
  // Admin can switch to daily; the next JST day then gets a notice again.
  assert.equal((await f.request('/api/admin/codex/notice-interval',{method:'PUT',headers:{...f.headers(1),'content-type':'application/json'},body:JSON.stringify({interval:'daily'})})).status,403);
  assert.equal((await f.request('/api/admin/codex/notice-interval',{method:'PUT',headers:{...f.headers(0),'content-type':'application/json'},body:JSON.stringify({interval:'daily'})})).status,200);
  f.store.run("UPDATE agent_tokens SET last_notice_at='d0'");
  assert.equal(parse(await a.callTool({name:'portal_whats_new',arguments:{}})).skip,undefined,'new day under the daily setting');
  // Registration still needs the same employee's browser.
  const reg=parse(await a.callTool({name:'portal_register_link',arguments:{title:'新ツール',url:'https://example.com/n'}}));
  assert.ok(reg.browser_url.includes(reg.request_id));
  assert.equal((await f.request('/api/agent/requests/'+reg.request_id+'/execute',{method:'POST',headers:f.headers(2)})).status,404,'another employee cannot execute');
  assert.equal(parse(await b.callTool({name:'portal_result',arguments:{request_id:reg.request_id}})).error!==undefined,true);
  assert.equal((await f.request('/api/agent/requests/'+reg.request_id+'/execute',{method:'POST',headers:f.headers(1)})).status,200);
  const done=parse(await a.callTool({name:'portal_result',arguments:{request_id:reg.request_id}}));assert.equal(done.state,'done');
  assert.equal(f.store.one<{creator_id:string;status:string;visibility:string}>("SELECT creator_id,status,visibility FROM resources WHERE title='新ツール'")!.creator_id,f.users[1].id);
  const evil=await fetch(f.config.origin+'/mcp',{method:'POST',headers:{authorization:'Bearer '+tokA,origin:'https://evil.test','content-type':'application/json'},body:'{}'});assert.equal(evil.status,403);
  await a.close();await b.close();
 }finally{server.close();f.store.close();}
});
