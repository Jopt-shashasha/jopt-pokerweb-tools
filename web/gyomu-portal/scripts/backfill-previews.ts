import {DatabaseSync,backup} from 'node:sqlite';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../src/db.js';
import {LocalBlobs,digest} from '../src/storage.js';
import {LocalPreviewRenderer} from '../src/preview-renderer.js';
import {Previews} from '../src/previews.js';
import type {Resource} from '../src/model.js';

if(!process.argv.includes('--apply')){console.log('Use --apply [--proposal-file <verified original HTML>] to generate thumbnails from saved files.');process.exit(0);}
const dbPath=resolve('.local/portal-local.sqlite'),snapshot=resolve('.local/backups/before-file-previews-20261117.sqlite');
await mkdir(resolve('.local/backups'),{recursive:true});if(!existsSync(snapshot)){const db=new DatabaseSync(dbPath,{readOnly:true});await backup(db,snapshot);db.close();}
const store=new Store(dbPath),blobs=new LocalBlobs(resolve('.local/blobs')),service=new Previews(store,blobs,new LocalPreviewRenderer());
try{
 const fileFlag=process.argv.indexOf('--proposal-file');
 if(fileFlag>=0){
  const path=process.argv[fileFlag+1];if(!path)throw Error('Missing proposal file');
  const r=store.one<Resource>('SELECT * FROM resources WHERE source_system=? AND source_id=?','drop','8b9ed0c252084905bd166f81aad31915');if(!r)throw Error('Proposal missing');
  const bytes=new Uint8Array(await readFile(resolve(path))),sha=digest(bytes),metadata=JSON.parse(r.source_metadata);
  if(bytes.byteLength>5*1024*1024||!metadata.file_manifest.some((f:{sha256:string})=>f.sha256===sha))throw Error('Preview source differs from the original DROP file');
  const old=store.one<{sha256:string}>('SELECT sha256 FROM resource_preview_inputs WHERE resource_id=?',r.id);
  if(old?.sha256!==sha){const blob=await blobs.put(bytes);try{store.run('INSERT INTO resource_preview_inputs(resource_id,blob,filename,sha256) VALUES (?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET blob=excluded.blob,filename=excluded.filename,sha256=excluded.sha256',r.id,blob,'業務ポータル_企画書_第1-4章.html',sha);}catch(e){await blobs.remove(blob);throw e;}}
 }
 const rows=store.all<Resource>('SELECT r.* FROM resources r WHERE preview_blob IS NULL AND (html_blob IS NOT NULL OR EXISTS(SELECT 1 FROM resource_preview_inputs i WHERE i.resource_id=r.id) OR EXISTS(SELECT 1 FROM resource_markdown m WHERE m.resource_id=r.id))');
 const report=[];for(const r of rows){const image=await service.get(r);report.push({title:r.title,generated:!!image,bytes:image?.byteLength??0});if(!image)process.exitCode=1;}
 await mkdir(resolve('.local/reports'),{recursive:true});await writeFile(resolve('.local/reports/preview-generation-20261117.json'),JSON.stringify({snapshot,report},null,2));console.log(JSON.stringify(report,null,2));
}finally{store.close();}
