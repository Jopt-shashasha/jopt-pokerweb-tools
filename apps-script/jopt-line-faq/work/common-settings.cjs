const fs=require('fs');const dir='apps-script/jopt-line-faq/';let s=fs.readFileSync(dir+'work/Simple.common-before.html','utf8');
function replace(a,b){if(!s.includes(a))throw Error('Missing anchor '+a.slice(0,50));s=s.replace(a,b)}
replace('function evVal(ev,k){ return EVF[k]?ev[EVF[k]]:extraOf(ev)[k]; }',`function eventBrand(ev){ return ev.brand||(/^SPADIE\\b/i.test(ev.name||'')?'SPADIE':'JOPT'); }
function commonValue(k){return S.vars[k]&&S.vars[k].value||'';}
function evVal(ev,k){
  if(k==='メディア申請')return commonValue('media_form_url');
  if(k==='写真アルバム')return commonValue('photo_album_url_'+eventBrand(ev).toLowerCase());
  return EVF[k]?ev[EVF[k]]:extraOf(ev)[k];
}`);
replace('(evVal(ev,k)||`（${k}未入力）`)','(evVal(ev,k)||(k===\'年齢制限\'?\'\':`（${k}未入力）`))');
replace('    h+=`<div class="secttl">🔗 案内先のLINE（他の公式LINE）</div>`;',`    h+=\`<div class="secttl">🌐 共通情報・ブランド別情報</div><button class="sb" id="commonSettings">メディア申請・写真アルバム・年齢制限</button>\`;
    h+=\`<div class="secttl">🔗 案内先のLINE（他の公式LINE）</div>\`;`);
replace('    sd.innerHTML=h; doFlash(sd);','    sd.innerHTML=h; doFlash(sd);\n    $("#commonSettings").onclick=()=>{if(!leave())return;sel="common";renderEditor();};');
replace('  if(sel==="__root") return rootEditor(el);','  if(sel==="common") return commonEditor(el);\n  if(sel==="__root") return rootEditor(el);');
const a=s.indexOf('  const F=[["name","大会名"',s.indexOf('function eventEditor(')),b=s.indexOf('\n  let d=',a);if(a<0||b<0)throw Error('fields');
s=s.slice(0,a)+`  const F=[["name","大会名",""],["dates","日程",""],["venue","会場","会場名と住所"],["guide_url","プレイヤーズガイドURL",""],["receipt_form","領収書申請フォームURL",""],["receipt_deadline","領収書の送付期限",""],["age_note","入場制限の追加案内（該当する場合のみ）","本大会に追加の入場制限がある場合のみ入力"]];`+s.slice(b);
replace('    ${F.map(([k,l,ph])=>{','    <div class="f"><label>ブランド</label><select id="v_brand"><option value="JOPT" ${eventBrand(e)===\'JOPT\'?\'selected\':\'\'}>JOPT</option><option value="SPADIE" ${eventBrand(e)===\'SPADIE\'?\'selected\':\'\'}>SPADIE</option></select></div>\n    <div class="infobox">写真アルバムはブランド別の共通設定を使用します。メディア申請と年齢制限の基本ルールは「設定」で確認できます。入場制限の追加案内が空欄の場合も、共通の年齢制限は適用されます。</div>\n    ${F.map(([k,l,ph])=>{');
replace('  $("#v_active").onchange=x=>{ d.active=x.target.checked; dirty=true; };','  $("#v_active").onchange=x=>{ d.active=x.target.checked; dirty=true; };\n  $("#v_brand").onchange=x=>{ d.brand=x.target.value;dirty=true; };');
const idx=s.indexOf('function channelEditor(');s=s.slice(0,idx)+`function commonEditor(el){
  const rows=[['media_form_url','メディアパス申請フォーム（全大会共通）'],['photo_album_url_jopt','写真アルバム（JOPT共通）'],['photo_album_url_spadie','写真アルバム（SPADIE共通）']];
  const values=Object.fromEntries(rows.map(([key])=>[key,commonValue(key)]));
  const age=S.nodes.entry_age||Object.values(S.nodes).find(n=>n.label==='年齢制限');
  el.innerHTML=\`\${sbar()}<h2>共通情報・ブランド別情報</h2><div class="path">設定</div><p class="hint">ここで保存したURLをすべての大会で使用します。大会ごとの登録は不要です。</p>\${rows.map(([key,label])=>\`<div class="f"><label>\${label}</label><input type="url" data-common="\${key}" value="\${esc(values[key])}"><button class="cp" data-copy="{{\${key}}}">差し込み用の文字列をコピー</button></div>\`).join('')}<div class="actions"><button class="btn pri" id="commonSave">保存</button></div><h3>年齢制限（全大会共通）</h3><p class="hint">基本ルールは共通の回答で管理します。特定の日の入場制限などは「開催大会」の追加案内に入力してください。</p>\${age?\`<div class="infobox" style="white-space:pre-wrap">\${esc(age.body||'')}</div><button class="btn sec" id="commonAge">共通の年齢制限を編集</button>\`:''}\`;
  el.querySelectorAll('[data-common]').forEach(i=>i.oninput=()=>{values[i.dataset.common]=i.value;dirty=true;});
  el.querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>copyText(b.dataset.copy));
  if(age)$('#commonAge').onclick=()=>{if(leave())go(age.id);};
  $('#commonSave').onclick=async()=>{for(const [key] of rows){try{const u=new URL(values[key]);if(u.protocol!=='https:')throw Error();}catch(e){toast('https://で始まるURLを入力してください');return;}}
    const button=$('#commonSave');button.disabled=true;
    try{for(const [key,label] of rows)apply(await gs('saveDoc','vars',Object.assign({},S.vars[key]||{},{key,value:values[key],valid_until:'',note:label})));dirty=false;toast('保存しました');renderEditor();}catch(e){toast('保存できませんでした');button.disabled=false;}
  };
}
`+s.slice(idx);
for(const m of s.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new Function(m[1]);fs.writeFileSync(dir+'Simple.html',s);
let code=fs.readFileSync(dir+'work/Code.common-before.gs','utf8');const marker="  out.user = Session.getActiveUser().getEmail() || '';";if(!code.includes(marker))throw Error('getAll anchor');code=code.replace(marker,`  applyCommonInfo_(out);
`+marker);code+=`
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
    event.brand = event.brand || (/^SPADIE\\b/i.test(event.name || '') ? 'SPADIE' : 'JOPT');
    event.media_form = out.vars.media_form_url.value;
    event.photo_url = out.vars['photo_album_url_' + event.brand.toLowerCase()].value;
  });
  Object.values(out.nodes).forEach(node => {
    if ((node.body || '').indexOf('【メディア申請】') < 0) return;
    node.body = node.body.replace(/【メディア申請】/g, '{{media_form_url}}');
    if (!/【(?:大会名|日程|会場|ガイドURL|領収書フォーム|領収書送付期限|年齢制限|写真アルバム)】/.test(node.body)) node.per_event = false;
  });
}
`;new Function(code);fs.writeFileSync(dir+'Code.gs',code);console.log('Shared settings UI and compatibility resolver: syntax valid');
