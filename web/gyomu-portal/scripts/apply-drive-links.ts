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
const input=JSON.parse(await readFile(reportPath,'utf8')) as {records:{resource_id:string;source_id:string;title:string;path:string;filename:string;sha256:string;bytes:number;drive_file_id:string;drive_url:string;uploaded:boolean;readback_verified:boolean}[]};
const apply=process.argv.includes('--apply'),snapshot=resolve('.local/backups/before-drive-link-migration-20261117.sqlite');
if(apply){await mkdir(resolve('.local/backups'),{recursive:true});if(!existsSync(snapshot)){const source=new DatabaseSync(path,{readOnly:true});await backup(source,snapshot);source.close();}}
const store=new Store(path),catalog=new Catalog(store),blobs=new LocalBlobs(resolve('.local/blobs'));
try{
 const plan:Array<{row:(typeof input.records)[number];r:Resource;previewBlob:string|null}>=[];const seen=new Set<string>();
 for(const row of input.records){
  if(seen.has(row.resource_id))throw Error('Duplicate migration resource');seen.add(row.resource_id);
  const url=new URL(row.drive_url);if(url.origin!=='https://drive.google.com'||url.pathname!==`/file/d/${row.drive_file_id}/view`||!row.uploaded||!row.readback_verified)throw Error('Unverified Drive upload');
  const r=store.one<Resource>('SELECT * FROM resources WHERE id=?',row.resource_id);
  if(!r||r.source_system!=='drop'||r.source_id!==row.source_id||r.title!==row.title)throw Error('Migration mapping differs from source');
  if(r.url===row.drive_url&&!r.html_blob)continue;
  const source=JSON.parse(r.source_metadata),file=source.file_manifest?.find((f:{path:string;sha256:string;size:number})=>f.path===row.filename&&f.sha256===row.sha256&&f.size===row.bytes);
  if(!file||source.file_manifest.length!==1)throw Error('Only complete original single HTML files can be relinked');
  const bytes=await readFile(row.path);if(bytes.length!==row.bytes||digest(bytes)!==row.sha256)throw Error('Archived file changed after upload');
  let previewBlob=r.html_blob;if(!previewBlob&&!store.one('SELECT resource_id FROM resource_preview_inputs WHERE resource_id=?',r.id))previewBlob=await blobs.put(bytes);
  plan.push({row,r,previewBlob});
 }
 if(apply)store.transaction(()=>{for(const {row,r,previewBlob} of plan){
  if(previewBlob)store.run('INSERT INTO resource_preview_inputs(resource_id,blob,filename,sha256) VALUES (?,?,?,?) ON CONFLICT(resource_id) DO NOTHING',r.id,previewBlob,row.filename,row.sha256);
  const changed=store.run('UPDATE resources SET url=?,html_blob=NULL,version=version+1 WHERE id=? AND version=?',row.drive_url,r.id,r.version);if(!changed.changes)throw Error('Resource changed while relinking');
  indexResource(store,r.id);catalog.audit(null,'migrate-drop-to-drive',r.id,{original_url:r.url,drive_url:row.drive_url,drive_file_id:row.drive_file_id,sha256:row.sha256,original_metadata_preserved:true});
 }});
 const report={applied:apply,updated:plan.length,snapshot:apply?snapshot:null,items:plan.map(({row})=>({id:row.resource_id,title:row.title,url:row.drive_url}))};
 if(apply)await writeFile(reportPath.replace('.json','-applied.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({applied:apply,updated:plan.length,snapshot:report.snapshot}));
}finally{store.close();}
