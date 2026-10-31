# 設計レビュー：現行の Codex CLI／Claude Code で動くか

対象：DESIGN.md、IMPLEMENTATION_PLAN.md、OPERATIONS.md、schema.sql（設計 1.0）
実施日：2026-10-30

調べた資料：
- Codex：openai/codex の main ブランチのソースコード（commit 8801b9a8、2026-10-30 時点）。出荷済みの 0.166 とは細部が違う可能性がある。
- Claude Code：code.claude.com/docs の channels、channels-reference、mcp、hooks、cli-reference、env-vars、cross-session-messaging。

判定の記号：✅ 前提どおり動く ／ ❌ このままでは動かない（修正が必要）／ ⚠ 動くが改善が必要 ／ ❓ 資料からは判断できない（スパイクで確認する）

---

## 1. 結論

骨格は、現行の仕組みでそのまま成立する。根拠は次の3点である。

- **Codex**：`codex queue` の挙動が設計の前提と一致する。アイドル中なら自動でターンが始まり、実行中ならそのターンが終わってから処理される。
- **Claude**：Channel の通知はセッションに順に積まれ、実行中に届いたものは次のターンでまとめて処理される。
- **両方**：MCP サーバーの instructions はモデルに届く。

ただし、**このままでは自動運用が止まる不備が3件ある**（§2）。中でも C1（MCP ツールの承認）を直さないと、通知が届いても `channel_receive` が承認待ちで止まり、受入基準の「自動受信」を満たせない。

---

## 2. 致命的（実装前に設計を直す）

### C1 ❌ MCP ツールの呼び出しが承認待ちで止まる

- **問題**：設計は「通知 → モデルが channel_receive / channel_ack / channel_send を呼ぶ」ことをユーザーの入力なしで行う前提だが、ツールの承認設定を書いていない。
  - Codex：MCP ツールは `default_tools_approval_mode` と `tools.<name>` で承認の要否が決まる（`config/src/mcp_types.rs`）。
  - Claude：MCP ツールは既定で許可を求める。
- **影響**：アイドル中に通知でターンが始まっても、receive の承認ダイアログで止まる。ユーザーが承認しない限り先へ進まないため、§12.1 の「自動受信」に不合格となる。
- **修正**：
  - Codex：`[mcp_servers.session_mail]` に、session_mail のツールを自動で承認する設定を加える。具体的な値（`default_tools_approval_mode` が取る値）はスパイク S-8（新設）で確定する。
  - Claude：`~/.claude/settings.json` の `permissions.allow` に `"mcp__session_mail__channel_join"`、`..._members`、`..._send`、`..._receive`、`..._ack` を入れる。`channel_leave` は許可しない（誤って退出しないよう、ユーザーの確認を残す）。
  - 試験 R-01 と「自動受信」の合格条件に「承認ダイアログが一度も出ないこと」を足す。

### C2 ❌ Codex で案A（`env_vars` によるトークンの受け渡し）が共有デーモンの下では効かない

- **事実**：Codex は MCP サーバーを `env_clear()` してから起動し、許可リストの変数、`env_vars` で指定した変数、`env` だけを渡す。
- **問題**：共有デーモンで動いている場合、MCP プロセスは**デーモンの環境変数**から起動される。そのため、TUI を起動したシェルで設定した `SESSION_MAIL_TOKEN_FILE` が届かない。また、デーモンの下ではブリッジの寿命が TUI と一致せず、TUI を閉じても「接続中」に見える恐れがある。
- **事実**：`-c` で `features.*` 以外を上書きすると、TUI は共有デーモンを使わず、自分の中に組み込んだサーバーで動く（`tui/src/daemon_startup.rs`）。ネストしたキーの上書きもできる。
- **修正**：**案Bを正式な方式にし、案Aは削除する。**
  ```powershell
  codex resume <UUID> -c "mcp_servers.session_mail.env.SESSION_MAIL_TOKEN_FILE='C:/Users/<you>/AppData/Local/session-mail/tokens/codex-sub1.json'"
  ```
  こうするとトークンが確実に届き、ブリッジの寿命も TUI と一致する。プロセスごとのレジストリに入るので、ブリッジが他のセッションと共有されることもない。

### C3 ❌ Codex への再通知が、Codex 側の永続キューに溜まり、余分なターンを生む

