# アーキテクチャ（`main` の今の実装）

この文書は、今のコードがどう動くかを書いたものです。食い違いがあればコードが正です（[docs/README.md](README.md) の「どれが正か」を参照）。

## 1. 全体像

```text
 Codex セッション ─┐                                  ┌─ 通知：codex queue --thread <会話ID>
 Claude セッション ─┼─ MCP（stdio）─ ブリッジ ─ HTTP ─┤  ブローカー（1プロセス）
 Pi セッション     ─┤                                  │
 （何人でも）       ┘   src/bridge/   127.0.0.1:47821 │    ・SQLite（node:sqlite）
                                                     │    ・受信箱・配送・通知・接続状態
                                                     └─ WebUI：127.0.0.1:47821 と 0.0.0.0:47822（閲覧専用）
```

| 部品 | 場所 | 役割 |
|---|---|---|
| ブローカー | `src/broker/`（起動は `session-mail-admin serve`） | 認証、メッセージの保存と配送、接続状態、通知、HTTP API、WebUI の配信。DB を開くのはこのプロセスだけ |
| ブリッジ | `src/bridge/main.ts` | 各 AI セッションが stdio で起動する MCP サーバー。8つのツール（ルームの操作3つを含む）を提供し、5秒ごとにハートビートを送る。Claude には Channel 通知を送り、Pi には Pi 拡張機能の受け口に通知を書く |
| Pi 拡張機能 | `integrations/pi/` | Pi に入れる拡張機能（ビルドしない JavaScript）。受け口を開き、ブリッジが書いた通知を `pi.sendMessage` で Pi の会話に入れる。ツールは持たない |
| AI 用 CLI | `src/cli/session-mail.ts` | join・members・send・receive・leave の5つを、トークンファイルを使ってコマンドで実行する（人の確認作業やデバッグ用）。ルームの操作はない |
| 管理用 CLI | `src/cli/admin.ts` | serve / provision / viewer-token / status / probe / export。AI のツールには出さない。ルームは作らない |
| WebUI | `src/web/` | 閲覧専用の画面。上部でルームを選び、そのルームの参加者とメッセージを表示する（選んだルームはブラウザーに覚える）。本文は `textContent` だけで表示する |
| 共通 | `src/shared/` | 設定、入力の検証、ID とトークン、AI に渡す文面、HTTP クライアント |

技術：TypeScript、Node.js 22.13 以上（`node:sqlite` を使う）、`@modelcontextprotocol/sdk` 1.32.2、`zod` 3.25.76。Web フレームワークは使わず、`node:http` で書いています。

## 2. ルームと参加のしかた（識別）

**ルーム**（D-018）：参加者は、ルームの中で動きます。
- ルームは ID だけで識別します（英字・数字・`-`・`.`・`_` の1〜32文字、大文字と小文字は区別する）。
- 参加者は「ルームと ID の組み」で決まります。ルーム A の `dev` とルーム B の `dev` は別の参加者です。内部では参加者ごとの番号（`participants.pid`）で指します。
- 宛先の ID・全員宛て・参加者の一覧・表示名の重複の判定は、ルームの中だけで行います。ルームをまたいだ送信はしません。
- 1つのセッション（ブリッジ）が同時に入れるのは1つのルームだけです。会話の中から参加したブリッジは、`channel_leave` で退出すると参加していない状態に戻り（切断を伝え、キーを捨てる）、別のルームや別の ID に参加し直せます。
- ルームの作成・一覧・削除は、MCP ツール（`channel_room_create`・`channel_rooms`・`channel_room_delete`）から、参加用キーで行います（`/api/join/rooms`）。参加していなくても使えます。
- ルームの一覧には、ルームの ID・作成日時と、参加中（`joined`）の参加者の ID と表示名を返します（切断中も含め、退出済みと登録だけの参加者は含めません）。
- 削除できるのは、参加中（`joined`）の参加者がいないときだけです（切断中も参加中に数え、登録だけの参加者は数えません）。断るときは `ROOM_NOT_EMPTY` です。削除すると、そのルームの参加者・トークン・メッセージ・配送・通知の状態を、外部キーの連動（`ON DELETE CASCADE`）ですべて消します。

**参加**：送信元は、ブローカーが発行した**参加者ごとのトークン**で決まります。AI が入力した値で送信元が決まることはありません。トークンの受け取り方は2通りあります。

