/** Business-facing labels and messages are supplied by the approved FAQ JSON. */
export function intakeForm(): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FAQ</title>
  <style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#18392b}label{display:block;margin-top:1rem}input,button{box-sizing:border-box;width:100%;padding:12px;font-size:16px;margin:.4rem 0;border:1px solid #bbc9c2;border-radius:8px}button{background:#236745;color:white}button:disabled{opacity:.5}#path{white-space:pre-wrap}#status{overflow-wrap:anywhere}</style>
  <main><h1 id="title">FAQ</h1><p id="path"></p><p id="status" role="status"></p><form id="form" hidden>
  <label id="glabel" for="game" hidden></label><input id="game" inputmode="numeric" pattern="[0-9]{8}" maxlength="8" autocomplete="off" hidden>
  <label id="gslabel" for="games" hidden></label><input id="games" pattern="[0-9]{4}-[0-9]{4}" maxlength="9" autocomplete="off" hidden>
  <label id="ilabel" for="image" hidden></label><input id="image" type="file" accept="image/jpeg,image/png,image/gif,image/webp" hidden>
  <button id="submit" type="submit"></button></form><button id="withdraw" hidden type="button"></button></main>
  <script nonce="${nonce}">(async()=>{
    const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
    const el=id=>document.getElementById(id);let info,policy;
    async function call(name,body,type='application/json'){
      const r=await fetch('/api/faq-intake/'+name,{method:'POST',headers:{'X-FAQ-Intake-Token':token,'Content-Type':type},body:type==='application/json'?JSON.stringify(body||{}):body});
      if(!r.ok)throw Error('HTTP '+r.status);return (await r.json()).data;
    }
    function render(){
      policy=info.policy;el('title').textContent=policy.title;el('path').textContent=info.classification;
      for(const [id,label,needed,text] of [['game','glabel',policy.gameId,policy.gameIdLabel],['games','gslabel',policy.gamesId,policy.gamesIdLabel],['image','ilabel',policy.image,policy.imageLabel]]){
        el(id).hidden=el(label).hidden=!needed;el(label).textContent=text||'';
        el(id).required=needed&&(id==='image'?!info.hasImage:!info.submitted);
        el(id).disabled=id==='image'?info.hasImage:info.submitted;
      }
      el('submit').textContent=policy.submitLabel;el('form').hidden=info.submitted&&(!policy.image||info.hasImage||info.status==='needs_staff');
      el('withdraw').hidden=!info.hasImage;el('withdraw').textContent=policy.withdrawLabel||'';
      el('status').textContent=info.imageWithdrawn?policy.withdrawText||'':info.submitted&&(!policy.image||info.hasImage)?policy.successText:policy.title;
    }
    try{info=await call('info');render();
      el('form').onsubmit=async event=>{
        event.preventDefault();if(!el('form').reportValidity())return;el('submit').disabled=true;
        try{
          if(!info.submitted)await call('submit',{...(policy.gameId?{gameId:el('game').value}:{}),...(policy.gamesId?{gamesId:el('games').value}:{})});
          if(policy.image&&!info.hasImage){const file=el('image').files[0];if(!file||file.size>10485760)throw Error('HTTP 413');await call('image',file,file.type);}
          el('game').value='';el('games').value='';info=await call('info');render();
        }catch(error){info=await call('info').catch(()=>info);render();el('status').textContent=policy.errorText;}
        finally{el('submit').disabled=false;}
      };
      el('withdraw').onclick=async()=>{el('withdraw').disabled=true;try{await call('withdraw');info=await call('info');render();}catch{el('status').textContent=policy.errorText;}finally{el('withdraw').disabled=false;}};
    }catch(error){el('status').textContent=String(error.message||error);}
  })();</script></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` } });
}
