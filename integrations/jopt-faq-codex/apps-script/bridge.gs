/** Authenticated browser bridge. No public API, shared token, or external AI call. */
function eventImportActor_() {
  const email=String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email.endsWith('@japanopenpoker.com')) throw Error('会社のGoogleアカウントでログインしてください。');
  return email;
}
function eventImportHash_(value) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify(value))).replace(/=+$/,'');
}
function previewEventImport(text) {
  const actor=eventImportActor_();
  if (typeof text!=='string' || text.length>40000) throw Error('導入JSONを確認してください。');
  const p=JoptEventImport.plan(JSON.parse(text),readKind_('events'));
  const token=Utilities.getUuid();
  CacheService.getScriptCache().put('event-import:'+token,JSON.stringify({actor:actor,payload:p.payload,previous_hash:eventImportHash_(p.previous),active:!!p.next.active}),600);
  return {token:token,changes:p.changes,unresolved:p.unresolved,operation:p.payload.operation,event_id:p.previous?p.previous.id:null,name:p.next.name,active:!!p.next.active};
}
function commitEventImport(token,active) {
  const actor=eventImportActor_();
  if (typeof token!=='string' || !/^[\w-]{20,80}$/.test(token) || typeof active!=='boolean') throw Error('プレビューを作り直してください。');
  const lock=LockService.getDocumentLock();lock.waitLock(20000);
  let eventId;
  try {
    const cache=CacheService.getScriptCache(), raw=cache.get('event-import:'+token);
    if (!raw) throw Error('プレビューの有効期限が切れました。内容を再確認してください。');
    const saved=JSON.parse(raw);
    if (saved.actor!==actor) throw Error('このプレビューは別の利用者のものです。');
    if (saved.done) return {event_id:saved.event_id,data:getAll(),already_saved:true};
    const all=readKind_('events'), p=JoptEventImport.plan(saved.payload,all);
    if (eventImportHash_(p.previous)!==saved.previous_hash) throw Error('他の利用者が大会を変更しました。再読み込みしてプレビューを作り直してください。');
    eventId=p.previous?p.previous.id:'ev_'+Utilities.getUuid().replace(/-/g,'');
    const next=Object.assign({},p.next,{id:eventId,active:active,import_sources:JSON.stringify(p.payload),updated_by:actor,updated_at:Utilities.formatDate(new Date(),'Asia/Tokyo','yyyy-MM-dd HH:mm')});
    if (!p.previous) next.order=Math.max(0,...Object.values(all).map(e=>Number(e.order)||0))+1;
    const sh=sheet_('events');
    let head=sh.getRange(1,1,1,sh.getLastColumn()).getDisplayValues()[0];
    Object.keys(next).forEach(k=>{if(head.indexOf(k)<0){head.push(k);sh.getRange(1,head.length).setValue(k).setFontWeight('bold');}});
    const ids=sh.getLastRow()>1?sh.getRange(2,head.indexOf('id')+1,sh.getLastRow()-1,1).getDisplayValues().map(r=>r[0]):[];
    const i=ids.indexOf(eventId), row=i<0?sh.getLastRow()+1:i+2;
    const line=head.map(k=>META.indexOf(k)>=0?next[k]:toCell_(k,next[k]));
    sh.getRange(row,1,1,head.length).setNumberFormat('@').setValues([line]);
    SpreadsheetApp.flush();
    cache.put('event-import:'+token,JSON.stringify({actor:actor,done:true,event_id:eventId}),600);
  } finally {lock.releaseLock();}
  return {event_id:eventId,data:getAll(),already_saved:false};
}
