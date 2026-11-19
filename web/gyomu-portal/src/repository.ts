import { randomUUID } from 'node:crypto';
import { commit, requireSql, type Database, type SqlValue, type Statement } from './database.js';
import { HTTPException } from 'hono/http-exception';
import { canEdit, now, type Resource, type User } from './model.js';
import { parseResource } from './validation.js';
import { cleanTag,normalizeText,queryGroups,searchIndex } from './discovery.js';
import { readerGuideUpdate,type ReaderGuide } from './reader.js';
import { type EventAssignment } from './events.js';
import { cleanImpact,parseStoredImpact,impactHeadline } from './impact.js';


type EventView = EventAssignment & { event_scope_name: string | null };
type CatalogRow = Resource & {
 event_json?: string;
 guide_json?: string | null;
 markdown_json?: string | null;
 has_body?: number;
};

const select = `SELECT r.*,u.name creator_name,u.email creator_email,d.name department_name,es.name event_scope_name,
 (SELECT json_group_array(category_name) FROM (SELECT category_name FROM resource_categories WHERE resource_id=r.id ORDER BY category_name)) categories,
 EXISTS(SELECT 1 FROM saved_resources s WHERE s.resource_id=r.id AND s.user_id=?) is_saved,
 (SELECT json_group_array(json_object('event',e.event,'event_scope_id',e.event_scope_id,'event_scope_name',e.name))
  FROM (SELECT re.event,re.event_scope_id,sc.name FROM resource_events re LEFT JOIN event_scopes sc ON sc.id=re.event_scope_id WHERE re.resource_id=r.id ORDER BY re.event) e) event_json,
 (SELECT content FROM resource_reader_guides WHERE resource_id=r.id) guide_json,
 (SELECT json_object('filename',filename,'bytes',bytes,'updated_at',updated_at) FROM resource_markdown WHERE resource_id=r.id) markdown_json,
 COALESCE(idx.body <> '',0) has_body
 FROM resources r JOIN users u ON u.id=r.creator_id LEFT JOIN departments d ON d.id=r.department_id
 LEFT JOIN event_scopes es ON es.id=r.event_scope_id LEFT JOIN resource_search idx ON idx.resource_id=r.id`;
export const readable = '(r.creator_id=? OR ?=1 OR (r.status=\'published\' AND r.visibility=\'company\'))';
export const readArgs = (u: User): SqlValue[] => [u.id, u.role==='admin'?1:0];

export function auditStatement(actor: string | null, action: string, id: string | null, detail: unknown): Statement {
 return ['INSERT INTO audit VALUES (?,?,?,?,?,?)',randomUUID(),actor,action,id,JSON.stringify(detail),now()];
}

const conflict = '他の操作で更新されています。再読み込みしてください。';
const eventAliases: Record<string,string> = {common:'共通','全社共通':'共通',jopt:'JOPT',spadie:'SPADIE','u-30':'U-30',u30:'U-30','战国':'戦国','jopt games':'JOPT GAMES'};
const primary = (events: EventView[]) => events[0] ?? null;

export class Catalog {
 constructor(readonly store: Database) {}

 audit(actor: string | null, action: string, id: string | null, detail: unknown) {
  const [sql,...parameters] = auditStatement(actor,action,id,detail);
  return this.store.run(sql,...parameters);
 }

