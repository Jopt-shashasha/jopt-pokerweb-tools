import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {digest} from '../src/storage.js';

const root=resolve('D:/JOPT work/業務ポータル/旧ファイル/DROP/2026-11-17');
const backupRoot=resolve('D:/JOPT work/業務ポータル/既存資料バックアップ/2026-11-16');
const database=new DatabaseSync(resolve('.local/portal-local.sqlite'),{readOnly:true});
await mkdir(root,{recursive:true});
const docs=JSON.parse(await readFile(resolve(backupRoot,'drop/documents.json'),'utf8')) as any[];
const safeSegment=(s:string)=>s.replace(/[<>:"\\|?*\x00-\x1f]/g,c=>'%'+c.charCodeAt(0).toString(16).padStart(2,'0'));
const rows=[];
for(const doc of docs){
 const resource=database.prepare("SELECT id,html_blob,source_metadata FROM resources WHERE source_system='drop' AND source_id=?").get(doc.id) as {id:string;html_blob:string|null;source_metadata:string}|undefined;if(!resource)throw Error('Unmapped resource');
 const metadata=JSON.parse(resource.source_metadata);
 const files=[];
 for(const original of doc.files){
  const parts=String(original.path).split('/');if(parts.some(s=>!s||s==='.'||s==='..'))throw Error('Unsafe original path');
  const target=resolve(root,doc.id,...parts.map(safeSegment)),rel=relative(root,target);if(rel.startsWith('..')||isAbsolute(rel))throw Error('Path escapes archive');
  await mkdir(resolve(target,'..'),{recursive:true});
  if(!existsSync(target)){
   const saved=metadata.local_files?.find((f:any)=>f.path.endsWith('/'+original.path));
   const blob=original.path===doc.entry_path?resource.html_blob:null;
   const source=blob?resolve('.local/blobs',blob):saved?resolve(backupRoot,saved.path):null;
   if(source&&existsSync(source)){const bytes=await readFile(source);if(digest(bytes)===original.sha256&&bytes.length===original.size)await copyFile(source,target);}
  }
  const bytes=existsSync(target)?await readFile(target):null;
  const verified=!!bytes&&bytes.length===original.size&&digest(bytes)===original.sha256;
  const base=doc.shareUrl??doc.previewUrl;
  const url=base?new URL(parts.map(encodeURIComponent).join('/'),base.replace(/\/$/,'')+'/').href:null;
  files.push({path:original.path,target,url,bytes:original.size,sha256:original.sha256,status:verified?'verified':'pending'});
 }
 rows.push({source_id:doc.id,resource_id:resource.id,title:doc.title,creator_email:doc.owner_email,source_state:doc.state,source_visibility:doc.visibility,entry_path:doc.entry_path,files});
}
database.close();
const plan={version:1,archive_root:root,created_on:'2026-11-17',drive_folder_id:'12HMLARc9wYhOu2OyLmy1rvpTOIdxGLeo',documents:rows};
await writeFile(resolve(root,'download-plan.json'),JSON.stringify(plan,null,2));
console.log(JSON.stringify({documents:rows.length,files:rows.reduce((n,d)=>n+d.files.length,0),verified:rows.flatMap(d=>d.files).filter(f=>f.status==='verified').length,plan:resolve(root,'download-plan.json')}));
