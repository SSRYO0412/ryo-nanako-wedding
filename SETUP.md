# RSVP フォーム セットアップ手順

ゲストの出欠回答を **Notion（CMS=正）** に保存し、**Google スプレッドシート（バックアップ）** にも残し、
**ゲスト宛の確認メール**と**新郎新婦宛の通知メール**を自動送信する構成です。

```
ゲスト ──送信──> index.html の <form>
                     │ fetch POST（同一ドメイン）
                     ▼
            Vercel Function  /api/rsvp.js
                     ├─ 1) Notion API        … 出欠回答DB（主）
                     └─ 2) Apps Script(GAS)  … サイドカー
                              ├─ スプレッドシート追記（バックアップ）
                              ├─ ゲストへ確認メール
                              └─ 新郎新婦へ通知メール
```

- Notion 保存が成功すれば、ゲストには完了画面を表示します。
- Sheets / メールはベストエフォート（失敗してもデータは Notion に残ります。Vercel のログに warning）。
- RSVP 締切は **2026-07-31（JST）**。締切後はフォーム無効化＋サーバー側でも 403 で拒否します。
  変更する場合は次の2か所の `RSVP_DEADLINE`（同じ値）を直します: `api/rsvp.js` と `index.html` の `<script>`。

---

## 0. すでに用意済みのもの

- **Notion DB**「出欠回答」を作成済み
  - 場所: 💍WEDDINGパーティープランニング → 詳細は → → 出欠DB → **出欠回答**
  - **Database ID**: `f9540ee6-b577-484f-bc20-5f2309366e65` （手順3の `NOTION_DATABASE_ID` に使用）

---

## 1. Notion 内部インテグレーション（サーバー実行用トークン）

> Claude/MCP の接続とは別に、サーバーから書き込むための **内部インテグレーショントークン**が必要です。

1. https://www.notion.so/my-integrations → **New integration**
   - Type: **Internal**、対象ワークスペースを選択、Capabilities は **Insert content** を含めて作成
2. 発行された **Internal Integration Token**（`ntn_...`）を控える → 手順3の `NOTION_TOKEN`
3. Notion で「出欠回答」DB を開く → 右上 `•••` → **コネクトを追加（Connections）** → 作成したインテグレーションを接続
   - これをしないと API が `object_not_found` になります。

---

## 2. Google スプレッドシート + Apps Script（バックアップ & メール）

1. 新しいスプレッドシートを作成（名前は任意）
2. **拡張機能 → Apps Script** を開き、`apps-script/Code.gs` の内容を貼り付けて保存
3. **プロジェクトの設定（⚙）→ スクリプト プロパティ** に2つ登録:
   | プロパティ | 値 |
   |---|---|
   | `RSVP_SECRET` | 任意の長いランダム文字列（手順3の `GAS_SHARED_SECRET` と**同じ値**）。例: `openssl rand -hex 16` で生成 |
   | `NOTIFY_EMAIL` | 回答通知を受け取る新郎新婦のメールアドレス |
4. **デプロイ → 新しいデプロイ → 種類「ウェブアプリ」**
   - 説明: 任意 / **実行ユーザー: 自分** / **アクセスできるユーザー: 全員**
   - 初回は **MailApp（メール送信）の権限承認**を求められるので許可
5. 発行された **ウェブアプリ URL**（`https://script.google.com/macros/s/.../exec`）を控える → 手順3の `GAS_WEBHOOK_URL`

> メールの差出人は、このスクリプトをデプロイした Google アカウントになります。
> Apps Script の無料枠は1日あたり約100通（1回答につき最大2通）。

---

## 3. Vercel デプロイ

1. Vercel で GitHub リポジトリ `SSRYO0412/ryo-nanako-wedding` を **Import**
   - Framework Preset: **Other**（静的サイト + `/api` を自動検出。ビルド設定は不要）
2. **Settings → Environment Variables** に以下を登録:

   | 変数名 | 値 |
   |---|---|
   | `NOTION_TOKEN` | 手順1のトークン（`ntn_...`） |
   | `NOTION_DATABASE_ID` | `f9540ee6-b577-484f-bc20-5f2309366e65` |
   | `GAS_WEBHOOK_URL` | 手順2のウェブアプリ URL |
   | `GAS_SHARED_SECRET` | 手順2の `RSVP_SECRET` と**同じ値** |

3. **Deploy**

> 公開 URL でフォームから送信し、Notion・スプレッドシート・メール2通を確認してください。

---

## ローカル動作確認（任意）

```bash
npm i -g vercel
vercel link           # プロジェクトに紐付け
vercel env pull       # 上記 env をローカルに取得
vercel dev            # http://localhost:3000 でフォーム送信を検証
```

## テスト チェックリスト

- [ ] **出席**で送信 → Notion「出欠回答」に新規行 + スプレッドシート追記 + ゲスト確認メール + 新郎新婦通知メール
- [ ] **欠席**で送信 → 同上（メール文面が欠席向けに変わる）
- [ ] 必須項目を空にして送信 → ブラウザのバリデーションで止まる
- [ ] 締切確認: `RSVP_DEADLINE` を一時的に過去日にする → フォームが「受付終了」表示・サーバーも 403
- [ ] スパム: 隠しフィールド（会社名）に値が入った送信は破棄される
