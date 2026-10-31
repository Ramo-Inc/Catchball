// データディレクトリ、設定、トークンファイル（DESIGN §3.5、§8）
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
  channel_id: string;
  heartbeat_interval_ms: number;
  offline_after_ms: number;
  notify: {
    debounce_ms: number;
    claude_renotify_backoff_ms: number[];
    codex_quiet_after_tool_ms: number;      // PoC R2：直前にツールを使っていた Codex には少し待ってから通知する
    attention_after_ms: number;
    failing_after_consecutive_failures: number;
  };
  codex: { command: string[]; queue_timeout_ms: number };
  limits: { body_max_chars: number; receive_default: number; receive_max: number; http_body_max_bytes: number };
}

export const DEFAULT_CONFIG: Config = {
  port: 47821,
  channel_id: 'dev',
  heartbeat_interval_ms: 5000,
  offline_after_ms: 30000,
  notify: {
    debounce_ms: 2000,
    claude_renotify_backoff_ms: [300000, 900000, 1800000],
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
  return {
    ...DEFAULT_CONFIG, ...user,
    notify: { ...DEFAULT_CONFIG.notify, ...(user.notify ?? {}) },
    codex: { ...DEFAULT_CONFIG.codex, ...(user.codex ?? {}) },
    limits: { ...DEFAULT_CONFIG.limits, ...(user.limits ?? {}) },
  };
}

export interface TokenFile {
  version: 1;
  broker_url: string;
  agent_id: string;
  provider: Provider;
  duty: Duty;
  token: string;
}

export function readTokenFile(path: string | undefined): TokenFile | null {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as TokenFile;
}
