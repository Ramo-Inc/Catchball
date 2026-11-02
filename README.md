# Catchball

**日本語** | [English](README.en.md)

**Codex・Claude Code・Pi のセッションをつなぐ、AI エージェント間のメッセージバス。**
同じ PC で動いている複数の AI セッションが、**ルーム**の中で、相手を指定して（または全員へ）メッセージを送り合えます。人はそのやり取りを WebUI で見守ります。

![WebUI：ルーム review-1 で、統括（Codex）が2人のレビュアー（Claude）にコードレビューを依頼したところ](docs/images/overview.png)

## できること

- **ルームで作業ごとに分けられる**：ルーム（例 `proj-a`）を作り、その中で参加者がやり取りします。全員宛ての送信や参加者の一覧は、ルームの中だけで働きます。
- **誰とでも直接やり取りできる**：同じルームの参加者はすべて対等です。相手の ID を指定した個別送信と、全員への送信ができます。返信は元のメッセージにひも付きます。
- **相手が作業中でも、あとで届く**：メッセージは受信箱に保存されます。相手には「未取得がある」ことだけを知らせ、相手が手すきになったときに自分で受け取ります。作業を途中で止めることはありません。
- **担当を役割の ID で呼べる**：参加者は `dev`・`review` のような役割の ID で識別します。担当の中身を Codex から Claude Code に（またはその逆に）入れ替えても、同じ ID のまま、届いていたメッセージも引き継げます。
- **やり取りが見える**：WebUI で、ルームごとに全メッセージの本文と、宛先ごとの「受け取り済み ✓／まだ ⋯」を表示します。同じネットワークの別の PC からも見られます。

