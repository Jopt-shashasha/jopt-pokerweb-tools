import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { digest } from '../src/blob-store.js';
import { D1Store } from '../src/d1.js';
import { Catalog } from '../src/repository.js';
import { Slack } from '../src/slack.js';
import type { Config, User } from '../src/model.js';

const origin = 'https://portal.test';
const migrationDir = new URL('../dist/.openai/drizzle/', import.meta.url);
const migrations = (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort();

test('Site Worker uses D1 and R2 for resources, authenticated MCP, and duplicate-safe Slack sends', async () => {
 const mf = new Miniflare({
  modules: true, scriptPath: 'dist/server/index.js', compatibilityDate: '2026-07-30',
  compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['BUCKET'],
  bindings: { APP_ORIGIN: origin, NEWS_FEED_URLS: '' }
 });
 try {
  const db = await mf.getD1Database('DB');
  for (const name of migrations) {
   const sql = await readFile(new URL(name, migrationDir), 'utf8');
   await db.batch(sql.split('--> statement-breakpoint').map(statement => db.prepare(statement.trim())));
  }
  const store = new D1Store(db);
  async function account(name: string, role: 'admin' | 'user') {
   const user: User = { id: randomUUID(), email: name+'@japanopenpoker.com', name, role, google_sub: null, active: 1 };
   const t = Math.floor(Date.now()/1000), token = randomUUID(), csrf = randomUUID();
   await store.batch([
    ['INSERT INTO users (id,email,name,role,created_at) VALUES(?,?,?,?,?)',user.id,user.email,user.name,user.role,new Date().toISOString()],
    ['INSERT INTO sessions (token_hash,user_id,csrf,expires_at,created_at,renewed_at) VALUES(?,?,?,?,?,?)',digest(token),user.id,csrf,t+3600,t,t]
   ]);
   return { user, headers: { cookie: '__Host-portal-session='+token, origin, 'x-csrf-token': csrf } };
  }
  const owner = await account('owner', 'admin'), reader = await account('reader', 'user');
  const request = (path: string, init?: RequestInit) => mf.dispatchFetch(origin+path, init as Parameters<typeof mf.dispatchFetch>[1]);
  const write = (method: string, path: string, data: unknown, headers: Record<string,string>={}) => request(path,{method,headers:{...headers,'content-type':'application/json'},body:JSON.stringify(data)});
  const input = { title: 'Voucher', url: 'https://example.com/voucher', tags: ['Voucher'], status: 'published', visibility: 'company', impact: {audience:'カスタマー',task:'Voucher照合',before:'5分',after:'30秒',frequency:'毎日'} };
  for (const path of ['/', '/app.js', '/style.css', '/health']) assert.equal((await request(path)).status,200,path);
  assert.equal((await request('/auth/google')).status,503);
  assert.equal((await write('POST','/auth/local',{})).status,404);
  assert.equal((await request('/api/resources')).status,401);
  assert.equal((await write('POST','/api/resources',{title:'missing URL'},owner.headers)).status,400);
  const res = await write('POST','/api/resources',input,owner.headers);
  assert.equal(res.status,201,await res.clone().text());
  const shared: any = await res.json();
  const privateResponse = await write('POST','/api/resources',{...input,title:'Voucher confidential',visibility:'private'},owner.headers);
  assert.equal(privateResponse.status,201);
  const secret: any = await privateResponse.json();
  const objectId = randomUUID();
  const bucket = await mf.getR2Bucket('BUCKET');
  const image = Uint8Array.from([137,80,78,71,13,10,26,10]);
  await bucket.put(objectId,image);
  await store.run('UPDATE resources SET preview_blob=? WHERE id=?',objectId,secret.id);
  const previewPath = '/api/resources/'+secret.id+'/preview-image';
  assert.equal((await request(previewPath,{headers:reader.headers})).status,404);
  const preview = await request(previewPath,{headers:owner.headers});
  assert.equal(preview.status,200);
  assert.deepEqual(new Uint8Array(await preview.arrayBuffer()),image);
  const changes = await Promise.all(['first','second'].map(description => write('PUT','/api/resources/'+shared.id,{...input,description,version:shared.version},owner.headers)));
  assert.deepEqual(changes.map(r=>r.status).sort(),[200,409]);
  const redirect = await request('/go/'+shared.id+'?to=https://example.com',{redirect:'manual'});
  assert.equal(redirect.headers.get('location'),'/#/resource/'+shared.id);

  const setup: any = await (await request('/api/codex/setup',{method:'POST',headers:reader.headers})).json();
  const code = setup.prompt.match(/code=([a-f0-9]{32})/)[1];
  assert.ok((await (await request('/setup.ps1?code='+code)).text()).includes(origin));
  const exchanges = await Promise.all([1,2].map(() => write('POST','/setup/exchange',{code,label:'D1 test'})));
  assert.deepEqual(exchanges.map(r=>r.status).sort(),[200,404]);
  const { token, mcp_url }: any = await exchanges.find(r=>r.status===200)!.json();
  assert.equal(mcp_url,origin+'/portal-mcp');
  const client = new Client({ name: 'worker-test', version:'1' });
  const transport = new StreamableHTTPClientTransport(new URL(mcp_url),{
   requestInit:{headers:{authorization:'Bearer '+token}},
   fetch: ((url,init) => mf.dispatchFetch(String(url),init as Parameters<typeof mf.dispatchFetch>[1])) as typeof fetch
  });
  try {
   await client.connect(transport);
   const registration = (await client.listTools()).tools.find(tool=>tool.name==='portal_register_link')!;
   assert.match(registration.description!,/before and after/);
   async function call(name: string, args: Record<string,unknown>) {
    const result = await client.callTool({name,arguments:args});
    assert.notEqual(result.isError,true,JSON.stringify(result));
    return JSON.parse((result.content as {text:string}[])[0].text);
   }
   assert.equal((await call('portal_search',{q:'Voucher'})).total,1);
   const pending = await call('portal_register_link',{title:'Test MCP',url:'https://example.com/mcp',description:'Link only'});
   const id = new URL(pending.browser_url).hash.split('/').at(-1);
   const execute = '/api/agent/requests/'+id+'/execute';
   assert.equal((await write('POST',execute,{},owner.headers)).status,404);
   const executions = await Promise.all([1,2].map(() => write('POST',execute,{},reader.headers)));
   assert.deepEqual(executions.map(r=>r.status),[200,200]);
   assert.equal((await store.one<{n:number}>("SELECT COUNT(*) n FROM resources WHERE title='Test MCP'"))?.n,1);
   const tokens: any = await (await request('/api/codex/tokens',{headers:reader.headers})).json();
   assert.equal((await request('/api/codex/tokens/'+tokens.items[0].id,{method:'DELETE',headers:reader.headers})).status,200);
   assert.equal((await request('/setup/whoami',{headers:{authorization:'Bearer '+token}})).status,401);
  } finally { await client.close(); }

  const config: Config = { origin,localDev:false,dataDir:'',adminEmail:owner.user.email,allowedDomains:['japanopenpoker.com'],newsFeeds:[],slackBotToken:'test-only' };
  let called = 0;
  const slack = new Slack(store,config,new Catalog(store),async () => {
   called++;
   throw new Error('Simulated Slack timeout');
  });
  await slack.updateSettings(owner.user,{test_channel_id:'C012345678',test_channel_name:'test'});
  const outcomes = await Promise.allSettled([1,2].map(()=>slack.introSend(owner.user,shared.id,{channel_id:'C012345678'})));
  assert.equal(called,1);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await store.one<{state:string}>('SELECT state FROM slack_posts'))?.state,'unknown');
  await assert.rejects(slack.introSend(owner.user,shared.id,{channel_id:'C012345678',force:true}));
  assert.equal(called,1);
 } finally { await mf.dispose(); }
});

