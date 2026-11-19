import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,rm,writeFile,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from '../src/db.js';
import { Catalog } from '../src/repository.js';
import { Auth } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { LocalBlobs,digest } from '../src/storage.js';
import { importDrop } from '../src/importer.js';
import { now,type User,type Config } from '../src/model.js';
import { compactContext,CONTEXT_MAX_BYTES } from '../src/context.js';

test('agent context excludes raw manifests and history and stays within an explicit byte budget',()=>{
 const record={id:randomUUID(),title:'資料'.repeat(500),description:'詳細'.repeat(5000),source_metadata:{file_manifest:Array(1000).fill('private-file')},creator_email:'private@example.com'};
 const result=compactContext({items:Array(20).fill(record),total:20},{items:Array(20).fill({title:'ニュース'.repeat(300),url:'https://example.com/'+ 'x'.repeat(800),source:'source',published_at:null}),stale:false,error:null});
 const body=JSON.stringify(result);assert.ok(Buffer.byteLength(body)<=CONTEXT_MAX_BYTES);assert.equal(result.resources.length,3);assert.equal(result.news.length,2);assert.ok(!body.includes('source_metadata'));assert.ok(!body.includes('creator_email'));assert.ok(!body.includes('private-file'));
});

const config:Config={origin:'https://portal.test',localDev:false,dataDir:'unused',adminEmail:'admin@japanopenpoker.com',allowedDomains:['japanopenpoker.com','huntersite.jp'],newsFeeds:[]};
function fixture(){
 const store=new Store(':memory:');
 const add=(email:string,role:'admin'|'user'):User=>{const id=randomUUID();store.run('INSERT INTO users(id,email,name,role,created_at) VALUES (?,?,?,?,?)',id,email,email,role,now());return store.one<User>('SELECT * FROM users WHERE id=?',id)!;};
 return {store,catalog:new Catalog(store),admin:add('admin@japanopenpoker.com','admin'),a:add('a@japanopenpoker.com','user'),b:add('b@japanopenpoker.com','user')};
}
const input=(title:string,extra:Record<string,unknown>={})=>({title,url:'https://example.com/resource',...extra});
test('registered source URL remains the entry when a retained HTML preview exists',async ()=>{
 const {store,catalog,a}=fixture();try{
  const external=(await catalog.create(a,input('Drive archive',{url:'https://drive.google.com/file/d/source/view'})));
  const legacy=(await catalog.create(a,input('Unmigrated local draft',{status:'draft'})));
  store.run('UPDATE resources SET html_blob=? WHERE id=?','retained-preview',external.id);
  store.run('UPDATE resources SET url=NULL,html_blob=? WHERE id=?','local-preview',legacy.id);
  const withLink=catalog.view((await catalog.get(external.id,a)),a);
  assert.equal(withLink.open_url,'https://drive.google.com/file/d/source/view');
  assert.equal(withLink.has_html,true);
  assert.equal(catalog.view((await catalog.get(legacy.id,a)),a).open_url,'/preview/'+legacy.id);
 }finally{store.close();}
});
test('authorization applies to detail, search, counts, saved and recommendations',async ()=>{
 const {store,catalog,admin,a,b}=fixture();try{
  const pub=(await catalog.create(a,input('shared')));
  const privateDoc=(await catalog.create(a,input('private-secret',{visibility:'private'})));
  const draft=(await catalog.create(a,input('draft-secret',{status:'draft'})));
  assert.equal((await catalog.list(b,new URLSearchParams())).total,1);
  assert.equal((await catalog.list(b,new URLSearchParams({q:'secret'}))).total,0);
  await assert.rejects(()=>catalog.get(privateDoc.id,b),/資料が見つかりません/);
  await assert.rejects(()=>catalog.save(draft.id,b,true),/資料が見つかりません/);
  assert.equal((await catalog.list(admin,new URLSearchParams())).total,3);
  for(let i=0;i<10;i++)assert.deepEqual((await catalog.pickup(admin)).map(r=>r.id),[pub.id]);
  (await catalog.save(pub.id,b,true));(await catalog.save(pub.id,b,true));
  assert.equal((await catalog.list(b,new URLSearchParams({collection:'saved'}))).total,1);
  (await catalog.save(pub.id,b,false));assert.equal((await catalog.list(b,new URLSearchParams({collection:'saved'}))).total,0);
 }finally{store.close();}
});
test('only administrator can assign creator; actor and original source identity remain distinct',async ()=>{
 const {store,catalog,admin,a,b}=fixture();try{
  await assert.rejects(()=>catalog.create(a,input('bad',{creator_id:b.id})),/管理者/);
  const delegated=(await catalog.create(admin,input('delegated',{creator_id:a.id})));
  assert.equal(delegated.creator_id,a.id);assert.equal(delegated.registered_by,admin.id);
  await assert.rejects(()=>catalog.update(delegated.id,a,input('bad',{creator_id:b.id,version:delegated.version})),/管理者/);
  await assert.rejects(()=>catalog.update(delegated.id,b,input('bad',{version:delegated.version})),/編集/);
  await assert.rejects(()=>catalog.update(delegated.id,admin,input('bad',{version:99})),/更新/);
  const changed=(await catalog.update(delegated.id,admin,input('changed',{creator_id:b.id,version:delegated.version})));
  assert.equal(changed.creator_id,b.id);assert.equal(changed.registered_by,admin.id);
  assert.equal(store.one<{actor_id:string}>('SELECT actor_id FROM audit WHERE action=?','update')?.actor_id,admin.id);
  await assert.rejects(()=>catalog.create(admin,input('role injection',{role:'admin'})),/role/);
 }finally{store.close();}
});
test('verified Google Workspace identities claim imported records without accepting changed subjects',async ()=>{
 const {store,a}=fixture();try{
  const auth=new Auth(store,config);
  const claims={email:a.email,email_verified:true,hd:'japanopenpoker.com',sub:'stable-google-sub'};
  assert.equal((await auth.verifiedUser(claims)).id,a.id);
  await assert.rejects(()=>auth.verifiedUser({...claims,sub:'different-sub'}),/確認/);
  await assert.rejects(()=>auth.verifiedUser({...claims,email_verified:false}),/会社/);
  await assert.rejects(()=>auth.verifiedUser({...claims,hd:'example.com'}),/会社/);
  await assert.rejects(()=>auth.verifiedUser({...claims,email:'outside@gmail.com',hd:'gmail.com'}),/会社/);
 }finally{store.close();}
});
test('HTTP routes reject anonymous reads, CSRF, host spoofing and unauthorized preview bytes',async()=>{
 await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local','test-'));
 const {store,catalog,admin,a,b}=fixture();try{
  const blobs=new LocalBlobs(dir);const {app}=createApp(config,store,blobs);
  const request=(path:string,init?:RequestInit)=>app.request(config.origin+path,init);
  assert.equal((await request('/api/resources')).status,401);
  assert.equal((await app.request('https://evil.test/api/me')).status,421);
  const token='test-session',csrf='test-csrf',t=Math.floor(Date.now()/1000);store.run('INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at,renewed_at) VALUES (?,?,?,?,?,?)',digest(token),b.id,csrf,t+1000,t,t);
  const cookie='__Host-portal-session='+token;
  assert.equal((await request('/api/resources',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(input('no csrf'))})).status,403);
  assert.equal((await request('/api/resources',{method:'POST',headers:{cookie,origin:'https://evil.test','x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify(input('bad origin'))})).status,403);
  const privateDoc=(await catalog.create(a,input('private',{visibility:'private'})));
  assert.equal((await request('/api/resources/'+privateDoc.id+'/preview-image',{headers:{cookie}})).status,404);
  const adminToken='admin-session';store.run('INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at,renewed_at) VALUES (?,?,?,?,?,?)',digest(adminToken),admin.id,csrf,t+1000,t,t);
  const headers={cookie:'__Host-portal-session='+adminToken,origin:config.origin,'x-csrf-token':csrf};
  const fd=new FormData();
  fd.append('file',new File(['<!doctype html><h1>Legacy</h1>'],'sample.html',{type:'text/html'}));
  const countBefore=store.one<{n:number}>('SELECT COUNT(*) n FROM resources')!.n;
  for(const path of ['/api/resources/html','/api/resources/upload']){
   assert.equal((await request(path,{method:'POST',headers,body:fd})).status,404);
  }
  const create=(body:unknown)=>request('/api/resources',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
  for(const invalid of [{title:'Missing URL'},{title:'Local file',url:'file:///C:/sample.html'},{title:'Attachment',url:'https://example.com/doc',markdown:{filename:'README.md',content:'# Legacy'}}]){
   assert.equal((await create(invalid)).status,400);
  }
  assert.equal(store.one<{n:number}>('SELECT COUNT(*) n FROM resources')!.n,countBefore);
  const created=await create({title:'Published HTML',url:'https://example.com/handbook.html',description:'First steps'});
  assert.equal(created.status,201);
  const resource=await created.json() as {id:string;open_url:string;has_html:boolean;version:number};
  assert.equal(resource.open_url,'https://example.com/handbook.html');
  assert.equal(resource.has_html,false);
  const invalidEdit=await request('/api/resources/'+resource.id,{method:'PUT',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({title:'Published HTML',url:null,version:resource.version})});
  assert.equal(invalidEdit.status,400);
  assert.equal((await request('/api/resources/'+resource.id+'/preview-image',{method:'PUT',headers,body:'image'})).status,404);
  const legacy=await blobs.put(new TextEncoder().encode('<h1>Legacy</h1>'));
  store.run('UPDATE resources SET url=NULL,html_blob=? WHERE id=?',legacy,resource.id);
  const html=await request('/api/resources/'+resource.id+'/content',{headers});
  assert.equal(html.status,200);
  assert.match(html.headers.get('content-security-policy')??'',/sandbox allow-scripts/);
  assert.doesNotMatch(html.headers.get('content-security-policy')??'',/allow-same-origin/);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('drop import is idempotent, retains creators/privacy and never guesses document classification',async()=>{
 await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local','import-test-'));const dbFile=resolve(dir,'catalog.sqlite');
 const store=new Store(dbFile);try{
  const backup=resolve(dir,'backup');await mkdir(resolve(backup,'aifact'),{recursive:true});
  await writeFile(resolve(backup,'aifact/departments.json'),JSON.stringify([{id:'dept-original',name:'Original department'}]));await writeFile(resolve(backup,'aifact/creator-profiles.json'),'[]');
  const common={source_system:'drop',creator_email:'a@japanopenpoker.com',creator_source_id:'google-a',source_created_at:1700000000,source_updated_at:1700000000,local_files:[],file_manifest:[]};
  const entries=[{...common,source_id:'1'.repeat(32),title:'shared',source_publication_status:'shared',source_visibility:'public',target_url:'https://example.com/shared'},{...common,source_id:'2'.repeat(32),title:'private',source_publication_status:'shared',source_visibility:'private',target_url:'https://example.com/private'}];
  await writeFile(resolve(backup,'移行用データ.json'),JSON.stringify({schema_version:1,creators:[],entries}));
  const blobs=new LocalBlobs(resolve(dir,'blobs'));
  const first=await importDrop(store,blobs,backup,resolve(dir,'reports'));assert.equal(first.inserted,2);
  const creator=store.one<User>('SELECT * FROM users WHERE email=?','a@japanopenpoker.com')!;assert.equal(creator.google_sub,'google-a');
  assert.equal(store.one<{n:number}>('SELECT COUNT(*) n FROM resources WHERE department_id IS NULL AND kind IS NULL')?.n,2);
  store.run('UPDATE resources SET department_id=? WHERE source_id=?','dept-original','1'.repeat(32));
  const second=await importDrop(store,blobs,backup,resolve(dir,'reports'));assert.equal(second.inserted,0);assert.equal(second.skipped,2);
  assert.equal(store.one<{department_id:string}>('SELECT department_id FROM resources WHERE source_id=?','1'.repeat(32))?.department_id,'dept-original');
  store.close();const reopened=new Store(dbFile);assert.equal(reopened.one<{n:number}>('SELECT COUNT(*) n FROM resources')?.n,2);reopened.close();
  assert.ok((await readFile(resolve(dir,'reports/classification-review.json'),'utf8')).includes('unclassified'));
 }finally{try{store.close();}catch{}await rm(dir,{recursive:true,force:true});}
});
