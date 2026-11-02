# Catchball ドキュメント

Catchball は、Codex CLI と Claude Code のセッションをつなぐ、AI エージェント間のメッセージバスです。現在のバージョンは **v1.0.0-alpha.1**（2026-10-31）です。

## 新しく作業を始める人・AI セッションへ

次の順で読んでください。上にあるものほど優先します。

0. **session_mail を使うだけなら** [MCP_TOOLS.md](MCP_TOOLS.md) の1枚で足ります（ツールの使い方・通知への反応・本文の書き方・エラー）
1. [`/AGENTS.md`](../AGENTS.md)：このリポジトリで作業するときの決まり（ビルド、試験、書き方、PR の流れ）
2. [ARCHITECTURE.md](ARCHITECTURE.md)：今の作りの全体像（構成、状態、API、通知、セキュリティ、設定）
3. [OPERATIONS.md](OPERATIONS.md)：導入・起動・参加・日常運用・トラブルシューティング
4. [REQUIREMENTS.md](REQUIREMENTS.md)：仕様書の要件ごとの達成状況と、仕様書から変えた点
5. [DECISIONS.md](DECISIONS.md)：これまでの設計判断とその理由
6. [ROADMAP.md](ROADMAP.md)：未実施の作業、既知の問題、次に検討していること

## どれが「正」か

ドキュメントとコードが食い違うときは、**コードが正**です。食い違いに気づいたら、ドキュメントを直してください。

| 知りたいこと | 正となる場所 |
|---|---|
| DB のテーブルと制約 | `src/broker/db.ts` の `SCHEMA` |
| 設定の項目と既定値 | `src/shared/config.ts` の `DEFAULT_CONFIG` |
| API の一覧 | `src/broker/http.ts` の `routes` |
| AI に渡す文面（運用指示・通知文） | `src/shared/text.ts` |
| AI に見えるツールと説明 | `src/bridge/main.ts`（使い方の説明は [MCP_TOOLS.md](MCP_TOOLS.md)。試験で両者の一致を確かめている） |
| 仕様として求められていること | [spec/AI通信チャンネル_MVP仕様書.md](spec/AI通信チャンネル_MVP仕様書.md)（ただし変更点は [REQUIREMENTS.md](REQUIREMENTS.md) を優先） |

## ドキュメントの一覧

| ファイル | 種類 | 内容 |
|---|---|---|
| [MCP_TOOLS.md](MCP_TOOLS.md) | 現行 | **AI 向け**：session_mail の5つのツールの使い方（これ1枚で始められる） |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 現行 | 今の作り |
| [OPERATIONS.md](OPERATIONS.md) | 現行 | 使い方と運用 |
| [REQUIREMENTS.md](REQUIREMENTS.md) | 現行 | 要件の達成状況・仕様書からの変更点 |
| [DECISIONS.md](DECISIONS.md) | 現行 | 設計判断の記録 |
| [ROADMAP.md](ROADMAP.md) | 現行 | 今後の作業・既知の問題 |
| [spec/](spec/) | 入力 | ユーザーが作成した元の仕様書（MVP 1.4）。**書き換えない** |
| [verification/](verification/) | 記録 | PoC とデモの検証記録・証跡 |
| [archive/](archive/) | 履歴 | 初期の設計書・実装計画・運用手順・レビュー・PoC の手順書。**今の実装とは異なる箇所がある**ので、経緯の確認にだけ使う |
| [images/](images/) | 画像 | README で使う WebUI のスクリーンショット |

リポジトリ直下の `poc/` は、受信経路を検証したときの最小実装です。履歴として残しているだけで、本体からは使っていません。
