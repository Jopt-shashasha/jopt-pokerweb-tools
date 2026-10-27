/* Shared by Node MCP and the authenticated Apps Script import bridge. */
var JoptEventImport = (function () {
  'use strict';
  var VERSION = 'jopt.event-import.v1';
  var FIELDS = ['name','brand','dates','venue','guide_url','receipt_deadline','preentry_deadline','age_note'];
  var BRANDS = ['JOPT','SPADIE','SENGOKU','U30'];
  function object(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function https(v) { return typeof v === 'string' && /^https:\/\/[^\s/@?#]+(?:[/?#][^\s]*)?$/.test(v); }
  function portal(v) { return typeof v === 'string' && /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+\/(?:edit|view)(?:[?#][^\s]*)?$/.test(v); }
  function normalize(v) { return String(v || '').normalize('NFKC').toLowerCase().replace(/\s+/g,'').replace(/test$/,''); }
  function validate(p) {
    if (!object(p)) throw Error('導入データはJSONオブジェクトで指定してください。');
    if (JSON.stringify(p).length>40000) throw Error('導入データが大きすぎます。必要な原文だけを残してください。');
    var top = ['schema_version','operation','event_id','portals','fields','evidence','unresolved'];
    Object.keys(p).forEach(function(k) { if (top.indexOf(k)<0) throw Error('未対応の項目: '+k); });
    if (p.schema_version !== VERSION) throw Error('導入データのバージョンが異なります。');
    if (['create','update'].indexOf(p.operation)<0) throw Error('operationをcreateまたはupdateにしてください。');
    if (p.operation==='update' && (typeof p.event_id!=='string' || !p.event_id)) throw Error('更新には既存大会のevent_idが必要です。');
    if (p.operation==='create' && p.event_id) throw Error('新規作成ではevent_idを指定しないでください。');
    if (!object(p.portals) || !portal(p.portals.portal_url) || !portal(p.portals.reception_portal_url)) throw Error('2つのGoogleスプレッドシートURLが必要です。');
    if (p.portals.portal_url.split('/d/')[1].split('/')[0]===p.portals.reception_portal_url.split('/d/')[1].split('/')[0]) throw Error('大会と受付の別々のポータルを指定してください。');
    if (!object(p.fields) || !object(p.evidence)) throw Error('fieldsとevidenceが必要です。');
    Object.keys(p.fields).forEach(function(k) {
      if (FIELDS.indexOf(k)<0) throw Error('大会に登録できない項目: '+k);
      var v=p.fields[k];
      if (typeof v!=='string' || v.length>4000) throw Error('不正な入力: '+k);
      if (v && /^[=+@\-\t\r]/.test(v)) throw Error('数式として解釈される入力は登録できません: '+k);
      if (k==='brand' && BRANDS.indexOf(v)<0) throw Error('ブランドはJOPT/SPADIE/SENGOKU/U30のいずれかです。');
      if (k==='guide_url' && v && (!https(v) || /^https:\/\/(?:docs|drive)\.google\.com\//i.test(v))) throw Error('お客様向けの公開ガイドURLを指定してください。内部Google資料は使えません。');
      if (!v) {
        if (p.operation==='update') throw Error('更新で空欄にする項目は送らず、省略してください: '+k);
        return;
      }
      var refs=p.evidence[k];
      if (!Array.isArray(refs) || !refs.length || refs.length>8) throw Error('根拠が必要です: '+k);
      refs.forEach(function(r) {
        if (!object(r) || !(r.url==='user' || https(r.url)) || typeof r.location!=='string' || !r.location.trim() || r.location.length>300 || typeof r.quote!=='string' || !r.quote.trim() || r.quote.length>2000) throw Error('根拠のURL・位置・原文を確認してください: '+k);
      });
    });
    Object.keys(p.evidence).forEach(function(k) { if (FIELDS.indexOf(k)<0 || !Object.prototype.hasOwnProperty.call(p.fields,k)) throw Error('対象のない根拠: '+k); });
    if (p.operation==='create' && (!p.fields.name || !p.fields.brand)) throw Error('新規作成には大会名とブランドが必要です。');
    if (!Object.keys(p.fields).length) throw Error('登録する項目がありません。');
    if (!Array.isArray(p.unresolved) || p.unresolved.length>20) throw Error('unresolvedを配列で指定してください。');
    p.unresolved.forEach(function(x) {
      if (!object(x) || FIELDS.indexOf(x.field)<0 || typeof x.reason!=='string' || !x.reason || x.reason.length>1000) throw Error('未確認項目を確認してください。');
      if (p.fields[x.field]) throw Error('未確認の項目に値は登録できません: '+x.field);
    });
    return JSON.parse(JSON.stringify(p));
  }
  function plan(payload, events) {
    var p=validate(payload), list=Object.keys(events).map(function(k){return events[k];}), old=null;
    if (p.operation==='update') {
      old=Object.prototype.hasOwnProperty.call(events,p.event_id) ? events[p.event_id] : null;
      if (!old) throw Error('更新対象が見つかりません。大会一覧を再読み込みしてください。');
    }
    var name=p.fields.name || (old && old.name);
    var duplicate=list.filter(function(e){ return (!old || e.id!==old.id) && normalize(e.name)===normalize(name); });
    if (duplicate.length) throw Error('同名の大会があります。新規作成せず既存の大会を更新してください: '+duplicate.map(function(e){return e.id;}).join(', '));
    var next=Object.assign({},old || {name:'',brand:'',dates:'',venue:'',guide_url:'',age_note:'',active:false,extra:'{}'},p.fields);
    var changes=Object.keys(p.fields).filter(function(k){return String((old||{})[k] || '')!==p.fields[k];}).map(function(k){return {field:k,before:String((old||{})[k]||''),after:p.fields[k],evidence:p.evidence[k]||[]};});
    return {payload:p,previous:old,next:next,changes:changes,unresolved:p.unresolved};
  }
  return {version:VERSION,fields:FIELDS,brands:BRANDS,validate:validate,plan:plan};
})();
if (typeof module!=='undefined') module.exports=JoptEventImport;