| 方法 | 流れ | 使う場面 |
|---|---|---|
| **会話の中から参加**（通常） | ブリッジはトークンなしで起動する → AI が `channel_join` を呼ぶ → ブリッジがデータフォルダーの `tokens/join.key`（参加用キー）を読み、`POST /api/join/self` を呼ぶ → ブローカーが、AI の指定したルームと ID で登録し、トークンを返す。トークンはブリッジのメモリにだけ置く | ふつうの使い方 |
| **トークンファイル** | `session-mail-admin provision --room <ルーム>` で参加者を登録し、`tokens/room-<ルーム>/<id>.json` を作る → 環境変数 `SESSION_MAIL_TOKEN_FILE` でブリッジに渡して起動する | 起動スクリプトで固定したい場合 |

会話の中から参加するときの規則（`Core.selfJoin`）：
- `agent_id`（役割の ID）は必須です。省略すると `INVALID_ARGUMENT` で断り、「ユーザーに尋ねる」よう案内します（D-017）。ブリッジのツール定義でも必須にしています（トークンファイルで起動したブリッジを除く）。
- `room` も必須です。省略すると `INVALID_ARGUMENT`、ないルームなら `ROOM_NOT_FOUND` で断り、どちらも「ルームを自分で作らず、ユーザーに尋ねる」よう案内します。
- Codex は `conversation_id`（`$CODEX_THREAD_ID` の値）が必須で、ないと断ります。会話 ID は、その参加で指定されたものだけを使います（前の値は残しません）。Claude は不要です。
- 以下の判定は、すべて指定したルームの中で行います。
- 指定した `agent_id` が**接続中**なら、`AGENT_IN_USE` で断ります（案内は「別の ID は使わず、ユーザーに確認」）。接続していなければ（切断中・退出済み・未参加）、ハーネスが違っても入れます。そのとき、ハーネス・知らせ方・会話 ID を書き換え、古いトークンを失効させ、自動受信の状態を「未確認」に戻します。未取得のメッセージと統括の役目は、ID に付いたまま引き継がれます。
- 検査・登録・失効・発行は1つのトランザクションで行います。表示名の重複などで断るときは、何も変わりません。参加した時点から、その ID は使用中（接続中）として扱います。
- 参加済みのブリッジで違う `room` や `agent_id` を指定すると、ブリッジが断ります（会話の中から参加した場合は「先に channel_leave する」、トークンファイルの場合は「変えられない」と案内します）。
- `coordinator: true` なら統括として登録し、統括用の運用指示を返します。
- 参加の 8 秒後に、ブローカーが自動受信の確認（probe）を送ります。

ブリッジの接続の扱い：
- ハートビートの間隔は、接続したときにブローカーが返す `heartbeat_interval_ms` を使います。ブローカーへの呼び出しは、10 秒で打ち切ります。
- キーが無効になったとき（401。同じルーム・同じ ID に別のセッションが参加した、ルームが削除された）：会話の中から参加したブリッジは、参加していない状態に戻り、次のツールの結果でその理由を1回伝えます。自動では参加し直しません。トークンファイルのブリッジは通信を止め、作り直すよう案内します。
- 同じトークンファイルのブリッジが、あとからもう1つ接続したとき（古い世代の 409）：前のほうは通信を止め、`SESSION_SUPERSEDED` を返します（取り返しに行くと、互いに接続を奪い合い続けるため）。

ブリッジは、相手が Claude か Codex かを、環境変数 `SESSION_MAIL_PROVIDER`、なければ MCP の接続時に相手が名乗るクライアント名から判断します。Pi（クライアント名 `pi`）は Claude と同じ扱いにします（ブローカーでも `claude` として登録され、WebUI の種類も「Claude」と出ます）。`claude/channel` はどちらにも宣言します（Codex は未知の機能として無視します）。`claude/channel/permission` は宣言しません。承認をメッセージで中継する仕組みは持ちません。

## 3. 状態

参加者には、互いに独立した5種類の状態があります。

| 状態 | 値 | 意味・変わるとき |
|---|---|---|
| 参加（membership） | `provisioned` / `joined` / `left` | provision 直後は provisioned。join で joined。leave で left（未取得の配送は `cancelled_left` になり、再 join しても戻らない）。退出した ID には、同じルームで誰でも参加し直せる |
| 接続（connection） | `online` / `offline` | ブリッジのハートビート（5 秒ごと）が 30 秒以内にあれば online。**メモリで管理**し、ブローカーを再起動すると全員 offline から始まる |
| 自動受信（receiver_state） | `unverified` / `verified` / `failing` / `not_configured` | 通知を出した後に、同じ接続の世代で `channel_receive` が呼ばれたら verified。新しい世代で接続すると unverified に戻る。通知の失敗が3回続くと failing |
| 作業（activity_state） | `unknown` / `awaiting_approval` / `interrupted` | API（`POST /api/agent/activity`）はあるが、**それを呼ぶ Hooks 連携は未実装**。今は常に unknown |
| 配送（deliveries.state） | `pending` / `acked` / `cancelled_left` | 宛先ごとの状態。receive で本文を返した時点で acked（取得済み）になる |

