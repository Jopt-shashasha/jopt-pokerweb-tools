// Add reader-facing drafts to existing records only. Original source metadata is retained.
import { DatabaseSync,backup } from 'node:sqlite';
import { mkdir,writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../src/db.js';
import { Catalog } from '../src/repository.js';
import type { User } from '../src/model.js';

const items=[
 {source:'aifact',sourceId:'1a06b539-4257-4d58-acef-5c329c9ab955',title:'PWでトーナメント作成',guide:{
  summary:'大会情報のTSVから、PokerWebのトーナメント作成・基本設定・Ticket Linkをまとめて処理するツールです。',
  requirements:['Tampermonkeyを導入したブラウザ','作成権限のあるPokerWebアカウント','今回の大会情報をまとめたTSV'],
  steps:['「スクリプトを導入する」から導入し、PokerWeb管理画面を開きます。','大会情報のTSVをツールに貼り付け、Previewを実行します。','対象・日時・金額・回数・Chips・TICKET名を確認してから作成へ進みます。'],
  notes:['リンク先はアプリの体験画面ではなく、スクリプトのインストール画面です。','旧MDと現在のコードにはTSV仕様の差があります。詳細な入力手順は次の段階で照合します。'],
  suggested_kind:'tool',suggested_tags:['PokerWeb','トーナメント','TSV','一括作成'],related_links:[],source_note:'AIFACTの元紹介文・登録URLと、ローカルのPW Tournament Createコード／旧操作MDを照合して概要を整理。詳細手順は作成者確認前。'}},
 {source:'aifact',sourceId:'e7c50cb7-5be5-4104-9aac-be3a4f3b685b',title:'メール一括自動送信',guide:{
  summary:'Google Sheetの宛先と本文テンプレートから差し込みメールを準備し、Gmail下書きの確認後に一括送信するツールです。',
  requirements:['送信元として使用するGoogle／Gmailアカウント','宛先データと本文テンプレートを用意したGoogle Sheet','添付する場合は対象ファイルのGoogle Drive URL'],
  steps:['アプリを開き、使用するSheet・宛先・本文の設定を確認します。','差し込み結果を確認してGmail下書きを作成します。','下書きを人が確認し、承認した対象だけを送信します。'],
  notes:['下書き作成と送信は別の操作です。','他の担当者の送信元設定や参考データを残したまま使用しないでください。'],
  suggested_kind:'tool',suggested_tags:['メール','Gmail','差し込み','下書き'],related_links:[],source_note:'AIFACTの元紹介文とローカルの「メール一括自動送信」操作MDから概要を整理。現行アプリとの実地照合は作成者確認前。'}},
 {source:'aifact',sourceId:'a94b16ac-f772-400b-9371-f93bd0ae4138',title:'スタッフ専用トーナメント参加確認受付（青色版）',guide:{
  summary:'スタッフ専用トーナメントの参加条件を、受付端末で日・英・韓・中の4言語で確認するWeb Appです。',
  requirements:['受付で使用するブラウザ・端末','対象がスタッフ専用トーナメントであることの確認'],
  steps:['確認画面を開き、青色のボタンとSTAFF表示で対象画面を確認します。','参加者に対応する言語を選び、参加条件を読んでもらいます。','内容を確認した参加者が確認ボタンを押します。'],
  notes:['元の登録説明では、確認ボタンによる記録動作の実地確認は未実施です。','確認操作はログを記録する設計です。閲覧だけのデモ画面ではありません。'],
  suggested_kind:'tool',suggested_tags:['受付','スタッフ','多言語'],related_links:[],source_note:'AIFACTの元紹介文・登録URLから整理。元説明にある未検証事項を維持。'}},
 {source:'drop',sourceId:'8b9ed0c252084905bd166f81aad31915',title:'業務ポータル導入企画書',guide:{
  summary:'AIFACT・JOPT dropの検索と共有をまとめる業務ポータルについて、目的・画面・保存方法・Codex連携を説明した企画書です。',
  requirements:[],steps:[],key_points:['AIFACTの検索・分類と、JOPT dropのHTML保存・共有を一つの入口に集約する。','セクション・大会・タグで資料を探せるようにし、AIニュースを掲載して利用のきっかけを増やす。','Codexから検索・取得・登録できるようにし、成果物と利用ガイド（MD）をセットで扱う。','原本は各公開先やGoogle Driveに保存し、ポータルはリンクを管理する。既存サービスを活用し、有料AI APIを使わず、試用段階の追加費用0円を目指す。'],
  notes:[],
  suggested_kind:'document',suggested_tags:['業務ポータル','企画書','資料共有'],related_links:[],source_note:'元DROPの資料名・URLと、2026年10月22日版の企画書本文から整理。'}},
 {source:'drop',sourceId:'820d59435f4f494df410c84a573deb8d',title:'JOPT FAQ｜報告書',guide:{
  summary:'JOPT LINE FAQの分類、回答時のルール、担当者対応、情報収集と更新方法をまとめた報告資料です。',
  requirements:[],steps:[],key_points:['JOPT LINEの問い合わせを4つに分類し、回答の振り分けと担当者対応のルールを整理している。','「届かない」場合の事前確認、期限後の案内、個別状況を断定しない回答方針を示している。','FAQ一覧、担当者対応の種類、誘導先LINE、情報収集と修正・追加の進め方をまとめている。'],
  notes:[],
  suggested_kind:'document',suggested_tags:['FAQ','LINE','問い合わせ','分類'],related_links:[],source_note:'元DROPから保存した「JOPT_FAQ_報告書.html」の見出しと本文から整理。'}}
];
const filename=resolve('.local/portal-local.sqlite'),read=new DatabaseSync(filename,{readOnly:true});
const plan=items.map(item=>{const r=read.prepare('SELECT r.id,r.title,r.status,r.visibility,u.email FROM resources r JOIN users u ON u.id=r.creator_id WHERE r.source_system=? AND r.source_id=?').get(item.source,item.sourceId) as any;if(!r||r.title!==item.title||r.email.toLowerCase()!=='xiao.h@japanopenpoker.com')throw Error('Source identity mismatch: '+item.title);return {...item,id:r.id,status:r.status,visibility:r.visibility};});
if(!process.argv.includes('--apply')){console.log(JSON.stringify({apply:false,items:plan.map(x=>({title:x.title,source:x.source,status:x.status,visibility:x.visibility,tags:x.guide.suggested_tags}))},null,2));read.close();}
else{
 const refresh=process.argv.includes('--refresh-document-summaries'),snapshot=resolve(refresh?'.local/backups/before-document-summaries-20261117.sqlite':'.local/backups/before-reader-pilot-20261117.sqlite');await mkdir(resolve('.local/backups'),{recursive:true});if(!existsSync(snapshot))await backup(read,snapshot);read.close();
 const store=new Store(filename),catalog=new Catalog(store),actor=store.one<User>('SELECT * FROM users WHERE lower(email)=? AND role=?','xiao.h@japanopenpoker.com','admin');if(!actor)throw Error('Local administrator missing');
 const report=[];for(const item of plan){const existing=store.one<{content:string}>('SELECT content FROM resource_reader_guides WHERE resource_id=?',item.id);if(existing&&!(refresh&&item.guide.suggested_kind==='document'&&JSON.parse(existing.content).status==='draft')){report.push({title:item.title,action:'kept-existing'});continue;}const r=await catalog.get(item.id,actor);await catalog.setReaderGuide(r.id,actor,{version:r.version,guide:{...item.guide,status:'draft'}});report.push({title:item.title,action:existing?'document-summary-updated':'reader-guide-added',url:'http://127.0.0.1:8788/#/resource/'+r.id});}
 await mkdir(resolve('.local/reports'),{recursive:true});await writeFile(resolve(refresh?'.local/reports/reader-summaries-20261117.json':'.local/reports/reader-pilot-20261117.json'),JSON.stringify({snapshot,report},null,2));console.log(JSON.stringify(report,null,2));store.close();
}
