# FAQ App と Codex の連携

App の「開催大会」→「Codexに大会登録を依頼」から、同僚本人の Codex に渡す依頼文と MCP・Skill 設定用 ZIP を取得できます。2件のポータル URL は App または Codex の会話に貼り付けます。資料の確認、通常の App 編集画面での保存、再読み込みの照合まで Codex に依頼します。利用者による JSON の作成・貼り付けは不要です。

## 初回の設定

1. App から「MCP・Skillをダウンロード」で ZIP を取得し、自分の Codex に依頼文と一緒に渡します。
2. Codex が内容と `scripts/install.mjs` を確認します。本人が許可した範囲で、Node.js 20 以上を使い `node scripts/install.mjs` を実行します。Node.js がなければ本人の承認を得て公式配布元のランタイムを準備します。
3. 設定は本人の `.codex/tools/jopt-faq-codex/`、`.codex/skills/jopt-event-register/` と `config.toml` の同名 MCP 項目に限定します。既存の設定をバックアップし、異なる同名設定があれば上書きせず確認します。他の MCP は変更しません。
4. Codex を再起動して `jopt_faq_events` の `get_workflow_rules` を呼び、接続を確認します。設定ファイルへの追記と接続成功は別々に確認します。
5. 同僚本人の会社 Google アカウントとブラウザー／Google 連携で、ポータルと FAQ App を開きます。

Web ページから Codex の会話を自動で開始したり、本人に代わって権限を与えたりはしません。依頼文を会話に渡す操作と、初回の接続・権限確認が必要です。MCP がなくても依頼文とブラウザーで大会登録を進められます。

## MCP と保存の役割

- `get_workflow_rules`：現行の業務ルール、項目、共通リンク。
- `get_registration_task`：2つのポータルから App を直接操作する依頼書。
- `register_event` プロンプト：同じ依頼書を生成。
- `get_import_schema` / `validate_event_import` / `prepare_event_import`：従来の取込処理との互換用。通常の同僚向け操作では不要。

このローカル MCP は Google 資料の読取権限・保存権限を持ちません。Codex が本人の連携／ブラウザーで資料を読み、認証済み FAQ App の通常の大会編集画面から保存します。共有秘密鍵や他人の Google 認証情報は配布しません。

## 確認する内容

大会名、ブランド、本番日程、会場、公開ガイド／公開スケジュール、領収書の送付期限、各事前予約の申込期限、追加入場制限。予約が複数ある場合は各番号と期限を「／」で区切ります。写真アルバム、フォームの案内先、年齢制限の基本回答は App の共通設定を使用します。

情報が見つからないことを未定とは断定しません。回答表から元の予約フォームを開き、ポータルの参照先が別の受付ポータルなら内容も比較します。旧大会の情報を採用せず、未確認項目で既存値を消しません。保存後に再読み込みし、既存大会のID・値・大会数・表示状態を照合します。

## 更新と検証

規則の正本は `shared/rules.json`、依頼書は `shared/task.cjs` です。`node scripts/build-app.mjs` で App の入口、MD、設定用 ZIP を生成します。`npm test` で MCP・保存処理・依頼書の検証を行います。インストール済みコピーの更新には再インストールと MCP の再起動が必要です。

この連携は FAQ App の大会登録までです。Harness／LINE への公開、資料の変更、Slack 調査は行いません。

仕様参照：[OpenAI MCP](https://developers.openai.com/learn/docs-mcp)、[OpenAI Plugins](https://developers.openai.com/plugins/build/plugins)。
