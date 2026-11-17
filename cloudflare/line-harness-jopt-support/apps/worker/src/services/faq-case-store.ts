/**
 * Structured FAQ cases. This module only persists metadata: it does not expose
 * routes, enable the feature, accept uploads or modify existing FAQ handling.
 * The caller must authenticate the LINE user or staff and establish account and
 * friend ownership before constructing a scope. A GameID is not proof of identity.
 */
export interface CaseScope { accountId: string; friendId: string }
export type CaseStatus = 'draft' | 'awaiting_image' | 'submitted' | 'checking' | 'needs_staff' | 'answered' | 'closed';
export type Selection = Record<string, unknown>;
export interface FaqCase {
  id: string; accountId: string; friendId: string; faqSessionId: string;
  releaseId: string; nodeId: string; eventId: string | null; selection: Selection;
  requiresAttachment: boolean; status: CaseStatus; version: number; createdAt: string; updatedAt: string;
}
export interface CaseAttachment {
  id: string; caseId: string; accountId: string; friendId: string;
  sourceEventId: string; storageKey: string; contentType: string;
  sizeBytes: number; createdAt: string;
}
interface CaseRow {
  id: string; account_id: string; friend_id: string; faq_session_id: string;
  release_id: string; node_id: string; event_id: string | null; selection_json: string;
  requires_attachment: number; status: CaseStatus; version: number; created_at: string; updated_at: string;
}
interface AttachmentRow {
  id: string; case_id: string; account_id: string; friend_id: string;
  source_event_id: string; storage_key: string; content_type: string;
  size_bytes: number; created_at: string;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const KEY = /^[A-Za-z0-9_.:-]{1,128}$/;
const CASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTENT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
};
const TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  draft: ['awaiting_image', 'submitted', 'closed'],
  awaiting_image: ['submitted', 'closed'],
  submitted: ['checking', 'needs_staff', 'closed'],
  checking: ['answered', 'needs_staff', 'closed'],
  needs_staff: ['answered', 'closed'],
  answered: ['closed'],
  closed: [],
};

function checkId(value: string): void {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid identifier');
}
function checkScope(scope: CaseScope): void {
  if (!scope || typeof scope !== 'object') throw new Error('Invalid scope');
  checkId(scope.accountId); checkId(scope.friendId);
}
function checkKey(value: string): void {
  if (typeof value !== 'string' || !KEY.test(value)) throw new Error('Invalid idempotency key');
}
function checkCaseId(value: string): void {
  if (typeof value !== 'string' || !CASE_ID.test(value)) throw new Error('Invalid case ID');
}

