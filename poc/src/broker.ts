// PoC ブローカー：メモリ上だけで送信・受信・ACK と通知を扱う。すべてのイベントを logs/events.jsonl に記録する。
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PORT, NOTIFY_DEBOUNCE_MS, OFFLINE_AFTER_MS, USER_TEST_SENDER, Provider, notifyText,
} from './common.js';

const PORT = Number(process.env.POC_PORT ?? DEFAULT_PORT);
const CODEX_BIN = process.env.POC_CODEX_BIN ?? 'codex';
// codex の前に付ける引数（JSON 配列）。例：POC_CODEX_BIN=node、POC_CODEX_PREFIX_ARGS='["C:/.../codex.js"]'
const CODEX_PREFIX_ARGS: string[] = process.env.POC_CODEX_PREFIX_ARGS ? JSON.parse(process.env.POC_CODEX_PREFIX_ARGS) : [];
const QUEUE_TIMEOUT_MS = Number(process.env.POC_QUEUE_TIMEOUT_MS ?? 30000);
const LOG_DIR = process.env.POC_LOG_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const LOG_FILE = join(LOG_DIR, 'events.jsonl');
const WEB_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html');

interface Agent {
  id: string;
  provider: Provider;
  thread: string;
  generation: number;
  lastSeen: number | null;
  offlineLogged: boolean;        // offline の記録を重複させないため
  // 通知制御
  outstanding: boolean;          // 通知したが、まだ receive が来ていない
  inflight: boolean;             // codex queue の実行中
  forceNotify: boolean;          // 再接続時に未取得があれば通知する
  pendingChannel: { notify_id: string; content: string; meta: Record<string, string> } | null;
  lastNotify: { notify_id: string; at: number; result: string; duration_ms?: number; error?: string } | null;
}

interface Message {
  message_id: string;
  from: string;
  to: string;
  body: string;
  reply_to: string | null;
  created_at: number;
  received_count: number;
  acked_at: number | null;
}

const agents = new Map<string, Agent>();
const messages: Message[] = [];
const events: Record<string, unknown>[] = [];

mkdirSync(LOG_DIR, { recursive: true });

function log(type: string, fields: Record<string, unknown> = {}): void {
  const ev = { t: Date.now(), iso: new Date().toISOString(), type, ...fields };
  events.push(ev);
  appendFileSync(LOG_FILE, JSON.stringify(ev) + '\n');
  process.stdout.write(`${ev.iso} ${type} ${JSON.stringify(fields)}\n`);
}

const isOnline = (a: Agent, now = Date.now()) => a.lastSeen !== null && now - a.lastSeen <= OFFLINE_AFTER_MS;
const pendingFor = (id: string) => messages.filter(m => m.to === id && m.acked_at === null);

// ---- 通知 ------------------------------------------------------------------

function evaluateNotify(a: Agent): void {
  if (a.inflight || !isOnline(a)) return;
  const pending = pendingFor(a.id);
  if (pending.length === 0) return;
  if (a.outstanding && !a.forceNotify) return;          // 通知を重ねない（再通知もしない）
  // 新着の判定は「まだ一度も受信されていないもの」だけで行う。受信済み・ACK待ちのものでは通知しない
  const fresh = pending.filter(m => m.received_count === 0);
  if (!a.forceNotify && fresh.length === 0) return;
  const newest = Math.max(...(a.forceNotify ? pending : fresh).map(m => m.created_at));
  if (!a.forceNotify && Date.now() - newest < NOTIFY_DEBOUNCE_MS) return;
  dispatch(a, pending.length, a.forceNotify ? 'reconnect' : 'new');
}

function dispatch(a: Agent, unread: number, reason: string): void {
  const notify_id = 'n_' + randomUUID().slice(0, 8);
  const content = notifyText(unread);
  a.outstanding = true;
  a.forceNotify = false;
  log('notify_start', { agent: a.id, provider: a.provider, notify_id, unread, reason });

  if (a.provider === 'claude') {
    a.pendingChannel = { notify_id, content, meta: { kind: 'mail_notice', notify_id, unread: String(unread) } };
    a.lastNotify = { notify_id, at: Date.now(), result: 'handed_to_bridge' };
    log('notify_end', { agent: a.id, notify_id, result: 'handed_to_bridge' });
    return;
  }

  a.inflight = true;
  const started = Date.now();
  execFile(
    CODEX_BIN,
    [...CODEX_PREFIX_ARGS, 'queue', '--thread', a.thread, '--message', content],
    { timeout: QUEUE_TIMEOUT_MS, windowsHide: true, shell: false },
    (err, _stdout, stderr) => {
      const duration_ms = Date.now() - started;
      a.inflight = false;
      const exitCode = err ? ((err as NodeJS.ErrnoException & { code?: unknown }).code ?? 'error') : 0;
      const result = err ? 'failed' : 'queued_ok';
      const error = err ? `${err.message}`.slice(0, 300) + (stderr ? ` | stderr: ${String(stderr).slice(0, 300)}` : '') : undefined;
      if (err) a.outstanding = false;                     // 失敗したら次の新着で再挑戦できるようにする
      a.lastNotify = { notify_id, at: started, result, duration_ms, error };
      log('notify_end', { agent: a.id, notify_id, result, duration_ms, exit_code: exitCode, error });
    },
  );
}

