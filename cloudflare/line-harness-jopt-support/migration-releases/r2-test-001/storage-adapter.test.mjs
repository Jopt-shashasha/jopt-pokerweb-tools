import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { HarnessR2TestStorage } from './storage-adapter.mjs';

const selected = 'line-private/account-1/message-1/file.png';
const other = 'line-private/account-1/message-2/file.png';
const otherAccount = 'line-private/account-2/message-1/file.png';
const faq = 'faq-private/case-1/file.png';
const otherFaq = 'faq-private/case-2/file.png';
const bytes = new Uint8Array([137, 80, 78, 71]);
function store() {
  const data = new Map();
  return {
    data, calls: [], fail: new Set(),
    async put(key, value) {
      this.calls.push(['put', key]); if (this.fail.has('put')) throw Error('put failed');
      data.set(key, new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
    },
    async get(key) {
      this.calls.push(['get', key]); if (this.fail.has('get')) throw Error('get failed');
      const value = data.get(key); return value ? { arrayBuffer: async () => value.slice().buffer } : null;
    },
    async delete(key) {
      this.calls.push(['delete', key]); if (this.fail.has('delete')) throw Error('delete failed'); data.delete(key);
    },
    async list(options) { this.calls.push(['list', options]); return { objects: [...data.keys()].map(key => ({ key })), truncated: false }; }
  };
}
function setup(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(`CREATE TABLE line_incoming_images(account_id TEXT,message_id TEXT,line_user_id TEXT,storage_key TEXT,PRIMARY KEY(account_id,message_id));
    CREATE TABLE friends(id TEXT PRIMARY KEY,line_account_id TEXT,line_user_id TEXT);
    CREATE TABLE faq_cases(id TEXT PRIMARY KEY,account_id TEXT,friend_id TEXT);
    CREATE TABLE faq_case_uploads(case_id TEXT PRIMARY KEY,storage_key TEXT);`);
  const lineInsert = sql.prepare('INSERT INTO line_incoming_images VALUES(?,?,?,?)');
  lineInsert.run('account-1', 'message-1', 'user-test', selected);
  lineInsert.run('account-1', 'message-2', 'user-other', other);
  lineInsert.run('account-2', 'message-1', 'user-test', otherAccount);
  sql.exec(`INSERT INTO friends VALUES('friend-1','account-1','user-test'),('friend-2','account-1','user-other');
    INSERT INTO faq_cases VALUES('case-1','account-1','friend-1'),('case-2','account-1','friend-2');`);
  sql.prepare('INSERT INTO faq_case_uploads VALUES(?,?)').run('case-1', faq);
  sql.prepare('INSERT INTO faq_case_uploads VALUES(?,?)').run('case-2', otherFaq);
  const legacy = store(), r2 = store();
  const env = { R2_WRITE_MODE: 'test', R2_TEST_ACCOUNT_ID: 'account-1', R2_TEST_LINE_USER_ID: 'user-test',
    IMAGES_R2: r2, DB: { prepare: query => ({ bind: (...args) => ({ first: async () => sql.prepare(query).get(...args) }) }) } };
  return { legacy, r2, env, adapter: new HarnessR2TestStorage(env, legacy) };
}

test('only selected account/user writes both stores for direct LINE and FAQ images', async t => {
  const { adapter, legacy, r2 } = setup(t);
  for (const key of [selected, faq, other, otherFaq, otherAccount, 'uploads/video.mp4', selected.replace('file.png', 'unowned.png')]) await adapter.put(key, bytes);
  assert.deepEqual([...r2.data.keys()], [selected, faq]);
  assert.equal(legacy.data.size, 7);
  assert.deepEqual(new Uint8Array(await (await r2.get(selected)).arrayBuffer()), bytes);
});
test('missing identity or disabled mode writes only Appwrite', async t => {
  const { adapter, legacy, r2, env } = setup(t);
  env.R2_WRITE_MODE = 'off'; await adapter.put(selected, bytes);
  env.R2_WRITE_MODE = 'test'; delete env.R2_TEST_LINE_USER_ID; await adapter.put(faq, bytes);
  assert.equal(r2.data.size, 0); assert.equal(legacy.data.size, 2);
});
test('switching writes off preserves reads and original Appwrite-only rollback reads', async t => {
  const { adapter, legacy, r2, env } = setup(t);
  await adapter.put(selected, bytes); env.R2_WRITE_MODE = 'off';
  assert.deepEqual(new Uint8Array(await (await adapter.get(selected)).arrayBuffer()), bytes);
  assert.deepEqual(new Uint8Array(await (await legacy.get(selected)).arrayBuffer()), bytes);
  assert.ok(r2.calls.some(([operation]) => operation === 'get'));
});
test('old images, missing R2 objects and R2 errors fall back to Appwrite; other users never read R2', async t => {
  const { adapter, legacy, r2 } = setup(t);
  await legacy.put(selected, bytes); await legacy.put(other, bytes);
  assert.ok(await adapter.get(selected));
  r2.fail.add('get'); assert.ok(await adapter.get(selected));
  const calls = r2.calls.length; assert.ok(await adapter.get(other)); assert.equal(r2.calls.length, calls);
});
test('failed R2 upload is not reported complete; retry succeeds and Appwrite copy survives', async t => {
  const { adapter, legacy, r2 } = setup(t); r2.fail.add('put');
  await assert.rejects(adapter.put(selected, bytes)); assert.ok(await legacy.get(selected));
  r2.fail.clear(); await adapter.put(selected, bytes); assert.ok(await r2.get(selected));
});
test('failed Appwrite upload cannot complete an R2-only write', async t => {
  const { adapter, legacy, r2 } = setup(t); legacy.fail.add('put');
  await assert.rejects(adapter.put(selected, bytes)); assert.equal(r2.calls.length, 0);
});
test('withdrawal deletes both stores even after writes are off; no fallback resurrection', async t => {
  const { adapter, legacy, r2, env } = setup(t); await adapter.put(selected, bytes); env.R2_WRITE_MODE = 'off';
  await adapter.delete(selected); assert.equal(await adapter.get(selected), null);
  assert.equal(legacy.data.size, 0); assert.equal(r2.data.size, 0);
});
test('cleanup attempts both providers and reports partial failure for retry', async t => {
  const { adapter, legacy, r2 } = setup(t); await adapter.put(faq, bytes); legacy.fail.add('delete');
  await assert.rejects(adapter.delete(faq), /cleanup incomplete/); assert.equal(r2.data.size, 0);
  legacy.fail.clear(); await adapter.delete(faq); assert.equal(legacy.data.size, 0);
});
test('unrelated cleanup and pagination stay on original store', async t => {
  const { adapter, legacy, r2 } = setup(t); await adapter.put(other, bytes); await adapter.delete(other);
  const options = { prefix: 'videos/', cursor: 'opaque-original-cursor' }; await adapter.list(options);
  assert.deepEqual(legacy.calls.at(-1), ['list', options]); assert.equal(r2.calls.length, 0);
});
test('a stream cannot silently produce an incomplete mirrored private image', async t => {
  const { adapter, legacy, r2 } = setup(t);
  await assert.rejects(adapter.put(selected, new ReadableStream()), /buffered bytes/);
  assert.equal(legacy.calls.length, 0); assert.equal(r2.calls.length, 0);
});
