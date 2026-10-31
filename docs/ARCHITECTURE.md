# アーキテクチャ（v1.0.0-alpha.1 時点の実装）

この文書は、今のコードがどう動くかを書いたものです。食い違いがあればコードが正です（[docs/README.md](README.md) の「どれが正か」を参照）。

## 1. 全体像

```text
 Codex セッション ─┐                                  ┌─ 通知：codex queue --thread <会話ID>
 Claude セッション ─┼─ MCP（stdio）─ ブリッジ ─ HTTP ─┤  ブローカー（1プロセス）
 （何人でも）       ┘   src/bridge/   127.0.0.1:47821 │    ・SQLite（node:sqlite）
                                                     │    ・受信箱・配送・通知・接続状態
                                                     └─ WebUI：127.0.0.1:47821 と 0.0.0.0:47822（閲覧専用）
```

| 部品 | 場所 | 役割 |
|---|---|---|
| ブローカー | `src/broker/`（起動は `session-mail-admin serve`） | 認証、メッセージの保存と配送、接続状態、通知、HTTP API、WebUI の配信。DB を開くのはこのプロセスだけ |
| ブリッジ | `src/bridge/main.ts` | 各 AI セッションが stdio で起動する MCP サーバー。6つのツールを提供し、5秒ごとにハートビートを送る。Claude には Channel 通知を送る |
| AI 用 CLI | `src/cli/session-mail.ts` | ブリッジと同じ6操作を、コマンドで実行する（人の確認作業やデバッグ用） |
| 管理用 CLI | `src/cli/admin.ts` | serve / provision / viewer-token / status / probe / export。AI のツールには出さない |
| WebUI | `src/web/` | 閲覧専用の画面。本文は `textContent` だけで表示する |
| 共通 | `src/shared/` | 設定、入力の検証、ID とトークン、AI に渡す文面、HTTP クライアント |

技術：TypeScript、Node.js 22.13 以上（`node:sqlite` を使う）、`@modelcontextprotocol/sdk` 1.32.2、`zod` 3.25.76。Web フレームワークは使わず、`node:http` で書いています。

## 2. 参加のしかた（識別）

送信元は、ブローカーが発行した**参加者ごとのトークン**で決まります。AI が入力した値で送信元が決まることはありません。トークンの受け取り方は2通りあります。

| 方法 | 流れ | 使う場面 |
|---|---|---|
| **会話の中から参加**（通常） | ブリッジはトークンなしで起動する → AI が `channel_join` を呼ぶ → ブリッジがデータフォルダーの `tokens/join.key`（参加用キー）を読み、`POST /api/join/self` を呼ぶ → ブローカーが固定 ID を割り当て、トークンを返す。トークンはブリッジのメモリにだけ置く | ふつうの使い方 |
| **トークンファイル** | `session-mail-admin provision` で参加者を登録し、`tokens/<id>.json` を作る → 環境変数 `SESSION_MAIL_TOKEN_FILE` でブリッジに渡して起動する | 起動スクリプトで固定したい場合 |

会話の中から参加するときの規則（`Core.selfJoin`）：
- `agent_id` を省略すると、`codex-1`、`claude-2` のように空いている番号を割り当てます。
- 指定した `agent_id` が**接続中**なら、`AGENT_IN_USE` で断ります。接続していなければ、古いトークンを失効させて引き継ぎます。
- Codex は `conversation_id`（`$CODEX_THREAD_ID` の値）が必要です。ないと自動受信は「未準備」になります。Claude は不要です。
- `coordinator: true` なら統括として登録し、統括用の運用指示を返します。
- 参加の 8 秒後に、ブローカーが自動受信の確認（probe）を送ります。

ブリッジは、相手が Claude か Codex かを、環境変数 `SESSION_MAIL_PROVIDER`、なければ MCP の接続時に相手が名乗るクライアント名から判断します。`claude/channel` はどちらにも宣言します（Codex は未知の機能として無視します）。`claude/channel/permission` は宣言しません。承認をメッセージで中継する仕組みは持ちません。

## 3. 状態

参加者には、互いに独立した5種類の状態があります。

| 状態 | 値 | 意味・変わるとき |
|---|---|---|
| 参加（membership） | `provisioned` / `joined` / `left` | provision 直後は provisioned。join で joined。leave で left（未取得の配送は `cancelled_left` になり、再 join しても戻らない） |
| 接続（connection） | `online` / `offline` | ブリッジのハートビート（5 秒ごと）が 30 秒以内にあれば online。**メモリで管理**し、ブローカーを再起動すると全員 offline から始まる |
| 自動受信（receiver_state） | `unverified` / `verified` / `failing` / `not_configured` | 通知を出した後に、同じ接続の世代で `channel_receive` が呼ばれたら verified。新しい世代で接続すると unverified に戻る。通知の失敗が3回続くと failing |
| 作業（activity_state） | `unknown` / `awaiting_approval` / `interrupted` | API（`POST /api/agent/activity`）はあるが、**それを呼ぶ Hooks 連携は未実装**。今は常に unknown |
| 配送（deliveries.state） | `pending` / `acked` / `cancelled_left` | 宛先ごとの状態。receive で本文を返しても pending のまま（ACK で acked） |