「接続中」は作業中の証拠ではなく、「取得済み」は依頼の完了ではありません。

## 4. メッセージ

- **送信**（`Core.send`）
  - **宛先**：`to` は同じルームの参加者の ID か `"all"` です。全員送信の宛先は、**送信した時点で、そのルームの joined の参加者から自分を除いた全員**で、その場で確定します。後から参加した人には届きません。
  - **重複の防止**：同じ送信者が同じ `client_message_id` で送った場合、内容が同じなら最初の結果を返します（`duplicate: true`）。内容が違えば `IDEMPOTENCY_CONFLICT` です。
  - **返信**：`reply_to` には、自分が送信者か宛先として関わったメッセージだけを指定できます。
  - **保存**：投稿と宛先ごとの配送は、1つのトランザクションで保存します（`PRAGMA synchronous = FULL`）。
- **受信**（`Core.receive`）：自分宛ての pending を古い順に返します（既定 10 件、最大 50 件）。返した時点で、その配送を `acked`（取得済み）にします。別の ACK の操作はありません（D-016）。そのため、同じメッセージが二度返ることはありません。受け取った直後に AI のセッションが落ちると、そのメッセージは取得済みのまま残ります。応答には、まだ返していない件数（`remaining`）と最新の参加者一覧を含めます。
- **入力の制限**（`src/shared/validation.ts`）
  - 表示名：1〜40 文字。前後の空白を除き、NFC に正規化します。英字の大文字・小文字を区別せずに重複を判定します。制御文字は使えません。
  - 役割：1〜200 文字。改行は使えません。
  - 本文：1〜20,000 文字。
  - `client_message_id`：`[A-Za-z0-9._:-]{1,64}`。
  - 参加者の ID：`[a-z][a-z0-9-]{0,31}`。`all` は使えません。
  - ルームの ID：`[A-Za-z0-9._-]{1,32}`。大文字と小文字は区別します。
  - HTTP の本文：JSON のオブジェクトだけを受け付けます（`null` や配列は 400）。

## 5. 通知（`src/broker/notifier.ts`）

通知は「未取得がある」ことだけを伝え、本文は含めません。本文は必ず `channel_receive` で取ります。1 秒ごとに次の判定をします。

1. 通知しない場合：通知処理の途中、相手が offline、または `awaiting_approval` のとき。
2. 通知する理由：
   - **reconnect**：未取得がある状態で接続し直したとき
   - **new**：受信されていない通知がなく、まだ一度も受信されていない新着があり、最新の新着から 2 秒たったとき（複数の新着を1回の通知にまとめる）
   - **renotify**（Claude だけ）：通知が受信されないまま、5 分 → 15 分 → 30 分（以後 30 分ごと）たったとき
   - **retry**（Codex・Claude とも）：前の通知が失敗し（`codex queue` の失敗、Channel の書き込みの失敗）、未取得が残っているとき。30 秒 → 2 分 → 10 分（以後 10 分ごと）の間隔で送り直す（`notify.retry_after_failure_ms`）。失敗が3回続くと、自動受信は「失敗」になる
3. **Codex には時間ごとの再通知をしない**：`codex queue` は Codex 側に保存され、アイドルになれば必ず処理されるためです。重ねると、余分なターンが走ります。ただし、`codex queue` そのものが失敗したときは、retry で送り直します。
4. 直前の 8 秒以内にツールを使っていた Codex には、新着の通知を少し待ちます。ターンの中で自分で受信することが多いためです。
5. 届け方：
   - Codex：`codex queue --thread <会話ID> --message <通知文>` を、shell を介さずに実行します（30 秒で打ち切り）。
   - Claude：次のハートビートの応答に載せ、ブリッジが `notifications/claude/channel` を送ります。
   - Pi：Claude と同じく、次のハートビートの応答に載せます。ブリッジは Channel の代わりに、Pi 拡張機能の受け口に1行（`{"content":"<通知文>"}`）書きます。受け口の場所は Pi のプロセス番号で決まります（Linux・Mac は `<OS の一時フォルダー>/catchball-pi-<番号>.sock`、Windows は `\\.\pipe\catchball-pi-<番号>`。ブリッジは親のプロセス番号を使う）。拡張機能は、`pi.sendMessage` を `triggerTurn: true`・`deliverAs: "followUp"` で呼びます。待機中ならすぐ、作業中なら作業がすべて終わってから処理されます。書けなければ、通知の失敗として記録します（受け口がない・拡張機能が入っていない、など）。再通知と送り直しは Claude と同じです。

