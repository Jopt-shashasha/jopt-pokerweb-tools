/* BEGIN HARNESS EXPORT UI */
async function harnessExportEditor(el){
  el.innerHTML='<h2>Harness用JSON</h2><p>保存済みのFAQ全体を読み込み、Harnessの取込形式で出力します。</p><p class="hint">未保存の編集内容は含まれません。取込先はHarnessの「FAQ管理 → JSONを取り込む」です。JSONの生成・取込だけではLINEに公開されません。</p><div id="hx_result">保存済みデータを確認しています…</div>';
  try{
    const result=await gs('getHarnessExport');
    if(sel!=='harness-export')return;
    const data=JoptHarnessContract.normalizeFaq(result.payload),validation=JoptHarnessContract.validateFaq(data);
    const payload=Object.assign({},result.payload,{data});
    const text=JSON.stringify(payload,null,2),size=new TextEncoder().encode(text).length;
    if(size>2*1024*1024)validation.errors.push('JSONがHarnessの上限（2MB）を超えています。');
    const items=values=>values.map(x=>'<li>'+esc(x)+'</li>').join('');
    $('#hx_result').innerHTML=`<div class="infobox"><b>保存済みデータ：${esc(result.exportedAt)}（日本時間）</b><p>FAQ・メニュー ${Object.keys(data.nodes).length}件 ／ 開催大会 ${Object.keys(data.events).length}件 ／ 案内先LINE ${Object.keys(data.channels).length}件</p><p>自動回答で解決・別LINEを案内：対応済み<br>未解決・確認後に担当者へ・担当者が対応：要対応</p></div>${validation.errors.length?`<h3>修正が必要な項目（${validation.errors.length}件）</h3><ul>${items(validation.errors)}</ul>`:''}${validation.warnings.length?`<details open><summary>確認事項（${validation.warnings.length}件）</summary><p class="hint">下書きとして取り込めます。正式リリース前に確認・修正してください。</p><ul>${items(validation.warnings)}</ul></details>`:'<p>チェックを通過しました。</p>'}<div class="actions">${validation.errors.length?'':`<a class="btn pri" id="hx_download" target="_self" download="${esc(result.filename)}">JSONをダウンロード</a>`}<button class="btn sec" id="hx_refresh">最新の保存内容で再生成</button><a class="btn out" href="https:\u002f\u002fline-harness-jopt-support.japanopenpoker.workers.dev\u002fconsole\u002ffaq" target="_blank" rel="noopener">HarnessのFAQ管理を開く</a></div><details><summary>出力内容を確認</summary><textarea id="hx_json" readonly style="min-height:220px" aria-label="Harness用FAQ JSON"></textarea></details>`;
    $('#hx_json').value=text;
    if(!validation.errors.length){
      if(harnessExportEditor.blob)URL.revokeObjectURL(harnessExportEditor.blob);
      harnessExportEditor.blob=URL.createObjectURL(new Blob([text],{type:'application/json;charset=utf-8'}));
      $('#hx_download').href=harnessExportEditor.blob;
    }
    $('#hx_refresh').onclick=()=>harnessExportEditor(el);
  }catch(e){if(sel==='harness-export')$('#hx_result').textContent='生成できませんでした：'+(e.message||e);}
}
/* END HARNESS EXPORT UI */
