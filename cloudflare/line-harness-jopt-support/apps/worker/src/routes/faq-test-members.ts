import { Hono } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import { getFriendById, getLineAccountById, jstNow } from '@line-crm/db';
import type { Env } from '../index.js';

export const faqTestMembers = new Hono<Env>();
type Member = { account_id: string; friend_id: string; group_id: string; rich_menu_id: string; previous_menu_id: string | null; created_at: string };
type Group = { id: string; name: string; updated_at: string; rich_menu_id: string };
type Deployment = { test_open: number; test_friend_ids: string };

async function individualMenu(line: LineClient, userId: string): Promise<string | null> {
  try { return (await line.getRichMenuIdOfUser(userId)).richMenuId; }
  catch (e) { if (e instanceof Error && /\b404\b/.test(e.message)) return null; throw e; }
}
async function testGroups(db: D1Database, accountId: string, line: LineClient) {
  const menus = (await line.getRichMenuList()).richmenus;
  const ids = new Set(menus.filter(m =>
    m.areas?.some(a => a.action.type === 'postback' && a.action.data === 'faqv1:test') &&
    !m.areas?.some(a => a.action.type === 'postback' && a.action.data.startsWith('faqv1:start')),
  ).map(m => m.richMenuId));
  const rows = await db.prepare(`SELECT g.id,g.name,g.updated_at,p.line_richmenu_id AS rich_menu_id
    FROM rich_menu_groups g JOIN rich_menu_pages p ON p.id=COALESCE(g.default_page_id,
      (SELECT id FROM rich_menu_pages WHERE group_id=g.id ORDER BY order_index LIMIT 1))
    WHERE g.account_id=? AND g.status='published' ORDER BY g.updated_at DESC,g.id`)
    .bind(accountId).all<Group>();
  return { groups: rows.results.filter(g => ids.has(g.rich_menu_id)), menuIds: new Set(menus.map(m => m.richMenuId)) };
}
async function deployment(db: D1Database, accountId: string) {
  return db.prepare("SELECT test_open,test_friend_ids FROM faq_deployments WHERE account_id=? AND audience='test'")
    .bind(accountId).first<Deployment>();
}
function allowFriend(db: D1Database, accountId: string, friendId: string, add: boolean) {
  if (add) return db.prepare(`UPDATE faq_deployments SET test_friend_ids=(
    SELECT json_group_array(value) FROM (SELECT value FROM json_each(test_friend_ids) UNION SELECT ?))
    WHERE account_id=? AND audience='test' AND (test_open=1 OR json_array_length(test_friend_ids)<30
      OR EXISTS(SELECT 1 FROM json_each(test_friend_ids) WHERE value=?))`).bind(friendId, accountId, friendId);
  return db.prepare(`UPDATE faq_deployments SET test_friend_ids=(
    SELECT json_group_array(value) FROM json_each(test_friend_ids) WHERE value<>?)
    WHERE account_id=? AND audience='test'`).bind(friendId, accountId);
}
async function restore(line: LineClient, userId: string, previous: string | null) {
  if (previous) await line.linkRichMenuToUser(userId, previous);
  else await line.unlinkRichMenuFromUser(userId);
}

faqTestMembers.get('/api/accounts/:accountId/faq-test-members', async c => {
  if (!c.get('staff')) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const accountId = c.req.param('accountId'), db = c.env.DB;
  const account = await getLineAccountById(db, accountId);
  if (!account?.is_active) return c.json({ success: false, error: '有効なLINEアカウントを選択してください' }, 404);
  try {
    const line = new LineClient(account.channel_access_token);
    const { groups } = await testGroups(db, accountId, line);
    const rows = await db.prepare(`SELECT m.*,f.display_name,f.picture_url,f.line_user_id
      FROM faq_test_menu_members m JOIN friends f ON f.id=m.friend_id
      WHERE m.account_id=? ORDER BY m.created_at DESC,m.friend_id`).bind(accountId)
      .all<Member & { display_name: string | null; picture_url: string | null; line_user_id: string }>();
    const members: Array<{friendId:string;displayName:string;pictureUrl:string|null;groupId:string;createdAt:string;state:'active'|'changed'|'unavailable'}> = [];
    for (const row of rows.results) {
      let state: 'active' | 'changed' | 'unavailable' = 'unavailable';
      try { state = await individualMenu(line, row.line_user_id) === row.rich_menu_id ? 'active' : 'changed'; } catch { /* never report a failed lookup as unassigned */ }
      members.push({ friendId: row.friend_id, displayName: row.display_name || '名前なし', pictureUrl: row.picture_url,
        groupId: row.group_id, createdAt: row.created_at, state });
    }
    const d = await deployment(db, accountId);
    return c.json({ success: true, data: { groups, members, testActive: !!d,
      preferredGroupId: groups.find(g => g.id === members[0]?.groupId)?.id || groups[0]?.id || '' } });
  } catch { return c.json({ success: false, error: 'テストメニューの取得に失敗しました。LINE接続を確認してください' }, 502); }
});

