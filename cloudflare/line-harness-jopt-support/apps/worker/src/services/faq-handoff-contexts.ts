// Account-scoped FAQ handoff history. Install migration 076 before deployment.
export async function recordHandoffContext(db:D1Database,input:{sessionId:string;accountId:string;friendId:string;nodeId:string;eventId:string|null;classification:string;createdAt:string}){
  if(!input.sessionId||!input.accountId||!input.friendId||!input.nodeId||!input.classification||input.classification.length>3000)throw Error('FAQ handoff context unavailable');
  const eventKey=input.eventId||'';
  await db.prepare(`INSERT INTO faq_handoff_contexts(session_id,account_id,friend_id,node_id,event_key,classification,created_at)
    SELECT id,account_id,friend_id,?,?,?,? FROM faq_sessions
    WHERE id=? AND account_id=? AND friend_id=? AND node_id=? AND outcome='handoff'
    ON CONFLICT(session_id,node_id,event_key) DO NOTHING`)
    .bind(input.nodeId,eventKey,input.classification,input.createdAt,input.sessionId,input.accountId,input.friendId,input.nodeId).run();
  const existing=await db.prepare(`SELECT classification FROM faq_handoff_contexts
    WHERE session_id=? AND account_id=? AND friend_id=? AND node_id=? AND event_key=?`)
    .bind(input.sessionId,input.accountId,input.friendId,input.nodeId,eventKey).first<{classification:string}>();
  if(existing?.classification!==input.classification)throw Error('FAQ handoff context unavailable');
}

export async function listHandoffContexts(db:D1Database,accountId:string,friendId:string){
  if(!accountId||!friendId)throw Error('FAQ handoff context unavailable');
  const rows=await db.prepare(`SELECT classification,created_at FROM faq_handoff_contexts
    WHERE account_id=? AND friend_id=? ORDER BY created_at DESC,session_id DESC LIMIT 20`).bind(accountId,friendId).all<{classification:string;created_at:string}>();
  return rows.results.map(row=>({classification:row.classification,createdAt:row.created_at}));
}
