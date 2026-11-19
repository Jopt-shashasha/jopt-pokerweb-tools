// Google OIDC + host-only session/CSRF flow adapted from JOPT drop's server/auth.ts.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie,setCookie,deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import * as oauth from 'oauth4webapi';
import { Store } from './db.js';
import { digest } from './storage.js';
import { epoch,now,type Config,type User } from './model.js';
export type AppEnv={Variables:{user:User;csrf:string}};
type Ctx=Context<AppEnv>;
const secret=()=>randomBytes(32).toString('hex');
export const SESSION_POLICY={idleSeconds:30*86400,absoluteSeconds:90*86400,renewAfterSeconds:86400} as const;
type BrowserSession=User&{csrf:string;token_hash:string;session_created_at:number;renewed_at:number;expires_at:number};
export class Auth {
 private discovery?:Promise<oauth.AuthorizationServer>;
 private attempts=new Map<string,{count:number;until:number}>();
 constructor(private db:Store,readonly config:Config,private clock:()=>number=epoch){}
 private cookieName(kind:string){return `${this.config.localDev?'':'__Host-'}portal-${kind}`;}
 private set(c:Ctx,kind:string,value:string,age:number){setCookie(c,this.cookieName(kind),value,{httpOnly:true,secure:!this.config.localDev,sameSite:'Lax',path:'/',maxAge:age});}
 private clear(c:Ctx,kind:string){deleteCookie(c,this.cookieName(kind),{httpOnly:true,secure:!this.config.localDev,sameSite:'Lax',path:'/'});}
 session(c:Ctx){
  const token=getCookie(c,this.cookieName('session'));if(!token)return null;
  const t=this.clock(),hash=digest(token);
  const s=this.db.one<BrowserSession>(`SELECT u.*,s.csrf,s.token_hash,s.created_at session_created_at,s.renewed_at,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND s.created_at>? AND u.active=1`,hash,t,t-SESSION_POLICY.absoluteSeconds);
  if(!s){this.db.run('DELETE FROM sessions WHERE token_hash=?',hash);this.clear(c,'session');return null;}
  if(s.renewed_at===0||t-s.renewed_at>=SESSION_POLICY.renewAfterSeconds){
   s.expires_at=Math.min(t+SESSION_POLICY.idleSeconds,s.session_created_at+SESSION_POLICY.absoluteSeconds);
   this.db.run('UPDATE sessions SET expires_at=?,renewed_at=? WHERE token_hash=?',s.expires_at,t,hash);
   this.set(c,'session',token,s.expires_at-t);
  }
  return s;
 }
 require(c:Ctx,mutation=false){
  const s=this.session(c);if(!s)throw new HTTPException(401,{message:'Googleアカウントでログインしてください。'});
  if(mutation){this.origin(c);if(c.req.header('x-csrf-token')!==s.csrf)throw new HTTPException(403,{message:'操作の有効期限が切れました。再読み込みしてください。'});}
  c.set('user',s);c.set('csrf',s.csrf);return s;
 }
 origin(c:Ctx){if(c.req.header('origin')!==this.config.origin)throw new HTTPException(403,{message:'操作元を確認できません。'});}
 private newSession(c:Ctx,id:string){
  const token=secret(),t=this.clock(),previous=getCookie(c,this.cookieName('session'));
  this.db.transaction(()=>{
   this.db.run('DELETE FROM sessions WHERE expires_at<=? OR created_at<=?',t,t-SESSION_POLICY.absoluteSeconds);
   // Signing in again replaces this browser's old session, not other browsers.
   if(previous)this.db.run('DELETE FROM sessions WHERE token_hash=?',digest(previous));
   this.db.run('INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at,renewed_at) VALUES (?,?,?,?,?,?)',digest(token),id,secret(),t+SESSION_POLICY.idleSeconds,t,t);
  });
  this.set(c,'session',token,SESSION_POLICY.idleSeconds);
 }
 logout(c:Ctx){const s=this.require(c,true);this.db.run('DELETE FROM sessions WHERE token_hash=?',s.token_hash);this.clear(c,'session');return c.json({ok:true});}
 localLogin(c:Ctx){
  if(!this.config.localDev)throw new HTTPException(404);this.origin(c);
  if(c.req.header('x-portal-local')!=='1')throw new HTTPException(403);
  let u=this.db.one<User>('SELECT * FROM users WHERE email=?',this.config.adminEmail);
  if(!u){const id=randomUUID();this.db.run("INSERT INTO users(id,email,name,role,created_at) VALUES (?,?,?,'admin',?)",id,this.config.adminEmail,'Han XIAO',now());u=this.db.one<User>('SELECT * FROM users WHERE id=?',id)!;}
  this.db.run("UPDATE users SET role='admin' WHERE id=?",u.id);this.newSession(c,u.id);return c.json({ok:true});
 }
 private server(){return this.discovery??=oauth.discoveryRequest(new URL('https://accounts.google.com')).then(r=>oauth.processDiscoveryResponse(new URL('https://accounts.google.com'),r)).catch(e=>{this.discovery=undefined;throw e;});}
 private configured(){
  if(!this.config.googleClientId||!this.config.googleClientSecret)throw new HTTPException(503,{message:'Googleログインの接続設定が必要です。'});
  // Real OIDC can be verified locally; the development identity remains loopback-only.
  if(this.config.localDev){const u=new URL(this.config.origin);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1')throw new HTTPException(503,{message:'ローカル検証はこのPC内の接続だけを使用してください。'});}
 }
 async google(c:Ctx){
  this.configured();const key=c.req.header('x-forwarded-for')??'single-node';const t=this.attempts.get(key);
  if(t&&t.until>epoch()&&t.count>=20)throw new HTTPException(429,{message:'しばらく待ってからログインしてください。'});
  if(this.attempts.size>10000)this.attempts.clear();this.attempts.set(key,{count:t&&t.until>epoch()?t.count+1:1,until:epoch()+60});
  const state=secret(),browser=secret(),verifier=oauth.generateRandomCodeVerifier(),nonce=secret();
  this.db.run('DELETE FROM oauth_requests WHERE expires_at<=?',epoch());
  this.db.run('INSERT INTO oauth_requests VALUES (?,?,?,?,?)',state,digest(browser),verifier,nonce,epoch()+600);this.set(c,'oauth',browser,600);
  const as=await this.server();const url=new URL(as.authorization_endpoint!);
  url.search=new URLSearchParams({client_id:this.config.googleClientId!,response_type:'code',scope:'openid email profile',redirect_uri:this.config.origin+'/auth/callback',state,nonce,code_challenge:await oauth.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256',hd:'*'}).toString();return c.redirect(url.href,302);
 }
 async callback(c:Ctx){
  this.configured();const state=c.req.query('state'),browser=getCookie(c,this.cookieName('oauth'));if(!state||!browser)throw new HTTPException(403,{message:'ログインをやり直してください。'});
  const r=this.db.one<{verifier:string;nonce:string}>('DELETE FROM oauth_requests WHERE state=? AND browser_hash=? AND expires_at>? RETURNING verifier,nonce',state,digest(browser),epoch());this.clear(c,'oauth');if(!r)throw new HTTPException(403,{message:'ログインの有効期限が切れました。'});
  const as=await this.server(),client={client_id:this.config.googleClientId!};
  const params=oauth.validateAuthResponse(as,client,new URL(c.req.url),state);
  const response=await oauth.authorizationCodeGrantRequest(as,client,oauth.ClientSecretPost(this.config.googleClientSecret!),params,this.config.origin+'/auth/callback',r.verifier);
  const result=await oauth.processAuthorizationCodeResponse(as,client,response,{expectedNonce:r.nonce,requireIdToken:true});await oauth.validateApplicationLevelSignature(as,response);
  const claims=oauth.getValidatedIdTokenClaims(result);if(!claims)throw new HTTPException(403);
  const u=this.verifiedUser(claims as Record<string,unknown>);this.newSession(c,u.id);return c.redirect('/',303);
 }
 verifiedUser(claims:Record<string,unknown>):User{
  const email=typeof claims.email==='string'?claims.email.toLowerCase():'';
  const domain=email.split('@')[1];if(claims.email_verified!==true||!domain||claims.hd!==domain||!this.config.allowedDomains.includes(domain)||typeof claims.sub!=='string'||!claims.sub)throw new HTTPException(403,{message:'会社のGoogleアカウントを使用してください。'});
  const sub=claims.sub;
  return this.db.transaction(()=>{
   let user=this.db.one<User>('SELECT * FROM users WHERE email=?',email);
   if(user&&(!user.active||(user.google_sub&&user.google_sub!==sub)))throw new HTTPException(403,{message:'アカウントを確認できません。管理者に確認してください。'});
   if(!user){const id=randomUUID();this.db.run('INSERT INTO users(id,email,name,google_sub,created_at) VALUES (?,?,?,?,?)',id,email,typeof claims.name==='string'?claims.name:email,sub,now());user=this.db.one<User>('SELECT * FROM users WHERE id=?',id)!;}
   else this.db.run('UPDATE users SET google_sub=? WHERE id=?',sub,user.id);
   if(email===this.config.adminEmail&&!this.db.one("SELECT id FROM users WHERE role='admin'"))this.db.run("UPDATE users SET role='admin' WHERE id=?",user.id);
   return this.db.one<User>('SELECT * FROM users WHERE id=?',user.id)!;
  });
 }
}
