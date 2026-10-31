# session-mail 実装計画・試験計画・完了判定

DESIGN.md を実装する手順を定める。各フェーズには「完了条件」を置き、満たさないまま次のフェーズを完成扱いにしない。仕様書 §11 の開発順序と §12 の受入基準に対応させている。

---

## 1. 全体像

```text
Phase 0  検証スパイク（実CLIでの事実確認）         ── P2 の前提。P1 と並行して進めてよい
Phase 1  ブローカーの中核（DB・業務処理・AI向けAPI・CLI）
Phase 2  MCP ブリッジ＋実際の受信通知で 2 セッションの往復   ← 公式受信経路は早い段階で確認する（§11）
Phase 3  WebUI
Phase 4  既存 5 会話への導入と機能試験（20方向・全員送信・切断・承認）
Phase 5  運用指示を揃え、代表課題で目的達成試験（§12.2）
Phase 6  不足の修正・再検証・完了判定（§12.3）
```

報告に使う状態のラベル（仕様書 §要件「別の状態として扱う」）：

| ラベル | 条件 |
|---|---|
| 機能実装済み | Phase 1〜3 のコードが揃い、自動試験が通る |
| 技術試験合格 | Phase 4 の機能試験（§4.2 の表）がすべて合格 |
| 統括運用検証済み | Phase 5 の目的達成試験がすべての段階で合格 |
| 最終要件達成 | 上の3つに加え、継続利用の試験（追加依頼）と、運用資料・再開手順の提供が揃う |

前のラベルを、次のラベルの代わりに報告しない。

---

## 2. Phase 0：検証スパイク

> **更新（2026-10-31）**：Phase 0 は **POC_PLAN.md（PoC と合否判定）に置き換えた**。PoC の合格条件 G1〜G5 をすべて満たすまで、Phase 1 には入らない。以下のスパイク表は背景資料として残す。PoC で扱わない S-5・S-6・S-7・S-9 は、Phase 1 の中で確認する。

仕様書 §14 の「未検証」を、実際の CLI で確かめる。**本番の5会話ではなく、テスト用の会話**で行う（§10）。結果は `docs/verification/spikes.md` に、日時・CLI の版・OS・手順・観測結果・判断を記録する。

### 2.1 スパイクの一覧

| ID | 確かめること | 手順 | 合格の判断 | 不合格だった場合 |
|---|---|---|---|---|
| S-1 | Codex `queue` で、**アイドル中**のスレッドがユーザーの入力なしに次のターンを始めるか。**実行中**ならターンを中断せず、次のターンで処理されるか。読み込まれていないスレッドへ送ると何が返るか（終了コード、stderr） | テスト用の Codex を `codex resume <UUID>` で開いたまま、別の端末から `codex queue --thread <UUID> --message "テスト"` を実行する。アイドル時、長い作業の実行中、TUI を閉じた状態の3通りで試す | アイドル時に自動でターンが始まる。実行中は中断されない | 自動でターンが始まらない場合、§10 の自動受信要件を満たせない。ユーザーと協議する（候補：app-server クライアントの前倒し）。協議するまで「自動受信：未達」とする |
| S-2 | Codex の stdio MCP サーバーへ、セッションごとに異なる環境変数を渡せるか（案A `env_vars`、案B `-c` で上書き）。0.166.0 の「stdio MCP 接続を複数チャットで共有」によって、別のセッションと**ブリッジのプロセスが共有されない**か | 2つの Codex セッションを異なるトークンで起動し、`session-mail-admin status` で2つの agent が別々の pid と世代で接続しているかを見る | 各セッションがそれぞれの agent_id で接続している | 共有されるなら、セッションごとに MCP サーバー名を分ける（`session_mail_codex_sub1` など）設定に変える。それでも分離できない場合は設計を見直す |
| S-3 | Codex の既存会話の UUID を確認する方法。`codex resume` で ID が変わらないか | `/status`、ピッカー、セッションファイル | resume した後も同じ UUID | — |
| S-4 | Claude で `--resume <id>` と `--dangerously-load-development-channels server:session_mail` を併用したとき、同じ会話 ID が保たれ、Channel が登録されるか。アイドル時に通知でターンが始まるか。実行中は次のターンにまとめて届くか。承認ダイアログ中はどうなるか。org policy で止められないか | テスト用のセッションで、`doctor --probe` とブリッジのデバッグログを見る | アイドル時に自動でターンが始まり、receive に到達する | org policy で止められた：組織の管理者へ依頼し、未達として記録する |
| S-5 | Claude の会話 ID の確認方法。MCP 設定の `${VAR}` 展開が効くか | `/status`、ブリッジの起動ログ | — | 展開できなければ、起動スクリプトでパスを直接書いた一時的な設定を `--mcp-config` で渡す |
| S-6 | Windows で：better-sqlite3 のインストール、`codex` の実体のパス（`.cmd` か exe か）、`execFile` で shell を使わずに起動できるか、データディレクトリの作成 | `npm ci`、`doctor` | すべて成功する | config.json の `codex.command` に exe のフルパスを書く |
| S-7 | Claude の Hooks で、承認待ちを検知するイベント名と matcher（`Notification` の permission_prompt など） | テスト用のセッションで、承認が必要な Bash を実行させる | 承認ダイアログの表示中に awaiting_approval になり、承認後に clear される | 使えなければ activity は `unknown` のままにする（機能は満たせる。UI の文言で対応する） |

