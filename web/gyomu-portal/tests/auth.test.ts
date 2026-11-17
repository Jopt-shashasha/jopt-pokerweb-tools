import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,mkdir,readFile,rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Auth,SESSION_POLICY,type AppEnv } from '../src/auth.js';
import { Store } from '../src/db.js';
import { digest } from '../src/storage.js';
import type { Config } from '../src/model.js';

const config:Config={origin:'http://127.0.0.1:8788',localDev:true,dataDir:'unused',adminEmail:'admin@japanopenpoker.com',allowedDomains:['japanopenpoker.com'],newsFeeds:[]};
const initial=1794787200,day=86400;
function harness(store:Store,clock:()=>number,cfg=config){
 const auth=new Auth(store,cfg,clock),app=new Hono<AppEnv>();
 app.post('/login',c=>auth.localLogin(c));
 app.post('/logout',c=>auth.logout(c));
 app.get('/me',c=>{const s=auth.require(c);return c.json({id:s.id,csrf:s.csrf,expires_at:s.expires_at});});
 return {auth,request:(path:string,init?:RequestInit)=>app.request(cfg.origin+path,init)};
}
function cookieFrom(res:Response){const cookie=res.headers.get('set-cookie');assert.ok(cookie);return cookie.split(';')[0];}
async function login(h:ReturnType<typeof harness>,previous?:string){
 const res=await h.request('/login',{method:'POST',headers:{origin:config.origin,'x-portal-local':'1',...(previous?{cookie:previous}:{})}});
 assert.equal(res.status,200);return {cookie:cookieFrom(res),res};
}

test('persistent browser sessions are independent; relogin rotates only this browser and logout revokes it',async()=>{
 const db=new Store(':memory:');try{
  const h=harness(db,()=>initial),first=await login(h),second=await login(h);
  assert.match(first.res.headers.get('set-cookie')!,new RegExp('Max-Age='+SESSION_POLICY.idleSeconds));
  assert.match(first.res.headers.get('set-cookie')!,/HttpOnly/);assert.match(first.res.headers.get('set-cookie')!,/SameSite=Lax/);
  assert.notEqual(first.cookie,second.cookie);
  const rotated=await login(h,first.cookie);
  assert.equal((await h.request('/me',{headers:{cookie:first.cookie}})).status,401);
  assert.equal((await h.request('/me',{headers:{cookie:second.cookie}})).status,200);
  const me=await (await h.request('/me',{headers:{cookie:rotated.cookie}})).json() as {csrf:string};
  assert.equal((await h.request('/logout',{method:'POST',headers:{cookie:rotated.cookie,origin:config.origin}})).status,403);
  const out=await h.request('/logout',{method:'POST',headers:{cookie:rotated.cookie,origin:config.origin,'x-csrf-token':me.csrf}});
  assert.equal(out.status,200);assert.match(out.headers.get('set-cookie')!,/Max-Age=0/);
  assert.equal((await h.request('/me',{headers:{cookie:rotated.cookie}})).status,401);
  assert.equal((await h.request('/me',{headers:{cookie:second.cookie}})).status,200);
  const row=db.one<{token_hash:string}>('SELECT token_hash FROM sessions')!;
  assert.equal(row.token_hash,digest(second.cookie.split('=')[1]));assert.ok(!row.token_hash.includes(second.cookie.split('=')[1]));
 }finally{db.close();}
});

test('activity renews at most daily and never exceeds 90 days even with daily use',async()=>{
 const db=new Store(':memory:');let t=initial;try{
  const h=harness(db,()=>t),{cookie}=await login(h);
  t+=60;assert.equal((await h.request('/me',{headers:{cookie}})).headers.get('set-cookie'),null);
  for(let n=1;n<90;n++){
   t=initial+n*day;
   const res=await h.request('/me',{headers:{cookie}});assert.equal(res.status,200);
   const expected=Math.min(t+SESSION_POLICY.idleSeconds,initial+SESSION_POLICY.absoluteSeconds);
   assert.equal((await res.json() as {expires_at:number}).expires_at,expected);
   assert.match(res.headers.get('set-cookie')!,new RegExp('Max-Age='+(expected-t)+'(?:;|$)'));
  }
  t=initial+90*day;const expired=await h.request('/me',{headers:{cookie}});
  assert.equal(expired.status,401);assert.match(expired.headers.get('set-cookie')!,/Max-Age=0/);
  assert.equal(db.one<{n:number}>('SELECT COUNT(*) n FROM sessions')?.n,0);
 }finally{db.close();}
});

