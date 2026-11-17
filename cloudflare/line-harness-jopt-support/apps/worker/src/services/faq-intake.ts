import { createFaqCase, getFaqCase, type CaseScope } from './faq-case-store.js';
import { encryptSubmittedCaseId, readCaseContactId } from './faq-contact-ids.js';
import { faqNow } from './faq-store.js';
import type { ObjectStorage } from './object-storage.js';

export interface IntakePolicy {
  gameId: boolean; gamesId: boolean; image: boolean;
  title: string; buttonLabel: string; submitLabel: string; successText: string; errorText: string;
  gameIdLabel?: string; gamesIdLabel?: string; imageLabel?: string; withdrawLabel?: string; withdrawText?: string;
}
export class IntakeError extends Error { constructor(public status: number, message: string) { super(message); } }
export function intakePolicy(value: unknown): IntakePolicy | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid intake policy');
  const v = value as Record<string, unknown>;
  for (const k of ['gameId', 'gamesId', 'image']) if (typeof v[k] !== 'boolean') throw new Error(`intake.${k} must be boolean`);
  if (!v.gameId && !v.gamesId && !v.image) throw new Error('Intake must require an ID or image');
  for (const k of ['title', 'buttonLabel', 'submitLabel', 'successText', 'errorText', ...(v.gameId ? ['gameIdLabel'] : []), ...(v.gamesId ? ['gamesIdLabel'] : []), ...(v.image ? ['imageLabel', 'withdrawLabel', 'withdrawText'] : [])]) {
    if (typeof v[k] !== 'string' || !v[k].trim() || v[k].length > (k === 'buttonLabel' ? 40 : 1000)) throw new Error(`Invalid intake.${k}`);
  }
  return v as unknown as IntakePolicy;
}
export function intakeKey(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new IntakeError(503, 'Intake encryption is not configured');
  const key = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if (key.length !== 32) throw new IntakeError(503, 'Invalid intake encryption key');
  return key;
}
const enc = new TextEncoder();
function b64(b: Uint8Array) { return btoa(String.fromCharCode(...b)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function unb64(v: string) { return Uint8Array.from(atob(v.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - v.length % 4) % 4)), c => c.charCodeAt(0)); }
async function macKey(raw: Uint8Array) {
  const input = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('jopt-faq-intake-v1'), info: enc.encode('capabilities-and-idempotency') }, input, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
}
export interface IntakeCapability extends CaseScope { caseId: string; expiresAt: number }
export async function signIntake(cap: IntakeCapability, raw: Uint8Array) {
  const body = b64(enc.encode(JSON.stringify(cap)));
  return body + '.' + b64(new Uint8Array(await crypto.subtle.sign('HMAC', await macKey(raw), enc.encode('cap:' + body))));
}
export async function verifyIntake(token: string, raw: Uint8Array, now = Date.now()): Promise<IntakeCapability> {
  try {
    if (typeof token !== 'string' || token.length > 1800 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw 0;
    const [body, sig] = token.split('.');
    if (!await crypto.subtle.verify('HMAC', await macKey(raw), unb64(sig), enc.encode('cap:' + body))) throw 0;
    const cap = JSON.parse(new TextDecoder().decode(unb64(body)));
    if (!/^[0-9a-f-]{36}$/i.test(cap.caseId) || !/^[A-Za-z0-9_-]{1,128}$/.test(cap.accountId) || !/^[A-Za-z0-9_-]{1,128}$/.test(cap.friendId) || !Number.isSafeInteger(cap.expiresAt) || cap.expiresAt <= now) throw 0;
    return cap;
  } catch { throw new IntakeError(401, 'Invalid or expired intake link'); }
}
async function owned(db: D1Database, cap: IntakeCapability, now = Date.now()) {
  const row = await db.prepare(`SELECT c.*,i.policy_json,i.expires_at,i.submission_hash FROM faq_cases c
    JOIN faq_case_intakes i ON i.case_id=c.id
    JOIN friends f ON f.id=c.friend_id AND f.line_account_id=c.account_id
    WHERE c.id=? AND c.account_id=? AND c.friend_id=?`).bind(cap.caseId, cap.accountId, cap.friendId).first<any>();
  if (!row || row.expires_at !== cap.expiresAt || row.expires_at <= now || row.status === 'closed') throw new IntakeError(410, 'Intake unavailable');
  return row;
}
export async function startIntake(db: D1Database, scope: CaseScope, sessionId: string, nodeId: string, classification: string, policy: IntakePolicy, key: Uint8Array, now = Date.now()) {
  const result = await createFaqCase(db, scope, { faqSessionId: sessionId, idempotencyKey: `intake:${sessionId}:${nodeId}`, selection: { classification }, requiresAttachment: policy.image });
  await db.prepare('INSERT OR IGNORE INTO faq_case_intakes(case_id,policy_json,expires_at) VALUES(?,?,?)').bind(result.case.id, JSON.stringify(policy), now + 24 * 3600000).run();
  const intake = await db.prepare('SELECT expires_at FROM faq_case_intakes WHERE case_id=?').bind(result.case.id).first<{ expires_at: number }>();
  const cap = { ...scope, caseId: result.case.id, expiresAt: intake!.expires_at };
  return { caseId: cap.caseId, token: await signIntake(cap, key) };
}
export async function intakeInfo(db: D1Database, cap: IntakeCapability) {
  const row = await owned(db, cap);
  const attachment = await db.prepare('SELECT state FROM faq_case_uploads WHERE case_id=?').bind(cap.caseId).first<{ state: string }>();
  return { caseId: cap.caseId, policy: intakePolicy(JSON.parse(row.policy_json))!, status: row.status, classification: JSON.parse(row.selection_json).classification, submitted: !!row.submission_hash, hasImage: attachment?.state === 'stored', imageWithdrawn: attachment?.state === 'deleted' };
}
export async function submitIntake(db: D1Database, cap: IntakeCapability, input: { gameId?: unknown; gamesId?: unknown }, key: Uint8Array) {
  const row = await owned(db, cap), policy = intakePolicy(JSON.parse(row.policy_json))!;
  const values: Record<string, string> = {};
  for (const [kind, name, required, pattern] of [['game_id', 'gameId', policy.gameId, /^[0-9]{8}$/], ['games_id', 'gamesId', policy.gamesId, /^[0-9]{4}-[0-9]{4}$/]] as const) {
    const value = input[name];
    if (required) { if (typeof value !== 'string' || !pattern.test(value)) throw new IntakeError(400, `Invalid ${name}`); values[kind] = value; }
    else if (value !== undefined && value !== '') throw new IntakeError(400, `Unexpected ${name}`);
  }
  const digest = b64(new Uint8Array(await crypto.subtle.sign('HMAC', await macKey(key), enc.encode('submission:' + cap.caseId + ':' + JSON.stringify(values)))));
  if (row.submission_hash && row.submission_hash !== digest) throw new IntakeError(409, 'This inquiry has already been submitted with different IDs');
  const statements: D1PreparedStatement[] = [];
  for (const [kind, value] of Object.entries(values)) {
    const encrypted = await encryptSubmittedCaseId(cap, cap.caseId, kind as 'game_id' | 'games_id', value, key);
    statements.push(db.prepare(`INSERT OR IGNORE INTO faq_case_contact_ids(case_id,account_id,friend_id,kind,ciphertext,nonce,profile_revision,created_at)
      SELECT c.id,c.account_id,c.friend_id,?,?,?,1,? FROM faq_cases c JOIN faq_case_intakes i ON i.case_id=c.id
      WHERE c.id=? AND c.account_id=? AND c.friend_id=? AND c.status='draft' AND i.submission_hash IS NULL`)
      .bind(kind, encrypted.ciphertext, encrypted.nonce, Date.now(), cap.caseId, cap.accountId, cap.friendId));
  }
  const now = faqNow();
  statements.push(db.prepare("UPDATE faq_case_intakes SET submission_hash=?,submitted_at=? WHERE case_id=? AND submission_hash IS NULL AND EXISTS(SELECT 1 FROM faq_cases WHERE id=? AND status='draft')").bind(digest, now, cap.caseId, cap.caseId));
  statements.push(db.prepare(`UPDATE faq_cases SET status=?,version=version+1,updated_at=? WHERE id=? AND account_id=? AND friend_id=? AND status='draft'
    AND EXISTS(SELECT 1 FROM faq_case_intakes WHERE case_id=? AND submission_hash=?)`).bind(policy.image ? 'awaiting_image' : 'submitted', now, cap.caseId, cap.accountId, cap.friendId, cap.caseId, digest));
  statements.push(db.prepare(`UPDATE chats SET status=CASE WHEN status='in_progress' THEN status ELSE 'unread' END,updated_at=?
    WHERE friend_id=? AND EXISTS(SELECT 1 FROM faq_cases WHERE id=? AND status IN ('submitted','awaiting_image'))`).bind(now, cap.friendId, cap.caseId));
  await db.batch(statements);
  const after = await owned(db, cap);
  if (after.submission_hash !== digest) throw new IntakeError(409, 'Concurrent submission conflict');
  return { caseId: cap.caseId, status: after.status };
}

export async function uploadIntakeImage(db: D1Database, storage: ObjectStorage, cap: IntakeCapability, contentType: string, data: ArrayBuffer) {
  const row = await owned(db, cap);
  if (!row.submission_hash || !row.requires_attachment || !['awaiting_image', 'submitted'].includes(row.status)) throw new IntakeError(409, 'Image upload is not available');
  const types: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
  if (!types[contentType] || !data.byteLength || data.byteLength > 10 * 1024 * 1024) throw new IntakeError(400, 'Invalid image size or type');
  const b = new Uint8Array(data);
  const actual = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'image/jpeg' : b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 13 && b[5] === 10 && b[6] === 26 && b[7] === 10 ? 'image/png' : new TextDecoder().decode(b.slice(0, 6)).match(/^GIF8[79]a$/) ? 'image/gif' : new TextDecoder().decode(b.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(b.slice(8, 12)) === 'WEBP' ? 'image/webp' : '';
  if (actual !== contentType) throw new IntakeError(400, 'Image content does not match its type');
  const hash = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', data))), id = crypto.randomUUID();
  const objectKey = `faq-private/${cap.caseId}/${id}.${types[contentType]}`;
  await db.prepare(`INSERT OR IGNORE INTO faq_case_uploads(case_id,attachment_id,storage_key,content_type,size_bytes,content_hash,state,created_at)
    VALUES(?,?,?,?,?,?,'reserved',?)`).bind(cap.caseId, id, objectKey, contentType, data.byteLength, hash, Date.now()).run();
  let upload = await db.prepare('SELECT * FROM faq_case_uploads WHERE case_id=?').bind(cap.caseId).first<any>();
  if (upload.state === 'deleted') throw new IntakeError(410, 'Image has been withdrawn');
  if (upload.content_hash !== hash) throw new IntakeError(409, 'Another image is already attached');
  if (upload.state !== 'stored') {
    await storage.put(upload.storage_key, data, { httpMetadata: { contentType } });
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO faq_case_attachments(id,case_id,account_id,friend_id,source_event_id,storage_key,content_type,size_bytes,created_at)
        SELECT u.attachment_id,c.id,c.account_id,c.friend_id,?,u.storage_key,u.content_type,u.size_bytes,? FROM faq_cases c JOIN faq_case_uploads u ON u.case_id=c.id
        WHERE c.id=? AND c.account_id=? AND c.friend_id=? AND c.status='awaiting_image' AND u.state='reserved'`).bind('form:' + upload.attachment_id, faqNow(), cap.caseId, cap.accountId, cap.friendId),
      db.prepare("UPDATE faq_case_uploads SET state='stored' WHERE case_id=? AND state='reserved' AND EXISTS(SELECT 1 FROM faq_case_attachments WHERE id=faq_case_uploads.attachment_id)").bind(cap.caseId),
      db.prepare("UPDATE faq_cases SET status='submitted',version=version+1,updated_at=? WHERE id=? AND status='awaiting_image' AND EXISTS(SELECT 1 FROM faq_case_uploads WHERE case_id=? AND state='stored')").bind(faqNow(), cap.caseId, cap.caseId),
      db.prepare("UPDATE chats SET status=CASE WHEN status='in_progress' THEN status ELSE 'unread' END,updated_at=? WHERE friend_id=? AND EXISTS(SELECT 1 FROM faq_cases WHERE id=? AND status='submitted')").bind(faqNow(), cap.friendId, cap.caseId),
    ]);
  }
  upload = await db.prepare('SELECT * FROM faq_case_uploads WHERE case_id=?').bind(cap.caseId).first<any>();
  if (upload.state === 'deleted') { await storage.delete(upload.storage_key).catch(() => {}); throw new IntakeError(410, 'Image has been withdrawn'); }
  if (upload.state !== 'stored') throw new IntakeError(409, 'Image could not be linked');
  return { caseId: cap.caseId, status: 'submitted', attachmentId: upload.attachment_id };
}
export async function withdrawIntakeImage(db: D1Database, storage: ObjectStorage, cap: IntakeCapability) {
  await owned(db, cap);
  return withdrawStoredImage(db, storage, cap, cap.caseId);
}
export async function withdrawStoredImage(db: D1Database, storage: ObjectStorage, scope: CaseScope, caseId: string) {
  if (!await getFaqCase(db, scope, caseId)) throw new IntakeError(404, 'Case not found');
  await db.batch([
    db.prepare("UPDATE faq_case_uploads SET state='deleted',retry_after=0 WHERE case_id=?").bind(caseId),
    db.prepare("UPDATE faq_cases SET status='needs_staff',version=version+1,updated_at=? WHERE id=? AND status NOT IN ('closed','needs_staff') AND EXISTS(SELECT 1 FROM faq_case_uploads WHERE case_id=? AND state='deleted')").bind(faqNow(), caseId, caseId),
  ]);
  const row = await db.prepare('SELECT storage_key FROM faq_case_uploads WHERE case_id=?').bind(caseId).first<{ storage_key: string }>();
  if (row) { try { await storage.delete(row.storage_key); } catch { /* Tombstone blocks reads; the scheduler retries physical deletion. */ } }
  return { withdrawn: true };
}
export async function cleanupIntakeImages(db: D1Database, storage: ObjectStorage, now = Date.now()) {
  await db.prepare(`UPDATE faq_case_uploads SET state='deleted' WHERE state='reserved' AND case_id IN (SELECT case_id FROM faq_case_intakes WHERE expires_at<=?)`).bind(now).run();
  const rows = await db.prepare("SELECT case_id,storage_key FROM faq_case_uploads WHERE state='deleted' AND retry_after<=? ORDER BY retry_after LIMIT 10").bind(now).all<{ case_id: string; storage_key: string }>();
  for (const row of rows.results) {
    try { await storage.delete(row.storage_key); } catch { /* Retry in the next scheduled window. */ }
    // Keep tombstones and revisit them: an upload already in flight can finish after a deletion.
    await db.prepare('UPDATE faq_case_uploads SET retry_after=? WHERE case_id=?').bind(now + 30 * 60000, row.case_id).run();
  }
}
export async function staffCases(db: D1Database, scope: CaseScope, key: Uint8Array, staffId: string) {
  const rows = await db.prepare('SELECT id FROM faq_cases WHERE account_id=? AND friend_id=? ORDER BY created_at DESC,id LIMIT 20').bind(scope.accountId, scope.friendId).all<{ id: string }>();
  const items = [];
  for (const row of rows.results) {
    const item = (await getFaqCase(db, scope, row.id))!;
    const ids: Record<string, string> = {};
    for (const kind of ['game_id', 'games_id'] as const) {
      const value = await readCaseContactId(db, scope, row.id, kind, key);
      if (!value && await db.prepare('SELECT kind FROM faq_case_contact_ids WHERE case_id=? AND account_id=? AND friend_id=? AND kind=?').bind(row.id, scope.accountId, scope.friendId, kind).first()) throw new IntakeError(503, 'Stored ID could not be decrypted');
      if (value) {
        await db.prepare('INSERT INTO faq_case_contact_access_audit(id,account_id,case_id,staff_id,kind,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(), scope.accountId, row.id, staffId, kind, Date.now()).run();
        ids[kind] = value;
      }
    }
    const images = await db.prepare(`SELECT a.id,a.content_type,a.size_bytes FROM faq_case_attachments a JOIN faq_case_uploads u ON u.attachment_id=a.id AND u.state='stored'
      WHERE a.case_id=? AND a.account_id=? AND a.friend_id=?`).bind(row.id, scope.accountId, scope.friendId).all();
    items.push({ ...item, contactIds: ids, attachments: images.results });
  }
  return items;
}
