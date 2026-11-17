import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,writeFile,rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from '../src/db.js';
import { Catalog } from '../src/repository.js';
import { digest,type BlobStore } from '../src/storage.js';
import { importAifact } from '../src/aifact-importer.js';
import { now,type User } from '../src/model.js';

async function fixture(){
 const parent=resolve('.local');await mkdir(parent,{recursive:true});const dir=await mkdtemp(resolve(parent,'aifact-test-'));
 const store=new Store(':memory:'),catalog=new Catalog(store),bytes=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK3sAAAAASUVORK5CYII=','base64'));
 const owner=randomUUID(),other=randomUUID(),sourceCreator=randomUUID(),dept=randomUUID();
 for(const [id,email] of [[owner,'owner@japanopenpoker.com'],[other,'other@japanopenpoker.com']])store.run('INSERT INTO users(id,email,name,google_sub,created_at) VALUES (?,?,?,?,?)',id,email,email,id===owner?'stable-google-sub':null,now());
 const blobsData=new Map<string,Uint8Array<ArrayBuffer>>(),blobs:BlobStore={put:async data=>{const id=randomUUID();blobsData.set(id,new Uint8Array(data));return id;},get:async id=>blobsData.get(id)!,remove:async id=>{blobsData.delete(id);}};
 await mkdir(resolve(dir,'aifact/images'),{recursive:true});await writeFile(resolve(dir,'aifact/images/sample.png'),bytes);
 await writeFile(resolve(dir,'aifact/departments.json'),JSON.stringify([{id:dept,name:'原部署'}]));
 await writeFile(resolve(dir,'aifact/creator-profiles.json'),JSON.stringify([{id:sourceCreator,email:'owner@japanopenpoker.com',full_name:'原作成者',department_id:dept}]));
 const entry={source_system:'aifact',source_id:randomUUID(),title:'同名資料',creator_email:'owner@japanopenpoker.com',creator_source_id:sourceCreator,creator_name:'原作成者',department:{id:dept,name:'原部署'},categories:['原カテゴリ','別カテゴリ'],description:'原文の用途説明',target_url:'https://example.com/original',source_publication_status:'公開中',source_visibility:null,source_created_at:'2026/11/13',source_updated_at:'2026/11/14',local_preview_image:'aifact/images/sample.png',preview_image_sha256:digest(bytes)};
 const write=async(entries:unknown[])=>writeFile(resolve(dir,'移行用データ.json'),JSON.stringify({schema_version:1,entries}));
 return {store,catalog,dir,owner,other,entry,blobs,blobsData,write,cleanup:async()=>{store.close();assert.equal(resolve(dir,'..'),parent);await rm(dir,{recursive:true,force:true});}};
}

test('AIFACT import preserves original categories, creator identity, preview bytes and date precision without guessing missing fields',async()=>{
 const f=await fixture();try{
  await f.write([f.entry,{...f.entry,source_id:randomUUID(),department:{id:null,name:'部署未設定'},categories:[]}]);
  const report=await importAifact(f.store,f.blobs,f.dir,resolve(f.dir,'reports'));assert.equal(report.inserted,2);assert.equal(report.missing_department,1);assert.equal(report.missing_categories,1);
  const rows=f.store.all<{id:string;creator_id:string;kind:null;tags:string;created_at:string;updated_at:string;preview_blob:string}>('SELECT * FROM resources');assert.equal(rows.length,2);
  assert.equal(rows[0].creator_id,f.owner);assert.equal(rows[0].kind,null);assert.equal(rows[0].tags,'[]');assert.equal(rows[0].created_at,'2026-11-13');assert.equal(rows[0].updated_at,'2026-11-14');
  assert.equal(f.store.one<{google_sub:string}>('SELECT google_sub FROM users WHERE id=?',f.owner)?.google_sub,'stable-google-sub');
  assert.equal(f.store.one<{user_id:string}>("SELECT user_id FROM source_identities WHERE source_system='aifact'")?.user_id,f.owner);
  assert.equal(digest(await f.blobs.get(rows[0].preview_blob)),f.entry.preview_image_sha256);
  const user=f.store.one<User>('SELECT * FROM users WHERE id=?',f.owner)!;
  assert.deepEqual(f.catalog.view(f.catalog.get(rows[0].id,user),user).categories.sort(),['別カテゴリ','原カテゴリ'].sort());
  assert.equal(f.catalog.list(user,new URLSearchParams({category:'原カテゴリ'})).total,1);
  assert.equal(f.catalog.list(user,new URLSearchParams({q:'別カテゴリ'})).total,1);
  f.store.run('UPDATE resources SET title=? WHERE id=?','編集後のタイトル',rows[0].id);
  const again=await importAifact(f.store,f.blobs,f.dir,resolve(f.dir,'reports'));assert.equal(again.inserted,0);assert.equal(again.skipped,2);assert.equal(f.blobsData.size,2);
  assert.equal(f.store.one<{title:string}>('SELECT title FROM resources WHERE id=?',rows[0].id)?.title,'編集後のタイトル');
 }finally{await f.cleanup();}
});

test('AIFACT category counts/search do not expose private records to another account',async()=>{
 const f=await fixture();try{
  await f.write([f.entry]);await importAifact(f.store,f.blobs,f.dir,resolve(f.dir,'reports'));
  f.store.run("UPDATE resources SET visibility='private'");const user=f.store.one<User>('SELECT * FROM users WHERE id=?',f.other)!;
  assert.equal(f.catalog.list(user,new URLSearchParams({category:'原カテゴリ'})).total,0);
  assert.equal(f.catalog.list(user,new URLSearchParams({q:'原カテゴリ'})).total,0);
  assert.deepEqual(f.catalog.masters(user).categories,[]);
 }finally{await f.cleanup();}
});

test('AIFACT import aborts on corrupt images and unsafe backup paths without leaving partial resources or staged blobs',async()=>{
 const f=await fixture();try{
  await f.write([f.entry,{...f.entry,source_id:randomUUID(),preview_image_sha256:'wrong'}]);
  await assert.rejects(importAifact(f.store,f.blobs,f.dir,resolve(f.dir,'reports')),/checksum/);
  assert.equal(f.store.one<{n:number}>('SELECT COUNT(*) n FROM resources')?.n,0);assert.equal(f.blobsData.size,0);
  await f.write([{...f.entry,local_preview_image:'../outside.png'}]);
  await assert.rejects(importAifact(f.store,f.blobs,f.dir,resolve(f.dir,'reports')),/escapes/);
  assert.equal(f.blobsData.size,0);
 }finally{await f.cleanup();}
});
