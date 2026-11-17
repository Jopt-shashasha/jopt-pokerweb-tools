import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {Store} from '../src/db.js';
import {Catalog} from '../src/repository.js';
import {Previews} from '../src/previews.js';
import {LocalPreviewRenderer} from '../src/preview-renderer.js';
import {digest,type BlobStore} from '../src/storage.js';
import {imageType} from '../src/validation.js';
import {saveMarkdown,stageMarkdown} from '../src/markdown.js';
import {now,type User} from '../src/model.js';
import {createApp} from '../src/app.js';

function fixture(){const store=new Store(':memory:'),data=new Map<string,Uint8Array<ArrayBuffer>>(),catalog=new Catalog(store);const id=randomUUID();store.run('INSERT INTO users(id,email,name,role,created_at) VALUES (?,?,?,?,?)',id,'a@japanopenpoker.com','a','user',now());const user=store.one<User>('SELECT * FROM users WHERE id=?',id)!;const blobs:BlobStore={put:async b=>{const id=randomUUID();data.set(id,new Uint8Array(b));return id;},get:async id=>data.get(id)!,remove:async id=>{data.delete(id);}};return {store,catalog,user,blobs};}
test('file previews coalesce requests, cache by content and regenerate after Markdown replacement',async()=>{
 const f=fixture();try{const r=f.catalog.create(f.user,{title:'Readme',url:'https://example.com/'});const md=await stageMarkdown(f.blobs,{filename:'README.md',content:'# Original\n\nFirst body'});saveMarkdown(f.store,r.id,md!,f.user.id);let count=0;
  const service=new Previews(f.store,f.blobs,{render:async html=>{count++;assert.ok(html.includes('body'));return new Uint8Array([255,216,255,count]);}});
  const resource=f.catalog.get(r.id,f.user);await Promise.all([service.get(resource),service.get(resource)]);assert.equal(count,1);await service.get(resource);assert.equal(count,1);
  const replacement=await stageMarkdown(f.blobs,{filename:'README.md',content:'# Replacement\n\nSecond body'});saveMarkdown(f.store,r.id,replacement!,f.user.id);await service.get(resource);assert.equal(count,2);assert.equal(f.catalog.get(r.id,f.user).preview_blob,null);
 }finally{f.store.close();}
});
test('a URL alone is never fetched for preview generation and render failures keep the document usable',async()=>{
 const f=fixture();try{const r=f.catalog.create(f.user,{title:'URL',url:'http://127.0.0.1/private'});let count=0;const service=new Previews(f.store,f.blobs,{render:async()=>{count++;throw Error('unavailable');}});assert.equal(await service.get(f.catalog.get(r.id,f.user)),null);assert.equal(count,0);
  const bytes=new TextEncoder().encode('<h1>Document</h1>'),blob=await f.blobs.put(bytes);f.store.run('INSERT INTO resource_preview_inputs VALUES (?,?,?,?)',r.id,blob,'index.html',digest(bytes));assert.equal(await service.get(f.catalog.get(r.id,f.user)),null);assert.equal(await service.get(f.catalog.get(r.id,f.user)),null);assert.equal(count,1);assert.equal(f.catalog.get(r.id,f.user).title,'URL');
 }finally{f.store.close();}
});
test('real file renderer blocks scripts and outbound requests in a fresh offline browser',async t=>{
 if(process.platform!=='win32'||!existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')){t.skip('Local Chrome not configured');return;}
 let requests=0;const server=createServer((_req,res)=>{requests++;res.end('unexpected');});await new Promise<void>(ready=>server.listen(0,'127.0.0.1',ready));
 try{const address=server.address() as {port:number},renderer=new LocalPreviewRenderer();const plain='<body style="margin:0;background:#fff"><h1>Preview file</h1><p>Saved content</p></body>';
  const first=await renderer.render(plain),second=await renderer.render(plain+`<script>document.body.innerHTML='WRONG';fetch('http://127.0.0.1:${address.port}/script')</script><link rel="stylesheet" href="http://127.0.0.1:${address.port}/style"><img style="display:none" src="http://127.0.0.1:${address.port}/image">`);
  assert.equal(imageType(first),'image/jpeg');assert.ok(first.byteLength>1000);assert.equal(digest(first),digest(second));assert.equal(requests,0);
 }finally{await new Promise<void>(done=>server.close(()=>done()));}
});
test('thumbnail generation follows document permissions and preserves an existing uploaded image',async()=>{
 const f=fixture();try{
  const r=f.catalog.create(f.user,{title:'private',url:'https://example.com/',visibility:'private'}),other=randomUUID(),epoch=Math.floor(Date.now()/1000);
  f.store.run('INSERT INTO users(id,email,name,role,created_at) VALUES (?,?,?,?,?)',other,'other@japanopenpoker.com','other','user',now());
  for(const [token,id] of [['owner-token',f.user.id],['other-token',other]])f.store.run('INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at,renewed_at) VALUES (?,?,?,?,?,?)',digest(token),id,'csrf',epoch+1000,epoch,epoch);
  const html=new TextEncoder().encode('<h1>private document</h1>');f.store.run('INSERT INTO resource_preview_inputs VALUES (?,?,?,?)',r.id,await f.blobs.put(html),'file.html',digest(html));
  let calls=0;const {app}=createApp({origin:'http://127.0.0.1:8788',localDev:true,dataDir:'unused',adminEmail:f.user.email,allowedDomains:['japanopenpoker.com'],newsFeeds:[]},f.store,f.blobs,{render:async()=>{calls++;return new Uint8Array([255,216,255,1]);}});
  const path='http://127.0.0.1:8788/api/resources/'+r.id+'/preview-image';
  assert.equal((await app.request(path,{headers:{cookie:'portal-session=other-token'}})).status,404);assert.equal(calls,0);
  const image=await app.request(path,{headers:{cookie:'portal-session=owner-token'}});assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/jpeg');assert.equal(calls,1);
  const original=new Uint8Array([255,216,255,7]);f.store.run('UPDATE resources SET preview_blob=? WHERE id=?',await f.blobs.put(original),r.id);
  assert.deepEqual(new Uint8Array(await (await app.request(path,{headers:{cookie:'portal-session=owner-token'}})).arrayBuffer()),original);assert.equal(calls,1);
 }finally{f.store.close();}
});