test('30 days of inactivity and account deactivation reject saved browser cookies',async()=>{
 const db=new Store(':memory:');let t=initial;try{
  const h=harness(db,()=>t),old=await login(h);t+=30*day;
  assert.equal((await h.request('/me',{headers:{cookie:old.cookie}})).status,401);
  const fresh=await login(h);db.run('UPDATE users SET active=0');
  assert.equal((await h.request('/me',{headers:{cookie:fresh.cookie}})).status,401);
 }finally{db.close();}
});

test('saved browser session survives database reopen; production renewal sets host-only secure cookie',async()=>{
 const parent=resolve('.local');await mkdir(parent,{recursive:true});const dir=await mkdtemp(resolve(parent,'auth-test-'));const file=resolve(dir,'portal.sqlite');
 let db:Store|undefined;try{
  db=new Store(file);const first=await login(harness(db,()=>initial));db.close();db=undefined;
  db=new Store(file);const h=harness(db,()=>initial+day);
  assert.equal((await h.request('/me',{headers:{cookie:first.cookie}})).status,200);
  const prod=harness(db,()=>initial+2*day,{...config,origin:'https://portal.test',localDev:false});
  const res=await prod.request('/me',{headers:{cookie:first.cookie.replace(/^portal-session=/,'__Host-portal-session=')}});
  assert.equal(res.status,200);assert.match(res.headers.get('set-cookie')!,/^__Host-portal-session=/);
  assert.match(res.headers.get('set-cookie')!,/Secure/);assert.match(res.headers.get('set-cookie')!,/HttpOnly/);
  assert.match(res.headers.get('set-cookie')!,/Path=\//);assert.doesNotMatch(res.headers.get('set-cookie')!,/Domain=/);
 }finally{db?.close();assert.equal(resolve(dir,'..'),parent);await rm(dir,{recursive:true,force:true});}
});

test('legacy one-hour sessions migrate without reviving expired logins or changing resource data',async()=>{
 const parent=resolve('.local');await mkdir(parent,{recursive:true});const dir=await mkdtemp(resolve(parent,'auth-migration-'));const file=resolve(dir,'portal.sqlite');
 let db:Store|undefined;try{
  const legacy=new DatabaseSync(file);
  legacy.exec(await readFile(new URL('../migrations/001_core.sql',import.meta.url),'utf8'));
  legacy.exec("CREATE TABLE migrations(name TEXT PRIMARY KEY); INSERT INTO migrations VALUES ('001_core.sql')");
  legacy.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('legacy',config.adminEmail,'Legacy','2026-11-16');
  legacy.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest('valid'),'legacy','csrf',initial+1800);
  legacy.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest('expired'),'legacy','csrf',initial-1);
  legacy.close();db=new Store(file);const h=harness(db,()=>initial);
  const valid=await h.request('/me',{headers:{cookie:'portal-session=valid'}});
  assert.equal(valid.status,200);assert.equal((await valid.json() as {expires_at:number}).expires_at,initial+SESSION_POLICY.idleSeconds);
  assert.equal((await h.request('/me',{headers:{cookie:'portal-session=expired'}})).status,401);
  assert.equal(db.one<{n:number}>('SELECT COUNT(*) n FROM users')?.n,1);
  assert.equal(db.one<{n:number}>('SELECT COUNT(*) n FROM resources')?.n,0);
 }finally{db?.close();assert.equal(resolve(dir,'..'),parent);await rm(dir,{recursive:true,force:true});}
});
