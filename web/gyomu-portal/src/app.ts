import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Auth,SESSION_POLICY,type AppEnv } from './auth.js';
import { Store } from './db.js';
import { Catalog } from './repository.js';
import { News } from './news.js';
import { canEdit,now,type Config } from './model.js';
import { digest,type BlobStore } from './storage.js';
import { imageType } from './validation.js';
import { compactContext } from './context.js';
import { AgentRequests } from './agent-requests.js';
import { htmlText } from './discovery.js';
import { stageMarkdown,renderMarkdown,MARKDOWN_MAX_BYTES,type MarkdownAsset } from './markdown.js';
import { parseResource } from './validation.js';
import {Previews} from './previews.js';
import type {PreviewRenderer} from './preview-renderer.js';

const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function createApp(config:Config,store:Store,blobs:BlobStore,previewRenderer?:PreviewRenderer){
 const app=new Hono<AppEnv>();const auth=new Auth(store,config),catalog=new Catalog(store),news=new News(store,config.newsFeeds),agent=new AgentRequests(store,catalog,config,undefined,blobs),previews=new Previews(store,blobs,previewRenderer);
 app.use('*',async(c,next)=>{
  if(new URL(c.req.url).host!==new URL(config.origin).host)return c.json({error:'Unexpected host'},421);
  c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');c.header('X-Frame-Options','DENY');
  c.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  c.header('Cache-Control','no-store');await next();
 });
 app.use('*',bodyLimit({maxSize:101*1024*1024,onError:c=>c.json({error:'ファイルは100 MB以下で指定してください。'},413)}));
 app.onError((e,c)=>{
  if(e instanceof HTTPException)return c.json({error:e.message||'操作できません。'},e.status);
  const ref=randomUUID();console.error('portal error',ref,e);return c.json({error:'処理に失敗しました。',reference:ref},500);
 });
 async function json(c:any,maxBytes=65536){if(!c.req.header('content-type')?.startsWith('application/json'))throw new HTTPException(415);const text=await c.req.text();if(Buffer.byteLength(text)>maxBytes)throw new HTTPException(413);try{return JSON.parse(text);}catch{throw new HTTPException(400,{message:'入力内容を読み取れません。'});}}
 async function withMarkdown(body:unknown,operation:(asset:MarkdownAsset|undefined)=>unknown){
  const parsed=parseResource(body),asset=await stageMarkdown(blobs,parsed.markdown);
  try{return operation(asset);}catch(e){if(asset)await blobs.remove(asset.blob);throw e;}
 }
 app.get('/health',c=>c.json({ok:true}));
 // Only enqueue/retrieve bounded operations here. Actual execution requires
 // the normal browser session, Origin and CSRF checks under /api/.
 app.use('/agent/*',async(c,next)=>{if(c.req.header('x-portal-agent')!=='1')throw new HTTPException(403);if(c.req.header('origin')&&c.req.header('origin')!==config.origin)throw new HTTPException(403);await next();});
 // Registration vocabulary only; no resource titles, people, private tags or counts.
 app.get('/agent/registration-options',c=>c.json({departments:store.all('SELECT id,name FROM departments ORDER BY sort_order,name'),events:store.all('SELECT name FROM event_series ORDER BY sort_order'),event_scopes:store.all('SELECT id,event,name FROM event_scopes ORDER BY event,sort_order,name')}));
 app.post('/agent/requests',async c=>c.json(agent.create(await json(c,2*1024*1024)),202));
 app.get('/agent/requests/:id/result',c=>c.json(agent.result(c.req.param('id'),c.req.header('authorization')?.replace(/^Bearer /,'')??'')));
 app.get('/api/me',c=>{const u=auth.session(c);return c.json({user:u?{id:u.id,email:u.email,name:u.name,role:u.role}:null,csrf:u?.csrf??null,browser_session:u?{expires_at:new Date(u.expires_at*1000).toISOString(),idle_days:SESSION_POLICY.idleSeconds/86400,maximum_days:SESSION_POLICY.absoluteSeconds/86400}:null,local_dev:config.localDev,google_configured:!!config.googleClientId&&!!config.googleClientSecret,integrations:{slack:false,codex:false}});});
 app.post('/auth/local',c=>auth.localLogin(c));app.post('/auth/logout',c=>auth.logout(c));
 app.get('/auth/google',c=>auth.google(c));app.get('/auth/callback',c=>auth.callback(c));
 app.use('/api/*',async(c,next)=>{auth.require(c,!['GET','HEAD'].includes(c.req.method));await next();});
 app.get('/api/agent/requests/:id',c=>c.json(agent.preview(c.req.param('id'),c.get('user'))));
 app.post('/api/agent/requests/:id/execute',async c=>{const s=auth.require(c,true);return c.json(await agent.execute(c.req.param('id'),s,s.token_hash));});
 app.post('/api/agent/requests/:id/cancel',c=>c.json(agent.cancel(c.req.param('id'),c.get('user'))));
 app.get('/api/masters',c=>c.json(catalog.masters(c.get('user'))));
 app.post('/api/admin/event-scopes',async c=>{const b=await json(c);if(typeof b.event!=='string'||typeof b.name!=='string')throw new HTTPException(400);return c.json(catalog.addEventScope(c.get('user'),b.event,b.name),201);});
 app.get('/api/resources',c=>c.json(catalog.list(c.get('user'),new URL(c.req.url).searchParams)));
 app.get('/api/home',c=>c.json({pickup:catalog.pickup(c.get('user')),masters:catalog.masters(c.get('user'))}));
 app.get('/api/news',async c=>c.json(await news.get()));
 // Browser-side requests reuse this browser's cookie and CSRF protection.
 // A remote MCP connection does not automatically receive that browser session.
 app.get('/api/agent/context',async c=>{const q=new URL(c.req.url).searchParams;q.set('page_size','3');return c.json(compactContext(catalog.list(c.get('user'),q),await news.get()));});
 app.get('/api/admin/creators',c=>{if(c.get('user').role!=='admin')throw new HTTPException(403);return c.json(store.all('SELECT id,email,name FROM users WHERE active=1 ORDER BY name,email'));});
 app.get('/api/admin/audit',c=>{if(c.get('user').role!=='admin')throw new HTTPException(403);return c.json(store.all('SELECT a.*,u.email actor_email FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY created_at DESC LIMIT 100'));});
 app.post('/api/resources',async c=>{const body=await json(c,1024*1024);return c.json(await withMarkdown(body,asset=>catalog.create(c.get('user'),body,undefined,asset)),201);});
 app.post('/api/resources/upload',async c=>{
  if(!c.req.header('content-type')?.startsWith('multipart/form-data'))throw new HTTPException(415);
  const form=await c.req.formData(),raw=form.get('metadata'),file=form.get('file'),mdFile=form.get('markdown_file');
  if(typeof raw!=='string'||Buffer.byteLength(raw)>65536)throw new HTTPException(400);
  let body:any;try{body=JSON.parse(raw);}catch{throw new HTTPException(400);}
  if(!body||typeof body!=='object'||Array.isArray(body))throw new HTTPException(400);
  if(mdFile!==null&&(!(mdFile instanceof File)||!mdFile.size))throw new HTTPException(400,{message:'空でないMDファイルを指定してください。'});
  if(file!==null&&(!(file instanceof File)||!file.size))throw new HTTPException(400,{message:'空でないHTMLファイルを指定してください。'});
  if(mdFile instanceof File&&mdFile.size){if(mdFile.size>MARKDOWN_MAX_BYTES)throw new HTTPException(413,{message:'MDは256 KB以下で指定してください。'});let content:string;try{content=new TextDecoder('utf-8',{fatal:true}).decode(await mdFile.arrayBuffer());}catch{throw new HTTPException(400,{message:'UTF-8のMDファイルを指定してください。'});}body.markdown={filename:mdFile.name,content};}
  let html:{blob:string;filename:string;bytes:number;sha256:string;search_text:string}|undefined;
  const parsed=parseResource(body);let markdown:MarkdownAsset|undefined;
  try{
   markdown=await stageMarkdown(blobs,parsed.markdown);
   if(file instanceof File&&file.size){if(!/\.html?$/i.test(file.name)||file.size>100*1024*1024)throw new HTTPException(400);const bytes=new Uint8Array(await file.arrayBuffer());html={blob:await blobs.put(bytes),filename:file.name.replace(/[\/\\\u0000-\u001f]/g,'_').slice(0,240),bytes:bytes.length,sha256:digest(bytes),search_text:htmlText(new TextDecoder().decode(bytes))};}
   return c.json(catalog.create(c.get('user'),body,html,markdown),201);
  }catch(e){if(html)await blobs.remove(html.blob);if(markdown)await blobs.remove(markdown.blob);throw e;}
 });
 app.post('/api/resources/html',async c=>{
  if(!c.req.header('content-type')?.startsWith('multipart/form-data'))throw new HTTPException(415);
  const body=await c.req.formData(),file=body.get('file'),metadata=body.get('metadata');
  if(!(file instanceof File)||typeof metadata!=='string'||!file.name.match(/\.html?$/i)||file.size>100*1024*1024||file.size===0)throw new HTTPException(400,{message:'100 MB以下のHTMLファイルを指定してください。'});
  let input:unknown;try{input=JSON.parse(metadata);}catch{throw new HTTPException(400,{message:'登録情報を確認してください。'});}
  const bytes=new Uint8Array(await file.arrayBuffer()),blob=await blobs.put(bytes);
  try{return c.json(catalog.create(c.get('user'),input,{blob,filename:file.name.replace(/[\/\\\u0000-\u001f]/g,'_').slice(0,240),bytes:bytes.length,sha256:digest(bytes),search_text:htmlText(new TextDecoder().decode(bytes))}),201);}catch(e){await blobs.remove(blob);throw e;}
 });
 app.get('/api/resources/:id',c=>c.json(catalog.view(catalog.get(c.req.param('id'),c.get('user')),c.get('user'))));
 app.put('/api/resources/:id/reader-guide',async c=>c.json(catalog.setReaderGuide(c.req.param('id'),c.get('user'),await json(c))));
 app.put('/api/resources/:id',async c=>{const body=await json(c,1024*1024);return c.json(await withMarkdown(body,asset=>catalog.update(c.req.param('id'),c.get('user'),body,asset)));});
 app.get('/api/resources/:id/markdown',async c=>{
  const r=catalog.get(c.req.param('id'),c.get('user')),md=store.one<{blob:string;filename:string;bytes:number}>('SELECT blob,filename,bytes FROM resource_markdown WHERE resource_id=?',r.id);if(!md)throw new HTTPException(404);
  return c.json({filename:md.filename,bytes:md.bytes,rendered_html:renderMarkdown(Buffer.from(await blobs.get(md.blob)).toString('utf8'))});
 });
 app.get('/api/resources/:id/markdown/download',async c=>{
  const r=catalog.get(c.req.param('id'),c.get('user')),md=store.one<{blob:string;filename:string}>('SELECT blob,filename FROM resource_markdown WHERE resource_id=?',r.id);if(!md)throw new HTTPException(404);
  return c.body(await blobs.get(md.blob),200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="README.md"; filename*=UTF-8''${encodeURIComponent(md.filename)}`});
 });
 app.put('/api/resources/:id/saved',c=>{catalog.save(c.req.param('id'),c.get('user'),true);return c.json({ok:true});});
 app.delete('/api/resources/:id/saved',c=>{catalog.save(c.req.param('id'),c.get('user'),false);return c.json({ok:true});});
 app.get('/api/resources/:id/preview-image',async c=>{
  const r=catalog.get(c.req.param('id'),c.get('user'));
  if(r.preview_blob){const bytes=await blobs.get(r.preview_blob);return c.body(bytes,{headers:{'Content-Type':imageType(bytes)??'application/octet-stream'}});}
  const generated=await previews.get(r);catalog.get(r.id,c.get('user'));
  if(generated)return c.body(generated,200,{'Content-Type':imageType(generated)??'image/jpeg'});
  const text=escape(r.title.length>29?r.title.slice(0,28)+'…':r.title);return c.body(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#f1f1f1"/><rect x="52" y="52" width="52" height="52" rx="12" fill="#111"/><text x="78" y="88" text-anchor="middle" font-size="30" fill="white" font-family="sans-serif">J</text><text x="52" y="320" font-size="28" fill="#111" font-family="sans-serif">${text}</text><text x="52" y="472" font-size="20" fill="#666" font-family="sans-serif">${escape(r.department_name??'セクション未分類')} / 業務ポータル</text></svg>`,200,{'Content-Type':'image/svg+xml'});
 });
 app.put('/api/resources/:id/preview-image',bodyLimit({maxSize:5*1024*1024}),async c=>{
  const r=catalog.get(c.req.param('id'),c.get('user'));if(!canEdit(r,c.get('user')))throw new HTTPException(403);
  const bytes=new Uint8Array(await c.req.arrayBuffer());if(!imageType(bytes))throw new HTTPException(415,{message:'PNG・JPEG・WebP画像を指定してください。'});
  const blob=await blobs.put(bytes);
  try{store.transaction(()=>{store.run('UPDATE resources SET preview_blob=?,version=version+1,updated_at=? WHERE id=?',blob,now(),r.id);catalog.audit(c.get('user').id,'preview-image',r.id,{bytes:bytes.length,sha256:digest(bytes)});});}catch(e){await blobs.remove(blob);throw e;}
  // Old objects are retained for audit/recovery; deletion is a separate maintenance concern.
  return c.json({ok:true});
 });
 app.get('/api/resources/:id/content',async c=>{
  const r=catalog.get(c.req.param('id'),c.get('user'));if(!r.html_blob)throw new HTTPException(404);
  c.header('Content-Security-Policy',"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");c.header('X-Frame-Options','SAMEORIGIN');
  return c.body(await blobs.get(r.html_blob),200,{'Content-Type':'text/html; charset=utf-8'});
 });
 app.get('/api/resources/:id/download',async c=>{
  const r=catalog.get(c.req.param('id'),c.get('user'));if(!r.html_blob)throw new HTTPException(404);
  return c.body(await blobs.get(r.html_blob),200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="document.html"; filename*=UTF-8''${encodeURIComponent(r.original_filename??'document.html')}`});
 });
 app.post('/api/resources/:id/access-request',c=>{
  catalog.get(c.req.param('id'),c.get('user'));
  // Never report delivery or a GitHub invitation until a real Slack/GitHub adapter is configured.
  throw new HTTPException(503,{message:'Slackの通知先・接続設定が必要です。現在は送信されません。'});
 });
 app.get('/preview/:id',c=>{
  const u=auth.session(c);if(!u)return c.redirect('/');const r=catalog.get(c.req.param('id'),u);if(!r.html_blob)throw new HTTPException(404);
  return c.html(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(r.title)}</title><link rel="stylesheet" href="/style.css"><body class="preview"><header><a href="/#/resource/${r.id}">← 資料へ戻る</a><strong>${escape(r.title)}</strong><a href="/api/resources/${r.id}/download">原ファイルを保存</a></header><p>HTMLプレビュー。外部通信・外部ファイルの読み込みは制限されています。</p><iframe title="HTMLプレビュー" sandbox="allow-scripts" src="/api/resources/${r.id}/content"></iframe></body></html>`);
 });
 for(const [route,name,type] of [['/','index.html','text/html'],['/app.js','app.js','text/javascript'],['/style.css','style.css','text/css']])app.get(route,async c=>c.body(await readFile(new URL('../public/'+name,import.meta.url)),200,{'Content-Type':type+'; charset=utf-8'}));
 app.notFound(c=>c.json({error:'見つかりません。'},404));return {app,auth,catalog};
}
