import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { randomUUID } from 'node:crypto';
import { Auth,SESSION_POLICY,type AppEnv } from './auth.js';
import type { Database } from './database.js';
import { Catalog } from './repository.js';
import { News } from './news.js';
import type { Config } from './model.js';
import type { BlobStore } from './blob-store.js';
import { imageType } from './validation.js';
import { compactContext } from './context.js';
import { AgentRequests } from './agent-requests.js';
import { AgentTokens, DEFAULT_MCP_PATH } from './agent-tokens.js';
import { createRemoteMcp } from './remote-mcp.js';
import { Slack } from './slack.js';
import { renderMarkdown } from './markdown.js';
import {Previews} from './previews.js';
import type {PreviewRenderer} from './preview-renderer.js';

const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function createApp(config:Config,store:Database,blobs:BlobStore,previewRenderer?:PreviewRenderer,options:{slackFetch?:typeof fetch; setupTemplate?:string; asset?:(name:string)=>string|Uint8Array|Promise<string|Uint8Array>}={}){
 const app=new Hono<AppEnv>();const auth=new Auth(store,config),catalog=new Catalog(store),news=new News(store,config.newsFeeds),agent=new AgentRequests(store,catalog,config,undefined,blobs),previews=new Previews(store,blobs,previewRenderer),tokens=new AgentTokens(store,config,undefined,options.setupTemplate),remoteMcp=createRemoteMcp(config,store,catalog,agent,tokens,blobs,news),slack=new Slack(store,config,catalog,options.slackFetch,undefined,news);
 app.use('*',async(c,next)=>{
  if(new URL(c.req.url).host!==new URL(config.origin).host)return c.json({error:'Unexpected host'},421);
  c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');c.header('X-Frame-Options','DENY');
  c.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  c.header('Cache-Control','no-store');await next();
 });
 app.use('*',bodyLimit({maxSize:2*1024*1024,onError:c=>c.json({error:'リクエストのサイズが上限を超えています。'},413)}));
 app.onError((e,c)=>{
  if(e instanceof HTTPException)return c.json({error:e.message||'操作できません。'},e.status);
  const ref=randomUUID();console.error('portal error',ref,e);return c.json({error:'処理に失敗しました。',reference:ref},500);
 });
 async function json(c:any,maxBytes=65536){if(!c.req.header('content-type')?.startsWith('application/json'))throw new HTTPException(415);const text=await c.req.text();if(Buffer.byteLength(text)>maxBytes)throw new HTTPException(413);try{return JSON.parse(text);}catch{throw new HTTPException(400,{message:'入力内容を読み取れません。'});}}
 app.get('/health',c=>c.json({ok:true}));
 // Codex連携 setup: the script is fetched by PowerShell with a one-time code, which it exchanges
 // for a read-scoped personal token. The BOM also supports offline review and execution on PowerShell 5.1.
 app.get('/setup.ps1',async c=>c.body('\uFEFF'+await tokens.script(c.req.query('code')??''),200,{'Content-Type':'text/plain; charset=utf-8'}));
 app.post('/setup/exchange',async c=>{if(c.req.header('origin'))throw new HTTPException(403);return c.json(await tokens.exchange(await json(c,4096),c.req.header('cf-connecting-ip')??'single-node'));});
 app.get('/setup/whoami',async c=>{const a=await tokens.authenticate(c.req.header('authorization'));if(!a)throw new HTTPException(401,{message:'Codex連携トークンが無効です。'});return c.json({name:a.user.name,email:a.user.email});});
 // Slack links land here: count a human click, then always go to the portal detail page
 // (never to a URL taken from the query string).
 app.get('/go/:id',async c=>{const id=c.req.param('id');if(!/^[0-9a-f-]{36}$/i.test(id))throw new HTTPException(404);const u=await auth.session(c);return c.redirect(await slack.click(id,c.req.query('p'),u??null,c.req.header('user-agent')),302);});
 // Remote MCP for Codex, authenticated by the personal token (not the shared Codex account).
 app.all(config.mcpPath??DEFAULT_MCP_PATH,c=>remoteMcp(c.req.raw));
 // Only enqueue/retrieve bounded operations here. Actual execution requires
 // the normal browser session, Origin and CSRF checks under /api/.
 app.use('/agent/*',async(c,next)=>{if(c.req.header('x-portal-agent')!=='1')throw new HTTPException(403);if(c.req.header('origin')&&c.req.header('origin')!==config.origin)throw new HTTPException(403);await next();});
 // Registration vocabulary only; no resource titles, people, private tags or counts.
 app.get('/agent/registration-options',async c=>c.json({departments:await store.all('SELECT id,name FROM departments ORDER BY sort_order,name'),events:await store.all('SELECT name FROM event_series ORDER BY sort_order'),event_scopes:await store.all('SELECT id,event,name FROM event_scopes ORDER BY event,sort_order,name')}));
 app.post('/agent/requests',async c=>c.json(await agent.create(await json(c,2*1024*1024)),202));
 app.get('/agent/requests/:id/result',async c=>c.json(await agent.result(c.req.param('id'),c.req.header('authorization')?.replace(/^Bearer /,'')??'')));
 app.get('/api/me',async c=>{const u=await auth.session(c);return c.json({user:u?{id:u.id,email:u.email,name:u.name,role:u.role}:null,csrf:u?.csrf??null,browser_session:u?{expires_at:new Date(u.expires_at*1000).toISOString(),idle_days:SESSION_POLICY.idleSeconds/86400,maximum_days:SESSION_POLICY.absoluteSeconds/86400}:null,local_dev:config.localDev,google_configured:!!config.googleClientId&&!!config.googleClientSecret,integrations:{slack:slack.mode==='live',codex:true}});});
 app.post('/auth/local',c=>auth.localLogin(c));app.post('/auth/logout',c=>auth.logout(c));
 app.get('/auth/google',c=>auth.google(c));app.get('/auth/callback',c=>auth.callback(c));
 app.use('/api/*',async(c,next)=>{await auth.require(c,!['GET','HEAD'].includes(c.req.method));await next();});
 app.get('/api/agent/requests/:id',async c=>c.json(await agent.preview(c.req.param('id'),c.get('user'))));
 app.post('/api/agent/requests/:id/execute',async c=>{const s=await auth.require(c,true);return c.json(await agent.execute(c.req.param('id'),s,s.token_hash));});
 app.post('/api/agent/requests/:id/cancel',async c=>c.json(await agent.cancel(c.req.param('id'),c.get('user'))));
 app.get('/api/admin/slack',async c=>c.json(await slack.settings(c.get('user'))));
 app.put('/api/admin/slack',async c=>c.json(await slack.updateSettings(c.get('user'),await json(c))));
 app.put('/api/admin/slack/departments/:id',async c=>c.json(await slack.updateDepartment(c.get('user'),c.req.param('id'),await json(c))));
 app.get('/api/admin/slack/intro/:id',async c=>c.json(await slack.introPreview(c.get('user'),c.req.param('id'),c.req.query('channel'))));
 app.post('/api/admin/slack/intro/:id',async c=>c.json(await slack.introSend(c.get('user'),c.req.param('id'),await json(c))));
 app.get('/api/admin/slack/people',async c=>c.json(await slack.people(c.get('user'))));
 app.post('/api/admin/slack/intro/:id/dm',async c=>c.json(await slack.introDm(c.get('user'),c.req.param('id'),await json(c))));
 app.get('/api/admin/slack/digest',async c=>c.json(await slack.digestPreview(c.get('user'))));
 app.get('/api/admin/slack/news',async c=>c.json(await slack.newsPreview(c.get('user'))));
 app.post('/api/admin/slack/news',async c=>c.json(await slack.newsSend(c.get('user'),await json(c))));
 app.post('/api/admin/slack/digest',async c=>c.json(await slack.digestSend(c.get('user'),await json(c))));
 app.get('/api/admin/slack/posts',async c=>c.json(await slack.posts(c.get('user'))));
 app.post('/api/admin/slack/posts/:id/resolve',async c=>c.json(await slack.resolve(c.get('user'),c.req.param('id'),await json(c))));
 app.post('/api/codex/setup',async c=>c.json(await tokens.issueSetupCode(c.get('user')),201));
 app.get('/api/codex/tokens',async c=>c.json({items:await tokens.list(c.get('user')),notice_interval:await tokens.noticeInterval()}));
 app.put('/api/admin/codex/notice-interval',async c=>c.json(await tokens.setNoticeInterval(c.get('user'),(await json(c)).interval)));
 app.delete('/api/codex/tokens/:id',async c=>c.json(await tokens.revoke(c.get('user'),c.req.param('id'))));
 app.get('/api/masters',async c=>c.json(await catalog.masters(c.get('user'))));
 app.post('/api/admin/event-scopes',async c=>{const b=await json(c);if(typeof b.event!=='string'||typeof b.name!=='string')throw new HTTPException(400);return c.json(await catalog.addEventScope(c.get('user'),b.event,b.name),201);});
 app.get('/api/resources',async c=>c.json(await catalog.list(c.get('user'),new URL(c.req.url).searchParams)));
 app.get('/api/home',async c=>c.json({pickup:await catalog.pickup(c.get('user')),masters:await catalog.masters(c.get('user'))}));
 app.get('/api/news',async c=>c.json(await news.get()));
 // Browser-side requests reuse this browser's cookie and CSRF protection.
 // A remote MCP connection does not automatically receive that browser session.
 app.get('/api/agent/context',async c=>{const q=new URL(c.req.url).searchParams;q.set('page_size','3');return c.json(compactContext(await catalog.list(c.get('user'),q),await news.get()));});
 app.get('/api/admin/creators',async c=>{if(c.get('user').role!=='admin')throw new HTTPException(403);return c.json(await store.all('SELECT id,email,name FROM users WHERE active=1 ORDER BY name,email'));});
 app.get('/api/admin/audit',async c=>{if(c.get('user').role!=='admin')throw new HTTPException(403);return c.json(await store.all('SELECT a.*,u.email actor_email FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY created_at DESC LIMIT 100'));});
 app.post('/api/resources',async c=>c.json(await catalog.create(c.get('user'),await json(c,1024*1024)),201));
 app.get('/api/resources/:id',async c=>c.json(catalog.view(await catalog.get(c.req.param('id'),c.get('user')),c.get('user'))));
 app.put('/api/resources/:id/reader-guide',async c=>c.json(await catalog.setReaderGuide(c.req.param('id'),c.get('user'),await json(c))));
 app.put('/api/resources/:id',async c=>c.json(await catalog.update(c.req.param('id'),c.get('user'),await json(c,1024*1024))));
 app.get('/api/resources/:id/markdown',async c=>{
  const r=await catalog.get(c.req.param('id'),c.get('user')),md=await store.one<{blob:string;filename:string;bytes:number}>('SELECT blob,filename,bytes FROM resource_markdown WHERE resource_id=?',r.id);if(!md)throw new HTTPException(404);
  return c.json({filename:md.filename,bytes:md.bytes,rendered_html:renderMarkdown(Buffer.from(await blobs.get(md.blob)).toString('utf8'))});
 });
 app.get('/api/resources/:id/markdown/download',async c=>{
  const r=await catalog.get(c.req.param('id'),c.get('user')),md=await store.one<{blob:string;filename:string}>('SELECT blob,filename FROM resource_markdown WHERE resource_id=?',r.id);if(!md)throw new HTTPException(404);
  return c.body(await blobs.get(md.blob),200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="README.md"; filename*=UTF-8''${encodeURIComponent(md.filename)}`});
 });
 app.put('/api/resources/:id/saved',async c=>{await catalog.save(c.req.param('id'),c.get('user'),true);return c.json({ok:true});});
 app.delete('/api/resources/:id/saved',async c=>{await catalog.save(c.req.param('id'),c.get('user'),false);return c.json({ok:true});});
 app.get('/api/resources/:id/preview-image',async c=>{
  const r=await catalog.get(c.req.param('id'),c.get('user'));
  if(r.preview_blob){const bytes=await blobs.get(r.preview_blob);return c.body(bytes,{headers:{'Content-Type':imageType(bytes)??'application/octet-stream'}});}
  const generated=await previews.get(r);await catalog.get(r.id,c.get('user'));
  if(generated)return c.body(generated,200,{'Content-Type':imageType(generated)??'image/jpeg'});
  const text=escape(r.title.length>29?r.title.slice(0,28)+'…':r.title);return c.body(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#f1f1f1"/><rect x="52" y="52" width="52" height="52" rx="12" fill="#111"/><text x="78" y="88" text-anchor="middle" font-size="30" fill="white" font-family="sans-serif">J</text><text x="52" y="320" font-size="28" fill="#111" font-family="sans-serif">${text}</text><text x="52" y="472" font-size="20" fill="#666" font-family="sans-serif">${escape(r.department_name??'セクション未分類')} / 業務ポータル</text></svg>`,200,{'Content-Type':'image/svg+xml'});
 });
 app.get('/api/resources/:id/content',async c=>{
  const r=await catalog.get(c.req.param('id'),c.get('user'));if(!r.html_blob)throw new HTTPException(404);
  c.header('Content-Security-Policy',"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");c.header('X-Frame-Options','SAMEORIGIN');
  return c.body(await blobs.get(r.html_blob),200,{'Content-Type':'text/html; charset=utf-8'});
 });
 app.get('/api/resources/:id/download',async c=>{
  const r=await catalog.get(c.req.param('id'),c.get('user'));if(!r.html_blob)throw new HTTPException(404);
  return c.body(await blobs.get(r.html_blob),200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="document.html"; filename*=UTF-8''${encodeURIComponent(r.original_filename??'document.html')}`});
 });
 app.post('/api/resources/:id/access-request',async c=>{
  await catalog.get(c.req.param('id'),c.get('user'));
  // Never report delivery or a GitHub invitation until a real Slack/GitHub adapter is configured.
  throw new HTTPException(503,{message:'Slackの通知先・接続設定が必要です。現在は送信されません。'});
 });
 app.get('/preview/:id',async c=>{
  const u=await auth.session(c);if(!u)return c.redirect('/');const r=await catalog.get(c.req.param('id'),u);if(!r.html_blob)throw new HTTPException(404);
  return c.html(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(r.title)}</title><link rel="stylesheet" href="/style.css"><body class="preview"><header><a href="/#/resource/${r.id}">← 資料へ戻る</a><strong>${escape(r.title)}</strong><a href="/api/resources/${r.id}/download">原ファイルを保存</a></header><p>HTMLプレビュー。外部通信・外部ファイルの読み込みは制限されています。</p><iframe title="HTMLプレビュー" sandbox="allow-scripts" src="/api/resources/${r.id}/content"></iframe></body></html>`);
 });
 if(options.asset)for(const [route,name,type] of [['/','index.html','text/html'],['/app.js','app.js','text/javascript'],['/style.css','style.css','text/css']])app.get(route,async c=>{const asset=await options.asset!(name);c.header('Content-Type',type+'; charset=utf-8');return typeof asset==='string'?c.body(asset):c.body(Uint8Array.from(asset));});
 app.notFound(c=>c.json({error:'見つかりません。'},404));return {app,auth,catalog};
}
