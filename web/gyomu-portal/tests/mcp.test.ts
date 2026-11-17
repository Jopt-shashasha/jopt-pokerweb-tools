import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/db.js';
import { Catalog } from '../src/repository.js';
import { AgentRequests } from '../src/agent-requests.js';
import { createApp } from '../src/app.js';
import { digest,type BlobStore } from '../src/storage.js';
import { now,type Config,type User } from '../src/model.js';

const blobStub:BlobStore={put:async()=>{throw Error('unused');},get:async()=>{throw Error('unused');},remove:async()=>{}};
function fixture(){
 const store=new Store(':memory:'),config:Config={origin:'http://127.0.0.1:8788',localDev:true,dataDir:'unused',adminEmail:'admin@japanopenpoker.com',allowedDomains:['japanopenpoker.com'],newsFeeds:[]};
 const users=['admin','a','b'].map((name,i)=>{const id=randomUUID();store.run('INSERT INTO users(id,email,name,role,created_at) VALUES (?,?,?,?,?)',id,name+'@japanopenpoker.com',name,i===0?'admin':'user',now());return store.one<User>('SELECT * FROM users WHERE id=?',id)!;});
 const sessions=users.map(u=>{const token=randomBytes(32).toString('hex'),csrf=randomUUID(),t=Math.floor(Date.now()/1000);store.run('INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at,renewed_at) VALUES (?,?,?,?,?,?)',digest(token),u.id,csrf,t+86400,t,t);return {cookie:'portal-session='+token,csrf,hash:digest(token)};});
 const catalog=new Catalog(store),agent=new AgentRequests(store,catalog,config),{app}=createApp(config,store,blobStub);
 const request=(path:string,init?:RequestInit)=>app.request(config.origin+path,init);
 const headers=(i:number)=>({cookie:sessions[i].cookie,origin:config.origin,'x-csrf-token':sessions[i].csrf});
 const enqueue=async(operation:string,input:unknown)=>{
  const key=randomBytes(32).toString('hex'),res=await request('/agent/requests',{method:'POST',headers:{'x-portal-agent':'1','content-type':'application/json'},body:JSON.stringify({operation,input,result_key:key})});assert.equal(res.status,202);return {...await res.json() as {request_id:string},key};
 };
 return {store,config,users,sessions,catalog,agent,app,request,headers,enqueue};
}

test('anonymous MCP requests never execute without browser authentication and CSRF; reads obey current account permissions',async()=>{
 const f=fixture();try{
  const privateDoc=f.catalog.create(f.users[1],{title:'secret',url:'https://example.com/private',visibility:'private'});
  const pending=await f.enqueue('read',{id:privateDoc.id}),path='/api/agent/requests/'+pending.request_id;
  assert.equal((await f.request(path)).status,401);
  assert.equal((await f.request(path+'/execute',{method:'POST'})).status,401);
  assert.equal((await f.request(path+'/execute',{method:'POST',headers:{cookie:f.sessions[2].cookie}})).status,403);
  assert.equal((await f.request(path+'/execute',{method:'POST',headers:{...f.headers(2),origin:'https://evil.test'}})).status,403);
  const denied=await f.request(path+'/execute',{method:'POST',headers:f.headers(2)});const result=await denied.json() as {state:string;result:{error:string}};
  assert.equal(result.state,'error');assert.ok(!JSON.stringify(result).includes('secret'));
  const good=await f.enqueue('read',{id:privateDoc.id});
  assert.equal((await f.request('/api/agent/requests/'+good.request_id+'/execute',{method:'POST',headers:f.headers(1)})).status,200);
  const headers={'x-portal-agent':'1',authorization:'Bearer '+good.key};
  const response=await f.request('/agent/requests/'+good.request_id+'/result',{headers});assert.equal(response.status,200);assert.ok((await response.text()).includes('secret'));
  assert.equal((await f.request('/agent/requests/'+good.request_id+'/result',{headers:{...headers,authorization:'Bearer '+randomBytes(32).toString('hex')}})).status,404);
  assert.equal((await f.request('/api/agent/requests/'+good.request_id,{headers:f.headers(2)})).status,404);
  await f.request('/auth/logout',{method:'POST',headers:f.headers(1)});
  assert.equal((await f.request('/agent/requests/'+good.request_id+'/result',{headers})).status,404);
 }finally{f.store.close();}
});