// Canonical JSON makes semantically identical retries independent of key order.
// Bounded depth/size keeps internal callers from storing unbounded request data.
function canonicalValue(value: unknown, depth: number): unknown {
  if (depth > 8) throw new Error('Selection is too deeply nested');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > 2048) throw new Error('Selection value is too long');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid selection number');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error('Selection array is too large');
    return value.map(item => canonicalValue(item, depth + 1));
  }
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error('Invalid selection');
  }
  const keys = Object.keys(value as object).sort();
  if (keys.length > 100 || keys.some(k => k.length > 128 || k === '__proto__' || k === 'constructor' || k === 'prototype')) {
    throw new Error('Invalid selection keys');
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) result[key] = canonicalValue((value as Record<string, unknown>)[key], depth + 1);
  return result;
}
function encodeSelection(selection: Selection): string {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw new Error('Invalid selection');
  const json = JSON.stringify(canonicalValue(selection, 0));
  if (new TextEncoder().encode(json).length > 16 * 1024) throw new Error('Selection is too large');
  return json;
}
function toCase(row: CaseRow): FaqCase {
  return { id: row.id, accountId: row.account_id, friendId: row.friend_id,
    faqSessionId: row.faq_session_id, releaseId: row.release_id, nodeId: row.node_id,
    eventId: row.event_id, selection: JSON.parse(row.selection_json) as Selection, requiresAttachment: row.requires_attachment === 1,
    status: row.status, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}
function toAttachment(row: AttachmentRow): CaseAttachment {
  return { id: row.id, caseId: row.case_id, accountId: row.account_id, friendId: row.friend_id,
    sourceEventId: row.source_event_id, storageKey: row.storage_key, contentType: row.content_type,
    sizeBytes: row.size_bytes, createdAt: row.created_at };
}

/** Create only from an existing FAQ session whose friend and release belong to this account. */
export async function createFaqCase(db: D1Database, scope: CaseScope, input: {
  faqSessionId: string; idempotencyKey: string; selection: Selection; requiresAttachment: boolean;
}): Promise<{ case: FaqCase; created: boolean }> {
  checkScope(scope); checkId(input.faqSessionId); checkKey(input.idempotencyKey);
  if (typeof input.requiresAttachment !== 'boolean') throw new Error('Invalid attachment requirement');
  const selectionJson = encodeSelection(input.selection);
  const id = crypto.randomUUID(), now = new Date(Date.now()+9*3600000).toISOString().replace('Z','+09:00');
  const result = await db.prepare(`INSERT INTO faq_cases
    (id,account_id,friend_id,faq_session_id,release_id,node_id,event_id,selection_json,requires_attachment,status,idempotency_key,version,created_at,updated_at)
    SELECT ?,s.account_id,s.friend_id,s.id,s.release_id,s.node_id,s.event_id,?,?,'draft',?,1,?,?
    FROM faq_sessions s
    JOIN friends f ON f.id=s.friend_id AND f.line_account_id=s.account_id
    JOIN faq_releases r ON r.id=s.release_id AND r.account_id=s.account_id
    WHERE s.id=? AND s.account_id=? AND s.friend_id=?
    ON CONFLICT(account_id,friend_id,idempotency_key) DO NOTHING`)
    .bind(id, selectionJson, input.requiresAttachment ? 1 : 0, input.idempotencyKey, now, now, input.faqSessionId, scope.accountId, scope.friendId).run();
  const row = await db.prepare(`SELECT * FROM faq_cases WHERE account_id=? AND friend_id=? AND idempotency_key=?`)
    .bind(scope.accountId, scope.friendId, input.idempotencyKey).first<CaseRow>();
  if (!row) throw new Error('FAQ session not found');
  if (row.faq_session_id !== input.faqSessionId || row.selection_json !== selectionJson || row.requires_attachment !== (input.requiresAttachment ? 1 : 0)) {
    throw new Error('Idempotency key already used for different data');
  }
  return { case: toCase(row), created: result.meta.changes === 1 };
}

export async function getFaqCase(db: D1Database, scope: CaseScope, caseId: string): Promise<FaqCase | null> {
  checkScope(scope); checkCaseId(caseId);
  const row = await db.prepare('SELECT * FROM faq_cases WHERE id=? AND account_id=? AND friend_id=?')
    .bind(caseId, scope.accountId, scope.friendId).first<CaseRow>();
  return row ? toCase(row) : null;
}

/** Version-checked transitions prevent two workers from overwriting each other. */
export async function transitionFaqCase(db: D1Database, scope: CaseScope, input: {
  caseId: string; from: CaseStatus; to: CaseStatus; expectedVersion: number;
}): Promise<FaqCase | null> {
  checkScope(scope); checkCaseId(input.caseId);
  if (!Object.hasOwn(TRANSITIONS, input.from) || !TRANSITIONS[input.from].includes(input.to) ||
      !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error('Invalid case transition');
  const result = await db.prepare(`UPDATE faq_cases SET status=?,version=version+1,updated_at=?
    WHERE id=? AND account_id=? AND friend_id=? AND status=? AND version=?
    AND (? <> 'submitted' OR requires_attachment=0 OR EXISTS (
      SELECT 1 FROM faq_case_attachments a WHERE a.case_id=faq_cases.id AND a.account_id=faq_cases.account_id AND a.friend_id=faq_cases.friend_id
    ))`)
    .bind(input.to, new Date(Date.now()+9*3600000).toISOString().replace('Z','+09:00'), input.caseId, scope.accountId, scope.friendId, input.from, input.expectedVersion, input.to).run();
  if (result.meta.changes !== 1) return null;
  return getFaqCase(db, scope, input.caseId);
}

/** Store metadata for an already privately stored image. This does not upload bytes. */
export async function addFaqCaseAttachment(db: D1Database, scope: CaseScope, input: {
  caseId: string; sourceEventId: string; storageKey: string; contentType: string; sizeBytes: number;
}): Promise<{ attachment: CaseAttachment; created: boolean }> {
  checkScope(scope); checkCaseId(input.caseId); checkKey(input.sourceEventId);
  const ext = Object.hasOwn(CONTENT_TYPES, input.contentType) ? CONTENT_TYPES[input.contentType] : undefined;
  const prefix = `faq-private/${input.caseId}/`;
  const name = typeof input.storageKey === 'string' && input.storageKey.startsWith(prefix)
    ? input.storageKey.slice(prefix.length) : '';
  const suffix = `.${ext}`;
  const imageId = ext && name.endsWith(suffix) ? name.slice(0, -suffix.length) : '';
  if (!ext || !CASE_ID.test(imageId) ||
      !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 10 * 1024 * 1024) {
    throw new Error('Invalid private attachment metadata');
  }
  const id = crypto.randomUUID(), now = new Date(Date.now()+9*3600000).toISOString().replace('Z','+09:00');
  const result = await db.prepare(`INSERT INTO faq_case_attachments
    (id,case_id,account_id,friend_id,source_event_id,storage_key,content_type,size_bytes,created_at)
    SELECT ?,id,account_id,friend_id,?,?,?,?,? FROM faq_cases
    WHERE id=? AND account_id=? AND friend_id=? AND status IN ('draft','awaiting_image')
    ON CONFLICT(account_id,source_event_id) DO NOTHING`)
    .bind(id, input.sourceEventId, input.storageKey, input.contentType, input.sizeBytes, now,
      input.caseId, scope.accountId, scope.friendId).run();
  const row = await db.prepare(`SELECT * FROM faq_case_attachments WHERE account_id=? AND friend_id=? AND source_event_id=?`)
    .bind(scope.accountId, scope.friendId, input.sourceEventId).first<AttachmentRow>();
  if (!row) throw new Error('Case not found or not accepting attachments');
  if (row.case_id !== input.caseId || row.storage_key !== input.storageKey ||
      row.content_type !== input.contentType || row.size_bytes !== input.sizeBytes) {
    throw new Error('Source event already used for different data');
  }
  return { attachment: toAttachment(row), created: result.meta.changes === 1 };
}

export async function listFaqCaseAttachments(db: D1Database, scope: CaseScope, caseId: string): Promise<CaseAttachment[]> {
  checkScope(scope); checkCaseId(caseId);
  const result = await db.prepare(`SELECT * FROM faq_case_attachments
    WHERE case_id=? AND account_id=? AND friend_id=? ORDER BY created_at,id`)
    .bind(caseId, scope.accountId, scope.friendId).all<AttachmentRow>();
  return (result.results || []).map(toAttachment);
}
