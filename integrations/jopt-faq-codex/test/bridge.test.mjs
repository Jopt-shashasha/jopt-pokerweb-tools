import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import {createHash,randomUUID} from 'node:crypto';
import {fixture} from './fixture.mjs';

async function harness(){
 const head=['id','name','brand','dates','venue','guide_url','age_note','active','extra','order','updated_by','updated_at'];
 const grid=[head.slice(),['ev_a','SPADIE OSAKA 03','SPADIE','','変更前会場','','','TRUE','{}','1','','']];
 const cache=new Map();let actor='test@japanopenpoker.com',writes=0,locked=false;
 const sheet={getLastColumn:()=>grid[0].length,getLastRow:()=>grid.length,getRange:(r,c,nr=1,nc=1)=>({getDisplayValues:()=>Array.from({length:nr},(_,i)=>Array.from({length:nc},(_,j)=>String(grid[r-1+i]?.[c-1+j]??''))),setValue(v){grid[r-1]??=[];grid[r-1][c-1]=v;return this;},setFontWeight(){return this;},setNumberFormat(){return this;},setValues(values){writes++;values.forEach((row,i)=>{grid[r-1+i]??=[];row.forEach((v,j)=>grid[r-1+i][c-1+j]=v);});return this;}})};
 const read=()=>Object.fromEntries(grid.slice(1).map(row=>{const v=Object.fromEntries(grid[0].map((k,i)=>[k,k==='active'?row[i]==='TRUE':row[i]??'']));return [v.id,v];}));
 const ctx=createContext({console,Session:{getActiveUser:()=>({getEmail:()=>actor})},CacheService:{getScriptCache:()=>({get:k=>cache.get(k)||null,put:(k,v)=>cache.set(k,v)})},Utilities:{getUuid:randomUUID,DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_,s)=>createHash('sha256').update(s).digest(),base64EncodeWebSafe:x=>Buffer.from(x).toString('base64url'),formatDate:()=> '2026-10-24 12:00'},LockService:{getDocumentLock:()=>({waitLock(){assert.equal(locked,false);locked=true;},releaseLock(){locked=false;}})},SpreadsheetApp:{flush(){}},META:['updated_by','updated_at'],sheet_:()=>sheet,readKind_:read,getAll:()=>({events:read()}),toCell_:(k,v)=>v==null?'':k==='active'?(v?'TRUE':'FALSE'):String(v)});
 runInContext(await readFile(new URL('../shared/contract.cjs',import.meta.url),'utf8')+'\n'+await readFile(new URL('../apps-script/bridge.gs',import.meta.url),'utf8'),ctx);
 return {ctx,grid,read,setActor:v=>actor=v,get writes(){return writes;},get locked(){return locked;}};
}
test('bridge preserves unrelated fields, binds preview to actor and prevents replay writes',async()=>{
 const h=await harness(),p=fixture();p.operation='update';p.event_id='ev_a';
 const preview=h.ctx.previewEventImport(JSON.stringify(p));assert.equal(h.writes,0);
 h.setActor('other@japanopenpoker.com');assert.throws(()=>h.ctx.commitEventImport(preview.token,true),/別の利用者/);assert.equal(h.writes,0);
 h.setActor('test@japanopenpoker.com');const out=h.ctx.commitEventImport(preview.token,true);assert.equal(out.event_id,'ev_a');assert.equal(h.read().ev_a.venue,'変更前会場');assert.equal(h.read().ev_a.active,true);assert.equal(h.writes,1);assert.equal(h.locked,false);
 assert.equal(h.ctx.commitEventImport(preview.token,false).already_saved,true);assert.equal(h.writes,1);assert.equal(h.read().ev_a.active,true);
});
test('bridge rejects stale records, duplicates and non-company accounts without writes',async()=>{
 const h=await harness(),p=fixture();assert.throws(()=>h.ctx.previewEventImport(JSON.stringify(p)),/同名/);
 p.operation='update';p.event_id='ev_a';const preview=h.ctx.previewEventImport(JSON.stringify(p));h.grid[1][4]='同僚が修正した会場';
 assert.throws(()=>h.ctx.commitEventImport(preview.token,true),/他の利用者/);assert.equal(h.writes,0);assert.equal(h.read().ev_a.venue,'同僚が修正した会場');assert.equal(h.locked,false);
 h.setActor('outside@example.org');assert.throws(()=>h.ctx.previewEventImport(JSON.stringify(p)),/会社のGoogle/);assert.equal(h.writes,0);
});