test('browser registration is atomic and idempotent; only admins can assign creators',async()=>{
 const f=fixture();try{
  const bad=await f.enqueue('register',{title:'delegated',url:'https://example.com',creator_id:f.users[1].id});
  const denied=await f.request('/api/agent/requests/'+bad.request_id+'/execute',{method:'POST',headers:f.headers(2)});
  assert.equal((await denied.json() as {state:string}).state,'error');assert.equal(f.store.one<{n:number}>('SELECT COUNT(*) n FROM resources')?.n,0);
  const good=await f.enqueue('register',{title:'delegated',url:'https://example.com',creator_id:f.users[1].id});
  f.store.db.exec("CREATE TRIGGER fail_agent_result BEFORE UPDATE ON agent_requests WHEN NEW.state='done' BEGIN SELECT RAISE(ABORT,'test-failure'); END;");
  await assert.rejects(f.agent.execute(good.request_id,f.users[0],f.sessions[0].hash),/test-failure/);
  assert.equal(f.store.one<{n:number}>('SELECT COUNT(*) n FROM resources')?.n,0);
  assert.equal(f.store.one<{state:string}>('SELECT state FROM agent_requests WHERE id=?',good.request_id)?.state,'pending');
  f.store.db.exec('DROP TRIGGER fail_agent_result');
  const first=await (await f.request('/api/agent/requests/'+good.request_id+'/execute',{method:'POST',headers:f.headers(0)})).json();
  const again=await (await f.request('/api/agent/requests/'+good.request_id+'/execute',{method:'POST',headers:f.headers(0)})).json();assert.deepEqual(first,again);
  const rows=f.store.all<{creator_id:string;registered_by:string;status:string;visibility:string}>('SELECT creator_id,registered_by,status,visibility FROM resources');assert.equal(rows.length,1);
  assert.deepEqual({...rows[0]},{creator_id:f.users[1].id,registered_by:f.users[0].id,status:'draft',visibility:'private'});
 }finally{f.store.close();}
});

test('agent requests reject cross-site queueing, unsafe input, cancellation and expiry',async()=>{
 const f=fixture();try{
  const body=JSON.stringify({operation:'search',input:{q:'x'},result_key:'a'.repeat(64)});
  assert.equal((await f.request('/agent/requests',{method:'POST',headers:{'content-type':'application/json'},body})).status,403);
  assert.equal((await f.request('/agent/requests',{method:'POST',headers:{'x-portal-agent':'1','content-type':'application/json',origin:'https://evil.test'},body})).status,403);
  assert.equal((await f.request('/agent/requests',{method:'POST',headers:{'x-portal-agent':'1','content-type':'application/json'},body:JSON.stringify({operation:'register',input:{title:'bad',url:'javascript:alert(1)'},result_key:'a'.repeat(64)})})).status,400);
  const cancelled=await f.enqueue('register',{title:'no',url:'https://example.com'});
  await f.request('/api/agent/requests/'+cancelled.request_id+'/cancel',{method:'POST',headers:f.headers(1)});
  assert.equal((await (await f.request('/api/agent/requests/'+cancelled.request_id+'/execute',{method:'POST',headers:f.headers(1)})).json() as {state:string}).state,'cancelled');
  assert.equal(f.store.one<{n:number}>('SELECT COUNT(*) n FROM resources')?.n,0);
  const expired=await f.enqueue('search',{});f.store.run('UPDATE agent_requests SET expires_at=0 WHERE id=?',expired.request_id);
  assert.equal((await f.request('/api/agent/requests/'+expired.request_id,{headers:f.headers(0)})).status,404);
 }finally{f.store.close();}
});