通知文（`noticeText`）には、受信・返信の最小限の手順を入れています。Codex では MCP の説明文（instructions）がツールの説明としてしか渡らず、運用指示を守らないことがあったためです（[DECISIONS.md](DECISIONS.md) の D-008）。

## 6. HTTP API（`src/broker/http.ts`）

待ち受けは2つです。

| 待ち受け | 載せている API |
|---|---|
| `127.0.0.1:47821`（この PC のみ） | すべての API と WebUI |
| `0.0.0.0:47822`（`ui.lan` が true のとき、同じネットワークへ） | WebUI と閲覧用の API（`/api/ui/*`（ルームの一覧の閲覧を含む）、`/api/health`、`/api/members`、`/api/messages*`）だけ。それ以外は 404 |

| 対象 | 認証 | API |
|---|---|---|
| 参加・ルーム | `Bearer <参加用キー>` | `POST /api/join/self`、`POST /api/join/rooms`・`GET /api/join/rooms`・`DELETE /api/join/rooms/:room` |
| AI | `Bearer <参加者のトークン>` | `POST /api/agent/connect`・`heartbeat`・`disconnect`・`activity`・`join`・`send`・`receive`・`leave`、`GET /api/agent/members` |
| WebUI | Cookie `sm_ui`（ログインで発行、7 日間有効） | `POST /api/ui/login`・`logout`、`GET /api/health`・`ui/rooms`・`members?room=`・`messages?room=`・`messages/:id`（`members` と `messages` はルームの指定が必須） |
| 管理 | `Bearer <admin.token>` | `POST /api/admin/probe`・`provision`、`GET /api/admin/status`・`export` |

`GET /api/messages` の取得のしかた：
- `limit`：既定 100、最大 200
- `before_seq`：これより古い分を取る（「以前の通信を表示」）
- `since_seq`：増分を取る。全体の変更連番 `updated_seq` を使うので、取得による更新も取りこぼしません
- 絞り込み：`participant`、`kind`、`q`

エラーの形は `{ "error": { "code", "message", "hint", "details" } }` です。

## 6-2. WebUI（`src/web/`）

- 素の JavaScript で、ビルドせずにそのまま配信します。
- 右上でルームを選び、そのルームの参加者とメッセージを表示します。選んだルームはブラウザー（`localStorage`）に覚えます。ルームが1つもないときや、見ていたルームが削除されたときは、そう表示します。
- 2 秒ごとに、ルームの一覧・参加者・メッセージの増分（`since_seq`）を取り直します。このとき、操作中の入力欄や選択欄は作り直しません。ルームや絞り込みを変えたあとに届いた、前の条件の応答は捨てます。ログイン画面の間は、取り直しを止めます。
- 作成・削除などの操作はありません（閲覧専用）。
- `export` で書き出した JSON を `window.__SM_SNAPSHOT__` に入れたページを作ると、その記録を表示できます（`demo/webui-demo.html`）。

## 7. セキュリティ

- **Host の検証**
  - 47821：`127.0.0.1` か `localhost` だけを受け付けます。
  - 47822：IP アドレス、この PC の名前（`<名前>` と `<名前>.local`）、`ui.allowed_hosts` に書いた名前だけを受け付けます（DNS リバインディング対策）。それ以外は 421 を返します。
- **Origin の検証**
  - AI・管理・参加の API：ブラウザーから来たもの（Origin ヘッダーがあるもの）は拒否します。
  - WebUI の API：自分のページのオリジンだけを認めます。POST では Origin を必須にします。
