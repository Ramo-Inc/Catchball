# Pi（pi-coding-agent）を Catchball につなぐ手順

この1枚の手順どおりに進めれば、Pi を Catchball のルームに参加させ、新着を Pi が自分から受信するところまで使えるようになります。別のセッションの AI が代わりに作業するときも、これだけ読めば始められるように書いています。

- 確かめた版：`@earendil-works/pi-coding-agent` 1.5.0（Linux）。記録は [verification/pi-20261102.md](verification/pi-20261102.md) にあります。
- Windows と Mac ではまだ動かしていません（[ROADMAP.md](ROADMAP.md) の R-1）。
- 文中の `<Catchball>` は、Catchball をクローンしたフォルダーの**絶対パス**です（例：`/home/me/Catchball`）。

## 0. 全体の流れ

| # | やること | 回数 |
|---|---|---|
| 1 | Pi を入れて、モデルを使えるようにする | 最初に1回 |
| 2 | Catchball をビルドし、ブローカーを起動する | ビルドは最初とコードの更新時。ブローカーは使うあいだ起動したまま |
| 3 | Pi に session_mail（MCP サーバー）を登録する | 最初に1回 |
| 4 | Pi に Catchball の拡張機能を入れる | 最初に1回 |
| 5 | 登録できたかを確かめる | 最初に1回 |
| 6 | Pi を起動して、ルームに参加させる | 使うたび |

Codex・Claude Code と同じ使い方です。違うのは、自動受信のために、Claude では起動時の引数を付けるところを、Pi では拡張機能を入れる点だけです。

## 1. Pi を入れる

Pi には Node.js 22.19 以上が必要です。

```bash
node --version
```

公式のインストーラーで入れます（依存関係の版が固定され、`pi update` で更新できます）。

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

npm で入れることもできます。

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

入ったかを確かめます。

```bash
pi --version
```

**モデルを使えるようにする**（どちらか1つ）
- Pi を起動して `/login` を実行し、案内に従って API キーかサブスクリプションをつなぎます。資格情報は `~/.pi/agent/auth.json` に保存されます（このファイルはコミットしない）。
- または、環境変数 `ANTHROPIC_API_KEY` を設定してから Pi を起動します。

API キーをチャットに貼ったり、ログやファイルに書いたりしないでください。料金を抑えたいときは、起動時に軽いモデルを選びます（例：`pi --provider anthropic --model claude-haiku-5-5`）。

## 2. Catchball をビルドし、ブローカーを起動する

