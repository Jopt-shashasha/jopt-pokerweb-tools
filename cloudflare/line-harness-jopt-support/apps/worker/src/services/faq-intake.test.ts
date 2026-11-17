import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { Hono } from 'hono';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import { importFaq, deployFaq } from './faq-store.js';
import { handleFaq } from './faq-runtime.js';
import { faqIntake } from '../routes/faq-intake.js';
import { authMiddleware } from '../middleware/auth.js';
import { intakePolicy, startIntake, verifyIntake, signIntake, submitIntake, uploadIntakeImage, withdrawIntakeImage, cleanupIntakeImages, staffCases } from './faq-intake.js';

const key = new Uint8Array(32).fill(7), keyText = btoa(String.fromCharCode(...key));
const policy = { gameId: true, gamesId: true, image: false, title: 'fixture-title', buttonLabel: 'fixture-link', submitLabel: 'fixture-submit', successText: 'fixture-success', errorText: 'fixture-error', gameIdLabel: 'Game ID', gamesIdLabel: 'JOPT Games ID', imageLabel: 'fixture-image', withdrawLabel: 'fixture-withdraw', withdrawText: 'fixture-withdrawn' };
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNuoAAAAASUVORK5CYII='), c => c.charCodeAt(0)).buffer as ArrayBuffer;
let db: D1Database, sqlite: ReturnType<typeof sqliteD1>['sqlite'], app: Hono<any>, storage: any;
let messages: any[], release: any;
const scope = { accountId: 'account', friendId: 'friend' };
beforeEach(async () => {
  ({ db, sqlite } = sqliteD1());
  sqlite.exec(readFileSync(new NodeURL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8'));
  for (const name of ['076_faq_handoff_contexts', '077_faq_cases', '078_faq_contact_ids', '079_faq_intakes']) sqlite.exec(readFileSync(new NodeURL(`../../../../packages/db/migrations/${name}.sql`, import.meta.url), 'utf8'));
  sqlite.prepare('INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES(?,?,?,?,?)').run('account', 'channel', 'fixture', 'token', 'secret');
  sqlite.prepare('INSERT INTO friends(id,line_user_id,line_account_id,metadata) VALUES(?,?,?,?)').run('friend', 'user', 'account', '{}');
  sqlite.prepare('INSERT INTO friends(id,line_user_id,line_account_id,metadata) VALUES(?,?,?,?)').run('other-friend', 'other-user', 'account', '{}');
  // D1 batches serialize transactions. Model that explicitly for concurrency tests.
  let queue = Promise.resolve();
  db.batch = async statements => {
    const result = queue.then(async () => {
      sqlite.exec('BEGIN');try { const values = [];for (const statement of statements) values.push(await statement.run());sqlite.exec('COMMIT');return values as any; }
      catch (e) { sqlite.exec('ROLLBACK');throw e; }
    });queue = result.then(() => {}, () => {});return result;
  };
  messages = [];
  const data = { nodes: { root: { id: 'root', type: 'menu', label: 'Root', body: 'fixture', status: '確認済' }, human: { id: 'human', parent: 'root', type: 'handoff', label: 'Handoff', body: 'fixture', handoff: 'H', status: '確認済' } }, handoffs: { H: { id: 'H', fields: ['Game ID', 'JOPT Games ID'], intake: policy } }, messages: Object.fromEntries(['msg_root', 'msg_followup', 'msg_handoff_in', 'msg_handoff_out', 'msg_resolved'].map(id => [id, { id, text: 'fixture' }])) };
  release = await importFaq(db, scope.accountId, data, 'admin');await deployFaq(db, scope.accountId, release.id, 'test', ['friend'], 'admin');
  const objects = new Map();
  storage = { put: vi.fn(async (name: string, data: ArrayBuffer) => { objects.set(name, data); }), get: vi.fn(async (name: string) => objects.has(name) ? { body: new Blob([objects.get(name)]).stream() } : null), delete: vi.fn(async (name: string) => { objects.delete(name); }), objects };
  app = new Hono();app.use('*', authMiddleware as any);app.route('/', faqIntake);
});
afterEach(() => sqlite.close());
function env() { return { DB: db, API_KEY: 'fixture-admin', FAQ_CONTACT_IDS_ENCRYPTION_KEY: keyText, IMAGES: storage }; }
async function begin(image = false) {
  if (image) {
    const payload = JSON.parse(release.payload);payload.handoffs.H.intake.image = true;
    release = await importFaq(db, scope.accountId, payload, 'admin');await deployFaq(db, scope.accountId, release.id, 'test', ['friend'], 'admin');
  }
  const send = async (message: unknown) => { messages.push(message); };
  await handleFaq(db, { ...scope, kind: 'postback', value: 'faqv1:test', eventId: crypto.randomUUID(), send, intake: { key: keyText, origin: 'https://example.test' } });
  const button = messages.at(-1).contents.body.contents.find((c: any) => c.action?.data?.endsWith(':node:human')).action.data;
  await handleFaq(db, { ...scope, kind: 'postback', value: button, eventId: crypto.randomUUID(), send, intake: { key: keyText, origin: 'https://example.test' } });
  const uri = messages.at(-1).contents.body.contents.find((c: any) => c.action?.type === 'uri').action.uri;
  const token = new URL(uri).hash.slice(1), cap = await verifyIntake(token, key);
  return { token, cap };
}
async function publicCall(action: string, token: string, body: any = {}, headers: Record<string, string> = {}) {
  return app.request(`https://example.test/api/faq-intake/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FAQ-Intake-Token': token, ...headers }, body: JSON.stringify(body) }, env());
}
function staffCall(path: string, body?: unknown) {
  return app.request('https://example.test/api/faq-cases/friends/' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }, env());
}

it('connects FAQ handoff to real-format encrypted IDs and an employee case view', async () => {
  const { token, cap } = await begin();
  expect((await publicCall('info', token)).status).toBe(200);
  expect((await publicCall('submit', token, { gameId: '87654321', gamesId: '9876-5432' })).status).toBe(200);
  expect((await publicCall('submit', token, { gameId: '87654321', gamesId: '9876-5432' })).status).toBe(200);
  expect(sqlite.prepare('SELECT count(*) n FROM faq_cases').get()).toEqual({ n: 1 });
  const stored = sqlite.prepare('SELECT * FROM faq_case_contact_ids').all();expect(JSON.stringify(stored)).not.toContain('87654321');
  const r = await staffCall('friend');expect(r.status).toBe(200);
  const item = (await r.json() as any).data[0];
  expect(item).toMatchObject({ id: cap.caseId, status: 'submitted', selection: { classification: 'Handoff' }, contactIds: { game_id: '87654321', games_id: '9876-5432' } });
  expect(sqlite.prepare('SELECT count(*) n FROM faq_case_contact_access_audit').get()).toEqual({ n: 2 });
});
it('rejects missing, malformed, expired, forged and cross-origin capabilities', async () => {
  const { token, cap } = await begin();
  expect((await publicCall('info', '')).status).toBe(401);
  expect((await publicCall('info', token + 'a')).status).toBe(401);
  expect((await publicCall('info', await signIntake({ ...cap, expiresAt: Date.now() - 1 }, key))).status).toBe(401);
  expect((await publicCall('info', await signIntake({ ...cap, friendId: 'other-friend' }, key))).status).toBe(410);
  expect((await publicCall('info', token, {}, { Origin: 'https://attacker.test' })).status).toBe(403);
  expect((await app.request('https://example.test/api/faq-cases/friends/friend', {}, env())).status).toBe(401);
});
it('does not accept fake formats or overwrite a confirmed case on replay', async () => {
  const { cap, token } = await begin();
  expect((await publicCall('submit', token, { gameId: 'wrong', gamesId: '9876-5432' })).status).toBe(400);
  expect(sqlite.prepare('SELECT count(*) n FROM faq_case_contact_ids').get()).toEqual({ n: 0 });
  await submitIntake(db, cap, { gameId: '87654321', gamesId: '9876-5432' }, key);
  expect((await publicCall('submit', token, { gameId: '11112222', gamesId: '9876-5432' })).status).toBe(409);
  expect((await staffCases(db, scope, key, 'staff'))[0].contactIds.game_id).toBe('87654321');
});
it('serializes competing confirmations without mixing IDs from different submissions', async () => {
  const { cap } = await begin();
  const results = await Promise.allSettled([
    submitIntake(db, cap, { gameId: '87654321', gamesId: '9876-5432' }, key),
    submitIntake(db, cap, { gameId: '11112222', gamesId: '1111-2222' }, key),
  ]);
  expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
  const item = (await staffCases(db, scope, key, 'staff'))[0];
  expect([{ game_id: '87654321', games_id: '9876-5432' }, { game_id: '11112222', games_id: '1111-2222' }]).toContainEqual(item.contactIds);
});
it('privately links one image, deduplicates upload, and blocks reads before failed deletion is retried', async () => {
  const { cap } = await begin(true);
  await submitIntake(db, cap, { gameId: '87654321', gamesId: '9876-5432' }, key);
  await expect(uploadIntakeImage(db, storage, cap, 'image/png', encBuffer('invalid'))).rejects.toMatchObject({ status: 400 });
  const image = await uploadIntakeImage(db, storage, cap, 'image/png', png);
  await uploadIntakeImage(db, storage, cap, 'image/png', png);expect(storage.put).toHaveBeenCalledTimes(1);
  const url = `friend/${cap.caseId}/images/${image.attachmentId}`;
  expect((await staffCall(url)).status).toBe(200);
  expect((await staffCall(url.replace('friend/', 'other-friend/'))).status).toBe(404);
  expect((await app.request('https://example.test/api/faq-cases/friends/' + url, {}, env())).status).toBe(401);
  storage.delete.mockRejectedValueOnce(Error('storage down'));
  await withdrawIntakeImage(db, storage, cap);
  expect((await staffCall(url)).status).toBe(404);
  expect(storage.objects.size).toBe(1);
  await cleanupIntakeImages(db, storage);expect(storage.objects.size).toBe(0);
  expect((await staffCases(db, scope, key, 'staff'))[0]).toMatchObject({ status: 'needs_staff', attachments: [] });
});
it('withdrawal wins when image upload is still in flight', async () => {
  const { cap } = await begin(true);await submitIntake(db, cap, { gameId: '87654321', gamesId: '9876-5432' }, key);
  let releasePut!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  storage.put.mockImplementationOnce(async (name: string, data: ArrayBuffer) => { started();await new Promise<void>(resolve => { releasePut = resolve; });storage.objects.set(name, data); });
  const upload = uploadIntakeImage(db, storage, cap, 'image/png', png);await waiting;
  await withdrawIntakeImage(db, storage, cap);releasePut();
  await expect(upload).rejects.toMatchObject({ status: 410 });
  expect(storage.objects.size).toBe(0);
  expect((await staffCases(db, scope, key, 'staff'))[0].attachments).toEqual([]);
});
it('protects state transitions with versions and never lets staff fabricate intake completion', async () => {
  const { cap } = await begin();
  expect((await staffCall(`friend/${cap.caseId}/status`, { status: 'submitted', expectedVersion: 1 })).status).toBe(400);
  await submitIntake(db, cap, { gameId: '87654321', gamesId: '9876-5432' }, key);
  expect((await staffCall(`friend/${cap.caseId}/status`, { status: 'checking', expectedVersion: 1 })).status).toBe(409);
  expect((await staffCall(`friend/${cap.caseId}/status`, { status: 'checking', expectedVersion: 2 })).status).toBe(200);
});
it('requires explicitly supplied form text and avoids injecting JSON into HTML', async () => {
  expect(() => intakePolicy({ gameId: true, gamesId: false, image: false })).toThrow();
  const response = await app.request('https://example.test/faq-intake', {}, env());
  expect(response.status).toBe(200);expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  const text = await response.text();expect(text).toContain('textContent=policy.title');expect(text).not.toContain(keyText);
});
function encBuffer(value: string) { return new TextEncoder().encode(value).buffer as ArrayBuffer; }
