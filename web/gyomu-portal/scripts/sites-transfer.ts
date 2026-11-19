import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { digest } from '../src/blob-store.js';
import { D1Store } from '../src/d1.js';
import { referencedObjects, transferColumns, transferStatements, transferTables, type PortalTransfer } from '../src/sites-transfer.js';

const [command,targetArg,host]=process.argv.slice(2);
if(!['export','verify','upload','probe'].includes(command)||!targetArg)throw Error('Usage: tsx scripts/sites-transfer.ts export|verify|upload|probe <snapshot-directory> [HTTPS origin]');
const target=resolve(targetArg);
const local=resolve('.local');
const readObject=(dir:string,id:string)=>readFile(join(dir,'objects',id));

async function sendSnapshot(send:(path:string,init:RequestInit)=>Promise<Pick<Response,'status'|'json'>>,key:string,raw:string,snapshot:PortalTransfer){
 async function sendPart(path:string,method:string,body?:string|ArrayBuffer){
  const headers=new Headers({'x-portal-migration-key':key});
  if(body!==undefined)headers.set('content-length',String(typeof body==='string'?Buffer.byteLength(body):body.byteLength));
  const response=await send('/_portal-migration/'+path,{method,body,redirect:'manual',headers})
   .catch(error=>{throw new Error('Migration request failed at '+path.split('/')[0],{cause:error});});
  if(response.status!==200)throw Error('Snapshot '+path+' returned HTTP '+response.status);
  return await response.json().catch(error=>{throw new Error('Reading migration response failed at '+path.split('/')[0],{cause:error});}) as {status:string;resources?:number;users?:number;objects?:number};
 }
 const status=await sendPart('status','GET');
 if(status.status==='already-restored')return status;
 if(status.status!=='ready')throw Error('Migration is not ready');
 const result=await sendPart('manifest','PUT',raw);
 if(result.status==='already-restored')return result;
 if(result.status!=='staged')throw Error('Manifest was not staged');
 for(const object of snapshot.objects){
  const bytes=await readObject(target,object.id);
  await sendPart('objects/'+object.id,'PUT',Uint8Array.from(bytes).buffer);
 }
 return sendPart('commit','POST');
}

async function readAccess(){
 const input=process.stdin;
 if(input.isTTY)input.setRawMode(true);
 process.stderr.write('Ready for Sites service access on stdin (input hidden).\n');
 input.setEncoding('utf8');
 const raw=await new Promise<string>((done,reject)=>{
  let text='';
  function finish(){
   input.removeListener('data',onData);input.removeListener('end',finish);
   if(input.isTTY)input.setRawMode(false);
   input.pause();done(text.split(/[\r\n]/)[0]);
  }
  function onData(chunk:string){
   text+=chunk;
   if(text.includes('\u0003')||/[\r\n]/.test(text))finish();
  }
  input.on('data',onData);input.once('end',finish);input.once('error',reject);input.resume();
 });
 const access=JSON.parse(raw) as {siteToken?:string;migrationKey?:string};
 if(!access.siteToken||!/^[a-f0-9]{64}$/.test(access.migrationKey??''))throw Error('Missing service access');
 return {siteToken:access.siteToken,migrationKey:access.migrationKey!};
}

