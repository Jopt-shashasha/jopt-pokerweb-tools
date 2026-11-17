'use strict';
const $=s=>document.querySelector(s);
const field=name=>$('#registration').elements.namedItem(name);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const link=(path,text,cls='')=>`<a class="${cls}" href="#${esc(path)}">${text}</a>`;
const date=v=>v?new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(v)):'';
const bytes=v=>v==null?'':v<1048576?Math.ceil(v/1024)+' KiB':(v/1048576).toFixed(1)+' MiB';
let session=null,masters={departments:[],events:[],editions:[],categories:[],event_scopes:[],tags:[]},renderId=0,editing=null,mode='link',currentResource=null,toastTimer;
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3500);}
async function api(path,options={}){
 const headers={...options.headers};if(options.body&&!(options.body instanceof FormData))headers['content-type']='application/json';
 if(options.method&&!['GET','HEAD'].includes(options.method))headers['x-csrf-token']=session?.csrf??'';
 const res=await fetch('/api'+path,{...options,headers});let data;try{data=await res.json();}catch{throw Error('応答を読み取れません。');}
 if(!res.ok){const error=Error(data.error||'操作に失敗しました。');error.status=res.status;throw error;}return data;
}
function route(){const raw=location.hash.slice(1)||'/';const [path,query='']=raw.split('?');return {parts:path.split('/').filter(Boolean).map(decodeURIComponent),params:new URLSearchParams(query)};}
function title(text,description=''){return `<div class="page-title"><h1>${esc(text)}</h1>${description?`<p>${esc(description)}</p>`:''}</div>`;}
function searchForm(q='',compact=false){return `<form class="page-search ${compact?'compact':''}" data-search><span class="search-icon" aria-hidden="true">⌕</span><input name="q" value="${esc(q)}" aria-label="資料・ツールを検索" placeholder="資料名・用途・本文のキーワードで検索"><button type="submit">検索</button></form>`;}
const kindName=r=>r.kind==='tool'?'ツール':r.kind==='document'?'資料':'種類未分類';
const statusName=r=>r.status==='draft'?'下書き':r.status==='archived'?'アーカイブ':r.visibility==='private'?'自分だけ':'社内共有';
function readerType(r){
 if(r.has_html)return {name:'HTML資料',action:'HTMLを開く',hint:'ポータルに保存したHTMLを開きます。'};
 let u;try{u=new URL(r.open_url||r.url);}catch{return {name:'リンク未設定',action:'開く',hint:'利用先のリンクがまだ登録されていません。'};}
 if(u.hostname==='www.tampermonkey.net'||(u.hostname==='raw.githubusercontent.com'&&u.pathname.endsWith('.user.js')))return {name:'ブラウザ用ツール',action:'スクリプトを導入する',hint:'インストール画面が開きます。Tampermonkeyと対象サービスの利用権限が必要です。'};
 if(u.hostname==='docs.google.com'&&u.pathname.startsWith('/spreadsheets/'))return {name:'Google Sheet',action:'シートを開く',hint:'Google Sheetの原本を開きます。コピーや設定の要否は案内を確認してください。'};
 if(u.hostname==='script.google.com')return {name:'Webアプリ',action:'アプリを開く',hint:'実際に使用する画面を開きます。操作が記録される場合があります。'};
 if(r.reader_guide?.suggested_kind==='document'||r.kind==='document')return {name:'閲覧資料',action:'資料を読む',hint:'資料の公開先を新しいタブで開きます。'};
 return {name:r.reader_guide?.suggested_kind==='tool'||r.kind==='tool'?'Webアプリ':'外部リンク',action:r.reader_guide?.suggested_kind==='tool'||r.kind==='tool'?'アプリを開く':'リンクを開く',hint:'登録された公開先を新しいタブで開きます。'};
}
function readerSummary(r){return r.reader_guide?.summary||String(r.description||'').replace(/^何に使えるか\s*/,'').split(/\n\s*\n/)[0].slice(0,280)||'';}
function readerItems(items,ordered=false){return `<${ordered?'ol':'ul'} class="reader-points">${items.map(x=>`<li>${esc(x)}</li>`).join('')}</${ordered?'ol':'ul'}>`;}
function readerGuideSection(r,isDocument,t){
 const g=r.reader_guide;
 const content=isDocument?`${(g?.key_points||[]).length?readerItems(g.key_points):'<p class="muted">要点はまだ整理されていません。原文を確認できます。</p>'}${g?.notes?.length?`<div class="reader-notes"><h3>補足</h3>${readerItems(g.notes)}</div>`:''}`:g?`${g.requirements.length?`<div class="reader-preparation"><h3>準備するもの</h3>${readerItems(g.requirements)}</div>`:''}${g.steps.length?`<h3>最初の操作</h3>${readerItems(g.steps,true)}`:''}${g.notes.length?`<div class="reader-notes"><h3>利用前に確認</h3>${readerItems(g.notes)}</div>`:''}`:`<p class="muted">準備するものや最初の操作は、まだ整理されていません。</p><p>${esc(t.hint)}</p><p class="muted">下の「元の紹介・ファイル情報」から登録時の説明を確認できます。</p>`;
 return `<section class="reader-section"><h2>${isDocument?'要約':'使い始め方'}</h2>${content}${r.can_edit?`<button class="reader-text-button" id="edit-reader-guide">${isDocument?(g?'要約を修正・確認する':'要約を追加する'):(g?'この案内を修正・確認する':'使い始め方を追加する')}</button>`:''}</section>`;
}
function row(r){const t=readerType(r);return `<article class="resource-row reader-result"><div class="reader-list-main"><a class="reader-list-thumbnail" href="#/resource/${r.id}" aria-label="${esc(r.title)}の詳細"><img src="${esc(r.preview_image_url)}?v=${r.version}" alt="" loading="lazy"></a><div class="reader-list-copy"><p class="reader-result-type">${esc(t.name)}${r.status!=='published'||r.visibility==='private'?` · ${statusName(r)}`:''}</p><h2>${link('/resource/'+r.id,esc(r.title))}</h2>${readerSummary(r)?`<p class="row-description">${esc(readerSummary(r))}</p>`:'<p class="row-description">用途の説明は未登録です。元資料を確認できます。</p>'}${r.search_excerpt?`<p class="reader-search-match">本文：${esc(r.search_excerpt)}</p>`:''}<div class="reader-result-tags">${r.tags.slice(0,4).map(x=>link('/library?tag='+encodeURIComponent(x),esc(x),'badge')).join('')}${r.markdown?'<span class="reader-md-label">MD説明書あり</span>':''}</div></div></div><div class="meta">${esc(r.department_name||'セクション未分類')}<br>${esc(eventLabel(r))}</div><div class="meta">${esc(r.creator_name)}<br>${date(r.updated_at)}</div><div class="row-actions">${link('/resource/'+r.id,'使い方・詳細','reader-detail-link')}<button class="save" data-save="${r.id}" data-saved="${r.is_saved?'1':'0'}" aria-label="${esc(r.title)}を${r.is_saved?'保存解除':'保存'}" aria-pressed="${!!r.is_saved}">${r.is_saved?'★':'☆'}</button></div></article>`;}
function empty(text){return `<div class="empty"><p>${esc(text)}</p>${link('/library','資料・ツールの一覧へ','secondary')}</div>`;}
function pickupCard(r){return link('/resource/'+r.id,`<small>${esc(r.department_name||'セクション未分類')}</small><h3>${esc(r.title)}</h3><p><span>${esc(r.creator_name)}</span><span>→</span></p>`,'pickup-card');}
function newsRows(items){return items.map(n=>`<article class="news-row"><h3><a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a></h3>${n.summary?`<p class="news-summary">${esc(n.summary)}</p>`:''}<div class="news-meta"><small>${esc(n.source)} · 配信日 ${date(n.published_at)}</small><a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">記事の詳細 ↗</a>${n.source_url?`<a href="${esc(n.source_url)}" target="_blank" rel="noopener noreferrer">関連リンク ↗</a>`:''}</div></article>`).join('');}
async function fillNews(id,limit=3){
 try{const data=await api('/news');if(id!==renderId)return;const el=$('#news-content');if(el)el.innerHTML=(data.error?`<p class="muted">${esc(data.error)}${data.stale?' 保存済みの記事を表示しています。':''}</p>`:'')+(data.items.length?newsRows(data.items.slice(0,limit)):'<p class="muted">表示できるニュースはありません。</p>');}
 catch(e){if(id===renderId&&$('#news-content'))$('#news-content').textContent=e.message;}
}
async function home(id){
 const data=await api('/home');if(id!==renderId)return;
 $('#page').innerHTML=`<section class="hero"><h1>何をお探しですか？</h1><p>資料・ツールを、部署をこえて探す。</p>${searchForm()}<div class="browse-links">${link('/sections','セクションから探す →')}${link('/events','大会から探す →')}</div></section><div class="home-column"><section class="upload-strip"><div><strong>作ったものを、みんなの仕事へ。</strong><p>ツール・資料・Webページを、ひとつの入口から共有。</p></div><div><button class="primary" data-register="entry">＋ 登録</button></div></section><section aria-labelledby="pickup-title"><div class="section-label"><h2 id="pickup-title">PICK UP <small>登録済みの資料から自動表示</small></h2><button id="pickup-next">入れ替える ↻</button></div><div class="pickup-grid" id="pickup-grid">${data.pickup.map(pickupCard).join('')||'<p class="muted">共有済みの資料がまだありません。</p>'}</div></section><section class="news" aria-labelledby="news-title"><div class="section-label"><h2 id="news-title">AIニュース <small>ML_Bear Times</small></h2>${link('/news','一覧 →')}</div><div id="news-content"><p class="muted">ニュースを読み込んでいます…</p></div></section></div>`;void fillNews(id);
}
let filtersOpen=false;
const eventAssignments=r=>r.events??(r.event?[{event:r.event,event_scope_id:r.event_scope_id,event_scope_name:r.event_scope_name}]:[]);
const eventLabel=r=>eventAssignments(r).map(e=>[e.event,e.event_scope_name].filter(Boolean).join(' / ')).join(' · ');
async function listPage(kind,params,id){
 const query=new URLSearchParams(params);if(kind==='mine'||kind==='saved')query.set('collection',kind);
 const data=await api('/resources?'+query);if(id!==renderId)return;
 const name=kind==='mine'?'自分の資料':kind==='saved'?'保存済み':'資料・ツール';
 const opts=(items,value)=>items.map(d=>`<option value="${esc(d.id??d.name)}" ${value===(d.id??d.name)?'selected':''}>${esc(d.name)}</option>`).join('');
 const check=(key,value,label)=>`<label class="filter-check"><input type="checkbox" name="${key}" value="${esc(value)}" ${params.getAll(key).includes(value)?'checked':''}>${esc(label)}</label>`;
 const active=[...params].filter(([k,v])=>['department','event','event_scope','category','kind','tag'].includes(k)&&v);
 const labelFor=(k,v)=>({department:masters.departments,event_scope:masters.event_scopes}[k]||[]).find(x=>x.id===v)?.name??({unclassified:'未分類',tool:'ツール',document:'資料'}[v]||v);
 const pageUrl=page=>{const q=new URLSearchParams(params);q.set('page',String(page));return '/'+kind+'?'+q;};
 const scopes=(masters.event_scopes||[]).filter(x=>!params.getAll('event').length||params.getAll('event').includes(x.event));
 $('#page').innerHTML=`${title(name)}${searchForm(params.get('q')||'',true)}
 <div class="filter-toolbar"><button class="secondary" id="filter-toggle" aria-expanded="${filtersOpen}" aria-controls="library-filters">☷ フィルター${active.length?' ('+active.length+')':''}</button><span>${data.total}件</span>${active.length?link('/'+kind+(params.get('q')?'?q='+encodeURIComponent(params.get('q')):''),'条件をクリア','filter-clear'):''}</div>
 <div class="active-filters">${active.map(([k,v])=>`<button class="badge" data-remove-filter="${esc(k)}" data-filter-value="${esc(v)}">${esc(labelFor(k,v))} ×</button>`).join('')}</div>
 <form class="library-filters" id="list-filter"><div id="library-filters" ${filtersOpen?'':'hidden'}>
 <div class="filter-basic"><label>セクション<select name="department"><option value="">すべて</option><option value="unclassified" ${params.get('department')==='unclassified'?'selected':''}>未分類</option>${opts(masters.departments,params.get('department'))}</select></label>
 <label>資料の種類<select name="kind">${[['','すべて'],['unclassified','未分類'],['document','資料'],['tool','ツール']].map(([v,t])=>`<option value="${v}" ${params.get('kind')===v?'selected':''}>${t}</option>`).join('')}</select></label>
 <label>元のカテゴリ<select name="category"><option value="">すべて</option>${opts(masters.categories||[],params.get('category'))}</select></label>
 <label>開催地・季節<select name="event_scope"><option value="">すべて</option><option value="unclassified" ${params.get('event_scope')==='unclassified'?'selected':''}>シリーズ共通・未設定</option>${opts(scopes.map(x=>({...x,name:x.event+' / '+x.name})),params.get('event_scope'))}</select></label></div>
 <fieldset><legend>大会タグ <small>複数選択可・いずれかに該当</small></legend><div class="filter-checks">${masters.events.map(e=>check('event',e.name,e.name)).join('')}${check('event','unclassified','未設定')}</div></fieldset>
 <fieldset><legend>補足タグ <small>複数選択可・すべてに該当</small></legend><div class="filter-checks filter-tag-list">${(masters.tags||[]).map(t=>check('tag',t.name,t.name)).join('')||'<span class="muted">登録されたタグはありません。</span>'}</div></fieldset>
 </div><label class="filter-sort">並び順<select name="sort"><option value="updated">更新順</option><option value="name" ${params.get('sort')==='name'?'selected':''}>資料名順</option></select></label></form>
 <div class="resource-list">${data.items.map(row).join('')||empty('該当する資料はありません。')}</div>${data.total>data.page_size?`<div class="pager">${data.page>1?link(pageUrl(data.page-1),'← 前へ'):''}<span>${data.page} / ${Math.ceil(data.total/data.page_size)}</span>${data.page*data.page_size<data.total?link(pageUrl(data.page+1),'次へ →'):''}</div>`:''}`;
}
async function detailPage(resourceId,id){
 const r=await api('/resources/'+encodeURIComponent(resourceId));if(id!==renderId)return;currentResource=r;renderReaderDetail(r);
}
function renderReaderDetail(r){
 const g=r.reader_guide,t=readerType(r),summary=readerSummary(r),isDocument=r.kind==='document'||g?.suggested_kind==='document';
 const suggested=g&&(g.suggested_tags.some(x=>!r.tags.includes(x))||(g.suggested_kind&&g.suggested_kind!==r.kind));
 const related=g?.related_links||[];
 const sourcePreview=`<details class="reader-disclosure"><summary>元の紹介・ファイル情報</summary><div class="reader-disclosure-body">${r.description?`<p class="description">${esc(r.description)}</p>`:'<p class="muted">元資料には紹介文がありません。</p>'}${r.file_count?`<p class="muted">元資料 ${r.file_count}ファイル${r.total_bytes?' · '+bytes(r.total_bytes):''}</p>`:''}</div></details>`;
 $('#page').innerHTML=`<div class="breadcrumbs">${link('/library','資料・ツール')} › ${esc(r.department_name||'セクション未分類')}</div><header class="reader-heading"><div class="reader-kicker"><span>${esc(t.name)}</span>${r.status!=='published'||r.visibility==='private'?`<span>${statusName(r)}</span>`:''}${g?.status==='draft'?`<span class="reader-draft">${isDocument?'要約':'案内'}は作成者確認前</span>`:''}</div><h1>${esc(r.title)}</h1>${summary?`<p class="reader-lead">${esc(summary)}</p>`:'<p class="reader-lead muted">用途の説明はまだ登録されていません。元の紹介とリンク先を確認できます。</p>'}<p class="reader-byline">${esc(r.creator_name)} <span>·</span> ${esc(r.department_name||'セクション未分類')} <span>·</span> 更新 ${date(r.updated_at)}</p></header><div class="reader-layout"><div class="reader-main">${readerGuideSection(r,isDocument,t)}${related.length?`<section class="reader-section"><h2>一緒に使う資料・ツール</h2><div class="reader-related">${related.map(x=>`<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.label)} ↗</a>`).join('')}</div></section>`:''}${r.markdown?`<details class="reader-disclosure" data-markdown-resource="${r.id}"><summary>詳しい説明書 <small>${esc(r.markdown.filename)} · ${bytes(r.markdown.bytes)}</small></summary><div class="reader-disclosure-body"><a class="secondary" href="${esc(r.markdown.download_url)}">MDをダウンロード ↓</a><div class="markdown-content" data-markdown-body>開くと説明書を読み込みます。</div></div></details>`:''}${sourcePreview}${g?`<details class="reader-disclosure reader-provenance"><summary>${isDocument?'この要約の整理元':'この案内の整理元'}</summary><p>${esc(g.source_note)}</p></details>`:''}</div><aside class="reader-aside"><figure class="reader-visible-preview"><button type="button" id="enlarge-preview" aria-label="${esc(r.title)}のプレビューを拡大"><img src="${esc(r.preview_image_url)}?v=${r.version}" alt="${esc(r.title)}のプレビュー"></button><figcaption>プレビュー <span>クリックで拡大 ↗</span></figcaption></figure><section class="reader-start"><p class="reader-start-label">${isDocument?'資料を読む':'ここから始める'}</p><p class="reader-action-hint">${esc(t.hint)}</p>${r.open_url?`<a class="primary reader-primary" href="${esc(r.open_url)}" target="_blank" rel="noopener noreferrer">${esc(t.action)} ↗</a><p class="reader-host">${esc(r.has_html?'ポータル内のHTML':new URL(r.open_url).hostname)}</p>`:''}<button class="secondary reader-save" data-save="${r.id}" data-saved="${r.is_saved?'1':'0'}">${r.is_saved?'★ 保存済み':'☆ 保存して後で見る'}</button>${r.access_request?'<button class="secondary reader-save" id="request-access">Slackでアクセスを依頼</button>':''}${r.has_html&&r.status==='draft'?'<p class="muted">下書き・未共有のHTMLです。</p><button class="secondary reader-save" id="publish-html">確認して共有する</button>':''}</section><section class="reader-metadata"><h2>分類・タグ</h2><dl><dt>セクション</dt><dd>${r.department_id?link('/library?department='+encodeURIComponent(r.department_id),esc(r.department_name)):'未分類'}</dd><dt>大会・開催回</dt><dd>${eventAssignments(r).map(e=>link('/library?event='+encodeURIComponent(e.event)+(e.event_scope_id?'&event_scope='+encodeURIComponent(e.event_scope_id):''),esc([e.event,e.event_scope_name].filter(Boolean).join(' / ')),'badge')).join(' ')||'未設定'} ${esc(r.edition||'')}</dd></dl>${r.categories?.length?`<div class="reader-tags">${r.categories.map(c=>link('/library?category='+encodeURIComponent(c),esc(c),'badge')).join('')}</div>`:''}${r.tags.length?`<div class="reader-tags">${r.tags.map(x=>link('/library?tag='+encodeURIComponent(x),esc(x),'badge')).join('')}</div>`:'<p class="muted">補足タグは未設定です。</p>'}${r.can_edit&&g?`<div class="reader-suggestions"><p>分類・タグの整理案 <small>${suggested?'未適用':'反映済み'}</small></p><span class="badge">${g.suggested_kind==='tool'?'ツール':g.suggested_kind==='document'?'資料':'種類未設定'}</span>${g.suggested_tags.map(x=>`<span class="badge">${esc(x)}</span>`).join('')}${suggested?'<button class="reader-text-button" id="apply-reader-classification">この分類・タグを採用</button>':''}</div>`:''}</section><details class="reader-disclosure reader-record"><summary>登録情報</summary><dl><dt>作成者</dt><dd>${esc(r.creator_name)}</dd><dt>登録元</dt><dd>${esc(r.source_system||'業務ポータル')}</dd><dt>共有範囲</dt><dd>${statusName(r)}</dd><dt>登録日</dt><dd>${date(r.created_at)}</dd></dl>${r.can_edit?'<button class="reader-text-button" id="edit-resource">登録情報を編集</button>':''}</details></aside></div>`;
}
function openReaderEditor(){
 const isDocument=currentResource.kind==='document'||currentResource.reader_guide?.suggested_kind==='document';
 const g=currentResource.reader_guide||{key_points:[],summary:readerSummary(currentResource),requirements:[],steps:[],notes:[],suggested_tags:[],suggested_kind:null,status:'draft'};
 const area=(name,label,value)=>`<label>${label}<textarea name="${name}" rows="3" maxlength="5000">${esc(value.join('\n'))}</textarea><small>1行に1項目。空欄でも保存できます。</small></label>`;
 info(isDocument?'要約を整理':'使い始め方を整理',`<form id="reader-guide-form"><label>${isDocument?'概要（短く）':'何に使えるか'}<textarea name="summary" required maxlength="500" rows="3">${esc(g.summary)}</textarea></label>${isDocument?area('key_points','要点',g.key_points||[]):area('requirements','準備するもの',g.requirements)+area('steps','最初の操作',g.steps)}${area('notes',isDocument?'補足（必要な場合）':'利用前に確認',g.notes)}<label>種類の整理案<select name="suggested_kind"><option value="">未設定</option><option value="tool" ${g.suggested_kind==='tool'?'selected':''}>ツール</option><option value="document" ${g.suggested_kind==='document'?'selected':''}>資料</option></select></label><label>タグの整理案<input name="suggested_tags" maxlength="720" value="${esc(g.suggested_tags.join(', '))}"></label><label class="checkbox"><input name="confirmed" type="checkbox" ${g.status==='confirmed'?'checked':''}>案内の内容を確認した</label><p class="muted">分類・タグの整理案は、詳細ページで採用するまで元の分類へ反映されません。</p><p class="error" id="reader-guide-error" role="alert"></p><button class="primary" type="submit">案内を保存する</button></form>`);
}
async function agentPage(requestId,id){
 const r=await api('/agent/requests/'+encodeURIComponent(requestId));if(id!==renderId)return;
 const names={search:'資料を検索',read:'資料を取得',register:'資料を登録'},b=r.input;
 let resultHtml='';
 if(r.result){
  const v=r.result;
  if(r.state==='error')resultHtml=`<p class="error">${esc(v.error)}</p>`;
  else if(r.operation==='search')resultHtml=`<p>${v.total}件見つかりました。</p><div class="resource-list">${v.items.map(x=>`<article class="resource-row"><div><h2>${link('/resource/'+encodeURIComponent(x.id),esc(x.title))}</h2><p>${esc(x.description)}</p></div></article>`).join('')}</div>`;
  else resultHtml=`<h2>${esc(v.title)}</h2><p>${esc(v.description||'')}</p>${link('/resource/'+encodeURIComponent(v.id),'資料の詳細を見る →','secondary')}`;
 }
 const details=r.operation==='search'?`<dt>検索キーワード</dt><dd>${esc(b.q||'すべて')}</dd>`:r.operation==='read'?`<dt>資料</dt><dd>${esc(r.resource_title||'資料を確認')}</dd>`:`<dt>タイトル</dt><dd>${esc(b.title)}</dd><dt>リンク先</dt><dd>${esc(b.url)}</dd><dt>何に使えるか</dt><dd>${esc(b.description||'未入力')}</dd>${b.markdown?`<dt>説明書（MD）</dt><dd>${esc(b.markdown.filename)} · ${bytes(b.markdown.bytes)}<details><summary>冒頭を確認</summary><pre>${esc(b.markdown.excerpt)}</pre></details></dd>`:''}<dt>大会タグ</dt><dd>${eventAssignments(b).map(e=>esc(e.event)+(e.event_scope_id?" / "+esc(masters.event_scopes.find(s=>s.id===e.event_scope_id)?.name||e.event_scope_id):"")).join(" · ")||"未設定"}</dd><dt>補足タグ</dt><dd>${(b.tags||[]).map(esc).join(" · ")||"未設定"}</dd><dt>作成者</dt><dd>${esc(r.creator_name)}</dd><dt>共有範囲</dt><dd>${b.visibility==='company'?'社内共有':'自分だけ'}</dd><dt>状態</dt><dd>${b.status==='published'?'共有中':'下書き'}</dd>`;
 $('#page').innerHTML=`${title('Codexからの依頼：'+names[r.operation],'実行結果は、この依頼を作成したCodexへ返されます。')}<section class="detail-side"><h2>操作するアカウント</h2><p>${esc(session.user.name)} · ${esc(session.user.email)}</p><dl>${details}</dl>${r.state==='pending'?`<div class="detail-actions"><button class="primary" data-agent-execute="${r.id}">${r.operation==='register'?'この内容で登録する':names[r.operation]+'する'}</button><button class="secondary" data-agent-cancel="${r.id}">キャンセル</button></div>`:`<p role="status">${r.state==='done'?'完了しました。Codexで結果を取得できます。':r.state==='cancelled'?'キャンセルしました。':'操作できませんでした。'}</p>${resultHtml}`}</section>`;
}
async function render(){
 const id=++renderId;currentResource=null;const {parts,params}=route();const kind=parts[0]||'home';
 document.querySelectorAll('[data-nav]').forEach(a=>{const on=a.dataset.nav===kind;a.classList.toggle('active',on);if(on)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
 if(!session?.user){$('#page').innerHTML=`<section class="login-box"><h1>必要な資料を、ひとつの入口から。</h1><p>会社のGoogleアカウントでログインしてください。</p>${session?.local_dev?'<button class="primary" id="local-login">このPCの開発環境を開く</button>':session?.google_configured?'<a class="primary" href="/auth/google">Googleでログイン</a>':'<p>Googleログインの接続設定が必要です。</p>'}<p class="muted">ログイン状態はこのブラウザに保存されます。共有PCでは利用後にログアウトしてください。</p></section>`;return;}
 $('#page').innerHTML='<p class="empty">読み込んでいます…</p>';
 try{
  if(kind==='home')await home(id);
  else if(['library','mine','saved'].includes(kind))await listPage(kind,params,id);
  else if(kind==='resource'&&parts[1])await detailPage(parts[1],id);
  else if(kind==='review')location.replace('#/library');
  else if(kind==='agent'&&parts[1])await agentPage(parts[1],id);
  else if(kind==='sections')$('#page').innerHTML=`${title('セクションから探す')}<div class="directory">${masters.departments.map(d=>link('/library?department='+encodeURIComponent(d.id),`<strong>${esc(d.name)}</strong><small>${d.count}件 →</small>`)).join('')}${link('/library?department=unclassified','<strong>未分類</strong><small>分類されていない資料 →</small>')}</div>`;
  else if(kind==='events'){
   const event=parts[1],scopes=(masters.event_scopes||[]).filter(x=>x.event===event);
   if(!event)$('#page').innerHTML=`${title('大会から探す','共通・大会シリーズから資料を探せます。分類の設定は任意です。')}<div class="directory">${masters.events.map(d=>link(d.name==='共通'?'/library?event='+encodeURIComponent(d.name):'/events/'+encodeURIComponent(d.name),`<strong>${esc(d.name)}</strong><small>${d.count}件 →</small>`)).join('')}</div>${link('/library?event=unclassified','大会未設定の資料を見る →','secondary')}`;
   else $('#page').innerHTML=`<div class="breadcrumbs">${link('/events','大会から探す')} › ${esc(event)}</div>${title(event,'開催地・季節を選択してください。')}<div class="directory">${link('/library?event='+encodeURIComponent(event),'<strong>すべての資料</strong><small>一覧 →</small>')}${link('/library?event='+encodeURIComponent(event)+'&event_scope=unclassified','<strong>シリーズ共通</strong><small>一覧 →</small>')}${scopes.map(d=>link('/library?event='+encodeURIComponent(event)+'&event_scope='+encodeURIComponent(d.id),`<strong>${esc(d.name)}</strong><small>${d.count}件 →</small>`)).join('')}</div>${session.user.role==='admin'&&event!=='共通'?`<button class="secondary" data-add-scope="${esc(event)}">開催地・季節を追加</button>`:''}`;
  }
  else if(kind==='news'){$('#page').innerHTML=`${title('AIニュース','ML_Bear Times · 個別ニュースと本文抜粋。詳細は配信元で確認できます。')}<div id="news-content"><p class="muted">読み込んでいます…</p></div>`;void fillNews(id,20);}
  else $('#page').innerHTML=empty('ページが見つかりません。');
 }catch(e){if(id!==renderId)return;if(e.status===401){session.user=null;await render();return;}$('#page').innerHTML=`<div class="empty"><h2>表示できませんでした</h2><p class="error">${esc(e.message)}</p><button class="secondary" id="retry">再読み込み</button></div>`;}
}
async function refreshSession(){session=await api('/me');$('#local-banner').hidden=!session.local_dev;$('#register').hidden=!session.user;$('#account').textContent=session.user?session.user.name:'ログイン';if(session.user)masters=await api('/masters');}
function info(titleText,body){$('#info-title').textContent=titleText;$('#info-body').innerHTML=body;$('#info-dialog').showModal();}
function openRegistrationEntry(){
 info('登録',`<p class="registration-intro">登録方法を選んでください。</p><div class="registration-choices"><button class="registration-choice" id="register-with-ai"><span class="registration-recommended">おすすめ</span><strong>AIで登録</strong><span>制作に使ったAIに、用途や説明を整理して登録してもらいます。</span><b>依頼方法を見る →</b></button><button class="registration-choice" id="register-manually"><strong>手動で登録</strong><span>リンクやHTMLファイルを指定し、内容を自分で入力します。</span><b>入力画面へ →</b></button></div>`);
}
function openAiRegistration(){
 const prompt=`この成果物を業務ポータル（${location.origin}）に登録してください。\nまずMCPのportal_registration_optionsで現在の分類候補を確認し、この会話と実際の内容から関連する大会を複数選び、eventsで送ってください。大会ごとの開催地・季節と、検索に役立つ補足タグも整理してください。会社共通の内容は共通、分からない開催地は空欄にしてください。タイトルの単語だけで分類しないでください。用途が他の部署の人にも分かる短い説明と、原本のURLを整理してください。portal_registration_optionsで現在の分類一覧を取得し、この成果物の内容と制作中の会話から、関連する大会を複数選んでeventsに指定してください。大会名が文中にあるだけで機械的に判断せず、複数大会に関係する場合はそれぞれ付けてください。開催地が不明な場合は補完しないでください。用途に合う補足タグも整理してください。既存のREADME.mdがあれば内容を確認して一緒に添付してください。説明と現在の成果物が食い違う場合は、登録前に知らせてください。\n既に同じ成果物が登録されているか確認し、重複登録を避けてください。今回対応していない更新・ファイル送信が必要な場合は、完了したことにせず、必要な操作を知らせてください。\nブラウザで現在のアカウントと登録内容を確認できるようにし、実際に登録できた場合はポータルのURLを返してください。`;
 info('AIに登録を依頼',`<p class="registration-intro">成果物を作ったAIの会話に、次の依頼文を貼り付けてください。</p><p class="registration-availability">現在の試用版は、このPCの連携済みCodexで利用できます。その他のAIは接続準備中です。</p><label class="registration-prompt-label">AIへの依頼文<textarea id="ai-registration-prompt" readonly rows="7">${esc(prompt)}</textarea></label><div class="info-actions"><button class="primary" id="copy-ai-registration">依頼文をコピー</button><button class="secondary" id="register-manually">手動で登録する</button></div><details class="registration-setup"><summary>初めて使う場合・対応状況</summary><p>MCP連携が必要です。現在の試用版では、このPCのCodexからリンク・READMEを登録できます。Claude・Grokなどの接続と、AIからのHTMLファイル送信は準備中です。</p><p>連携していないAIに依頼文を貼るだけでは、登録は完了しません。</p></details><button class="reader-text-button" id="registration-back">← 登録方法に戻る</button>`);
}
async function openRegistration(selected='link',resource=null){
 masters=await api('/masters');
 editing=resource;mode=selected;$('#registration').reset();$('#form-error').textContent='';$('#upload-status').textContent='';
 const f=$('#registration');field('department_id').innerHTML='<option value="">未分類</option>'+masters.departments.map(d=>`<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
 $('#creator-field').hidden=session.user.role!=='admin';if(session.user.role==='admin'){const creators=await api('/admin/creators');field('creator_id').innerHTML=creators.map(u=>`<option value="${u.id}">${esc(u.name)} · ${esc(u.email)}</option>`).join('');field('creator_id').value=resource?.creator_id??session.user.id;}
 $('#registration-title').textContent=resource?'資料を編集':'資料・ツールを登録';$('#status-field').hidden=!resource;$('.tabs').hidden=!!resource;
 if(resource){for(const k of ['title','description','department_id','kind','edition','visibility','status'])field(k).value=resource[k]??'';field('url').value=resource.url??'';field('tags').value=resource.tags.join(', ');field('access_request').checked=!!resource.access_request;}
 renderEventChoices(resource?eventAssignments(resource):[]);updateTagSuggestions();$('#markdown-hint').textContent=resource?.markdown?`現在：${resource.markdown.filename}。ファイルを選ぶと置き換えます。`:'作成済みのREADME.mdを添付できます。本文も検索対象になります。';
 setMode(mode);$('#register-dialog').showModal();
}
function renderEventChoices(values){
 $('#event-choices').innerHTML=masters.events.map(e=>{const selected=values.find(x=>x.event===e.name),scopes=masters.event_scopes.filter(s=>s.event===e.name);return `<div class="event-choice"><label class="checkbox"><input type="checkbox" name="resource_event" value="${esc(e.name)}" ${selected?'checked':''}>${esc(e.name)}</label>${scopes.length?`<select data-event-scope="${esc(e.name)}" aria-label="${esc(e.name)}の開催地・季節" ${selected?'':'disabled'}><option value="">シリーズ共通</option>${scopes.map(s=>`<option value="${esc(s.id)}" ${selected?.event_scope_id===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select>`:''}</div>`;}).join('');
}
function selectedEvents(){return [...document.querySelectorAll('#event-choices input:checked')].map(input=>({event:input.value,event_scope_id:[...document.querySelectorAll('[data-event-scope]')].find(s=>s.dataset.eventScope===input.value)?.value||null}));}
function updateTagSuggestions(){
 const raw=field('tags').value.split(/[,、]/),term=(raw.at(-1)||'').normalize('NFKC').trim().toLowerCase();
 const existing=raw.slice(0,-1).map(x=>x.normalize('NFKC').trim().toLowerCase());
 $('#tag-suggestions').innerHTML=(masters.tags||[]).filter(x=>!existing.includes(x.name.toLowerCase())&&(!term||x.name.toLowerCase().includes(term))).slice(0,8).map(x=>`<button type="button" class="secondary" data-add-tag="${esc(x.name)}">＋ ${esc(x.name)}</button>`).join('');
}
function setMode(value){mode=value;document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('selected',b.dataset.mode===mode));$('#url-field').hidden=mode==='html';$('#file-field').hidden=mode!=='html'||!!editing;field('url').required=mode==='link';field('file').required=mode==='html'&&!editing;$('#submit-registration').textContent=editing?'変更を保存':mode==='html'?'アップロードして確認':'登録する';}
function bodyFromForm(){return {title:field('title').value,description:field('description').value,url:mode==='link'?field('url').value:null,department_id:field('department_id').value||null,kind:field('kind').value||null,events:selectedEvents(),edition:field('edition').value||null,tags:field('tags').value.split(/[,、]/).map(t=>t.trim()).filter(Boolean),visibility:field('visibility').value,status:editing?field('status').value:'published',access_request:field('access_request').checked,...(session.user.role==='admin'?{creator_id:field('creator_id').value}:{}),...(editing?{version:editing.version}:{})};}
function bodyFromResource(r,overrides={}){return {title:r.title,description:r.description,url:r.url,department_id:r.department_id,kind:r.kind,events:eventAssignments(r).map(e=>({event:e.event,event_scope_id:e.event_scope_id??null})),edition:r.edition,tags:r.tags,visibility:r.visibility,status:r.status,access_request:!!r.access_request,creator_id:r.creator_id,version:r.version,...overrides};}
function uploadHtml(data,file,markdown){return new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST','/api/resources/upload');xhr.responseType='json';xhr.setRequestHeader('x-csrf-token',session.csrf);xhr.upload.onprogress=e=>{if(e.lengthComputable)$('#upload-status').textContent=Math.round(e.loaded/e.total*100)+'% アップロード';};xhr.onload=()=>xhr.status>=200&&xhr.status<300?resolve(xhr.response):reject(Error(xhr.response?.error||'アップロードに失敗しました。'));xhr.onerror=()=>reject(Error('通信に失敗しました。'));const fd=new FormData();fd.append('metadata',JSON.stringify(data));if(file)fd.append('file',file);if(markdown)fd.append('markdown_file',markdown);xhr.send(fd);});}
$('#registration').addEventListener('submit',async e=>{e.preventDefault();const button=$('#submit-registration');button.disabled=true;$('#form-error').textContent='';try{const body=bodyFromForm(),md=field('markdown_file').files[0];if(md&&md.size>256*1024)throw Error('MDは256 KB以下で指定してください。');if(editing&&md)body.markdown={filename:md.name,content:await md.text()};let r;if(editing)r=await api('/resources/'+editing.id,{method:'PUT',body:JSON.stringify(body)});else if(mode==='html'||md)r=await uploadHtml(body,mode==='html'?field('file').files[0]:null,md);else r=await api('/resources',{method:'POST',body:JSON.stringify(body)});$('#register-dialog').close();masters=await api('/masters');location.hash='/resource/'+r.id;await render();toast(editing?'変更を保存しました。':mode==='html'?'HTMLを保存しました。プレビューを確認してください。':'登録しました。');}catch(err){$('#form-error').textContent=err.message;}finally{button.disabled=false;$('#upload-status').textContent='';}});
document.addEventListener('submit',async e=>{if(e.target.id==='scope-form'){e.preventDefault();try{await api('/admin/event-scopes',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});$('#info-dialog').close();masters=await api('/masters');await render();}catch(err){toast(err.message);}return;}if(!e.target.matches('[data-search]'))return;e.preventDefault();const q=new FormData(e.target).get('q');const {parts,params}=route();params.set('q',q);params.delete('page');location.hash='/'+(['mine','saved'].includes(parts[0])?parts[0]:'library')+'?'+params;});
document.addEventListener('input',e=>{if(e.target.name==='tags')updateTagSuggestions();});
document.addEventListener('change',e=>{
 if(e.target.name==='resource_event'){const scope=[...document.querySelectorAll('[data-event-scope]')].find(s=>s.dataset.eventScope===e.target.value);if(scope)scope.disabled=!e.target.checked;}
 if(e.target.closest('#list-filter')){const {parts,params}=route();for(const key of ['department','kind','category','event_scope','event','tag','sort','page'])params.delete(key);for(const [key,value] of new FormData($('#list-filter'))){if(value&&!(key==='event_scope'&&e.target.name==='event'))params.append(key,value);}location.hash='/'+parts[0]+'?'+params;}
});
document.addEventListener('click',async e=>{
 const b=e.target.closest('button');if(!b)return;
 try{
  if(b.id==='filter-toggle'){filtersOpen=!filtersOpen;$('#library-filters').hidden=!filtersOpen;b.setAttribute('aria-expanded',String(filtersOpen));return;}
  if(b.dataset.removeFilter){const {parts,params}=route(),key=b.dataset.removeFilter;params.delete(key,b.dataset.filterValue);if(key==='event')params.delete('event_scope');params.delete('page');location.hash='/'+parts[0]+'?'+params;return;}
  if(b.classList.contains('close')){b.closest('dialog').close();return;}
  if(b.dataset.addTag){const tags=field('tags').value.split(/[,、]/);tags[tags.length-1]=b.dataset.addTag;field('tags').value=tags.filter(x=>x.trim()).join(', ')+', ';updateTagSuggestions();return;}
  if(b.dataset.addScope){info('開催地・季節を追加',`<form id="scope-form"><input type="hidden" name="event" value="${esc(b.dataset.addScope)}"><label>名称<input name="name" required maxlength="60" placeholder="例：Yokohama"></label><button class="primary" type="submit">追加する</button></form>`);return;}
  if(b.dataset.mode){setMode(b.dataset.mode);return;}
  if(b.id==='register'||b.dataset.register){if(!session.user)return;openRegistrationEntry();return;}
  if(b.id==='register-with-ai'){$('#info-dialog').close();openAiRegistration();return;}
  if(b.id==='register-manually'){$('#info-dialog').close();await openRegistration('link');return;}
  if(b.id==='registration-back'){$('#info-dialog').close();openRegistrationEntry();return;}
  if(b.id==='copy-ai-registration'){await navigator.clipboard.writeText($('#ai-registration-prompt').value);b.textContent='コピーしました';toast('AIへの依頼文をコピーしました。');return;}
  if(b.id==='copy-ai-registration'){await navigator.clipboard.writeText($('#ai-registration-prompt').value);b.textContent='コピーしました';toast('依頼文をコピーしました。');return;}
  if(b.dataset.agentExecute||b.dataset.agentCancel){b.disabled=true;const requestId=b.dataset.agentExecute??b.dataset.agentCancel;await api('/agent/requests/'+requestId+(b.dataset.agentExecute?'/execute':'/cancel'),{method:'POST'});await render();return;}
  if(b.id==='local-login'){const r=await fetch('/auth/local',{method:'POST',headers:{'x-portal-local':'1'}});if(!r.ok)throw Error('開発環境を開けませんでした。');await refreshSession();await render();return;}
  if(b.id==='account'){await refreshSession();if(!session.user){await render();return;}info('アカウント',`<p class="info-copy">${esc(session.user.name)}<br>${esc(session.user.email)}<br>${session.user.role==='admin'?'管理者':'メンバー'}</p><p class="info-copy">このブラウザのログイン状態を使用しています。ブラウザを閉じても保持されます。<br>30日間利用がない場合、またはログインから90日後に再ログインが必要です。</p><button class="secondary" id="logout">このブラウザからログアウト</button>`);return;}
  if(b.id==='logout'){const r=await fetch('/auth/logout',{method:'POST',headers:{'x-csrf-token':session.csrf}});if(!r.ok)throw Error('ログアウトに失敗しました。');$('#info-dialog').close();await refreshSession();await render();return;}
  if(b.dataset.save){b.disabled=true;await api('/resources/'+b.dataset.save+'/saved',{method:b.dataset.saved==='1'?'DELETE':'PUT'});toast(b.dataset.saved==='1'?'保存を解除しました。':'保存しました。');await render();return;}
  if(b.id==='edit-resource'){await openRegistration(currentResource.has_html?'html':'link',currentResource);return;}
  if(b.id==='edit-reader-guide'){openReaderEditor();return;}
  if(b.id==='enlarge-preview'){const r=currentResource;info('プレビュー',`<img class="reader-preview-full" src="${esc(r.preview_image_url)}?v=${r.version}" alt="${esc(r.title)}のプレビュー"><p class="muted">${esc(r.title)}</p><a class="secondary" href="${esc(r.preview_image_url)}?v=${r.version}" target="_blank" rel="noopener noreferrer">画像を大きく開く ↗</a>`);return;}
  if(b.id==='apply-reader-classification'){
   const r=currentResource,g=r.reader_guide;b.disabled=true;
   await api('/resources/'+r.id,{method:'PUT',body:JSON.stringify(bodyFromResource(r,{kind:g.suggested_kind||r.kind,tags:[...new Set([...r.tags,...g.suggested_tags])]}))});
   masters=await api('/masters');await render();toast('分類・タグを反映しました。');return;
  }
  if(b.id==='publish-html'){info('HTMLを共有する',`<p class="info-copy">プレビューで内容を確認しましたか？<br>共有範囲：${currentResource.visibility==='company'?'社内共有':'自分だけ'}<br>元のHTMLは変更されません。</p><button class="primary" id="confirm-publish">確認済み・共有する</button>`);return;}
  if(b.id==='confirm-publish'){await api('/resources/'+currentResource.id,{method:'PUT',body:JSON.stringify(bodyFromResource(currentResource,{status:'published'}))});$('#info-dialog').close();await render();toast('共有設定を保存しました。');return;}
  if(b.id==='pickup-next'){const d=await api('/home');if($('#pickup-grid'))$('#pickup-grid').innerHTML=d.pickup.map(pickupCard).join('');return;}
  if(b.id==='codex'){info('Codexと連携','<p class="info-copy">ローカルMCPから検索・資料取得・リンク登録を依頼できます。Codexが開く依頼ページを、このブラウザにログイン中のアカウントで実行します。</p><p class="info-copy">Codexとのアカウント紐付けは不要です。接続にはこのPCのMCP設定が必要です。HTMLファイルの転送・ニュースの自動通知はまだ未対応です。</p>');return;}
  if(b.id==='slack'||b.id==='request-access'){info('Slackでアクセスを依頼','<p class="info-copy">リンク先の資料を閲覧できない場合、公開者へアクセスを依頼するための連携です。\nSlackの接続先はまだ設定されていないため、現在は通知やGitHub招待は送信されません。</p>');return;}
  if(b.id==='retry')await render();
 }catch(err){toast(err.message);b.disabled=false;}
});
document.addEventListener('submit',async e=>{
 if(e.target.id!=='reader-guide-form')return;e.preventDefault();const f=e.target,button=f.querySelector('[type="submit"]');button.disabled=true;
 try{const v=new FormData(f),lines=name=>String(v.get(name)||'').split('\n').map(x=>x.trim()).filter(Boolean),r=currentResource;
  const guide={...(r.reader_guide||{related_links:[],source_note:'作成者がポータルから登録した案内。'}),summary:String(v.get('summary')),requirements:lines('requirements'),steps:lines('steps'),key_points:lines('key_points'),notes:lines('notes'),suggested_kind:v.get('suggested_kind')||null,suggested_tags:String(v.get('suggested_tags')||'').split(/[,、]/).map(x=>x.trim()).filter(Boolean),status:v.get('confirmed')?'confirmed':'draft'};
  await api('/resources/'+r.id+'/reader-guide',{method:'PUT',body:JSON.stringify({version:r.version,guide})});$('#info-dialog').close();await render();toast('案内を保存しました。');
 }catch(err){$('#reader-guide-error').textContent=err.message;}finally{button.disabled=false;}
});
document.addEventListener('toggle',async e=>{
 const el=e.target;if(!el.matches?.('[data-markdown-resource]')||!el.open||el.dataset.markdownLoaded)return;
 const target=el.querySelector('[data-markdown-body]');target.textContent='説明書を読み込んでいます…';el.dataset.markdownLoaded='loading';
 try{const md=await api('/resources/'+encodeURIComponent(el.dataset.markdownResource)+'/markdown');if(el.isConnected){target.innerHTML=md.rendered_html;el.dataset.markdownLoaded='done';}}
 catch(err){target.textContent=err.message;delete el.dataset.markdownLoaded;}
},true);
window.addEventListener('hashchange',()=>{void render();window.scrollTo({top:0});});
$('.skip').addEventListener('click',e=>{e.preventDefault();$('#page').focus();});
(async()=>{try{await refreshSession();await render();}catch(e){$('#page').innerHTML=`<p class="empty error">${esc(e.message)}</p>`;}})();
