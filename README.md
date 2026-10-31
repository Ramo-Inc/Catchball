# Catchball（session-mail）

既存の Codex CLI と Claude Code のセッションを1つの通信チャンネルにつなぐツールです。統括 AI が担当 AI に仕事を振り分け、進捗・質問・結果を受け取りながら開発を進められるようにします。人はそのやり取りを WebUI で見守ります。

- 仕様：[docs/spec/AI通信チャンネル_MVP仕様書.md](docs/spec/AI通信チャンネル_MVP仕様書.md)
- 詳細設計：[docs/design/DESIGN.md](docs/design/DESIGN.md)
- 導入・運用の手順と AI への運用指示：[docs/design/OPERATIONS.md](docs/design/OPERATIONS.md)
- 実装計画と試験計画：[docs/design/IMPLEMENTATION_PLAN.md](docs/design/IMPLEMENTATION_PLAN.md)

## 現在の状態（2026-10-31）

| 段階 | 状態 |
|---|---|
| PoC（受信経路の確認） | 合格。実物の Codex CLI 0.166.0 と Claude Code 2.1.314 で、合格条件 G1〜G5 をすべて満たした（[記録](docs/verification/poc-20261031.md)） |
| 本実装 | ブローカー・MCP ブリッジ・CLI・WebUI を実装した。自動試験 8 件すべて合格 |
| 統括運用のデモ | クラウド環境で、新しく作った5つのセッションと小さな課題を使って実施した。統括が4名に振り分け、受入確認と報告まで行った（[WebUI の記録](demo/webui-demo.html)） |
| 未実施 | 既存の5セッションでの目的達成試験（仕様書 §12.2）、Windows での試験、Hooks による承認待ちの検知 |

## 構成

```text
Codex CLI ×3 ─┐  MCP（stdio）: session-mail-bridge
Claude Code ×2┘        │ HTTP（127.0.0.1）
                       ▼
            session-mail-admin serve（ブローカー：SQLite・通知・WebUI）
              ├─ Codex への通知：codex queue --thread <会話ID>
              └─ Claude への通知：Channel（notifications/claude/channel）
```

AI が使うツールは6つです：`channel_join` / `channel_members` / `channel_send` / `channel_receive` / `channel_ack` / `channel_leave`

## はじめかた

必要なもの：Node.js 22.13 以上（DB は Node 組み込みの SQLite を使うため、ネイティブ部品のインストールは不要）

```bash
npm ci
npm run build
npm test
```

```bash
node dist/cli/admin.js serve
```

ブローカーを起動したら、次の流れで進めます（詳細は [OPERATIONS.md](docs/design/OPERATIONS.md)）。

1. `session-mail-admin provision` で、各セッションを登録する（会話 ID を指定する）
2. 表示された起動コマンドで、各セッションを同じ会話のまま再開する
3. 各セッションに導入プロンプトを1回だけ貼る
4. ブラウザーで `http://127.0.0.1:47821/` を開き、`session-mail-admin viewer-token` で表示されるトークンでログインする

### 別の PC から WebUI を見る（既定で有効）

WebUI（閲覧専用）は、同じネットワーク内の別の PC からも `http://<この PC の IP アドレス>:47822/` で開けます。起動時のログに、開くための URL が表示されます。

- **LAN 側に公開されるもの**：WebUI と、その閲覧用の API だけです。
- **公開されないもの**：AI 用・管理用の API は、常にこの PC の中からしか使えません。
- **Windows の場合**：最初にファイアウォールでポート 47822 の受信を許可してください（[OPERATIONS.md §1.5](docs/design/OPERATIONS.md)）。
- **この PC だけに戻す場合**：`config.json` に `"ui": { "lan": false }` を書いてください。

## ディレクトリ

| パス | 内容 |
|---|---|
| `src/broker/` | ブローカー（DB、業務処理、通知、HTTP API） |
| `src/bridge/` | MCP ブリッジ（Codex / Claude が起動する） |
| `src/cli/` | `session-mail`（AI 用の6操作）と `session-mail-admin`（管理用） |
| `src/web/` | WebUI |
| `test/` | 自動試験 |
| `poc/` | PoC（受信経路の確認に使った最小実装と、試験ガイド） |
| `docs/` | 仕様・設計・レビュー・検証記録 |
| `demo/` | デモの記録（WebUI に記録データを埋め込んだ HTML） |