if(command==='export'){
 const snapshot:PortalTransfer={version:1,tables:{} as PortalTransfer['tables'],objects:[]};
 const db=new DatabaseSync(join(local,'portal-local.sqlite'),{readOnly:true});
 try{
  db.exec('BEGIN');
  for(const table of transferTables){
   const available=new Set(db.prepare('PRAGMA table_info('+table+')').all().map(column=>column.name));
   const columns=transferColumns[table].map(column=>{
    if(available.has(column))return column;
    if(table==='resources'&&column==='impact')return 'NULL AS impact';
    throw Error('Missing source column: '+table+'.'+column);
   });
   snapshot.tables[table]=db.prepare('SELECT '+columns.join(',')+' FROM '+table+' ORDER BY rowid').all() as PortalTransfer['tables'][typeof table];
  }
  db.exec('COMMIT');
 }finally{db.close();}
 const stage=join(dirname(target),basename(target)+'.'+randomUUID()+'.tmp');
 await mkdir(join(stage,'objects'),{recursive:true});
 for(const id of referencedObjects(snapshot.tables)){
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))throw Error('Invalid object id in local data');
  const bytes=await readFile(join(local,'blobs',id));
  snapshot.objects.push({id,size:bytes.length,sha256:digest(bytes)});
  await writeFile(join(stage,'objects',id),bytes,{flag:'wx'});
 }
 const raw=JSON.stringify(snapshot);
 transferStatements(snapshot,digest(raw));
 await writeFile(join(stage,'catalog.json'),raw,{flag:'wx'});
 await rename(stage,target);
 console.log(JSON.stringify({resources:snapshot.tables.resources.length,users:snapshot.tables.users.length,objects:snapshot.objects.length,bytes:snapshot.objects.reduce((n,o)=>n+o.size,0),sha256:digest(raw)}));
}else if(command==='upload'||command==='probe'){
 if(!host||new URL(host).origin!==host||!host.startsWith('https://'))throw Error('Use the exact HTTPS Site origin');
 const {siteToken,migrationKey}=await readAccess();
 const send=(path:string,init:RequestInit={})=>{
  const headers=new Headers(init.headers);
  headers.delete('content-length');
  headers.set('OAI-Sites-Authorization','Bearer '+siteToken);
  return fetch(host+path,{...init,headers,redirect:'manual',signal:AbortSignal.timeout(30000)});
 };
 if(command==='upload'){
  const raw=await readFile(join(target,'catalog.json'),'utf8'),snapshot=JSON.parse(raw) as PortalTransfer;
  console.log(JSON.stringify(await sendSnapshot(send,migrationKey,raw,snapshot)));
 }else{
  const [health,profile,resources,mcp,importer]=await Promise.all([
   send('/health'),send('/api/me'),send('/api/resources'),send('/portal-mcp'),
   send('/_portal-migration/status',{headers:{'x-portal-migration-key':migrationKey}})
  ]);
  if(health.status!==200||profile.status!==200||resources.status!==401||mcp.status!==401||importer.status!==404){
   throw Error('Unexpected health or authorization status: '+[health.status,profile.status,resources.status,mcp.status,importer.status].join(','));
  }
  const settings=await profile.json() as {google_configured?:boolean};
  console.log(JSON.stringify({live:true,googleConfigured:settings.google_configured===true,anonymousResources:resources.status,anonymousMcp:mcp.status,migration:importer.status}));
 }
}else{
 const raw=await readFile(join(target,'catalog.json'),'utf8'),snapshot=JSON.parse(raw) as PortalTransfer;
 const origin='https://portal.test',key='0'.repeat(64);
 const mf=new Miniflare({
  modules:true,scriptPath:'dist/server/index.js',compatibilityFlags:['nodejs_compat'],compatibilityDate:'2026-07-30',
  d1Databases:['DB'],r2Buckets:['BUCKET'],bindings:{APP_ORIGIN:origin,NEWS_FEED_URLS:'',PORTAL_MIGRATION_KEY:key,PORTAL_MIGRATION_SHA256:digest(raw)}
 });
 try{
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('BUCKET'),store=new D1Store(db);
  const root=resolve('dist/.openai/drizzle');
  const journal=JSON.parse(await readFile(join(root,'meta/_journal.json'),'utf8')) as {entries:{tag:string}[]};
  for(const {tag} of journal.entries){
   const sql=await readFile(join(root,tag+'.sql'),'utf8');
   await db.batch(sql.split('--> statement-breakpoint').map(statement=>db.prepare(statement.trim())));
  }
  const send=(path:string,init:RequestInit)=>mf.dispatchFetch(origin+path,init as Parameters<typeof mf.dispatchFetch>[1]);
  const unauthed=await send('/_portal-migration/commit',{method:'POST'});
  if(unauthed.status!==404)throw Error('Import route accepted a missing migration key');
  await unauthed.json();
  if((await sendSnapshot(send,key,raw,snapshot)).status!=='restored')throw Error('Expected first-time import');
  if((await sendSnapshot(send,key,raw,snapshot)).status!=='already-restored')throw Error('Expected idempotent import');
  for(const table of transferTables){
   const imported=await store.all('SELECT '+transferColumns[table].join(',')+' FROM '+table);
   const sortRows=(rows:unknown[])=>rows.map(row=>JSON.stringify(row)).sort();
   if(JSON.stringify(sortRows(imported))!==JSON.stringify(sortRows(snapshot.tables[table])))throw Error('Data mismatch in '+table);
  }
  for(const item of snapshot.objects){
   const blob=await bucket.get(item.id);
   if(!blob||digest(new Uint8Array(await blob.arrayBuffer()))!==item.sha256)throw Error('R2 object failed checksum: '+item.id);
  }
  console.log(JSON.stringify({verified:true,resources:snapshot.tables.resources.length,users:snapshot.tables.users.length,objects:snapshot.objects.length,tables:transferTables.length}));
 }finally{await mf.dispose();}
}
