import { randomBytes,randomUUID } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { isBatchConflict, requireSql, type Database, type Statement } from './database.js';
import { Catalog, readable, readArgs } from './repository.js';
import { digest,type BlobStore } from './blob-store.js';
import { epoch,type Config,type User } from './model.js';
import { resourceInput } from './validation.js';
import { SESSION_POLICY } from './auth.js';

export const searchInput=z.object({q:z.string().trim().max(160).default(''),department:z.string().max(100).optional(),category:z.string().max(100).optional(),kind:z.enum(['document','tool','unclassified']).optional(),event:z.string().max(100).optional(),event_scope:z.string().max(100).optional(),tag:z.string().max(60).optional(),page:z.number().int().min(1).max(100000).default(1)}).strict();
export const readInput=z.object({id:z.string().uuid(),include_markdown:z.boolean().default(false),markdown_offset:z.number().int().min(0).max(300000).default(0)}).strict();
// Sharing is explicit in the browser review. New agent submissions default to private drafts.
export const registerInput=resourceInput.omit({version:true}).extend({visibility:z.enum(['company','private']).default('private'),status:z.enum(['draft','published']).default('draft')});
const schemas={search:searchInput,read:readInput,register:registerInput};
export const requestEnvelope=z.object({operation:z.enum(['search','read','register']),input:z.unknown(),result_key:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type Row={id:string;result_hash:string;operation:keyof typeof schemas;input:string;state:'pending'|'done'|'error'|'cancelled';actor_id:string|null;session_hash:string|null;result:string|null;created_at:number;expires_at:number};
export const AGENT_REQUEST_SECONDS=600;
export const AGENT_RESULT_BYTES=16000;

export class AgentRequests {
 constructor(private store:Database,private catalog:Catalog,private config:Config,private clock:()=>number=epoch,private blobs?:BlobStore){}
 async create(body:unknown,actorId:string|null=null){
  const parsed=requestEnvelope.safeParse(body);
  if(!parsed.success)throw new HTTPException(400,{message:'連携リクエストを確認してください。'});
  const {operation,result_key}=parsed.data,input=schemas[operation].safeParse(parsed.data.input);
  if(!input.success)throw new HTTPException(400,{message:input.error.issues.map(i=>i.path.join('.')+': '+i.message).join(' / ')});
  const id=randomUUID(),time=this.clock(),expires=time+AGENT_REQUEST_SECONDS,payload=JSON.stringify(input.data);
  await this.store.run('DELETE FROM agent_requests WHERE expires_at<=?',time);
  const inserted=await this.store.run(`INSERT INTO agent_requests(id,result_hash,operation,input,actor_id,created_at,expires_at)
   SELECT ?,?,?,?,?,?,? WHERE
    (SELECT COUNT(*) FROM agent_requests)<1000
    AND (SELECT COALESCE(SUM(length(CAST(input AS BLOB))),0) FROM agent_requests)+?<=?`,
   id,digest(result_key),operation,payload,actorId,time,expires,Buffer.byteLength(payload),32*1024*1024);
  if(!inserted.changes)throw new HTTPException(429,{message:'連携リクエストが混み合っています。しばらく待ってください。'});
  return {request_id:id,state:'pending',browser_url:this.config.origin+'/#/agent/'+id,expires_at:new Date(expires*1000).toISOString(),next:'Open browser_url in the signed-in browser, review the current account and requested action, then use its execute button. Call portal_result only after the browser reports completion. Do not copy browser cookies or log in through shell commands.'};
 }
 private async row(id:string){const r=await this.store.one<Row>('SELECT * FROM agent_requests WHERE id=? AND expires_at>?',id,this.clock());if(!r)throw new HTTPException(404,{message:'連携リクエストが見つからないか、有効期限が切れています。'});return r;}
 async preview(id:string,user:User){
  const r=await this.row(id);if(r.actor_id&&r.actor_id!==user.id)throw new HTTPException(404);
  const input=JSON.parse(r.input),creator=input.creator_id&&user.role==='admin'?(await this.store.one<{name:string}>('SELECT name FROM users WHERE id=?',input.creator_id))?.name:user.name;
  let resourceTitle:string|null=null;
  if(r.operation==='read'){try{resourceTitle=(await this.catalog.get(input.id,user)).title;}catch(e){if(!(e instanceof HTTPException))throw e;resourceTitle='閲覧できない資料';}}
  const previewInput={...input,search_text:undefined,markdown:undefined};
  return {id:r.id,operation:r.operation,input:previewInput,state:r.state,resource_title:resourceTitle,creator_name:creator??input.creator_id,result:r.result?JSON.parse(r.result):null};
 }
 summary(r:Record<string,any>){return {id:r.id,title:r.title,headline:r.headline?.text??null,description:String(r.description??'').slice(0,200),department:r.department_name??null,categories:r.categories??[],events:r.events??[],kind:r.kind,creator:r.creator_name,status:r.status,visibility:r.visibility,portal_url:this.config.origin+'/#/resource/'+r.id};}
 private sessionStatement(user:User,sessionHash:string): Statement {
  const time=this.clock();
  return [`SELECT s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id
   WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND s.created_at>? AND u.active=1`,
   sessionHash,user.id,time,time-SESSION_POLICY.absoluteSeconds];
 }

 async execute(id:string,user:User,sessionHash:string){
  const [sessionSql,...sessionArgs]=this.sessionStatement(user,sessionHash);
  if(!await this.store.one(sessionSql,...sessionArgs))throw new HTTPException(401,{message:'ブラウザでログインし直してください。'});
  const r=await this.row(id);
  if(r.actor_id&&r.actor_id!==user.id)throw new HTTPException(404);
  if(r.state!=='pending')return {state:r.state,result:r.result?JSON.parse(r.result):null};

  const input=JSON.parse(r.input);
  let value:Record<string,unknown>,state:'done'|'error'='done';
  let operation:Statement[]=[];
  try{
   if(r.operation==='search'){
    const query=new URLSearchParams(Object.entries(input).map(([k,v])=>[k,String(v)]));
    query.set('page_size','5');
    const found=await this.catalog.list(user,query);
    value={total:found.total,page:found.page,items:found.items.map(x=>this.summary(x))};
   }else if(r.operation==='read'){
    const source=await this.catalog.get(input.id,user),view=this.catalog.view(source,user);
    if(input.include_markdown){
     const md=await this.store.one<{blob:string;filename:string}>('SELECT blob,filename FROM resource_markdown WHERE resource_id=?',source.id);
     if(!md||!this.blobs)throw new HTTPException(404,{message:'MDの説明書は添付されていません。'});
     const markdown=Buffer.from(await this.blobs.get(md.blob)).toString('utf8');
     const offset=Math.min(input.markdown_offset,markdown.length),content=markdown.slice(offset,offset+2000);
     value={id:source.id,title:source.title,markdown:{filename:md.filename,content,offset,next_offset:offset+content.length,has_more:offset+content.length<markdown.length}};
    }else{
     value={...this.summary(view),description:source.description.slice(0,2000),description_truncated:source.description.length>2000,url:source.url,open_url:view.open_url?.startsWith('/')?this.config.origin+view.open_url:view.open_url,has_html:view.has_html,tags:JSON.parse(source.tags),source:source.source_system,markdown:view.markdown};
    }
    operation=[requireSql('EXISTS(SELECT 1 FROM resources r WHERE r.id=? AND r.version=? AND '+readable+')',source.id,source.version,...readArgs(user))];
   }else{
    const planned=await this.catalog.prepareCreate(user,input);
    operation=planned.statements;
    value={...this.summary(planned.view),registered_by:user.name,url:planned.view.url};
   }
  }catch(error){
   if(!(error instanceof HTTPException))throw error;
   state='error';value={error:error.message||'操作できません。',status:error.status};
  }
  const result={...value,actor:{name:user.name,email:user.email},operation:r.operation,portal_model_calls:0};
  const payload=JSON.stringify(result);
  if(Buffer.byteLength(payload)>AGENT_RESULT_BYTES)throw new HTTPException(413,{message:'結果が大きすぎます。ポータル画面で確認してください。'});
  const [currentSessionSql,...currentSessionArgs]=this.sessionStatement(user,sessionHash);
  try{
   await this.store.batch([
    requireSql('EXISTS('+currentSessionSql+')',...currentSessionArgs),
    requireSql("EXISTS(SELECT 1 FROM agent_requests WHERE id=? AND expires_at>? AND state='pending' AND (actor_id IS NULL OR actor_id=?))",id,this.clock(),user.id),
    ...operation,
    ['UPDATE agent_requests SET state=?,actor_id=?,session_hash=?,result=? WHERE id=?',state,user.id,sessionHash,payload,id]
   ]);
  }catch(error){
   if(!isBatchConflict(error))throw error;
   if(!await this.store.one(currentSessionSql,...currentSessionArgs))throw new HTTPException(401,{message:'ブラウザでログインし直してください。'});
   const current=await this.row(id);
   if(current.actor_id&&current.actor_id!==user.id)throw new HTTPException(404);
   if(current.state!=='pending')return {state:current.state,result:current.result?JSON.parse(current.result):null};
   throw new HTTPException(409,{message:'内容が変更されました。確認してやり直してください。'});
  }
  return {state,result};
 }
 /** Token-authenticated (remote MCP) requests are bound to that employee: only their browser can execute them. */
 createFor(user:User,operation:'search'|'read'|'register',input:unknown){
  return this.create({operation,input,result_key:randomBytes(32).toString('hex')},user.id);
 }
 async resultFor(id:string,user:User){
  const row=await this.row(id);
  if(row.actor_id!==user.id)throw new HTTPException(404);
  return {request_id:row.id,state:row.state,...(row.result?{result:JSON.parse(row.result)}:{})};
 }
 async cancel(id:string,user:User){
  await this.store.run("UPDATE agent_requests SET state='cancelled',actor_id=? WHERE id=? AND expires_at>? AND state='pending' AND (actor_id IS NULL OR actor_id=?)",user.id,id,this.clock(),user.id);
  const row=await this.row(id);
  if(row.actor_id&&row.actor_id!==user.id)throw new HTTPException(404);
  return {state:row.state};
 }
 async result(id:string,key:string){
  const row=await this.row(id);
  if(!/^[a-f0-9]{64}$/.test(key)||digest(key)!==row.result_hash)throw new HTTPException(404);
  if(row.session_hash&&!await this.store.one(`SELECT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND s.created_at>? AND u.active=1`,row.session_hash,this.clock(),this.clock()-SESSION_POLICY.absoluteSeconds))
   throw new HTTPException(401,{message:'ブラウザでログインし直し、新しい操作を依頼してください。'});
  return {request_id:row.id,state:row.state,...(row.result?{result:JSON.parse(row.result)}:{})};
 }
}
