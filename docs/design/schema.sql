-- session-mail MVP スキーマ（SQLite 3.35 以上。RETURNING と部分インデックスを使用）
-- 接続ごとに必ず設定する PRAGMA（migrate.ts が毎回実行する）:
--   PRAGMA journal_mode = WAL;
--   PRAGMA synchronous = FULL;     -- 「受付済み」を返す前にディスクへ確定させる
--   PRAGMA foreign_keys = ON;
--   PRAGMA busy_timeout = 5000;
-- 時刻はすべて UNIX エポックのミリ秒（INTEGER）で保存する。

CREATE TABLE schema_version (
  version INTEGER NOT NULL
);
INSERT INTO schema_version VALUES (1);

-- 全体で単調増加する変更連番。messages.updated_seq が WebUI 増分取得のカーソルになる。
CREATE TABLE seq_counter (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL
);
INSERT INTO seq_counter VALUES (1, 0);

------------------------------------------------------------------------------
-- participants：参加者（固定 ID）。provision で作成し、join で名前と役割が入る
------------------------------------------------------------------------------
CREATE TABLE participants (
  agent_id          TEXT PRIMARY KEY
                    CHECK (length(agent_id) BETWEEN 1 AND 32
                           AND agent_id GLOB '[a-z]*'
                           AND agent_id NOT GLOB '*[^a-z0-9-]*'
                           AND agent_id <> 'all'),
  channel_id        TEXT NOT NULL DEFAULT 'dev',
  provider          TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
  duty              TEXT NOT NULL DEFAULT 'worker' CHECK (duty IN ('coordinator', 'worker')),
                    -- duty は渡す運用指示の種類を選ぶためだけに使う。権限には使わない
  conversation_id   TEXT NOT NULL,          -- Codex のスレッド UUID または Claude のセッション ID
  display_name      TEXT,                   -- join するまでは NULL
  display_name_key  TEXT,                   -- NFC 正規化し、英字 A-Z だけを小文字化したもの
  role              TEXT,
  membership        TEXT NOT NULL DEFAULT 'provisioned'
                    CHECK (membership IN ('provisioned', 'joined', 'left')),
  joined_at         INTEGER,
  left_at           INTEGER,
  profile_updated_at INTEGER,

  -- 接続（参加状態とは別に管理する）
  conn_generation   INTEGER NOT NULL DEFAULT 0,
  conn_state        TEXT NOT NULL DEFAULT 'offline' CHECK (conn_state IN ('online', 'offline')),
  connected_at      INTEGER,
  last_seen_at      INTEGER,
  disconnected_at   INTEGER,
  bridge_info       TEXT,                   -- JSON: {"version":"0.1.0","pid":1234}

  -- 自動受信の準備状況
  receiver_kind     TEXT NOT NULL CHECK (receiver_kind IN ('codex_queue', 'claude_channel')),
  receiver_state    TEXT NOT NULL DEFAULT 'unverified'
                    CHECK (receiver_state IN ('not_configured', 'unverified', 'verified', 'failing')),
  receiver_detail   TEXT,
  receiver_verified_generation INTEGER,

  -- 作業状態。観測できないときは unknown（推測で埋めない）
  activity_state    TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (activity_state IN ('unknown', 'awaiting_approval')),
  activity_updated_at INTEGER,

  created_at        INTEGER NOT NULL,

  CHECK (membership = 'provisioned' OR (display_name IS NOT NULL AND role IS NOT NULL))
);

-- 参加中の参加者だけで表示名の一意性を保証する（left・provisioned の名前は再利用できる）
CREATE UNIQUE INDEX ux_participants_joined_name
  ON participants (channel_id, display_name_key)
  WHERE membership = 'joined';

------------------------------------------------------------------------------
-- credentials：資格情報。生のトークンは保存しない
-- トークンの形式：sm1.<credential_id>.<secret>（secret は 32 バイトの乱数を base64url にしたもの）
------------------------------------------------------------------------------
CREATE TABLE credentials (
  credential_id  TEXT PRIMARY KEY,                 -- 'c_' + ULID
  kind           TEXT NOT NULL CHECK (kind IN ('agent', 'viewer', 'admin', 'ui_session')),
  agent_id       TEXT REFERENCES participants (agent_id),
  secret_hash    TEXT NOT NULL,                    -- sha256(secret) の hex。比較は timingSafeEqual
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER,                          -- ui_session だけが持つ
  revoked_at     INTEGER,
  revoked_reason TEXT,
  CHECK ((kind = 'agent') = (agent_id IS NOT NULL))
);
CREATE INDEX ix_credentials_agent ON credentials (agent_id) WHERE revoked_at IS NULL;

