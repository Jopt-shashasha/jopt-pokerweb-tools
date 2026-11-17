import { randomUUID } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { Store } from './db.js';
import { Catalog } from './repository.js';
import { digest,type BlobStore } from './storage.js';
import { stageMarkdown } from './markdown.js';
import { epoch,type Config,type User } from './model.js';
import { resourceInput,httpUrl } from './validation.js';
import { SESSION_POLICY } from './auth.js';

export const searchInput=z.object({q:z.string().trim().max(160).default(''),department:z.string().max(100).optional(),category:z.string().max(100).optional(),kind:z.enum(['document','tool','unclassified']).optional(),event:z.string().max(100).optional(),event_scope:z.string().max(100).optional(),tag:z.string().max(60).optional(),page:z.number().int().min(1).max(100000).default(1)}).strict();
export const readInput=z.object({id:z.string().uuid(),include_markdown:z.boolean().default(false),markdown_offset:z.number().int().min(0).max(300000).default(0)}).strict();
// Sharing is explicit in the browser review. New agent submissions default to private drafts.
export const registerInput=resourceInput.omit({version:true}).extend({url:httpUrl,visibility:z.enum(['company','private']).default('private'),status:z.enum(['draft','published']).default('draft')});
const schemas={search:searchInput,read:readInput,register:registerInput};
export const requestEnvelope=z.object({operation:z.enum(['search','read','register']),input:z.unknown(),result_key:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type Row={id:string;result_hash:string;operation:keyof typeof schemas;input:string;state:'pending'|'done'|'error'|'cancelled';actor_id:string|null;session_hash:string|null;result:string|null;created_at:number;expires_at:number};
export const AGENT_REQUEST_SECONDS=600;
export const AGENT_RESULT_BYTES=16000;

export class AgentRequests {
 constructor(private store:Store,private catalog:Catalog,private config:Config,private clock:()=>number=epoch,private blobs?:BlobStore){}
 create(body:unknown){
  const parsed=requestEnvelope.safeParse(body);if(!parsed.success)throw new HTTPException(400,{message:'連携リクエストを確認してください。'});
  const {operation,result_key}=parsed.data,input=schemas[operation].safeParse(parsed.data.input);
  if(!input.success)throw new HTTPException(400,{message:input.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join(' / ')});
  this.store.run('DELETE FROM agent_requests WHERE expires_at<=?',this.clock());
  if(this.store.one<{n:number}>('SELECT COUNT(*) n FROM agent_requests')!.n>=1000)throw new HTTPException(429,{message:'連携リクエストが混み合っています。しばらく待ってください。'});
  if(Number(this.store.one<{bytes:number}>('SELECT COALESCE(SUM(length(CAST(input AS BLOB))),0) bytes FROM agent_requests')?.bytes??0)+Buffer.byteLength(JSON.stringify(input.data))>32*1024*1024)throw new HTTPException(429,{message:'連携リクエストが混み合っています。'});
  const id=randomUUID(),expires=this.clock()+AGENT_REQUEST_SECONDS;
  this.store.run('INSERT INTO agent_requests(id,result_hash,operation,input,created_at,expires_at) VALUES (?,?,?,?,?,?)',id,digest(result_key),operation,JSON.stringify(input.data),this.clock(),expires);
  return {request_id:id,state:'pending',browser_url:this.config.origin+'/#/agent/'+id,expires_at:new Date(expires*1000).toISOString(),next:'Open browser_url in the signed-in browser, review the current account and requested action, then use its execute button. Call portal_result only after the browser reports completion. Do not copy browser cookies or log in through shell commands.'};
 }
 private row(id:string){const r=this.store.one<Row>('SELECT * FROM agent_requests WHERE id=? AND expires_at>?',id,this.clock());if(!r)throw new HTTPException(404,{message:'連携リクエストが見つからないか、有効期限が切れています。'});return r;}
 preview(id:string,user:User){
  const r=this.row(id);if(r.actor_id&&r.actor_id!==user.id)throw new HTTPException(404);
  const input=JSON.parse(r.input),creator=input.creator_id&&user.role==='admin'?this.store.one<{name:string}>('SELECT name FROM users WHERE id=?',input.creator_id)?.name:user.name;
  let resourceTitle:string|null=null;
  if(r.operation==='read'){try{resourceTitle=this.catalog.get(input.id,user).title;}catch(e){if(!(e instanceof HTTPException))throw e;resourceTitle='閲覧できない資料';}}
  const previewInput={...input,search_text:undefined,...(input.markdown?{markdown:{filename:input.markdown.filename,bytes:Buffer.byteLength(input.markdown.content),excerpt:input.markdown.content.slice(0,800)}}:{})};
  return {id:r.id,operation:r.operation,input:previewInput,state:r.state,resource_title:resourceTitle,creator_name:creator??input.creator_id,result:r.result?JSON.parse(r.result):null};
 }
 private summary(r:Record<string,any>){return {id:r.id,title:r.title,description:String(r.description??'').slice(0,200),department:r.department_name??null,categories:r.categories??[],events:r.events??[],kind:r.kind,creator:r.creator_name,status:r.status,visibility:r.visibility,portal_url:this.config.origin+'/#/resource/'+r.id};}
 async execute(id:string,user:User,sessionHash:string){
  const initial=this.row(id),initialInput=JSON.parse(initial.input);
  const asset=initial.state==='pending'&&initial.operation==='register'?await stageMarkdown(this.blobs,initialInput.markdown):undefined;
  let markdownContent:string|undefined;
  if(initial.state==='pending'&&initial.operation==='read'&&initialInput.include_markdown){
   try{const resource=this.catalog.get(initialInput.id,user),md=this.store.one<{blob:string}>('SELECT blob FROM resource_markdown WHERE resource_id=?',resource.id);
    if(md&&this.blobs)markdownContent=Buffer.from(await this.blobs.get(md.blob)).toString('utf8');
   }catch(e){if(!(e instanceof HTTPException))throw e;}
  }
  let committed=false,attached=false;
  try{const executed=this.store.transaction(()=>{
   if(!this.store.one('SELECT s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND u.active=1',sessionHash,user.id,this.clock()))throw new HTTPException(401,{message:'ブラウザでログインし直してください。'});
   const r=this.row(id);if(r.actor_id&&r.actor_id!==user.id)throw new HTTPException(404);
   if(r.state!=='pending')return {state:r.state,result:r.result?JSON.parse(r.result):null};
   const input=JSON.parse(r.input);let value:Record<string,unknown>,state:'done'|'error'='done';
   try{
    if(r.operation==='search'){
     const query=new URLSearchParams(Object.entries(input).map(([k,v])=>[k,String(v)]));query.set('page_size','5');
     const found=this.catalog.list(user,query);value={total:found.total,page:found.page,items:found.items.map(x=>this.summary(x))};
    }else if(r.operation==='read'){
     const source=this.catalog.get(input.id,user),view=this.catalog.view(source,user);
     if(input.include_markdown){
      if(markdownContent===undefined)throw new HTTPException(404,{message:'MDの説明書は添付されていません。'});
      const offset=Math.min(input.markdown_offset,markdownContent.length),content=markdownContent.slice(offset,offset+2000);
      value={id:source.id,title:source.title,markdown:{filename:view.markdown!.filename,content,offset,next_offset:offset+content.length,has_more:offset+content.length<markdownContent.length}};
     }else value={...this.summary(view),description:source.description.slice(0,2000),description_truncated:source.description.length>2000,url:source.url,open_url:view.open_url?.startsWith('/')?this.config.origin+view.open_url:view.open_url,has_html:view.has_html,tags:JSON.parse(source.tags),source:source.source_system,markdown:view.markdown};
    }else{
     const created=this.catalog.create(user,input,undefined,asset);attached=!!asset;value={...this.summary(created),registered_by:user.name,markdown:created.markdown};
    }
   }catch(e){if(!(e instanceof HTTPException))throw e;state='error';value={error:e.message||'操作できません。',status:e.status};}
   const result={...value,actor:{name:user.name,email:user.email},operation:r.operation,portal_model_calls:0};
   if(Buffer.byteLength(JSON.stringify(result))>AGENT_RESULT_BYTES)throw new HTTPException(413,{message:'結果が大きすぎます。ポータル画面で確認してください。'});
   this.store.run('UPDATE agent_requests SET state=?,actor_id=?,session_hash=?,result=? WHERE id=?',state,user.id,sessionHash,JSON.stringify(result),id);
   return {state,result};
  });committed=true;return executed;}finally{if(asset&&(!committed||!attached))await this.blobs!.remove(asset.blob);}
 }
 cancel(id:string,user:User){const r=this.row(id);if(r.actor_id&&r.actor_id!==user.id)throw new HTTPException(404);if(r.state==='pending')this.store.run("UPDATE agent_requests SET state='cancelled',actor_id=? WHERE id=?",user.id,id);return {state:r.state==='pending'?'cancelled':r.state};}
 result(id:string,key:string){
  const r=this.row(id);if(!/^[a-f0-9]{64}$/.test(key)||digest(key)!==r.result_hash)throw new HTTPException(404);
  if(r.session_hash&&!this.store.one(`SELECT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND s.created_at>? AND u.active=1`,r.session_hash,this.clock(),this.clock()-SESSION_POLICY.absoluteSeconds))throw new HTTPException(401,{message:'ブラウザでログインし直し、新しい操作を依頼してください。'});
  return {request_id:r.id,state:r.state,...(r.result?{result:JSON.parse(r.result)}:{})};
 }
}