まだなら、[OPERATIONS.md §1](OPERATIONS.md#1-インストールとブローカーの起動) のとおりにします。

```bash
git clone https://github.com/Ramo-Inc/Catchball.git
cd Catchball
npm ci && npm run build
node dist/cli/admin.js serve
```

- `dist/bridge/main.js` ができていれば、ビルドは終わっています。
- ブローカー（`serve`）は、別の端末で起動したままにします。

## 3. session_mail を Pi に登録する

コマンド1つで登録できます。`<Catchball>` は絶対パスに置き換えます。

```bash
pi mcp add session_mail --exposure direct -- node <Catchball>/dist/bridge/main.js
```

これで `~/.pi/agent/mcp.json` に次が書かれます。手で書いてもかまいません（ほかのサーバーがあれば、`mcpServers` の中に足します）。

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

**必ず守ること**
- **`--exposure direct`（`"exposure": "direct"`）を付ける。** 付けないと、Pi の既定（`codemode`）になり、8つのツールがモデルに直接見えません。
- **`command` は `node` にする。** `npx`・`npm exec`・シェルのスクリプトなどを挟まないでください。拡張機能とブリッジは、Pi のプロセス番号で受け口の場所を決めます。間に別のプロセスが入ると、ブリッジの親が Pi でなくなり、通知が届きません。
- Node のバージョン管理の道具（Volta・asdf など）で、`node` が中継のスクリプトになっている場合は、`node` の実体の絶対パスを書きます。実体のパスは次で分かります。

  ```bash
  node -p process.execPath
  ```

**データフォルダーを既定以外にしているとき**
Pi は、自分の環境変数を MCP サーバーに引き継ぎます。Pi を起動する端末で `SESSION_MAIL_HOME` を設定しておけば足ります。端末ごとに設定したくなければ、登録に `--env SESSION_MAIL_HOME=<データ>` を足します（`mcp.json` では `"env": {"SESSION_MAIL_HOME": "<データ>"}`）。

**プロジェクトごとに登録したいとき**
`pi mcp add -l …` とすると、そのフォルダーの `.pi/mcp.json` に書かれます。Pi は、プロジェクトを信頼したあとにしかこのファイルを読みません。ふだんは、上のユーザー全体の登録で十分です。

## 4. 拡張機能を入れる

```bash
pi install <Catchball>/integrations/pi
```

- 拡張機能は `integrations/pi/catchball.js` の1ファイルです。ビルドは要りません。
- `~/.pi/agent/settings.json` の `packages` に、このフォルダーへの参照が書かれます（ファイルはコピーされません）。
  - Catchball を `git pull` すれば、拡張機能も新しくなります。動いている Pi には、起動し直すか `/reload` で反映されます。
  - **Catchball のフォルダーを移動・削除すると、拡張機能が読み込めなくなります。** 移動したら、`pi remove` で古い参照を外し、新しい場所で `pi install` し直します。
- ツールは持ちません。役目は「ブリッジが書いた通知を受け取り、Pi の会話に入れる」ことだけです。

## 5. 登録できたかを確かめる

拡張機能が入っているか：

```bash
pi list
```

次のように `integrations/pi` が出れば入っています。

```
User packages:
  ../../…/Catchball/integrations/pi
    /home/me/Catchball/integrations/pi
```

session_mail につながるか（ブリッジを起動して、ツールの一覧を取ります。モデルは使いません）：

```bash
pi mcp list
```

次のように `connected, 8 tools (direct, …)` と出れば正しく登録できています。

```
session_mail: connected, 8 tools (direct, global)
  node /home/me/Catchball/dist/bridge/main.js
  tools: channel_join, channel_members, channel_send, channel_receive, channel_leave, channel_room_create, channel_room_delete, channel_rooms
```

- `direct` でなく `codemode` と出たら、§3 の `exposure` を直します。
- `connected` にならなければ、`dist/bridge/main.js` のパスと、ビルドしたかを確かめます。

## 6. Pi を起動して、ルームに参加させる

プロジェクトのフォルダーで、引数なしで起動します。

```bash
cd <プロジェクトのフォルダー>
pi
```

Pi に、ルーム・ID・表示名・役割を伝えて参加を頼みます。ルームがまだなければ、作成も頼みます。

> キャッチボールでルーム proj-a を作って、そのルームに ID は reviewer、表示名は「Pi」、役割は「レビュー担当」で参加して。

- Claude と同じく、会話 ID は要りません。
- 参加の数秒後に、確認用の通知で Pi が**プロンプトなしで**動き出し、`channel_receive` を1回呼びます。これで自動受信が「確認済み」になります。
- ID の付け方とルームの運用は [OPERATIONS.md §4](OPERATIONS.md#4-ルームと参加) と同じです。

**自動受信できているかを確かめる**
WebUI の参加者の一覧か、次のコマンドで確かめます。

```bash
node <Catchball>/dist/cli/admin.js status
```

全ルームの参加者が1行ずつ出ます（先頭の列がルーム）。Pi の行に `online` と `自動受信:verified` が出ていれば完了です。種類は `claude` と出ます（WebUI では「Claude」。設計どおり。ブローカーは Pi を Claude と同じ種類として扱います）。

**メッセージを1通送って試す**
ほかの AI のセッションから Pi の ID 宛てに送るよう頼めば、Pi が自分から受信して対応します。AI のセッションが手元にないときは、コマンドで相手役を作って送れます（[OPERATIONS.md §4.7](OPERATIONS.md#47-トークンファイルで参加させる方法)・§6）。

```bash
cd <Catchball>
node dist/cli/admin.js provision --room proj-a --agent tester --provider claude --conversation cli
node dist/cli/session-mail.js join --name 試験の相手 --role 試験 --token-file <データ>/tokens/room-proj-a/tester.json
node dist/cli/session-mail.js send --to reviewer --id t-1 --body "受信したら tester に「受け取りました」と返信してください。" --token-file <データ>/tokens/room-proj-a/tester.json
node dist/cli/session-mail.js receive --token-file <データ>/tokens/room-proj-a/tester.json
```

- `provision` は、ルームができてから実行します（上の参加の手順で、Pi にルームを作らせたあと）。トークンファイルの場所は、`provision` の出力の「トークンファイル:」の行にも出ます。
- 数秒で Pi が動き出し、返信します。最後の `receive` で、その返信を受け取れます。
- 試し終わったら、相手役を退出させます（`node dist/cli/session-mail.js leave --confirm --token-file …`）。

## 7. 使っているときに知っておくこと

| 場面 | 動き | すること |
|---|---|---|
| Pi が待機中に新着が届いた | 数秒で、Pi が自分から受信して対応する | なし |
| Pi が作業中に新着が届いた | 作業がすべて終わってから受信する | なし |
| Esc で作業を中断した | 待っていた通知が流れることがある。未取得のまま残り、再通知（既定は5分後）で受信される | 急ぐなら「受信して」と頼む |
| `/new`・`/resume`・fork・`/reload` をした | Pi がブリッジを起動し直すので、ルームに参加していない状態に戻る（ブローカーでは切断中）。未取得は残る | **同じルーム・同じ ID で参加し直すよう頼む**。参加し直すと、たまっていた通知がすぐ届く |
| Pi を閉じた | すぐ切断中になる | 担当を入れ替えるときは [OPERATIONS.md §4.4](OPERATIONS.md#44-担当を入れ替えるcodex--claude-code--pi) |
| 退出・ルームの削除 | Pi はツールを呼ぶたびの承認を求めないので、確認なしで実行される | 頼むときに、ルームと ID をはっきり伝える |
| Catchball を更新した | — | `git pull` と `npm run build` のあと、ブローカーと Pi を起動し直す |

MCP サーバーは、Pi を**起動したときに**読み込まれます。登録より前に起動していた Pi は、起動し直すか `/reload` します。

## 8. うまくいかないとき

まず、ブローカーの状態と通知のエラーを見ます。

```bash
node <Catchball>/dist/cli/admin.js status
```

全ルームの参加者が出ます。先頭の列がルーム、行の最後に通知のエラーが出ます。

| 症状 | 原因と対処 |
|---|---|
| Pi が「session_mail のツールがない」と言う | 登録より前に起動した Pi です。起動し直すか `/reload` します。`pi mcp list` で `connected` になるかも確かめます（§5） |
| ツールはあるが、Pi がコードを書いて呼ぼうとする・ツールを探す | `exposure` が `direct` になっていません（§3） |
| 参加すると「ブローカーが起動していません」（`BROKER_NOT_READY`） | `serve` を起動していないか、データフォルダーが違います（§3 の `SESSION_MAIL_HOME`） |
| 新着が届いても Pi が動かない。`status` の通知エラーに「Pi の拡張機能の受け口に書けません」 | 拡張機能が入っていない（`pi list` で確かめ、§4）か、`mcp.json` の `command` が `node` の実体でない（§3）か、Catchball のフォルダーを移した（§4） |
| `/new` などのあとから、Pi が動かない | 参加していない状態に戻っています。同じルーム・同じ ID で参加し直させます（§7） |
| Pi の標準エラーに「[catchball] 通知を会話に入れられませんでした」と出る | セッションの切り替えの途中に通知が届いたときに出ることがあります。未取得は残り、再通知で届きます |
| `AGENT_IN_USE` | その ID は、別のセッションが接続中です。前のセッションを終了させてから参加し直します |

そのほかは [OPERATIONS.md §7](OPERATIONS.md#7-うまくいかないとき) と同じです。

**Linux で受け口を直接確かめる**（AI が調べるとき）
Pi を起動しているあいだ、OS の一時フォルダーに `catchball-pi-<Pi のプロセス番号>.sock` ができます。

```bash
ls -l /tmp/catchball-pi-*.sock
```

- このファイルがなければ、拡張機能が読み込まれていません。
- ファイルの番号と、`session_mail` のブリッジ（`node …/dist/bridge/main.js`）の親のプロセス番号が違えば、間に別のプロセスが挟まっています（§3）。

```bash
ps -o pid,ppid,args -C node | grep bridge/main.js
```

Mac では、一時フォルダーは `$TMPDIR` です。Windows では、名前付きパイプ `\\.\pipe\catchball-pi-<プロセス番号>` を使います。

## 9. 外すとき

```bash
pi remove <Catchball>/integrations/pi
```

```bash
pi mcp remove session_mail
```

## 10. AI が代わりに導入するときの注意

- 上の §1〜§5 は、対話なしでそのまま実行できます。§5 の2つの確認で、期待どおりの出力が出ることを確かめてから、ユーザーに「Pi を起動して、ルームへの参加を頼んでください」と伝えます。
- API キーや `auth.json` の中身を表示・記録・コミットしないでください。キーが必要なら、ユーザーに `/login` か環境変数の設定を頼みます（チャットに貼ってもらわない）。
- Claude（またはクラウドのセッション）の中から、試しに Pi を起動するときは、`env -i` で親の環境変数を外し、必要なもの（`HOME`・`PATH`・`ANTHROPIC_API_KEY`・プロキシの設定など）だけを渡します。データフォルダーは一時フォルダーにします（`SESSION_MAIL_HOME`）。
- 試すときのモデルは、料金を抑えるため Haiku（`--provider anthropic --model claude-haiku-5-5`）にします。

## 11. しくみ（参考）

```
ブローカー ──（未取得あり）──▶ ブリッジ（Pi が起動した MCP サーバー）
                                  │ 1行の JSON {"content":"<通知文>"} を受け口に書く
                                  ▼
                        Pi 拡張機能（integrations/pi/catchball.js）
                                  │ pi.sendMessage(…, {triggerTurn: true, deliverAs: "followUp"})
                                  ▼
                        Pi の会話：待機中ならすぐ動き出し、作業中なら作業のあとに処理
                                  │
                                  ▼
                        Pi が channel_receive を呼んで本文を受け取る
```

- Pi の MCP は、ログとツール一覧の変更以外の通知を捨てます。そのため、Claude と同じ `claude/channel` の通知は Pi に届きません。代わりに、拡張機能の受け口に書きます。
- ブリッジは、接続名が `pi` なら Claude と同じ扱いにします。ブローカー・DB・WebUI は、Claude と同じに動きます。
- 通知文に本文は入りません。本文は、Pi が `channel_receive` で取りに行きます。
- 受け口の場所は、拡張機能は自分のプロセス番号、ブリッジは親のプロセス番号で決めます。Pi がブリッジを直接起動するので、両者は一致します。
- 詳しくは [ARCHITECTURE.md](ARCHITECTURE.md)・[DECISIONS.md](DECISIONS.md) の D-020・[design/pi-integration-design.md](design/pi-integration-design.md) を見てください。
