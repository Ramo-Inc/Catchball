// 本実装の自動試験：一時ディレクトリでブローカーを起動し、HTTP と MCP（stdio）から仕様の規則を確かめる
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'sm-test-'));
const PORT = 48100 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const UI_PORT = PORT + 1000;
const FAKE_LOG = join(HOME, 'fake-codex.log');
const env = { ...process.env, SESSION_MAIL_HOME: HOME, FAKE_CODEX_LOG: FAKE_LOG };
writeFileSync(join(HOME, 'config.json'), JSON.stringify({ port: PORT, ui: { lan: true, port: UI_PORT, allowed_hosts: ['monitor.example'] }, codex: { command: [process.execPath, join(ROOT, 'test/fake-codex.mjs')] }, notify: { codex_quiet_after_tool_ms: 0 } }));

const admin = (...a) => execFileSync(process.execPath, ['--no-warnings', join(ROOT, 'dist/cli/admin.js'), ...a], { env, encoding: 'utf8' });
const tok = id => JSON.parse(readFileSync(join(HOME, 'tokens', `${id}.json`), 'utf8')).token;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, label) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } throw new Error('タイムアウト: ' + label); }

async function req(method, path, { token, body, origin, cookie, host } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  if (host) headers.host = host;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const A = (id, path, body) => req(body === undefined ? 'GET' : 'POST', '/api/agent/' + path, { token: tok(id), body });
const queueCalls = () => existsSync(FAKE_LOG) ? readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

let broker;
const clients = [];
before(async () => {
  admin('provision', '--agent', 'main', '--provider', 'codex', '--conversation', 'T-MAIN', '--duty', 'coordinator');
  admin('provision', '--agent', 'sub1', '--provider', 'codex', '--conversation', 'T-SUB1');
  admin('provision', '--agent', 'cl1', '--provider', 'claude', '--conversation', 'S-CL1');
  admin('provision', '--agent', 'cl2', '--provider', 'claude', '--conversation', 'S-CL2');
  broker = spawn(process.execPath, ['--no-warnings', join(ROOT, 'dist/cli/admin.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await until(async () => { try { await fetch(BASE + '/'); return true; } catch { return false; } }, 8000, 'broker start');
});
after(async () => { for (const c of clients) await c.close().catch(() => {}); broker?.kill('SIGTERM'); });

test('join：登録・名前の重複・制御文字・再 join での更新', async () => {
  assert.equal((await A('main', 'join', { display_name: '統括', role: '振り分けと進捗管理' })).status, 200);
  assert.equal((await A('sub1', 'join', { display_name: '実装担当A', role: 'API の実装' })).status, 200);
  const dup = await A('cl1', 'join', { display_name: ' 実装担当a ', role: 'x' });     // 前後の空白・大文字小文字の違いだけ
  assert.equal(dup.data.error.code, 'NAME_TAKEN');
  assert.equal((await A('cl1', 'join', { display_name: 'レビュー\n担当', role: 'x' })).data.error.code, 'INVALID_ARGUMENT');
  const ok = await A('cl1', 'join', { display_name: '設計レビュアー', role: 'API 設計のレビュー' });
  assert.equal(ok.status, 200);
  assert.match(ok.data.guide, /担当の運用指示/);
  const upd = await A('cl1', 'join', { display_name: '設計レビュアー', role: 'API と DB 設計のレビュー' });
  assert.equal(upd.data.self.role, 'API と DB 設計のレビュー');
  assert.equal(upd.data.self.id, 'cl1');
});

test('members：自分を含む一覧と送信可否・理由（未参加は送れない）', async () => {
  const r = await A('main', 'members');
  const by = Object.fromEntries(r.data.members.map(m => [m.id, m]));
  assert.equal(by.main.is_self, true);
  assert.equal(by.main.can_send, false);
  assert.equal(by.cl2.membership, 'provisioned');
  assert.equal(by.cl2.can_send, false);
  assert.equal(by.sub1.can_send, true);
  assert.equal(by.sub1.delivery, 'queued');
  assert.match(by.sub1.reason, /切断中/);
});

test('send：個別・全員・宛先の確定・冪等性・各種エラー', async () => {
  const d = await A('main', 'send', { to: 'cl1', body: '[依頼 T-01] 設計を見てください', client_message_id: 'main-T01-req' });
  assert.equal(d.status, 200);
  assert.deepEqual(d.data.recipients.map(r => r.id), ['cl1']);
  const again = await A('main', 'send', { to: 'cl1', body: '[依頼 T-01] 設計を見てください', client_message_id: 'main-T01-req' });
  assert.equal(again.data.message_id, d.data.message_id);
  assert.equal(again.data.duplicate, true);
  assert.equal((await A('main', 'send', { to: 'cl1', body: '別の内容', client_message_id: 'main-T01-req' })).data.error.code, 'IDEMPOTENCY_CONFLICT');

  const b = await A('main', 'send', { to: 'all', body: '[決定] 方針はこれで進めます', client_message_id: 'main-dec-1' });
  assert.deepEqual(b.data.recipients.map(r => r.id).sort(), ['cl1', 'sub1']);           // 未参加の cl2 と自分は含まない
  await A('cl2', 'join', { display_name: 'テスト担当', role: '動作確認' });
  const b2 = await A('main', 'send', { to: 'all', body: '[決定] 方針はこれで進めます', client_message_id: 'main-dec-1' });
  assert.deepEqual(b2.data.recipients.map(r => r.id).sort(), ['cl1', 'sub1'], '後から join しても過去の全員送信の宛先は増えない');

  assert.equal((await A('main', 'send', { to: 'main', body: 'x', client_message_id: 'self-1' })).data.error.code, 'SELF_SEND');
  assert.equal((await A('main', 'send', { to: 'nobody', body: 'x', client_message_id: 'u-1' })).data.error.code, 'UNKNOWN_RECIPIENT');
  assert.equal((await A('main', 'send', { to: 'cl1', body: '   ', client_message_id: 'e-1' })).data.error.code, 'INVALID_ARGUMENT');
  assert.equal((await A('main', 'send', { to: 'cl1', body: 'x', from: 'cl2', client_message_id: 'from-1' })).status, 200);
  const view = await A('cl1', 'receive', {});
  assert.ok(view.data.messages.every(m => m.from.id === 'main'), 'from を偽っても送信者はトークンの主になる');
});

test('receive：自分宛てだけ・取得したら既読で二度は返らない・reply_to', async () => {
  const sub = await A('sub1', 'receive', {});
  assert.ok(sub.data.messages.every(m => m.to === 'all' || m.to === 'sub1'), '他人の受信箱が混ざらない');
  await A('main', 'send', { to: 'cl1', body: '[依頼 T-02] 1件目', client_message_id: 'main-T02-req' });
  await A('main', 'send', { to: 'cl1', body: '[依頼 T-03] 2件目', client_message_id: 'main-T03-req' });
  const r1 = await A('cl1', 'receive', { limit: 1 });
  assert.deepEqual(r1.data.messages.map(m => m.body), ['[依頼 T-02] 1件目']);
  assert.equal(r1.data.remaining, 1, 'remaining は、まだ返していない件数');
  const r2 = await A('cl1', 'receive', {});
  assert.deepEqual(r2.data.messages.map(m => m.body), ['[依頼 T-03] 2件目'], '一度返したものは二度返らない');
  assert.equal(r2.data.remaining, 0);
  assert.equal((await A('cl1', 'receive', {})).data.messages.length, 0);
  assert.equal((await A('cl1', 'ack', { message_ids: [r1.data.messages[0].message_id] })).status, 404, 'ACK の API はない（取得で既読）');
  const req2 = r1.data.messages[0];
  const rep = await A('cl1', 'send', { to: 'main', body: '[受領 T-02] 着手します', client_message_id: 'cl1-T02-ack', reply_to: req2.message_id });
  assert.equal(rep.status, 200);
  assert.equal((await A('sub1', 'send', { to: 'main', body: 'x', client_message_id: 'bad-reply', reply_to: req2.message_id })).data.error.code, 'INVALID_REPLY_TO');
});

test('leave：未取得は配送停止、以後は送れない、再 join しても戻らない', async () => {
  await A('main', 'send', { to: 'cl2', body: 'テストして', client_message_id: 'to-cl2-1' });
  const l = await A('cl2', 'leave', { confirm: true });
  assert.equal(l.data.cancelled_deliveries, 1);
  assert.equal((await A('main', 'send', { to: 'cl2', body: 'x', client_message_id: 'to-cl2-2' })).data.error.code, 'RECIPIENT_NOT_JOINED');
  await A('cl2', 'join', { display_name: 'テスト担当', role: '動作確認' });
  assert.equal((await A('cl2', 'receive', {})).data.messages.length, 0);
});

test('認証と HTTP の安全策', async () => {
  assert.equal((await req('GET', '/api/agent/members')).status, 401);
  assert.equal((await req('GET', '/api/agent/members', { token: 'sm1.c_00000000000000000000000000.xxxxxxxxxxxxxxxxxxxxxxxx' })).status, 401);
  assert.equal((await req('GET', '/api/agent/members', { token: tok('main'), origin: 'http://evil.example' })).status, 403);
  const badHost = await new Promise(res => httpRequest({ host: '127.0.0.1', port: PORT, path: '/api/members', headers: { host: 'evil.example' } }, r => { r.resume(); res(r.statusCode); }).end());
  assert.equal(badHost, 421, 'Host が違う（DNS リバインディング）なら拒否する');
  assert.equal((await req('GET', '/api/members')).status, 401, 'WebUI の API はログインが必要');
  assert.equal((await req('POST', '/api/ui/login', { body: { token: 'x' }, origin: 'http://evil.example' })).status, 403);
  const page = await req('GET', '/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(readFileSync(join(ROOT, 'src/web/app.js'), 'utf8'), /innerHTML/, '本文を HTML として扱わない');
});

test('WebUI：ログイン、一覧、取得（既読）による更新を増分で取りこぼさない', async () => {
  const pend = await A('main', 'send', { to: 'sub1', body: '[状況] 確認用', client_message_id: 'main-ui-1' });
  const viewer = readFileSync(join(HOME, 'tokens', 'viewer.token'), 'utf8').trim();
  const login = await req('POST', '/api/ui/login', { body: { token: viewer }, origin: BASE });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const first = await req('GET', '/api/messages?limit=100', { cookie });
  assert.ok(first.data.messages.length >= 4);
  const bc = first.data.messages.find(m => m.kind === 'broadcast');
  assert.equal(bc.summary.total, 2, '全員送信は投稿1件・宛先2件');
  assert.equal(first.data.messages.find(m => m.message_id === pend.data.message_id).deliveries[0].state, 'pending');
  await A('sub1', 'receive', {});
  const inc = await req('GET', `/api/messages?since_seq=${first.data.max_seq}`, { cookie });
  const upd = inc.data.messages.find(m => m.message_id === pend.data.message_id);
  assert.ok(upd, '取得で変わった投稿が増分に含まれる');
  assert.ok(upd.deliveries.find(d => d.recipient_id === 'sub1').state === 'acked');
  const mem = await req('GET', '/api/members', { cookie });
  assert.equal(mem.data.members.length, 4);
});

test('MCP ブリッジ：5ツール、Claude には channel 通知、Codex には codex queue', async () => {
  const start = async (id, provider, onChannel) => {
    const t = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'dist/bridge/main.js')],
      env: { ...env, SESSION_MAIL_TOKEN_FILE: join(HOME, 'tokens', `${id}.json`) }, stderr: 'pipe' });
    const c = new Client({ name: 't', version: '0' });
    c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') onChannel?.(n.params); };
    await c.connect(t); clients.push(c); return c;
  };
  await A('main', 'send', { to: 'cl1', body: '[依頼 T-04] 接続前に届いた依頼', client_message_id: 'main-T04-req' });
  const events = [];
  const cl = await start('cl1', 'claude', p => events.push(p));
  const cx = await start('sub1', 'codex');
  assert.deepEqual((await cl.listTools()).tools.map(t => t.name).sort(), ['channel_join', 'channel_leave', 'channel_members', 'channel_receive', 'channel_send']);
  assert.ok(cl.getServerCapabilities().experimental['claude/channel']);
  assert.equal(cl.getServerCapabilities().experimental['claude/channel/permission'], undefined);
  assert.match(cl.getInstructions(), /承認を代行・突破しません/);

  // 既存の未取得（main からの依頼など）は、接続した時点で通知される
  const ev = await until(() => events[0], 12000, 'channel 通知');
  assert.equal(ev.meta.kind, 'mail_notice');
  assert.match(ev.content, /channel_receive/);
  const r = JSON.parse((await cl.callTool({ name: 'channel_receive', arguments: {} })).content[0].text);
  assert.ok(r.messages.length >= 1);
  assert.equal(JSON.parse((await cl.callTool({ name: 'channel_receive', arguments: {} })).content[0].text).messages.length, 0, '取得したものは既読になる');

  const before = queueCalls().length;
  const sent = JSON.parse((await cl.callTool({ name: 'channel_send', arguments: { to: 'sub1', body: '[質問] 確認です', client_message_id: 'cl1-q-1' } })).content[0].text);
  assert.ok(sent.message_id);
  const call = await until(() => queueCalls().length > before && queueCalls().at(-1), 8000, 'codex queue');
  assert.deepEqual(call.slice(0, 4), ['queue', '--thread', 'T-SUB1', '--message']);
  assert.match(call[4], /^\[session-mail 通知\]/);
  const got = JSON.parse((await cx.callTool({ name: 'channel_receive', arguments: {} })).content[0].text);
  assert.ok(got.messages.some(m => m.message_id === sent.message_id));
  assert.ok(got.members.length >= 4, '受信時に参加者一覧を同梱する');

  // 通知の後に受信したので、自動受信は確認済みになる
  const mem = JSON.parse((await cx.callTool({ name: 'channel_members', arguments: {} })).content[0].text);
  assert.equal(mem.members.find(m => m.id === 'sub1').auto_receive, 'verified');
});

// LAN 側（別 PC から開く WebUI）。Host を自由に指定するため node:http で送る
function lanReq(method, path, host, { origin, body, cookie } = {}) {
  return new Promise(res => {
    const headers = { host };
    if (origin) headers.origin = origin;
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = httpRequest({ host: '127.0.0.1', port: UI_PORT, method, path, headers }, resp => {
      let data = ''; resp.on('data', c => data += c);
      resp.on('end', () => { let j; try { j = JSON.parse(data); } catch { j = data; } res({ status: resp.statusCode, data: j, headers: resp.headers }); });
    });
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

test('LAN 向け WebUI：閲覧だけ公開し、AI 用・管理用の API は置かない', async () => {
  const H = `192.168.1.50:${UI_PORT}`;
  await until(async () => (await lanReq('GET', '/', H)).status === 200, 5000, 'LAN 側の起動');
  assert.equal((await lanReq('GET', '/', `monitor.example:${UI_PORT}`)).status, 200, '設定で許可した名前でも開ける');
  assert.equal((await lanReq('GET', '/', `evil.example:${UI_PORT}`)).status, 421, '許可していない名前は拒否する');
  assert.equal((await lanReq('GET', '/api/agent/members', H)).status, 404, 'AI 用の API は LAN 側に存在しない');
  assert.equal((await lanReq('GET', '/api/admin/status', H)).status, 404, '管理用の API も LAN 側に存在しない');
  assert.equal((await lanReq('GET', '/api/members', H)).status, 401, '閲覧にもログインが必要');
  const viewer = readFileSync(join(HOME, 'tokens', 'viewer.token'), 'utf8').trim();
  assert.equal((await lanReq('POST', '/api/ui/login', H, { origin: 'http://evil.example', body: { token: viewer } })).status, 403);
  const ok = await lanReq('POST', '/api/ui/login', H, { origin: `http://${H}`, body: { token: viewer } });
  assert.equal(ok.status, 200);
  const cookie = ok.headers['set-cookie'][0].split(';')[0];
  const msgs = await lanReq('GET', '/api/messages?limit=5', H, { cookie });
  assert.equal(msgs.status, 200);
  assert.ok(Array.isArray(msgs.data.messages));
  assert.equal((await lanReq('POST', '/api/ui/login', H, { origin: `http://${H}`, body: { token: 'wrong' } })).status, 401);
});

test('会話の中から参加：トークンファイルなしで起動し、channel_join で参加する', async () => {
  const startUnbound = async (provider, onChannel) => {
    const e = { ...env, SESSION_MAIL_PROVIDER: provider };
    delete e.SESSION_MAIL_TOKEN_FILE;
    const t = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'dist/bridge/main.js')], env: e, stderr: 'pipe' });
    const c = new Client({ name: provider === 'claude' ? 'claude-code' : 'codex-mcp-client', version: '0' });
    c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') onChannel?.(n.params); };
    await c.connect(t); clients.push(c); return c;
  };
  const cx = await startUnbound('codex');
  const before = JSON.parse((await cx.callTool({ name: 'channel_members', arguments: {} })).content[0].text);
  assert.equal(before.error.code, 'NOT_JOINED', '参加前は他のツールが使えない');

  const j = await cx.callTool({ name: 'channel_join', arguments: { display_name: '実装担当C', role: 'CLI の実装', agent_id: 'codex-x', conversation_id: 'T-X' } });
  const jr = JSON.parse(j.content[0].text);
  assert.equal(jr.agent_id, 'codex-x');
  assert.match(jr.guide, /担当の運用指示/);
  const mem = JSON.parse((await cx.callTool({ name: 'channel_members', arguments: {} })).content[0].text);
  assert.equal(mem.self_id, 'codex-x');

  // 参加の直後に自動受信の確認（probe）が codex queue で届く
  const call = await until(() => queueCalls().find(c => c[2] === 'T-X'), 15000, '参加後の probe');
  assert.match(call[4], /接続確認/);
  await cx.callTool({ name: 'channel_receive', arguments: {} });
  const me = JSON.parse((await cx.callTool({ name: 'channel_members', arguments: {} })).content[0].text).members.find(m => m.id === 'codex-x');
  assert.equal(me.auto_receive, 'verified');

  // 同じ固定 ID は、接続中なら別のセッションから使えない
  const other = await startUnbound('codex');
  const dup = JSON.parse((await other.callTool({ name: 'channel_join', arguments: { display_name: '別人', role: 'x', agent_id: 'codex-x', conversation_id: 'T-Y' } })).content[0].text);
  assert.equal(dup.error.code, 'AGENT_IN_USE');

  // Claude は会話 ID なしで参加でき、ID を省略すると自動で割り当てる
  const events = [];
  const cl = await startUnbound('claude', p => events.push(p));
  const cj = JSON.parse((await cl.callTool({ name: 'channel_join', arguments: { display_name: 'レビュー担当2', role: 'レビュー' } })).content[0].text);
  assert.match(cj.agent_id, /^claude-\d+$/);
  await until(() => events.find(e => e.meta.kind === 'probe'), 20000, 'Claude への probe');

  // 参加用キーが違えば参加できない
  const bad = await req('POST', '/api/join/self', { token: 'wrong-key', body: { provider: 'codex', display_name: 'x', role: 'y' } });
  assert.equal(bad.status, 401);
});

test('ドキュメント：docs/MCP_TOOLS.md が実際のツールと必須の引数をすべて説明している', async () => {
  const t = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'dist/bridge/main.js')], env: { ...env }, stderr: 'pipe' });
  const c = new Client({ name: 'doc-check', version: '0' });
  await c.connect(t); clients.push(c);
  const doc = readFileSync(join(ROOT, 'docs/MCP_TOOLS.md'), 'utf8');
  for (const tool of (await c.listTools()).tools) {
    assert.ok(doc.includes(`### ${tool.name}`), `${tool.name} の節がない`);
    for (const arg of tool.inputSchema.required ?? []) assert.ok(doc.includes(`\`${arg}\``), `${tool.name} の必須の引数 ${arg} の説明がない`);
  }
});
