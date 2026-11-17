import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { resolve,relative,isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './db.js';
import { digest } from './storage.js';
import { imageType,httpUrl } from './validation.js';
import type { BlobStore } from './storage.js';
import { now } from './model.js';

interface ImportedEntry {source_system:string;source_id:string;title:string;creator_email:string;creator_source_id:string;source_publication_status:string;source_visibility:string;source_created_at:number;source_updated_at:number;target_url:string|null;local_files:{path:string;sha256:string}[];file_manifest:unknown[];[key:string]:unknown}
export async function importDrop(store:Store,blobs:BlobStore,backupPath:string,reportDir:string){
 const root=resolve(backupPath);
 const safePath=(p:string)=>{const file=resolve(root,p),rel=relative(root,file);if(rel.startsWith('..')||isAbsolute(rel))throw Error('Backup path escapes root');return file;};
 const data=JSON.parse(await readFile(safePath('移行用データ.json'),'utf8'));
 if(data.schema_version!==1||!Array.isArray(data.entries)||!Array.isArray(data.creators))throw Error('Unsupported backup schema');
 const entries:ImportedEntry[]=data.entries.filter((e:ImportedEntry)=>e.source_system==='drop');
 if(!entries.length)throw Error('No drop records');
 if(new Set(entries.map(e=>e.source_id)).size!==entries.length)throw Error('Duplicate source IDs');
 const departments=JSON.parse(await readFile(safePath('aifact/departments.json'),'utf8')) as {id:string;name:string}[];
 const profiles=JSON.parse(await readFile(safePath('aifact/creator-profiles.json'),'utf8')) as {email:string;department_id:string;full_name:string}[];
 const createdBlobs:string[]=[];const prepared=new Map<string,{html:string|null;image:string|null}>();
 let committed=false;
 try{
  // Validate and stage file bytes before changing ownership or catalogue rows.
  for(const e of entries){
   if(!/^[a-f0-9]{32}$/.test(e.source_id)||typeof e.title!=='string'||!e.title.trim()||e.title.length>160||typeof e.creator_email!=='string'||!e.creator_email.includes('@')||typeof e.creator_source_id!=='string')throw Error('Invalid source record');
   if(e.target_url)httpUrl.parse(e.target_url);
   if(!['shared','draft'].includes(e.source_publication_status)||!['public','private'].includes(e.source_visibility))throw Error('Unknown source visibility/state');
   if(store.one('SELECT id FROM resources WHERE source_system=? AND source_id=?','drop',e.source_id))continue;
   let html:string|null=null,image:string|null=null;
   for(const f of e.local_files??[]){const bytes=await readFile(safePath(f.path));if(digest(bytes)!==f.sha256)throw Error('Backup checksum mismatch');if(html)throw Error('Multi-file local restore requires a folder storage adapter');html=await blobs.put(bytes);createdBlobs.push(html);}
   if(e.source_publication_status==='draft'&&!html)throw Error('Draft has no local HTML');
   const group=data.duplicate_candidates?.find((g:any)=>g.entries.some((x:any)=>x.source_system==='drop'&&x.source_id===e.source_id));
   const otherId=group?.entries.find((x:any)=>x.source_system==='aifact')?.source_id;
   const other=data.entries.find((x:any)=>x.source_system==='aifact'&&x.source_id===otherId);
   if(other?.local_preview_image&&other.target_url&&e.target_url&&new URL(other.target_url).origin===new URL(e.target_url).origin){const bytes=await readFile(safePath(other.local_preview_image));if(imageType(bytes)&&bytes.length<=5*1024*1024){image=await blobs.put(bytes);createdBlobs.push(image);}}
   prepared.set(e.source_id,{html,image});
  }
  let inserted=0,skipped=0;
  store.transaction(()=>{
   for(let i=0;i<departments.length;i++){const d=departments[i];store.run('INSERT INTO departments VALUES (?,?,?) ON CONFLICT(id) DO NOTHING',d.id,d.name,i);}
   for(const e of entries){
    if(store.one('SELECT id FROM resources WHERE source_system=? AND source_id=?','drop',e.source_id)){skipped++;continue;}
    let user=store.one<{id:string;google_sub:string|null}>('SELECT id,google_sub FROM users WHERE email=?',e.creator_email);
    if(!user){const profile=profiles.find(p=>p.email.toLowerCase()===e.creator_email.toLowerCase());const id=randomUUID();store.run('INSERT INTO users(id,email,name,google_sub,department_id,created_at) VALUES (?,?,?,?,?,?)',id,e.creator_email,profile?.full_name??e.creator_email,e.creator_source_id,profile?.department_id??null,now());user={id,google_sub:e.creator_source_id};}
    else if(user.google_sub&&user.google_sub!==e.creator_source_id)throw Error('Conflicting Google subject for source creator');
    if(!user.google_sub)store.run('UPDATE users SET google_sub=? WHERE id=?',e.creator_source_id,user.id);
    const old=store.one<{user_id:string}>('SELECT user_id FROM source_identities WHERE source_system=? AND source_id=?','drop',e.creator_source_id);
    if(old&&old.user_id!==user.id)throw Error('Conflicting source identity');
    store.run('INSERT INTO source_identities VALUES (?,?,?) ON CONFLICT DO NOTHING','drop',e.creator_source_id,user.id);
    const p=prepared.get(e.source_id)!;
    const state=e.source_publication_status==='shared'?'published':'draft';
    const visibility=state==='published'&&e.source_visibility==='public'?'company':'private';
    const id=randomUUID();
    store.run(`INSERT INTO resources(id,source_system,source_id,title,creator_id,url,status,visibility,html_blob,preview_blob,original_filename,source_metadata,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,'drop',e.source_id,e.title,user.id,e.target_url,state,visibility,p.html,p.image,String(e.entry_path??''),JSON.stringify(e),new Date(e.source_created_at*1000).toISOString(),new Date(e.source_updated_at*1000).toISOString());inserted++;
   }
   store.run('INSERT INTO audit VALUES (?,?,?,?,?,?)',randomUUID(),null,'import-drop',null,JSON.stringify({backup:root,inserted,skipped,source_exported_at:data.exported_at,classification:'Not inferred'}),now());
  });
  committed=true;
  const rows=store.all<{id:string;source_id:string;title:string;email:string;status:string;visibility:string}>(`SELECT r.id,r.source_id,r.title,u.email,r.status,r.visibility FROM resources r JOIN users u ON u.id=r.creator_id WHERE r.source_system='drop' AND r.department_id IS NULL ORDER BY r.title`);
  const duplicates=store.all<{title:string;count:number}>('SELECT title,COUNT(*) count FROM resources GROUP BY title HAVING COUNT(*)>1');
  await mkdir(reportDir,{recursive:true});
  await writeFile(resolve(reportDir,'classification-review.json'),JSON.stringify({inserted,skipped,unclassified:rows.length,source_duplicate_candidates:data.duplicate_candidates,same_titles:duplicates,items:rows},null,2));
  const safe=(s:string)=>s.replaceAll('|','／').replace(/[\r\n]/g,' ');
  await writeFile(resolve(reportDir,'分類整理が必要な資料.md'),`# drop移行・分類レビュー\n\n追加 ${inserted}件、既存のためスキップ ${skipped}件。セクション未分類 ${rows.length}件。\n\n元dropにはセクション・大会・開催回・資料/ツール種別・用途説明の項目がありません。アップロード者の所属や資料名から分類を推定していません。大会・開催回は任意項目です。\n\n同名資料：${duplicates.map(d=>safe(d.title)+'（'+d.count+'件）').join('、')||'なし'}。別ID・別URLを維持し、自動統合していません。AIFACTとの同一dropリンク候補は元バックアップのduplicate_candidatesに保持しています。\n\n| 資料名 | 元アップロード者 | 状態 | 元ID |\n| --- | --- | --- | --- |\n${rows.map(r=>`| ${safe(r.title)} | ${r.email} | ${r.status} / ${r.visibility} | ${r.source_id} |`).join('\n')}\n`);
  return {inserted,skipped,total:entries.length,unclassified:rows.length,local_html:prepared.size?[...prepared.values()].filter(p=>p.html).length:0};
 }catch(e){if(!committed)for(const id of createdBlobs)await blobs.remove(id);throw e;}
}
