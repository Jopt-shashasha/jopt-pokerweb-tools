const SECTIONS=["ディレクター","トーナメント","メディア","カスタマー","クリエイティブ","ロジスティックス","マーケティング","営業","インフルエンサー","その他"];
const TOURNAMENTS=["JOPT","SPADIE","戦国","U-30"];
const MATERIALS = [
  {id:1,title:"Voucher関連資料",section:"カスタマー",tournament:"JOPT",round:"#03",tag:"Voucher",type:"資料",link:"Google Drive",purpose:"来場者向けVoucherの発行条件と利用ルールの確認用。",share:"全社共通",owner:"sha",updated:"11月14日"},
  {id:2,title:"Ticket管理シート",section:"カスタマー",tournament:"JOPT",round:"#03",tag:"Ticket",type:"ツール",link:"Google Drive",purpose:"チケット販売・入場実績の記録と集計。",share:"全社共通",owner:"他メンバー",updated:"11月13日"},
  {id:3,title:"大会運営マニュアル",section:"トーナメント",tournament:"JOPT",round:"#03",tag:"運営",type:"資料",link:"Google Drive",purpose:"当日の運営フローとスタッフ配置の確認用。",share:"全社共通",owner:"他メンバー",updated:"11月10日"},
  {id:4,title:"配信用クリエイティブ",section:"クリエイティブ",tournament:"SPADIE",round:"",tag:"メディア",type:"資料",link:"Google Drive",purpose:"配信画面用の素材一式。",share:"指定アカウントのみ",owner:"sha",updated:"11月9日"},
  {id:5,title:"搬入チェックリスト",section:"ロジスティックス",tournament:"戦国",round:"",tag:"会場",type:"資料",link:"Google Drive",purpose:"会場搬入時の確認項目一覧。",share:"全社共通",owner:"他メンバー",updated:"11月6日"},
  {id:6,title:"企画書テンプレート",section:"マーケティング",tournament:"共通",round:"",tag:"企画",type:"ツール",link:"Google Drive",purpose:"新規企画の提出用フォーマット。",share:"全社共通",owner:"sha",updated:"11月2日"},
  {id:7,title:"大会運営スクリプト（GitHub）",section:"トーナメント",tournament:"JOPT",round:"#03",tag:"自動化",type:"ツール",link:"GitHub（限定公開）",purpose:"大会当日の集計作業を自動化するスクリプト。GitHubの限定公開リポジトリで管理。",share:"指定アカウントのみ",owner:"他メンバー",updated:"11月15日",hasAccess:false},
  {id:8,title:"JOPTスタートバナーツール",section:"クリエイティブ",tournament:"JOPT",round:"#03",tag:"バナー",type:"ツール",link:"公開先（Cloudflare）",purpose:"JOPTのスタートバナーを一気に作成できます。前回の構成に合わせて出力されます。",share:"全社共通",owner:"他メンバー",updated:"11月8日"},
  {id:9,title:"クリエイティブのタスクボード",section:"クリエイティブ",tournament:"共通",round:"",tag:"タスク管理",type:"ツール",link:"公開先（Cloudflare）",purpose:"Slackで口頭で頼まれたことをAIが読み取り、着手済みかどうかを自動で判断します。",share:"全社共通",owner:"他メンバー",updated:"11月7日"},
  {id:10,title:"協賛提案テンプレート",section:"営業",tournament:"U-30",round:"",tag:"協賛",type:"資料",link:"Google Drive",purpose:"協賛企業向けの提案書の雛形。",share:"全社共通",owner:"他メンバー",updated:"11月4日"},
  {id:11,title:"Grok Bot 写真探しの実力 レポート",section:"メディア",tournament:"共通",round:"",tag:"AI設定",type:"資料",link:"Google Drive",purpose:"過去実績を参考に、似た写真を提案できるかを検証したレポート。",share:"全社共通",owner:"他メンバー",updated:"11月3日"},
  {id:12,title:"大会振り返りシート",section:"ディレクター",tournament:"JOPT",round:"#02",tag:"振り返り",type:"ツール",link:"Google Drive",purpose:"大会終了後の振り返りを項目ごとに記録するシート。",share:"全社共通",owner:"他メンバー",updated:"11月1日"},
];


