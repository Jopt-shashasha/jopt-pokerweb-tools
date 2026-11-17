import { backup,DatabaseSync } from 'node:sqlite';
import { readFile,mkdir,writeFile } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Store } from '../src/db.js';
import { Catalog } from '../src/repository.js';
import { indexResource } from '../src/discovery.js';
import { resourceEvents,validateEvents,saveEvents } from '../src/events.js';

const assignment=z.object({event:z.string().min(1),event_scope_id:z.string().nullable()}).strict();
export const reviewInput=z.object({reviewed_on:z.string(),plan:z.array(z.object({id:z.string().uuid(),title:z.string(),source_system:z.enum(['drop','aifact']),expected_version:z.number().int().positive(),before:z.array(assignment),events:z.array(assignment).max(20),reason:z.string().min(1)}).strict()).min(1)}).strict();
const signature=(values:{event:string;event_scope_id:string|null}[])=>JSON.stringify([...values].sort((a,b)=>a.event.localeCompare(b.event)));

// Applies reviewed data only. It contains no title matching or classification rules.
export function applyEventReview(store:Store,input:unknown,apply=false){
 const review=reviewInput.parse(input),catalog=new Catalog(store),seen=new Set<string>();
 return store.transaction(()=>{
  const rows=review.plan.map(row=>{
   if(seen.has(row.id))throw Error('Duplicate review resource');seen.add(row.id);
   const current=store.one<{title:string;source_system:string;version:number}>('SELECT title,source_system,version FROM resources WHERE id=?',row.id);
   if(!current||current.title!==row.title||current.source_system!==row.source_system||current.version!==row.expected_version||signature(resourceEvents(store,row.id))!==signature(row.before))throw Error('Resource changed since review: '+row.id);
   const events=validateEvents(store,row.events);
   return {...row,events,changed:signature(events)!==signature(row.before)};
  });
  const changed=rows.filter(row=>row.changed);
  if(apply){for(const row of changed){
   const first=row.events[0];
   store.run('UPDATE resources SET event=?,event_scope_id=?,version=version+1 WHERE id=? AND version=?',first?.event??null,first?.event_scope_id??null,row.id,row.expected_version);
   saveEvents(store,row.id,row.events);indexResource(store,row.id);
  }catalog.audit(null,'apply-ai-event-review',null,{reviewed:rows.length,changed:changed.length,reviewed_on:review.reviewed_on});}
  return {applied:apply,reviewed:rows.length,changed:changed.length,changes:changed.map(({id,title,events,reason})=>({id,title,events,reason}))};
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const file=process.argv[2];if(!file||file.startsWith('--'))throw Error('Usage: tsx scripts/apply-event-review.ts review.json [--apply]');
 const input=JSON.parse(await readFile(resolve(file),'utf8')),apply=process.argv.includes('--apply'),dbPath=resolve('.local/portal-local.sqlite');
 let snapshot:string|undefined;
 if(apply){const label=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',dateStyle:'short',timeStyle:'medium'}).format(new Date()).replace(/[^0-9]/g,'');snapshot=resolve('.local/backups/before-reviewed-events-'+label+'.sqlite');await mkdir(dirname(snapshot),{recursive:true});const db=new DatabaseSync(dbPath,{readOnly:true});try{await backup(db,snapshot);}finally{db.close();}}
 const store=new Store(dbPath);try{const result=applyEventReview(store,input,apply);if(apply)await writeFile(resolve(file).replace(/\.json$/,'-applied.json'),JSON.stringify({...result,snapshot},null,2));console.log(JSON.stringify({...result,snapshot},null,2));}finally{store.close();}
}
