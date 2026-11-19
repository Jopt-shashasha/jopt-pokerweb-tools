// Codex連携: one-time setup codes exchanged for read-scoped personal tokens.
// The token identifies the employee independently of the (possibly shared)
// Codex/OpenAI login. Writes still require the signed-in browser review.
import { randomBytes,randomUUID } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import { isBatchConflict, rateLimit, requireSql, type Database } from './database.js';
import { digest } from './blob-store.js';
import { epoch,type Config,type User } from './model.js';

export const SETUP_CODE_SECONDS=600;
export const AGENT_TOKEN_SECONDS=90*86400;
export const TOKEN_ENV='JOPT_PORTAL_TOKEN';
export const MCP_SERVER_NAME='jopt-portal';
export const DEFAULT_MCP_PATH='/mcp';
const CODE=/^[a-f0-9]{32}$/,TOKEN=/^jpt_[a-f0-9]{64}$/;
type TokenRow={id:string;user_id:string;label:string;created_at:number;expires_at:number;last_used_at:number|null;revoked_at:number|null;last_seen_new_at:number|null};

export class AgentTokens {
 constructor(private store:Database,private config:Config,private clock:()=>number=epoch,private template?:string){}
 async issueSetupCode(user:User){
  const t=this.clock(),code=randomBytes(16).toString('hex');
  await this.store.batch([
   ['DELETE FROM agent_setup_codes WHERE expires_at<=? OR user_id=?',t,user.id],
   ['INSERT INTO agent_setup_codes(code_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)',digest(code),user.id,t,t+SETUP_CODE_SECONDS]
  ]);
  const prompt=setupPrompt(this.config.origin,code);
  return {expires_at:new Date((t+SETUP_CODE_SECONDS)*1000).toISOString(),prompt,codex_url:'codex://new?prompt='+encodeURIComponent(prompt)};
 }
 /** Script is served only while the code is valid; serving does not consume it. */
 async script(code:string){
  if(!CODE.test(code)||!await this.store.one('SELECT code_hash FROM agent_setup_codes WHERE code_hash=? AND expires_at>?',digest(code),this.clock()))throw new HTTPException(404,{message:'設定コードが無効か、有効期限が切れています。ポータルでボタンを押し直してください。'});
  if(!this.template)throw new HTTPException(503,{message:'Codex設定スクリプトが構成されていません。'});
  return setupScript(this.template,this.config.origin,code);
 }
 async exchange(body:unknown,client='single-node'){
  const t=this.clock();
  await rateLimit(this.store,'codex-setup:'+client,t);
  const b=(body&&typeof body==='object'?body:{}) as Record<string,unknown>;
  const code=typeof b.code==='string'?b.code:'';
  const label=typeof b.label==='string'&&b.label.trim()?b.label.trim().slice(0,80):'Codex';
  if(!CODE.test(code))throw new HTTPException(400,{message:'設定コードを確認してください。'});
  const hash=digest(code),invalid='設定コードが無効か、有効期限が切れています。ポータルでボタンを押し直してください。';
  const user=await this.store.one<User>('SELECT u.* FROM agent_setup_codes c JOIN users u ON u.id=c.user_id WHERE c.code_hash=? AND c.expires_at>? AND u.active=1',hash,t);
  if(!user)throw new HTTPException(404,{message:invalid});
  const token='jpt_'+randomBytes(32).toString('hex'),id=randomUUID();
  try{
   await this.store.batch([
    requireSql('EXISTS(SELECT 1 FROM agent_setup_codes c JOIN users u ON u.id=c.user_id WHERE c.code_hash=? AND c.user_id=? AND c.expires_at>? AND u.active=1)',hash,user.id,this.clock()),
    ['DELETE FROM agent_setup_codes WHERE code_hash=?',hash],
    ['UPDATE agent_tokens SET revoked_at=? WHERE user_id=? AND label=? AND revoked_at IS NULL',t,user.id,label],
    ['INSERT INTO agent_tokens(id,user_id,token_hash,label,created_at,expires_at) VALUES (?,?,?,?,?,?)',id,user.id,digest(token),label,t,t+AGENT_TOKEN_SECONDS],
    this.auditStatement(user.id,'codex_token_issue',{token_id:id,label})
   ]);
  }catch(error){
   if(isBatchConflict(error))throw new HTTPException(404,{message:invalid});
   throw error;
  }
  return {token,name:user.name,email:user.email,expires_at:new Date((t+AGENT_TOKEN_SECONDS)*1000).toISOString(),env:TOKEN_ENV,mcp_url:this.config.origin+(this.config.mcpPath??DEFAULT_MCP_PATH),server_name:MCP_SERVER_NAME};
 }
 /** Returns the active user for a bearer token, or null. */
 async authenticate(header:string|undefined):Promise<{user:User;tokenId:string}|null>{
  const token=header?.match(/^Bearer (\S+)$/)?.[1];if(!token||!TOKEN.test(token))return null;
  const t=this.clock(),row=await this.store.one<User&{token_id:string;last_used_at:number|null}>(`SELECT u.*,k.id token_id,k.last_used_at FROM agent_tokens k JOIN users u ON u.id=k.user_id WHERE k.token_hash=? AND k.revoked_at IS NULL AND k.expires_at>? AND u.active=1`,digest(token),t);
  if(!row)return null;
  if(!row.last_used_at||t-row.last_used_at>=300)await this.store.run('UPDATE agent_tokens SET last_used_at=? WHERE id=?',t,row.token_id);
  const {token_id,last_used_at,...user}=row;return {user:user as User,tokenId:token_id};
 }
 async list(user:User){
  const t=this.clock();
  return (await this.store.all<TokenRow>('SELECT id,user_id,label,created_at,expires_at,last_used_at,revoked_at,last_seen_new_at FROM agent_tokens WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC',user.id,t))
   .map(r=>({id:r.id,label:r.label,created_at:iso(r.created_at),expires_at:iso(r.expires_at),last_used_at:r.last_used_at?iso(r.last_used_at):null}));
 }
 async revoke(user:User,id:string){
  const r=await this.store.run('UPDATE agent_tokens SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL',this.clock(),id,user.id);
  if(!r.changes)throw new HTTPException(404);await this.store.batch([this.auditStatement(user.id,'codex_token_revoke',{token_id:id})]);return {ok:true};
 }
 async resetNoticeForTest(user:User,id:string){
  if(user.role!=='admin')throw new HTTPException(403);
  const reset=await this.store.run(
   `UPDATE agent_tokens
    SET last_notice_at=NULL,last_seen_new_at=NULL,last_seen_news_at=NULL
    WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?`,
   id,user.id,this.clock());
  if(!reset.changes)throw new HTTPException(404);
  await this.store.batch([this.auditStatement(user.id,'codex_notice_test_reset',{token_id:id})]);
  return {ok:true};
 }
 /** New published company resources since this token last asked; own department first. */
 async whatsNew(user:User&{department_id?:string|null},tokenId:string){
  const t=this.clock(),row=(await this.store.one<{last_seen_new_at:number|null;created_at:number}>('SELECT last_seen_new_at,created_at FROM agent_tokens WHERE id=?',tokenId))!;
  // last_seen_new_at is stored in milliseconds so items created in the same second are not repeated.
  const sinceIso=new Date(row.last_seen_new_at??(row.created_at-14*86400)*1000).toISOString();
  const items=await this.store.all<Record<string,any>>(`SELECT r.id,r.title,r.description,d.name department_name,u.name creator_name,r.created_at FROM resources r JOIN users u ON u.id=r.creator_id LEFT JOIN departments d ON d.id=r.department_id
   WHERE r.status='published' AND r.visibility='company' AND r.created_at>? ORDER BY CASE WHEN r.department_id IS NOT NULL AND r.department_id=? THEN 0 ELSE 1 END,r.created_at DESC LIMIT 5`,sinceIso,user.department_id??null);
  await this.store.run('UPDATE agent_tokens SET last_seen_new_at=MAX(COALESCE(last_seen_new_at,0),?) WHERE id=?',Math.max(Date.now(),t*1000),tokenId);
  return {since:sinceIso,items:items.map(r=>({id:r.id,title:String(r.title).slice(0,100),department:r.department_name??null,creator:r.creator_name,portal_url:this.config.origin+'/#/resource/'+r.id}))};
 }
 /** Up to 2 news items published after what this PC last saw; first call looks back 3 days. */
 async freshNews(tokenId:string,items:{title:string;url:string;source:string;published_at:string|null;summary?:string}[]){
  const row=(await this.store.one<{last_seen_news_at:string|null;created_at:number}>('SELECT last_seen_news_at,created_at FROM agent_tokens WHERE id=?',tokenId))!;
  const since=row.last_seen_news_at??new Date((row.created_at-3*86400)*1000).toISOString();
  const fresh=items.filter(n=>n.published_at&&n.published_at>since).slice(0,2);
  const newest=items.reduce((m,n)=>n.published_at&&n.published_at>m?n.published_at:m,since);
  if(newest>since)await this.store.run('UPDATE agent_tokens SET last_seen_news_at=? WHERE id=? AND (last_seen_news_at IS NULL OR last_seen_news_at<?)',newest,tokenId,newest);
  return fresh.map(n=>({title:n.title,source:n.source,url:n.url}));
 }
 /** Admin-set frequency for Codex notices: 'weekly' (default) or 'daily'. */
 async noticeInterval(){return ((await this.store.one<{value:string}>("SELECT value FROM portal_settings WHERE key='codex.notice_interval'"))?.value==='daily')?'daily':'weekly' as 'daily'|'weekly';}
 async setNoticeInterval(user:User,value:unknown){
  if(user.role!=='admin')throw new HTTPException(403);if(value!=='daily'&&value!=='weekly')throw new HTTPException(400);
  await this.store.batch([["INSERT INTO portal_settings(key,value,updated_at) VALUES ('codex.notice_interval',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",value,new Date(this.clock()*1000).toISOString()],this.auditStatement(user.id,'codex_notice_interval',{value})]);return {interval:value};
 }
 /** True once per JST day/week per PC; marks the period as used. */
 async takeNotice(tokenId:string){
  const t=this.clock()*1000,jst=9*3600000,day=Math.floor((t+jst)/86400000);
  const period=(await this.noticeInterval())==='daily'?`d${day}`:`w${Math.floor((day+3)/7)}`; // weeks start on Monday (JST)
  const row=await this.store.one<{id:string}>('UPDATE agent_tokens SET last_notice_at=? WHERE id=? AND last_notice_at IS NOT ? AND revoked_at IS NULL AND expires_at>? RETURNING id',period,tokenId,period,this.clock());
  return !!row;
 }
 async logUsage(user:User,resourceId:string,action:'read'|'suggested'){
  await this.store.run("INSERT INTO resource_usage(id,user_id,resource_id,via,action,created_at) VALUES (?,?,?,'codex',?,?)",randomUUID(),user.id,resourceId,action,this.clock());
 }
 private auditStatement(actor:string,action:string,detail:Record<string,unknown>){
  return ['INSERT INTO audit(id,actor_id,action,resource_id,detail,created_at) VALUES (?,?,?,NULL,?,?)',randomUUID(),actor,action,JSON.stringify(detail),new Date(this.clock()*1000).toISOString()] as const;
 }
}
const iso=(s:number)=>new Date(s*1000).toISOString();

