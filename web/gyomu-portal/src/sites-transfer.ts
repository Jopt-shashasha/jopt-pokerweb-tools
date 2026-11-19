import { requireSql, type SqlValue, type Statement } from './database.js';

export const transferColumns = {
 departments: ['id','name','sort_order'],
 users: ['id','email','name','google_sub','department_id','role','active','created_at'],
 source_identities: ['source_system','source_id','user_id'],
 categories: ['name'],
 event_series: ['name','sort_order'],
 event_scopes: ['id','event','name','sort_order'],
 resources: ['id','source_system','source_id','title','description','creator_id','registered_by','department_id','kind','event','edition','tags','url','status','visibility','access_request','preview_blob','original_filename','source_metadata','version','created_at','updated_at','event_scope_id','impact'],
 saved_resources: ['user_id','resource_id','created_at'],
 resource_categories: ['resource_id','category_name'],
 resource_events: ['resource_id','event','event_scope_id'],
 resource_search: ['resource_id','body','normalized_text','normalized_title','normalized_summary','updated_at'],
 resource_markdown: ['resource_id','blob','filename','bytes','sha256','search_text','updated_by','updated_at'],
 resource_reader_guides: ['resource_id','content','updated_by','updated_at'],
 resource_generated_previews: ['resource_id','blob','content_key','kind','created_at']
} as const;
type Table = keyof typeof transferColumns;
type Row = Record<string,SqlValue>;
export type TransferObject = {id:string;size:number;sha256:string};
export type PortalTransfer = {version:1;tables:Record<Table,Row[]>;objects:TransferObject[]};
export const transferTables = Object.keys(transferColumns) as Table[];
export const transferMarker = 'migration.sites_catalog_v1';

export function referencedObjects(tables:PortalTransfer['tables']) {
 return new Set([
  ...tables.resources.map(row=>row.preview_blob),
  ...tables.resource_markdown.map(row=>row.blob),
  ...tables.resource_generated_previews.map(row=>row.blob)
 ].filter((value):value is string=>typeof value==='string'&&!!value));
}

function validate(snapshot:PortalTransfer) {
 if(snapshot.version!==1||!snapshot.tables||!Array.isArray(snapshot.objects))throw Error('Unsupported portal snapshot');
 for(const table of transferTables){
  const rows=snapshot.tables[table],columns=transferColumns[table];
  if(!Array.isArray(rows)||rows.some(row=>!row||columns.some(column=>{
   const value=row[column];
   return value!==null&&typeof value!=='string'&&(typeof value!=='number'||!Number.isFinite(value));
  })))throw Error('Invalid snapshot rows: '+table);
 }
 for(const row of snapshot.tables.resources){
  const url=typeof row.url==='string'&&URL.canParse(row.url)?new URL(row.url):null;
  if(!url||!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('Assign a valid source URL before migrating resource '+row.id);
 }
 const refs=referencedObjects(snapshot.tables);
 for(const item of snapshot.objects){
  if(!item||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(item.id)||
     !/^[a-f0-9]{64}$/.test(item.sha256)||!Number.isSafeInteger(item.size)||item.size<0||item.size>16*1024*1024||!refs.delete(item.id))throw Error('Invalid or duplicate attachment reference');
 }
 if(refs.size)throw Error('Snapshot is missing attachment references');
}
 
export function transferStatements(snapshot:PortalTransfer,manifestHash:string):Statement[] {
 validate(snapshot);
 if(!/^[a-f0-9]{64}$/.test(manifestHash))throw Error('Invalid snapshot hash');
 const statements:Statement[]=[
  requireSql("NOT EXISTS (SELECT 1 FROM resources) AND NOT EXISTS (SELECT 1 FROM users) AND NOT EXISTS (SELECT 1 FROM portal_settings WHERE key=?)",transferMarker)
 ];
 for(const table of transferTables){
  const columns=transferColumns[table];
  const fields=columns.map((_,index)=>"json_extract(value,'$["+index+"]')").join(',');
  const onDuplicate=table==='event_series'?' ON CONFLICT(name) DO UPDATE SET sort_order=excluded.sort_order':
   table==='event_scopes'?' ON CONFLICT(id) DO UPDATE SET event=excluded.event,name=excluded.name,sort_order=excluded.sort_order':'';
  const insert='INSERT INTO '+table+' ('+columns.join(',')+') SELECT '+fields+' FROM json_each(?) WHERE 1'+onDuplicate;
  let rows:string[]=[],size=2;
  for(const data of snapshot.tables[table]){
   const row=JSON.stringify(columns.map(column=>data[column]));
   const bytes=new TextEncoder().encode(row).length+1;
   if(size+bytes>96*1024&&rows.length){statements.push([insert,'['+rows.join(',')+']']);rows=[];size=2;}
   rows.push(row);size+=bytes;
  }
  if(rows.length)statements.push([insert,'['+rows.join(',')+']']);
 }
 statements.push(['INSERT INTO portal_settings(key,value,updated_at) VALUES (?,?,?)',transferMarker,manifestHash,new Date().toISOString()]);
 return statements;
}

