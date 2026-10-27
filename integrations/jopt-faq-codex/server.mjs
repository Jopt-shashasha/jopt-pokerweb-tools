import {createInterface} from 'node:readline';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import contract from './shared/contract.cjs';
import task from './shared/task.cjs';

const base=dirname(fileURLToPath(import.meta.url));
const rules=JSON.parse(await readFile(join(base,'shared/rules.json'),'utf8'));
const payloadSchema={type:'object',properties:{payload:{type:'object',description:'jopt.event-import.v1。get_import_schemaの説明を参照。'},existing_events:{type:'object',description:'任意。Appで読み取った既存大会をidをキーに指定。サーバーでも保存前に再検証します。'}},required:['payload'],additionalProperties:false};
const toolList=[
  {name:'get_registration_task',description:'2つのポータルからFAQ Appを直接操作して登録する依頼書と、現在の入力項目を取得します。JSONを利用者に貼り付けてもらう必要はありません。',inputSchema:{type:'object',properties:{event_name:{type:'string'},portal_url:{type:'string'},reception_portal_url:{type:'string'}},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'get_workflow_rules',description:'大会情報登録の現行業務ルール・4ブランドの共通資料・正しいFAQ App URLを取得します。Google資料の読み取りは同僚本人のGoogle連携またはブラウザーを使用します。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'get_import_schema',description:'大会導入JSONの形式と保存手順を取得します。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'validate_event_import',description:'AIが作成した登録候補の形式・根拠・禁止項目・既存大会との重複を検証します。事実の正しさはAIと利用者が元資料で確認します。',inputSchema:payloadSchema,annotations:{readOnlyHint:true}},
  {name:'prepare_event_import',description:'検証済み候補をローカルJSONファイルとして保存します。GoogleやHarnessは変更しません。ファイルまたはJSONをAppのAI取込に渡し、差分を確認して保存してください。',inputSchema:payloadSchema,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}}
];
function schema() { return {schema_version:contract.version,operation:'create|update',event_id:'update時のみ既存id',portals:{portal_url:'大会ポータルURL',reception_portal_url:'受付ポータルURL'},fields:rules.event_fields,evidence:'値を登録する各フィールドに [{url,location,quote}]。明示的な利用者指定はurl=user。',unresolved:'[{field,reason}]。不明項目は省略し、理由を記録。',save:'App→開催大会→AIの登録内容を取り込む→JSONを貼付/ファイル選択→内容を確認→利用者確認→保存。Googleログイン必須。',rules_version:rules.version}; }
async function call(name,a={}) {
  if (name==='get_workflow_rules') return rules;
  if (name==='get_registration_task') return {markdown:task.build(rules,a),app_url:rules.app_url,fields:rules.event_fields,workflow:'本人のGoogle連携で資料を読み、認証済みAppの通常の大会編集画面から保存し、再読み込みで照合する。',saved_to_google:false};
  if (name==='get_import_schema') return schema();
  if (!['validate_event_import','prepare_event_import'].includes(name)) throw Error('Unknown tool');
  const p=contract.validate(a.payload);
  const preview=a.existing_events ? contract.plan(p,a.existing_events) : {payload:p,existing_events_not_checked:true};
  if (name==='validate_event_import') return {valid:true,preview,semantic_accuracy:'not_verified_by_validator'};
  const dir=process.env.JOPT_FAQ_IMPORT_DIR || join(homedir(),'.codex','jopt-faq','imports');
  await mkdir(dir,{recursive:true});
  const path=join(dir,'event-'+randomUUID()+'.json');
  const json=JSON.stringify(p,null,2);
  await writeFile(path,json,{encoding:'utf8',flag:'wx',mode:0o600});
  return {path,json,app_url:rules.app_url,preview,saved_to_google:false,next:'Codexのブラウザー操作でAppのAI取込にJSONを貼り付けてプレビュー。利用者の確認後に保存。自動でHarnessに公開しない。'};
}
function result(id,value) { return {jsonrpc:'2.0',id,result:value}; }
async function dispatch(m) {
  if (!m || m.jsonrpc!=='2.0' || !m.method) return {jsonrpc:'2.0',id:m?.id??null,error:{code:-32600,message:'Invalid request'}};
  if (m.id===undefined) return null;
  if (m.method==='initialize') return result(m.id,{protocolVersion:['2024-11-05','2025-03-26','2025-06-18'].includes(m.params?.protocolVersion)?m.params.protocolVersion:'2025-03-26',capabilities:{tools:{},prompts:{}},serverInfo:{name:'jopt-faq-events',version:'1.1.0'},instructions:'大会情報登録用。get_workflow_rulesとget_registration_taskを読み、本人の権限で資料確認とAppの通常画面による登録を実行する。利用者にJSON操作を求めない。このMCP自体にはGoogleの読取・保存権限はない。'});
  if (m.method==='ping') return result(m.id,{});
  if (m.method==='tools/list') return result(m.id,{tools:toolList});
  if (m.method==='prompts/list') return result(m.id,{prompts:[{name:'register_event',description:'2つのポータルから大会情報を核対し、FAQ Appの登録候補を作成',arguments:[{name:'portal_url',required:true},{name:'reception_portal_url',required:true},{name:'event_name',required:true}]}]});
  if (m.method==='prompts/get' && m.params?.name==='register_event') return result(m.id,{messages:[{role:'user',content:{type:'text',text:task.build(rules,m.params.arguments)}}]});
  if (m.method==='tools/call') {
    try { return result(m.id,{content:[{type:'text',text:JSON.stringify(await call(m.params?.name,m.params?.arguments))}]}); }
    catch(e) { return result(m.id,{isError:true,content:[{type:'text',text:e.message}]}); }
  }
  return {jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}};
}
// MCP stdio: one UTF-8 JSON-RPC message per line; stdout is protocol-only.
for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  try {
    if (Buffer.byteLength(line)>256000) throw Error('Request too large');
    const m=JSON.parse(line);
    const r=Array.isArray(m)?(await Promise.all(m.map(dispatch))).filter(Boolean):await dispatch(m);
    if (r && (!Array.isArray(r)||r.length)) process.stdout.write(JSON.stringify(r)+'\n');
  } catch { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON-RPC input'}})+'\n'); }
}