- **事実**：`codex queue` のメッセージは Codex 側の SQLite に永続化され、スレッドがアイドルになったときに**1件につき1ターン**として送られる。
- **問題**：設計 §4.8 は、受信が観測されないと 2分→5分→10分→30分 の間隔で再通知する。担当が30分の作業をしている間に3件が溜まり、作業が終わった後に「通知だけのターン」が続けて3回走る。
- **修正**：`receiver_kind='codex_queue'` では**時間による再通知をしない**。Codex のキューは永続的で、アイドルになれば必ず処理されるため、再通知は不要である。通知を出すのは次の場合だけにする。
  - 新着があり、かつ outstanding がないとき
  - 再接続で新しい世代になったとき
  - Interrupted から復帰したとき（H1）
  
  「要確認」の判定（通知から10分）は、Codex では「アイドルなのに受信がない」と分かる場合に限る。それが分からない間は「通知済み・実行中の可能性」と表示する。Claude の Channel は、実行中に届いたものを1回にまとめて処理するので、再通知の害は小さい。ただし間隔は 5分→15分→30分に延ばす。

---

## 3. 重要（導入までに直す）

### H1 ⚠ Codex がユーザーの中断（Interrupted）の後だと、キューを自動で送らない

- **事実**：`ThreadIdleCause::Interrupted` のときは自動送信を飛ばす（`ext/queue/src/service.rs`）。ユーザーが Esc でターンを止めた後は、通知が届いていてもターンが始まらない。
- **修正**：Codex の `Interrupt` フックで activity を `interrupted` にし、UI に「中断後のため自動受信が止まっています（ユーザーの入力で再開）」と表示する。`UserPromptSubmit` で解除する。schema の `activity_state` に `'interrupted'` を足す。

### H2 ⚠ Claude で承認待ちを知るフックの選び方が誤っている

- **事実**：`Notification` の `permission_prompt` は、ユーザーが**約6秒入力しなかったとき**にしか発火しない。より早い合図として `PermissionRequest` イベントがあり、許可を求める直前に発火する。`PostToolUse` はツールが成功したときにしか発火しない。
- **修正**：`awaiting_approval` には `PermissionRequest` を使う。解除には `PostToolUse`、`PostToolUseFailure`、`PermissionDenied`、`Stop`、`UserPromptSubmit` を使う。
- **安全上の注意**：`PermissionRequest` のフックは allow／deny を返せる。`hook-status` は**何も出力せず exit 0 で終わり、判断に関わらない**ようにし、試験で確認する（新しい試験 B-09）。ここを誤ると、仕様書が禁じる「承認の代行」になる。

### H3 ⚠ Codex でも承認待ちを検知できる（設計は「常に unknown」としていた）

- **事実**：Codex にも `PermissionRequest`、`PostToolUse`、`Stop`、`UserPromptSubmit`、`Interrupt` などのライフサイクルフックがある（`[[hooks.<Event>]]` または `hooks.json`）。
- **修正**：DESIGN §2.4 と §6.7 を、両製品に対応するよう書き換える。設定例は OPERATIONS.md に追加する。

### H4 ⚠ Claude に標準の「セッション間メッセージング」があり、経路が二重になる

- **事実**：Claude Code には、同じマシン上の Claude セッション同士が `SendMessage`／`ListAgents` で直接やり取りする機能がある（v2.1.224 以降、Windows は v2.1.234 以降）。
- **問題**：claude-1 と claude-2 がこの機能で直接やり取りすると、session-mail を通らない。その通信は WebUI に出ず、統括（Codex）からも見えない。仕様書はこの機能（Socket）を後続扱いとしている。
- **修正**：
  - 共通の運用指示に「他の参加者との連絡は session_mail だけで行う。SendMessage は使わない」と明記する。
  - 必要なら、その2セッションで `crossSessionInbound` を `hold` か `refuse` にする。これはユーザーの他の作業に影響するので、ユーザーに確認してから決める。
  - なお、Codex はこの機能に参加できないため、session-mail が不要になるわけではない。

---

## 4. 改善（実装中に反映する）

| ID | 内容 | 修正 |
|---|---|---|
| M1 | Codex の queue は、別のプロセスから入れたメッセージを **10秒ごとのポーリング**で拾う（`watch_external_messages`） | 非機能目標を「Codex：送信から約15秒以内」に直す |
| M2 | 新しい会話で起動してしまう事故を検知できない（仕様書は新しい会話への無断の置き換えを禁じている） | 両製品の `SessionStart` フックから、セッション ID・スレッド ID をブローカーへ報告する。登録済みの conversation_id と違えば `receiver_state='not_configured'` にし、理由を「会話IDが登録と異なります」とする。Claude は stdin の `session_id` から取る。Codex がフックに何を渡すかはスパイクで確認する |
| M3 | Codex では、モデルがシェルから実行する `session-mail` CLI がサンドボックスに入り、127.0.0.1 へ接続できない可能性がある | AI の主な経路は MCP とし、CLI は人とデバッグのためのものと明記する |
| M4 | Codex の MCP 設定で `required = true` にすると、ブローカーが止まっているときにセッションが起動しない | `required` は既定（false）のままにし、`startup_timeout_sec` は短く（10秒）する。ブリッジはブローカーが止まっていてもすぐ起動する（設計どおり） |
| M5 | `codex queue` は CODEX_HOME の SQLite を使う | ブローカーを、TUI と**同じ OS ユーザー・同じ CODEX_HOME** で動かす（WSL と Windows を混ぜない）。doctor で確認する |
| M6 | Codex は、存在しない UUID には `thread not found`、アーカイブ済みのスレッドには unarchive を促すエラーを返す | これらの stderr を分類し、`receiver_detail` に分かる言葉で出す |
| M7 | `--resume` を付けると、スレッドがデーモンの中で TUI なしに動く | `--resume` を使わない現行の設計を維持し、理由をこの事実で補強する |

