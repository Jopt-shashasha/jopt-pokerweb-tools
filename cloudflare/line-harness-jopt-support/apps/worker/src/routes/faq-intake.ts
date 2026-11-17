import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '../index.js';
import { intakeForm } from '../client/faq-intake-form.js';
import { IntakeError, intakeKey, verifyIntake, intakeInfo, submitIntake, uploadIntakeImage, withdrawIntakeImage, withdrawStoredImage, staffCases } from '../services/faq-intake.js';
import { getFaqCase, transitionFaqCase, type CaseStatus } from '../services/faq-case-store.js';

export const faqIntake = new Hono<Env>();
faqIntake.onError((e, c) => {
  if (e instanceof IntakeError) return c.json({ success: false, error: e.message }, e.status as 400);
  console.error('[faq-intake] request failed'); // Never log submitted IDs, capabilities or images.
  return c.json({ success: false, error: 'FAQ intake failed' }, 500);
});
faqIntake.get('/faq-intake', () => intakeForm());
faqIntake.use('/api/faq-intake/*', bodyLimit({ maxSize: 10 * 1024 * 1024, onError: c => c.json({ success: false, error: 'Too large' }, 413) }));
faqIntake.post('/api/faq-intake/:action', async c => {
  const action = c.req.param('action');
  if (!['info', 'submit', 'image', 'withdraw'].includes(action)) return c.json({ success: false }, 404);
  const origin = c.req.header('Origin');
  if (origin && origin !== new URL(c.req.url).origin) throw new IntakeError(403, 'Origin rejected');
  const key = intakeKey(c.env.FAQ_CONTACT_IDS_ENCRYPTION_KEY);
  const cap = await verifyIntake(c.req.header('X-FAQ-Intake-Token') || '', key);
  let data;
  if (action === 'info') data = await intakeInfo(c.env.DB, cap);
  else if (action === 'submit') {
    if (Number(c.req.header('Content-Length') || 0) > 4096) throw new IntakeError(413, 'Too large');
    const text = await c.req.text();if (new TextEncoder().encode(text).length > 4096) throw new IntakeError(413, 'Too large');
    let input;try { input = JSON.parse(text); } catch { throw new IntakeError(400, 'Invalid JSON'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new IntakeError(400, 'Invalid submission');
    data = await submitIntake(c.env.DB, cap, input, key);
  } else if (action === 'image') data = await uploadIntakeImage(c.env.DB, c.env.IMAGES, cap, (c.req.header('Content-Type') || '').split(';')[0], await c.req.arrayBuffer());
  else data = await withdrawIntakeImage(c.env.DB, c.env.IMAGES, cap);
  return c.json({ success: true, data }, 200, { 'Cache-Control': 'private, no-store' });
});

async function scopeForFriend(db: D1Database, friendId: string) {
  const friend = await db.prepare('SELECT line_account_id FROM friends WHERE id=?').bind(friendId).first<{ line_account_id: string }>();
  if (!friend?.line_account_id) throw new IntakeError(404, 'Friend not found');
  return { accountId: friend.line_account_id, friendId };
}
faqIntake.use('/api/faq-cases/*', async (c, next) => { if (!c.get('staff')) return c.json({ success: false, error: 'Unauthorized' }, 401);return next(); });
faqIntake.get('/api/faq-cases/friends/:friendId', async c => {
  const scope = await scopeForFriend(c.env.DB, c.req.param('friendId'));
  return c.json({ success: true, data: await staffCases(c.env.DB, scope, intakeKey(c.env.FAQ_CONTACT_IDS_ENCRYPTION_KEY), c.get('staff').id) }, 200, { 'Cache-Control': 'private, no-store' });
});
faqIntake.post('/api/faq-cases/friends/:friendId/:caseId/status', bodyLimit({ maxSize: 1024, onError: c => c.json({ success: false }, 413) }), async c => {
  const scope = await scopeForFriend(c.env.DB, c.req.param('friendId'));
  const item = await getFaqCase(c.env.DB, scope, c.req.param('caseId'));
  if (!item) throw new IntakeError(404, 'Case not found');
  const body = await c.req.json<{ status: CaseStatus; expectedVersion: number }>();
  // Staff may close incomplete cases, but cannot manufacture completed intake or bypass image requirements.
  const allowed: Record<string, string[]> = { draft: ['closed'], awaiting_image: ['closed'], submitted: ['checking', 'closed'], checking: ['needs_staff', 'answered', 'closed'], needs_staff: ['answered', 'closed'], answered: ['closed'], closed: [] };
  if (!allowed[item.status]?.includes(body.status)) throw new IntakeError(400, 'Invalid status transition');
  if (body.expectedVersion !== item.version) throw new IntakeError(409, 'Case was updated');
  const result = await transitionFaqCase(c.env.DB, scope, { caseId: item.id, from: item.status, to: body.status, expectedVersion: item.version });
  if (!result) throw new IntakeError(409, 'Case was updated');
  return c.json({ success: true, data: result });
});
faqIntake.post('/api/faq-cases/friends/:friendId/:caseId/withdraw-image', async c => {
  const scope = await scopeForFriend(c.env.DB, c.req.param('friendId'));
  return c.json({ success: true, data: await withdrawStoredImage(c.env.DB, c.env.IMAGES, scope, c.req.param('caseId')) });
});
faqIntake.get('/api/faq-cases/friends/:friendId/:caseId/images/:attachmentId', async c => {
  const scope = await scopeForFriend(c.env.DB, c.req.param('friendId'));
  const image = await c.env.DB.prepare(`SELECT a.storage_key,a.content_type FROM faq_case_attachments a JOIN faq_case_uploads u ON u.attachment_id=a.id AND u.state='stored'
    WHERE a.id=? AND a.case_id=? AND a.account_id=? AND a.friend_id=?`).bind(c.req.param('attachmentId'), c.req.param('caseId'), scope.accountId, scope.friendId).first<{ storage_key: string; content_type: string }>();
  if (!image) throw new IntakeError(404, 'Image not found');
  const object = await c.env.IMAGES.get(image.storage_key);
  if (!object) throw new IntakeError(404, 'Image not found');
  // Recheck after storage I/O, so withdrawal wins over a read still in flight.
  const active = await c.env.DB.prepare("SELECT attachment_id FROM faq_case_uploads WHERE attachment_id=? AND state='stored'").bind(c.req.param('attachmentId')).first();
  if (!active) throw new IntakeError(404, 'Image withdrawn');
  return new Response(object.body, { headers: { 'Content-Type': image.content_type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' } });
});
