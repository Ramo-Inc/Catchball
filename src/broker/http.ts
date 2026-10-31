// HTTP API と WebUI の配信（DESIGN §5）
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Core } from './core.js';
import { Notifier } from './notifier.js';
import { ApiError } from '../shared/validation.js';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const UI_SESSION_TTL = 7 * 24 * 3600 * 1000;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; body: any; token?: string; cookie?: string };

// local：この PC だけで待ち受け、すべての API を持つ。lan：同じネットワークの別 PC 向けで、WebUI の閲覧に必要なものだけを持つ
export type Surface = 'local' | 'lan';

// LAN 側で受け付ける Host 名。IP アドレス・この PC の名前・設定で許可した名前だけ（DNS リバインディング対策）
export function lanHostAllowed(hostHeader: string, port: number, extra: string[]): boolean {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:]+):(\d+)$/.exec(hostHeader);
  if (!m || Number(m[2]) !== port) return false;
  const name = m[1].replace(/^\[|\]$/g, '').toLowerCase();
  const me = hostname().toLowerCase();
  return isIP(name) !== 0 || name === 'localhost' || name === me || name === `${me}.local` || extra.map(h => h.toLowerCase()).includes(name);
}

const isUiRoute = (method: string, path: string) =>
  path.startsWith('/api/ui/') || (method === 'GET' && (path === '/api/health' || path === '/api/members' || path.startsWith('/api/messages')));

