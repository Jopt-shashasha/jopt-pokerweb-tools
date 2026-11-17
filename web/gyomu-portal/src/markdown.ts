import MarkdownIt from 'markdown-it';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { digest,type BlobStore } from './storage.js';
import { Store } from './db.js';
import { now } from './model.js';

export const MARKDOWN_MAX_BYTES=256*1024;
export const markdownInput=z.object({filename:z.string().min(1).max(160).regex(/^[^/\\\u0000-\u001f]+\.md$/i),content:z.string().max(MARKDOWN_MAX_BYTES).refine(s=>Buffer.byteLength(s,'utf8')<=MARKDOWN_MAX_BYTES,'MDは256 KB以下で指定してください。')}).strict();
const renderer=new MarkdownIt({html:false,linkify:false});
renderer.renderer.rules.image=(tokens,index)=>renderer.utils.escapeHtml(tokens[index].content);
const linkOpen=renderer.renderer.rules.link_open;
renderer.renderer.rules.link_open=(tokens,index,options,env,self)=>{tokens[index].attrSet('rel','noopener noreferrer');tokens[index].attrSet('target','_blank');return linkOpen?linkOpen(tokens,index,options,env,self):self.renderToken(tokens,index,options);};
export const renderMarkdown=(text:string)=>renderer.render(text);
export function markdownText(text:string){
 const tokens=renderer.parse(text,{});return tokens.filter(t=>t.type==='inline'||t.type==='fence'||t.type==='code_block').map(t=>t.children?.map(c=>c.content).join('')||t.content).join('\n').slice(0,120000);
}
export function markdownDescription(text:string){
 const tokens=renderer.parse(text,{});for(let i=0;i<tokens.length-1;i++)if(tokens[i].type==='paragraph_open'&&tokens[i+1].type==='inline')return markdownText(tokens[i+1].content).replace(/\s+/g,' ').trim().slice(0,400);return '';
}
export type MarkdownAsset={blob:string;filename:string;bytes:number;sha256:string;search_text:string;description:string};
export async function stageMarkdown(blobs:BlobStore|undefined,input:unknown):Promise<MarkdownAsset|undefined>{
 if(input===undefined)return undefined;if(!blobs)throw new HTTPException(503,{message:'MD添付の保存先が未設定です。'});
 const checked=markdownInput.safeParse(input);if(!checked.success)throw new HTTPException(400,{message:'256 KB以下のUTF-8の.mdファイルを指定してください。'});
 const {filename,content}=checked.data,bytes=Buffer.from(content,'utf8');
 return {blob:await blobs.put(bytes),filename,bytes:bytes.length,sha256:digest(bytes),search_text:markdownText(content),description:markdownDescription(content)};
}
export function saveMarkdown(store:Store,id:string,asset:MarkdownAsset,actor:string){
 store.run(`INSERT INTO resource_markdown(resource_id,blob,filename,bytes,sha256,search_text,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET blob=excluded.blob,filename=excluded.filename,bytes=excluded.bytes,sha256=excluded.sha256,search_text=excluded.search_text,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,id,asset.blob,asset.filename,asset.bytes,asset.sha256,asset.search_text,actor,now());
}
