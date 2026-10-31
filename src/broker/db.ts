// SQLite（Node 組み込みの node:sqlite）。DB を開くのはブローカーと provision だけ
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS seq_counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
INSERT OR IGNORE INTO seq_counter VALUES (1, 0);

CREATE TABLE IF NOT EXISTS participants (
  agent_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL DEFAULT 'dev',
  provider TEXT NOT NULL CHECK (provider IN ('codex','claude')),
  duty TEXT NOT NULL DEFAULT 'worker' CHECK (duty IN ('coordinator','worker')),
  conversation_id TEXT NOT NULL,
  display_name TEXT, display_name_key TEXT, role TEXT,
  membership TEXT NOT NULL DEFAULT 'provisioned' CHECK (membership IN ('provisioned','joined','left')),
  joined_at INTEGER, left_at INTEGER, profile_updated_at INTEGER,
  conn_generation INTEGER NOT NULL DEFAULT 0,
  conn_state TEXT NOT NULL DEFAULT 'offline' CHECK (conn_state IN ('online','offline')),
  connected_at INTEGER, last_seen_at INTEGER, disconnected_at INTEGER, bridge_info TEXT,
  receiver_kind TEXT NOT NULL CHECK (receiver_kind IN ('codex_queue','claude_channel')),
  receiver_state TEXT NOT NULL DEFAULT 'unverified' CHECK (receiver_state IN ('not_configured','unverified','verified','failing')),
  receiver_detail TEXT, receiver_verified_generation INTEGER,
  activity_state TEXT NOT NULL DEFAULT 'unknown' CHECK (activity_state IN ('unknown','awaiting_approval','interrupted')),
  activity_updated_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK (membership = 'provisioned' OR (display_name IS NOT NULL AND role IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_participants_joined_name ON participants (channel_id, display_name_key) WHERE membership = 'joined';

CREATE TABLE IF NOT EXISTS credentials (
  credential_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('agent','viewer','admin','ui_session')),
  agent_id TEXT REFERENCES participants (agent_id),
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER, revoked_reason TEXT,
  CHECK ((kind = 'agent') = (agent_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  sender_id TEXT NOT NULL REFERENCES participants (agent_id),
  sender_display_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('direct','broadcast')),
  to_spec TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to TEXT REFERENCES messages (message_id),
  client_message_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  recipient_count INTEGER NOT NULL CHECK (recipient_count >= 1),
  ext_json TEXT,
  created_at INTEGER NOT NULL,
  created_seq INTEGER NOT NULL UNIQUE,
  updated_seq INTEGER NOT NULL,
  UNIQUE (sender_id, client_message_id)
);
CREATE INDEX IF NOT EXISTS ix_messages_updated_seq ON messages (updated_seq);
CREATE INDEX IF NOT EXISTS ix_messages_reply_to ON messages (reply_to);

CREATE TABLE IF NOT EXISTS deliveries (
  message_id TEXT NOT NULL REFERENCES messages (message_id),
  recipient_id TEXT NOT NULL REFERENCES participants (agent_id),
  recipient_display_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','acked','cancelled_left')),
  first_received_at INTEGER, last_received_at INTEGER, receive_count INTEGER NOT NULL DEFAULT 0,
  acked_at INTEGER, cancelled_at INTEGER,
  notify_count INTEGER NOT NULL DEFAULT 0, last_notify_at INTEGER, last_notify_result TEXT,
  created_seq INTEGER NOT NULL,
  PRIMARY KEY (message_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS ix_deliveries_inbox ON deliveries (recipient_id, state, created_seq);

CREATE TABLE IF NOT EXISTS notify_state (
  agent_id TEXT PRIMARY KEY REFERENCES participants (agent_id),
  known_seq INTEGER NOT NULL DEFAULT 0,
  outstanding_notify_id TEXT, outstanding_since INTEGER, outstanding_generation INTEGER,
  last_notify_at INTEGER, last_notify_reason TEXT, last_notify_result TEXT, last_notify_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  renotify_streak INTEGER NOT NULL DEFAULT 0,
  force_on_connect INTEGER NOT NULL DEFAULT 0,
  last_receive_at INTEGER
);
`;

export type Row = Record<string, any>;

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.raw.exec(SCHEMA);
    if (!this.get('SELECT version FROM schema_version')) this.run('INSERT INTO schema_version VALUES (1)');
  }

  get(sql: string, ...p: any[]): Row | undefined { return this.raw.prepare(sql).get(...p) as Row | undefined; }
  all(sql: string, ...p: any[]): Row[] { return this.raw.prepare(sql).all(...p) as Row[]; }
  run(sql: string, ...p: any[]) { return this.raw.prepare(sql).run(...p); }

  // 書き込みトランザクション（IMMEDIATE）。例外なら ROLLBACK
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }

  nextSeq(): number {
    return (this.get('UPDATE seq_counter SET value = value + 1 WHERE id = 1 RETURNING value') as Row).value as number;
  }

  close(): void { this.raw.close(); }
}