------------------------------------------------------------------------------
-- messages：投稿。全員送信でも 1 行
------------------------------------------------------------------------------
CREATE TABLE messages (
  message_id          TEXT PRIMARY KEY,            -- 'm_' + ULID
  channel_id          TEXT NOT NULL,
  sender_id           TEXT NOT NULL REFERENCES participants (agent_id),
  sender_display_name TEXT NOT NULL,               -- 送信時の表示名（後から変えない）
  kind                TEXT NOT NULL CHECK (kind IN ('direct', 'broadcast')),
  to_spec             TEXT NOT NULL,               -- 個別送信なら宛先の agent_id、全員送信なら 'all'
  body                TEXT NOT NULL,
  reply_to            TEXT REFERENCES messages (message_id),
  client_message_id   TEXT NOT NULL,
  request_hash        TEXT NOT NULL,               -- sha256(JSON [to, body, reply_to|null])
  recipient_count     INTEGER NOT NULL CHECK (recipient_count >= 1),
  ext_json            TEXT,                        -- 将来のタスク ID・報告種別用に予約。MVP では常に NULL
  created_at          INTEGER NOT NULL,
  created_seq         INTEGER NOT NULL UNIQUE,     -- 表示順（古い順）とページングに使う
  updated_seq         INTEGER NOT NULL,            -- 投稿自体か、その配送のどれかが変わるたびに更新する
  UNIQUE (sender_id, client_message_id)
);
CREATE INDEX ix_messages_updated_seq ON messages (updated_seq);
CREATE INDEX ix_messages_sender      ON messages (sender_id, created_seq);
CREATE INDEX ix_messages_reply_to    ON messages (reply_to);

------------------------------------------------------------------------------
-- deliveries：宛先ごとの配送。宛先の集合は送信時に確定し、後から増減させない
------------------------------------------------------------------------------
CREATE TABLE deliveries (
  message_id             TEXT NOT NULL REFERENCES messages (message_id),
  recipient_id           TEXT NOT NULL REFERENCES participants (agent_id),
  recipient_display_name TEXT NOT NULL,            -- 送信時の表示名
  state                  TEXT NOT NULL DEFAULT 'pending'
                         CHECK (state IN ('pending', 'acked', 'cancelled_left')),
  first_received_at      INTEGER,                  -- receive で本文を最初に返した時刻（ACK ではない）
  last_received_at       INTEGER,
  receive_count          INTEGER NOT NULL DEFAULT 0,
  acked_at               INTEGER,
  cancelled_at           INTEGER,
  notify_count           INTEGER NOT NULL DEFAULT 0,
  last_notify_at         INTEGER,
  last_notify_result     TEXT CHECK (last_notify_result IN ('queued_ok', 'written', 'handed_to_bridge', 'failed', 'unknown')),
  created_seq            INTEGER NOT NULL,
  PRIMARY KEY (message_id, recipient_id)
);
-- 注記：SQLite の CHECK 制約は他のテーブルを参照できないため、「送信者自身への配送を作らない」条件は
--       アプリ側（messaging.ts）で保証し、単体テスト U-SEND-04 で検証する。
CREATE INDEX ix_deliveries_inbox ON deliveries (recipient_id, state, created_seq);

------------------------------------------------------------------------------
-- notify_state：宛先ごとの通知制御（deliveries 領域の補助テーブル）
------------------------------------------------------------------------------
CREATE TABLE notify_state (
  agent_id               TEXT PRIMARY KEY REFERENCES participants (agent_id),
  known_seq              INTEGER NOT NULL DEFAULT 0, -- この宛先へ通知済み、または本人が取得済みの最大 created_seq
  outstanding_notify_id  TEXT,                       -- 通知を出したが、まだ receive が来ていないもの
  outstanding_since      INTEGER,
  outstanding_generation INTEGER,
  last_notify_at         INTEGER,
  last_notify_reason     TEXT CHECK (last_notify_reason IN ('new', 'reconnect', 'renotify', 'probe')),
  last_notify_result     TEXT CHECK (last_notify_result IN ('queued_ok', 'written', 'handed_to_bridge', 'failed', 'unknown')),
  last_notify_error      TEXT,                       -- 最大 500 文字。本文と秘密情報は含めない
  consecutive_failures   INTEGER NOT NULL DEFAULT 0,
  renotify_streak        INTEGER NOT NULL DEFAULT 0,
  force_on_connect       INTEGER NOT NULL DEFAULT 0 CHECK (force_on_connect IN (0, 1)),
  last_receive_at        INTEGER
);
