import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import contract from '../shared/contract.cjs';

import {fixture} from './fixture.mjs';

test('unknown fields cannot erase saved values; duplicates and private guides rejected',()=>{
 const p=fixture(), existing={ev_a:{id:'ev_a',name:p.fields.name,brand:'SPADIE',venue:'既存会場',active:true}};
 assert.throws(()=>contract.plan(p,existing),/同名/);
 p.operation='update';p.event_id='ev_a';
 const planned=contract.plan(p,existing);assert.equal(planned.next.venue,'既存会場');assert.equal(planned.next.active,true);
 p.fields.venue='';assert.throws(()=>contract.validate(p),/省略/);delete p.fields.venue;
 p.fields.photo_url='https://example.com/album';assert.throws(()=>contract.validate(p),/登録できない/);delete p.fields.photo_url;
 p.fields.guide_url='https://docs.google.com/spreadsheets/d/internal/edit';assert.throws(()=>contract.validate(p),/内部/);
});
test('evidence, unresolved values, spreadsheet formulas and prototype ids rejected',()=>{
 const p=fixture();delete p.evidence.dates;assert.throws(()=>contract.validate(p),/根拠/);
 const q=fixture();q.unresolved.push({field:'dates',reason:'矛盾'});assert.throws(()=>contract.validate(q),/未確認/);
 const r=fixture();r.fields.name='=IMPORTXML("secret")';assert.throws(()=>contract.validate(r),/数式/);
 const u=fixture();u.operation='update';u.event_id='__proto__';assert.throws(()=>contract.plan(u,{}),/見つかりません/);
});
test('MCP protocol negotiates and creates a JSON package without network access',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jopt-mcp-'));
 try{
 const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'prepare_event_import',arguments:{payload:fixture()}}},{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'validate_event_import',arguments:{payload:{}}}}];
 const proc=spawnSync(process.execPath,['server.mjs'],{cwd:new URL('../',import.meta.url),input:messages.map(x=>JSON.stringify(x)).join('\n')+'\n',encoding:'utf8',env:{...process.env,JOPT_FAQ_IMPORT_DIR:dir}});
 assert.equal(proc.status,0,proc.stderr);const out=proc.stdout.trim().split('\n').map(x=>JSON.parse(x));
 assert.equal(out[0].result.protocolVersion,'2025-03-26');assert.equal(out[1].result.tools.length,5);
 const pkg=JSON.parse(out[2].result.content[0].text);assert.equal(pkg.saved_to_google,false);assert.deepEqual(JSON.parse(await readFile(pkg.path,'utf8')),fixture());assert.equal(out[3].result.isError,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
