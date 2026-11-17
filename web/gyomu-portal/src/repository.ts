import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { HTTPException } from 'hono/http-exception';
import { Store } from './db.js';
import { canEdit, canRead, now, type Resource, type User } from './model.js';
import { parseResource } from './validation.js';
import { cleanTag,normalizeText,queryGroups,likePattern,indexResource,ensureSearchIndex,eventChoice } from './discovery.js';
import { saveMarkdown,type MarkdownAsset } from './markdown.js';
import { readerGuideUpdate,type ReaderGuide } from './reader.js';
import { resourceEvents,validateEvents,saveEvents } from './events.js';

const select = `SELECT r.*,u.name creator_name,u.email creator_email,d.name department_name,es.name event_scope_name,
 (SELECT json_group_array(category_name) FROM (SELECT category_name FROM resource_categories WHERE resource_id=r.id ORDER BY category_name)) categories,
 EXISTS(SELECT 1 FROM saved_resources s WHERE s.resource_id=r.id AND s.user_id=?) is_saved
 FROM resources r JOIN users u ON u.id=r.creator_id LEFT JOIN departments d ON d.id=r.department_id LEFT JOIN event_scopes es ON es.id=r.event_scope_id LEFT JOIN resource_search idx ON idx.resource_id=r.id`;
export const readable = '(r.creator_id=? OR ?=1 OR (r.status=\'published\' AND r.visibility=\'company\'))';
export const readArgs = (u: User): SQLInputValue[] => [u.id, u.role==='admin'?1:0];

