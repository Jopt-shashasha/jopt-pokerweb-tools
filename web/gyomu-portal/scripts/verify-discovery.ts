// Browser QA with an isolated database and the real MCP stdio client.
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Store } from '../src/db.js';
import { LocalBlobs } from '../src/storage.js';
import { createApp } from '../src/app.js';
import type { Config } from '../src/model.js';

await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local','discovery-browser-qa-'));
const store=new Store(resolve(dir,'portal.sqlite')),blobs=new LocalBlobs(resolve(dir,'blobs'));
const config:Config={origin:'http://localhost:8790',localDev:true,dataDir:dir,adminEmail:'xiao.h@japanopenpoker.com',allowedDomains:['japanopenpoker.com'],newsFeeds:[]};
const url='https://example.com/survey',purpose='来場者アンケートを大会ごとに集計する。検証用キーワード：集計検証OMEGA';
const {app}=createApp(config,store,blobs),client=new Client({name:'discovery-browser-verifier',version:'1.0.0'});
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:8790});
let closing=false;
async function close(){if(closing)return;closing=true;await client.close();server.close(()=>{store.close();process.exit(0);});}
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>void close());
try{
 await client.connect(new StdioClientTransport({command:process.execPath,args:['--import',pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,resolve('src/mcp.ts')],env:{...process.env as Record<string,string>,PORTAL_ORIGIN:config.origin},stderr:'inherit'}));
 async function call(name:string,args:Record<string,unknown>){const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r.content));return JSON.parse((r.content as {text:string}[])[0].text);}
 async function operation(name:string,args:Record<string,unknown>){
  const pending=await call(name,args);console.log(JSON.stringify({phase:name,browser_url:pending.browser_url}));
  const deadline=Date.now()+9*60000;
  while(Date.now()<deadline){const result=await call('portal_result',{request_id:pending.request_id});if(result.state==='done')return result.result;if(result.state!=='pending')throw Error(JSON.stringify(result));await new Promise(r=>setTimeout(r,1000));}
  throw Error('Browser verification timed out');
 }
 const registered=await operation('portal_register_link',{title:'アンケート集計（検証用）',url,description:purpose,event:'JOPT',event_scope_id:'jopt-tokyo',tags:['Ticket',' ticket ']});
 assert.equal(registered.url,url);
 const found=await operation('portal_search',{q:'集計検証OMEGA'});assert.equal(found.total,1);assert.equal(found.items[0].id,registered.id);
 const metadata=await operation('portal_read',{id:registered.id});assert.equal(metadata.url,url);assert.equal(metadata.description,purpose);assert.equal(metadata.markdown,null);
 const report={passed:true,resource_url:config.origin+'/#/resource/'+registered.id,checks:['browser-session-registration','event-scope','http-url-only','purpose-search','original-url-readback'],data_dir:dir};
 await writeFile(resolve(dir,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 // Keep the QA detail page available until Ctrl+C.
}catch(e){console.error(e);await close();process.exitCode=1;}
