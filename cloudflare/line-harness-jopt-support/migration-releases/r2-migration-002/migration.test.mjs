import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { harnessMigrateOne, harnessMigrateBatch, harnessMigrationAllowed, harnessMigrationBytes, harnessMigrationKey } from './migration-core.mjs';
import { HarnessR2TestStorage } from '../r2-test-001/storage-adapter.mjs';
import { harnessR2RouterMethods } from './router-methods.mjs';
import { harnessR2OperationTotals, harnessR2LatestStorage } from './r2-capacity.mjs';
Object.assign(HarnessR2TestStorage.prototype, harnessR2RouterMethods);

const key = 'line-private/account/message/photo.jpg';
const faqKey = 'faq-private/case/photo.png';
const original = new Uint8Array([255,216,255,7,8,9]);
function objectStore() {
  const objects = new Map();
  const store = {
    objects, calls: [], fail: new Set(),
    async put(key, value, options) {
      this.calls.push(['put', key]);
      if (this.fail.has('put')) throw Error('provider failure');
      objects.set(key, { bytes:typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value), type:options?.httpMetadata?.contentType || 'image/jpeg' });
      await this.afterPut?.(key);
    },
    async get(key) {
      this.calls.push(['get', key]);
      if (this.fail.has('get')) throw Error('provider failure');
      const value = objects.get(key);
      if (!value) return null;
      return { httpMetadata:{contentType:value.type}, body:new ReadableStream({start(controller){controller.enqueue(value.bytes.slice());controller.close();}}) };
    },
    async delete(key) { this.calls.push(['delete',key]);if(this.fail.has('delete'))throw Error('provider failure');objects.delete(key); },
    async list() { return { objects:[...objects.keys()].map(key=>({key})),truncated:false }; }
  };
  return store;
}
function setup(t) {
  const sql = new DatabaseSync(':memory:'); t.after(()=>sql.close());
  sql.exec(`CREATE TABLE line_incoming_images(account_id TEXT,message_id TEXT,line_user_id TEXT,storage_key TEXT,state TEXT,PRIMARY KEY(account_id,message_id));
    CREATE TABLE faq_case_uploads(case_id TEXT PRIMARY KEY,storage_key TEXT,state TEXT);
    CREATE TABLE line_legacy_image_unsends(storage_key TEXT PRIMARY KEY);
    CREATE TABLE friends(id TEXT PRIMARY KEY,line_account_id TEXT,line_user_id TEXT);
    CREATE TABLE faq_cases(id TEXT PRIMARY KEY,account_id TEXT,friend_id TEXT);`);
  sql.prepare('INSERT INTO line_incoming_images VALUES(?,?,?,?,?)').run('account','message','user',key,'stored');
  sql.prepare('INSERT INTO faq_case_uploads VALUES(?,?,?)').run('case',faqKey,'stored');
  sql.exec("INSERT INTO friends VALUES('friend','account','user');INSERT INTO faq_cases VALUES('case','account','friend');");
  const db = {prepare(query){return {bind(...args){return {first:async()=>sql.prepare(query).get(...args)}}}}};
  const source=objectStore(),destination=objectStore();
  const env={DB:db,IMAGES_R2:destination,R2_MIGRATION_ENABLED:'1',R2_MIGRATION_READS:'enabled',R2_TEST_ACCOUNT_ID:'account',R2_TEST_LINE_USER_ID:'user',R2_WRITE_MODE:'test'};
  return {sql,db,source,destination,env,router:new HarnessR2TestStorage(env,source)};
}
test('copies the original key, verifies bytes and keeps Appwrite untouched; repeat is idempotent',async t=>{
  const {db,source,destination}=setup(t);await source.put(key,original);
  const first=await harnessMigrateOne(db,source,destination,key),second=await harnessMigrateOne(db,source,destination,key);
  assert.equal(first.status,'copied_verified');assert.equal(second.status,'verified_existing');assert.equal(first.sha256,second.sha256);
  assert.deepEqual(source.objects.get(key).bytes,original);assert.deepEqual(destination.objects.get(key).bytes,original);
  assert.equal(destination.calls.filter(c=>c[0]==='put').length,1);assert.equal(source.calls.filter(c=>c[0]==='delete').length,0);
});
test('withdrawn direct images, withdrawn FAQ images, legacy tombstones and unlinked private keys are excluded',async t=>{
  const {sql,db,source,destination}=setup(t);
  sql.exec("UPDATE line_incoming_images SET state='deleted';UPDATE faq_case_uploads SET state='deleted';INSERT INTO line_legacy_image_unsends VALUES('incoming-deleted.jpg');");
  for(const k of [key,faqKey,'incoming-deleted.jpg','line-private/missing/missing/x.jpg','line-private/bad.jpg','faq-private/bad.jpg']){
    assert.equal(await harnessMigrationAllowed(db,k),false);assert.match((await harnessMigrateOne(db,source,destination,k)).status,/skipped/);
  }
  assert.equal(source.calls.length,0);assert.equal(destination.calls.length,0);
});
test('withdrawal during upload removes the new R2 copy rather than resurrecting the image',async t=>{
  const {sql,db,source,destination}=setup(t);await source.put(key,original);
  destination.afterPut=async()=>sql.exec("UPDATE line_incoming_images SET state='deleted'");
  const result=await harnessMigrateOne(db,source,destination,key);
  assert.equal(result.status,'withdrawn_during_copy');assert.equal(destination.objects.has(key),false);assert.equal(source.objects.has(key),true);
});
test('does not overwrite a conflicting R2 object',async t=>{
  const {db,source,destination}=setup(t);await source.put(key,original);await destination.put(key,new Uint8Array([4,5]));
  assert.equal((await harnessMigrateOne(db,source,destination,key)).status,'conflict_not_overwritten');
  assert.deepEqual(destination.objects.get(key).bytes,new Uint8Array([4,5]));
});
test('a corrupted new copy is removed after verification fails; the original survives',async t=>{
  const {db,source,destination}=setup(t);await source.put(key,original);
  destination.afterPut=async k=>destination.objects.set(k,{bytes:new Uint8Array([0]),type:'image/jpeg'});
  await assert.rejects(harnessMigrateOne(db,source,destination,key),/verification_failed/);
  assert.equal(destination.objects.has(key),false);assert.deepEqual(source.objects.get(key).bytes,original);
});
test('skips non-images and reports source disappearance',async t=>{
  const {db,source,destination}=setup(t);await source.put('movie.mp4',original,{httpMetadata:{contentType:'video/mp4'}});
  assert.equal((await harnessMigrateOne(db,source,destination,'movie.mp4')).status,'skipped_non_image');
  assert.equal((await harnessMigrateOne(db,source,destination,'missing.jpg')).status,'source_missing');assert.equal(destination.calls.length,0);
});
test('bounded reader cancels an oversized image',async()=>{
  let cancelled=false;
  const stream=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(11*1024*1024));},cancel(){cancelled=true;}});
  await assert.rejects(harnessMigrationBytes({body:stream}),/image_too_large/);assert.equal(cancelled,true);
});
test('batches reject invalid keys and missing safety switches; successful results are privately audited',async t=>{
  const {env,source,destination}=setup(t);await source.put(key,original);
  await assert.rejects(harnessMigrateBatch({...env,R2_MIGRATION_READS:'disabled'},source,[key]),/migration_disabled/);
  await assert.rejects(harnessMigrateBatch(env,source,['../secret']),/invalid_batch/);
  await assert.rejects(harnessMigrateBatch(env,source,[key,key,key,key]),/invalid_batch/);
  const result=await harnessMigrateBatch(env,source,[key]);assert.equal(result.results[0].status,'copied_verified');
  assert.ok([...destination.objects.keys()].some(k=>k.startsWith('_migration/r2-migration-002/')));
});
test('invalid or administrative keys cannot be migrated as customer images',()=>{
  for(const k of ['../x','/absolute','a/../b','a\\b','x\u0000y','_migration/private.json',''])assert.equal(harnessMigrationKey(k),false);
});
test('a disabled write switch still reads migrated images and cleans up both providers',async t=>{
  const {env,source,destination,router}=setup(t);env.R2_WRITE_MODE='off';
  await destination.put(key,original);assert.ok(await router.get(key));await router.put('new.jpg',original,{httpMetadata:{contentType:'image/jpeg'}});
  assert.equal(source.objects.has('new.jpg'),true);assert.equal(destination.objects.has('new.jpg'),false);
  await router.delete(key);assert.equal(destination.objects.has(key),false);
});
test('all mode accepts new images even when Appwrite is unavailable, while non-images retain the old route',async t=>{
  const {env,source,destination,router}=setup(t);env.R2_WRITE_MODE='all';source.fail.add('put');
  await router.put('new.jpg',original,{httpMetadata:{contentType:'image/jpeg'}});assert.equal(destination.objects.has('new.jpg'),true);
  await assert.rejects(router.put('movie.mp4',original,{httpMetadata:{contentType:'video/mp4'}}));
});
test('all-mirror mode requires both providers and reports a partial delete failure for retry',async t=>{
  const {env,source,destination,router}=setup(t);env.R2_WRITE_MODE='all-mirror';
  await router.put('new.jpg',original,{httpMetadata:{contentType:'image/jpeg'}});assert.equal(source.objects.has('new.jpg'),true);assert.equal(destination.objects.has('new.jpg'),true);
  source.fail.add('delete');await assert.rejects(router.delete('new.jpg'),/cleanup incomplete/);assert.equal(destination.objects.has('new.jpg'),false);
});
test('R2 fallback preserves original provider reads',async t=>{
  const {source,destination,router}=setup(t);await source.put(key,original);destination.fail.add('get');assert.ok(await router.get(key));
});
test('official operation types are classified; delete is free and unknown types cannot falsely show zero',()=>{
  const row=(type,n,storageClass='Standard')=>({dimensions:{actionType:type,storageClass},sum:{requests:n}});
  assert.deepEqual(harnessR2OperationTotals([row('PutObject',2),row('ListObjectsV2',3),row('GetObject',7),row('HeadObject',1),row('DeleteObject',9)]),{classA:5,classB:8,unknown:0,infrequent:0});
  assert.equal(harnessR2OperationTotals([row('unknown-new-operation',2)]).classA,null);
  assert.equal(harnessR2OperationTotals([row('GetObject',3,'InfrequentAccess')]).infrequent,3);
  assert.throws(()=>harnessR2OperationTotals([row('GetObject',NaN)]));
});
test('latest storage gauges are selected per bucket, not added repeatedly or replaced by an old peak',()=>{
  const row=(bucket,datetime,n)=>({dimensions:{bucketName:bucket,datetime},max:{payloadSize:n}});
  assert.equal(harnessR2LatestStorage([row('a','2026-11-17T01:00:00Z',900),row('a','2026-11-17T02:00:00Z',0),row('b','2026-11-17T02:00:00Z',30)]),30);
  assert.equal(harnessR2LatestStorage([]),null);assert.throws(()=>harnessR2LatestStorage([row('a','bad',1)]));
});
