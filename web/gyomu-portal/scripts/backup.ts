// Consistent backup of the portal: SQLite Online Backup API (includes WAL contents)
// plus the blob files the database refers to. Run daily from cron / a scheduled job.
// Usage: node --import tsx scripts/backup.ts --out <BACKUP_DIR> [--data-dir <PORTAL_DATA_DIR>] [--keep 14]
import { backup,DatabaseSync } from 'node:sqlite';
import { copyFile,mkdir,readdir,rm,stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function runBackup(dataDir:string,outDir:string,keep=14,clock=()=>new Date()){
 const dbName=['portal.sqlite','portal-local.sqlite'].find(n=>existsSync(join(dataDir,n)));
 if(!dbName)throw Error('No portal database in '+dataDir);
 if(resolve(outDir).startsWith(resolve(dataDir)))throw Error('Backup directory must be outside the data directory');
 const stamp=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',dateStyle:'short',timeStyle:'medium'}).format(clock()).replace(/[^0-9]/g,'');
 await mkdir(join(outDir,'db'),{recursive:true});await mkdir(join(outDir,'blobs'),{recursive:true});
 const target=join(outDir,'db',`${dbName.replace('.sqlite','')}-${stamp}.sqlite`);
 const source=new DatabaseSync(join(dataDir,dbName),{readOnly:true});try{await backup(source,target);}finally{source.close();}
 // Store the copy as a single self-contained file (no -wal/-shm sidecars), then verify it.
 const check=new DatabaseSync(target);let integrity:string;try{check.exec('PRAGMA journal_mode=DELETE');integrity=String((check.prepare('PRAGMA integrity_check').get() as Record<string,unknown>).integrity_check);}finally{check.close();}
 if(integrity!=='ok')throw Error('Backup integrity check failed: '+integrity);
 // Blobs are immutable (random names), so copying new files is enough.
 let copied=0;const blobDir=join(dataDir,'blobs');
 if(existsSync(blobDir))for(const name of await readdir(blobDir)){const from=join(blobDir,name),to=join(outDir,'blobs',name);if(!(await stat(from)).isFile())continue;if(!existsSync(to)){await copyFile(from,to);copied++;}}
 const all=(await readdir(join(outDir,'db'))).filter(n=>n.endsWith('.sqlite')).sort();
 const removed=all.slice(0,Math.max(0,all.length-keep));for(const n of removed)for(const suffix of ['','-wal','-shm'])await rm(join(outDir,'db',n+suffix),{force:true});
 return {database:target,integrity,blobs_copied:copied,kept:Math.min(all.length,keep),removed};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const args=process.argv.slice(2),arg=(k:string)=>{const i=args.indexOf(k);return i>=0?args[i+1]:undefined;};
 const out=arg('--out')??process.env.BACKUP_DIR;if(!out)throw Error('Specify --out or BACKUP_DIR');
 const result=await runBackup(resolve(arg('--data-dir')??process.env.PORTAL_DATA_DIR??'.local'),resolve(out),Number(arg('--keep')??14));
 console.log(JSON.stringify(result,null,1));
}
