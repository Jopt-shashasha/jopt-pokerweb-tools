const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/Simple.html','utf8');
const source=html.slice(html.indexOf('function leafEditor('),html.indexOf('async function addUnder('));
function editor(node={},handoffs={}){
  let db={nodes:{a:{id:'a',label:'テスト',type:'check',body:'本文',handoff:null,...node},b:{id:'b',label:'別の質問',type:'check',handoff:null}},handoffs:structuredClone(handoffs),channels:{},messages:{},events:{},vars:{}};
  const calls=[],toasts=[],controls={}; let markup='';
  const el={querySelectorAll:()=>[],set innerHTML(s){markup=s;for(const m of s.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g))controls['#'+m[2]]={tagName:m[1].toUpperCase(),disabled:false,addEventListener(event,fn){this[event]=fn;}};},get innerHTML(){return markup;}};
  const c={S:structuredClone(db),tab:'edit',dirty:false,busy:false,TYPES:{check:'確認',handoff:'担当者',answer:'回答'},$:id=>controls[id],esc:s=>String(s??''),head:()=>'',toolbar:()=>'',tabs:()=>'',tagList:()=>[],moveBtns:()=>'',wireTabs(){},wireToolbar(){},wireAsk(){},wireMove(){},previewHtml:()=>'',toast:m=>toasts.push(m),render(){c.leafEditor(el,c.S.nodes.a);},renderEditor(){c.render();},apply(d){for(const k of Object.keys(db))c.S[k]=d[k];},gs:async(fn,kind,obj)=>{calls.push({fn,kind,obj:structuredClone(obj)});if(c.fail===kind)throw Error('test failure');db[kind][obj.id]=structuredClone(obj);return structuredClone(db);}};
  vm.runInNewContext(source,c);c.render();
  return {c,controls,calls,toasts,get markup(){return markup;},get db(){return db;},fill(s){controls['#e_fields'].input({target:{value:s}});},save:()=>controls['#e_save'].onclick(),reopen(){c.apply(structuredClone(db));c.render();}};
}
test('check with no handoff saves fields and binds its own destination; fresh read keeps fields',async()=>{
  const e=editor({}, {H_GENERAL:{id:'H_GENERAL',name:'共通',fields:['共通項目'],team:'カスタマー'}});
  assert.match(e.markup,/この質問専用/);assert.doesNotMatch(e.markup,/でも同じ項目を使っています/);
  e.fill(' GameID \r\nGamesID\n\n');await e.save();
  const id=e.db.nodes.a.handoff;assert.equal(id,'H_NODE_a');assert.deepEqual(e.db.handoffs[id].fields,['GameID','GamesID']);
  assert.deepEqual(e.db.handoffs.H_GENERAL.fields,['共通項目']);assert.equal(e.db.nodes.b.handoff,null);
  e.reopen();assert.match(e.markup,/>GameID\nGamesID<\/textarea>/);assert.deepEqual(e.calls.map(x=>x.kind),['handoffs','nodes']);
});
test('handoff with no binding also preserves entered fields',async()=>{const e=editor({type:'handoff'});e.fill('お名前');await e.save();assert.deepEqual(e.db.handoffs[e.db.nodes.a.handoff].fields,['お名前']);});
test('dangling binding creates a valid destination without overwriting an unrelated id',async()=>{
  const e=editor({handoff:'missing'},{H_NODE_a:{id:'H_NODE_a',fields:['別用途']}});e.fill('確認項目');await e.save();
  assert.equal(e.db.nodes.a.handoff,'H_NODE_a_');assert.deepEqual(e.db.handoffs.H_NODE_a.fields,['別用途']);
});
test('existing shared destination is updated and retained instead of copied',async()=>{
  const e=editor({handoff:'H_GAMES'},{H_GAMES:{id:'H_GAMES',name:'Games',fields:['古い項目']}});e.fill('GameID\nGamesID');await e.save();
  assert.equal(e.db.nodes.a.handoff,'H_GAMES');assert.deepEqual(Object.keys(e.db.handoffs),['H_GAMES']);assert.deepEqual(e.db.handoffs.H_GAMES.fields,['GameID','GamesID']);
});
test('unchanged fields do not rewrite shared destination',async()=>{
  const e=editor({handoff:'H_GAMES'},{H_GAMES:{id:'H_GAMES',name:'Games',fields:['GameID']}});await e.save();assert.deepEqual(e.calls.map(x=>x.kind),['nodes']);
});
test('failed field write never reports success or writes node; retry works',async()=>{
  const e=editor();e.fill('GameID');e.c.fail='handoffs';await e.save();
  assert.equal(e.controls['#e_save'].disabled,false);assert.equal(e.c.busy,false);assert.equal(e.db.nodes.a.handoff,null);assert.equal(e.toasts.includes('保存しました'),false);
  e.c.fail=null;await e.save();assert.deepEqual(e.db.handoffs[e.db.nodes.a.handoff].fields,['GameID']);
});
test('failed node write retries the already saved destination without duplicating it',async()=>{
  const e=editor();e.fill('GameID');e.c.fail='nodes';await e.save();assert.equal(e.toasts.includes('保存しました'),false);
  e.c.fail=null;await e.save();assert.deepEqual(Object.keys(e.db.handoffs),['H_NODE_a']);assert.equal(e.db.nodes.a.handoff,'H_NODE_a');
});
