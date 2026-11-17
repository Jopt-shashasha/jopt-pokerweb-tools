// Interactive browser QA: use a disposable local DB and the real stdio protocol.
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Store } from '../src/db.js';
import { createApp } from '../src/app.js';
import { LocalBlobs } from '../src/storage.js';
import { importDrop } from '../src/importer.js';
import type { Config } from '../src/model.js';

await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local','mcp-browser-qa-'));
const store=new Store(resolve(dir,'portal.sqlite')),blobs=new LocalBlobs(resolve(dir,'blobs'));
const config:Config={origin:'http://localhost:8790',localDev:true,dataDir:dir,adminEmail:'xiao.h@japanopenpoker.com',allowedDomains:['japanopenpoker.com'],newsFeeds:[]};
await importDrop(store,blobs,process.argv[2]??'D:/JOPT work/業務ポータル/既存資料バックアップ/2026-11-16',resolve(dir,'reports'));
const before=store.one<{n:number}>('SELECT COUNT(*) n FROM resources')!.n;
const {app}=createApp(config,store,blobs);let server:ReturnType<typeof serve>|undefined;
const client=new Client({name:'portal-browser-verifier',version:'1.0.0'});
try{
 await new Promise<void>(ready=>{server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:8790},()=>ready());});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['--import',pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,resolve('src/mcp.ts')],env:{...process.env as Record<string,string>,PORTAL_ORIGIN:config.origin},stderr:'inherit'}));
 console.log(JSON.stringify({phase:'connected',tools:(await client.listTools()).tools.map(t=>t.name),source_resources:before,test_data_dir:dir}));
 async function call(name:string,args:Record<string,unknown>={}){
  const r=await client.callTool({name,arguments:args});if(r.isError)throw Error(JSON.stringify(r.content));return JSON.parse((r.content as {text:string}[])[0].text);
 }
 async function operation(name:string,args:Record<string,unknown>){
  const r=await call(name,args);console.log(JSON.stringify({phase:name,...r}));
  const until=Date.now()+8*60*1000;
  while(Date.now()<until){
   const done=await call('portal_result',{request_id:r.request_id});
   if(done.state==='done'){console.log(JSON.stringify({phase:name+'_complete',request_id:r.request_id,title:done.result.title??null,total:done.result.total??null}));return done.result;}
   if(done.state!=='pending')throw Error(JSON.stringify(done));
   await new Promise(r=>setTimeout(r,1000));
  }throw Error('Browser verification timed out');
 }
 const found=await operation('portal_search',{q:'業務ポータル'});assert.ok(found.items.length>0);
 const detail=await operation('portal_read',{id:found.items[0].id});assert.ok(detail.url||detail.open_url);
 const other=store.one<{id:string}>('SELECT id FROM users WHERE email<>? ORDER BY email LIMIT 1',config.adminEmail)!;
 const registered=await operation('portal_register_link',{title:'MCP接続検証（テスト用・非公開）',url:'https://example.com/portal-mcp-smoke',description:'ブラウザのログイン状態を使う接続検証。テストDBにのみ保存します。',creator_id:other.id});
 const actual=store.one<{creator_id:string;registered_by:string;visibility:string;status:string}>('SELECT creator_id,registered_by,visibility,status FROM resources WHERE id=?',registered.id)!;
 assert.equal(actual.creator_id,other.id);assert.equal(actual.status,'draft');assert.equal(actual.visibility,'private');
 assert.equal(store.one<{email:string}>('SELECT email FROM users WHERE id=?',actual.registered_by)?.email,config.adminEmail);
 assert.equal(store.one<{n:number}>('SELECT COUNT(*) n FROM resources')!.n,before+1);
 const report={passed:true,source_resources:before,test_resources:before+1,search_title:found.items[0].title,registered_title:registered.title,actor:registered.actor,creator_id:actual.creator_id,registered_by:actual.registered_by,test_data_dir:dir};
 await writeFile(resolve(dir,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({phase:'passed',...report}));
}finally{
 await client.close();if(server)await new Promise<void>((done,fail)=>server!.close(e=>e?fail(e):done()));store.close();
}
