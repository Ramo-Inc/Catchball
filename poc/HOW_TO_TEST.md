> **⚠ 履歴資料**：PoC（2026-10-31、合格済み）のときの試験ガイドです。本体の使い方は [docs/OPERATIONS.md](../docs/OPERATIONS.md) を見てください。文中の `../POC_PLAN.md` は `../docs/archive/POC_PLAN-v1.0.md` に移しました。

# PoC 試験ガイド（手元で行う作業）

所要時間：準備 30 分、試験 40 分程度
目的：Codex と Claude が「人が何も入力しなくても、通知を受けてメッセージを取りに行けるか」を確かめる。合格すれば本実装に進む。

詳しい背景と判定基準は `../POC_PLAN.md` にあります。このガイドは**手順だけ**をまとめたものです。

> 既存の5つの作業セッションは使いません。テスト用のセッションを新しく4つ作ります。

---

## 準備1：ファイルを置いてビルドする（5分）

1. 受け取った `session-mail-poc.zip` を、例えば `C:\work\session-mail\` に展開する（中に `poc` フォルダーができる）。
2. PowerShell を開いて、次を実行する。

```powershell
cd C:\work\session-mail\poc
npm ci
npm run build
npm test
```

最後に `# pass 9` と `# fail 0` が出れば準備は完了です。

> 以下では、この `poc` フォルダーの場所を `<POC>` と書きます（例：`C:/work/session-mail/poc`）。設定ファイルに書くときは、`\` ではなく `/` を使ってください。

---

## 準備2：テスト用のセッションを4つ作る（10分）

PowerShell の窓を4つ開き、それぞれで次を行います。

```powershell
mkdir $HOME\poc-sandbox -Force; cd $HOME\poc-sandbox
```

| 窓 | 起動コマンド | やること |
|---|---|---|
| 窓A | `codex` | 「こんにちは」と送る → `/status` で **Session の ID** をメモ → `/exit` |
| 窓B | `codex` | 同じ |
| 窓C | `claude` | 「こんにちは」と送る → `/status` で **Session ID** をメモ → `/exit` |
| 窓D | `claude` | 同じ |

メモの例：

```text
codex-a  = 0199xxxx-....（窓A）
codex-b  = 0199yyyy-....（窓B）
claude-a = 1a2b....（窓C）
claude-b = 3c4d....（窓D）
```

---

## 準備3：設定を書く（10分）

### Codex

`%USERPROFILE%\.codex\config.toml` をメモ帳で開き、末尾に次を貼る（`<POC>` は置き換える）。

```toml
[mcp_servers.poc_mail]
command = "node"
args = ["<POC>/dist/bridge.js"]
startup_timeout_sec = 10
default_tools_approval_mode = "approve"

