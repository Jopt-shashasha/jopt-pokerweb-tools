import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.js';
import { runBackup } from '../scripts/backup.js';

test('backup copies a consistent database (including WAL data), new blobs only, and keeps N copies',async()=>{
 const root=await mkdtemp(join(tmpdir(),'portal-backup-'));try{
  const data=join(root,'data'),out=join(root,'backup');await mkdir(join(data,'blobs'),{recursive:true});
  const store=new Store(join(data,'portal.sqlite'));store.run("INSERT INTO departments(id,name,sort_order) VALUES ('d1','カスタマー',0)");
  await writeFile(join(data,'blobs','a'),'x');
  let t=Date.parse('2026-11-19T00:00:00Z');const clock=()=>new Date(t);
  const first=await runBackup(data,out,2,clock);assert.equal(first.integrity,'ok');assert.equal(first.blobs_copied,1);
  const copy=new DatabaseSync(first.database,{readOnly:true});assert.equal((copy.prepare('SELECT name FROM departments').get() as {name:string}).name,'カスタマー','uncheckpointed WAL rows are included');copy.close();
  await writeFile(join(data,'blobs','b'),'y');t+=86400000;assert.equal((await runBackup(data,out,2,clock)).blobs_copied,1);
  t+=86400000;const third=await runBackup(data,out,2,clock);assert.equal(third.removed.length,1);assert.equal((await readdir(join(out,'db'))).length,2);
  await assert.rejects(runBackup(data,join(data,'inside'),2,clock),/outside/);
  store.close();
 }finally{await rm(root,{recursive:true,force:true});}
});