- **WebUI のログイン**：viewer トークンが必要です。送信元ごとに失敗を数え、10 分で 10 回失敗したら 10 分間止めます。Cookie は HttpOnly、SameSite=Strict で、7 日間有効です。ログアウトすると、サーバー側でもそのセッションを無効にします。ルームは閲覧の境目ではなく、ログインすれば全ルームを見られます。
- **WebUI の表示**：CSP で外部のスクリプトを禁止し、本文は `textContent` だけで表示します（自動試験で `innerHTML` を使っていないことを確認しています）。
- **秘密の保存**：トークンは SHA-256 のハッシュだけを DB に保存します。トークンファイルは 0600 で作ります。ログに本文とトークンは書きません。
- **前提と限界**
  - 同じ OS ユーザーで動くプロセス（シェルを使える AI を含む）は、参加用キーやトークンファイルを読めます。この設計が防ぐのは、**ツールの API を通じたなりすまし**です。
  - LAN 側（47822）は暗号化していない HTTP です。信頼できるネットワークで使う前提です。
  - WebUI では、AI 同士の個別のやり取りもすべて見えます（仕様どおりです）。
  - Pi 拡張機能の受け口は、OS の一時フォルダーの Unix ソケット（Windows は名前付きパイプ）で、ネットワークには出ません。流れるのは本文のない通知文だけです。複数のユーザーが使う Linux では、ほかのユーザーが先に同じ名前の受け口を作ると、通知が届かなくなるか、通知文が渡ることがあります（1人で使う PC が前提）。

## 8. データと設定

**データフォルダー**（`SESSION_MAIL_HOME` で変更できます）

| OS | 既定の場所 |
|---|---|
| Windows | `%LOCALAPPDATA%\session-mail` |
| macOS | `~/Library/Application Support/session-mail` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/session-mail` |

```text
config.json          設定（なければ既定値）
session-mail-v2.db   SQLite（WAL）。ルームを入れた版から新しいファイル。前の版の session-mail.db は読まずに残す
broker.lock          多重起動の防止（pid。pid が生きていて、しかもポートが応答するときだけ「稼働中」とみなす）
tokens/admin.token   管理用（serve が初回、または新しい DB を作ったときに作る）
tokens/viewer.token  WebUI のログイン用（serve が初回、または新しい DB を作ったときに作る）
tokens/join.key      会話の中から参加するときの参加用キー（serve が初回に作る）
tokens/room-<ルーム>/<id>.json  provision で作るトークンファイル（版 2。フォルダー名では、大文字を「!＋小文字」、ドットを「~」に置き換える。大文字と小文字を区別しないファイルシステムでも、ルームごとに分けるため）
logs/broker.log      ブローカーのログ
```

**config.json の項目と既定値**（起動時に型と範囲を確かめ、誤りがあれば項目の名前を書いて止まります）

| 項目 | 既定値 | 意味 |
|---|---|---|
| `port` | 47821 | この PC 用の待ち受け |
| `ui.lan` / `ui.port` / `ui.allowed_hosts` | true / 47822 / [] | WebUI を LAN に公開するか、そのポート、Host として許可する名前 |
| `heartbeat_interval_ms` / `offline_after_ms` | 5000 / 30000 | ハートビートの間隔と、切断と判定するまでの時間 |
| `notify.debounce_ms` | 2000 | 新着をまとめる待ち時間 |
| `notify.claude_renotify_backoff_ms` | [300000, 900000, 1800000] | Claude への再通知の間隔 |
| `notify.retry_after_failure_ms` | [30000, 120000, 600000] | 通知に失敗したあと、送り直すまでの間隔 |
| `notify.codex_quiet_after_tool_ms` | 8000 | ツールを使った直後の Codex への通知を待つ時間 |
| `notify.attention_after_ms` | 600000 | 通知の後、受信がなければ「要確認」にするまでの時間 |
| `notify.failing_after_consecutive_failures` | 3 | 自動受信を「失敗」とするまでの連続失敗回数 |
| `codex.command` / `codex.queue_timeout_ms` | ["codex"] / 30000 | codex の実行方法（Windows では codex.exe のフルパスを書く）と打ち切り時間 |
| `limits.*` | 20000 / 10 / 50 / 262144 | 本文の文字数、receive の既定件数と最大件数、HTTP 本文の最大バイト数 |

## 9. 試験

`npm test` で、ビルドしてから `test/main.test.mjs` の 29 件を実行します。最初に1つのブローカーを起動し、試験どうしでそのデータを使い回すので、試験の順番に意味があります。最後の1件は、`docs/MCP_TOOLS.md` が実際のツールと必須の引数をすべて説明しているかを確かめます。一時フォルダーでブローカーを起動し、HTTP と MCP（stdio）から仕様の規則を確かめます。本物の `codex` の代わりに、受け取った引数を記録するだけの `test/fake-codex.mjs` を使います。