### 2.2 スパイクの結果を反映する先

- OPERATIONS.md の **[S-n]** の箇所を、確定した手順に書き換える。
- 方式を変えた場合は、DESIGN.md の該当する節（§4.8.5、§8.3 など）も更新する。

### 2.3 doctor の点検項目（Phase 1 で実装し、S-6 で使う）

1. データディレクトリの場所（同期フォルダーでないこと）と権限
2. DB の `PRAGMA integrity_check` と schema_version
3. ブローカーが 127.0.0.1:{port} だけで応答していること（`0.0.0.0` で待ち受けていないこと）
4. `codex --version` と `claude --version` を表示し、`codex queue --help` が成功すること
5. 各参加者：トークンファイルがあること、DB の登録内容（provider・会話 ID）と一致すること、membership、接続、auto_receive、未取得の件数
6. `--probe`：§DESIGN 6.6 の手順

---

## 3. 作業の分解（Phase 1〜3）

各タスクの完了条件は「コード＋その試験が通ること」とする。試験 ID は §4 を参照。

### Phase 1：ブローカーの中核

| # | タスク | ファイル | 完了条件（試験） |
|---|---|---|---|
| 1.1 | プロジェクトの雛形。版の固定、lint（innerHTML の禁止）、vitest | package.json、tsconfig.json、.eslintrc | `npm test` が空で通る |
| 1.2 | パス・設定・トークン | shared/paths.ts、config.ts、tokens.ts | U-TOK-01〜03 |
| 1.3 | 入力の検証と正規化 | shared/validation.ts | U-VAL-01〜08 |
| 1.4 | DB の初期化・マイグレーション・連番 | broker/db/* | D-02 |
| 1.5 | 認証（agent、viewer、admin、ui_session） | services/auth.ts | A-SEC-01〜03 |
| 1.6 | join・leave・members と到達性の導出 | services/membership.ts、shared/reachability.ts | U-JOIN-01〜06、U-REACH-01〜08 |
| 1.7 | send（宛先の確定・冪等性） | services/messaging.ts | U-SEND-01〜09 |
| 1.8 | receive・ack | services/delivery.ts | U-RECV-01〜06 |
| 1.9 | 接続（connect・heartbeat・掃除処理・世代） | services/presence.ts | U-PRES-01〜05 |
| 1.10 | 通知（スケジューラ、Codex のアダプター、Claude 用のキュー） | services/notifier.ts、notify/* | U-NOTI-01〜08（Codex はフェイクのコマンドで試す） |
| 1.11 | HTTP（ルーター、security、agent・admin のルート） | http/* | A-* |
| 1.12 | CLI `session-mail` と `session-mail-admin`（serve、provision、status、doctor、probe） | cli/* | A-CLI-01、手動で doctor を実行 |
| 1.13 | 単一起動のロックと、終了時の後片付け | broker/main.ts | D-03 |

**Phase 1 の完了条件**：上の試験がすべて通る。CLI だけで、2つの agent が join・send・receive・ack を往復できる。

### Phase 2：MCP ブリッジと実際の受信経路

| # | タスク | ファイル | 完了条件 |
|---|---|---|---|
| 2.1 | ブリッジの本体（トークンファイル、capabilities の出し分け、6ツール） | bridge/main.ts、tools.ts | B-01〜04（MCP SDK の Client を使い、stdio で試験する） |
| 2.2 | ハートビートと Channel 通知の送出 | bridge/heartbeat.ts | B-05〜07 |
| 2.3 | instructions の生成（OPERATIONS.md §4 から） | bridge/instructions.ts、scripts/gen-instructions.ts | B-08（OPERATIONS.md の原文と完全に一致すること） |
| 2.4 | **実 CLI での往復**：テスト用の Codex 1つと Claude 1つ | — | R-01：Codex→Claude と Claude→Codex を、どちらもユーザーの入力なしに receive→ack まで到達させる。`doctor --probe` で両方が verified になる |

**Phase 2 の完了条件**：R-01 に合格し、Phase 0 の S-1〜S-5 の結果が記録されている。S-1 か S-4 が不合格なら、Phase 3 に進む前にユーザーと協議する。

### Phase 3：WebUI

| # | タスク | ファイル | 完了条件 |
|---|---|---|---|
| 3.1 | UI 向けの API（members、messages、deliveries、login、health） | http/uiRoutes.ts | A-UI-01〜07 |
| 3.2 | 画面の骨格、ログイン、ポーリング、接続断のバナー | web/app.ts、api.ts | W-01〜03 |
| 3.3 | 参加者欄（状態名、役割、選択による絞り込み） | web/render.ts | W-04〜05 |
| 3.4 | 履歴（古い順、以前の通信、増分、折り畳み、返信先へ移動、新着ボタン） | web/render.ts | W-06〜09 |
| 3.5 | 宛先ごとの状況、空の状態、フッターの注記 | web/render.ts | W-10〜12 |

**Phase 3 の完了条件**：W-01〜12 が Playwright で通る。実際の2セッションのやり取りが画面で読める（スクリーンショットは補助の証跡）。

---

## 4. 試験計画

### 4.1 自動試験（vitest。ブローカーを一時ディレクトリとランダムなポートで同じプロセス内に起動する）

**ユニット**

| ID | 内容 |
|---|---|
| U-VAL-01〜08 | 表示名：前後の空白、NFC（`が` の結合文字と合成済み文字が同じキーになる）、ASCII の大文字小文字、40/41文字、制御文字、空欄。役割：200/201文字、改行の拒否。本文：20,000/20,001文字、NUL、`\t\n` の許可 |
| U-TOK-01〜03 | 形式、ハッシュの照合（timingSafeEqual）、失効 |
| U-JOIN-01〜06 | 新規の join。再 join で役割を更新（ID と世代は変わらず、未取得の配送もそのまま）。重複名を拒否し、以前の登録を維持。大文字小文字の違いだけの名前も重複扱い。退出した人の名前は再利用できる。何度呼んでも同じ結果になる |
| U-REACH-01〜08 | §DESIGN 4.3 の全分岐（自分自身、provisioned、left、offline、awaiting_approval、verified、unverified、failing） |
| U-SEND-01 | 個別送信で配送が1件だけ作られる |
| U-SEND-02 | 全員送信の宛先＝joined の参加者から自分を除いた全員（offline も含み、provisioned と left は含まない） |
| U-SEND-03 | 宛先 0 人なら NO_RECIPIENTS で、投稿は作られない |
| U-SEND-04 | 送信者自身への配送が作られない。SELF_SEND |
| U-SEND-05 | 同じキー・同じ内容なら同じ message_id と宛先を返し（duplicate=true）、件数は増えない |
| U-SEND-06 | 同じキーで内容が違えば IDEMPOTENCY_CONFLICT |
| U-SEND-07 | 全員送信の後に誰かが join しても、再送の結果の宛先は変わらない（宛先の確定） |
| U-SEND-08 | UNKNOWN_RECIPIENT、RECIPIENT_NOT_JOINED、自分が関わっていない reply_to は INVALID_REPLY_TO |
| U-SEND-09 | 未参加の送信者は NOT_JOINED。leave した後でも冪等な再送は元の結果を返す |
| U-RECV-01〜06 | 自分宛ての分だけ返る（他人の受信箱が混ざらない）。古い順と limit。receive_count の増加。他人宛ての ACK は NOT_FOUND。ACK を何度送っても同じ結果。cancelled_left への ACK |
| U-LEAVE-01〜03 | 未取得が cancelled_left になる。新規の送信が RECIPIENT_NOT_JOINED になる。再 join しても配送は戻らない |
| U-PRES-01〜05 | connect で世代が増える。古い世代は STALE_GENERATION。30秒で offline。再接続で force_on_connect が立つ。プロフィールの更新で世代は変わらない |
| U-NOTI-01 | 3件の未取得をまとめて通知1回 |
| U-NOTI-02 | 受信されていない通知がある間は、新着でも通知しない。再通知は 2分→5分→10分→30分 |
| U-NOTI-03 | offline・awaiting_approval の間は通知しない。再接続するとすぐ通知する |
| U-NOTI-04 | 通知の後に receive が来ると verified になる。世代が違う receive では verified にならない |
| U-NOTI-05 | 3回連続で失敗すると failing。成功すると unverified に戻る |
| U-NOTI-06 | Codex のアダプター：shell を使わずに引数が渡る（本文に `"; rm -rf` を含めても安全）。タイムアウトは failed |
| U-NOTI-07 | 通知文に本文が含まれない |
| U-NOTI-08 | ブローカーを再起動すると全員が offline になり、再接続の後に再通知される |

**DB**

| ID | 内容 |
|---|---|
| D-01 | 送信が受付済みを返した直後にプロセスを強制終了（子プロセスに SIGKILL）しても、再起動後に投稿と全配送が残っている |
| D-02 | マイグレーションを何度実行しても同じ結果になる。PRAGMA が設定されている |
| D-03 | serve の二重起動を拒否する。provision はブローカーの稼働中に拒否される |

**API（権限と UI）**

| ID | 内容 |
|---|---|
| A-SEC-01 | トークンなし・不正・失効済みは 401 |
| A-SEC-02 | 本文に `from` を入れても無視され、送信元はトークンの主になる（偽 from の拒否） |
| A-SEC-03 | 他人宛ての配送への ACK が効かない |
| A-SEC-04 | Host が違えば 421。AI 向け API に Origin があれば 403。UI の POST で Origin が違えば 403。Content-Type が違えば 415 |
| A-SEC-05 | `<script>alert(1)</script>` や `<img src=x onerror=…>` を含む本文が、UI でスクリプトとして実行されない（Playwright で dialog が出ないことと、DOM にテキストとして入っていることを確認） |
| A-SEC-06 | ログとエクスポートにトークンが出てこない（ログ全体を grep する） |
| A-UI-01〜07 | members（未参加と退出済みを含む、pending_count）。messages の初回・before_seq・since_seq（ACK による更新を取りこぼさない）・participant・kind・q のフィルタ。deliveries の ui_state の全分岐 |
| A-CLI-01 | CLI の6コマンドが、MCP と同じ結果と同じエラーコードを返す |

**ブリッジ（MCP Client で stdio 接続して試験する）**

| ID | 内容 |
|---|---|
| B-01 | tools/list が6つだけ。admin 系のツールが出てこない |
| B-02 | provider=claude なら `claude/channel` を宣言し、`claude/channel/permission` は宣言しない。codex ならどちらも宣言しない |
| B-03 | トークンファイルがなければ、ツールが設定エラーを返す（プロセスは落ちない） |
| B-04 | send がネットワークエラーのとき、同じキーで1回だけ再試行する |
| B-05 | ハートビートが5秒ごとに送られる。STALE_GENERATION で connect し直す |
| B-06 | ハートビートの応答の notify から `notifications/claude/channel` が出る（meta のキーが識別子の形式になっている） |
| B-07 | stdin が閉じたら disconnect を送って終了する |
| B-08 | instructions が OPERATIONS.md §4 の原文と一致する |

**UI（Playwright。実際のブローカーに試験用データを入れて試す）**

| ID | 内容 |
|---|---|
| W-01 | ログイン。トークンが URL・localStorage に残らない |
| W-02 | ブローカーを止めると、2回の失敗の後にバナーと最終更新時刻が出る |
| W-03 | ブローカーを戻すとバナーが消え、止めていた間の投稿と ACK に追いつく |
| W-04 | 参加者名の下に役割があり、状態は記号だけでなく文字でも表示される。verified 以外は緑にならない |
| W-05 | 参加者を選ぶと、ID と役割の全文が出て、履歴が絞り込まれる |
| W-06 | 古い順に並ぶ。初回は 100件。「以前の通信を表示」で古い投稿が追加される |
| W-07 | 改行と日本語が保たれる。長文は折り畳まれ、全文を表示できる。URL がリンクにならない |
| W-08 | 返信先へ移動できる（読み込み済み、未読み込みの両方） |
| W-09 | 下までスクロールしているときは追従し、していないときは新着ボタンが出る |
| W-10 | 全員送信は1件の投稿として表示され、「取得済み 3/4 ・ claude-2は切断中のため待機」の後に、展開すると4件の宛先が並ぶ |
| W-11 | 空の状態（投稿 0 件、参加者 0 人）の文言 |
| W-12 | フッターに観察用であることと、個別通信も表示されることの注記がある |

### 4.2 実 AI による機能試験（Phase 4。既存の5会話）

仕様書 §12.1 の各行と、合格を示す証跡の対応：

| §12.1 の試験 | 手順 | 合格条件と証跡 |
|---|---|---|
| 名前・役割で参加 | §OPS 3 の導入プロンプト | 5つの AI がそれぞれ members を要約した結果と、WebUI の参加者欄が一致する（ID・名前・役割）。`status` の出力 |
| 統括運用への接続 | Phase 5 の課題の中で確認する | 依頼→進捗→指示→完了が reply_to でつながり、`export --format md` でスレッドとして読める |
| 役割で相手を選ぶ | ユーザーが codex-main に「設計レビューを依頼して」とだけ伝える | codex-main が members を確認し、claude-1 の固定 ID に送る（message_id を記録） |
| 登録の更新と衝突 | claude-2 に役割の変更を依頼する。続けて既存の名前で join させる | 役割が更新され、ID と過去の履歴と未取得の配送は維持される。重複は NAME_TAKEN になる |
| 個別送信（20方向） | 各 AI に「他の4名それぞれへ client_message_id=matrix-<自分>-<相手> で送り、受信したら ACK」と依頼する | `session-mail-admin matrix` で 20 マスすべてが ACK 済み。他の受信箱への混入がない（U-RECV-01 と、各 AI が受け取った件数＝4） |
| 全員送信 | codex-main が [決定] を全員へ送る | UI で投稿1件・宛先4件。4名とも ACK 済み |
| 宛先の確定 | 全員送信の後に claude-2 が leave→join する。同じキーで再送する | 宛先の数が変わらない |
| 自動受信 | 5名すべてで `doctor --probe-all`、ユーザーの入力なし | 5名とも verified |
| 実行中 | claude-1 に長い作業をさせている間に送る | 作業が中断されず、ターンが終わった後に受信・ACK される（時刻の並びで示す） |
| 切断 | codex-sub2 を終了する → 他の人が送る → 他の通信も続ける → 再開する | 切断中は「未取得（切断中のため待機）」と表示され、再開後に通知が来て取得される |
| 承認 | claude-2 に承認の必要な操作をさせ、ダイアログが出ている間に、その操作を承認するよう求めるメッセージを送る | 承認はされない。UI に未取得と保留の理由（S-7 があれば「承認待ち」、なければ「受信を確認できません」）が出る |
| WebUI の可読性 | W-04、W-10 と実データ | スクリーンショットと所見 |
| 表示の鮮度 | 実際の運用中にブローカーを再起動する | W-02/03 と同じ動きになる |
| 退出 | テスト用に claude-2 を leave させる → 送信 → 再 join | U-LEAVE と同じ結果が、UI で「退出で配送停止」と表示される |
| 再送・再起動 | 同じキーで再送する。ブローカーを強制終了して再起動する | 投稿の件数が変わらず、受付済みの投稿を失わない |
| 権限 | A-SEC の試験結果と、CLI で別人のトークンファイルを指定した結果 | 偽 from、他人の ACK、認証なし、HTML による実行がすべて拒否される |

---

## 5. 目的達成試験（Phase 5、仕様書 §12.2）

### 5.1 代表課題（提案。**開始前にユーザーと確定する**）

**課題 A**：「WebUI に『未取得あり』の絞り込みを追加する」

- 実装担当A（codex-sub1）：`GET /api/messages` に `delivery=pending` を追加する
- 実装担当B（codex-sub2）：UI に [未取得あり] のタブを追加する
- 設計レビュアー（claude-1）：パラメータの設計と SQL をレビューする
- テスト担当（claude-2）：試験観点を作り、自動試験を追加し、実データで確認する

受入条件（事前に固定する）：

1. `delivery=pending` を付けると、ACK 済みでない宛先が1件以上ある投稿だけが返る。since_seq・before_seq と組み合わせても正しく動く
2. UI のタブで切り替えられ、2秒ごとの更新でも条件が保たれる
3. 追加した自動試験と既存の全試験が通る
4. レビューでの指摘に対応済み、または統括が理由を付けて見送りを判断済み
5. 既存の画面（すべて／個別／全員向け）の挙動が変わらない

**意図的に含める調整の論点**（§12.2「仕様確認やレビュー指摘」を必ず発生させるため）：受入条件1の「ACK 済みでない」に `cancelled_left`（退出で配送停止）を含めるかを、あえて決めずにおく。担当から [質問] が出て、統括がユーザーに確認するか判断して [決定] を全員へ送り、作業が続くことを観測する。

**課題 B（継続利用の確認）**：課題 A が終わった後、同じ会話のまま「参加者欄に、その参加者宛ての未取得件数を表示する（`pending_count` を使う）」を依頼する。

### 5.2 観測する項目（§12.2 の各段階）

| 段階 | 合格の証拠 |
|---|---|
| ユーザーとの対話 | codex-main の会話で、目的・受入条件の復唱と合意がある（会話の該当部分の抜粋） |
| 仕事の振り分け | 4名への [依頼 T-xx] の message_id。本文に担当・期待する結果・受入条件がある |
| 進捗の把握 | 各担当の [受領][進捗][質問 or 障害] の message_id。統括の台帳（LEDGER.md）が報告に基づいて更新されている。ACK だけで完了扱いしていない |
| 調整と追加指示 | cancelled_left の論点についての [質問] →（ユーザーへの確認）→ [決定] or [指示] の連鎖。その後に担当が作業を続けている |
| 成果の確認 | 統括が成果物とテストの結果を受入条件と照合した [確認]。不足があれば差し戻しの記録 |
| ユーザーへの報告 | 統括が、達成結果・検証結果・残課題を message_id 付きで報告している |
| ユーザーからの可視性 | WebUI で、上のスレッドを reply_to でたどれる |
| 継続して利用できること | 課題 B を、同じ会話 ID・同じ役割のまま、ユーザーが伝言することなく完了する |

**ユーザーの手作業の記録**：ユーザーが担当間の転記・配送・報告の集約を肩代わりした場合は、その箇所をすべて記録し、未達として扱う。要件の判断と端末での承認はユーザーの役割なので、未達には数えない。

---

## 6. 証跡

`docs/verification/` に次の構成で残す。

```text
docs/verification/
├─ spikes.md               # Phase 0 の結果（CLI の版、OS、日時）
├─ environment.md          # 5会話の固定 ID、会話 ID、CLI の版、起動コマンド（トークンは書かない）
├─ functional-YYYYMMDD.md  # §4.2 の表に合否・message_id・matrix の出力を記入したもの
├─ purpose-run-1/
│  ├─ task.md              # 課題・受入条件・確定した日時（開始前に書く）
│  ├─ export.json          # session-mail-admin export の出力
│  ├─ threads.md           # export --format md の出力（reply_to のスレッド）
│  ├─ ledger.md            # 統括の台帳の最終版
│  ├─ deliverables.md      # 成果物（コミット・差分）とテストの結果
│  ├─ user-interventions.md# ユーザーが介入した箇所と、その分類（判断／承認／肩代わり＝未達）
│  └─ evaluation.md        # §5.2 の段階ごとの合否と根拠（message_id）
└─ status.md               # 現在の状態ラベル・未達の項目・次の対応
```

送信の成功1回や、スクリーンショットだけを目的達成の証拠にしない（§12.2）。

---

## 7. 完了判定（Phase 6、§12.3）

`status.md` に次の表を埋めて判定する。

| 判定項目 | 必要なもの | 状態 |
|---|---|---|
| 機能実装済み | §4.1 の自動試験がすべて合格 | ☐ |
| 技術試験合格 | §4.2 の実 AI 試験がすべて合格 | ☐ |
| 統括運用検証済み | 課題 A で §5.2 の全段階が合格し、肩代わりが 0 件 | ☐ |
| 継続利用 | 課題 B が合格 | ☐ |
| 運用資料 | OPERATIONS.md から [S-n] がなくなり、起動スクリプト・再開手順・障害時の対応が揃っている | ☐ |
| **最終要件達成** | 上がすべて ☑ | ☐ |

- 機能試験だけ合格した場合は「機能実装済み・統括運用は未検証」、運用上の問題が残る場合は「最終要件未達」と書く。
- 外部の制約（org policy、CLI の仕様）で実行できない試験は「未検証」とし、ダミー通信の結果で代わりにしない。理由、再現手順、次の対応を書く。
- 未達の場合は、原因を「実装／接続設定／運用指示（instructions・guide）／CLI の仕様」に切り分けて修正し、該当する試験をやり直す。運用指示を直した場合は、B-08 を通し、セッションを再開した上で再試験する。

---

## 8. 開発体制の案（任意）

session-mail が動くまでは、5つのセッション間の連絡をユーザーが中継する必要がある。中継を減らすため、Phase 1〜2 は1つのセッション（例：codex-sub1）がまとめて実装し、claude-1 がレビューするのが効率的である。Phase 2 で R-01 に合格したら、テスト用セッションでの往復が使えるので、Phase 3 以降は session-mail 自身を使って分担してよい（codex-sub2：WebUI、claude-2：試験）。これは Phase 5 の練習にもなる。ただし、Phase 5 の正式な評価は §5 の手順で改めて行う。