---

## 5. 前提どおり動くことを確認した項目

| 前提 | 判定 | 根拠 |
|---|---|---|
| Codex：アイドル中に queue でターンが自動で始まる | ✅ | `start_turn_if_idle(turn_trigger:"queue")` |
| Codex：実行中は中断されず、ターンの後に処理される | ✅ | `on_thread_idle` で送信 |
| Codex：会話 ID は `/status` で確認でき、resume しても変わらない | ✅ | `tui/src/status/card.rs`、rollout のファイル名 |
| Codex：MCP の instructions がモデルに届く | ✅ | ツールの名前空間の説明として渡される（上限 512KiB） |
| Codex：#57211 の接続共有で、ブリッジが他のセッションと共有される | ✅ 心配なし | 機能フラグは既定でオフ。共有は同じプロセスの中だけ。`env` が違えばキーも違う |
| Codex：Windows の実体のパス | ✅ | `@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`。config.json の `codex.command` に指定する |
| Claude：実行中に届いた Channel 通知は次のターンでまとめて処理される | ✅ | channels-reference |
| Claude：サーバー名 `session_mail` | ✅ | 英数字・ハイフン・アンダースコアは使える |
| Claude：MCP の stdio サーバーは Claude の環境変数を受け継ぐ。`env` の `${VAR}` は展開される | ✅ | mcp、env-vars（ただし `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1` のときは受け継がない） |
| Claude：フックが Claude の環境変数を受け継ぎ、stdin に session_id が来る | ✅ | hooks |
| Claude：Channel の利用要件 | ✅ | claude.ai か Console の API キーが必要。Bedrock・Vertex・Foundry では使えない。Team／Enterprise では channelsEnabled が必要 |

---

## 6. 資料では判断できない項目（スパイクに残す、または追加する）

| スパイク | 内容 |
|---|---|
| S-1（縮小） | Codex の queue の挙動はソースで確認できた。残るのは**出荷済みの版**での確認、終了コード、Windows での動作だけ |
| S-4（重要） | Claude の `--resume <id>` と `--dangerously-load-development-channels` を併用できるか。会話 ID が保たれるか。**アイドル中に Channel の通知で自動的にターンが始まるか**（資料では示唆されているだけ）。承認ダイアログの表示中に届いた通知の扱い |
| S-4b（追加） | 開発用 Channel の確認画面が起動のたびに出るか（再開の手順と自動化に影響する） |
| S-7（変更） | Claude と Codex の `PermissionRequest` フックが「何もしない」で終われば、承認の判断に影響しないこと |
| S-8（追加） | Codex で session_mail のツールを自動承認する設定の値。Claude の `permissions.allow` で、承認ダイアログが出なくなること |
| S-9（追加） | Codex の `SessionStart` フックの入力に thread id が含まれるか（M2） |

---

## 7. 反映する先

| 修正 | DESIGN.md | OPERATIONS.md | IMPLEMENTATION_PLAN.md | schema.sql |
|---|---|---|---|---|
| C1 | §8.3 | §1.4 にツールの承認設定を追加 | S-8、R-01 と自動受信の条件 | — |
| C2 | §8.3 | §1.4、§2.2 から案Aを削除 | S-2 を完了扱いにする | — |
| C3 | §4.8.2、§7.4 | — | U-NOTI-02 を製品別に分ける | — |
| H1・H3 | §2.4、§6.7 | §2.4 に Codex のフックを追加 | S-7、U-REACH に分岐を追加 | activity_state に interrupted を追加 |
| H2 | §6.7 | §2.4 を差し替え | B-09 を追加 | — |
| H4 | — | §4.1 に一文を追加 | 試験の観察項目に追加 | — |
| M1〜M7 | §10、§4.8.5 ほか | §5 | doctor の点検項目 | — |