export function createBroker(core: Core, notifier: Notifier, log: (s: string) => void = () => {}, surface: Surface = 'local'): Server {
  const port = surface === 'local' ? core.cfg.port : core.cfg.ui.port;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const hostOk = (h: string) => surface === 'local' ? allowedHosts.has(h) : lanHostAllowed(h, port, core.cfg.ui.allowed_hosts);
  // LAN 側の Origin は、開いているページ自身（http://<Host>）だけを認める
  const originOk = (o: string, h: string) => surface === 'local' ? allowedOrigins.has(o) : o === `http://${h}`;
  // ログインの総当たり対策：送信元ごとに失敗を数え、10 分で 10 回失敗したら 10 分間止める
  const failures = new Map<string, { n: number; since: number }>();

  const agent = (c: Ctx) => {
    const a = core.agentFromToken(c.token);
    core.lastToolAt.set(a.agent_id, core.now());
    return a;
  };
  const ui = (c: Ctx) => core.verify(c.cookie, 'ui_session');
  const admin = (c: Ctx) => core.verify(c.token, 'admin');

  const routes: Record<string, (c: Ctx, m: RegExpMatchArray) => unknown> = {
    // ---- AI 向け ----
    'POST /api/agent/connect': c => core.connect(core.agentFromToken(c.token), c.body),
    'POST /api/agent/heartbeat': c => {
      const a = core.agentFromToken(c.token);
      core.heartbeat(a, c.body.generation);
      for (const r of Array.isArray(c.body.notify_results) ? c.body.notify_results : []) {
        notifier.record(a.agent_id, String(r.notify_id), null, r.result === 'written' ? 'written' : 'error', r.error ?? null);
      }
      const notify = notifier.pendingChannel.get(a.agent_id) ?? null;
      notifier.pendingChannel.delete(a.agent_id);
      return { ok: true, notify };
    },
    'POST /api/agent/disconnect': c => { core.disconnect(core.agentFromToken(c.token), c.body.generation); return { ok: true }; },
    'POST /api/agent/activity': c => { core.setActivity(core.agentFromToken(c.token), c.body.state); return { ok: true }; },
    'POST /api/agent/join': c => core.join(agent(c), c.body.display_name, c.body.role),
    'GET /api/agent/members': c => { const a = agent(c); return { channel_id: core.cfg.channel_id, self_id: a.agent_id, members: core.members(a.agent_id) }; },
    'POST /api/agent/send': c => core.send(agent(c), c.body),
    'POST /api/agent/receive': c => core.receive(agent(c), c.body.limit),
    'POST /api/agent/ack': c => core.ack(agent(c), c.body.message_ids),
    'POST /api/agent/leave': c => {
      if (c.body.confirm !== true) throw new ApiError('INVALID_ARGUMENT', 400, '退出するには confirm: true を指定してください。');
      return core.leave(agent(c));
    },

    // ---- WebUI 向け ----
    'POST /api/ui/login': async c => {
      const ip = c.req.socket.remoteAddress ?? '?';
      const f = failures.get(ip);
      if (f && core.now() - f.since > 600000) failures.delete(ip);
      if ((failures.get(ip)?.n ?? 0) >= 10) throw new ApiError('TOO_MANY_ATTEMPTS', 429, 'ログインの失敗が続いたため、10 分間ログインできません。');
      try { core.verify(String(c.body.token ?? '').trim(), 'viewer'); }
      catch {
        const cur = failures.get(ip) ?? { n: 0, since: core.now() };
        failures.set(ip, { n: cur.n + 1, since: cur.since });
        await new Promise(r => setTimeout(r, 800));
        throw new ApiError('UNAUTHENTICATED', 401, 'トークンが正しくありません。session-mail-admin viewer-token で確認してください。');
      }
      failures.delete(ip);
      const s = core.createCredential('ui_session', null, UI_SESSION_TTL);
      c.res.setHeader('Set-Cookie', `sm_ui=${s}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${UI_SESSION_TTL / 1000}`);
      return { ok: true };
    },
    'POST /api/ui/logout': c => { c.res.setHeader('Set-Cookie', 'sm_ui=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return { ok: true }; },
    'GET /api/health': c => { ui(c); return { ok: true, now: core.now(), max_seq: core.maxSeq() }; },
    'GET /api/members': c => { ui(c); return { channel_id: core.cfg.channel_id, now: core.now(), members: core.members(null, true) }; },
    'GET /api/messages': c => {
      ui(c);
      const g = (k: string) => c.url.searchParams.get(k);
      return core.listMessages({ limit: g('limit'), before_seq: g('before_seq'), since_seq: g('since_seq'), participant: g('participant'), kind: g('kind'), q: g('q') });
    },
    'GET /api/messages/:id': (c, m) => { ui(c); return core.getMessage(m[1]); },

    // ---- 管理者向け ----
    'POST /api/admin/probe': async c => { admin(c); return notifier.probe(String(c.body.agent_id)); },
    'POST /api/admin/provision': c => {
      admin(c);
      const b = c.body;
      if (!['codex', 'claude'].includes(b.provider) || !['coordinator', 'worker'].includes(b.duty) || typeof b.conversation !== 'string' || !b.conversation) {
        throw new ApiError('INVALID_ARGUMENT', 400, 'provider・duty・conversation を正しく指定してください。');
      }
      return { token: core.provision({ agent: b.agent, provider: b.provider, conversation: b.conversation, duty: b.duty, rotate: b.rotate === true }) };
    },
    'GET /api/admin/status': c => {
      admin(c);
      return { members: core.members(null, true), notify: core.db.all('SELECT * FROM notify_state ORDER BY agent_id') };
    },
    'GET /api/admin/export': c => {
      admin(c);
      const f = c.url.searchParams.get('from'), t = c.url.searchParams.get('to');
      return core.export(f ? Date.parse(f) : 0, t ? Date.parse(t) : undefined);
    },
  };

  function match(method: string, path: string): [(c: Ctx, m: RegExpMatchArray) => unknown, RegExpMatchArray] | null {
    for (const [key, fn] of Object.entries(routes)) {
      const [mth, pattern] = key.split(' ');
      if (mth !== method) continue;
      const re = new RegExp('^' + pattern.replace(/:id/g, '(m_[0-9A-Z]{26})') + '$');
      const m = path.match(re);
      if (m) return [fn, m];
    }
    return null;
  }

  function sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(JSON.stringify(data));
  }

  function serveStatic(res: ServerResponse, path: string): boolean {
    const files: Record<string, [string, string]> = {
      '/': ['index.html', 'text/html; charset=utf-8'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
      '/app.css': ['app.css', 'text/css; charset=utf-8'],
    };
    const f = files[path];
    if (!f || !existsSync(join(WEB_DIR, f[0]))) return false;
    res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(readFileSync(join(WEB_DIR, f[0])));
    return true;
  }

  return createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let status = 200;
    try {
      const host = req.headers.host ?? '';
      if (!hostOk(host)) {
        status = 421;
        return sendJson(res, 421, { error: { code: 'FORBIDDEN', message: 'Host が許可されていません。', hint: surface === 'lan' ? 'IP アドレスか PC 名で開くか、config.json の ui.allowed_hosts に名前を追加してください。' : undefined } });
      }
      const origin = req.headers.origin;
      const isAgentApi = url.pathname.startsWith('/api/agent/') || url.pathname.startsWith('/api/admin/');
      if (origin && (isAgentApi || !originOk(origin, host))) throw new ApiError('FORBIDDEN', 403, 'このオリジンからは利用できません。');
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        if (serveStatic(res, url.pathname)) return;
        throw new ApiError('NOT_FOUND', 404, '見つかりません。');
      }
      // LAN 側には AI 用・管理用の API を置かない（存在しないものとして扱う）
      if (surface === 'lan' && !isUiRoute(req.method ?? 'GET', url.pathname)) throw new ApiError('NOT_FOUND', 404, 'API が見つかりません。');
      const hit = match(req.method ?? 'GET', url.pathname);
      if (!hit) throw new ApiError('NOT_FOUND', 404, 'API が見つかりません。');
      let body: any = {};
      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 415, 'Content-Type は application/json にしてください。');
        if (!isAgentApi && !origin) throw new ApiError('FORBIDDEN', 403, 'Origin ヘッダーが必要です。');
        body = await readBody(req, core.cfg.limits.http_body_max_bytes);
      }
      const auth = String(req.headers.authorization ?? '');
      const cookie = /(?:^|;\s*)sm_ui=([^;]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
      const ctx: Ctx = { req, res, url, body, token: auth.startsWith('Bearer ') ? auth.slice(7) : undefined, cookie };
      sendJson(res, 200, await hit[0](ctx, hit[1]));
    } catch (e) {
      if (e instanceof ApiError) {
        status = e.status;
        sendJson(res, e.status, { error: { code: e.code, message: e.message, hint: e.hint, details: e.details } });
      } else {
        status = 500;
        log(`internal error ${req.method} ${url.pathname}: ${(e as Error).stack}`);
        sendJson(res, 500, { error: { code: 'INTERNAL', message: '内部エラーが発生しました。', hint: '少し待って、同じ client_message_id で再送してください。' } });
      }
    } finally {
      if (!url.pathname.endsWith('/heartbeat') || status !== 200) log(`${req.method} ${url.pathname} ${status} ${Date.now() - started}ms`);
    }
  });
}

async function readBody(req: IncomingMessage, max: number): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new ApiError('PAYLOAD_TOO_LARGE', 413, 'リクエストが大きすぎます。');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return text ? JSON.parse(text) : {}; } catch { throw new ApiError('INVALID_ARGUMENT', 400, 'JSON の形式が正しくありません。'); }
}