setInterval(() => {
  const now = Date.now();
  for (const a of agents.values()) {
    if (a.lastSeen !== null && now - a.lastSeen > OFFLINE_AFTER_MS && !a.offlineLogged) {
      a.offlineLogged = true;
      log('offline', { agent: a.id, last_seen_ago_ms: now - a.lastSeen });
    }
    evaluateNotify(a);
  }
}, 1000).unref();

// ---- HTTP ------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function requireAgent(id: unknown, res: ServerResponse): Agent | null {
  const a = typeof id === 'string' ? agents.get(id) : undefined;
  if (!a) {
    send(res, 404, { error: `未登録のエージェントです: ${String(id)}（cli.js register で登録してください）` });
    return null;
  }
  return a;
}

const routes: Record<string, (body: any, res: ServerResponse, url: URL) => void> = {
  'POST /register': (b, res) => {
    if (typeof b.agent !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(b.agent)) return send(res, 400, { error: 'agent が不正です' });
    if (b.provider !== 'codex' && b.provider !== 'claude') return send(res, 400, { error: 'provider は codex か claude です' });
    if (typeof b.thread !== 'string' || !b.thread) return send(res, 400, { error: 'thread（会話 ID）が必要です' });
    const prev = agents.get(b.agent);
    agents.set(b.agent, {
      id: b.agent, provider: b.provider, thread: b.thread,
      generation: prev?.generation ?? 0, lastSeen: prev?.lastSeen ?? null, offlineLogged: false,
      outstanding: false, inflight: false, forceNotify: false, pendingChannel: null, lastNotify: null,
    });
    log('register', { agent: b.agent, provider: b.provider, thread: b.thread });
    send(res, 200, { ok: true });
  },

  'POST /connect': (b, res) => {
    const a = requireAgent(b.agent, res); if (!a) return;
    a.generation += 1;
    a.lastSeen = Date.now();
    a.offlineLogged = false;
    a.outstanding = false;
    a.pendingChannel = null;
    if (pendingFor(a.id).length > 0) a.forceNotify = true;
    log('connect', { agent: a.id, generation: a.generation, provider_reported: b.provider, pid: b.pid });
    if (b.provider && b.provider !== a.provider) log('provider_mismatch', { agent: a.id, registered: a.provider, reported: b.provider });
    send(res, 200, { agent: a.id, provider: a.provider, generation: a.generation });
  },

  'POST /heartbeat': (b, res) => {
    const a = requireAgent(b.agent, res); if (!a) return;
    if (b.generation !== a.generation) return send(res, 409, { error: 'STALE_GENERATION', generation: a.generation });
    const now = Date.now();
    if (a.lastSeen !== null && now - a.lastSeen > 10000) log('heartbeat_gap', { agent: a.id, gap_ms: now - a.lastSeen });
    if (a.offlineLogged) {
      a.offlineLogged = false;
      if (pendingFor(a.id).length > 0) a.forceNotify = true;
      log('online_again', { agent: a.id });
    }
    a.lastSeen = now;
    for (const r of Array.isArray(b.results) ? b.results : []) {
      log('bridge_written', { agent: a.id, notify_id: r.notify_id, result: r.result, error: r.error });
      if (a.lastNotify && a.lastNotify.notify_id === r.notify_id) a.lastNotify.result = r.result;
    }
    const notify = a.pendingChannel;
    a.pendingChannel = null;
    send(res, 200, { ok: true, notify });
  },

  'POST /disconnect': (b, res) => {
    const a = requireAgent(b.agent, res); if (!a) return;
    if (b.generation === a.generation) {
      a.lastSeen = null;
      log('disconnect', { agent: a.id, generation: a.generation });
    }
    send(res, 200, { ok: true });
  },

  'POST /send': (b, res) => {
    const from = b.from;
    if (from !== USER_TEST_SENDER && !agents.has(from)) return send(res, 404, { error: `未登録の送信者です: ${from}` });
    if (!agents.has(b.to)) return send(res, 404, { error: `未登録の宛先です: ${b.to}。登録済み: ${[...agents.keys()].join(', ')}` });
    if (b.to === from) return send(res, 400, { error: '自分自身には送信できません' });
    if (typeof b.body !== 'string' || !b.body.trim()) return send(res, 400, { error: 'body が空です' });
    if (b.reply_to != null && !messages.some(m => m.message_id === b.reply_to)) return send(res, 400, { error: `reply_to が見つかりません: ${b.reply_to}` });
    const m: Message = {
      message_id: 'm_' + randomUUID().slice(0, 8), from, to: b.to, body: b.body,
      reply_to: b.reply_to ?? null, created_at: Date.now(), received_count: 0, acked_at: null,
    };
    messages.push(m);
    log('send', { message_id: m.message_id, from, to: m.to, reply_to: m.reply_to, via: b.via ?? 'api', body_head: m.body.slice(0, 60) });
    send(res, 200, { message_id: m.message_id, to: m.to, recipient_online: isOnline(agents.get(m.to)!) });
  },

  'POST /receive': (b, res) => {
    const a = requireAgent(b.agent, res); if (!a) return;
    const pending = pendingFor(a.id);
    for (const m of pending) m.received_count += 1;
    a.outstanding = false;
    log('receive', { agent: a.id, count: pending.length, message_ids: pending.map(m => m.message_id), via: b.via ?? 'api' });
    send(res, 200, {
      messages: pending.map(m => ({
        message_id: m.message_id, from: m.from, reply_to: m.reply_to,
        created_at: new Date(m.created_at).toISOString(), receive_count: m.received_count, body: m.body,
      })),
    });
  },

  'POST /ack': (b, res) => {
    const a = requireAgent(b.agent, res); if (!a) return;
    const ids: string[] = Array.isArray(b.message_ids) ? b.message_ids : [];
    const results = ids.map(id => {
      const m = messages.find(x => x.message_id === id && x.to === a.id);
      if (!m) return { message_id: id, error: 'NOT_FOUND' };
      const already = m.acked_at !== null;
      if (!already) m.acked_at = Date.now();
      return { message_id: id, state: 'acked', already };
    });
    log('ack', { agent: a.id, results, via: b.via ?? 'api' });
    send(res, 200, { results });
  },

  'POST /whoami': (b, res) => {
    const a = requireAgent(b.agent, res); if (!a) return;
    log('whoami', { agent: a.id, generation: a.generation });
    send(res, 200, { agent_id: a.id, provider: a.provider, generation: a.generation });
  },

  'GET /status': (_b, res) => {
    const now = Date.now();
    send(res, 200, {
      now: new Date(now).toISOString(),
      codex_bin: CODEX_BIN,
      agents: [...agents.values()].map(a => ({
        agent: a.id, provider: a.provider, thread: a.thread, generation: a.generation,
        connected: isOnline(a, now), last_seen_ago_s: a.lastSeen === null ? null : Math.round((now - a.lastSeen) / 1000),
        pending: pendingFor(a.id).length, outstanding: a.outstanding, last_notify: a.lastNotify,
      })),
    });
  },

  // WebUI 用：参加者と、全メッセージ（配送状態つき）をまとめて返す
  'GET /api/view': (_b, res) => {
    const now = Date.now();
    send(res, 200, {
      now,
      agents: [...agents.values()].map(a => ({
        agent: a.id, provider: a.provider, connected: isOnline(a, now), pending: pendingFor(a.id).length,
      })),
      messages: messages.map(m => ({
        message_id: m.message_id, from: m.from, to: m.to, body: m.body, reply_to: m.reply_to,
        created_at: m.created_at, received_count: m.received_count, acked_at: m.acked_at,
      })),
    });
  },

  'GET /log': (_b, res, url) => {
    const since = Number(url.searchParams.get('since_ms') ?? 0);
    send(res, 200, { events: events.filter(e => (e.t as number) >= since) });
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  if (req.method === 'GET' && url.pathname === '/') {
    // web/index.html は本文だけの断片なので、文書の骨組みを付けて返す
    const page = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<style>body{margin:0}[hidden]{display:none!important}</style></head><body>' + readFileSync(WEB_FILE, 'utf8') + '</body></html>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(page);
  }
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { error: 'not found' });
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    handler(body, res, url);
  } catch (e) {
    send(res, 400, { error: String((e as Error).message) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log('broker_start', { port: PORT, codex_bin: CODEX_BIN, codex_prefix_args: CODEX_PREFIX_ARGS, log_file: LOG_FILE });
  process.stdout.write(`listening 127.0.0.1:${PORT}\n`);
});