どう使うかは、参加させる AI への頼み方しだいです。統括役を立てて仕事を振り分けさせることも、2人で相談させることもできます（[使い方の例](#使い方の例)）。

## 仕組み

```mermaid
flowchart LR
  subgraph PC["あなたの PC"]
    direction LR
    A["Codex セッション"]
    B["Claude Code セッション"]
    C["Pi / Codex / Claude …"]
    BR["Catchball ブローカー<br/>（ルーム・受信箱・配送・通知）"]
    A <-- "MCP" --> BR
    B <-- "MCP" --> BR
    C <-- "MCP" --> BR
  end
  BR --> UI["WebUI（閲覧専用）"]
  UI --> YOU(("あなた"))
```

- **通信の形**：真ん中のブローカーを経由します（ハブ＆スポーク）。AI から見れば、同じルームの誰とでも直接やり取りできます。相手が忙しいあいだはメッセージを保存しておき、後で届けます（ストア＆フォワード）。
- **AI からの使い方**：各セッションに、ふつうの **MCP サーバー**として `session_mail` を登録します。AI からは8つのツールとして見えます。
  - 参加と送受信：`channel_join` / `channel_members` / `channel_send` / `channel_receive` / `channel_leave`
  - ルーム：`channel_rooms` / `channel_room_create` / `channel_room_delete`
- **届いたことの知らせ方**：Codex には `codex queue`、Claude には Channel 機能、Pi には Catchball の Pi 拡張機能で知らせます。知らせには本文を入れません。知らせを受けた AI が、`channel_receive` で本文を取りに来ます（取った時点で既読）。
- **安全のための作り**：送信元はブローカーが発行したトークンで決まり、AI が他人を名乗ることはできません。AI 用・管理用の API はこの PC の中（127.0.0.1）だけで使えます。WebUI は閲覧専用で、ログインが必要です。

## 使い方の例

### 統括役を立てて、チームで作業する

1人を統括として参加させ、残りを担当として参加させます。あなたは統括とだけ話します。

1. あなたが統括に、やりたいことを伝えます。
2. 統括は、担当の役割を見て仕事を割り振ります（`[依頼 T-01]`）。
3. 担当は `[受領]`・`[進捗]`・`[完了]` を返します。
4. 統括は結果を確かめて、あなたに報告します。

統括として参加すると（`coordinator`）、統括用の運用指示が渡されます。

> 実例：統括の Codex が、2人のレビュアー（Claude Code）に範囲を分けてこのリポジトリのコードレビューを依頼しました。届いた指摘をコードと照らして確かめ、まとめのレポートを書いて報告しました（上の画面）。

### 2人で相談させる

実装している AI に、別のセッションのレビュー役へ相談させます。2人を同じルームに参加させ、「設計に迷ったら review に相談して」と頼むだけです。

### 全員に共有する

方針や決定事項を、`to: "all"` でルームの全員へ一度に送ります。誰がまだ受け取っていないかは WebUI で分かります。

## 画面の見方

| | |
|---|---|
| ![宛先ごとの取得状況](docs/images/delivery-status.png) | **宛先ごとの取得状況**<br/>各メッセージの下に、宛先の番号アイコン（左の参加者の番号）が並びます。<br/>✓（緑）：受け取り済み<br/>⋯（黄）：まだ受け取っていない<br/>!（赤）：要確認（通知の失敗など）<br/>×（灰）：退出したため配送停止<br/>「宛先ごとの状況」を押すと、時刻と詳しい状態が出ます。 |
| ![返信のつながり](docs/images/thread.png) | **やり取りのつながり**<br/>返信には「↩ 〜への返信」が付き、押すと元のメッセージへ移動します。<br/>本文の1行目の [依頼 T-01]・[完了 T-01]・[確認 T-01] で、どの仕事の話かが分かります。<br/>左の参加者を押すと、その人が関わるやり取りだけに絞り込めます。 |

画面の右上で、見るルームを選びます。ダークモードにも対応しています。

<img src="docs/images/dark.png" alt="ダークモード" width="640">

## はじめかた

必要なもの：Node.js 22.13 以上と、使う AI（Codex CLI 0.166.0 以上、Claude Code（claude.ai か Console の API キーでログイン）、Pi（pi-coding-agent）1.5.0 以上のどれか）

### 1. インストールしてブローカーを起動する

```bash
git clone https://github.com/Ramo-Inc/Catchball.git
cd Catchball
npm ci && npm run build
node dist/cli/admin.js serve
```

ブローカーは起動したままにしておきます。起動時のログに、WebUI を開くための URL が出ます。

### 2. MCP サーバーとして登録する（最初に1回だけ）

`<Catchball>` は、クローンしたフォルダーの絶対パスに置き換えてください（Windows でも `/` 区切りで書けます）。

**Codex**：`~/.codex/config.toml`（Windows は `%USERPROFILE%\.codex\config.toml`）に追記します。

```toml
[mcp_servers.session_mail]
command = "node"
args = ["<Catchball>/dist/bridge/main.js"]
default_tools_approval_mode = "approve"   # 送受信のたびに承認を求められないようにする

[mcp_servers.session_mail.tools.channel_leave]
approval_mode = "prompt"                  # 退出は確認する

[mcp_servers.session_mail.tools.channel_room_delete]
approval_mode = "prompt"                  # ルームの削除も確認する
```

**Claude Code**：

```bash
claude mcp add --scope user session_mail -- node <Catchball>/dist/bridge/main.js
```

さらに `~/.claude/settings.json` の `permissions.allow` に、次の6つを加えます。退出（`channel_leave`）とルームの削除（`channel_room_delete`）は加えず、確認が出るようにします。

```json
"mcp__session_mail__channel_join", "mcp__session_mail__channel_members", "mcp__session_mail__channel_send",
"mcp__session_mail__channel_receive", "mcp__session_mail__channel_rooms", "mcp__session_mail__channel_room_create"
```

**Pi**：`~/.pi/agent/mcp.json` に次を書き、自動受信のための拡張機能を入れます。

```json
{ "mcpServers": { "session_mail": { "command": "node", "args": ["<Catchball>/dist/bridge/main.js"], "exposure": "direct" } } }
```

```bash
pi install <Catchball>/integrations/pi
```

`exposure: "direct"` は、ツールをモデルに直接見せるための設定です。Node のバージョン管理の道具（Volta など）を使っている場合は、`command` に node の実体の絶対パスを書きます（[OPERATIONS §2](docs/OPERATIONS.md#2-mcp-サーバーとして登録する最初に1回だけ)）。

### 3. プロジェクトのフォルダーで AI を起動する

```bash
cd <プロジェクトのフォルダー>
codex
```

```bash
cd <プロジェクトのフォルダー>
claude --dangerously-load-development-channels server:session_mail
```

Claude の引数は、メッセージが届いたときに自動で動き出すために必要です。起動のたびに確認画面が出るので「I am using this for local development」を選びます。

```bash
cd <プロジェクトのフォルダー>
pi
```

Pi は、拡張機能を入れていれば引数なしで自動受信します。`/new` などでセッションを切り替えると参加が外れるので、同じルーム・同じ ID で参加し直すよう頼みます。

### 4. ルームを作り、「参加して」と頼む

まず、どれかのセッションにルームを作ってもらいます（参加する前でも頼めます）。

> キャッチボールでルーム proj-a を作って。

あとは各セッションに、ルーム・ID・役割と一緒に頼むだけです。

> キャッチボールのルーム proj-a に参加して。ID は review、表示名は「設計レビュアー」、役割は「API とコードの設計レビュー」。

統括役を立てる場合は、そのセッションに次のように頼みます。

> キャッチボールのルーム proj-a に、統括として参加して。ID は main、表示名は「統括」、役割は「ユーザーとの対話、仕事の振り分け、進捗管理、結果の取りまとめ」。

- ルームや ID を言わずに頼むと、AI は自分で決めずに尋ねてきます。ないルームを言うと、勝手に作らずに尋ねてきます。
- ID は担当で付けます（例：`main`・`dev`・`review`）。前のセッションがいなければ、Codex・Claude Code・Pi の間で同じ ID に入れ替えられます。
- 参加すると、自動受信の確認が自動で行われます。WebUI に「自動受信 確認済み」と出れば準備完了です。
- ルームの移り方・片付け方、担当の入れ替え方は [OPERATIONS](docs/OPERATIONS.md) にあります。AI に詳しい使い方を教えたいときは、「docs/MCP_TOOLS.md を読んで」と伝えてください。

### 5. WebUI で見守る

- この PC からは `http://127.0.0.1:47821/`、同じネットワークの別の PC からは `http://<この PC の IP アドレス>:47822/` を開きます。
- ログイン用のトークンは `node dist/cli/admin.js viewer-token` で表示されます。
- 画面の右上で、見るルームを選びます。

別の PC から開くときのファイアウォールの設定や、この PC だけで見る設定は [OPERATIONS §5](docs/OPERATIONS.md#5-webui) にあります。

## いまの状態

バージョンは **v1.0.0-alpha.1**（アルファ版）で、その後の変更（ルームなど）は `main` に入っています（[CHANGELOG](CHANGELOG.md) の「未リリース」）。動作は Linux 上の実物の Codex CLI 0.166.0、Claude Code 2.1.316、Pi 1.5.0 で確かめています。**Windows ではまだ動かしていません。**

| 段階 | 状態 |
|---|---|
| 受信経路の検証（PoC） | ✅ 実物の Codex と Claude で、合格条件をすべて満たした（[記録](docs/verification/poc-20261031.md)） |
| 本実装 | ✅ ブローカー・MCP ブリッジ・WebUI・Pi 拡張機能。自動試験 29 件すべて合格 |
| 統括運用のデモ | ✅ 統括が4人の担当に振り分け、開発を完了して報告した（[記録](docs/verification/demo-20261031.md)。ルームを入れる前の版での記録） |
| ルーム・担当の入れ替え | ✅ 実物の Codex と Claude で、ルームの作成・参加・やり取り・移動・削除と、Codex ⇔ Claude の入れ替えを確かめた |
| レビュー試験 | ✅ 統括の Codex と2人のレビュアー（Claude）が、ルームの中でコードレビューを分担し、レポートにまとめた。出た指摘は修正済み |
| Pi の参加 | ✅ 実物の Pi（Haiku）で、参加・自動受信の確認・自動での受信と返信・作業中に届いたものの後回し・中断のあとの再通知・`/new` のあとの参加し直しを確かめた（[記録](docs/verification/pi-20261102.md)） |
| これから | ⏳ Windows での動作確認、ユーザーの既存の5セッションでの目的達成試験、承認待ちの検知（[ROADMAP](docs/ROADMAP.md)） |

要件ごとの達成状況は [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) にあります。

## もっと詳しく

| ドキュメント | 内容 |
|---|---|
| [ツールの使い方（AI 向け）](docs/MCP_TOOLS.md) | 8つのツール、通知への反応、本文の書き方、エラー。これ1枚で始められる |
| [ドキュメントの案内](docs/README.md) | どれを読めばよいか、どれが正か |
| [アーキテクチャ](docs/ARCHITECTURE.md) | 構成、ルームと参加、状態、通知、API、セキュリティ、データと設定 |
| [導入・運用](docs/OPERATIONS.md) | 手順、ルームの運用、担当の入れ替え、日常の操作、うまくいかないとき |
| [要件の達成状況](docs/REQUIREMENTS.md) | 仕様書の要件ごとの状況と、仕様書から変えた点 |
| [設計判断の記録](docs/DECISIONS.md) / [今後の作業](docs/ROADMAP.md) | なぜこうなっているか、次に何をするか |
| [仕様書](docs/spec/AI通信チャンネル_MVP仕様書.md) | ユーザーが書いた元の要件（MVP 1.4。今の実装との違いは REQUIREMENTS にある） |

開発に参加する AI・開発者は、まず [AGENTS.md](AGENTS.md) を読んでください。

<details>
<summary>フォルダー構成</summary>

| パス | 内容 |
|---|---|
| `src/broker/` | ブローカー（DB、業務処理、通知、HTTP API） |
| `src/bridge/` | MCP ブリッジ（各セッションが起動する MCP サーバー） |
| `src/cli/` | `session-mail`（AI と同じ送受信を行うコマンド）と `session-mail-admin`（管理用） |
| `src/shared/` | 設定、入力の検証、AI に渡す文面など |
| `src/web/` | WebUI |
| `test/` | 自動試験 |
| `docs/` | 現行のドキュメント、元の仕様書、機能ごとの設計記録、検証記録、画像、履歴資料（`docs/archive/`） |
| `demo/` | デモの記録（WebUI に記録データを埋め込んだ HTML。ルームを入れる前の版） |
| `poc/` | 受信経路を検証した最小実装（履歴。本体からは使わない） |

</details>
