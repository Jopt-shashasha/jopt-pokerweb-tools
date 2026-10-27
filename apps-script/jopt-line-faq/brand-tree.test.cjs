const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync(__dirname+'/Code.gs','utf8');
const context={};vm.runInNewContext(src+'\nthis.plan=planLiveBrandTree_;',context);
test('clones the live tree by brand without mutating the source, isolates links and marks copies for review',()=>{
  const data={nodes:{root:{id:'root',type:'menu'},live:{id:'live',parent:'root',type:'menu',label:'JOPT'},ticket:{id:'ticket',parent:'live',type:'menu',label:'チケット'},ticket_other_brand:{id:'ticket_other_brand',parent:'ticket',type:'answer',label:'SPADIE・戦国',body:'SPADIEで獲得したチケット\n戦国のチケットも同様に対象大会のみ\nSPADIEのメインチケット',links:[]},answer:{id:'answer',parent:'ticket',type:'answer',label:'質問',body:'本文',status:'確認済',links:['answer']}}};
  const before=JSON.stringify(data),out=context.plan(data);assert.equal(JSON.stringify(data),before);
  assert.equal(out.nodes.live.label,'ライブイベントの問い合わせ');
  assert.deepEqual(['JOPT','SPADIE','SENGOKU','U30'],['brand_jopt','brand_spadie','brand_sengoku','brand_u30'].map(id=>out.nodes[id].brand));
  assert.equal(out.nodes.ticket.parent,'brand_jopt');assert.equal(out.nodes.spadie_answer.parent,'spadie_ticket');
  assert.equal(out.nodes.spadie_answer.status,'要確認');assert.equal(out.nodes.spadie_answer.links[0],'spadie_answer');
  assert.equal(out.nodes.spadie_ticket_other_brand.label,'SPADIEのチケット');assert.doesNotMatch(out.nodes.sengoku_ticket_other_brand.body,/SPADIE/);
  assert.equal(out.nodes.ticket_other_brand,undefined);assert.equal(out.nodes.u30_ticket_other_brand,undefined);
  assert.throws(()=>context.plan(out),/既に存在/);
});