const BUSINESSES=[
 {id:'review',section:'ディレクター',title:'大会の振り返り',purpose:'開催後の気づきと、次回へ引き継ぐ資料を確認する。'},
 {id:'operations',section:'トーナメント',title:'大会当日の運営',purpose:'進行・スタッフ配置・集計に必要な資料とツールを確認する。'},
 {id:'photo',section:'メディア',title:'撮影・写真選定',purpose:'写真選定の参考資料と、撮影前の確認事項を探す。'},
 {id:'mission',section:'カスタマー',title:'ミッションチャレンジ',purpose:'運用ルール、参加管理、Voucher関連のツールをまとめて確認する。'},
 {id:'tickets',section:'カスタマー',title:'Ticket管理',purpose:'チケットの記録・集計に使う資料を確認する。'},
 {id:'broadcast',section:'クリエイティブ',title:'配信用素材の準備',purpose:'配信に必要な素材と、制作条件を確認する。'},
 {id:'banner',section:'クリエイティブ',title:'スタートバナー制作',purpose:'バナー制作に使う外部ツールと仕様を確認する。'},
 {id:'production',section:'クリエイティブ',title:'制作依頼の確認',purpose:'制作依頼の確認に使う既存ツールへの入口。'},
 {id:'transport',section:'ロジスティックス',title:'会場搬入・撤収',purpose:'搬入手順と備品一覧をまとめて確認する。'},
 {id:'planning',section:'マーケティング',title:'キャンペーンの企画',purpose:'企画書、実施条件、告知予定をまとめて確認する。'},
 {id:'sales',section:'営業',title:'協賛提案の準備',purpose:'提案書と、提供内容を確認するための資料を探す。'},
 {id:'appearance',section:'インフルエンサー',title:'出演・投稿連携',purpose:'出演予定と投稿素材、事前確認の資料をまとめて確認する。'},
 {id:'handover',section:'その他',title:'社内の引き継ぎ',purpose:'部署共通で使う記入例、管理表、関連ツールを探す。'}
];
const assoc={1:'mission',2:'tickets',3:'operations',4:'broadcast',5:'transport',6:'planning',7:'operations',8:'banner',9:'production',10:'sales',11:'photo',12:'review'};
MATERIALS.forEach(m=>{m.business=assoc[m.id];if(m.tournament!=='共通'&&!m.round)m.round='#03';});
const EXTRA=[
 ['mission','ミッション参加管理シート','参加状況と付与対象を確認する。','管理表','JOPT','#03'],
 ['mission','Voucher付与確認ツール','付与対象の確認に使う外部ツールの入口。','ツール','JOPT','#03'],
 ['operations','スタッフ配置表','担当ポジションと配置を確認する。','管理表','JOPT','#03'],
 ['broadcast','配信素材の制作条件','素材のサイズ・表記条件を確認する。','資料','SPADIE','#03'],
 ['transport','搬入備品一覧','会場へ持ち込む備品を確認する。','管理表','戦国','#03'],
 ['planning','告知スケジュール','キャンペーンの告知予定を確認する。','管理表','共通',''],
 ['sales','協賛メニュー一覧','提案内容を整理する際の参照用。','資料','U-30','#03'],
 ['appearance','出演・投稿の確認資料','出演前に確認する条件と担当窓口を確認する。','資料','U-30','#03'],
 ['appearance','出演スケジュール','出演日程と関連資料を確認する。','管理表','U-30','#03'],
 ['appearance','投稿素材の共有先','投稿に使う素材の保存先への入口。','リンク','U-30','#03'],
 ['handover','引き継ぎ記入例','部署共通の引き継ぎ項目を確認する。','資料','共通',''],
 ['handover','引き継ぎ管理表','引き継ぐ内容と担当を一覧で確認する。','管理表','共通',''],
 ['handover','議事録整理ツール','会議メモの整理に使う外部ツールの入口。','ツール','共通','']
];
EXTRA.forEach((x,n)=>{const b=BUSINESSES.find(b=>b.id===x[0]);MATERIALS.push({id:13+n,business:x[0],title:x[1],purpose:x[2],type:x[3],tournament:x[4],round:x[5],section:b.section,tag:b.title,link:x[3]==='ツール'?'外部ツール':'Google Drive',share:'全社共通',owner:'サンプル担当',updated:'11月12日'});});