 async get(id: string, user: User) {
  const row = await this.store.one<CatalogRow>(select+' WHERE r.id=? AND '+readable,user.id,id,...readArgs(user));
  if (!row) throw new HTTPException(404,{message:'資料が見つかりません。'});
  return row;
 }
 view(row: CatalogRow, user: User) {
  const {html_blob,preview_blob,source_metadata,tags,categories,impact:rawImpact,event_json,guide_json,markdown_json,has_body,...safe}=row;
  const r=row,impact=parseStoredImpact(rawImpact),source=JSON.parse(source_metadata);
  const md=markdown_json?JSON.parse(markdown_json) as {filename:string;bytes:number;updated_at:string}:null;
  const events=JSON.parse(event_json??'[]') as EventView[];
  return {...safe,impact,headline:impactHeadline(r.title,r.department_name,impact),events,reader_guide:guide_json?JSON.parse(guide_json) as ReaderGuide:null,markdown:md?{...md,view_url:`/api/resources/${r.id}/markdown`,download_url:`/api/resources/${r.id}/markdown/download`}:null,has_search_body:!!has_body||!!md,tags:JSON.parse(tags),categories:JSON.parse(categories??'[]'),is_saved:!!r.is_saved,can_edit:canEdit(r,user),has_html:!!html_blob,
   preview_image_url:`/api/resources/${r.id}/preview-image`,
   // A retained HTML copy is for preview/recovery; the registered URL is the primary entry.
   open_url:r.url??(html_blob?`/preview/${r.id}`:null),
   file_count:source.file_manifest?.length??(html_blob?1:0),total_bytes:source.total_bytes??null,
   ...(user.role==='admin'?{source_metadata:source}:{})};
 }
 async list(user: User, query: URLSearchParams) {
  let where=readable; const args:SqlValue[]=readArgs(user);
  const collection=query.get('collection');
  if(collection==='mine'){where+=' AND r.creator_id=?';args.push(user.id);}
  if(collection==='saved'){where+=' AND EXISTS(SELECT 1 FROM saved_resources s WHERE s.resource_id=r.id AND s.user_id=?)';args.push(user.id);}
  const category=query.get('category');if(category){where+=' AND EXISTS(SELECT 1 FROM resource_categories rc WHERE rc.resource_id=r.id AND rc.category_name=?)';args.push(category);}
  const events=query.getAll('event').filter(Boolean).slice(0,20),scope=query.get('event_scope');
  if(events.length||scope){
   const choices=events.filter(e=>e!=='unclassified');
   let match='re.resource_id=r.id';const eventArgs:SqlValue[]=[];
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
  for(const group of groups){where+=' AND ('+group.map(()=>"instr(idx.normalized_text, ?) > 0").join(' OR ')+')';args.push(...group);}
  for(const tag of query.getAll('tag').filter(Boolean).slice(0,20)){where+=" AND EXISTS(SELECT 1 FROM json_each(r.tags) t WHERE lower(t.value)=?)";args.push(normalizeText(tag));}
  const total=Number((await this.store.one<{n:number}>('SELECT COUNT(*) n FROM resources r JOIN users u ON u.id=r.creator_id LEFT JOIN resource_search idx ON idx.resource_id=r.id WHERE '+where,...args))?.n??0);
  const page=Math.max(1,Math.min(100000,Math.trunc(Number(query.get('page'))||1)));
  const size=Math.max(1,Math.min(100,Math.trunc(Number(query.get('page_size'))||20)));
  const rankArgs:SqlValue[]=[];
  const rank=groups.length&&query.get('sort')!=='name'?"CASE WHEN ("+groups[0].map(()=>"instr(idx.normalized_title, ?) > 0").join(' OR ')+") THEN 0 WHEN ("+groups[0].map(()=>"instr(idx.normalized_summary, ?) > 0").join(' OR ')+") THEN 1 ELSE 2 END,":'';
  if(rank)rankArgs.push(...groups[0],...groups[0]);
  const order=rank+(query.get('sort')==='name'?'r.title COLLATE NOCASE ASC,r.id':'r.updated_at DESC,r.id');
  const rows=await this.store.all<CatalogRow>(select+' WHERE '+where+' ORDER BY '+order+' LIMIT ? OFFSET ?',user.id,...args,...rankArgs,size,(page-1)*size);
  const searchBodies=groups.length&&rows.length?await this.store.all<{id:string;body:string|null;markdown:string|null}>(`
   SELECT idx.resource_id id,idx.body,m.search_text markdown FROM resource_search idx
   LEFT JOIN resource_markdown m ON m.resource_id=idx.resource_id
   WHERE idx.resource_id IN (SELECT value FROM json_each(?))`,JSON.stringify(rows.map(r=>r.id))):[];
  const bodies=new Map(searchBodies.map(r=>[r.id,[r.body,r.markdown].filter(Boolean).join(' ')]));
  return {items:rows.map(r=>{
   const item=this.view(r,user),text=bodies.get(r.id)??'';
   const normalized=normalizeText(text),match=groups.flat().map(word=>normalized.indexOf(word)).find(i=>i>=0);
   return {...item,search_excerpt:match===undefined?undefined:text.slice(Math.max(0,match-35),match+150)};
  }),total,page,page_size:size};
 }

 async masters(user: User){
  const args=readArgs(user);
  const [departments,events,event_scopes,editions,categories,tags]=await Promise.all([
   this.store.all<{id:string;name:string;count:number}>('SELECT d.id,d.name,COUNT(r.id) count FROM departments d LEFT JOIN resources r ON r.department_id=d.id AND '+readable+' GROUP BY d.id ORDER BY d.sort_order,d.name',...args),
   this.store.all<{name:string;count:number}>('SELECT e.name,COUNT(r.id) count FROM event_series e LEFT JOIN resource_events re ON re.event=e.name LEFT JOIN resources r ON r.id=re.resource_id AND '+readable+' GROUP BY e.name ORDER BY e.sort_order',...args),
   this.store.all<{id:string;event:string;name:string;count:number}>('SELECT s.id,s.event,s.name,COUNT(r.id) count FROM event_scopes s LEFT JOIN resource_events re ON re.event_scope_id=s.id LEFT JOIN resources r ON r.id=re.resource_id AND '+readable+' GROUP BY s.id ORDER BY s.event,s.sort_order,s.name',...args),
   this.store.all('SELECT DISTINCT r.edition name,r.event FROM resources r WHERE '+readable+' AND r.edition IS NOT NULL ORDER BY r.edition',...args),
   this.store.all('SELECT rc.category_name name,COUNT(r.id) count FROM resource_categories rc JOIN resources r ON r.id=rc.resource_id WHERE '+readable+' GROUP BY rc.category_name ORDER BY rc.category_name',...args),
   this.tags(user)
  ]);
  return {departments,events,event_scopes,editions,categories,tags};
 }

 async tags(user:User){
  const tags=new Map<string,{name:string;count:number}>();
  for(const r of await this.store.all<{tags:string}>('SELECT r.tags FROM resources r WHERE '+readable+' ORDER BY r.created_at,r.id',...readArgs(user))){
   for(const tag of new Set<string>(JSON.parse(r.tags).map((t:string)=>cleanTag(t)))){const key=normalizeText(tag);if(!key)continue;const old=tags.get(key);if(old)old.count++;else tags.set(key,{name:tag,count:1});}
  }return [...tags.values()].sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'ja')).slice(0,100);
 }
 private async canonicalTags(tags:string[],user:User){const known=new Map((await this.tags(user)).map(t=>[normalizeText(t.name),t.name]));const seen=new Set<string>();return tags.map(cleanTag).filter(t=>{const key=normalizeText(t);if(!key||seen.has(key))return false;seen.add(key);return true;}).map(t=>known.get(normalizeText(t))??t);}

 private async referenceData(creatorId:string,departmentId:string|null) {
  const [creator,department]=await Promise.all([
   this.store.one<{name:string;email:string}>('SELECT name,email FROM users WHERE id=? AND active=1',creatorId),
   departmentId?this.store.one<{name:string}>('SELECT name FROM departments WHERE id=?',departmentId):undefined
  ]);
  if(!creator)throw new HTTPException(400,{message:'作成者が見つかりません。'});
  if(departmentId&&!department)throw new HTTPException(400,{message:'セクションが見つかりません。'});
  return {creator,department:department?.name??null};
 }

 private async validateEvents(values:{event:string;event_scope_id?:string|null}[]) {
  if (!values.length) return [];
  const [series,scopes]=await Promise.all([
   this.store.all<{name:string}>('SELECT name FROM event_series'),
   this.store.all<{id:string;event:string;name:string}>('SELECT id,event,name FROM event_scopes')
  ]);
  const seen=new Set<string>();
  return values.map(({event,event_scope_id})=>{
   const name=eventAliases[normalizeText(event)]??event;
   if(!series.some(row=>row.name===name))throw new HTTPException(400,{message:'大会は一覧から選択してください。'});
   if(seen.has(name))throw new HTTPException(400,{message:'同じ大会は1回だけ選択してください。'});
   const scope=event_scope_id?scopes.find(s=>s.id===event_scope_id&&s.event===name):null;
   if(event_scope_id&&!scope)throw new HTTPException(400,{message:'開催地・季節と大会の組み合わせを確認してください。'});
   seen.add(name);
   return {event:name,event_scope_id:scope?.id??null,event_scope_name:scope?.name??null};
  });
 }

 private eventStatements(id:string,events: EventView[]): Statement[] {
  return events.map(e=>['INSERT INTO resource_events(resource_id,event,event_scope_id) VALUES (?,?,?)',id,e.event,e.event_scope_id]);
 }

 private versionGuard(id:string,version:number): Statement {
  return requireSql('EXISTS(SELECT 1 FROM resources WHERE id=? AND version=?)',id,version);
 }

 private async indexedText(row:CatalogRow){
  const text=await this.store.one<{body:string|null;markdown:string|null}>(`SELECT
   (SELECT body FROM resource_search WHERE resource_id=?) body,
   (SELECT search_text FROM resource_markdown WHERE resource_id=?) markdown`,row.id,row.id);
  const source=JSON.parse(row.source_metadata);
  return {body:text?.body??(typeof source.detail_text==='string'?source.detail_text:''),markdown:text?.markdown??''};
 }

 async addEventScope(user:User,event:string,name:string){
  if(user.role!=='admin')throw new HTTPException(403);
  const canonical=eventAliases[normalizeText(event)]??event;
  name=cleanTag(name);
  if(canonical==='共通'||!name||name.length>60||!await this.store.one('SELECT name FROM event_series WHERE name=?',canonical))
   throw new HTTPException(400,{message:'大会と60文字以内の子分類名を指定してください。'});
  const existing=await this.store.all<{id:string;name:string}>('SELECT id,name FROM event_scopes WHERE event=?',canonical);
  const duplicate='同じ子分類が登録されています。';
  if(existing.some(s=>normalizeText(s.name)===normalizeText(name)))throw new HTTPException(409,{message:duplicate});
  const id=randomUUID();
  await commit(this.store,[
   requireSql('(SELECT COUNT(*) FROM event_scopes WHERE event=?)=?',canonical,existing.length),
   ['INSERT INTO event_scopes(id,event,name,sort_order) VALUES (?,?,?,?)',id,canonical,name,existing.length],
   auditStatement(user.id,'event-scope-add',null,{event:canonical,name})
  ],duplicate);
  return {id,event:canonical,name};
 }

 // Build the record and its index together, so an MCP approval can commit them
 // in the same batch as the request's state transition.
 async prepareCreate(user: User, body: unknown){
  const b=parseResource(body);
  const creatorId=b.creator_id??user.id;
  if(creatorId!==user.id&&user.role!=='admin')throw new HTTPException(403,{message:'作成者の指定は管理者だけが行えます。'});
  if(b.events===undefined&&!b.event&&b.event_scope_id)throw new HTTPException(400,{message:'開催地・季節と大会の組み合わせを確認してください。'});
  const [{creator,department},events,tags]=await Promise.all([
   this.referenceData(creatorId,b.department_id),
   this.validateEvents(b.events??(b.event?[{event:b.event,event_scope_id:b.event_scope_id}]:[])),
   this.canonicalTags(b.tags,user)
  ]);
  const id=randomUUID(),date=now(),impact=cleanImpact(b.impact),first=primary(events);
  const row:CatalogRow={
   id,source_system:null,source_id:null,title:b.title,description:b.description,creator_id:creatorId,registered_by:user.id,
   department_id:b.department_id,department_name:department??undefined,kind:b.kind,event:first?.event??null,edition:b.edition||null,
   event_scope_id:first?.event_scope_id??null,event_scope_name:first?.event_scope_name??null,tags:JSON.stringify(tags),url:b.url,
   status:b.status,visibility:b.visibility,access_request:b.access_request?1:0,publisher_slack_id:null,preview_blob:null,html_blob:null,
   original_filename:null,source_metadata:'{}',version:1,created_at:date,updated_at:date,
   creator_name:creator.name,creator_email:creator.email,is_saved:0,impact:impact?JSON.stringify(impact):null,
   event_json:JSON.stringify([...events].sort((a,c)=>a.event.localeCompare(c.event))),has_body:b.search_text?1:0
  };
  const statements:Statement[]=[
   requireSql('EXISTS(SELECT 1 FROM users WHERE id=? AND active=1)',creatorId),
   [`INSERT INTO resources(id,title,description,creator_id,registered_by,department_id,kind,event,edition,tags,url,status,visibility,access_request,created_at,updated_at,event_scope_id,impact)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,row.title,row.description,creatorId,user.id,row.department_id,row.kind,row.event,row.edition,row.tags,row.url,row.status,row.visibility,row.access_request,date,date,row.event_scope_id,row.impact??null],
   ...this.eventStatements(id,events),
   searchIndex(id,{title:b.title,description:b.description,impact,creator:creator.name,email:creator.email,department,events:events.map(e=>({event:e.event,name:e.event_scope_name})),edition:row.edition,tags,categories:[],guide:null,body:b.search_text??'',markdown:''}),
   auditStatement(user.id,'create',id,{creator_id:creatorId})
  ];
  return {statements,view:this.view(row,user)};
 }

 async create(user:User,body:unknown){
  const {statements,view}=await this.prepareCreate(user,body);
  await commit(this.store,statements,conflict);
  return view;
 }

 async update(id:string,user:User,body:unknown){
  const b=parseResource(body),old=await this.get(id,user);
  if(!canEdit(old,user))throw new HTTPException(403,{message:'作成者または管理者だけが編集できます。'});
  if(b.version!==old.version)throw new HTTPException(409,{message:conflict});
  const creatorId=b.creator_id??old.creator_id;
  if(creatorId!==old.creator_id&&user.role!=='admin')throw new HTTPException(403,{message:'作成者の変更は管理者だけが行えます。'});
  const oldView=this.view(old,user);
  const scope=b.event_scope_id===undefined&&b.event===old.event?old.event_scope_id:b.event_scope_id??null;
  if(b.events===undefined&&!b.event&&scope)throw new HTTPException(400,{message:'開催地・季節と大会の組み合わせを確認してください。'});
  const event=b.event?(eventAliases[normalizeText(b.event)]??b.event):null;
  const selected=b.events??(event===old.event&&scope===old.event_scope_id?oldView.events:event?[{event,event_scope_id:scope}]:[]);
  const [{creator,department},events,tags,text]=await Promise.all([
   this.referenceData(creatorId,b.department_id),this.validateEvents(selected),this.canonicalTags(b.tags,user),this.indexedText(old)
  ]);
  const first=b.events===undefined&&event===old.event&&scope===old.event_scope_id?{event:old.event,event_scope_id:scope}:primary(events);
  const impact=b.impact===undefined?oldView.impact:cleanImpact(b.impact);
  const {search_text,...auditInput}=b;
  await commit(this.store,[
   this.versionGuard(id,b.version),
   requireSql('EXISTS(SELECT 1 FROM users WHERE id=? AND active=1)',creatorId),
   [`UPDATE resources SET title=?,description=?,creator_id=?,department_id=?,kind=?,event=?,edition=?,tags=?,url=?,status=?,visibility=?,access_request=?,updated_at=?,version=version+1,event_scope_id=?,impact=? WHERE id=?`,
    b.title,b.description,creatorId,b.department_id,b.kind,first?.event??null,b.edition||null,JSON.stringify(tags),b.url,b.status,b.visibility,b.access_request?1:0,now(),first?.event_scope_id??null,impact?JSON.stringify(impact):null,id],
   ['DELETE FROM resource_events WHERE resource_id=?',id],
   ...this.eventStatements(id,events),
   searchIndex(id,{title:b.title,description:b.description,impact,creator:creator.name,email:creator.email,department,events:events.map(e=>({event:e.event,name:e.event_scope_name})),edition:b.edition||null,tags,categories:oldView.categories,guide:oldView.reader_guide,body:search_text??text.body,markdown:text.markdown}),
   auditStatement(user.id,'update',id,{before:{creator_id:old.creator_id,department_id:old.department_id,status:old.status,visibility:old.visibility,version:old.version},after:auditInput,search_text_updated:search_text!==undefined})
  ],conflict);
  return this.view(await this.get(id,user),user);
 }

 async setReaderGuide(id:string,user:User,body:unknown){
  const row=await this.get(id,user);
  if(!canEdit(row,user))throw new HTTPException(403);
  const parsed=readerGuideUpdate.safeParse(body);
  if(!parsed.success)throw new HTTPException(400,{message:'使い始め方の入力内容を確認してください。'});
  const {version,guide}=parsed.data;
  if(version!==row.version)throw new HTTPException(409,{message:conflict});
  const view=this.view(row,user),text=await this.indexedText(row),date=now();
  await commit(this.store,[
   this.versionGuard(id,version),
   ['UPDATE resources SET version=version+1,updated_at=? WHERE id=?',date,id],
   [`INSERT INTO resource_reader_guides(resource_id,content,updated_by,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(resource_id) DO UPDATE SET content=excluded.content,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,id,JSON.stringify(guide),user.id,date],
   searchIndex(id,{title:row.title,description:row.description,impact:view.impact,creator:row.creator_name??'',email:row.creator_email??'',department:row.department_name??null,events:view.events.map(e=>({event:e.event,name:e.event_scope_name})),edition:row.edition,tags:view.tags,categories:view.categories,guide,...text}),
   auditStatement(user.id,'reader-guide-update',id,{status:guide.status})
  ],conflict);
  return this.view(await this.get(id,user),user);
 }

 async save(id:string,user:User,value:boolean){
  if(value){
   await this.get(id,user);
   await this.store.run('INSERT INTO saved_resources VALUES (?,?,?) ON CONFLICT DO NOTHING',user.id,id,now());
  }else{
   await this.store.run('DELETE FROM saved_resources WHERE user_id=? AND resource_id=?',user.id,id);
  }
 }

 async pickup(user:User){
  const rows=await this.store.all<CatalogRow>(select+` WHERE r.status='published' AND r.visibility='company' ORDER BY RANDOM() LIMIT 3`,user.id);
  return rows.map(r=>this.view(r,user));
 }

}
