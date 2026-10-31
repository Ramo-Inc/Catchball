# 導入と運用（v1.0.0-alpha.1）

`<Catchball>` はクローンしたフォルダーの絶対パス、`<データ>` はデータフォルダー（[ARCHITECTURE.md §8](ARCHITECTURE.md#8-データと設定)）を表します。設定ファイルの中のパスは、Windows でも `/` 区切りで書けます。

> **動作確認の状況**：Linux 上の Codex CLI 0.166.0 と Claude Code 2.1.314 で確認しています。**Windows ではまだ動かしていません**（[ROADMAP.md](ROADMAP.md)）。

## 1. インストールとブローカーの起動

```bash
git clone https://github.com/Ramo-Inc/Catchball.git
cd Catchball
npm ci && npm run build
node dist/cli/admin.js serve
```

ブローカーは起動したままにします。初回の起動で、`tokens/` に admin.token・viewer.token・join.key が作られます。ログには、別の PC から WebUI を開くための URL が出ます。

## 2. MCP サーバーとして登録する（最初に1回だけ）

### Codex

`~/.codex/config.toml`（Windows は `%USERPROFILE%\.codex\config.toml`）に次を追記します。

```toml
[mcp_servers.session_mail]
command = "node"
args = ["<Catchball>/dist/bridge/main.js"]
default_tools_approval_mode = "approve"

[mcp_servers.session_mail.tools.channel_leave]
approval_mode = "prompt"
```

- `default_tools_approval_mode = "approve"` を入れないと、受信や送信のたびに承認を求められ、自動では動けません。
- データフォルダーを既定以外にしている場合は、`[mcp_servers.session_mail.env]` に `SESSION_MAIL_HOME = "<データ>"` を書きます。Codex は MCP サーバーに環境変数を引き継がないためです。

### Claude Code

```bash
claude mcp add --scope user session_mail -- node <Catchball>/dist/bridge/main.js
```

`~/.claude/settings.json` の `permissions.allow` に次の5つを加えます。`channel_leave` は加えず、退出だけは確認が出るようにします。

```json
"mcp__session_mail__channel_join", "mcp__session_mail__channel_members", "mcp__session_mail__channel_send",
"mcp__session_mail__channel_receive", "mcp__session_mail__channel_ack"
```

- プロジェクトの `.mcp.json` に登録する方法もあります。その場合は、最初の起動時に「新しい MCP サーバー」の確認画面が出るので、使う方を選んでください。

## 3. 起動する

プロジェクトのフォルダーで起動します。そのフォルダーの `AGENTS.md`（Codex）と `CLAUDE.md`（Claude）が自動で読み込まれます。別のフォルダーで起動すると、そのフォルダーのものが読まれるので注意してください。

```bash
cd <プロジェクトのフォルダー>
codex
```

```bash
cd <プロジェクトのフォルダー>
claude --dangerously-load-development-channels server:session_mail
```

- Claude の引数は、メッセージが届いたときに自動で動き出す（Channel）ために必要です。起動のたびに確認画面が出るので「I am using this for local development」を選びます。
- 引数なしで起動しても、ツールは使えます。ただし、メッセージが届いても自動では動き出しません。

## 4. 参加する

各セッションに、役割と一緒に頼みます。

> キャッチボールに参加して。ID は claude-1、表示名は「設計レビュアー」、役割は「API とコードの設計レビュー」。

> キャッチボールに、統括として参加して。ID は codex-main、表示名は「統括」、役割は「ユーザーとの対話、仕事の振り分け、進捗管理、結果の取りまとめ」。

- Codex は、自分の会話 ID（`$CODEX_THREAD_ID`）をシェルで調べて登録します。
- 参加の 8 秒後に自動受信の確認が届きます。WebUI で「自動受信 確認済み」になれば準備完了です。
- ID を省略すると、`codex-1` のような ID が自動で割り当てられます。

### トークンファイルで参加させる方法（従来の方法）

```bash
node dist/cli/admin.js provision --agent claude-1 --provider claude --conversation <会話ID> [--duty coordinator]
```

表示された起動コマンド（`SESSION_MAIL_TOKEN_FILE` を付けて同じ会話を再開するもの）で起動し、そのあとで `channel_join` を呼ばせます。

## 5. WebUI

| 開く場所 | URL |
|---|---|
| この PC | `http://127.0.0.1:47821/` |
| 同じネットワークの別の PC | `http://<IP アドレス または PC 名>:47822/` |

- ログイン用のトークンは `node dist/cli/admin.js viewer-token` で表示します（`--rotate` で再発行できます。再発行するときはブローカーを止めてください）。
- Windows で別の PC から開くには、最初にファイアウォールの受信を許可します（管理者の PowerShell）。

  ```powershell
  New-NetFirewallRule -DisplayName "session-mail WebUI" -Direction Inbound -Protocol TCP -LocalPort 47822 -Action Allow -Profile Private
  ```

- この PC だけで見る場合は、`<データ>/config.json` に `"ui": { "lan": false }` と書きます。
- 画面の見方は [README](../README.md#画面の見方) を参照してください。

## 6. 日常の操作（管理用 CLI）

| コマンド | 用途 |
|---|---|
| `node dist/cli/admin.js status` | 参加者ごとの参加・接続・自動受信・未取得件数・通知のエラー |
| `node dist/cli/admin.js probe <ID> [--wait 120]` | 自動受信を確認する（通知を出し、受信されるまで待つ） |
| `node dist/cli/admin.js export [--from ISO] [--to ISO] --out file.json` | やり取りを JSON で書き出す（証跡用） |
| `node dist/cli/session-mail.js <join|members|send|receive|ack|leave>` | AI と同じ6操作をコマンドで実行する（`SESSION_MAIL_TOKEN_FILE` が必要） |

## 7. うまくいかないとき

| 症状 | 原因と対処 |
|---|---|
| AI が「session_mail のツールがない」と言う | MCP は**起動したときにしか読み込まれません**。登録より前に起動したセッションは、一度だけ再起動します（会話は引き継げます：Codex は `codex resume --last`、Claude は `claude --continue --dangerously-load-development-channels server:session_mail`）。Claude で `.mcp.json` を使う場合は、確認画面で「使わない」を選んでいないか確認してください（`.claude/settings.local.json` の `disabledMcpjsonServers`） |
| 参加すると「ブローカーが起動していません」 | `serve` を起動していないか、データフォルダーが違います（Codex は §2 の `SESSION_MAIL_HOME` を確認） |
| `AGENT_IN_USE` | その ID は別のセッションが接続中です。別の ID を使うか、そのセッションを終了してから参加し直します |
| Codex が「自動受信は未準備」 | 会話 ID なしで参加しています。「`$CODEX_THREAD_ID` を conversation_id に入れて、もう一度 channel_join して」と頼みます |
| 「自動受信 失敗（要確認）」 | `status` の通知エラーを見ます。`codex` が見つからない場合は、`config.json` の `codex.command` に codex の実体のフルパスを書きます（Windows の npm 版は `.cmd` を直接起動できません） |
| Codex がメッセージに反応しない | Esc で作業を中断した直後の Codex は、届いた通知を自動では処理しません。何か入力すると、そのターンの後で処理されます |
| Claude がメッセージに反応しない | `--dangerously-load-development-channels server:session_mail` を付けて起動したか、起動時に Channel の行が表示されたかを確認します。組織のアカウントで「blocked by org policy」と出る場合は、管理者に Channels の有効化を頼んでください |
| 承認を求める画面が毎回出る | §2 のツールの承認設定（Codex の `default_tools_approval_mode`、Claude の `permissions.allow`）を確認します |
| 別の PC から WebUI が開けない | ファイアウォール、`ui.lan`、開いている名前（IP アドレスか PC 名。それ以外は `ui.allowed_hosts` に追加）を確認します |
| Claude から Claude を起動して試すと動きがおかしい | 親のセッションの環境変数（`CLAUDE_CODE_SESSION_ID` など）を引き継ぐと、親のセッションと混ざります。`env -i` などで外して起動します |

## 8. AI に渡している運用指示

ツールの使い方を1枚にまとめたものは [MCP_TOOLS.md](MCP_TOOLS.md) です。AI に読ませるときは、これを渡してください。

AI に渡す文面は `src/shared/text.ts` にあり、ここが正です。

| 文面 | 渡す経路 |
|---|---|
| 共通の運用指示（`COMMON_GUIDE`） | MCP の instructions |
| 統括用・担当用の指示（`COORDINATOR_GUIDE` / `WORKER_GUIDE`） | `channel_join` の応答の `guide` |
| 通知文（`noticeText`） | 受信・ACK・返信の最小限の手順を含めて送る |

文面を変えたら、実際の Codex と Claude で動きを確かめてください。Codex は、MCP の instructions よりも通知文に従う傾向があります。