export function setupPrompt(origin:string,code:string){
 return [
  'JOPT業務ポータルとCodexの連携を設定してください。',
  'まず、以下のコマンドをPowerShellで実行してセットアップファイルを一時フォルダーに保存してください。この手順はダウンロードだけです。',
  '表示されたパスの .ps1 を Get-Content -LiteralPath で最後まで読んでください。ポータルへの通信と、連携キー・config.toml・AGENTS.md への変更を確認し、Get-FileHash -Algorithm SHA256 でファイルのハッシュを記録してください。',
  '内容を確認できた場合だけ、別の実行で SHA256 が確認時と一致することを確かめ、その同じローカルファイルを PowerShell の & 演算子で実行してください。実行ポリシーなどにより許可されない場合は、設定を変更せずに止めてください。',
  '成功したかを日本語で短く報告してください。失敗した場合は、止まった手順とエラーの種類を報告してください。セットアップコードやトークンは報告に含めないでください。',
  '',
  '```powershell',
  '$setupFile = Join-Path ([IO.Path]::GetTempPath()) ("jopt-codex-" + [IO.Path]::GetRandomFileName() + ".ps1")',
  `Invoke-WebRequest -UseBasicParsing -Uri '${origin}/setup.ps1?code=${code}' -OutFile $setupFile -ErrorAction Stop`,
  'Write-Output $setupFile',
  '```',
 ].join('\n');
}

/** Windows PowerShell 5.1 compatible template in src/codex-setup.ps1. Writes UTF-8 without BOM and is idempotent. */
export function setupScript(template:string,origin:string,code:string){
 if(!CODE.test(code))throw Error('invalid code');
 if(!/^https?:\/\/[A-Za-z0-9.\-\[\]:]+$/.test(origin))throw Error('invalid origin');
 return template.replaceAll('__PORTAL_ORIGIN__',origin).replaceAll('__SETUP_CODE__',code).replaceAll('__SERVER_NAME__',MCP_SERVER_NAME).replaceAll('__TOKEN_ENV__',TOKEN_ENV);
}
