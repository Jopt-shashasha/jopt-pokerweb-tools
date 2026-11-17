// Real MCP and browser actions against a disposable copy of the current portal.
import assert from 'node:assert/strict';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdir,mkdtemp,cp,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {serve} from '@hono/node-server';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {Store} from '../src/db.js';
import {LocalBlobs} from '../src/storage.js';
import {createApp} from '../src/app.js';
import type {Config} from '../src/model.js';

await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local','e2e-browser-qa-'));
const source=new DatabaseSync(resolve('.local/portal-local.sqlite'),{readOnly:true});await backup(source,resolve(dir,'portal.sqlite'));source.close();
await cp(resolve('.local/blobs'),resolve(dir,'blobs'),{recursive:true});
let store=new Store(resolve(dir,'portal.sqlite'));store.run('DELETE FROM sessions');store.run('DELETE FROM agent_requests');store.run('DELETE FROM oauth_requests');
const blobs=new LocalBlobs(resolve(dir,'blobs'));
const config:Config={origin:'http://localhost:8790',localDev:true,dataDir:dir,adminEmail:'xiao.h@japanopenpoker.com',allowedDomains:['japanopenpoker.com','huntersite.jp'],newsFeeds:[]};
const before=store.one<{n:number}>('SELECT COUNT(*) n FROM resources')!.n;
const original=store.one<{id:string;title:string;url:string;description:string;creator_id:string}>('SELECT id,title,url,description,creator_id FROM resources WHERE id=?','a341d72e-8e40-4304-bae8-9bb5660b050e')!;
assert.ok(original);const content=`# MCP連携検証用の説明書\n\n${original.title}\n\n${original.description}\n\n元URL：${original.url}\n\nこのMDは転送・本文検索の検証用です。元資料の正式マニュアルを追加・更新するものではありません。\n\n検証キーワード：連携確認OMEGA\n`;
const mdPath=resolve(dir,'README.md');await writeFile(mdPath,content);
let server:ReturnType<typeof serve>;
async function start(){const {app}=createApp(config,store,blobs);await new Promise<void>(ready=>{server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:8790},()=>ready());});}
await start();const client=new Client({name:'portal-e2e-verifier',version:'1.0.0'});let closing=false;
async function close(){if(closing)return;closing=true;await client.close();await new Promise<void>((done,fail)=>server.close(e=>e?fail(e):done()));store.close();}
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>void close());
try{
 await client.connect(new StdioClientTransport({command:process.execPath,args:['--import',pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,resolve('src/mcp.ts')],env:{...process.env as Record<string,string>,PORTAL_ORIGIN:config.origin},stderr:'inherit'}));
 async function call(name:string,args:Record<string,unknown>={}){const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r.content));return JSON.parse((r.content as {text:string}[])[0].text);}
 async function operation(name:string,args:Record<string,unknown>){
  const pending=await call(name,args);console.log(JSON.stringify({phase:name,browser_url:pending.browser_url}));const deadline=Date.now()+9*60000;
  while(Date.now()<deadline){const r=await call('portal_result',{request_id:pending.request_id});if(r.state==='done')return r.result;if(r.state!=='pending')throw Error(JSON.stringify(r));await new Promise(done=>setTimeout(done,1500));}throw Error('Browser verification timed out');
 }
 const tools=(await client.listTools()).tools.map(t=>t.name);assert.equal(tools.length,6);
 const vocabulary=await call('portal_registration_options');assert.ok(vocabulary.events.some((e:{name:string})=>e.name==='JOPT GAMES'));
 console.log(JSON.stringify({phase:'connected',tools,source_resources:before,data_dir:dir}));
 const registered=await operation('portal_register_link',{title:'MCP接続検証｜'+original.title,url:original.url,description:'独立テストDBだけに保存する接続確認。'+original.description,creator_id:original.creator_id,events:[{event:'SPADIE',event_scope_id:'spadie-tokyo'},{event:'JOPT GAMES'}],tags:['告知','MCP検証'],markdown_path:mdPath});
 assert.equal(registered.events.length,2);assert.equal(registered.visibility,'private');assert.equal(registered.status,'draft');assert.equal(registered.markdown.filename,'README.md');
 const saved=store.one<{creator_id:string;registered_by:string}>('SELECT creator_id,registered_by FROM resources WHERE id=?',registered.id)!;
 assert.equal(saved.creator_id,original.creator_id);assert.notEqual(saved.creator_id,saved.registered_by);console.log(JSON.stringify({phase:'registration_verified',resource_url:registered.portal_url}));
 await new Promise<void>((done,fail)=>server.close(e=>e?fail(e):done()));store.close();store=new Store(resolve(dir,'portal.sqlite'));await start();console.log(JSON.stringify({phase:'restarted'}));
 const found=await operation('portal_search',{q:'連携確認OMEGA',event:'JOPT GAMES'});assert.equal(found.total,1);assert.equal(found.items[0].id,registered.id);
 const detail=await operation('portal_read',{id:registered.id});assert.equal(detail.events.length,2);assert.equal(detail.url,original.url);assert.ok(!JSON.stringify(detail).includes('連携確認OMEGA'));
 const md=await operation('portal_read',{id:registered.id,include_markdown:true});assert.equal(md.markdown.content,content);
 const count=store.one<{n:number}>('SELECT COUNT(*) n FROM resources')!.n;assert.equal(count,before+1);
 const report={passed:true,source_resources:before,test_resources:count,tools,checks:['actual-stdio-mcp','classification-vocabulary','browser-session-review','multiple-tournament-tags','scope-pairing','local-md-transfer','private-draft-default','creator-and-operator-separated','server-restart','browser-session-survives-restart','markdown-search','metadata-only-default','md-on-demand'],resource_url:registered.portal_url,portal_model_calls:0,data_dir:dir};
 await writeFile(resolve(dir,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({phase:'passed',...report}));
}catch(e){console.error(e);await close();process.exitCode=1;}