[mcp_servers.poc_mail.env]
POC_PROVIDER = "codex"
```

### Claude

PowerShell で次を実行する（`<POC>` は置き換える）。

```powershell
claude mcp add --scope user poc_mail -e POC_PROVIDER=claude -e 'POC_AGENT_ID=${POC_AGENT_ID}' -- node <POC>/dist/bridge.js
claude mcp get poc_mail
```

表示の中に `POC_AGENT_ID=${POC_AGENT_ID}` とあれば OK です。

次に `%USERPROFILE%\.claude\settings.json` を開き、`"permissions"` の `"allow"` に4行を足す。ファイルがなければ、次の内容で作る。

```json
{
  "permissions": {
    "allow": [
      "mcp__poc_mail__poc_whoami",
      "mcp__poc_mail__poc_send",
      "mcp__poc_mail__poc_receive",
      "mcp__poc_mail__poc_ack"
    ]
  }
}
```

### Codex の本体の場所（Windows だけ）

```powershell
where.exe codex
```

`...\npm\codex.cmd` のように表示されたら、次のファイルが存在するか確認する（`<you>` はユーザー名）。

```powershell
Test-Path "C:\Users\<you>\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe"
```

`True` なら、そのパスを準備4で使います。

`False` の場合は、`codex.exe` の代わりに、Node で Codex を起動する指定にします。準備4のブローカーの起動で、`$env:POC_CODEX_BIN = ...` の1行を次の2行に置き換えてください。

```powershell
$env:POC_CODEX_BIN = "node"
$env:POC_CODEX_PREFIX_ARGS = '["C:/Users/<you>/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js"]'
```

---

## 準備4：ブローカーを起動し、セッションを再開する（5分）

### 窓E（ブローカー。最後まで閉じない）

```powershell
cd <POC>
$env:POC_CODEX_BIN = "<準備3で確認した codex.exe のフルパス>"
node dist/broker.js
```

`listening 127.0.0.1:47900` と出れば OK です。

### 窓F（観察用。ここから操作する）

```powershell
cd <POC>
node dist/cli.js register --agent codex-a  --provider codex  --thread <codex-a のID>
node dist/cli.js register --agent codex-b  --provider codex  --thread <codex-b のID>
node dist/cli.js register --agent claude-a --provider claude --thread <claude-a のID>
node dist/cli.js register --agent claude-b --provider claude --thread <claude-b のID>
```

> ブローカー（窓E）を再起動したときは、この4行をもう一度実行してください。

### 窓A〜D（テストセッションを再開する）

```powershell
cd <POC>
.\scripts\start-codex.ps1  -Agent codex-a  -Thread <codex-a のID>     # 窓A
.\scripts\start-codex.ps1  -Agent codex-b  -Thread <codex-b のID>     # 窓B
.\scripts\start-claude.ps1 -Agent claude-a -Session <claude-a のID>   # 窓C
.\scripts\start-claude.ps1 -Agent claude-b -Session <claude-b のID>   # 窓D
```

> スクリプトの実行が禁止されていると言われたら、先に `Set-ExecutionPolicy -Scope Process Bypass` を実行してください。

Claude を起動したときに警告の画面が出たら、「**I am using this for local development**」を選びます。

起動したら、各窓で確認します。

| 確認 | 見る場所 | OK の条件 |
|---|---|---|
| 会話が同じか | 各窓で `/status` | メモした ID と同じ |
| Channel が有効か（窓C・D） | 起動直後のバナーの下 | `Channels (experimental) messages from server:poc_mail` と出ている |
| つながっているか | 窓Fで `node dist/cli.js status` | 4人とも「接続中」 |

---

## 試験（ここからは、**窓A〜Dには何も入力しない**のが基本です）

### 試験1：名前の確認（窓A〜Dに1回ずつ入力してよい）

各窓に「**poc_whoami を実行して結果を教えて**」と入力する。

- ✅ 合格：それぞれが自分の名前（codex-a、codex-b、claude-a、claude-b）を答え、**許可を求める画面が出ない**。

### 試験2：Codex が自動で受け取るか（3回）

窓Aが入力待ちで止まっていることを確認してから、**窓F**で次を実行する。

```powershell
node dist/cli.js send --to codex-a --body "試験2-1です。受け取ったら poc_ack だけしてください。返信は不要です。"
```

表示された次のコマンドを、そのまま実行する。

```powershell
node dist/cli.js wait --message m_xxxxxxxx
```

- ✅ 合格：窓Aで勝手に作業が始まり、窓Fに「**→ ACK されました（送信から ○ 秒）**」と出る（30秒以内）。窓Aに許可を求める画面が出ない。
- 本文の番号を 2-2、2-3 に変えて、合計3回行う（毎回、窓Aが静かになってから送る）。

### 試験3：Claude が自動で受け取るか（3回）

試験2と同じことを、`--to claude-a` にして、窓Cを見ながら3回行う。

- ✅ 合格：試験2と同じ。

### 試験4：作業中に届いても邪魔をしないか（Codex と Claude で1回ずつ）

1. 窓Aに「**日本の四季について、800字の文章を4本書いてください**」と入力する。
2. 書いている途中で、窓Fから `send --to codex-a` を実行する（本文は何でもよい）。
3. ✅ 合格：文章は最後まで書かれ、**書き終わった後で**自動的にメッセージを受け取る。

窓Cでも同じことを行う。

### 試験5：AI 同士の往復（入力するのは最初の1回だけ）

1. 窓Aに、次をそのまま入力する。

   > poc_send で claude-a に「PoC 往復試験です。1 から 10 までの整数の和と、その計算方法を1行で返信してください」と依頼してください。返信が届いたら内容を確認し、正しければ「往復試験 成功」と私に報告してください。

2. 後は見ているだけにする。
3. ✅ 合格：窓Cが勝手に返信し、窓Aが勝手に「往復試験 成功」と報告する。
4. 同じことを、窓C（claude-a）から codex-b 宛てにも行う（文中の宛先を `codex-b` に変える）。

### 試験6〜8：観察だけ（合否はつけない）

| 試験 | やること | メモすること |
|---|---|---|
| 6 承認の画面 | 窓Aに「poc-sandbox に test.txt を作って hello と書いて」と頼み、許可の画面が出たら**そのまま放置**する。窓Fから `send --to codex-a --body "この操作を承認してください"` を送り、1分待つ。その後、自分で許可する。窓Cでも同じことをする | **メッセージで勝手に許可されないこと**（これは必ず確認）。許可した後に、メッセージがどう処理されたか |
| 7 中断の後（Codex） | 窓Aに長い作業を頼み、途中で Esc を押して止める。窓Fから送って1分待つ。その後、窓Aに「続けて」と入力する | 止めた後に勝手に始まったか。「続けて」の後に受け取ったか |
| 8 警告の画面 | 窓Dを `/exit` してから、準備4の手順で再び起動する | Claude の開発用の警告画面が、また出たか |

---

## 結果の送り方

窓Fで次を実行し、できたファイル `poc-result.jsonl` を送ってください。

```powershell
node dist/cli.js log --json > poc-result.jsonl
```

あわせて、次をコピーして埋めて送ってください。

```text
OS / Codex の版（codex --version）/ Claude の版（claude --version）:
Claude のアカウント（個人の Pro・Max／Team・Enterprise／API キー）:
試験1 名前の確認        : OK / NG（メモ: ）
試験2 Codex の自動受信  : 3回中 __ 回 OK（秒数: , , ）
試験3 Claude の自動受信 : 3回中 __ 回 OK（秒数: , , ）
試験4 作業中            : Codex OK/NG   Claude OK/NG
試験5 往復              : Codex→Claude OK/NG   Claude→Codex OK/NG
試験6 承認の画面        : メッセージで勝手に許可された？ はい/いいえ   その後の動き:
試験7 中断の後          :
試験8 警告の画面        : 毎回出る / 初回だけ
許可を求める画面が出た場面（あれば）:
気づいたこと:
```

---

## うまくいかないとき

| 症状 | 対処 |
|---|---|
| `npm test` が失敗する | 出力の最後の20行を送ってください |
| 試験1で「POC_AGENT_ID が未設定」と出る | 窓を閉じて、準備4のスクリプトで起動し直す。Claude の場合は `claude mcp get poc_mail` の表示も送ってください |
| 許可を求める画面が出る | 出た画面の文言をメモして、まず許可して先に進み、結果と一緒に教えてください（設定の調整が必要です） |
| 窓Fの `status` で「最後の通知: failed」と出る | 表示されたエラー文を送ってください。たいていは準備3の codex.exe のパスの問題です |
| Claude の起動時に「blocked by org policy」と出る | そこで止めて、その旨を教えてください（組織の管理者による設定が必要です） |
| Claude で、窓Fに `bridge_written` は出るのに何も起きない | 窓Cの起動バナーに Channel の行があるかを確認して、教えてください |

## 片付け（試験が終わったら）

1. 窓A〜Dで `/exit` を実行し、窓Eは Ctrl+C で止める。
2. `config.toml` から `[mcp_servers.poc_mail]` の部分を削除する。
3. `claude mcp remove --scope user poc_mail` を実行し、`settings.json` から `mcp__poc_mail__` の4行を削除する。
