import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import { recordHandoffContext, listHandoffContexts } from './faq-handoff-contexts.js';

it('stores handoffs once and isolates account/friend ownership', async () => {
  const {db,sqlite}=sqliteD1();
  try {
    sqlite.exec('CREATE TABLE faq_sessions(id TEXT,account_id TEXT,friend_id TEXT,node_id TEXT,outcome TEXT)');
    sqlite.exec(readFileSync(new URL('../../../../packages/db/migrations/076_faq_handoff_contexts.sql',import.meta.url),'utf8'));
    sqlite.exec("INSERT INTO faq_sessions VALUES('session','account','friend','question','handoff')");
    const input={sessionId:'session',accountId:'account',friendId:'friend',nodeId:'question',eventId:null,classification:'分類 → 質問',createdAt:'2026-11-05T13:00:00+09:00'};
    await recordHandoffContext(db,input);await recordHandoffContext(db,input);
    expect(await listHandoffContexts(db,'account','friend')).toEqual([{classification:input.classification,createdAt:input.createdAt}]);
    expect(await listHandoffContexts(db,'other','friend')).toEqual([]);
    expect(await listHandoffContexts(db,'account','other')).toEqual([]);
    await expect(recordHandoffContext(db,{...input,accountId:'other'})).rejects.toThrow();
    await expect(recordHandoffContext(db,{...input,classification:'changed'})).rejects.toThrow();
    expect(await listHandoffContexts(db,'account','friend')).toHaveLength(1);
  } finally { sqlite.close(); }
});
