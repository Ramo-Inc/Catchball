// データフォルダー、設定（config.json）、トークンファイル
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Provider = 'codex' | 'claude';
export type Duty = 'coordinator' | 'worker';

export function dataDir(): string {
  if (process.env.SESSION_MAIL_HOME) return process.env.SESSION_MAIL_HOME;
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'session-mail');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'session-mail');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'session-mail');
}

export function ensureDataDir(): string {
  const d = dataDir();
  mkdirSync(join(d, 'tokens'), { recursive: true, mode: 0o700 });
  mkdirSync(join(d, 'logs'), { recursive: true, mode: 0o700 });
  return d;
}

export interface Config {
  port: number;
  // WebUI（閲覧専用）を同じネットワーク内の別 PC に公開する設定。AI 用・管理用の API は常にこの PC のみ
  ui: { lan: boolean; port: number; allowed_hosts: string[] };
  heartbeat_interval_ms: number;
  offline_after_ms: number;
  notify: {
    debounce_ms: number;
    claude_renotify_backoff_ms: number[];
    retry_after_failure_ms: number[];        // 通知に失敗したあと、送り直すまでの間隔（失敗が続くたびに次の値へ。最後の値で止まる）
    codex_quiet_after_tool_ms: number;      // 直前にツールを使っていた Codex には少し待ってから通知する
    attention_after_ms: number;
    failing_after_consecutive_failures: number;
  };
  codex: { command: string[]; queue_timeout_ms: number };
  limits: { body_max_chars: number; receive_default: number; receive_max: number; http_body_max_bytes: number };
}

export const DEFAULT_CONFIG: Config = {
  port: 47821,
  ui: { lan: true, port: 47822, allowed_hosts: [] },
  heartbeat_interval_ms: 5000,
  offline_after_ms: 30000,
  notify: {
    debounce_ms: 2000,
    claude_renotify_backoff_ms: [300000, 900000, 1800000],
    retry_after_failure_ms: [30000, 120000, 600000],
    codex_quiet_after_tool_ms: 8000,
    attention_after_ms: 600000,
    failing_after_consecutive_failures: 3,
  },
  codex: { command: ['codex'], queue_timeout_ms: 30000 },
  limits: { body_max_chars: 20000, receive_default: 10, receive_max: 50, http_body_max_bytes: 262144 },
};

export function loadConfig(): Config {
  const p = join(dataDir(), 'config.json');
  if (!existsSync(p)) return structuredClone(DEFAULT_CONFIG);
  const user = JSON.parse(readFileSync(p, 'utf8'));
  const cfg: Config = {
    ...DEFAULT_CONFIG, ...user,
    ui: { ...DEFAULT_CONFIG.ui, ...(user.ui ?? {}) },
    notify: { ...DEFAULT_CONFIG.notify, ...(user.notify ?? {}) },
    codex: { ...DEFAULT_CONFIG.codex, ...(user.codex ?? {}) },
    limits: { ...DEFAULT_CONFIG.limits, ...(user.limits ?? {}) },
  };
  checkConfig(cfg, p);
  return cfg;
}

// 設定の型と範囲を確かめる。誤りがあれば、どの項目かを書いて止める（黙って変な動きをしないように）
function checkConfig(c: Config, path: string): void {
  const bad = (key: string, want: string) => { throw new Error(`${path} の ${key} が正しくありません（${want}）。`); };
  const num = (key: string, v: unknown, min = 0) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min) bad(key, `${min} 以上の数`); };
  const port = (key: string, v: unknown) => { if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 65535) bad(key, '1〜65535 の整数'); };
  const nums = (key: string, v: unknown) => { if (!Array.isArray(v) || v.length === 0) bad(key, '数を1つ以上並べた配列'); for (const x of v as unknown[]) num(key, x); };
  port('port', c.port);
  port('ui.port', c.ui.port);
  if (typeof c.ui.lan !== 'boolean') bad('ui.lan', 'true か false');
  if (!Array.isArray(c.ui.allowed_hosts) || !c.ui.allowed_hosts.every(h => typeof h === 'string')) bad('ui.allowed_hosts', '文字列の配列');
  num('heartbeat_interval_ms', c.heartbeat_interval_ms, 1000);
  num('offline_after_ms', c.offline_after_ms, 1000);
  if (c.offline_after_ms <= c.heartbeat_interval_ms) bad('offline_after_ms', 'heartbeat_interval_ms より大きい数');
  num('notify.debounce_ms', c.notify.debounce_ms);
  nums('notify.claude_renotify_backoff_ms', c.notify.claude_renotify_backoff_ms);
  nums('notify.retry_after_failure_ms', c.notify.retry_after_failure_ms);
  num('notify.codex_quiet_after_tool_ms', c.notify.codex_quiet_after_tool_ms);
  num('notify.attention_after_ms', c.notify.attention_after_ms);
  num('notify.failing_after_consecutive_failures', c.notify.failing_after_consecutive_failures, 1);
  if (!Array.isArray(c.codex.command) || c.codex.command.length === 0 || !c.codex.command.every(x => typeof x === 'string' && x)) {
    bad('codex.command', '["codex"] のような、文字列を1つ以上並べた配列');
  }
  num('codex.queue_timeout_ms', c.codex.queue_timeout_ms, 1);
  num('limits.body_max_chars', c.limits.body_max_chars, 1);
  num('limits.receive_default', c.limits.receive_default, 1);
  num('limits.receive_max', c.limits.receive_max, 1);
  num('limits.http_body_max_bytes', c.limits.http_body_max_bytes, 1);
}

// トークンファイル（provision が作る）。版 2 からルームを持つ。版 1 は新しい DB では使えないので読まない
export interface TokenFile {
  version: 2;
  broker_url: string;
  room: string;
  agent_id: string;
  provider: Provider;
  duty: Duty;
  token: string;
}

export function readTokenFile(path: string | undefined): TokenFile | null {
  if (!path || !existsSync(path)) return null;
  const tf = JSON.parse(readFileSync(path, 'utf8'));
  if (tf.version !== 2 || typeof tf.room !== 'string') {
    throw new Error(`トークンファイル ${path} は古い形式です（ルームがありません）。session-mail-admin provision --room で作り直してください。`);
  }
  return tf as TokenFile;
}
