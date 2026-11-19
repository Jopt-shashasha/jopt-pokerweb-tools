import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/db.js';
import {Catalog} from '../src/repository.js';
import {now,type User} from '../src/model.js';

const guide={summary:'申込データを照合するツールです。',requirements:['対象データ'],steps:['元データを確認する','プレビューを確認する'],notes:['本番送信は別の操作です。'],related_links:[],source_note:'元の登録説明から整理。',suggested_kind:'tool',suggested_tags:['分類候補ユニーク'],status:'draft'};
function fixture(){const store=new Store(':memory:'),catalog=new Catalog(store);const users=['owner','other','admin'].map((name,i)=>{const id=randomUUID();store.run('INSERT INTO users(id,email,name,role,created_at) VALUES (?,?,?,?,?)',id,name+'@japanopenpoker.com',name,i===2?'admin':'user',now());return store.one<User>('SELECT * FROM users WHERE id=?',id)!;});return {store,catalog,users};}
test('reader guides preserve original records and keep proposed tags separate from real classification',async ()=>{
 const {store,catalog,users}=fixture();try{const original=(await catalog.create(users[0],{title:'既存成果',description:'元紹介文',url:'https://example.com/',tags:['元タグ'],visibility:'private',status:'draft'}));const before=(await catalog.get(original.id,users[0]));
  const updated=(await catalog.setReaderGuide(original.id,users[0],{version:original.version,guide}));assert.equal(updated.reader_guide?.summary,guide.summary);assert.equal(updated.version,original.version+1);assert.deepEqual(updated.tags,['元タグ']);assert.equal(updated.kind,null);assert.equal(updated.status,'draft');assert.equal(updated.visibility,'private');assert.equal(updated.description,'元紹介文');assert.equal((await catalog.get(original.id,users[0])).source_metadata,before.source_metadata);
  assert.equal((await catalog.list(users[0],new URLSearchParams({q:'照合する'}))).total,1);assert.equal((await catalog.list(users[0],new URLSearchParams({q:'分類候補ユニーク'}))).total,0);assert.equal((await catalog.masters(users[0])).tags.some(t=>t.name==='分類候補ユニーク'),false);
 }finally{store.close();}
});
test('private reader guides cannot be fetched, searched or changed by another user',async ()=>{
 const {store,catalog,users}=fixture();try{const r=(await catalog.create(users[0],{title:'private',url:'https://example.com/',visibility:'private'}));(await catalog.setReaderGuide(r.id,users[0],{version:r.version,guide}));await assert.rejects(()=>catalog.get(r.id,users[1]));assert.equal((await catalog.list(users[1],new URLSearchParams({q:'照合する'}))).total,0);await assert.rejects(()=>catalog.setReaderGuide(r.id,users[1],{version:r.version+1,guide}));
 }finally{store.close();}
});
test('document key points are stored separately from operational steps and enter content search',async ()=>{
 const {store,catalog,users}=fixture();try{
  const r=(await catalog.create(users[0],{title:'企画書',url:'https://example.com/proposal',kind:'document'}));
  const updated=(await catalog.setReaderGuide(r.id,users[0],{version:r.version,guide:{...guide,suggested_kind:'document',requirements:[],steps:[],notes:[],key_points:['部署横断のナレッジを集約する。','検索語ポイントXYZで内容を確認できる。']}}));
  assert.deepEqual(updated.reader_guide?.steps,[]);assert.equal(updated.reader_guide?.key_points.length,2);assert.equal((await catalog.list(users[1],new URLSearchParams({q:'ポイントXYZ'}))).total,1);
 }finally{store.close();}
});
test('public reader guide updates require edit permissions and an exact version; unsafe links are rejected',async ()=>{
 const {store,catalog,users}=fixture();try{const r=(await catalog.create(users[0],{title:'shared',url:'https://example.com/'}));await assert.rejects(()=>catalog.setReaderGuide(r.id,users[1],{version:r.version,guide}));await assert.rejects(()=>catalog.setReaderGuide(r.id,users[0],{version:r.version,guide:{...guide,related_links:[{label:'bad',url:'javascript:alert(1)'}]}}));
  (await catalog.setReaderGuide(r.id,users[0],{version:r.version,guide}));await assert.rejects(()=>catalog.setReaderGuide(r.id,users[0],{version:r.version,guide:{...guide,summary:'stale'}}),/更新/);assert.equal(catalog.view((await catalog.get(r.id,users[1])),users[1]).reader_guide?.status,'draft');
  const confirmed=(await catalog.setReaderGuide(r.id,users[0],{version:r.version+1,guide:{...guide,status:'confirmed'}}));assert.equal(confirmed.reader_guide?.status,'confirmed');
 }finally{store.close();}
});
