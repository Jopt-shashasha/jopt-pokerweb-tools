// Google OIDC + host-only session/CSRF flow adapted from JOPT drop's server/auth.ts.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie,setCookie,deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import * as oauth from 'oauth4webapi';
import { commit, rateLimit, requireSql, type Database, type Statement } from './database.js';
import { digest } from './blob-store.js';
import { epoch,now,type Config,type User } from './model.js';
export type AppEnv={Variables:{user:User;csrf:string}};
type Ctx=Context<AppEnv>;
const secret=()=>randomBytes(32).toString('hex');
export const SESSION_POLICY={idleSeconds:30*86400,absoluteSeconds:90*86400,renewAfterSeconds:86400} as const;
type BrowserSession=User&{csrf:string;token_hash:string;session_created_at:number;renewed_at:number;expires_at:number};
export class Auth {
 private discovery?:Promise<oauth.AuthorizationServer>;
 constructor(private db:Database,readonly config:Config,private clock:()=>number=epoch){}
 private cookieName(kind:string){return `${this.config.localDev?'':'__Host-'}portal-${kind}`;}
 private set(c:Ctx,kind:string,value:string,age:number){setCookie(c,this.cookieName(kind),value,{httpOnly:true,secure:!this.config.localDev,sameSite:'Lax',path:'/',maxAge:age});}
 private clear(c:Ctx,kind:string){deleteCookie(c,this.cookieName(kind),{httpOnly:true,secure:!this.config.localDev,sameSite:'Lax',path:'/'});}
 async session(c:Ctx){
  const token=getCookie(c,this.cookieName('session'));if(!token)return null;
  const t=this.clock(),hash=digest(token);
  const s=await this.db.one<BrowserSession>(`SELECT u.*,s.csrf,s.token_hash,s.created_at session_created_at,s.renewed_at,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND s.created_at>? AND u.active=1`,hash,t,t-SESSION_POLICY.absoluteSeconds);
  if(!s){await this.db.run('DELETE FROM sessions WHERE token_hash=?',hash);this.clear(c,'session');return null;}
  if(s.renewed_at===0||t-s.renewed_at>=SESSION_POLICY.renewAfterSeconds){
   s.expires_at=Math.min(t+SESSION_POLICY.idleSeconds,s.session_created_at+SESSION_POLICY.absoluteSeconds);
   await this.db.run('UPDATE sessions SET expires_at=?,renewed_at=? WHERE token_hash=?',s.expires_at,t,hash);
   this.set(c,'session',token,s.expires_at-t);
  }
  return s;
 }
 async require(c:Ctx,mutation=false){
  const s=await this.session(c);if(!s)throw new HTTPException(401,{message:'Googleアカウントでログインしてください。'});
  if(mutation){this.origin(c);if(c.req.header('x-csrf-token')!==s.csrf)throw new HTTPException(403,{message:'操作の有効期限が切れました。再読み込みしてください。'});}
  c.set('user',s);c.set('csrf',s.csrf);return s;
 }
 origin(c:Ctx){if(c.req.header('origin')!==this.config.origin)throw new HTTPException(403,{message:'操作元を確認できません。'});}
 private async newSession(c:Ctx,id:string){
  const token=secret(),t=this.clock(),previous=getCookie(c,this.cookieName('session'));
  const statements:Statement[]=[['DELETE FROM sessions WHERE expires_at<=? OR created_at<=?',t,t-SESSION_POLICY.absoluteSeconds]];
  if(previous)statements.push(['DELETE FROM sessions WHERE token_hash=?',digest(previous)]);
  statements.push(['INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at,renewed_at) VALUES (?,?,?,?,?,?)',digest(token),id,secret(),t+SESSION_POLICY.idleSeconds,t,t]);
  await this.db.batch(statements);
  this.set(c,'session',token,SESSION_POLICY.idleSeconds);
 }
 async logout(c:Ctx){const s=await this.require(c,true);await this.db.run('DELETE FROM sessions WHERE token_hash=?',s.token_hash);this.clear(c,'session');return c.json({ok:true});}
 async localLogin(c:Ctx){
  if(!this.config.localDev)throw new HTTPException(404);this.origin(c);
  if(c.req.header('x-portal-local')!=='1')throw new HTTPException(403);
  await this.db.run("INSERT INTO users(id,email,name,role,created_at) VALUES (?,?,?,'admin',?) ON CONFLICT(email) DO UPDATE SET role='admin'",randomUUID(),this.config.adminEmail,'Han XIAO',now());
  const user=await this.db.one<User>('SELECT * FROM users WHERE email=? AND active=1',this.config.adminEmail);
  if(!user)throw new HTTPException(403);
  await this.newSession(c,user.id);
  return c.json({ok:true});
 }
 private server(){return this.discovery??=oauth.discoveryRequest(new URL('https://accounts.google.com')).then(r=>oauth.processDiscoveryResponse(new URL('https://accounts.google.com'),r)).catch(e=>{this.discovery=undefined;throw e;});}
 private configured(){
  if(!this.config.googleClientId||!this.config.googleClientSecret)throw new HTTPException(503,{message:'Googleログインの接続設定が必要です。'});
  // Real OIDC can be verified locally; the development identity remains loopback-only.
  if(this.config.localDev){const u=new URL(this.config.origin);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1')throw new HTTPException(503,{message:'ローカル検証はこのPC内の接続だけを使用してください。'});}
 }
 async google(c:Ctx){
  this.configured();
  await rateLimit(this.db,'google:'+ (c.req.header('cf-connecting-ip')??'single-node'),this.clock());
  const state=secret(),browser=secret(),verifier=oauth.generateRandomCodeVerifier(),nonce=secret();
  const time=this.clock();
  await this.db.batch([
   ['DELETE FROM oauth_requests WHERE expires_at<=?',time],
   ['INSERT INTO oauth_requests VALUES (?,?,?,?,?)',state,digest(browser),verifier,nonce,time+600]
  ]);
  this.set(c,'oauth',browser,600);
  const as=await this.server();const url=new URL(as.authorization_endpoint!);
  url.search=new URLSearchParams({client_id:this.config.googleClientId!,response_type:'code',scope:'openid email profile',redirect_uri:this.config.origin+'/auth/callback',state,nonce,code_challenge:await oauth.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256',hd:'*'}).toString();return c.redirect(url.href,302);
 }
 async callback(c:Ctx){
  this.configured();const state=c.req.query('state'),browser=getCookie(c,this.cookieName('oauth'));if(!state||!browser)throw new HTTPException(403,{message:'ログインをやり直してください。'});
  const r=await this.db.one<{verifier:string;nonce:string}>('DELETE FROM oauth_requests WHERE state=? AND browser_hash=? AND expires_at>? RETURNING verifier,nonce',state,digest(browser),this.clock());this.clear(c,'oauth');if(!r)throw new HTTPException(403,{message:'ログインの有効期限が切れました。'});
  const as=await this.server(),client={client_id:this.config.googleClientId!};
  const params=oauth.validateAuthResponse(as,client,new URL(c.req.url),state);
  const response=await oauth.authorizationCodeGrantRequest(as,client,oauth.ClientSecretPost(this.config.googleClientSecret!),params,this.config.origin+'/auth/callback',r.verifier);
  const result=await oauth.processAuthorizationCodeResponse(as,client,response,{expectedNonce:r.nonce,requireIdToken:true});await oauth.validateApplicationLevelSignature(as,response);
  const claims=oauth.getValidatedIdTokenClaims(result);if(!claims)throw new HTTPException(403);
  const u=await this.verifiedUser(claims as Record<string,unknown>);await this.newSession(c,u.id);return c.redirect('/',303);
 }
 async verifiedUser(claims:Record<string,unknown>):Promise<User>{
  const email=typeof claims.email==='string'?claims.email.toLowerCase():'';
  const domain=email.split('@')[1];if(claims.email_verified!==true||!domain||claims.hd!==domain||!this.config.allowedDomains.includes(domain)||typeof claims.sub!=='string'||!claims.sub)throw new HTTPException(403,{message:'会社のGoogleアカウントを使用してください。'});
  const sub=claims.sub;
  const name=typeof claims.name==='string'?claims.name:email;
  const statements:Statement[]=[
   requireSql('NOT EXISTS(SELECT 1 FROM users WHERE (email=? AND (active<>1 OR (google_sub IS NOT NULL AND google_sub<>?))) OR (google_sub=? AND email<>?))',email,sub,sub,email),
   ['INSERT INTO users(id,email,name,google_sub,created_at) VALUES (?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET google_sub=excluded.google_sub',randomUUID(),email,name,sub,now()]
  ];
  if(email===this.config.adminEmail)statements.push(["UPDATE users SET role='admin' WHERE email=? AND NOT EXISTS(SELECT 1 FROM users WHERE role='admin')",email]);
  try{
   await commit(this.db,statements,'アカウントを確認できません。管理者に確認してください。');
  }catch(error){
   if(error instanceof HTTPException&&error.status===409)throw new HTTPException(403,{message:error.message});
   throw error;
  }
  const user=await this.db.one<User>('SELECT * FROM users WHERE email=? AND google_sub=? AND active=1',email,sub);
  if(!user)throw new HTTPException(403,{message:'アカウントを確認できません。'});
  return user;
 }
}