export class Catalog {
 constructor(readonly store: Store) {}
 audit(actor: string | null, action: string, id: string | null, detail: unknown) {
  this.store.run('INSERT INTO audit VALUES (?,?,?,?,?,?)',randomUUID(),actor,action,id,JSON.stringify(detail),now());
 }
 get(id: string, user: User): Resource {
  const r = this.store.one<Resource>(select+' WHERE r.id=?',user.id,id);
  if (!r || !canRead(r,user)) throw new HTTPException(404,{message:'資料が見つかりません。'});
  return r;
 }
 view(r: Resource, user: User) {
  const { html_blob,preview_blob,source_metadata,tags,categories,...safe } = r;
  const source = JSON.parse(source_metadata);
  const md=this.store.one<{filename:string;bytes:number;updated_at:string}>('SELECT filename,bytes,updated_at FROM resource_markdown WHERE resource_id=?',r.id);
  const hasBody=!!this.store.one('SELECT resource_id FROM resource_search WHERE resource_id=? AND body<>?',r.id,'');
  const guide=this.store.one<{content:string}>('SELECT content FROM resource_reader_guides WHERE resource_id=?',r.id);
  const events=resourceEvents(this.store,r.id).map(e=>({...e,event_scope_name:e.event_scope_id?this.store.one<{name:string}>('SELECT name FROM event_scopes WHERE id=?',e.event_scope_id)?.name??null:null}));
  return {...safe,events,reader_guide:guide?JSON.parse(guide.content) as ReaderGuide:null,markdown:md?{...md,view_url:`/api/resources/${r.id}/markdown`,download_url:`/api/resources/${r.id}/markdown/download`}:null,has_search_body:hasBody||!!md,tags:JSON.parse(tags),categories:JSON.parse(categories??'[]'),is_saved:!!r.is_saved,can_edit:canEdit(r,user),has_html:!!html_blob,
   preview_image_url:`/api/resources/${r.id}/preview-image`,
   open_url:html_blob?`/preview/${r.id}`:r.url,
   file_count:source.file_manifest?.length??(html_blob?1:0),total_bytes:source.total_bytes??null,
   ...(user.role==='admin'?{source_metadata:source}:{})};
 }
 list(user: User, query: URLSearchParams) {
  ensureSearchIndex(this.store);
  let where=readable; const args:SQLInputValue[]=readArgs(user);
  const collection=query.get('collection');
  if(collection==='mine'){where+=' AND r.creator_id=?';args.push(user.id);}
  if(collection==='saved'){where+=' AND EXISTS(SELECT 1 FROM saved_resources s WHERE s.resource_id=r.id AND s.user_id=?)';args.push(user.id);}
  const category=query.get('category');if(category){where+=' AND EXISTS(SELECT 1 FROM resource_categories rc WHERE rc.resource_id=r.id AND rc.category_name=?)';args.push(category);}
  const events=query.getAll('event').filter(Boolean),scope=query.get('event_scope');
  if(events.length||scope){
   const choices=events.filter(e=>e!=='unclassified');
   let match='re.resource_id=r.id';const eventArgs:SQLInputValue[]=[];
   if(choices.length){match+=' AND re.event IN ('+choices.map(()=>'?').join(',')+')';eventArgs.push(...choices);}
   if(scope){match+=scope==='unclassified'?' AND re.event_scope_id IS NULL':' AND re.event_scope_id=?';if(scope!=='unclassified')eventArgs.push(scope);}
   const missing=events.includes('unclassified')?'NOT EXISTS(SELECT 1 FROM resource_events re WHERE re.resource_id=r.id)':'';
   if(choices.length||!missing){where+=' AND ('+'EXISTS(SELECT 1 FROM resource_events re WHERE '+match+')'+(missing?' OR '+missing:'')+')';args.push(...eventArgs);}
   else where+=' AND '+missing;
  }
  for(const [key,column] of [['department','department_id'],['edition','edition'],['kind','kind']] as const){
   const value=query.get(key);if(!value)continue;
   if(value==='unclassified')where+=` AND r.${column} IS NULL`;
   else {where+=` AND r.${column}=?`;args.push(value);}
  }
  const q=(query.get('q')??'').trim().slice(0,160);
  const groups=q?queryGroups(q):[];
  for(const group of groups){where+=' AND ('+group.map(()=>"idx.normalized_text LIKE ? ESCAPE '\\'").join(' OR ')+')';args.push(...group.map(likePattern));}
  for(const tag of query.getAll('tag').filter(Boolean)){where+=" AND EXISTS(SELECT 1 FROM json_each(r.tags) t WHERE lower(t.value)=?)";args.push(normalizeText(tag));}
  const total=Number(this.store.one<{n:number}>('SELECT COUNT(*) n FROM resources r JOIN users u ON u.id=r.creator_id LEFT JOIN resource_search idx ON idx.resource_id=r.id WHERE '+where,...args)?.n??0);
  const page=Math.max(1,Math.min(100000,Math.trunc(Number(query.get('page'))||1)));
  const size=Math.max(1,Math.min(100,Math.trunc(Number(query.get('page_size'))||20)));
  const rankArgs:SQLInputValue[]=[];
  const rank=groups.length&&query.get('sort')!=='name'?"CASE WHEN ("+groups[0].map(()=>"idx.normalized_title LIKE ? ESCAPE '\\'").join(' OR ')+") THEN 0 WHEN ("+groups[0].map(()=>"idx.normalized_summary LIKE ? ESCAPE '\\'").join(' OR ')+") THEN 1 ELSE 2 END,":'';
  if(rank)rankArgs.push(...groups[0].map(likePattern),...groups[0].map(likePattern));
  const order=rank+(query.get('sort')==='name'?'r.title COLLATE NOCASE ASC,r.id':'r.updated_at DESC,r.id');
  const rows=this.store.all<Resource>(select+' WHERE '+where+' ORDER BY '+order+' LIMIT ? OFFSET ?',user.id,...args,...rankArgs,size,(page-1)*size);
  return {items:rows.map(r=>{const item=this.view(r,user);if(!groups.length)return {...item,search_excerpt:undefined};const text=(this.store.one<{body:string}>('SELECT body FROM resource_search WHERE resource_id=?',r.id)?.body??'')+' '+(this.store.one<{search_text:string}>('SELECT search_text FROM resource_markdown WHERE resource_id=?',r.id)?.search_text??'');const match=groups.flat().map(w=>normalizeText(text).indexOf(w)).find(i=>i>=0);return {...item,search_excerpt:match!==undefined?text.slice(Math.max(0,match-35),match+150):undefined};}),total,page,page_size:size};
 }
 masters(user: User){
  const departments=this.store.all('SELECT d.id,d.name,COUNT(r.id) count FROM departments d LEFT JOIN resources r ON r.department_id=d.id AND '+readable+' GROUP BY d.id ORDER BY d.sort_order,d.name',...readArgs(user));
  const events=this.store.all('SELECT e.name,COUNT(r.id) count FROM event_series e LEFT JOIN resource_events re ON re.event=e.name LEFT JOIN resources r ON r.id=re.resource_id AND '+readable+' GROUP BY e.name ORDER BY e.sort_order',...readArgs(user));
  const event_scopes=this.store.all('SELECT s.id,s.event,s.name,COUNT(r.id) count FROM event_scopes s LEFT JOIN resource_events re ON re.event_scope_id=s.id LEFT JOIN resources r ON r.id=re.resource_id AND '+readable+' GROUP BY s.id ORDER BY s.event,s.sort_order,s.name',...readArgs(user));
  const editions=this.store.all('SELECT DISTINCT r.edition name,r.event FROM resources r WHERE '+readable+' AND r.edition IS NOT NULL ORDER BY r.edition',...readArgs(user));
  const categories=this.store.all('SELECT rc.category_name name,COUNT(r.id) count FROM resource_categories rc JOIN resources r ON r.id=rc.resource_id WHERE '+readable+' GROUP BY rc.category_name ORDER BY rc.category_name',...readArgs(user));
  return {departments,events,event_scopes,editions,categories,tags:this.tags(user)};
 }
 tags(user:User){
  const tags=new Map<string,{name:string;count:number}>();
  for(const r of this.store.all<{tags:string}>('SELECT r.tags FROM resources r WHERE '+readable+' ORDER BY r.created_at,r.id',...readArgs(user))){
   for(const tag of new Set<string>(JSON.parse(r.tags).map((t:string)=>cleanTag(t)))){const key=normalizeText(tag);if(!key)continue;const old=tags.get(key);if(old)old.count++;else tags.set(key,{name:tag,count:1});}
  }return [...tags.values()].sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'ja')).slice(0,100);
 }
 private canonicalTags(tags:string[],user:User){const known=new Map(this.tags(user).map(t=>[normalizeText(t.name),t.name]));const seen=new Set<string>();return tags.map(cleanTag).filter(t=>{const key=normalizeText(t);if(!key||seen.has(key))return false;seen.add(key);return true;}).map(t=>known.get(normalizeText(t))??t);}
 addEventScope(user:User,event:string,name:string){
  if(user.role!=='admin')throw new HTTPException(403);const choice=eventChoice(this.store,event,null);name=cleanTag(name);
  if(!choice.event||choice.event==='共通'||!name||name.length>60)throw new HTTPException(400,{message:'大会と60文字以内の子分類名を指定してください。'});
  const existing=this.store.all<{name:string}>('SELECT name FROM event_scopes WHERE event=?',choice.event);if(existing.some(s=>normalizeText(s.name)===normalizeText(name)))throw new HTTPException(409,{message:'同じ子分類が登録されています。'});
  const id=randomUUID();this.store.transaction(()=>{this.store.run('INSERT INTO event_scopes(id,event,name,sort_order) VALUES (?,?,?,?)',id,choice.event,name,existing.length);this.audit(user.id,'event-scope-add',null,{event:choice.event,name});});return {id,event:choice.event,name};
 }
 create(user: User, body: unknown, html?: {blob:string;filename:string;bytes:number;sha256:string;search_text?:string},markdown?:MarkdownAsset){
  const b=parseResource(body);const events=validateEvents(this.store,b.events??(b.event?[{event:b.event,event_scope_id:b.event_scope_id}]:[]));const choice=b.events!==undefined?{event:events[0]?.event??null,scope:events[0]?.event_scope_id??null}:eventChoice(this.store,b.event,b.event_scope_id??null),tags=this.canonicalTags(b.tags,user);
  if(b.markdown&&!markdown)throw new HTTPException(400,{message:'MDを添付できませんでした。'});
  if(b.creator_id&&b.creator_id!==user.id&&user.role!=='admin')throw new HTTPException(403,{message:'作成者の指定は管理者だけが行えます。'});
  const creator=b.creator_id??user.id; this.checkReferences(creator,b.department_id);
  if(!html&&!b.url)throw new HTTPException(400,{message:'URLまたはHTMLが必要です。'});
  const id=randomUUID(),date=now();
  this.store.transaction(()=>{
   this.store.run(`INSERT INTO resources(id,title,description,creator_id,registered_by,department_id,kind,event,edition,tags,url,status,visibility,access_request,html_blob,original_filename,source_metadata,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,b.title,b.description||markdown?.description||'',creator,user.id,b.department_id,b.kind,choice.event,b.edition||null,JSON.stringify(tags),b.url,html?'draft':b.status,b.visibility,b.access_request?1:0,html?.blob??null,html?.filename??null,JSON.stringify(html?{total_bytes:html.bytes,sha256:html.sha256}:{}),date,date);
   this.store.run('UPDATE resources SET event_scope_id=? WHERE id=?',choice.scope,id);
   saveEvents(this.store,id,events);
   if(markdown)saveMarkdown(this.store,id,markdown,user.id);
   indexResource(this.store,id,b.search_text??html?.search_text);
   this.audit(user.id,'create',id,{creator_id:creator,html:!!html,markdown:!!markdown});
  });return this.view(this.get(id,user),user);
 }
 update(id:string,user:User,body:unknown,markdown?:MarkdownAsset){
  const b=parseResource(body);const old=this.get(id,user);
  const legacy=eventChoice(this.store,b.event,b.event_scope_id===undefined?(b.event===old.event?old.event_scope_id:null):b.event_scope_id,old);
  const events=validateEvents(this.store,b.events??(legacy.event===old.event&&legacy.scope===old.event_scope_id?resourceEvents(this.store,id):legacy.event?[{event:legacy.event,event_scope_id:legacy.scope}]:[]));
  const choice=b.events!==undefined?{event:events[0]?.event??null,scope:events[0]?.event_scope_id??null}:legacy,tags=this.canonicalTags(b.tags,user);
  if(b.markdown&&!markdown)throw new HTTPException(400,{message:'MDを添付できませんでした。'});
  if(!canEdit(old,user))throw new HTTPException(403,{message:'作成者または管理者だけが編集できます。'});
  if(b.version!==old.version)throw new HTTPException(409,{message:'他の操作で更新されています。再読み込みしてください。'});
  const creator=b.creator_id??old.creator_id;
  if(creator!==old.creator_id&&user.role!=='admin')throw new HTTPException(403,{message:'作成者の変更は管理者だけが行えます。'});
  this.checkReferences(creator,b.department_id);
  if(!old.html_blob&&!b.url)throw new HTTPException(400,{message:'リンクURLが必要です。'});
  this.store.transaction(()=>{
   const result=this.store.run(`UPDATE resources SET title=?,description=?,creator_id=?,department_id=?,kind=?,event=?,edition=?,tags=?,url=?,status=?,visibility=?,access_request=?,updated_at=?,version=version+1 WHERE id=? AND version=?`,b.title,b.description||markdown?.description||'',creator,b.department_id,b.kind,choice.event,b.edition||null,JSON.stringify(tags),b.url,b.status,b.visibility,b.access_request?1:0,now(),id,b.version!);
   if(!result.changes)throw new HTTPException(409,{message:'更新が競合しました。再読み込みしてください。'});
   this.store.run('UPDATE resources SET event_scope_id=? WHERE id=?',choice.scope,id);
   saveEvents(this.store,id,events);
   if(markdown)saveMarkdown(this.store,id,markdown,user.id);
   indexResource(this.store,id,b.search_text);
   const {markdown:rawMarkdown,search_text:rawSearch,...auditInput}=b;
   this.audit(user.id,'update',id,{before:{creator_id:old.creator_id,department_id:old.department_id,status:old.status,visibility:old.visibility,version:old.version},after:auditInput,markdown:!!markdown,search_text_updated:rawSearch!==undefined});
  });return this.view(this.get(id,user),user);
 }
 setReaderGuide(id:string,user:User,body:unknown){
  const r=this.get(id,user);if(!canEdit(r,user))throw new HTTPException(403);
  const parsed=readerGuideUpdate.safeParse(body);if(!parsed.success)throw new HTTPException(400,{message:'使い始め方の入力内容を確認してください。'});
  const {version,guide}=parsed.data;if(version!==r.version)throw new HTTPException(409,{message:'他の操作で更新されています。再読み込みしてください。'});
  this.store.transaction(()=>{
   const changed=this.store.run('UPDATE resources SET version=version+1,updated_at=? WHERE id=? AND version=?',now(),id,version);if(!changed.changes)throw new HTTPException(409);
   this.store.run('INSERT INTO resource_reader_guides(resource_id,content,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET content=excluded.content,updated_by=excluded.updated_by,updated_at=excluded.updated_at',id,JSON.stringify(guide),user.id,now());
   indexResource(this.store,id);this.audit(user.id,'reader-guide-update',id,{status:guide.status});
  });return this.view(this.get(id,user),user);
 }
 private checkReferences(creator:string,department:string|null){
  if(!this.store.one('SELECT id FROM users WHERE id=? AND active=1',creator))throw new HTTPException(400,{message:'作成者が見つかりません。'});
  if(department&&!this.store.one('SELECT id FROM departments WHERE id=?',department))throw new HTTPException(400,{message:'セクションが見つかりません。'});
 }
 save(id:string,user:User,value:boolean){
  if(value){this.get(id,user);this.store.run('INSERT INTO saved_resources VALUES (?,?,?) ON CONFLICT DO NOTHING',user.id,id,now());}
  else this.store.run('DELETE FROM saved_resources WHERE user_id=? AND resource_id=?',user.id,id);
 }
 pickup(user:User){
  // Never recommend another person's draft/private metadata, even to an administrator.
  const rows=this.store.all<Resource>(select+` WHERE r.status='published' AND r.visibility='company' ORDER BY RANDOM() LIMIT 3`,user.id);
  return rows.map(r=>this.view(r,user));
 }

}
