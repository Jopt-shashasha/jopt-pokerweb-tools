import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {inflateRawSync} from 'node:zlib';
import vm from 'node:vm';
import task from '../shared/task.cjs';
import contract from '../shared/contract.cjs';
import {makePackage,packageFiles} from '../scripts/pack.mjs';
import {fixture} from './fixture.mjs';
const root=new URL('../',import.meta.url);
const rules=JSON.parse(await readFile(new URL('shared/rules.json',root),'utf8'));

test('embedded App literals survive HtmlService line-comment rewriting',async()=>{
 const html=await readFile(new URL('../../../apps-script/jopt-line-faq/Simple.html',import.meta.url),'utf8');
 const lines=html.split('\n').filter(s=>/^const CODEX_HANDOFF_(RULES|BUNDLE)=/.test(s));assert.equal(lines.length,2);
 const scope={};vm.createContext(scope);vm.runInContext(lines.join('\n').replace(/\/\/[^\n]*/g,'')+'\nresult={rules:CODEX_HANDOFF_RULES,bundle:CODEX_HANDOFF_BUNDLE};',scope);
 assert.equal(scope.result.rules.app_url,rules.app_url);assert.ok(Buffer.from(scope.result.bundle.base64,'base64').subarray(0,2).equals(Buffer.from('PK')));
});

test('direct App task validates portal inputs and includes form tracing, both deadlines and readback',()=>{
 const md=task.build(rules,{event_name:'JOPT 2026 Tokyo #03',portal_url:'https://docs.google.com/spreadsheets/d/portal/edit',reception_portal_url:'https://docs.google.com/spreadsheets/d/reception/edit'});
 for(const s of ['JOPT 2026 Tokyo #03','領収書の送付期限','事前予約の申込期限','フォームを編集','スマートチップ','再読み込み','利用者に JSON の作成・貼り付けを依頼しない'])assert.ok(md.includes(s),s);
 assert.ok(!md.includes('領収書の期限・送付日は登録も回答もしない'));
 assert.throws(()=>task.build(rules,{portal_url:'javascript:alert(1)'}),/URL/);
 assert.throws(()=>task.build(rules,{portal_url:'https://evil.test/spreadsheets/d/id'}),/URL/);
 assert.throws(()=>task.build(rules,{portal_url:'https://docs.google.com/spreadsheets/d/same/edit',reception_portal_url:'https://docs.google.com/spreadsheets/d/same/edit?gid=1'}),/別/);
 const p=fixture();p.fields.receipt_deadline='2026年11月18日';p.fields.preentry_deadline='#04 10/26（月）23:59まで';p.evidence.receipt_deadline=[{url:'user',location:'確認',quote:'2026年11月18日'}];p.evidence.preentry_deadline=[{url:'user',location:'確認',quote:'#04 10/26（月）23:59まで'}];assert.equal(contract.validate(p).fields.receipt_deadline,'2026年11月18日');
});

test('download archive contains only the complete allowlisted setup package',async()=>{
 const {zip}=await makePackage(root);let pos=0;const names=[];
 while(zip.readUInt32LE(pos)===0x04034b50){const len=zip.readUInt32LE(pos+18),n=zip.readUInt16LE(pos+26),extra=zip.readUInt16LE(pos+28),name=zip.subarray(pos+30,pos+30+n).toString();const offset=pos+30+n+extra;assert.deepEqual(inflateRawSync(zip.subarray(offset,offset+len)),await readFile(new URL(name,root)));names.push(name);pos=offset+len;}
 assert.deepEqual(names,packageFiles);assert.ok(names.includes('shared/task.cjs'));assert.ok(names.includes('skills/jopt-event-register/references/workflow.md'));assert.ok(!names.some(n=>/config\.toml|token|credential|^work\//i.test(n)));
});

test('clean employee installation preserves other MCP settings and serves the direct registration task',async()=>{
 const home=await mkdtemp(join(tmpdir(),'jopt-codex-install-'));
 try{
  await writeFile(join(home,'config.toml'),'[mcp_servers.unrelated]\ncommand = "keep-me"\n');
  const proc=spawnSync(process.execPath,['scripts/install.mjs'],{cwd:root,encoding:'utf8',env:{...process.env,CODEX_HOME:home}});assert.equal(proc.status,0,proc.stderr);
  const config=await readFile(join(home,'config.toml'),'utf8');assert.ok(config.includes('command = "keep-me"'));assert.equal(config.match(/\[mcp_servers\.jopt_faq_events\]/g).length,1);
  const server=join(home,'tools/jopt-faq-codex/server.mjs');
  const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26'}},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_registration_task',arguments:{event_name:'JOPT 2026 Tokyo #03'}}}];
  const run=spawnSync(process.execPath,[server],{encoding:'utf8',input:messages.map(m=>JSON.stringify(m)).join('\n')+'\n'});assert.equal(run.status,0,run.stderr);const result=run.stdout.trim().split('\n').map(JSON.parse);assert.equal(result[0].result.serverInfo.version,'1.1.0');const taskResult=JSON.parse(result[1].result.content[0].text);assert.equal(taskResult.saved_to_google,false);assert.ok(taskResult.markdown.includes('JOPT 2026 Tokyo #03'));assert.ok(taskResult.fields.preentry_deadline);
 }finally{if(!resolve(home).startsWith(resolve(tmpdir())+'\\')&&!resolve(home).startsWith(resolve(tmpdir())+'/'))throw Error('Unsafe cleanup path');await rm(home,{recursive:true,force:true});}
});
