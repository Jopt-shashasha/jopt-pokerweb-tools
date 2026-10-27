const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const html=fs.readFileSync(__dirname+'/Simple.html','utf8'),code=fs.readFileSync(__dirname+'/Code.gs','utf8');
const contract=html.match(/\/\* BEGIN HARNESS CONTRACT \*\/([\s\S]*?)\/\* END HARNESS CONTRACT \*\//)[1];
const context={URL};vm.runInNewContext(contract+';this.contract=JoptHarnessContract;',context);
test('export panel survives HtmlService line-comment rewriting',()=>{
  const ui=fs.readFileSync(__dirname+'/harness-export-ui.js','utf8');
  assert.doesNotThrow(()=>new Function(ui.replace(/\/\/[^\n]*/g,'')));
});
test('export reads current saved data on every call, strips user data, and releases its lock',()=>{
  let reads=0,releases=0;
  const tables=['nodes','channels','handoffs','vars','messages','events'];
  const sandbox={TABS:Object.fromEntries(tables.map(k=>[k,k])),LockService:{getDocumentLock:()=>({waitLock(){},releaseLock(){releases++;}})},Utilities:{formatDate:()=> '20261026-120000'},getAll:()=>{reads++;return Object.assign(Object.fromEntries(tables.map(k=>[k,{}])),{user:'excluded',nodes:{root:{id:'root',type:'menu',label:'トップ',body:'',status:'確認済'}},events:{ev:{id:'ev',name:'大会',active:false}}});}};
  vm.runInNewContext(code.match(/\/\* BEGIN HARNESS EXPORT \*\/([\s\S]*?)\/\* END HARNESS EXPORT \*\//)[1],sandbox);
  for(let i=0;i<2;i++){
    const result=sandbox.getHarnessExport();assert.equal(result.payload.schemaVersion,1);
    assert.deepEqual(Object.keys(result.payload.data),tables);assert.equal(JSON.stringify(result).includes('excluded'),false);
    const normalized=context.contract.normalizeFaq(JSON.parse(JSON.stringify(result.payload)));
    assert.equal(normalized.events.ev.active,false);assert.equal(context.contract.validateFaq(normalized).errors.length,0);
  }
  assert.equal(reads,2);assert.equal(releases,2);
  sandbox.getAll=()=>{throw Error('read failed');};assert.throws(()=>sandbox.getHarnessExport(),/read failed/);assert.equal(releases,3);
});
test('embedded Harness validator blocks broken hierarchy and unresolved destination links',()=>{
  const payload={nodes:{root:{id:'root',type:'menu',label:'トップ',body:'',status:'確認済'},bad:{id:'bad',parent:'missing',type:'redirect',label:'案内',body:'',channel:'gone'}}};
  const result=context.contract.validateFaq(context.contract.normalizeFaq(payload));
  assert(result.errors.some(x=>x.includes('親メニュー')));assert(result.errors.some(x=>x.includes('誘導先URL')));
});
test('check and direct handoff previews have no resolution choices',()=>{
  const src=html.match(/function previewHtml\(d\)\{([\s\S]*?)\n\}\n/)[0];
  const sandbox={S:{nodes:{root:{id:'root',label:'トップ',type:'menu',body:''},q:{id:'q',parent:'root',label:'質問',type:'answer',body:'本文'}},handoffs:{},events:{},vars:{},messages:{msg_handoff_in:{text:'受付 {{fields}}'},msg_handoff_out:{text:'受付 {{fields}}'},msg_followup:{text:'解決しましたか？'}},channels:{}},esc:s=>String(s??''),previewText:s=>String(s??'')};
  const engine=html.match(/\/\* BEGIN HARNESS PREVIEW \*\/([\s\S]*?)\/\* END HARNESS PREVIEW \*\//)[1];
  vm.runInNewContext(engine+'\n'+src,sandbox);
  for(const type of ['check','handoff']){const out=sandbox.previewHtml({id:'q',label:'質問',type,body:'本文',fields:'ID'});assert(out.includes('・ID'));assert(!out.includes('解決した'));assert(!out.includes('最初に戻る'));}
  assert(sandbox.previewHtml({id:'q',label:'質問',type:'answer',body:'本文'}).includes('担当者に相談'));
});
