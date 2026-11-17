import {DatabaseSync,backup} from 'node:sqlite';
import {mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../src/db.js';
import {LocalBlobs,digest} from '../src/storage.js';
import {Catalog} from '../src/repository.js';
import {htmlText,indexResource} from '../src/discovery.js';

const apply=process.argv.includes('--apply'),file=resolve('.local/portal-local.sqlite');
const snapshot=resolve('.local/backups/before-drop-file-restore-20261117.sqlite');
if(apply){await mkdir(resolve('.local/backups'),{recursive:true});if(!existsSync(snapshot)){const source=new DatabaseSync(file,{readOnly:true});await backup(source,snapshot);source.close();}}
const store=new Store(file),blobs=new LocalBlobs(resolve('.local/blobs')),catalog=new Catalog(store);
try{
 const candidates=store.all<{id:string;title:string;version:number;source_metadata:string;blob:string;filename:string;sha256:string}>(`SELECT r.id,r.title,r.version,r.source_metadata,p.blob,p.filename,p.sha256 FROM resources r JOIN resource_preview_inputs p ON p.resource_id=r.id WHERE r.source_system='drop' AND r.html_blob IS NULL`);
 const ready:Array<(typeof candidates)[number]&{bytes:number;body:string}>=[];
 for(const row of candidates){const metadata=JSON.parse(row.source_metadata),manifest=metadata.file_manifest;
  if(!Array.isArray(manifest)||manifest.length!==1||manifest[0].path!==metadata.entry_path||!/\.html?$/i.test(metadata.entry_path))throw Error('Original entry is not a verified single HTML file: '+row.id);
  const bytes=await blobs.get(row.blob),sha=digest(bytes);
  if(sha!==row.sha256||sha!==manifest[0].sha256||bytes.byteLength!==manifest[0].size)throw Error('Original file checksum/size mismatch: '+row.id);
  ready.push({...row,bytes:bytes.byteLength,body:htmlText(Buffer.from(bytes).toString('utf8'))});
 }
 if(apply)store.transaction(()=>{for(const row of ready){
  const changed=store.run('UPDATE resources SET html_blob=?,version=version+1 WHERE id=? AND version=? AND html_blob IS NULL',row.blob,row.id,row.version);
  if(!changed.changes)throw Error('Resource changed while restoring: '+row.id);indexResource(store,row.id,row.body);catalog.audit(null,'restore-verified-drop-entry',row.id,{sha256:row.sha256,bytes:row.bytes,original_url_preserved:true});
 }});
 const report={applied:apply,snapshot:apply?snapshot:null,restored:ready.map(({id,title,sha256,bytes})=>({id,title,sha256,bytes})),status:store.one('SELECT COUNT(*) total,SUM(html_blob IS NOT NULL) local_html FROM resources WHERE source_system=?','drop')};
 if(apply){await mkdir(resolve('.local/reports'),{recursive:true});await writeFile(resolve('.local/reports/drop-file-restore-20261117.json'),JSON.stringify(report,null,2));}console.log(JSON.stringify(report,null,2));
}finally{store.close();}
