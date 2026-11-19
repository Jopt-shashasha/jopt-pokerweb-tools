import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/db.js';
import { Catalog } from '../src/repository.js';
import { impactHeadline } from '../src/impact.js';
import { now,type User } from '../src/model.js';

function fixture(){
 const store=new Store(':memory:'),catalog=new Catalog(store);
 const users=['admin','a'].map((name,i)=>{const id=randomUUID();store.run('INSERT INTO users(id,email,name,role,created_at) VALUES (?,?,?,?,?)',id,name+'@japanopenpoker.com',name,i===0?'admin':'user',now());return store.one<User>('SELECT * FROM users WHERE id=?',id)!;});
 return {store,catalog,users};
}

test('headline template: audience/department prefix, before→after, frequency; nothing invented',()=>{
 assert.deepEqual(impactHeadline('Voucher照合ツール',null,{audience:'カスタマー担当',task:'Voucher照合',before:'5分/件',after:'30秒/件',frequency:'1日20件'}),
  {label:'カスタマー担当向け｜Voucher照合ツール',effect:'Voucher照合が 5分/件 → 30秒/件（1日20件）',text:'カスタマー担当向け｜Voucher照合ツール：Voucher照合が 5分/件 → 30秒/件（1日20件）'});
 assert.equal(impactHeadline('T','カスタマー',{before:'5分',after:'30秒'})!.label,'カスタマー向け｜T','falls back to the department');
 assert.equal(impactHeadline('T',null,{task:'Ticket確認'})!.effect,'Ticket確認');
 assert.equal(impactHeadline('T',null,{before:'5分'}),null,'half a comparison is not shown');
 assert.equal(impactHeadline('T',null,null),null);
});

test('impact is stored, shown, searchable, kept on partial edits and clearable',async ()=>{
 const f=fixture();try{
  const r=(await f.catalog.create(f.users[1],{title:'照合ツール',url:'https://example.com/t',impact:{audience:'カスタマー担当',task:'Voucher照合',before:'5分/件',after:'30秒/件',frequency:'',}}));
  assert.deepEqual(r.impact,{audience:'カスタマー担当',task:'Voucher照合',before:'5分/件',after:'30秒/件'},'empty fields dropped');
  assert.equal(r.headline!.effect,'Voucher照合が 5分/件 → 30秒/件');
  assert.equal((await f.catalog.list(f.users[0],new URLSearchParams({q:'Voucher照合'}))).total,1,'task is searchable');
  const base={title:'照合ツール',url:'https://example.com/t'};
  const kept=(await f.catalog.update(r.id,f.users[1],{...base,version:r.version}));assert.equal(kept.headline!.effect,'Voucher照合が 5分/件 → 30秒/件','omitted impact keeps the value');
  const cleared=(await f.catalog.update(r.id,f.users[1],{...base,version:kept.version,impact:null}));assert.equal(cleared.impact,null);assert.equal(cleared.headline,null);
  const none=(await f.catalog.update(r.id,f.users[1],{...base,version:cleared.version,impact:{audience:' ',task:''}}));assert.equal(none.impact,null,'all-blank input stores nothing');
  await assert.rejects(()=>f.catalog.create(f.users[1],{...base,impact:{before:'x'.repeat(31)}}),/impact/);
  await assert.rejects(()=>f.catalog.create(f.users[1],{...base,impact:{savings:'10h'}}),/impact/);
  f.store.run("UPDATE resources SET impact='not json' WHERE id=?",r.id);assert.equal((await f.catalog.get(r.id,f.users[1])).id,r.id);
  assert.equal(f.catalog.view((await f.catalog.get(r.id,f.users[1])),f.users[1]).headline,null,'corrupt stored value is ignored');
 }finally{f.store.close();}
});