「接続中」は作業中の証拠ではなく、「取得済み（ACK）」は依頼の完了ではありません。

## 4. メッセージ

- **送信**（`Core.send`）
  - **宛先**：`to` は固定 ID か `"all"` です。全員送信の宛先は、**送信した時点の joined の参加者から自分を除いた全員**で、その場で確定します。後から参加した人には届きません。
  - **重複の防止**：同じ送信者が同じ `client_message_id` で送った場合、内容が同じなら最初の結果を返します（`duplicate: true`）。内容が違えば `IDEMPOTENCY_CONFLICT` です。
  - **返信**：`reply_to` には、自分が送信者か宛先として関わったメッセージだけを指定できます。
  - **保存**：投稿と宛先ごとの配送は、1つのトランザクションで保存します（`PRAGMA synchronous = FULL`）。
- **受信**（`Core.receive`）：自分宛ての pending を古い順に返します（既定 10 件、最大 50 件）。応答には、残りの件数（`remaining`）と最新の参加者一覧を含めます。`receive_count` が 2 以上なら、同じメッセージを再取得しています。
- **ACK**：自分宛ての配送だけに効きます。他人宛ての ID は `NOT_FOUND` を返します。何度送っても同じ結果になります。
- **入力の制限**（`src/shared/validation.ts`）
  - 表示名：1〜40 文字。前後の空白を除き、NFC に正規化します。英字の大文字・小文字を区別せずに重複を判定します。制御文字は使えません。
  - 役割：1〜200 文字。改行は使えません。
  - 本文：1〜20,000 文字。
  - `client_message_id`：`[A-Za-z0-9._:-]{1,64}`。
  - 固定 ID：`[a-z][a-z0-9-]{0,31}`。`all` は使えません。

## 5. 通知（`src/broker/notifier.ts`）

通知は「未取得がある」ことだけを伝え、本文は含めません。本文は必ず `channel_receive` で取ります。1 秒ごとに次の判定をします。

1. 通知しない場合：通知処理の途中、相手が offline、または `awaiting_approval` のとき。
2. 通知する理由：
   - **reconnect**：未取得がある状態で接続し直したとき
   - **new**：受信されていない通知がなく、まだ一度も受信されていない新着があり、最新の新着から 2 秒たったとき（複数の新着を1回の通知にまとめる）
   - **renotify**（Claude だけ）：通知が受信されないまま、5 分 → 15 分 → 30 分（以後 30 分ごと）たったとき
3. **Codex には時間ごとの再通知をしない**：`codex queue` は Codex 側に保存され、アイドルになれば必ず処理されるためです。重ねると、余分なターンが走ります。
4. 直前の 8 秒以内にツールを使っていた Codex には、新着の通知を少し待ちます。ターンの中で自分で受信することが多いためです。
5. 届け方：
   - Codex：`codex queue --thread <会話ID> --message <通知文>` を、shell を介さずに実行します（30 秒で打ち切り）。
   - Claude：次のハートビートの応答に載せ、ブリッジが `notifications/claude/channel` を送ります。

通知文（`noticeText`）には、受信・ACK・返信の最小限の手順を入れています。Codex では MCP の説明文（instructions）がツールの説明としてしか渡らず、運用指示を守らないことがあったためです（[DECISIONS.md](DECISIONS.md) の D-008）。

## 6. HTTP API（`src/broker/http.ts`）

待ち受けは2つです。

| 待ち受け | 載せている API |
|---|---|
| `127.0.0.1:47821`（この PC のみ） | すべての API と WebUI |
| `0.0.0.0:47822`（`ui.lan` が true のとき、同じネットワークへ） | WebUI と閲覧用の API（`/api/ui/*`、`/api/health`、`/api/members`、`/api/messages*`）だけ。それ以外は 404 |

| 対象 | 認証 | API |
|---|---|---|
| 参加 | `Bearer <参加用キー>` | `POST /api/join/self` |
| AI | `Bearer <参加者のトークン>` | `POST /api/agent/connect`・`heartbeat`・`disconnect`・`activity`・`join`・`send`・`receive`・`ack`・`leave`、`GET /api/agent/members` |
| WebUI | Cookie `sm_ui`（ログインで発行、7 日間有効） | `POST /api/ui/login`・`logout`、`GET /api/health`・`members`・`messages`・`messages/:id` |
| 管理 | `Bearer <admin.token>` | `POST /api/admin/probe`・`provision`、`GET /api/admin/status`・`export` |

