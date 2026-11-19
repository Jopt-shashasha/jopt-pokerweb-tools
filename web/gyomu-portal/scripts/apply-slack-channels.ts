// Copies verified channel IDs from docs/slack-channel-map.json into departments.
// Never enables sending: an admin turns each channel on in the portal after checking it.
// Usage: node --import tsx scripts/apply-slack-channels.ts [map.json] [--db path] [--apply]
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Store } from '../src/db.js';

const mapInput=z.object({channels:z.array(z.object({department:z.string(),department_id:z.string().nullable(),channel_name:z.string().nullable(),channel_id:z.string().nullable(),status:z.string()}).passthrough())}).passthrough();
export function applySlackChannels(store:Store,input:unknown,apply=false){
 const map=mapInput.parse(input);
 return store.transaction(()=>{
  const rows=map.channels.filter(c=>c.status==='identified'&&c.department_id&&c.channel_id).map(c=>{
   if(!/^[CG][A-Z0-9]{8,12}$/.test(c.channel_id!))throw Error('Invalid channel id: '+c.channel_id);
   const d=store.one<{name:string;slack_channel_id:string|null;slack_channel_name:string|null}>('SELECT name,slack_channel_id,slack_channel_name FROM departments WHERE id=?',c.department_id!);
   if(!d)throw Error('Unknown department: '+c.department+' '+c.department_id);
   if(d.name!==c.department)throw Error(`Department name mismatch: ${d.name} != ${c.department}`);
   return {department:d.name,id:c.department_id!,from:d.slack_channel_id,to:c.channel_id!,name:c.channel_name,changed:d.slack_channel_id!==c.channel_id||d.slack_channel_name!==c.channel_name};
  });
  const skipped=map.channels.filter(c=>c.status!=='identified').map(c=>c.department);
  if(apply)for(const r of rows)if(r.changed)store.run('UPDATE departments SET slack_channel_id=?,slack_channel_name=? WHERE id=?',r.to,r.name,r.id);
  return {applied:apply,changed:rows.filter(r=>r.changed),unchanged:rows.filter(r=>!r.changed).length,skipped_needs_confirmation:skipped};
 });
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const args=process.argv.slice(2),apply=args.includes('--apply'),dbAt=args.indexOf('--db');
 const file=args.find((a,i)=>!a.startsWith('--')&&args[i-1]!=='--db')??'docs/slack-channel-map.json';
 const db=resolve(dbAt>=0?args[dbAt+1]:'.local/portal-local.sqlite');
 const store=new Store(db);try{console.log(JSON.stringify(applySlackChannels(store,JSON.parse(await readFile(file,'utf8')),apply),null,1));if(!apply)console.log('Dry run. Add --apply to save. Sending stays disabled until an admin enables each channel.');}finally{store.close();}
}
