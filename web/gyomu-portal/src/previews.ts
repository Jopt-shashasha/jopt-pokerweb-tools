import {Store} from './db.js';
import {now,type Resource} from './model.js';
import {type BlobStore} from './storage.js';
import {renderMarkdown} from './markdown.js';
import type {PreviewRenderer} from './preview-renderer.js';

type Source={blob:string;key:string;kind:'html'|'markdown'};
export class Previews {
 private pending=new Map<string,Promise<Uint8Array<ArrayBuffer>|null>>();
 private failed=new Map<string,number>();
 private tail:Promise<unknown>=Promise.resolve();
 constructor(private store:Store,private blobs:BlobStore,private renderer?:PreviewRenderer){}
 private source(r:Resource):Source|null{
  if(r.html_blob)return {blob:r.html_blob,key:'html:'+r.html_blob,kind:'html'};
  const supplied=this.store.one<{blob:string;sha256:string}>('SELECT blob,sha256 FROM resource_preview_inputs WHERE resource_id=?',r.id);
  if(supplied)return {blob:supplied.blob,key:'html:'+supplied.sha256,kind:'html'};
  const md=this.store.one<{blob:string;sha256:string}>('SELECT blob,sha256 FROM resource_markdown WHERE resource_id=?',r.id);
  return md?{blob:md.blob,key:'markdown:'+md.sha256,kind:'markdown'}:null;
 }
 async get(r:Resource):Promise<Uint8Array<ArrayBuffer>|null>{
  const source=this.source(r);if(!source)return null;
  const cached=this.store.one<{blob:string;content_key:string}>('SELECT blob,content_key FROM resource_generated_previews WHERE resource_id=?',r.id);
  if(cached?.content_key===source.key)return this.blobs.get(cached.blob);
  if(!this.renderer||(this.failed.get(source.key)??0)>Date.now())return null;
  const existing=this.pending.get(r.id);if(existing)return existing;
  if(this.pending.size>=4)return null;
  const task=this.tail.then(async()=>{
   try{
    const bytes=await this.blobs.get(source.blob);if(bytes.byteLength>5*1024*1024)throw Error('Preview input exceeds 5 MiB');
    let html=Buffer.from(bytes).toString('utf8');
    if(source.kind==='markdown')html='<!doctype html><html lang="ja"><meta charset="utf-8"><style>body{font:20px/1.8 "Yu Gothic",sans-serif;color:#182523;background:#fff;padding:34px 50px;max-width:1050px}h1{font-size:34px}h2{font-size:25px}pre{white-space:pre-wrap;background:#f3f5f4;padding:14px}a{color:#245c50}</style><body>'+renderMarkdown(html)+'</body></html>';
    const image=await this.renderer!.render(html);
    const current=this.store.one<Resource>('SELECT * FROM resources WHERE id=?',r.id);if(!current||this.source(current)?.key!==source.key)return null;
    const blob=await this.blobs.put(image);try{this.store.run('INSERT INTO resource_generated_previews(resource_id,blob,content_key,kind,created_at) VALUES (?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET blob=excluded.blob,content_key=excluded.content_key,kind=excluded.kind,created_at=excluded.created_at',r.id,blob,source.key,source.kind,now());}catch(e){await this.blobs.remove(blob);throw e;}
    return image;
   }catch(e){if(this.failed.size>500)this.failed.clear();this.failed.set(source.key,Date.now()+10*60000);console.warn('Preview unavailable',r.id,e instanceof Error?e.message:'render failed');return null;}
  });this.pending.set(r.id,task);this.tail=task.catch(()=>null);
  try{return await task;}finally{this.pending.delete(r.id);}
 }
}
