# Catchball ドキュメント

Catchball は、Codex CLI・Claude Code・Pi（pi-coding-agent）のセッションを、ルームごとにつなぐ AI エージェント間のメッセージバスです。最後に付けたバージョンは **v1.0.0-alpha.1**（2026-10-31）で、その後の変更（ルーム、役割の ID、担当の入れ替えなど）は `main` に入っています（[CHANGELOG](../CHANGELOG.md) の「未リリース」）。この `docs/` の現行の文書は、`main` の今のコードに合わせてあります。

## 新しく作業を始める人・AI セッションへ

次の順で読んでください。上にあるものほど優先します。

0. **session_mail を使うだけなら** [MCP_TOOLS.md](MCP_TOOLS.md) の1枚で足ります（ツールの使い方・通知への反応・本文の書き方・エラー）
1. [`/AGENTS.md`](../AGENTS.md)：このリポジトリで作業するときの決まり（ビルド、試験、書き方、プルリクエストの流れ）
2. [ARCHITECTURE.md](ARCHITECTURE.md)：今の作りの全体像（ルームと参加、状態、通知、API、セキュリティ、データと設定）
3. [OPERATIONS.md](OPERATIONS.md)：導入・起動・ルームの運用・担当の入れ替え・日常の操作・トラブルシューティング
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
| [MCP_TOOLS.md](MCP_TOOLS.md) | 現行 | **AI 向け**：session_mail の8つのツールの使い方（これ1枚で始められる） |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 現行 | 今の作り |
| [OPERATIONS.md](OPERATIONS.md) | 現行 | 使い方と運用 |
| [REQUIREMENTS.md](REQUIREMENTS.md) | 現行 | 要件の達成状況・仕様書からの変更点 |
| [DECISIONS.md](DECISIONS.md) | 現行 | 設計判断の記録 |
| [ROADMAP.md](ROADMAP.md) | 現行 | 今後の作業・既知の問題 |
| [design/](design/) | 記録 | 機能ごとの「ユーザーとの決定事項」と「実装前に書いた仕様書」。どれも**実装済み**。決定事項は今も有効だが、仕様書の「今の作りは〜」は実装前の状態を指す。今の動きは上の現行の文書で確かめる |
| [verification/](verification/) | 記録 | 検証記録・証跡。どれも**記録した時点の版**のもので、今の手順ではない。PoC とデモの記録は、ルームも役割の ID もなく、ACK の操作があったころのもの。Pi の記録（pi-20261102.md）は、Pi の参加を実装した直後のもの |
| [spec/](spec/) | 入力 | ユーザーが作成した元の仕様書（MVP 1.4）。**書き換えない** |
| [archive/](archive/) | 履歴 | 初期の設計書・実装計画・運用手順・レビュー・PoC の手順書。**今の実装とは大きく異なる**ので、経緯の確認にだけ使う。作業の根拠にしない |
| [images/](images/) | 画像 | README で使う WebUI のスクリーンショット（今の画面） |

**design/ の中身**

| 機能 | 決定事項（今も有効） | 実装前の仕様書（記録） |
|---|---|---|
| 役割の ID と担当の入れ替え（D-017） | [role-id-takeover-decisions.md](design/role-id-takeover-decisions.md) | [role-id-takeover.md](design/role-id-takeover.md) |
| ルーム（D-018） | [rooms-decisions.md](design/rooms-decisions.md) | [rooms.md](design/rooms.md) |
| Pi の参加と自動受信（D-020） | 仕様書の中に含める | [pi-integration.md](design/pi-integration.md)（機能の仕様）・[pi-integration-design.md](design/pi-integration-design.md)（設計・調査・試作の結果） |

リポジトリ直下の README には、英語版（[README.en.md](../README.en.md)）もあります。内容を変えたら、両方を直してください。

リポジトリ直下の `poc/` は、受信経路を検証したときの最小実装です。`demo/` は、ルームを入れる前の版のデモの記録です。どちらも履歴として残しているだけで、本体からは使っていません。
