# weekly-agent-report（参考スクリプト）

Notion の **Admin API** から、ワークスペース内カスタムエージェントの
**週次「稼働・クレジット」レポート**を生成する参考実装です。

> このリポジトリは「技術者に渡す参考コード」を想定しています。
> 実際のレポート（表）は営業メンバーが Notion 等で閲覧する運用を前提にしています。

---

## 何が取れて、何が取れないか

| 列 | 取得元 | 備考 |
|---|---|---|
| エージェント名 / 稼働状態 / モデル / 連携先 | `GET /agents` | — |
| **消費クレジット** / 実行回数 / クレジット上限 | `GET /agents/credit_usage` | 期間フィルタ対応 |
| 担当 | `GET /agents`（`created_by_id`） | **IDで返る** → 氏名解決が必要 |
| 部署 | `GET /agents`（`permissions` の共有先グループ） | **グループIDで返る** → `departments.json` で名前解決 |
| **効果** | ❌ API に無い | Notion 上で**手入力**（自動更新では上書きしない設計） |

APIは2本を `agent.id` で結合しています（片方だけでは列が揃いません）。

---

## セットアップ

### 1. 権限（トークン）

- **組織 bot トークン**に scope `workflows:read` を付与（Admin API 用）
  - ⚠️ これはワークスペース全体のエージェント情報・クレジットを閲覧できる強い権限です。**全員に配らず1か所に集約**してください。
- （任意）担当ID→氏名 変換用に、通常の Notion API トークン（`NOTION_API_TOKEN`）

### 2. 環境変数

```bash
cp .env.example .env
# .env を編集して NOTION_ADMIN_TOKEN と SPACE_ID を設定
```

### 3. 部署の対応表（任意）

`departments.json` に「共有先グループID → 部署名」を追記します。
未定義のIDはそのまま表示されるので、出てきたIDを見て埋めていく運用でOKです。

---

## 実行

Node.js **>= 22** が必要です（追加依存なしで動きます）。

```bash
# Node ネイティブでTSをそのまま実行（.env を読み込む）
npm run report
```

tsx を使う場合:

```bash
npm install   # tsx を入れる
npm run report:tsx
```

### 出力

- コンソールに要約テーブル
- `report.json`（他ツール／DBへの受け渡し用）
- `OUTPUT_DATABASE_ID` を設定した場合のみ、Notion DB へ upsert

---

## Notion DB へ出力する場合（任意）

`OUTPUT_DATABASE_ID` と `NOTION_API_TOKEN` を設定すると、下記スキーマの DB に upsert します。

| プロパティ名 | 型 | 備考 |
|---|---|---|
| エージェント名 | Title | 突合キー |
| 稼働状態 | Select | 稼働中 / 上限到達 / 停止中 / 削除済み |
| 消費クレジット | Number | — |
| 実行回数 | Number | — |
| 最終実行 | Text | — |
| 担当 | Text | — |
| 部署 | Text | — |
| **効果** | Text | **手入力**。スクリプトは触りません |

> **設計上の肝**: エージェント名で既存ページを検索し、あれば「効果」以外を更新、
> 無ければ新規作成します。これにより、毎週の自動更新でも**手入力の「効果」が消えません**。

### 週次ログ（1行＝1週間）も自動追記する場合

`WEEKLY_LOG_DATABASE_ID` を設定すると、その週の**合計を1行**として週次ログ DB に追記します。
「週」ラベル（例: `2026/08/15 – 2026/08/21`）をキーに、同じ週なら更新・無ければ追加。
**「週次の所感・効果」列は手入力なので上書きしません。**

| プロパティ名 | 型 | 中身 |
|---|---|---|
| 週 | Title | 期間ラベル（突合キー） |
| 期間 | Date | 集計期間（範囲） |
| 総消費クレジット | Number | 全エージェント合計 |
| 稼働中 / 上限到達 / 停止中 | Number | 状態別の件数 |
| 総実行回数 | Number | 全エージェント合計 |
| **週次の所感・効果** | Text | **手入力**。スクリプトは触りません |

毎週このスクリプトを実行すれば、週次ログに1行ずつ積み上がり、推移が追えます。

---

## 定期実行について（このスクリプトの範囲外）

このスクリプトは「1回叩くと最新のレポートを作る」だけです。
毎週自動で動かす場合は、外側の仕組み（cron / GitHub Actions / スケジューラ）から
`npm run report` を呼んでください。

> ⚠️ Notion ワーカー（`@notionhq/workers`）の Tool はエージェント呼び出し時のみ実行、
> 時間トリガーの Automation は private alpha のため、**週次バッチには本スクリプト＋外部スケジューラ**を推奨します。

### GitHub Actions で30分ごとに自動実行（推奨・チーム共有向き）

`.github/workflows/weekly-agent-report.yml` を同梱しています。PCを閉じてもクラウドで動くので、共有・引き継ぎに向きます。

**セットアップ手順:**

1. このフォルダを **プライベートリポジトリ** として GitHub に push
   （`.gitignore` で `.env` は除外済み。トークンはコミットされません）
2. リポジトリの **Settings > Secrets and variables > Actions** の **Secrets** タブで3つを登録
   - `NOTION_ADMIN_TOKEN`（① 組織bot token）
   - `SPACE_ID`（② スペースUUID）
   - `NOTION_API_TOKEN`（③ 書き込み用。PAT可）
   - （部署解決を使う場合）`DEPT_DB_TOKEN`
3. 同じ画面の **Variables** タブで、使う分だけ登録（値はトークンではないが環境固有なのでコードに直書きしない）
   - `OUTPUT_DATABASE_ID` / `WEEKLY_LOG_DATABASE_ID` / `MONTHLY_LOG_DATABASE_ID` / `DAILY_LOG_DATABASE_ID` / `DEPT_DB_ID`（使わないものは未設定でOK）
4. **Actions** タブでワークフローを有効化。以後 **30分ごと**に自動実行（`workflow_dispatch` で手動実行も可）

**注意:**
- Adminトークンは強い権限のため、リポジトリは必ず **private**、Secretsにアクセスできる人を絞る。
- GitHub の cron は負荷により多少遅延することがある（30分間隔なら実用上問題なし）。
- スケジュールはリポジトリが60日間 無操作だと自動停止する仕様（手動実行や push で復帰）。

---

## 参照した Admin API

- Get agents in a space … `GET /admin/v1/spaces/{space_id}/agents`
- Get credit usage for agents in a space … `GET /admin/v1/spaces/{space_id}/agents/credit_usage`
- Admin API バージョン: `2026-06-01`
