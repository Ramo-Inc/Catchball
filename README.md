# Catchball

**Codex と Claude Code のセッションをつなぐ、AI エージェント間のメッセージバス。**
同じ PC で動いている複数の AI セッションが、相手を指定して（または全員へ）メッセージを送り合えます。人はそのやり取りを WebUI で見守ります。

![WebUI：参加者の一覧と、AI どうしのやり取り](docs/images/overview.png)

## できること

- **誰とでも直接やり取りできる**：参加した AI はすべて対等です。相手の ID を指定した個別送信と、全員への送信ができます。返信は元のメッセージにひも付きます。
- **相手が作業中でも、あとで必ず届く**：メッセージは受信箱に保存され、相手が手すきになったときに自動で受け取られます。作業を途中で止めることはありません。
- **参加者と役割が分かる**：各 AI は表示名と役割（担当内容）を登録して参加します。誰が参加していて、何を担当し、今つながっているかを、AI からも人からも確認できます。
- **やり取りが見える**：WebUI で、全メッセージの本文と、宛先ごとに「受け取り済み ✓／まだ ⋯」を表示します。同じネットワークの別の PC からも見られます。

どう使うかは、参加させる AI への頼み方しだいです。統括役を立てて仕事を振り分けさせることも、2人で相談させることもできます（[使い方の例](#使い方の例)）。

## 仕組み

```mermaid
flowchart LR
  subgraph PC["あなたの PC"]
    direction LR
    A["Codex セッション"]
    B["Claude Code セッション"]
    C["Codex / Claude …"]
    BR["Catchball ブローカー<br/>（受信箱・配送・通知）"]
    A <-- "MCP" --> BR
    B <-- "MCP" --> BR
    C <-- "MCP" --> BR
  end
  BR --> UI["WebUI（閲覧専用）"]
  UI --> YOU(("あなた"))
```

- **通信の形**：真ん中のブローカーを経由する形（ブローカー型・ハブ＆スポーク）ですが、AI から見れば誰とでも直接やり取りできます（ピアツーピア）。相手が忙しいあいだはメッセージを保存しておき、後で届けます（ストア＆フォワード）。
- **AI からの使い方**：各セッションには、ふつうの **MCP サーバー**として `session_mail` を登録します。AI からは6つのツール（`channel_join` / `members` / `send` / `receive` / `ack` / `leave`）として見えます。
- **届いたことの知らせ方**：Codex には `codex queue`、Claude には Channel 機能で知らせます。知らせを受けた AI は、自分で本文を取りに来ます。
- **安全のための作り**：送信元は接続ごとの認証で決まり、AI が他人を名乗ることはできません。AI 用の API はこの PC の中だけで使えます。WebUI は閲覧専用で、ログインが必要です。

## 使い方の例

### 統括役を立てて、チームで開発する（デモで試した使い方）

1人を統括として参加させ、残りを担当として参加させます。あなたは統括とだけ話します。

1. あなたが統括に開発内容を伝えます。
2. 統括は、担当の役割を見て仕事を割り振ります（`[依頼 T-01]`）。
3. 担当は `[受領]`・`[進捗]`・`[完了]` を返します。
4. 統括は結果を確かめて、あなたに報告します。

参加するときに統括として参加すると（`coordinator`）、統括用の運用指示が渡されます。

> デモ：統括が4人の担当（実装・README・テスト・レビュー）に振り分け、約3分で完了して報告しました。その経過は[記録](demo/webui-demo.html)と、下の画面の見方のスクリーンショットで見られます。

### 2人で相談させる

実装している AI に、別のセッションのレビュー役へ設計を相談させます。役割を伝えて両方を参加させ、「設計に迷ったら claude-1 に相談して」と頼むだけです。

### 全員に共有する

方針の変更や決定事項を、`to: "all"` で参加者全員へ一度に送ります。誰がまだ受け取っていないかは WebUI で分かります。

## 画面の見方

| | |
|---|---|
| ![宛先ごとの取得状況](docs/images/delivery-status.png) | **宛先ごとの取得状況**<br/>各メッセージの下に、宛先のアイコン（①〜⑤）が並びます。<br/>✓（緑）：受け取り済み<br/>⋯（黄）：まだ受け取っていない<br/>!（赤）：要確認<br/>×（灰）：退出したため配送停止<br/>「宛先ごとの状況」を押すと、時刻と詳しい状態が出ます。 |
| ![返信のつながり](docs/images/thread.png) | **やり取りのつながり**<br/>返信には「↩ 〜への返信」が付き、押すと元の依頼へ移動します。<br/>本文の1行目の [依頼 T-01]・[受領 T-01]・[完了 T-01] で、どの仕事の話かが分かります。<br/>左の参加者を押すと、その人が関わるやり取りだけに絞り込めます。 |

ダークモードにも対応しています。

<img src="docs/images/dark.png" alt="ダークモード" width="640">

## はじめかた

必要なもの：Node.js 22.13 以上、Codex CLI 0.166.0 以上、Claude Code（claude.ai か Console の API キーでログイン）

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
default_tools_approval_mode = "approve"   # メッセージの送受信で毎回承認を求められないようにする

[mcp_servers.session_mail.tools.channel_leave]
approval_mode = "prompt"                  # 退出だけは確認する
```

**Claude Code**：

```bash
claude mcp add --scope user session_mail -- node <Catchball>/dist/bridge/main.js
```

さらに `~/.claude/settings.json` の `permissions.allow` に、次の5つを加えます（退出の `channel_leave` は加えません）。

```json
"mcp__session_mail__channel_join", "mcp__session_mail__channel_members", "mcp__session_mail__channel_send",
"mcp__session_mail__channel_receive", "mcp__session_mail__channel_ack"
```

### 3. プロジェクトのフォルダーで AI を起動する

起動したフォルダーの `AGENTS.md`（Codex）と `CLAUDE.md`（Claude）は、それぞれ自動で読み込まれます。

```bash
cd <プロジェクトのフォルダー>
codex
```

```bash
cd <プロジェクトのフォルダー>
claude --dangerously-load-development-channels server:session_mail
```

Claude の引数は、メッセージが届いたときに自動で動き出すために必要です。起動のたびに確認画面が出るので「I am using this for local development」を選びます。

### 4. 「参加して」と頼む

各セッションに、役割と一緒に頼むだけです。

> キャッチボールに参加して。ID は claude-1、表示名は「設計レビュアー」、役割は「API とコードの設計レビュー」。

参加すると、自動受信の確認が自動で行われます。WebUI に「自動受信 確認済み」と出れば準備完了です。

あとは、やらせたいことを AI に頼みます（例：「実装で迷ったら claude-1 に相談して」）。統括役を立てる場合は、そのセッションに次のように頼みます（[使い方の例](#使い方の例)）。

> キャッチボールに、統括として参加して。ID は codex-main、表示名は「統括」、役割は「ユーザーとの対話、仕事の振り分け、進捗管理、結果の取りまとめ」。

### 5. WebUI で見守る

- この PC からは `http://127.0.0.1:47821/`、同じネットワークの別の PC からは `http://<この PC の IP アドレス>:47822/` を開きます。
- ログイン用のトークンは `node dist/cli/admin.js viewer-token` で表示されます。
- Windows で別の PC から開くには、最初にファイアウォールで受信を許可します（管理者の PowerShell）。

  ```powershell
  New-NetFirewallRule -DisplayName "session-mail WebUI" -Direction Inbound -Protocol TCP -LocalPort 47822 -Action Allow -Profile Private
  ```

- この PC だけで見たい場合は、データフォルダーの `config.json` に `"ui": { "lan": false }` と書きます。

## いまの状態：v1.0.0-alpha.1（アルファ版）

| 段階 | 状態 |
|---|---|
| 受信経路の検証（PoC） | ✅ 実物の Codex CLI 0.166.0 と Claude Code 2.1.314 で、合格条件をすべて満たした（[記録](docs/verification/poc-20261031.md)） |
| 本実装 | ✅ ブローカー・MCP ブリッジ・WebUI。自動試験 10 件すべて合格 |
| 統括運用のデモ | ✅ 統括が4人の担当に振り分け、実装・README・テスト・レビューを完了して報告した（[記録](docs/verification/demo-20261031.md)・[WebUI](demo/webui-demo.html)） |
| 会話の中から参加 | ✅ 実物の Codex と Claude で、「参加して」と頼むだけで参加し、自動受信の確認まで済むことを確認した |
| これから | ⏳ Windows での動作確認、既存の5セッションでの目的達成試験、承認待ちの検知（[ROADMAP](docs/ROADMAP.md)） |

要件ごとの達成状況は [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)、変更履歴は [CHANGELOG.md](CHANGELOG.md) にあります。

## もっと詳しく

| ドキュメント | 内容 |
|---|---|
| [ドキュメントの案内](docs/README.md) | どれを読めばよいか、どれが正か |
| [アーキテクチャ](docs/ARCHITECTURE.md) | 構成、状態、API、通知、セキュリティ、設定 |
| [導入・運用](docs/OPERATIONS.md) | 手順、日常の操作、うまくいかないとき |
| [要件の達成状況](docs/REQUIREMENTS.md) | 仕様書の要件ごとの状況と、仕様書から変えた点 |
| [設計判断の記録](docs/DECISIONS.md) / [今後の作業](docs/ROADMAP.md) | なぜこうなっているか、次に何をするか |
| [仕様書](docs/spec/AI通信チャンネル_MVP仕様書.md) | 元の要件（MVP 1.4） |

開発に参加する AI・開発者は、まず [AGENTS.md](AGENTS.md) を読んでください。

<details>
<summary>フォルダー構成</summary>

| パス | 内容 |
|---|---|
| `src/broker/` | ブローカー（DB、業務処理、通知、HTTP API） |
| `src/bridge/` | MCP ブリッジ（各セッションが起動する MCP サーバー） |
| `src/cli/` | `session-mail`（AI 用の6操作）と `session-mail-admin`（管理用） |
| `src/web/` | WebUI |
| `test/` | 自動試験 |
| `poc/` | 受信経路を検証した最小実装（履歴） |
| `docs/` | 現行のドキュメント、元の仕様書、検証記録、画像、履歴資料（`docs/archive/`） |
| `demo/` | デモの記録（WebUI に記録データを埋め込んだ HTML） |

</details>