faqTestMembers.post('/api/accounts/:accountId/faq-test-members', async c => {
  if (!c.get('staff')) return c.json({ success: false, error: 'Unauthorized' }, 401);
  let body: { groupId?: unknown; friendIds?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ success: false, error: '入力内容を確認してください' }, 400); }
  if (typeof body.groupId !== 'string' || !Array.isArray(body.friendIds) || body.friendIds.length < 1 || body.friendIds.length > 30 || body.friendIds.some(id => typeof id !== 'string' || !id))
    return c.json({ success: false, error: 'メニューと1〜30人の友だちを選択してください' }, 400);
  const ids = [...new Set(body.friendIds as string[])];
  const accountId = c.req.param('accountId'), db = c.env.DB;
  const account = await getLineAccountById(db, accountId);
  if (!account?.is_active) return c.json({ success: false, error: '有効なLINEアカウントを選択してください' }, 404);
  const friends = [];
  for (const id of ids) {
    const f = await getFriendById(db, id);
    if (!f || f.line_account_id !== accountId || !f.is_following)
      return c.json({ success: false, error: '選択中のLINEアカウントの友だちだけを追加できます。ブロック状態も確認してください' }, 400);
    friends.push(f);
  }
  const d = await deployment(db, accountId);
  if (!d) return c.json({ success: false, error: '先にFAQバージョンを選んで「このバージョンでテスト開始」を実行してください' }, 409);
  if (!d.test_open && new Set([...JSON.parse(d.test_friend_ids) as string[], ...ids]).size > 30)
    return c.json({ success: false, error: '友だち限定テストは合計30人までです' }, 400);
  try {
    const line = new LineClient(account.channel_access_token);
    const { groups } = await testGroups(db, accountId, line);
    const group = groups.find(g => g.id === body.groupId);
    if (!group) return c.json({ success: false, error: 'faqv1:test のテスト用メニューを選択してください' }, 400);
    const results = [];
    for (const f of friends) {
      try {
        const current = await individualMenu(line, f.line_user_id);
        const saved = await db.prepare('SELECT * FROM faq_test_menu_members WHERE account_id=? AND friend_id=?').bind(accountId, f.id).first<Member>();
        if (saved && current !== saved.rich_menu_id) {
          results.push({ friendId: f.id, success: false, error: 'LINE側で別メニューに変更されています。登録を解除してから再追加してください' }); continue;
        }
        const previous = saved ? saved.previous_menu_id : current === group.rich_menu_id ? null : current;
        if (current !== group.rich_menu_id) await line.linkRichMenuToUser(f.line_user_id, group.rich_menu_id);
        try {
          const result = await db.batch([
            allowFriend(db, accountId, f.id, true),
            db.prepare(`INSERT INTO faq_test_menu_members(account_id,friend_id,group_id,rich_menu_id,previous_menu_id,added_by,created_at)
              SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM faq_deployments,json_each(test_friend_ids)
                WHERE account_id=? AND audience='test' AND value=?)
              ON CONFLICT(account_id,friend_id) DO UPDATE SET group_id=excluded.group_id,rich_menu_id=excluded.rich_menu_id`)
              .bind(accountId, f.id, group.id, group.rich_menu_id, previous, c.get('staff').id, jstNow(), accountId, f.id),
          ]);
          if (!result[1].meta.changes) throw new Error('Test stopped or member limit reached');
        } catch (e) {
          if (current !== group.rich_menu_id) await restore(line, f.line_user_id, current);
          throw e;
        }
        results.push({ friendId: f.id, success: true });
      } catch { results.push({ friendId: f.id, success: false, error: '追加できませんでした。LINE接続を確認して再読み込みしてください' }); }
    }
    return c.json({ success: true, data: { results } });
  } catch { return c.json({ success: false, error: 'LINE接続を確認してください' }, 502); }
});

faqTestMembers.delete('/api/accounts/:accountId/faq-test-members/:friendId', async c => {
  if (!c.get('staff')) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const accountId = c.req.param('accountId'), friendId = c.req.param('friendId'), db = c.env.DB;
  const account = await getLineAccountById(db, accountId);
  const f = await getFriendById(db, friendId);
  if (!account?.is_active || !f || f.line_account_id !== accountId) return c.json({ success: false, error: '友だちが見つかりません' }, 404);
  const saved = await db.prepare('SELECT * FROM faq_test_menu_members WHERE account_id=? AND friend_id=?').bind(accountId, friendId).first<Member>();
  if (!saved) return c.json({ success: true, data: { removed: false } });
  try {
    const line = new LineClient(account.channel_access_token);
    const current = await individualMenu(line, f.line_user_id);
    if (current === saved.rich_menu_id) {
      const menuIds = new Set((await line.getRichMenuList()).richmenus.map(m => m.richMenuId));
      await restore(line, f.line_user_id, saved.previous_menu_id && menuIds.has(saved.previous_menu_id) ? saved.previous_menu_id : null);
    }
    await db.batch([
      allowFriend(db, accountId, friendId, false),
      db.prepare('DELETE FROM faq_test_menu_members WHERE account_id=? AND friend_id=?').bind(accountId, friendId),
    ]);
    return c.json({ success: true, data: { removed: true } });
  } catch { return c.json({ success: false, error: '解除できませんでした。LINE接続を確認して再読み込みしてください' }, 502); }
});
