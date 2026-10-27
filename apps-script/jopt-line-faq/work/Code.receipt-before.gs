/** JOPT LINE FAQ — Google Sheets backed web app */
const TABS = { nodes:'db_nodes', channels:'db_channels', handoffs:'db_handoffs', vars:'db_vars', messages:'db_messages', events:'db_events' };
const COLS = {
  nodes:    ['id','parent','order','label','type','body','channel','handoff','follow','links','status','review','evidence'],
  channels: ['id','name','url','scope','status','last_seen','uses','note'],
  handoffs: ['id','name','team','priority','slack','sla','fields','note'],
  vars:     ['key','value','valid_until','note'],
  messages: ['id','title','text'],
  events:   ['id','order','active','name','dates','venue','guide_url','receipt_form','receipt_deadline','age_note','photo_url','media_form','extra','note']
};
const META = ['updated_by','updated_at'];
const IDF = { vars:'key' };
const ARR = { links:1, fields:1, tags:1 };   // 1行に1つ（改行区切り）
const BOOL = { follow:1, active:1, per_event:1 };
const NUM = { order:1, uses:1 };

function doGet(e) {
  const admin = e && e.parameter && e.parameter.mode === 'admin';
  return HtmlService.createHtmlOutputFromFile(admin ? 'Index' : 'Simple')
    .setTitle('JOPT LINE FAQ')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function sheet_(kind) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(TABS[kind]);
  if (!sh) {
    sh = ss.insertSheet(TABS[kind]);
    const h = COLS[kind].concat(META);
    sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#e8efe9');
    sh.setFrozenRows(1);
  }
  return sh;
}

function toCell_(k, v) {
  if (v === null || v === undefined) return '';
  if (ARR[k]) return (v || []).join('\n');
  if (BOOL[k]) return v ? 'TRUE' : 'FALSE';
  return String(v);
}
function fromCell_(k, v) {
  v = v === undefined ? '' : String(v);
  if (ARR[k]) return v ? v.split(/\r?\n/).map(s => s.trim()).filter(String) : [];
  if (BOOL[k]) return v.toUpperCase() === 'TRUE';
  if (NUM[k]) return v === '' ? null : Number(v);
  if (k === 'channel' || k === 'handoff' || k === 'parent') return v === '' ? null : v;
  return v;
}

function readKind_(kind) {
  const sh = sheet_(kind);
  const vals = sh.getDataRange().getDisplayValues();
  const head = vals[0] || [];
  const idf = IDF[kind] || 'id';
  const out = {};
  for (let r = 1; r < vals.length; r++) {
    const o = {};
    head.forEach((k, i) => { if (k && META.indexOf(k) < 0) o[k] = fromCell_(k, vals[r][i]); });
    if (o[idf]) out[o[idf]] = o;
  }
  return out;
}

function getAll() {
  const out = {};
  Object.keys(TABS).forEach(k => out[k] = readKind_(k));
  applyCommonInfo_(out);
  out.user = Session.getActiveUser().getEmail() || '';
  return out;
}