`GET /api/messages` の取得のしかた：
- `limit`：既定 100、最大 200
- `before_seq`：これより古い分を取る（「以前の通信を表示」）
- `since_seq`：増分を取る。全体の変更連番 `updated_seq` を使うので、ACK による更新も取りこぼしません
- 絞り込み：`participant`、`kind`、`q`

エラーの形は `{ "error": { "code", "message", "hint", "details" } }` です。

## 7. セキュリティ

- **Host の検証**
  - 47821：`127.0.0.1` か `localhost` だけを受け付けます。
  - 47822：IP アドレス、この PC の名前（`<名前>` と `<名前>.local`）、`ui.allowed_hosts` に書いた名前だけを受け付けます（DNS リバインディング対策）。それ以外は 421 を返します。
- **Origin の検証**
  - AI・管理・参加の API：ブラウザーから来たもの（Origin ヘッダーがあるもの）は拒否します。
  - WebUI の API：自分のページのオリジンだけを認めます。POST では Origin を必須にします。
- **WebUI のログイン**：viewer トークンが必要です。送信元ごとに失敗を数え、10 分で 10 回失敗したら 10 分間止めます。Cookie は HttpOnly、SameSite=Strict です。
- **WebUI の表示**：CSP で外部のスクリプトを禁止し、本文は `textContent` だけで表示します（自動試験で `innerHTML` を使っていないことを確認しています）。
- **秘密の保存**：トークンは SHA-256 のハッシュだけを DB に保存します。トークンファイルは 0600 で作ります。ログに本文とトークンは書きません。
- **前提と限界**
  - 同じ OS ユーザーで動くプロセス（シェルを使える AI を含む）は、参加用キーやトークンファイルを読めます。この設計が防ぐのは、**ツールの API を通じたなりすまし**です。
  - LAN 側（47822）は暗号化していない HTTP です。信頼できるネットワークで使う前提です。
  - WebUI では、AI 同士の個別のやり取りもすべて見えます（仕様どおりです）。

## 8. データと設定

**データフォルダー**（`SESSION_MAIL_HOME` で変更できます）

| OS | 既定の場所 |
|---|---|
| Windows | `%LOCALAPPDATA%\session-mail` |
| macOS | `~/Library/Application Support/session-mail` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/session-mail` |

```text
config.json          設定（なければ既定値）
session-mail.db      SQLite（WAL）
broker.lock          多重起動の防止（pid）
tokens/admin.token   管理用（serve が初回に作る）
tokens/viewer.token  WebUI のログイン用（serve が初回に作る）
tokens/join.key      会話の中から参加するときの参加用キー（serve が初回に作る）
tokens/<id>.json     provision で作るトークンファイル
logs/broker.log      ブローカーのログ
```

**config.json の項目と既定値**

| 項目 | 既定値 | 意味 |
|---|---|---|
| `port` | 47821 | この PC 用の待ち受け |
| `ui.lan` / `ui.port` / `ui.allowed_hosts` | true / 47822 / [] | WebUI を LAN に公開するか、そのポート、Host として許可する名前 |
| `channel_id` | `dev` | チャンネル名（今は1つだけ） |
| `heartbeat_interval_ms` / `offline_after_ms` | 5000 / 30000 | ハートビートの間隔と、切断と判定するまでの時間 |
| `notify.debounce_ms` | 2000 | 新着をまとめる待ち時間 |
| `notify.claude_renotify_backoff_ms` | [300000, 900000, 1800000] | Claude への再通知の間隔 |
| `notify.codex_quiet_after_tool_ms` | 8000 | ツールを使った直後の Codex への通知を待つ時間 |
| `notify.attention_after_ms` | 600000 | 通知の後、受信がなければ「要確認」にするまでの時間 |
| `notify.failing_after_consecutive_failures` | 3 | 自動受信を「失敗」とするまでの連続失敗回数 |
| `codex.command` / `codex.queue_timeout_ms` | ["codex"] / 30000 | codex の実行方法（Windows では codex.exe のフルパスを書く）と打ち切り時間 |
| `limits.*` | 20000 / 10 / 50 / 262144 | 本文の文字数、receive の既定件数と最大件数、HTTP 本文の最大バイト数 |

## 9. 試験

`npm test` で、ビルドしてから `test/main.test.mjs` の 10 件を実行します。一時フォルダーでブローカーを起動し、HTTP と MCP（stdio）から仕様の規則を確かめます。本物の `codex` の代わりに、受け取った引数を記録するだけの `test/fake-codex.mjs` を使います。
