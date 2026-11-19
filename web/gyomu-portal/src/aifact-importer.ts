import { readFile,mkdir,writeFile } from 'node:fs/promises';
import { resolve,relative,isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './db.js';
import { digest,type BlobStore } from './storage.js';
import { httpUrl,imageType } from './validation.js';
import { now } from './model.js';
import { indexResource } from './discovery.js';

type Entry={source_system:'aifact';source_id:string;title:string;creator_email:string;creator_source_id:string;creator_name:string;department:{id:string|null;name:string}|null;categories:string[];description:string;target_url:string;source_publication_status:string;source_visibility:null;source_created_at:string;source_updated_at:string;local_preview_image:string;preview_image_sha256:string};
const dateOnly=(value:string)=>{if(!/^\d{4}\/\d{2}\/\d{2}$/.test(value))throw Error('Unsupported AIFACT source date');const iso=value.replaceAll('/','-'),date=new Date(iso+'T00:00:00Z');if(date.toISOString().slice(0,10)!==iso)throw Error('Invalid AIFACT date');return iso;};

export async function importAifact(store:Store,blobs:BlobStore,backupPath:string,reportDir:string){
 const root=resolve(backupPath),safePath=(p:string)=>{const file=resolve(root,p),rel=relative(root,file);if(rel.startsWith('..')||isAbsolute(rel))throw Error('Backup path escapes root');return file;};
 const data=JSON.parse(await readFile(safePath('移行用データ.json'),'utf8'));
 if(data.schema_version!==1||!Array.isArray(data.entries))throw Error('Unsupported backup schema');
 const entries:Entry[]=data.entries.filter((e:Entry)=>e.source_system==='aifact');if(!entries.length||new Set(entries.map(e=>e.source_id)).size!==entries.length)throw Error('Missing or duplicate AIFACT source IDs');
 const profiles=JSON.parse(await readFile(safePath('aifact/creator-profiles.json'),'utf8')) as {id:string;email:string;full_name:string;department_id:string|null}[];
 const departments=JSON.parse(await readFile(safePath('aifact/departments.json'),'utf8')) as {id:string;name:string}[];
 const staged=new Map<string,string>(),createdBlobs:string[]=[];let committed=false;
 try{
  for(const e of entries){
   if(!/^[a-f0-9-]{36}$/.test(e.source_id)||!e.title?.trim()||e.title.length>160||typeof e.description!=='string'||e.description.length>12000||!Array.isArray(e.categories)||e.categories.some(c=>typeof c!=='string'||!c.trim()||c.length>100))throw Error('Invalid AIFACT record');
   if(e.source_publication_status!=='公開中'||e.source_visibility!==null)throw Error('Unsupported AIFACT visibility; review before importing');
   const p=profiles.find(p=>p.id===e.creator_source_id&&p.email?.toLowerCase()===e.creator_email?.toLowerCase());if(!p||!p.email.includes('@'))throw Error('Creator mapping is not backed by a source profile');
   const department=e.department;if(department?.id&&!departments.some(d=>d.id===department.id&&d.name===department.name))throw Error('Unknown source department');
   httpUrl.parse(e.target_url);dateOnly(e.source_created_at);dateOnly(e.source_updated_at);
   if(store.one('SELECT id FROM resources WHERE source_system=? AND source_id=?','aifact',e.source_id))continue;
   const bytes=await readFile(safePath(e.local_preview_image));if(digest(bytes)!==e.preview_image_sha256)throw Error('AIFACT preview checksum mismatch');
   if(!imageType(bytes)||bytes.length>5*1024*1024)throw Error('Unsupported AIFACT preview image');
   const id=await blobs.put(bytes);staged.set(e.source_id,id);createdBlobs.push(id);
  }
  let inserted=0,skipped=0;
  store.transaction(()=>{
   for(let i=0;i<departments.length;i++){
    const d=departments[i],old=store.one<{name:string}>('SELECT name FROM departments WHERE id=?',d.id);if(old&&old.name!==d.name)throw Error('Department identity conflict');
    store.run('INSERT INTO departments(id,name,sort_order) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING',d.id,d.name,i);
   }
   for(const e of entries){
    if(store.one('SELECT id FROM resources WHERE source_system=? AND source_id=?','aifact',e.source_id)){skipped++;continue;}
    const profile=profiles.find(p=>p.id===e.creator_source_id)!;
    let user=store.one<{id:string}>('SELECT id FROM users WHERE email=?',e.creator_email.toLowerCase());
    if(!user){user={id:randomUUID()};store.run('INSERT INTO users(id,email,name,department_id,created_at) VALUES (?,?,?,?,?)',user.id,e.creator_email.toLowerCase(),profile.full_name||e.creator_name,profile.department_id??null,now());}
    const old=store.one<{user_id:string}>('SELECT user_id FROM source_identities WHERE source_system=? AND source_id=?','aifact',e.creator_source_id);if(old&&old.user_id!==user.id)throw Error('Conflicting AIFACT creator identity');
    // Supabase's profile UUID is a source identity, never a Google subject.
    store.run('INSERT INTO source_identities VALUES (?,?,?) ON CONFLICT DO NOTHING','aifact',e.creator_source_id,user.id);
    const id=randomUUID();store.run(`INSERT INTO resources(id,source_system,source_id,title,description,creator_id,department_id,url,status,visibility,preview_blob,source_metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,'aifact',e.source_id,e.title,e.description,user.id,e.department?.id??null,e.target_url,'published','company',staged.get(e.source_id)!,JSON.stringify(e),dateOnly(e.source_created_at),dateOnly(e.source_updated_at));
    for(const category of new Set(e.categories)){store.run('INSERT INTO categories(name) VALUES (?) ON CONFLICT DO NOTHING',category);store.run('INSERT INTO resource_categories VALUES (?,?)',id,category);}
    indexResource(store,id);inserted++;
   }
   store.run('INSERT INTO audit VALUES (?,?,?,?,?,?)',randomUUID(),null,'import-aifact',null,JSON.stringify({backup:root,inserted,skipped,source_exported_at:data.exported_at,classification:'Original departments/categories only; kind and tags not inferred'}),now());
  });
  committed=true;await mkdir(reportDir,{recursive:true});
  const needsReview=entries.filter(e=>!e.department?.id||!e.categories.length).map(e=>({source_id:e.source_id,title:e.title,missing_department:!e.department?.id,missing_categories:!e.categories.length}));
  const report={inserted,skipped,total:entries.length,images:staged.size,source_creators:new Set(entries.map(e=>e.creator_source_id)).size,missing_department:entries.filter(e=>!e.department?.id).length,missing_categories:entries.filter(e=>!e.categories.length).length,review:needsReview};
  await writeFile(resolve(reportDir,'aifact-import.json'),JSON.stringify(report,null,2));return report;
 }catch(e){if(!committed)for(const id of createdBlobs)await blobs.remove(id);throw e;}
}