function saveDoc(kind, obj) {
  const lock = LockService.getDocumentLock(); lock.waitLock(20000);
  try {
    const sh = sheet_(kind), idf = IDF[kind] || 'id';
    let head = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    Object.keys(obj).concat(META).forEach(k => {
      if (head.indexOf(k) < 0) { head.push(k); sh.getRange(1, head.length).setValue(k).setFontWeight('bold'); }
    });
    const ids = sh.getLastRow() > 1 ? sh.getRange(2, head.indexOf(idf) + 1, sh.getLastRow() - 1, 1).getDisplayValues().map(r => r[0]) : [];
    const i = ids.indexOf(String(obj[idf]));
    const row = i < 0 ? sh.getLastRow() + 1 : i + 2;
    const rec = Object.assign({}, obj, { updated_by: Session.getActiveUser().getEmail() || '', updated_at: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') });
    const line = head.map(k => META.indexOf(k) >= 0 ? rec[k] : toCell_(k, rec[k]));
    const rg = sh.getRange(row, 1, 1, head.length);
    rg.setNumberFormat('@'); rg.setValues([line]);
  } finally { lock.releaseLock(); }
  return getAll();
}

function deleteDoc(kind, id) {
  const lock = LockService.getDocumentLock(); lock.waitLock(20000);
  try {
    const sh = sheet_(kind), idf = IDF[kind] || 'id';
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    if (sh.getLastRow() > 1) {
      const ids = sh.getRange(2, head.indexOf(idf) + 1, sh.getLastRow() - 1, 1).getDisplayValues().map(r => r[0]);
      const i = ids.indexOf(String(id));
      if (i >= 0) sh.deleteRow(i + 2);
    }
  } finally { lock.releaseLock(); }
  return getAll();
}

/** 最初に1回だけ実行：db_ タブを作って初期データを入れる */
function setup() {
  Object.keys(TABS).forEach(kind => {
    const sh = sheet_(kind);
    if (sh.getLastRow() > 1) return; // 既にデータがあれば何もしない
    const head = COLS[kind].concat(META);
    const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
    const rows = Object.values(SEED[kind]).map(o => head.map(k => META.indexOf(k) >= 0 ? (k === 'updated_by' ? 'setup' : now) : toCell_(k, o[k])));
    if (rows.length) { const rg = sh.getRange(2, 1, rows.length, head.length); rg.setNumberFormat('@'); rg.setValues(rows); }
    sh.getRange(1, 1, sh.getLastRow(), head.length).setVerticalAlignment('top').setWrap(true);
  });
}

/** 誤って変更・削除したボタンを初期データから戻す（管理者用） */
function restore_(id) {
  const all = readKind_('nodes');
  const kids = id2 => Object.values(all).filter(n => n.parent === id2);
  const walk = id2 => { kids(id2).forEach(c => { walk(c.id); deleteDoc('nodes', c.id); }); };
  walk(id);
  if (SEED.nodes[id]) saveDoc('nodes', SEED.nodes[id]);
}
function restorePrizeType() { restore_('prize_type'); }

/** 開催回ごとの情報を「開催大会」に移す（1回だけ実行） */
function migrateEvents() {
  const V = readKind_('vars'), g = k => (V[k] && V[k].value) || '';
  const ev = readKind_('events');
  if (!Object.keys(ev).length) {
    saveDoc('events', { id:'ev_osaka02', order:1, active:true, name:g('event_name'), dates:g('event_dates'), venue:g('event_venue'),
      guide_url:g('players_guide_url'), receipt_form:g('receipt_form_event'), receipt_deadline:g('receipt_send_deadline'),
      age_note:g('age_note'), photo_url:g('photo_album_url'), media_form:g('media_form_url'), note:'変数から移行' });
  }
  const MAP = { event_name:'大会名', event_dates:'日程', event_venue:'会場', players_guide_url:'ガイドURL', receipt_form_event:'領収書フォーム',
    receipt_send_deadline:'領収書送付期限', age_note:'年齢制限', photo_album_url:'写真アルバム', media_form_url:'メディア申請' };
  const N = readKind_('nodes');
  Object.values(N).forEach(n => {
    let b = n.body || '', hit = false;
    Object.keys(MAP).forEach(k => { const re = new RegExp('\\{\\{\\s*' + k + '\\s*\\}\\}', 'g'); if (re.test(b)) { hit = true; b = b.replace(re, '【' + MAP[k] + '】'); } });
    if (hit) saveDoc('nodes', Object.assign({}, n, { body: b, per_event: true }));
  });
}

/** 問い合わせにカテゴリ（タグ）を付ける（1回だけ実行。既にタグがあるものは変更しない） */
function migrateTags() {
  const TAGS = ['プライズ','チケット','大会参加・エントリー','領収書','コイン・選手契約','JOPT Games','GameIDアプリ','店舗・お仕事','忘れ物・商品','その他'];
  const BY_ANC = { prize:'プライズ', ticket:'チケット', entry:'大会参加・エントリー', receipt:'領収書', coin:'コイン・選手契約', games:'JOPT Games', biz:'店舗・お仕事', goods:'忘れ物・商品', human:'その他' };
  const BY_ID = { lost:['忘れ物・商品'], app_gameid:['GameIDアプリ'], ticket_which:['チケット','JOPT Games'] };
  const EXTRA = { ticket_games:['JOPT Games'], games_live_voucher:['チケット'], games_merges:['チケット'], games_ticket_types:['チケット'],
    prize_contract_status:['コイン・選手契約'], receipt_coin:['コイン・選手契約'], app_link:['GameIDアプリ'], games_id_diff:['GameIDアプリ'],
    entry_pay:['コイン・選手契約'], coin_entry:['大会参加・エントリー'] };
  const N = readKind_('nodes');
  Object.values(N).forEach(n => {
    if (n.type === 'menu' || n.id === 'root' || (n.tags && n.tags.length)) return;
    let tags = (BY_ID[n.id] || []).slice();
    let p = n;
    while (!tags.length && p) { if (BY_ANC[p.id]) tags.push(BY_ANC[p.id]); p = N[p.parent]; }
    (EXTRA[n.id] || []).forEach(t => { if (tags.indexOf(t) < 0) tags.push(t); });
    if (!tags.length) tags = ['その他'];
    saveDoc('nodes', Object.assign({}, n, { tags: tags }));
  });
  const M = readKind_('messages');
  if (!M.msg_tags) saveDoc('messages', { id:'msg_tags', title:'カテゴリ一覧', text: JSON.stringify(TAGS) });
}

/* ===== 2026-10-24 メニュー構成の変更（1回だけ実行） ===== */
function put_(kind, obj) {
  const sh = sheet_(kind), idf = IDF[kind] || 'id';
  let head = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
  Object.keys(obj).concat(META).forEach(k => {
    if (head.indexOf(k) < 0) { head.push(k); sh.getRange(1, head.length).setValue(k).setFontWeight('bold'); }
  });
  const ids = sh.getLastRow() > 1 ? sh.getRange(2, head.indexOf(idf) + 1, sh.getLastRow() - 1, 1).getDisplayValues().map(r => r[0]) : [];
  const i = ids.indexOf(String(obj[idf]));
  const row = i < 0 ? sh.getLastRow() + 1 : i + 2;
  const rec = Object.assign({}, obj, { updated_by: 'restructure', updated_at: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') });
  const rg = sh.getRange(row, 1, 1, head.length);
  rg.setNumberFormat('@'); rg.setValues([head.map(k => META.indexOf(k) >= 0 ? rec[k] : toCell_(k, rec[k]))]);
}
function del_(kind, id) {
  const sh = sheet_(kind), idf = IDF[kind] || 'id';
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
  if (sh.getLastRow() < 2) return;
  const ids = sh.getRange(2, head.indexOf(idf) + 1, sh.getLastRow() - 1, 1).getDisplayValues().map(r => r[0]);
  const i = ids.indexOf(String(id)); if (i >= 0) sh.deleteRow(i + 2);
}

function restructure20261024() {
  const lock = LockService.getDocumentLock(); lock.waitLock(20000);
  const log = [];
  try {
    const sh = sheet_('nodes');
    const vals = sh.getDataRange().getDisplayValues(), head = vals[0];
    const who = {}; vals.slice(1).forEach(r => { who[r[head.indexOf('id')]] = r[head.indexOf('updated_by')]; });
    const N = readKind_('nodes');
    const MINE = ['', 'setup', 'restructure', 'xiao.h@japanopenpoker.com'];
    const touched = {};
    const up = (id, patch, bodyPatch) => {   // bodyPatch: 文案の書き換え（同僚が編集済みなら保留）
      const n = N[id]; if (!n) { log.push('なし: ' + id); return; }
      Object.assign(n, patch);
      if (bodyPatch !== undefined) {
        if (MINE.indexOf(who[id] || '') >= 0) n.body = typeof bodyPatch === 'function' ? bodyPatch(n.body || '') : bodyPatch;
        else { n.review = '【構成変更】文案の更新を保留（' + who[id] + ' が編集済み）'; log.push('保留: ' + id); }
      }
      touched[id] = 1;
    };
    const add = o => { N[o.id] = Object.assign({ channel:null, handoff:null, follow:false, links:[], status:'確認済', review:'', evidence:'', per_event:false, tags:[] }, o); touched[o.id] = 1; };
    const gone = [];
    const rm = id => { if (N[id]) { delete N[id]; gone.push(id); } };
    const SONOTA = s => s;  // 回答後の「担当者に相談」ボタンは残るため、文案はそのまま
    const OTHER = '担当者が確認してご返信します。';

    /* --- トップ --- */
    up('live', { order:1 });
    up('games', { order:2, label:'JOPT Gamesの問い合わせ' });
    add({ id:'shop', parent:'root', order:3, type:'menu', label:'店舗', body:'お選びください。' });
    up('biz_store', { parent:'shop', order:1 }); up('biz_store_w', { parent:'shop', order:2 });
    up('biz', { order:4, label:'お仕事', body:'お選びください。' });
    up('biz_dealer', { order:1 }); up('biz_staff', { order:2 }); up('biz_media', { order:3 });
    up('human', { order:5, label:'その他', body:'お選びください。' });
    up('app_gameid', { parent:'human', order:1 });
    up('human_other', { order:2 }, OTHER);
    rm('human_report'); rm('ticket_which');

    /* --- JOPTの問い合わせ 第2層 --- */
    up('ticket', { order:1, label:'チケット', body:'チケット・バウチャーについて、お選びください。' });
    up('prize', { order:2, label:'プライズ・コイン・選手契約', body:'プライズ・コイン・選手契約について、お選びください。' });
    up('entry', { order:3 }); up('receipt', { order:4 });
    up('lost', { order:5, label:'落とし物' }); up('goods', { order:6 });

    /* --- チケット --- */
    up('ticket_main', { order:1 }); up('ticket_valid', { order:2 }); up('ticket_side', { order:3 });
    up('ticket_voucher_use', { order:4, label:'バウチャーの使い方・何枚使える？' },
      b => b.replace(/・?1つのトーナメントにつき2枚までご利用いただけます。/, '・1つのトーナメントで使える枚数に制限はありません。'));
    up('ticket_transfer', { order:5 });
    up('ticket_missing', { order:6, type:'menu', handoff:null, follow:false }, 'どこで獲得したチケットですか？');
    const CLUB = '②GameIDで「JOPT」クラブに参加しているかご確認ください。クラブに参加していないと、チケットを付与できません。（GameID下部の「クラブ」から「JOPT」を検索して参加申請）';
    const RESTART = '①GameIDアプリを一度完全に終了して再起動し、画面下メニュー右端の「その他」→「チケット」をご確認ください。';
    up('ticket_campaign', { parent:'ticket_missing', order:1, type:'check', label:'キャンペーン・招待' },
      'キャンペーンの賞品・招待チケットは、各キャンペーンの告知に記載の日時にGameIDへ付与します。次の順にご確認ください。\n' + RESTART + '\n' + CLUB +
      '\n③受け取りに公式LINEのミッション画面で「達成」ボタンが必要なものもあります。\n④当日会場の「特別対応窓口」で付与するものもあります。\nそれでも届かない場合や、ミッション賞品の受け取り期間を過ぎてしまった場合は、担当者が確認します。');
    add({ id:'tm_store', parent:'ticket_missing', order:2, type:'answer', label:'店舗のサテライト', follow:true, tags:['チケット'],
      body:'店舗のサテライトで獲得したチケットは、獲得した店舗から付与されます。お手数ですが、獲得した店舗へ直接お問い合わせください。' });
    add({ id:'tm_live', parent:'ticket_missing', order:3, type:'check', label:'JOPTの会場で獲得', handoff:'H_TICKET', follow:true, tags:['チケット'],
      body:'次の順にご確認ください。\n' + RESTART + '\n' + CLUB + '\n③申込フォームなどに入力したGameIDが、ご自身のGameID（8桁の数字）と合っているかご確認ください。\nそれでも届かない場合は、担当者が確認します。' });
    ['games_live_voucher', 'games_merges'].forEach((src, k) => {
      const s = N[src]; if (!s) return;
      add({ id: k ? 'tm_merges' : 'tm_games', parent:'ticket_missing', order:4 + k, type:s.type, channel:s.channel, follow:s.follow, tags:['チケット','JOPT Games'],
        label: k ? '会場入賞でもらうGamesのFinal Ticket' : 'JOPT Gamesで獲得', body:s.body, review:'JOPT Games側の「' + s.label + '」と同じ内容' });
    });
    add({ id:'tm_other', parent:'ticket_missing', order:9, type:'handoff', label:'その他', handoff:'H_TICKET', tags:['チケット'], body:OTHER });
    up('ticket_overused', { order:7 }); up('ticket_other_brand', { order:8 });
    rm('ticket_games');
    add({ id:'ticket_other', parent:'ticket', order:99, type:'handoff', label:'その他', handoff:'H_TICKET', tags:['チケット'], body:OTHER });

    /* --- プライズ・コイン・選手契約（コインを統合） --- */
    up('prize_steps', { order:1 }, SONOTA);
    up('prize_missing', { order:2, type:'handoff', handoff:'H_PRIZE', follow:false, label:'プライズが届かない・いつ届く？' }, 'プライズの付与状況を担当者が確認してご案内します。');
    rm('prize_when');
    up('prize_type', { order:3, label:'ウェブコインと選手契約の違い' },
      '2026年年末年始の「JOPT 2026 Tokyo #01」「U-30 2026 WINTER」で入賞した方はJOPT選手契約、それ以外の大会はウェブコイン（POKER WEB COIN）です。\n' +
      '・ウェブコインの方：ポーカーギルド公式LINE {{ch_pokerguild}}\n・JOPT選手契約の方：選手契約履行申請サポート {{ch_contract_jopt}}\n' +
      '※外国籍の方は、USDTまたは選手契約の形でご案内します。\n分からない場合は、下の「担当者に相談」からご連絡ください。');
    up('coin_travel', { parent:'prize', order:4 });
    up('coin_other_event', { parent:'prize', order:5, status:'確認済', review:'' },
      '海外大会やJOPT以外の大会での利用は、お持ちのプライズによって窓口が異なります。\n' +
      '・ウェブコインの方：利用できる大会は下記の一覧でご確認ください。\n海外大会：https://pokerguild-contract.com/ja/contents/tournaments_oversea.pdf\n国内大会：https://pokerguild-contract.com/ja/contents/tournaments_domestic.pdf\n申請・お問い合わせ：{{ch_pokerguild}}\n' +
      '・JOPT選手契約の方：{{ch_contract_jopt}}\nなお、入賞で獲得したAPTバウチャーは、APT会場内のJOPTブースでご利用いただけます（有効期限は原則1年）。');
    up('coin_entry', { parent:'prize', order:6 });
    up('coin_balance', { parent:'prize', order:7 }); up('contract_balance', { parent:'prize', order:8 });
    up('coin_wrong', { parent:'prize', order:9 });
    up('prize_doc', { order:10, type:'answer', follow:true },
      b => (b.trim() ? b.trim() + '\n' : '') + 'プライズカードがお手元にない場合は、下の「担当者に相談」からご連絡ください。');
    rm('prize_contract_status'); rm('coin_change'); rm('coin');
    add({ id:'prize_other', parent:'prize', order:99, type:'handoff', label:'その他', handoff:'H_CONTRACT', tags:['プライズ・コイン・選手契約'], body:OTHER });

    /* --- 大会参加・エントリー --- */
    up('entry_info', { order:1, label:'開催大会（日程・会場）' });
    up('entry_need', { order:2 }); up('entry_age', { order:3 });
    up('entry_pay', { order:4, status:'確認済', review:'' },
      'エントリー費は次の方法でお支払いいただけます。\n・現金\n・クレジットカード\n・交通系IC、iD、QUICPay、QRコード決済などの電子決済\n・POKER WEB COIN\n・USDT（受付横の「特別対応窓口」へお越しください）\nPayPayのみご利用いただけません。\n複数の支払い方法を組み合わせることもできます（1,000円単位）。');
    up('entry_drink', { order:5 });
    up('entry_team', { order:6 }, b => SONOTA(b.replace(/・代表者を含むメンバーの変更[\s\S]*?会場でも変更できます。\s*/, '')));
    up('entry_mail', { order:7 }, SONOTA); up('entry_late', { order:8 });
    up('entry_overseas', { order:9 }); up('entry_venue_rule', { order:10 });
    up('entry_photo', { order:11 }, b => b.replace(/店舗様・お仕事\s*›\s*「メディア・写真」/, '「お仕事」›「メディア・写真」'));
    add({ id:'entry_other', parent:'entry', order:99, type:'handoff', label:'その他', handoff:'H_GENERAL', tags:['大会参加・エントリー'], body:OTHER });

    /* --- 領収書 --- */
    const NOTE = 'なお、電子チケットおよび選手契約履行によるエントリーにつきましては、領収書の発行対象外となっております。';
    const ATT = '※ご利用の環境によっては、添付ファイルが表示されない場合があります。その場合は、別の端末やメールアプリでお試しください。それでも開けない場合は、下の「担当者に相談」からご連絡ください。';
    up('receipt_after', { order:1, label:'まだ申請していない', per_event:false },
      '下記フォームから領収書を申請してください。大会当日に申請できなかった場合や、申請期限を過ぎた場合も申請できます。\n{{receipt_form_after}}\n\n' +
      '・フォームの「対象期間」には、参加した大会の開催期間（例：10/8〜10/12）を入力してください。\n・POKER WEB COIN（ウェブコイン）でお支払いいただいた参加費も発行対象です。領収書の「ポイント」の表記は、ウェブコインでのお支払い分を表します。\n\n' +
      '申請内容をもとに、ご登録のメールアドレスへ電子領収書をお送りします。\n但し書きは「施設使用料として」となります。\n' + NOTE + '\n\n' + ATT);
    up('receipt_event', { order:2, label:'これから参加する大会の領収書', per_event:true },
      '【大会名】の領収書は、下記フォームから申請してください。\n【領収書フォーム】\n大会終了後、参加したトーナメント分をまとめてメールでお送りします。\n\n・現金、クレジットカード、ウェブコインでのお支払い分が発行対象です。\n・電子チケットおよび選手契約履行によるエントリーにつきましては、領収書の発行対象外となっております。');
    up('receipt_issue', { order:3, label:'申請したが届いていない', per_event:true },
      '【大会名】の領収書は、【領収書送付期限】までにご登録のメールアドレスへお送りします。\n迷惑メールフォルダもご確認ください。\nこの日を過ぎても届かない場合は、担当者が確認します。');
    add({ id:'receipt_open', parent:'receipt', order:4, type:'check', label:'届いたが開けない', handoff:'H_RECEIPT', follow:true, tags:['領収書'],
      body:'ご利用の環境によっては、添付ファイルが表示されない場合があります。別の端末やメールアプリでお試しください。\nそれでも開けない場合は、担当者が確認します。' });
    rm('receipt_coin');
    add({ id:'receipt_other', parent:'receipt', order:99, type:'handoff', label:'その他', handoff:'H_RECEIPT', tags:['領収書'], body:OTHER });

    /* --- 商品・副賞・トロフィー --- */
    up('goods_ship', { order:1, handoff:'H_GOODS_SHIP' }, 'ご購入いただいた商品の配送状況を、担当者が確認します。');
    up('goods_prize', { order:2, label:'副賞・トロフィー' }, '副賞・トロフィーの発送状況を、担当者が確認します。郵送中の破損もこちらからご連絡ください。');
    rm('goods_trophy');

    /* --- JOPT Games --- */
    up('games_account', {}, 'JOPT Gamesの登録メールアドレスは、10月21日のアップデート以降、アプリ内から変更できます。アプリを最新版にアップデートしてからお試しください。\nログインできない場合やアカウントについては、下記のJOPT Gamesお問い合わせ窓口へご連絡ください。\n{{ch_jopt_games}}');
    up('games_refund', { status:'確認済', review:'' }, b => b.indexOf('Google Play') >= 0 ? b :
      b.replace(/(「サブスクリプション」から手続きしてください。)/, '$1Androidの場合は、Google Playストアの「定期購入」から手続きしてください。※アプリを削除しただけでは解約されません。'));

    /* --- カテゴリ（タグ）の統合 --- */
    const TMAP = { 'プライズ':'プライズ・コイン・選手契約', 'コイン・選手契約':'プライズ・コイン・選手契約', '忘れ物・商品':'落とし物・商品' };
    Object.values(N).forEach(n => {
      if (!n.tags || !n.tags.length) return;
      const t = []; n.tags.forEach(x => { x = TMAP[x] || x; if (t.indexOf(x) < 0) t.push(x); });
      if (t.join() !== n.tags.join()) { n.tags = t; touched[n.id] = 1; }
      if (n.links && n.links.some(l => gone.indexOf(l) >= 0)) { n.links = n.links.filter(l => gone.indexOf(l) < 0); touched[n.id] = 1; }
    });

    /* --- 書き込み --- */
    Object.keys(touched).forEach(id => { if (N[id]) put_('nodes', N[id]); });
    gone.forEach(id => del_('nodes', id));

    put_('messages', { id:'msg_tags', title:'カテゴリ一覧', text: JSON.stringify(['チケット','プライズ・コイン・選手契約','大会参加・エントリー','領収書','落とし物・商品','JOPT Games','GameIDアプリ','店舗・お仕事','その他']) });
    const M = readKind_('messages');
    if (M.msg_freetext) put_('messages', Object.assign(M.msg_freetext, { text: M.msg_freetext.text.replace(/該当がない場合は「担当者に相談」を押してください。/, '該当がない場合は、各メニューの「その他」からご連絡ください。') }));
    const H = readKind_('handoffs');
    if (H.H_PRIZE) put_('handoffs', Object.assign(H.H_PRIZE, { fields:['GameID（8桁）','大会名・トーナメント名','順位','入賞した場所（JOPT／店舗／SPADIE／戦国など）'] }));
    if (H.H_CONTRACT) put_('handoffs', Object.assign(H.H_CONTRACT, { name:'プライズ・コイン・選手契約（その他）' }));
    if (H.H_GOODS) put_('handoffs', Object.assign(H.H_GOODS, { name:'副賞・トロフィー', fields:['GameID（8桁）','大会名','順位','状況（届かない／破損 など）'] }));
    put_('handoffs', { id:'H_GOODS_SHIP', name:'購入商品が届かない', team:'カスタマー', priority:'低', slack:'#cs-line', sla:'2営業日', fields:['購入した商品','注文番号','GameID（8桁）'], note:'' });
  } finally { lock.releaseLock(); }
  Logger.log(log.join('\n') || 'OK');
  return log;
}

function backup20261024() { const ss = SpreadsheetApp.getActive(); ['db_nodes','db_handoffs','db_messages'].forEach(n => { const old = ss.getSheetByName(n + '_bk1024'); if (old) ss.deleteSheet(old); ss.getSheetByName(n).copyTo(ss).setName(n + '_bk1024'); }); }


function prizeFlow20261024() {
  const lock = LockService.getDocumentLock(); lock.waitLock(20000);
  try {
    const N = readKind_('nodes'), p = N.prize_missing; if (!p) return;
    put_('nodes', Object.assign(p, { type:'menu', handoff:null, follow:false, body:'会場で選手契約の手続きと、同意書の提出はお済みですか？' }));
    const base = { channel:null, links:[], status:'確認済', review:'', evidence:'', per_event:false, tags:['プライズ・コイン・選手契約'] };
    put_('nodes', Object.assign({}, base, { id:'pm_not', parent:'prize_missing', order:1, type:'answer', label:'まだ／分からない', handoff:'H_PRIZE_DOC', follow:true,
      body:'選手契約の手続きと同意書の提出が完了していないと、プライズを付与できません。\n①プライズカード裏面の下側のQRコードから、入賞記録フォームを送信してください。\n②同意書がお手元にある場合は、ご記入のうえ下記へ郵送してください。\n〒162-0845 東京都新宿区市谷本村町2-21 市ヶ谷キャナルコート 3F\nジャパンオープンポーカーツアー株式会社 カスタマー部\n\nプライズカードがお手元にない場合は、下の「担当者に相談」からご連絡ください。' }));
    put_('nodes', Object.assign({}, base, { id:'pm_done', parent:'prize_missing', order:2, type:'handoff', label:'済んでいる', handoff:'H_PRIZE', follow:false,
      body:'プライズの付与状況を担当者が確認してご案内します。' }));
    del_('nodes', 'prize_doc');
  } finally { lock.releaseLock(); }
}


function fixOsaka02() {
  const E = readKind_('events'), e = E.ev_osaka02; if (!e) return 'none';
  put_('events', Object.assign(e, {
    dates: '2026年10月29日（木）〜11月3日（火・祝）',
    venue: '堂島リバーフォーラム（〒553-0003 大阪市福島区福島1-1-17／JR・阪神「福島」駅 徒歩約5分）',
    guide_url: 'https://events.japanopenpoker.com/2026-osaka-02',
    receipt_form: 'https://forms.gle/euc1MoTHjKwZnZVX7',
    note: '受付ポータル・ポータルから更新（10/24）。送付期限・年齢制限・写真・メディア申請は要確認'
  }));
  return 'ok';
}


function listPortalLinks() {
  const out = [];
  ['1LdPznpKqx9nm7xMoinGsiK7GFas0rrE8Jnsz4iP7WeA'].forEach(id => {
    const sh = SpreadsheetApp.openById(id).getSheetByName('Menu');
    const rg = sh.getRange(1, 1, Math.min(sh.getLastRow(), 100), Math.min(sh.getLastColumn(), 12));
    const rich = rg.getRichTextValues(), disp = rg.getDisplayValues(), f = rg.getFormulas();
    f.forEach((row, r) => row.forEach((x, k) => { if (x) out.push('F ' + (r+1) + ',' + (k+1) + ' | ' + disp[r][k] + ' | ' + x.slice(0, 200)); }));
    rich.forEach((row, r) => row.forEach((c, k) => {
      const runs = c ? c.getRuns() : [];
      runs.forEach(run => { const u = run.getLinkUrl(); if (u) out.push((r+1) + ',' + (k+1) + ' | ' + disp[r][k] + ' | ' + u); });
    }));
  });
  Logger.log(out.join('\n'));
  return out;
}


function setOsakaDeadline() {
  const E = readKind_('events'), e = E.ev_osaka02; if (!e) return 'none';
  put_('events', Object.assign(e, { receipt_deadline: '2026年11月18日', age_note: '期間中、年齢による入場日の制限は原則ありません。※協賛などの都合により、一部の日程で20歳未満の方の入場を制限する場合があります。最新の情報はプレイヤーズガイドをご確認ください。', note: '受付ポータル・ポータル・領収書フォームから更新（10/24）。写真・メディア申請は要確認' }));
  return 'ok';
}


function fixAge20261024() {
  const N = readKind_('nodes'), n = N.entry_age;
  if (n) put_('nodes', Object.assign(n, { per_event:false, status:'確認済', review:'', body:
    'トーナメントには、満18歳以上の方がご参加いただけます。\n18歳未満の方も、保護者同伴であれば見学のためにご入場いただけます。ただし、次の点にご注意ください。\n・同伴の保護者の方は、トーナメントに参加できません。\n・16歳未満の方は18:00以降、16〜17歳の方は22:00以降、保護者同伴でもご入場いただけません。\n・18歳以上でも、高校在学中の方は22:00以降の入場・滞在はできません。\n\n※入場できる時間は、開催地の条例により異なる場合があります。また、協賛などの都合により、一部の日程で20歳未満の方の入場を制限する場合があります。最新の情報はプレイヤーズガイドをご確認ください。' }));
  const E = readKind_('events'), e = E.ev_osaka02;
  if (e) put_('events', Object.assign(e, { age_note: '' }));
  return 'ok';
}

/** Shared URLs are resolved on read. Existing event rows are preserved. */
function applyCommonInfo_(out) {
  const defaults = {
    media_form_url: 'https://docs.google.com/forms/d/e/1FAIpQLSdbkCtXztmyHzStAl54h3388l7Nryg9xpuUxjt1MaqNcSdMKA/viewform',
    photo_album_url_jopt: 'https://www.flickr.com/photos/190979093@N07/',
    photo_album_url_spadie: 'https://www.flickr.com/photos/201752439@N08'
  };
  Object.keys(defaults).forEach(key => {
    if (!out.vars[key] || !out.vars[key].value || /^（/.test(out.vars[key].value)) {
      out.vars[key] = Object.assign({}, out.vars[key] || {}, {key:key, value:defaults[key], valid_until:''});
    }
  });
  Object.values(out.events).forEach(event => {
    event.brand = event.brand || (/^SPADIE\b/i.test(event.name || '') ? 'SPADIE' : 'JOPT');
    event.media_form = out.vars.media_form_url.value;
    event.photo_url = out.vars['photo_album_url_' + event.brand.toLowerCase()].value;
  });
  Object.values(out.nodes).forEach(node => {
    if ((node.body || '').indexOf('【メディア申請】') < 0) return;
    node.body = node.body.replace(/【メディア申請】/g, '{{media_form_url}}');
    if (!/【(?:大会名|日程|会場|ガイドURL|領収書フォーム|領収書送付期限|年齢制限|写真アルバム)】/.test(node.body)) node.per_event = false;
  });
}
