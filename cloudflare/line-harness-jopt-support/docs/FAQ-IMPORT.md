# FAQ import, testing and release

## Status and scope

The admin page is `/faq` (normally `/console/faq` in a bundled installation). It uses the existing Harness login, account selector, API credentials/CSRF checks and database. The automation Actions JSON editor is **not** the FAQ import location.

Importing creates an immutable, account-scoped draft. It does not create active auto-reply rules or change LINE menus. An explicit deployment pointer selects a test or production version. Stopping a deployment removes that pointer; drafts and the audit trail remain. To roll back, choose an older version and activate it for the same audience.

## JSON contract

The preferred file is `{ "schemaVersion": 1, "data": { ... } }`. Raw data objects and the earlier test-candidate wrapper are also accepted. `data` contains:

- `nodes`: records keyed by ID (or an array with IDs), including `root`, parent ID, order, label, type, original body, channel/handoff references, links, per-event flag and confirmation status.
- `channels`, `handoffs`, `messages`, `events`: records keyed by ID, or arrays with IDs.
- `vars`: records keyed by variable name, or arrays with `key`.

Node types are `menu`, `answer`, `check`, `redirect`, and `handoff`. The importer checks IDs, parent cycles, references, HTTPS URLs, known placeholders, confirmation flags, expired variables and shared messages. The original content is retained; input wrapper metadata, a logged-in user's identity and precompiled legacy rules are not persisted.

Requests are limited to 2 MiB; each record group to 1,500 entries. A repeated import of equivalent content returns the same version for the selected account. Invalid structure is rejected. Warnings allow drafts/tests but block production activation. Validation is recomputed on activation so expired content cannot rely on an old validation result.

## Operator flow

1. Choose the intended LINE account.
2. Select the JSON file or paste the entire JSON into **FAQ管理 → JSONを取り込む**.
3. Click **チェック**, then **下書きとして取り込む**. Inspect the returned warnings and preview.
4. Choose **テスト用postbackを押した人は誰でもテスト可能にする** or turn it off for a private test (up to 30 Harness friends, including registered test-menu members).
5. Click **このバージョンでテスト開始**, then use **テストメンバー** to search colleagues by LINE display name, select them, and click **選択した同僚を追加**. Each colleague must be a following friend of this LINE account. If absent from search, ask them to send a message once. Only menus with `faqv1:test` postback and no production FAQ entry are selectable. Changes apply to individual menus, never the account-wide default. Click the menu in LINE to start; sending text does not start FAQ or receive a bot reply.
6. Use **テスト停止** to stop test conversations. Test buttons are no longer processed after the test deployment is stopped.
7. Production activation is separate, requires administrator/owner privileges and explicit confirmation, and is blocked by unresolved warnings. The production entry is postback `faqv1:start`; configuring a production rich-menu button is a separate deliberate change.

Authenticated staff can add/remove test-menu members; starting or publishing a release still requires an administrator. **登録を解除** restores the previous individual menu, or falls back to the official account default if that menu is absent/deleted. If another operator changed the individual menu elsewhere, removal preserves that newer choice. Removal does not delete old FAQ messages; in an open test those old postbacks remain usable until the test deployment is stopped. LINE lookup errors are displayed as unknown, not as proof the menu is absent. Partial batch failures are reported per colleague.

## Runtime and chat states

- Menu buttons carry version and consultation identifiers in LINE Postbacks; dispatch runs within the existing verified webhook before generic auto-replies/automations. Draft previews send no messages and mutate no chats.
- `answer` offers resolution and **担当者に相談**. `check` and direct `handoff` display the supplied instructions/confirmation fields without resolution buttons and create pending human work. The consultation button also sets the chat to unread (keeps an assigned/in-progress chat in progress) and adds FAQ/classification to notes.
- A channel URI is recorded as redirected, not as proof that another LINE resolved the issue.
- Handoff acknowledgements/fields use the imported messages. Business hours follow the user-confirmed Tokyo rule: 10:00–19:00, excluding Wednesdays and Sundays.
- Additional text/images continue through the normal Harness inbox. The bot is not globally paused: users can explicitly browse menus again.
- Existing unrelated unread/in-progress work and other pending FAQ handoffs cannot be closed by a solved button. A new unrelated incoming message arriving during a FAQ also remains unread.
- Marking a chat resolved through the normal chat API closes its pending FAQ consultations. Old completion buttons cannot close a newer node/consultation; a version change returns the user to the current root.
- Webhook event receipts prevent duplicate sends/state transitions. A delivery failure becomes a visible unread item; there is no surprise paid push fallback. Outgoing messages use the existing Harness LINE reply proxy and messages log.

## Installation / deployment boundary

Before deploying code, apply `packages/db/migrations/073_faq_releases.sql` and `075_faq_test_menu_members.sql` to the **verified intended database**. New-install `schema.sql` and bootstrap include the same tables. Then build/deploy both Worker and admin assets with the deployment's real API topology/base path. Do not deploy a QA frontend built against `127.0.0.1:8792`.

This checkout includes the active JOPT storage/Appwrite adapter and other custom functions. Preserve those source changes and use the configured JOPT deployment target. Never package `.dev.vars` or local SQLite files in public assets.

## Verification and local host

`apps/worker/src/services/faq.test.ts` verifies draft import, content identity, account/test isolation, staging, rollback and chat transitions with real SQLite-backed D1 calls and a stubbed transport. `faq-webhook.test.ts` also runs a signed LINE webhook through the actual webhook and reply-proxy path, with all real network disabled. Existing auth/auto-reply regressions are included. These do not replace a real LINE delivery test after deployment.

The loopback-only QA script `work/faq-test-release/harness-local.ts` serves the actual built Harness admin assets and FAQ/auth/account/friend APIs against its own SQLite database on port 8792. It blocks all external network. The synthetic account is visibly named **ローカル検証用（LINE未接続）**. This QA script and its local synthetic login are not production code or real credentials.

Start it from the Harness root with `node --import tsx work/faq-test-release/harness-local.ts` after building admin assets with `NEXT_PUBLIC_API_URL=http://127.0.0.1:8792`. Restart it after changing backend source. Port 8791 belongs to the earlier read-only package inspector and is not the implemented Harness management page.

Customer text source: **ユーザー提供原文** (the supplied Google App snapshot). No FAQ answers were rewritten or generated for publication.
