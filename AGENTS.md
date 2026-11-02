# Catchball で作業する AI・開発者へ

Catchball は、Codex CLI と Claude Code のセッションをつなぐ AI エージェント間のメッセージバスです（コード上の名前は `session-mail`、MCP サーバー名は `session_mail`）。現在のバージョンは **v1.0.0-alpha.1** です。

## まず読むもの

**session_mail のツールを使って作業するだけなら**、[docs/MCP_TOOLS.md](docs/MCP_TOOLS.md) の1枚を読めば始められます。このリポジトリのコードを直す場合は、次の順に読んでください。

1. [docs/README.md](docs/README.md)：ドキュメントの地図と「どれが正か」
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：今の作り
3. 作業の内容に応じて：[OPERATIONS](docs/OPERATIONS.md) / [REQUIREMENTS](docs/REQUIREMENTS.md) / [DECISIONS](docs/DECISIONS.md) / [ROADMAP](docs/ROADMAP.md)

`docs/archive/` は初期の設計書などの**履歴資料で、今の実装とは異なります**。作業の根拠にしないでください。ドキュメントとコードが食い違うときは、コードが正です。

## コマンド

```bash
npm ci
npm run build    # tsc と WebUI のコピー（dist/ に出力）
npm test         # build してから test/main.test.mjs を実行（11件）
```

- 試験は `node --test test/main.test.mjs` のようにファイルを指定します。Node 22 では `node --test test/` のようにフォルダーを指定すると失敗します。
- ブローカーを手で動かすときは `SESSION_MAIL_HOME=<一時フォルダー> node dist/cli/admin.js serve` とし、普段のデータフォルダーを汚さないようにします。

## コードの地図

| 場所 | 内容 |
|---|---|
| `src/broker/core.ts` | 業務処理（参加・送信・受信・接続・WebUI 用の集計） |
| `src/broker/notifier.ts` | 受信通知の判定と送信（codex queue / Channel） |
| `src/broker/http.ts` | HTTP API、Host・Origin の検証、LAN 側の制限 |
| `src/broker/db.ts` | SQLite のスキーマ（`SCHEMA`）とトランザクション |
| `src/bridge/main.ts` | MCP ブリッジ（5ツール、会話の中からの参加、ハートビート） |
| `src/shared/text.ts` | AI に渡す文面（運用指示・通知文） |
| `src/shared/config.ts` | 設定の項目と既定値、データフォルダー |
| `src/web/` | WebUI（素の JavaScript。ビルドなしでそのまま配信） |
| `test/main.test.mjs` | 自動試験 |

## 守ること

**安全性**（変えるときは、必ずユーザーに確認する）
- AI 用・管理用・参加用の API は `127.0.0.1` だけで受ける。LAN 側（47822）には WebUI の閲覧に必要なものしか置かない。
- 送信元は、必ずトークンから決める。AI の入力から決めない。
- 承認をメッセージで中継しない（`claude/channel/permission` を宣言しない）。
- 通知に本文を入れない。
- WebUI では本文を `textContent` だけで表示し、`innerHTML` は使わない（試験で確認している）。
- トークンは、ハッシュだけを保存する。ログに本文やトークンを書かない。

**変更のしかた**
- 動きを変えたら、試験を追加・更新し、`npm test` が全件通ることを確かめる。
- AI に渡す文面（`src/shared/text.ts`）や通知のしかたを変えたら、可能なら実物の Codex と Claude で動きを確かめる。Codex は MCP の instructions より通知文に従う傾向がある。
- ツール（`src/bridge/main.ts`）を追加・変更したら、`docs/MCP_TOOLS.md` も直す（試験11が、ツール名と必須の引数の説明があるかを確かめる）。
- 動き・設定・API を変えたら、`docs/ARCHITECTURE.md`・`docs/OPERATIONS.md`・`CHANGELOG.md` を更新する。要件の状況が変わったら `docs/REQUIREMENTS.md`、判断をしたら `docs/DECISIONS.md` に追記、作業が片付いたら `docs/ROADMAP.md` を更新する。
- `docs/spec/`（ユーザーが書いた元の仕様書）は書き換えない。仕様から変えた点は `docs/REQUIREMENTS.md` の「仕様書から変えた点」に書く。
- `docs/archive/` と `poc/` は履歴なので、直さない。
- ドキュメントは日本語で、平易に書く。

**Git**
- `main` から作業ブランチを作り、プルリクエストを経て `main` に取り込む。このリポジトリは作業者が1人なので、試験が通っていれば、作業した AI がプルリクエストを作って取り込んでよい。取り込んだブランチは GitHub が自動で消す。
- `.env`、データフォルダー、トークン、`node_modules/`、`dist/` はコミットしない。

## 実物の CLI で試すときの注意

- MCP サーバーは、セッションを**起動したときにしか**読み込まれない。登録してから起動する。
- Claude の自動受信には、起動時の引数 `--dangerously-load-development-channels server:session_mail` が必要。起動のたびに確認画面が出る。
- Codex は、Esc で中断した直後は通知を自動で処理しない。
- Claude（またはクラウドセッション）の中から別の Claude を起動するときは、`env -i` などで親の環境変数（`CLAUDE_CODE_SESSION_ID` など）を外す。外さないと、親のセッションと混ざる。
- Codex の担当を、sandbox なし・承認なしで起動しない。作業フォルダーの中だけ書ける通常の設定（`workspace-write`・`on-request`）を使う。
