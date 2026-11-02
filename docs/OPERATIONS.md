# 導入と運用

`<Catchball>` はクローンしたフォルダーの絶対パス、`<データ>` はデータフォルダー（[ARCHITECTURE.md §8](ARCHITECTURE.md#8-データと設定)）を表します。設定ファイルの中のパスは、Windows でも `/` 区切りで書けます。

> **動作確認の状況**：Linux 上の Codex CLI 0.166.0、Claude Code 2.1.316、Pi 1.5.0 で確かめています。**Windows と Mac ではまだ動かしていません**（[ROADMAP.md](ROADMAP.md) の R-1）。

## 1. インストールとブローカーの起動

```bash
git clone https://github.com/Ramo-Inc/Catchball.git
cd Catchball
npm ci && npm run build
node dist/cli/admin.js serve
```

- ブローカーは起動したままにします。
- 初回の起動で、`<データ>/tokens/` に admin.token・viewer.token・join.key が作られます。
- ログには、別の PC から WebUI を開くための URL が出ます。
- ポートが使えない、`config.json` の値が正しくない、といったときは、理由を書いて止まります（§7）。

**ルームを入れる前の版から替えるとき**
- DB は新しいファイル（`session-mail-v2.db`）で始まり、前のデータは引き継ぎません。前の `session-mail.db` は読まずに残すので、要らなければ手で消してください。
- 新しい DB を作るときに admin.token と viewer.token を発行し直します。WebUI には、新しいトークンでログインし直します。
- トークンファイル（provision で作ったもの）は使えなくなります。`--room` を付けて作り直します（§4.7）。
- AI のセッションは起動し直します（MCP のツールの定義が変わったため）。

コードを更新したときは、`git pull` と `npm run build` のあと、ブローカーと AI のセッションを起動し直します。

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

[mcp_servers.session_mail.tools.channel_room_delete]
approval_mode = "prompt"
```

- `default_tools_approval_mode = "approve"` を入れないと、受信や送信のたびに承認を求められ、自動では動けません。
- 退出（`channel_leave`）とルームの削除（`channel_room_delete`）だけは、確認が出るようにしています。
- データフォルダーを既定以外にしている場合は、`[mcp_servers.session_mail.env]` に `SESSION_MAIL_HOME = "<データ>"` を書きます。Codex は MCP サーバーに環境変数を引き継がないためです。

### Claude Code

```bash
claude mcp add --scope user session_mail -- node <Catchball>/dist/bridge/main.js
```

`~/.claude/settings.json` の `permissions.allow` に次の6つを加えます。`channel_leave` と `channel_room_delete` は加えず、確認が出るようにします。

```json
"mcp__session_mail__channel_join", "mcp__session_mail__channel_members", "mcp__session_mail__channel_send",
"mcp__session_mail__channel_receive", "mcp__session_mail__channel_rooms", "mcp__session_mail__channel_room_create"
```

- プロジェクトの `.mcp.json` に登録する方法もあります。その場合は、最初の起動時に「新しい MCP サーバー」の確認画面が出るので、使う方を選んでください。

### Pi（pi-coding-agent）

Pi の導入から確認までの詳しい手順は [PI_SETUP.md](PI_SETUP.md) にまとめています。ここには要点だけを書きます。

`~/.pi/agent/mcp.json` に次を書きます（すでにほかのサーバーがあれば、`mcpServers` の中に足します）。

```json
{
  "mcpServers": {
    "session_mail": {
      "command": "node",
      "args": ["<Catchball>/dist/bridge/main.js"],
      "exposure": "direct"
    }
  }
}
```

続けて、自動受信のための拡張機能を入れます（Claude の起動時の引数に当たるものです）。

```bash
pi install <Catchball>/integrations/pi
```

- `exposure: "direct"` を入れないと、ツールがモデルに直接見えません（Pi の既定は `codemode`）。
- `command` は `node` にします。拡張機能とブリッジは、Pi のプロセス番号で受け口の場所を決めるので、`npx` などを挟むと受け口が見つかりません。Node のバージョン管理の道具（Volta など）の中継が挟まる場合は、`command` に node の実体の絶対パス（`node -p process.execPath` で分かる）を書きます。
- Pi は、ツールを呼ぶたびの承認を求めません。退出や削除の前の確認も出ません。
- ブローカーの中では、Pi は Claude と同じ種類として扱われます。種類は、WebUI では「Claude」、`status` では `claude` と出ます。

## 3. 起動する

プロジェクトのフォルダーで起動します。そのフォルダーの `AGENTS.md`（Codex）と `CLAUDE.md`（Claude）が自動で読み込まれます。

```bash
cd <プロジェクトのフォルダー>
codex
```

```bash
cd <プロジェクトのフォルダー>
claude --dangerously-load-development-channels server:session_mail
```

- Claude の引数は、メッセージが届いたときに自動で動き出す（Channel）ために必要です。起動のたびに確認画面が出るので「I am using this for local development」を選びます。初めてのフォルダーでは、その前に「このフォルダーを信頼するか」の確認も出ます。
- 引数なしで起動しても、ツールは使えます。ただし、メッセージが届いても自動では動き出しません。
- Codex の担当を、sandbox なし・承認なしで起動しないでください。通常の設定（`workspace-write`・`on-request`）で十分に動きます。

```bash
cd <プロジェクトのフォルダー>
pi
```

- Pi は、§2 の拡張機能を入れていれば、引数なしで自動受信します。
- Pi の `/new`・`/resume`・fork・`/reload` では、Pi がブリッジを起動し直すので、ルームに参加していない状態に戻ります（ブローカーでは切断中）。未取得のメッセージは残ります。同じルーム・同じ ID で参加し直すよう頼めば、通知が再開します。Claude の `/clear` とは違うので注意してください。

## 4. ルームと参加

### 4.1 ルームを作る

参加者は、ルームの中でやり取りします。作業（プロジェクト）ごとにルームを作ると、全員宛ての送信や参加者の一覧が混ざりません。まず、どれかのセッションにルームの作成を頼みます（参加する前でも頼めます）。

> キャッチボールでルーム proj-a を作って。

- ルームの ID は、英字・数字・ハイフン・ドット・アンダースコアの1〜32文字です。空白と、`.`・`..` だけの ID は使えません。大文字と小文字は区別します（`Proj` と `proj` は別のルーム）。
- 一覧は「キャッチボールのルーム一覧を見せて」と頼みます。ルームごとに、作成した日時と、退出していない参加者（切断中を含む）の ID と表示名が出ます。
- AI は、頼まれたときだけルームを作ります。参加しようとしたルームがないときは、作らずにユーザーに尋ねます。
- ルームの作成・削除・一覧は AI のツールだけで行います。管理用 CLI と WebUI にはありません。

### 4.2 セッションを参加させる

各セッションに、ルーム・ID・役割と一緒に頼みます。

> キャッチボールのルーム proj-a に参加して。ID は review、表示名は「設計レビュアー」、役割は「API とコードの設計レビュー」。

> キャッチボールのルーム proj-a に、統括として参加して。ID は main、表示名は「統括」、役割は「ユーザーとの対話、仕事の振り分け、進捗管理、結果の取りまとめ」。

- ルームや ID を言わずに頼むと、AI は自分で決めずに尋ねてきます。
- 1つのセッションが同時に入れるのは、1つのルームだけです。
- Codex は、自分の会話 ID（`$CODEX_THREAD_ID`）をシェルで調べて渡します。会話 ID なしでは参加できません。
- 参加の 8 秒後に自動受信の確認が届きます。WebUI で「自動受信 確認済み」になれば準備完了です。
- 同じルームで、ほかの参加者と同じ表示名は使えません（英字の大文字・小文字の違いも同じ扱い）。

### 4.3 ID の付け方

- **ID は担当で付け、ハーネス（Codex か Claude か）では付けません。** 例：`main`（統括）、`dev`（開発）、`review`（レビュー）、`planning`（計画）。
- 使える文字は、英小文字で始まる英小文字・数字・ハイフンの32文字までです（`all` は使えません）。
- ID はルームごとです。ルーム proj-a の `dev` と、ルーム proj-b の `dev` は別の参加者です。
- 宛先は ID で指定するので、担当の中身（Codex か Claude か）が替わっても、送る側は同じ ID に送り続けられます。

### 4.4 担当を入れ替える（Codex ⇔ Claude Code ⇔ Pi）

1. 引き継ぎが必要なら、前のセッションに状況（やったこと・残り・変えたファイル）をまとめさせます。引き継ぎはセッションどうしで行います。入れ替わったことは、ほかの参加者へ自動では知らせません。
2. 前のセッションを閉じます。退出（leave）はさせません。退出すると、前の担当宛ての未取得のメッセージが配送停止になるためです。
3. 前のセッションが「切断中」になってから、新しいセッションに「キャッチボールのルーム proj-a に、ID は dev で参加して」と頼みます。前の担当宛ての未取得のメッセージは、新しいセッションがそのまま受け取ります。
   - Claude と Pi は、閉じればすぐ切断中になります。
   - Codex は、閉じても（`/new` で新しい会話にしても）前の会話が1〜2分「接続中」のまま残ります（§7-2）。
4. 前のセッションがまだ動いていた場合、そのセッションは次にツールを使ったときに「参加は無効になった」と伝えられます。続けるなら、別の ID などで参加し直させます（起動し直す必要はありません）。

### 4.5 別のルームに移る

「キャッチボールのルームを退出して、ルーム proj-b に ID は dev で入り直して」と頼みます。

- AI は `channel_leave` してから `channel_join` します。セッションを起動し直す必要はありません。
- 前のルームで受け取っていなかったメッセージは、退出で配送停止になります。
- 参加中のまま別のルームや別の ID を指定すると、断られ、「先に channel_leave する」と案内されます。

### 4.6 ルームを片付ける

作業が終わったら「キャッチボールのルーム proj-a を削除して」と頼みます。

- 退出していない参加者（切断中を含む）がいると、削除は断られます（`ROOM_NOT_EMPTY`。残っている ID が伝えられます）。各セッションを退出させてから頼みます。
- 落ちたセッションなどで、切断したまま残っている ID があるときは、新しいセッションにその ID で参加させてから退出させます。
- provision で登録しただけで、一度も参加していない ID は、削除の邪魔をしません。
- 削除すると、そのルームのメッセージや参加者の記録もすべて消えます。

### 4.7 トークンファイルで参加させる方法

起動スクリプトなどで、ルームと ID を固定したいときに使います。ふつうは §4.2 の方法で十分です。

```bash
node dist/cli/admin.js provision --room proj-a --agent dev --provider claude --conversation <会話ID> [--duty coordinator]
```

- `--room` は必須です。ルームは先に AI に作ってもらいます（CLI ではルームを作りません）。
- トークンファイルは `<データ>/tokens/room-<ルーム>/<ID>.json` にできます。フォルダー名では、大文字は「!＋小文字」、ドットは「~」になります（例：ルーム `Proj.1` は `room-!proj~1`）。
- 表示された起動コマンド（`SESSION_MAIL_TOKEN_FILE` を付けて同じ会話を再開するもの）で起動し、そのあとで `channel_join` を呼ばせます。
- トークンファイルで起動したセッションは、ルームと ID を変えられません。
- 同じトークンファイルで2つのセッションを起動しないでください。先に起動したほうが止まります（`SESSION_SUPERSEDED`）。
- 同じ ID でもう一度 provision するには `--rotate` を付けます。前のトークンは使えなくなります。

## 5. WebUI

| 開く場所 | URL |
|---|---|
| この PC | `http://127.0.0.1:47821/` |
| 同じネットワークの別の PC | `http://<IP アドレス または PC 名>:47822/` |

- ログイン用のトークンは `node dist/cli/admin.js viewer-token` で表示します。`--rotate` で再発行できます（ブローカーを止めてから実行します）。
- 画面の右上で、見るルームを選びます。選んだルームは、そのブラウザーに覚えておきます。
- ルームの作成・削除はできません（AI に頼みます）。ログインすれば、すべてのルームを見られます。
- Windows で別の PC から開くには、最初にファイアウォールの受信を許可します（管理者の PowerShell）。

  ```powershell
  New-NetFirewallRule -DisplayName "session-mail WebUI" -Direction Inbound -Protocol TCP -LocalPort 47822 -Action Allow -Profile Private
  ```

- この PC だけで見る場合は、`<データ>/config.json` に `"ui": { "lan": false }` と書きます。
- 画面の見方は [README](../README.md#画面の見方) を参照してください。

## 6. 日常の操作（管理用 CLI）

| コマンド | 用途 |
|---|---|
| `node dist/cli/admin.js status` | 全ルームの参加者ごとの参加・接続・自動受信・未取得件数・通知のエラー（先頭の列がルーム） |
| `node dist/cli/admin.js probe <ルーム> <ID> [--wait 120]` | 自動受信を確認する（通知を出し、受信されるまで待つ） |
| `node dist/cli/admin.js export [--room <ルーム>] [--from ISO] [--to ISO] [--out file.json]` | やり取りを JSON で書き出す（証跡用。`--room` を省くと全ルーム、`--out` を省くと画面に出す） |
| `node dist/cli/admin.js viewer-token [--rotate]` | WebUI のログイン用トークンを表示する（再発行する） |
| `node dist/cli/session-mail.js <join|members|send|receive|leave>` | AI と同じ送受信をコマンドで行う（`SESSION_MAIL_TOKEN_FILE` か `--token-file` でトークンファイルを渡す） |

## 7. うまくいかないとき

| 症状 | 原因と対処 |
|---|---|
| AI が「session_mail のツールがない」と言う | MCP は**起動したときにしか読み込まれません**。登録より前に起動したセッションは、一度だけ再起動します（会話は引き継げます：Codex は `codex resume --last`、Claude は `claude --continue --dangerously-load-development-channels server:session_mail`）。Claude で `.mcp.json` を使う場合は、確認画面で「使わない」を選んでいないか確認してください（`.claude/settings.local.json` の `disabledMcpjsonServers`） |
| 参加すると「ブローカーが起動していません」（`BROKER_NOT_READY`） | `serve` を起動していないか、データフォルダーが違います（Codex は §2 の `SESSION_MAIL_HOME` を確認） |
| AI が「ルームが見つからない」と言う（`ROOM_NOT_FOUND`） | ルームの ID の打ち間違いか、まだ作っていません。大文字と小文字も区別します。一覧で確かめ、必要なら作成を頼みます |
| `AGENT_IN_USE` | その ID は、そのルームで別のセッションが接続中です。別の ID は使わず、前のセッションを終了させてから参加し直します（§7-2） |
| AI が「参加が無効になった」と言う（`UNAUTHENTICATED`） | 同じルーム・同じ ID に別のセッションが参加したか、ルームが削除されました。続けるなら、ルームと ID を伝えて参加し直させます（起動し直す必要はありません） |
| AI が `SESSION_SUPERSEDED` と言う | 同じトークンファイルで、セッションを2つ起動しています。使わないほうを終了し、使うほうを起動し直します |
| AI が `INVALID_TOKEN_FILE` と言う | 渡しているトークンファイルが古い形式（ルームを入れる前の版）です。`provision --room` で作り直します |
| ブローカーが「起動できませんでした（ポート …）」で止まる | そのポートを別のプログラムが使っています。止めるか、`config.json` の `port` を変えます |
| 「config.json の … が正しくありません」で止まる | 書かれている項目の値を直します（数の項目は数で、配列の項目は1つ以上の値を並べて書きます） |
| 「自動受信 失敗（要確認）」 | `status` の通知エラーを見ます。`codex` が見つからない場合は、`config.json` の `codex.command` に codex の実体のフルパスを書きます（Windows の npm 版は `.cmd` を直接起動できません）。失敗した通知は、30秒・2分・10分の間隔で送り直します |
| Codex がメッセージに反応しない | Esc で作業を中断した直後の Codex は、届いた通知を自動では処理しません。何か入力すると、そのターンの後で処理されます |
| Pi がメッセージに反応しない | `pi list` などで拡張機能（`integrations/pi`）が入っているかを確認します。`status` の通知エラーに「Pi の拡張機能の受け口に書けません」と出ていれば、拡張機能が入っていないか、mcp.json の `command` が node の実体でありません（§2）。`/new` などのあとなら、参加し直させます（§3） |
| Claude がメッセージに反応しない | `--dangerously-load-development-channels server:session_mail` を付けて起動したか、起動時に Channel の行が表示されたかを確認します。組織のアカウントで「blocked by org policy」と出る場合は、管理者に Channels の有効化を頼んでください |
| 承認を求める画面が毎回出る | §2 のツールの承認設定（Codex の `default_tools_approval_mode`、Claude の `permissions.allow`）を確認します |
| 別の PC から WebUI が開けない | ファイアウォール、`ui.lan`、開いている名前（IP アドレスか PC 名。それ以外は `ui.allowed_hosts` に追加）を確認します |
| Claude から Claude を起動して試すと動きがおかしい | 親のセッションの環境変数（`CLAUDE_CODE_SESSION_ID` など）を引き継ぐと、親のセッションと混ざります。`env -i` などで外して起動します |

## 7-2. 異常検知と異常処理

| 異常 | 気づき方 | 対処 |
|---|---|---|
| 前のセッションが「接続中」のまま残った | 参加すると `AGENT_IN_USE`。WebUI でその ID が接続中のまま、応答が返ってこない | 前のセッションを終了させます（ウィンドウを閉じる・プロセスを止める）。AI が固まっていても、プロセスが生きていれば接続中のままです。Claude は閉じればすぐ切断になります。**Codex は閉じても（`/new` でも）前の会話の MCP サーバーが1〜2分残る**ので、1〜2分待ってから参加します。`codex app-server daemon stop` でもすぐに切れますが、動いているすべての Codex のセッションが止まるので、ほかに Codex のセッションがあるときは使いません |
| ブローカーだけが再起動した | WebUI が一時的に開けない | 何もしなくてかまいません。各セッションは数秒ごとに再接続を試み、未取得があれば通知し直します |
| 停電などで PC ごと落ちた | すべて止まる | ブローカーを起動 → AI のセッションを再開（Codex は `codex resume --last`、Claude は `claude --continue --dangerously-load-development-channels server:session_mail`）→ **同じルーム・同じ ID で**参加し直します。未取得のメッセージは、そのまま受け取れます |
| ルームを削除できない（`ROOM_NOT_EMPTY`） | 削除を頼んだ AI が、残っている ID を伝えてくる | 各セッションを退出させます。落ちたセッションで切断したまま残っている ID は、新しいセッションにその ID で参加させてから退出させます |
| 止まっている間の送信がエラーになった | `BROKER_UNAVAILABLE` | ブローカーの復旧後に、同じ `client_message_id` で送り直します（受理済みでも、二重には投稿されません） |

その他の症状は §7 を見てください。

## 8. AI に渡している運用指示

ツールの使い方を1枚にまとめたものは [MCP_TOOLS.md](MCP_TOOLS.md) です。AI に読ませるときは、これを渡してください。

AI に渡す文面は `src/shared/text.ts` にあり、ここが正です。

| 文面 | 渡す経路 |
|---|---|
| 共通の運用指示（`COMMON_GUIDE`） | MCP の instructions |
| 統括用・担当用の指示（`COORDINATOR_GUIDE` / `WORKER_GUIDE`） | `channel_join` の応答の `guide` |
| 通知文（`noticeText`）・接続確認（`PROBE_TEXT`） | Codex には `codex queue`、Claude には Channel で送る |

文面を変えたら、実際の Codex・Claude・Pi で動きを確かめてください。Codex は、MCP の instructions よりも通知文に従う傾向があります。
