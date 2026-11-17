import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/db.js';
import { Catalog } from '../src/repository.js';
import { now,type User } from '../src/model.js';
import { applyEventReview } from '../scripts/apply-event-review.js';

test('reviewed migration validates all rows before changing anything and preserves source content, dates, ownership and permissions',()=>{
 const store=new Store(':memory:'),catalog=new Catalog(store),id=randomUUID();
 try{
  store.run('INSERT INTO users(id,email,name,role,created_at) VALUES (?,?,?,?,?)',id,'review@japanopenpoker.com','review','admin',now());const user=store.one<User>('SELECT * FROM users WHERE id=?',id)!;
  const a=catalog.create(user,{title:'review A',url:'https://example.com/a',event:'共通',visibility:'private'}),b=catalog.create(user,{title:'review B',url:'https://example.com/b',event:'共通'});
  store.run("UPDATE resources SET source_system='drop'");
  const plan=[a,b].map(r=>({id:r.id,title:r.title,source_system:'drop',expected_version:r.version,before:[{event:'共通',event_scope_id:null}],events:[{event:'SPADIE',event_scope_id:'spadie-tokyo'},{event:'JOPT GAMES',event_scope_id:null}],reason:'AI reviewed artifact context'}));
  const review={reviewed_on:'2026-11-17',plan},before=store.all('SELECT * FROM resources ORDER BY id');
  assert.equal(applyEventReview(store,review).changed,2);assert.deepEqual(store.all('SELECT * FROM resources ORDER BY id'),before);
  assert.throws(()=>applyEventReview(store,{...review,plan:[plan[0],{...plan[1],expected_version:99}]},true),/changed/);assert.deepEqual(store.all('SELECT * FROM resources ORDER BY id'),before);
  assert.throws(()=>applyEventReview(store,{...review,plan:[{...plan[0],events:[{event:'JOPT GAMES',event_scope_id:'spadie-tokyo'}]}]},true),/組み合わせ/);
  assert.equal(applyEventReview(store,review,true).changed,2);
  const after=store.all<Record<string,unknown>>('SELECT * FROM resources ORDER BY id');
  for(let i=0;i<before.length;i++){const {event,event_scope_id,version,...rest}=before[i] as Record<string,unknown>;const {event:e,event_scope_id:s,version:v,...unchanged}=after[i];assert.deepEqual(unchanged,rest);assert.equal(v,Number(version)+1);}
  assert.equal(catalog.list(user,new URLSearchParams({event:'JOPT GAMES'})).total,2);assert.equal(catalog.list(user,new URLSearchParams({event:'SPADIE',event_scope:'spadie-tokyo'})).total,2);
  assert.throws(()=>applyEventReview(store,review,true),/changed/);
 }finally{store.close();}
});
