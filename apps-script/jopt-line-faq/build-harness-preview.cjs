const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ts=require('../../cloudflare/line-harness-jopt-support/node_modules/typescript');
const base=__dirname,services=path.resolve(base,'../../cloudflare/line-harness-jopt-support/apps/worker/src/services');
const data=fs.readFileSync(path.join(services,'faq-data.ts'),'utf8'),render=fs.readFileSync(path.join(services,'faq-render.ts'),'utf8'),runtime=fs.readFileSync(path.join(services,'faq-runtime.ts'),'utf8');
const handoff=runtime.match(/if\(action==='handoff'\)\{([\s\S]*?)\n      \}/)?.[1];
const resolved=runtime.match(/view=\{nodeId:s\.node_id,eventId:s\.event_id,text:[^\n]+/)?.[0];
if(!handoff||!resolved)throw Error('Harness runtime changed; review the preview adapter before rebuilding.');
const clean=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
const source=clean(data)+'\n'+clean(render)+`
function previewHandoff(data:FaqData,nodeId:string,eventId:string|null){const s={event_id:eventId};let view:FaqView;${handoff}\nreturn view;}
function previewResolved(data:FaqData,nodeId:string,eventId:string|null){const s={node_id:nodeId,event_id:eventId};let view:FaqView;${resolved}\nreturn view;}
`;
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.None,removeComments:true}}).outputText;
const digest=crypto.createHash('sha256').update(source).digest('hex');
const block=`/* BEGIN HARNESS PREVIEW */
const JoptHarnessPreview=(()=>{
  const factory=(Date)=>{${compiled}\nreturn {normalizeFaq,faqView,previewHandoff,previewResolved};};
  const core=now=>factory(now===undefined?Date:class extends Date{static now(){return now;}});
  function data(raw,draft){
    const d=core().normalizeFaq(raw);
    if(draft){
      d.nodes={...d.nodes,[draft.id]:{...d.nodes[draft.id],...draft}};
      if((draft.type==='check'||draft.type==='handoff')&&typeof draft.fields==='string'){
        const id=draft.handoff||'__preview_fields__';
        d.handoffs={...d.handoffs,[id]:{...(d.handoffs[id]||{}),id,fields:draft.fields.split(/\\r?\\n/).map(x=>x.trim()).filter(Boolean)}};
        d.nodes[draft.id].handoff=id;
      }
    }
    return d;
  }
  return {sourceHash:'${digest}',data,
    view:(raw,id,eventId,now)=>core(now).faqView(data(raw),id,eventId),
    handoff:(raw,id,eventId,now)=>core(now).previewHandoff(data(raw),id,eventId||null),
    resolved:(raw,id,eventId)=>core().previewResolved(data(raw),id,eventId||null),
    openClock:open=>Date.UTC(2026,9,26,open?3:11)};
})();
/* END HARNESS PREVIEW */`;
for(const name of ['Simple','Index']){
 const file=path.join(base,name+'.html');let html=fs.readFileSync(file,'utf8');
 if(html.includes('/* BEGIN HARNESS PREVIEW */'))html=html.replace(/\/\* BEGIN HARNESS PREVIEW \*\/[\s\S]*?\/\* END HARNESS PREVIEW \*\//,()=>block);
 else {const marker=name==='Simple'?'/* ---------- LINEで試す ---------- */':'/* ---------- preview ---------- */';if(!html.includes(marker))throw Error('Missing preview marker');html=html.replace(marker,block+'\n\n'+marker);}
 for(const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new Function(m[1]);fs.writeFileSync(file,html);
}
console.log('Embedded current Harness FAQ renderer and action outputs into both App previews. '+digest);
