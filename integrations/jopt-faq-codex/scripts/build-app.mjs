import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {makePackage} from './pack.mjs';
import task from '../shared/task.cjs';
const root=new URL('../',import.meta.url);
const app=new URL('../../../apps-script/jopt-line-faq/',import.meta.url);
const rules=JSON.parse(await readFile(new URL('shared/rules.json',root),'utf8'));
const pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
const norm=s=>s.replace(/\r\n/g,'\n');
// HtmlService's script rewriting can treat // inside generated literals as comments.
const json=v=>JSON.stringify(v).replace(/</g,'\\u003c').replace(/\//g,'\\u002f');
const contract=norm(await readFile(new URL('shared/contract.cjs',root),'utf8'));
const bridge=norm(await readFile(new URL('apps-script/bridge.gs',root),'utf8'));
const marker='// BEGIN JOPT CODEX EVENT IMPORT',codeEnd='// END JOPT CODEX EVENT IMPORT';
let code=norm(await readFile(new URL('Code.gs',app),'utf8'));
if(code.includes(marker)){
 const begin=code.indexOf(marker); let end=code.indexOf(codeEnd,begin);
 if(end>=0)end+=codeEnd.length;
 else{const lastReturn=code.indexOf('return {event_id:eventId,data:getAll(),already_saved:false};',begin);if(lastReturn<0)throw Error('Cannot identify existing import bridge boundary');end=code.indexOf('\n}',lastReturn)+2;}
 if(end<begin)throw Error('Invalid import bridge boundary');
 code=code.slice(0,begin)+marker+'\n'+contract+'\n'+bridge+'\n'+codeEnd+code.slice(end);
}else code=code.trimEnd()+'\n\n'+marker+'\n'+contract+'\n'+bridge+'\n'+codeEnd+'\n';
let html=norm(await readFile(new URL('Simple.html',app),'utf8'));
if(!html.includes('id="evCodex"')){
 if(!html.includes('id="evImport"'))throw Error('Existing event sidebar anchor missing');
 html=html.replace(/<button[^>]*id="evImport"[^>]*>[^<]*<\/button>/,'<button class="tadd" id="evCodex" style="padding:12px;color:#0f7a52;font-weight:700">Codexに大会登録を依頼</button>');
 html=html.replace('$("#evImport").onclick=()=>{if(!leave())return;sel="event-import";renderEditor();};','$("#evCodex").onclick=()=>{if(!leave())return;sel="event-codex";renderEditor();};');
}
if(!html.includes('if(sel==="event-codex")'))html=html.replace('if(sel==="event-import") return eventImportEditor(el);','if(sel==="event-codex") return eventCodexEditor(el);\n  if(sel==="event-import") return eventImportEditor(el);');
html=html.replace('order:Object.keys(S.events).length+1,active:true,name','order:Object.keys(S.events).length+1,active:false,name');
const start='/* BEGIN CODEX IMPORT UI */',end='/* END CODEX IMPORT UI */';
const oldStart=html.indexOf(start),oldEnd=html.indexOf(end);
if(oldStart<0||oldEnd<oldStart)throw Error('Existing import UI boundary missing');
const importUi=norm(await readFile(new URL('apps-script/import-ui.js',root),'utf8'));
html=html.slice(0,oldStart)+start+'\n'+importUi+'\n'+html.slice(oldEnd);
await mkdir(new URL('skills/jopt-event-register/references/',root),{recursive:true});
await writeFile(new URL('skills/jopt-event-register/references/rules.json',root),JSON.stringify(rules,null,2)+'\n');
await writeFile(new URL('skills/jopt-event-register/references/workflow.md',root),task.build(rules,{}));
const bundle=await makePackage(root);
await writeFile(new URL('jopt-faq-codex-v1.1.0.zip',root),bundle.zip);
const taskSource=norm(await readFile(new URL('shared/task.cjs',root),'utf8'));
const ui=norm(await readFile(new URL('apps-script/codex-ui.js',root),'utf8'));
const blockStart='/* BEGIN CODEX HANDOFF UI */',blockEnd='/* END CODEX HANDOFF UI */';
const block=blockStart+'\nconst CODEX_HANDOFF_RULES='+json(rules)+';\nconst CODEX_HANDOFF_BUNDLE='+json({version:pkg.version,sha256:bundle.sha256,base64:bundle.zip.toString('base64')})+';\n'+taskSource+'\n'+ui+'\n'+blockEnd;
if(html.includes(blockStart)){const a=html.indexOf(blockStart),b=html.indexOf(blockEnd);if(b<a)throw Error('Handoff boundary missing');html=html.slice(0,a)+block+html.slice(b+blockEnd.length);}
else html=html.replace('/* ---------- LINEで試す ---------- */',block+'\n/* ---------- LINEで試す ---------- */');
if(!html.includes('id="evCodex"')||!html.includes('function eventCodexEditor'))throw Error('Codex insertion failed');
for(const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new Function(m[1]);
new Function(code);
await writeFile(new URL('Code.gs',app),code);
await writeFile(new URL('Simple.html',app),html);
console.log(JSON.stringify({app:fileURLToPath(app),package_version:pkg.version,zip_bytes:bundle.zip.length,sha256:bundle.sha256}));