test('result capabilities stay isolated and stop working after logout or account deactivation',async()=>{
 const f=fixture();try{
  const request=await f.enqueue('search',{});f.agent.execute(request.request_id,f.users[1],f.sessions[1].hash);
  assert.throws(()=>f.agent.result(request.request_id,'b'.repeat(64)));
  assert.equal(f.agent.result(request.request_id,request.key).state,'done');
  assert.equal((await f.request('/api/agent/requests/'+request.request_id,{headers:f.headers(2)})).status,404);
  f.store.run('UPDATE users SET active=0 WHERE id=?',f.users[1].id);assert.throws(()=>f.agent.result(request.request_id,request.key),/ログイン/);
  f.store.run('UPDATE users SET active=1 WHERE id=?',f.users[1].id);
  assert.equal((await f.request('/auth/logout',{method:'POST',headers:f.headers(1)})).status,200);
  assert.throws(()=>f.agent.result(request.request_id,request.key),/リクエスト/);
  assert.equal(f.store.one<{n:number}>('SELECT COUNT(*) n FROM sessions')?.n,2);
 }finally{f.store.close();}
});

test('real MCP stdio client discovers tools and completes search/read/register through browser-authenticated endpoints',async()=>{
 const f=fixture();let server:ReturnType<typeof serve>|undefined;const client=new Client({name:'portal-integration-test',version:'1.0.0'});
 try{
  await new Promise<void>(ready=>{server=serve({fetch:f.app.fetch,hostname:'127.0.0.1',port:0},info=>{f.config.origin='http://127.0.0.1:'+info.port;ready();});});
  f.catalog.create(f.users[1],{title:'shared test',url:'https://example.com/shared'});
  f.catalog.create(f.users[1],{title:'secret test',url:'https://example.com/private',visibility:'private'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['--import',pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,resolve('src/mcp.ts')],env:{...process.env as Record<string,string>,PORTAL_ORIGIN:f.config.origin},stderr:'inherit'}));
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['portal_status','portal_registration_options','portal_search','portal_read','portal_register_link','portal_result'].sort());
  async function call(name:string,args:Record<string,unknown>={}){const value=await client.callTool({name,arguments:args});assert.ok(!value.isError);return JSON.parse((value.content as {type:string;text:string}[])[0].text);}
  assert.equal((await call('portal_status')).ok,true);
  const vocabulary=await call('portal_registration_options');assert.ok(vocabulary.events.some((e:{name:string})=>e.name==='JOPT GAMES'));assert.ok(!JSON.stringify(vocabulary).includes('secret test'));assert.ok(!JSON.stringify(vocabulary).includes('count'));
  const searched=await call('portal_search',{q:'test'});assert.equal((await call('portal_result',{request_id:searched.request_id})).state,'pending');
  const run=async(id:string)=>{const res=await fetch(f.config.origin+'/api/agent/requests/'+id+'/execute',{method:'POST',headers:f.headers(2)});assert.equal(res.status,200);};
  await run(searched.request_id);const results=await call('portal_result',{request_id:searched.request_id});assert.equal(results.result.total,1);assert.equal(results.result.items[0].title,'shared test');assert.ok(!JSON.stringify(results).includes('secret'));
  const read=await call('portal_read',{id:results.result.items[0].id});await run(read.request_id);assert.equal((await call('portal_result',{request_id:read.request_id})).result.url,'https://example.com/shared');
  const register=await call('portal_register_link',{title:'from MCP',url:'https://example.com/created',events:[{event:'SPADIE',event_scope_id:'spadie-tokyo'},{event:'JOPT GAMES'}]});await run(register.request_id);
  const result=await call('portal_result',{request_id:register.request_id});assert.equal(result.state,'done');assert.equal(result.result.actor.email,f.users[2].email);
  const created=f.catalog.list(f.users[2],new URLSearchParams({event:'JOPT GAMES'}));assert.equal(created.total,1);assert.equal(created.items[0].events.length,2);
  assert.equal(f.store.one<{registered_by:string}>('SELECT registered_by FROM resources WHERE title=?','from MCP')?.registered_by,f.users[2].id);
 }finally{await client.close();if(server)await new Promise<void>((resolve,reject)=>server!.close(e=>e?reject(e):resolve()));f.store.close();}
});
