import {DatabaseSync,backup} from 'node:sqlite';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../src/db.js';
import {LocalBlobs,digest} from '../src/storage.js';
import {Catalog} from '../src/repository.js';
import {indexResource} from '../src/discovery.js';
import type {Resource} from '../src/model.js';

const path=resolve('.local/portal-local.sqlite'),reportPath=resolve('.local/reports/drive-migration-20261117.json');
const input=JSON.parse(await readFile(reportPath,'utf8')) as {records:{resource_id:string;source_id:string;title:string;path:string;filename:string;sha256:string;bytes:number;drive_file_id:string;drive_url:string;uploaded:boolean;readback_verified:boolean;artifact_type?:'folder-zip';entry_filename?:string;entry_path?:string;original_files?:{filename:string;path:string;bytes:number;sha256:string}[]}[]};
const apply=process.argv.includes('--apply'),snapshot=resolve('.local/backups/before-drive-link-migration-20261117.sqlite');
if(apply){await mkdir(resolve('.local/backups'),{recursive:true});if(!existsSync(snapshot)){const source=new DatabaseSync(path,{readOnly:true});await backup(source,snapshot);source.close();}}
const store=new Store(path),catalog=new Catalog(store),blobs=new LocalBlobs(resolve('.local/blobs'));
const normalizeLink=(value:string)=>{const u=new URL(value);u.hash='';return u.href;};
try{
 const plan:Array<{row:(typeof input.records)[number];r:Resource;previewBlob:string|null}>=[];const seen=new Set<string>();
 const originalLinks=new Map<string,(typeof input.records)[number]|null>();
 for(const row of input.records){
  if(seen.has(row.resource_id))throw Error('Duplicate migration resource');seen.add(row.resource_id);
  const url=new URL(row.drive_url);if(url.origin!=='https://drive.google.com'||url.pathname!==`/file/d/${row.drive_file_id}/view`||!row.uploaded||!row.readback_verified)throw Error('Unverified Drive upload');
  const r=store.one<Resource>('SELECT * FROM resources WHERE id=?',row.resource_id);
  if(!r||r.source_system!=='drop'||r.source_id!==row.source_id||r.title!==row.title)throw Error('Migration mapping differs from source');
  const source=JSON.parse(r.source_metadata);
  // Match source URLs and their recorded entry path, never names or guessed aliases.
  for(const base of [source.target_url,source.preview_url].filter((v:unknown):v is string=>typeof v==='string'&&!!v)){
   const links=[normalizeLink(base)];if(source.entry_path)links.push(normalizeLink(new URL(source.entry_path,base.replace(/\/$/,'')+'/').href));
   for(const link of links){const prior=originalLinks.get(link);if(!originalLinks.has(link))originalLinks.set(link,row);else if(prior?.drive_url!==row.drive_url)originalLinks.set(link,null);}
  }
  if(r.url===row.drive_url&&!r.html_blob)continue;
  const bytes=await readFile(row.path);if(bytes.length!==row.bytes||digest(bytes)!==row.sha256)throw Error('Archived file changed after upload');
  let previewBytes=bytes;
  if(row.artifact_type==='folder-zip'){
   const files=row.original_files;
   if(!files||files.length!==source.file_manifest.length||new Set(files.map(f=>f.filename)).size!==files.length||!row.entry_filename||!row.entry_path)throw Error('Incomplete folder archive');
   for(const original of source.file_manifest as {path:string;sha256:string;size:number}[]){
    const saved=files.find(f=>f.filename===original.path&&f.bytes===original.size&&f.sha256===original.sha256);if(!saved)throw Error('Folder manifest differs from original');
    const content=await readFile(saved.path);if(content.length!==saved.bytes||digest(content)!==saved.sha256)throw Error('Original folder file changed');
   }
   if(!files.some(f=>f.filename===row.entry_filename&&f.path===row.entry_path))throw Error('Archive entry differs');
   previewBytes=await readFile(row.entry_path);
  }else{
   const file=source.file_manifest?.find((f:{path:string;sha256:string;size:number})=>f.path===row.filename&&f.sha256===row.sha256&&f.size===row.bytes);
   if(!file||source.file_manifest.length!==1)throw Error('Only complete original files can be relinked');
  }
  let previewBlob=r.html_blob;if(!previewBlob&&!store.one('SELECT resource_id FROM resource_preview_inputs WHERE resource_id=?',r.id))previewBlob=await blobs.put(previewBytes);
  plan.push({row,r,previewBlob});
 }
 const aliases:Array<{r:Resource;row:(typeof input.records)[number]}>=[];
 for(const r of store.all<Resource>("SELECT * FROM resources WHERE source_system='aifact' AND url IS NOT NULL")){
  const row=originalLinks.get(normalizeLink(r.url!));if(row&&!r.html_blob&&r.url!==row.drive_url)aliases.push({r,row});
 }
 if(apply)store.transaction(()=>{for(const {row,r,previewBlob} of plan){
  if(previewBlob)store.run('INSERT INTO resource_preview_inputs(resource_id,blob,filename,sha256) VALUES (?,?,?,?) ON CONFLICT(resource_id) DO NOTHING',r.id,previewBlob,row.entry_filename??row.filename,row.artifact_type==='folder-zip'?row.original_files!.find(f=>f.filename===row.entry_filename)!.sha256:row.sha256);
  const changed=store.run('UPDATE resources SET url=?,html_blob=NULL,version=version+1 WHERE id=? AND version=?',row.drive_url,r.id,r.version);if(!changed.changes)throw Error('Resource changed while relinking');
  indexResource(store,r.id);catalog.audit(null,'migrate-drop-to-drive',r.id,{original_url:r.url,drive_url:row.drive_url,drive_file_id:row.drive_file_id,sha256:row.sha256,original_metadata_preserved:true});
 }for(const {r,row} of aliases){
  const changed=store.run('UPDATE resources SET url=?,version=version+1 WHERE id=? AND version=?',row.drive_url,r.id,r.version);if(!changed.changes)throw Error('Linked resource changed while relinking');
  indexResource(store,r.id);catalog.audit(null,'migrate-linked-drop-to-drive',r.id,{original_url:r.url,drive_url:row.drive_url,drop_source_id:row.source_id,original_metadata_preserved:true});
 }});
 const report={applied:apply,updated:plan.length+aliases.length,linked_aifact:aliases.length,snapshot:apply?snapshot:null,items:[...plan.map(({row})=>({id:row.resource_id,title:row.title,url:row.drive_url})),...aliases.map(({r,row})=>({id:r.id,title:r.title,url:row.drive_url}))]};
 if(apply)await writeFile(reportPath.replace('.json','-applied.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({applied:apply,updated:report.updated,linked_aifact:aliases.length,snapshot:report.snapshot}));
}finally{store.close();}
