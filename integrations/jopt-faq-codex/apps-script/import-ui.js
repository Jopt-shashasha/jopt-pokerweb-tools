function eventImportEditor(el){
  const labels={name:'大会名',brand:'ブランド',dates:'日程',venue:'会場',guide_url:'公開プレイヤーズガイドURL',receipt_deadline:'領収書の送付期限',preentry_deadline:'事前予約の申込期限',age_note:'入場制限の追加案内'};
  el.innerHTML=`<h2>AIの登録内容を取り込む</h2><p class="hint">Codexが作成したJSONを読み込み、根拠と差分を確認して保存します。この操作ではHarnessに公開しません。</p><div class="f"><label>導入JSONファイル</label><input type="file" id="ei_file" accept=".json,application/json"></div><div class="f"><label>またはJSONを貼り付け</label><textarea id="ei_json" style="min-height:220px" placeholder="Codexが作成したJSONを貼り付けてください"></textarea></div><button class="btn pri" id="ei_preview">内容を確認</button><div id="ei_result" style="margin-top:20px"></div>`;
  let token=null;
  const reset=()=>{token=null;$('#ei_result').innerHTML='';};
  $('#ei_json').oninput=reset;
  $('#ei_file').onchange=async e=>{reset();const f=e.target.files[0];if(!f)return;if(f.size>160000){toast('ファイルが大きすぎます');return;}$('#ei_json').value=await f.text();};
  $('#ei_preview').onclick=async()=>{
    reset();const b=$('#ei_preview');b.disabled=true;
    try{
      const r=await gs('previewEventImport',$('#ei_json').value);token=r.token;
      $('#ei_result').innerHTML=`<h3>${r.operation==='create'?'新規登録':'更新'}：${esc(r.name)}</h3><p class="hint">${r.event_id?'大会ID：'+esc(r.event_id):'新しい大会を作成します。'}</p>${r.changes.map(c=>`<div class="infobox"><b>${esc(labels[c.field]||c.field)}</b><div>変更前：${esc(c.before||'（空欄）')}</div><div>変更後：${esc(c.after||'（空欄）')}</div>${c.evidence.map(s=>`<details><summary>出典：${esc(s.location)}</summary><p>${s.url==='user'?'利用者の指定':`<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>`}</p><p style="white-space:pre-wrap">${esc(s.quote)}</p></details>`).join('')}</div>`).join('')||'<p>登録済みの値と同じです。</p>'}${r.unresolved.length?`<h3>未確認（登録・上書きしません）</h3>${r.unresolved.map(x=>`<p>${esc(labels[x.field]||x.field)}：${esc(x.reason)}</p>`).join('')}`:''}<div class="evbox"><label><input type="checkbox" id="ei_active" ${r.active?'checked':''}>LINEに表示する</label><p class="hint">新規大会は非表示が初期値です。変更する場合は確認してください。</p></div><label class="hint"><input type="checkbox" id="ei_confirm">出典・変更内容・表示状態を確認しました</label><div class="actions"><button class="btn pri" id="ei_commit" disabled>確認した内容を保存</button></div>`;
      $('#ei_confirm').onchange=e=>{$('#ei_commit').disabled=!e.target.checked;};
      $('#ei_commit').onclick=async()=>{
        const commit=$('#ei_commit');commit.disabled=true;
        try{const out=await gs('commitEventImport',token,$('#ei_active').checked);apply(out.data);dirty=false;filter='events';sel='ev:'+out.event_id;render();toast('保存しました');}
        catch(e){token=null;$('#ei_result').innerHTML=`<p class="hint">${esc(e.message||'保存できませんでした。内容を再確認してください。')}</p>`;}
      };
    }catch(e){$('#ei_result').innerHTML=`<p class="hint">${esc(e.message||'導入JSONを確認してください。')}</p>`;}
    finally{b.disabled=false;}
  };
}
