import { timingSafeEqual } from 'node:crypto';
import type { R2Bucket } from '@cloudflare/workers-types';
import { digest } from './blob-store.js';
import { isBatchConflict, type Database } from './database.js';
import { transferMarker, transferStatements, type PortalTransfer } from './sites-transfer.js';

export async function migrateSite(
 request:Request,store:Database,bucket:R2Bucket,origin:string,secret:string|undefined,expected:string|undefined
):Promise<Response>{
 const url=new URL(request.url);
 const supplied=request.headers.get('x-portal-migration-key')??'';
 if(url.origin!==origin||!secret||!/^[a-f0-9]{64}$/.test(secret)||!/^[a-f0-9]{64}$/.test(expected??'')||
    !timingSafeEqual(Buffer.from(digest(secret)),Buffer.from(digest(supplied)))){
  return Response.json({error:'Not found'},{status:404});
 }
 const hash=expected!;
 const current=await store.one<{value:string}>('SELECT value FROM portal_settings WHERE key=?',transferMarker);
 if(current?.value===hash)return Response.json({status:'already-restored'});
 if(current||await store.one('SELECT id FROM resources LIMIT 1')||await store.one('SELECT id FROM users LIMIT 1')){
  return Response.json({error:'Import requires empty portal data'},{status:409});
 }
 const path=url.pathname.slice('/_portal-migration/'.length);
 if(request.method==='GET'&&path==='status')return Response.json({status:'ready'});
 const manifestKey='migration/'+hash+'/catalog';
 if(request.method==='PUT'&&path==='manifest'){
  const raw=await boundedBody(request,1024*1024);
  if(!raw||digest(raw)!==hash)return Response.json({error:'Unexpected snapshot'},{status:400});
  transferStatements(JSON.parse(new TextDecoder().decode(raw)) as PortalTransfer,hash);
  await bucket.put(manifestKey,raw);
  return Response.json({status:'staged'});
 }
 const manifest=await bucket.get(manifestKey);
 if(!manifest)return Response.json({error:'Manifest is required'},{status:409});
 const raw=await manifest.arrayBuffer();
 if(digest(new Uint8Array(raw))!==hash)return Response.json({error:'Manifest verification failed'},{status:409});
 const snapshot=JSON.parse(new TextDecoder().decode(raw)) as PortalTransfer;
 if(request.method==='PUT'&&path.startsWith('objects/')){
  const item=snapshot.objects.find(o=>o.id===path.slice('objects/'.length));
  if(!item)return Response.json({error:'Object is not in snapshot'},{status:404});
  const bytes=await boundedBody(request,item.size);
  if(!bytes||bytes.byteLength!==item.size||digest(bytes)!==item.sha256)return Response.json({error:'Object checksum mismatch'},{status:400});
  await bucket.put(item.id,bytes,{customMetadata:{portal_migration:hash,sha256:item.sha256}});
  return Response.json({status:'staged'});
 }
 if(request.method!=='POST'||path!=='commit')return Response.json({error:'Not found'},{status:404});
 const missing=new Map(snapshot.objects.map(item=>[item.id,item]));
 let cursor:string|undefined;
 do{
  const page=await bucket.list({include:['customMetadata'],limit:100,cursor});
  for(const item of page.objects){
   const expectedItem=missing.get(item.key);
   if(expectedItem&&item.size===expectedItem.size&&item.customMetadata?.portal_migration===hash&&item.customMetadata.sha256===expectedItem.sha256)missing.delete(item.key);
  }
  cursor=page.truncated?page.cursor:undefined;
 }while(cursor&&missing.size);
 if(missing.size)return Response.json({error:'Referenced objects are missing',count:missing.size},{status:409});
 try{
  await store.batch(transferStatements(snapshot,hash));
 }catch(error){
  if(!isBatchConflict(error))throw error;
  const previous=await store.one<{value:string}>('SELECT value FROM portal_settings WHERE key=?',transferMarker);
  return previous?.value===hash?Response.json({status:'already-restored'}):Response.json({error:'Target data changed'},{status:409});
 }
 await bucket.delete(manifestKey);
 return Response.json({status:'restored',resources:snapshot.tables.resources.length,users:snapshot.tables.users.length,objects:snapshot.objects.length});
}

async function boundedBody(request:Request,max:number){
 const length=request.headers.get('content-length');
 if(length===null||!/^\d+$/.test(length)||Number(length)>max)return null;
 const bytes=new Uint8Array(await request.arrayBuffer());
 return bytes.byteLength<=max?bytes:null;
}
