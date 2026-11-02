// 本実装の自動試験：一時ディレクトリでブローカーを起動し、HTTP と MCP（stdio）から仕様の規則を確かめる
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
const tokPath = (id, room = 'r1') => join(HOME, 'tokens', `room-${room.replace(/[A-Z]/g, c => '!' + c.toLowerCase()).replace(/\./g, '~')}`, `${id}.json`);
const tok = (id, room) => JSON.parse(readFileSync(tokPath(id, room), 'utf8')).token;
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
// 前の版の DB と閲覧用トークン（新しい版では読まない・使えない）
const OLD_DB = 'これは前の版の DB の代わり';
mkdirSync(join(HOME, 'tokens'), { recursive: true });
writeFileSync(join(HOME, 'session-mail.db'), OLD_DB);
writeFileSync(join(HOME, 'tokens', 'viewer.token'), 'sm1.c_00000000000000000000000000.oldviewer');
const joinKey = () => readFileSync(join(HOME, 'tokens', 'join.key'), 'utf8').trim();
const J = (method, path, body) => req(method, '/api/join/' + path, { token: joinKey(), body });
before(async () => {
  broker = spawn(process.execPath, ['--no-warnings', join(ROOT, 'dist/cli/admin.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await until(async () => { try { await fetch(BASE + '/'); return true; } catch { return false; } }, 8000, 'broker start');
  assert.equal((await J('POST', 'rooms', { room: 'r1' })).status, 200);
  admin('provision', '--room', 'r1', '--agent', 'main', '--provider', 'codex', '--conversation', 'T-MAIN', '--duty', 'coordinator');
  admin('provision', '--room', 'r1', '--agent', 'sub1', '--provider', 'codex', '--conversation', 'T-SUB1');
  admin('provision', '--room', 'r1', '--agent', 'cl1', '--provider', 'claude', '--conversation', 'S-CL1');
  admin('provision', '--room', 'r1', '--agent', 'cl2', '--provider', 'claude', '--conversation', 'S-CL2');
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
  const first = await req('GET', '/api/messages?room=r1&limit=100', { cookie });
  assert.ok(first.data.messages.length >= 4);
  const bc = first.data.messages.find(m => m.kind === 'broadcast');
  assert.equal(bc.summary.total, 2, '全員送信は投稿1件・宛先2件');
  assert.equal(first.data.messages.find(m => m.message_id === pend.data.message_id).deliveries[0].state, 'pending');
  await A('sub1', 'receive', {});
  const inc = await req('GET', `/api/messages?room=r1&since_seq=${first.data.max_seq}`, { cookie });
  const upd = inc.data.messages.find(m => m.message_id === pend.data.message_id);
  assert.ok(upd, '取得で変わった投稿が増分に含まれる');
  assert.ok(upd.deliveries.find(d => d.recipient_id === 'sub1').state === 'acked');
  const mem = await req('GET', '/api/members?room=r1', { cookie });
  assert.equal(mem.data.members.length, 4);
});

test('MCP ブリッジ：8ツール、Claude には channel 通知、Codex には codex queue', async () => {
  const start = async (id, provider, onChannel) => {
    const t = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'dist/bridge/main.js')],
      env: { ...env, SESSION_MAIL_TOKEN_FILE: tokPath(id) }, stderr: 'pipe' });
    const c = new Client({ name: 't', version: '0' });
    c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') onChannel?.(n.params); };
    await c.connect(t); clients.push(c); return c;
  };
  await A('main', 'send', { to: 'cl1', body: '[依頼 T-04] 接続前に届いた依頼', client_message_id: 'main-T04-req' });
  const events = [];
  const cl = await start('cl1', 'claude', p => events.push(p));
  const cx = await start('sub1', 'codex');
  assert.deepEqual((await cl.listTools()).tools.map(t => t.name).sort(), ['channel_join', 'channel_leave', 'channel_members', 'channel_receive', 'channel_room_create', 'channel_room_delete', 'channel_rooms', 'channel_send']);
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
  const msgs = await lanReq('GET', '/api/messages?room=r1&limit=5', H, { cookie });
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

  const j = await cx.callTool({ name: 'channel_join', arguments: { display_name: '実装担当C', role: 'CLI の実装', room: 'r1', agent_id: 'codex-x', conversation_id: 'T-X' } });
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
  const dup = JSON.parse((await other.callTool({ name: 'channel_join', arguments: { display_name: '別人', role: 'x', room: 'r1', agent_id: 'codex-x', conversation_id: 'T-Y' } })).content[0].text);
  assert.equal(dup.error.code, 'AGENT_IN_USE');
  assert.match(dup.error.hint, /別の ID は使わず/, '別の ID に逃げさせず、ユーザーに確認させる');

  // ID は必須：ツールの定義で必須になっていて、省略すると断られる
  const events = [];
  const cl = await startUnbound('claude', p => events.push(p));
  const joinTool = (await cl.listTools()).tools.find(t => t.name === 'channel_join');
  assert.ok(joinTool.inputSchema.required.includes('agent_id'), '会話の中から参加する方法では agent_id が必須');
  assert.ok((await cl.callTool({ name: 'channel_join', arguments: { display_name: 'レビュー担当2', role: 'レビュー', room: 'r1' } })).isError, 'ID を省略すると断られる');
  const key = readFileSync(join(HOME, 'tokens', 'join.key'), 'utf8').trim();
  const noId = await req('POST', '/api/join/self', { token: key, body: { provider: 'claude', display_name: 'x', role: 'y' } });
  assert.equal(noId.data.error.code, 'INVALID_ARGUMENT');
  assert.match(noId.data.error.hint, /ユーザーに尋ね/, 'ID は自分で決めず、ユーザーに尋ねるよう案内する');
  const noConv = await req('POST', '/api/join/self', { token: key, body: { provider: 'codex', room: 'r1', agent_id: 'codex-noconv', display_name: 'x', role: 'y' } });
  assert.equal(noConv.data.error.code, 'INVALID_ARGUMENT', 'Codex は会話 ID なしでは参加できない');
  assert.match(noConv.data.error.hint, /CODEX_THREAD_ID/);

  // Claude は会話 ID なしで参加できる
  const cj = JSON.parse((await cl.callTool({ name: 'channel_join', arguments: { display_name: 'レビュー担当2', role: 'レビュー', room: 'r1', agent_id: 'review2' } })).content[0].text);
  assert.equal(cj.agent_id, 'review2');
  await until(() => events.find(e => e.meta.kind === 'probe'), 20000, 'Claude への probe');

  // 参加用キーが違えば参加できない
  const bad = await req('POST', '/api/join/self', { token: 'wrong-key', body: { provider: 'codex', display_name: 'x', role: 'y' } });
  assert.equal(bad.status, 401);
});

// 会話の中から参加する方法のブリッジ（トークンファイルなし）を起動する
async function startBridge(provider, onChannel) {
  const e = { ...env, SESSION_MAIL_PROVIDER: provider };
  delete e.SESSION_MAIL_TOKEN_FILE;
  const t = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'dist/bridge/main.js')], env: e, stderr: 'pipe' });
  const c = new Client({ name: provider === 'claude' ? 'claude-code' : 'codex-mcp-client', version: '0' });
  c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') onChannel?.(n.params); };
  await c.connect(t); clients.push(c);
  const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); return { isError: !!r.isError, data: (() => { try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; } })() }; };
  return { c, call };
}
const memberOf = async id => (await A('main', 'members')).data.members.find(m => m.id === id);

test('担当の入れ替え：同じ役割の ID に、別のハーネスで入れる（未取得は引き継ぐ）', async () => {
  // Codex（会話 T-DEV1）で dev として参加し、閉じる
  const cx = await startBridge('codex');
  assert.equal((await cx.call('channel_join', { room: 'r1', agent_id: 'dev', display_name: '開発担当', role: '開発', conversation_id: 'T-DEV1' })).data.agent_id, 'dev');
  await cx.c.close();
  await until(async () => (await memberOf('dev'))?.connection === 'offline', 8000, 'dev が切断中になる');

  // 切断中の dev にも送れる
  const sent = await A('main', 'send', { to: 'dev', body: '[依頼 T-10] 引き継ぎの確認', client_message_id: 'main-T10-req' });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.recipients[0].delivery, 'queued');

  // Claude で同じ dev に入れる。未取得を受け取れ、ハーネスは Claude になり、自動受信の確認が届く
  const events = [];
  const cl = await startBridge('claude', p => events.push(p));
  const j = await cl.call('channel_join', { room: 'r1', agent_id: 'dev', display_name: '開発担当', role: '開発' });
  assert.equal(j.isError, false, JSON.stringify(j.data));
  const got = (await cl.call('channel_receive')).data;
  assert.ok(got.messages.some(m => m.message_id === sent.data.message_id), '前の担当宛ての未取得を受け取れる');
  assert.equal((await memberOf('dev')).provider, 'claude');
  await until(() => events.find(e => e.meta.kind === 'probe'), 20000, 'Claude への自動受信の確認');

  // 参加済みのセッションで別の ID を指定すると断られる。同じ ID なら更新できる
  const other = await cl.call('channel_join', { room: 'r1', agent_id: 'review', display_name: '開発担当', role: '開発' });
  assert.equal(other.isError, true);
  assert.match(other.data.error.message, /dev として参加済み/);
  assert.equal((await cl.call('channel_join', { room: 'r1', agent_id: 'dev', display_name: '開発担当', role: '開発とテスト' })).data.self.role, '開発とテスト');

  // Claude を閉じて、Codex（新しい会話 T-DEV2）で入れる。通知は T-DEV2 にだけ届き、前の会話 T-DEV1 には届かない
  await cl.c.close();
  await until(async () => (await memberOf('dev'))?.connection === 'offline', 8000, 'dev が切断中になる（2回目）');
  const before = queueCalls().length;
  const cx2 = await startBridge('codex');
  assert.equal((await cx2.call('channel_join', { room: 'r1', agent_id: 'dev', display_name: '開発担当', role: '開発', conversation_id: 'T-DEV2' })).isError, false);
  await until(() => queueCalls().slice(before).find(c => c[2] === 'T-DEV2'), 20000, 'T-DEV2 への通知');
  assert.equal(queueCalls().slice(before).filter(c => c[2] === 'T-DEV1').length, 0, '前の会話には通知しない');
  assert.equal((await memberOf('dev')).provider, 'codex');
});

test('担当の入れ替え：前のキーは無効になる・表示名で断られても ID は使用中にならない', async () => {
  const key = readFileSync(join(HOME, 'tokens', 'join.key'), 'utf8').trim();
  const self = body => req('POST', '/api/join/self', { token: key, body });

  // トークンファイルの参加者（Codex）を、会話の中からの参加（Claude）で入れ替えると、前のトークンは使えない
  admin('provision', '--room', 'r1', '--agent', 'old1', '--provider', 'codex', '--conversation', 'T-OLD1');
  assert.equal((await A('old1', 'members')).status, 200);
  assert.equal((await self({ provider: 'claude', room: 'r1', agent_id: 'old1', display_name: '入れ替え後', role: 'x' })).status, 200);
  assert.equal((await A('old1', 'members')).status, 401, '入れ替え前のトークンは失効している');

  // 表示名の重複で断られても、その ID は使用中にならず、すぐに別の表示名で入れる
  const taken = await self({ provider: 'claude', room: 'r1', agent_id: 'nm1', display_name: '統括', role: 'x' });
  assert.equal(taken.data.error.code, 'NAME_TAKEN');
  const ok = await self({ provider: 'claude', room: 'r1', agent_id: 'nm1', display_name: '別の名前', role: 'x' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

// ---- ルーム（D-018） ----
const selfJoin = body => J('POST', 'self', { provider: 'claude', display_name: body.agent_id, role: 'x', ...body });
const AT = (token, path, body) => req(body === undefined ? 'GET' : 'POST', '/api/agent/' + path, { token, body });
const roomOf = async room => (await J('GET', 'rooms')).data.rooms.find(r => r.room === room);

test('ルーム：作成・一覧・削除と ID の決まり（参加していないブリッジからも使える）', async () => {
  const b = await startBridge('claude');
  const made = await b.call('channel_room_create', { room: 'Proj' });
  assert.equal(made.isError, false, JSON.stringify(made.data));
  assert.equal(made.data.room, 'Proj');
  assert.equal((await b.call('channel_room_create', { room: 'Proj' })).data.error.code, 'ROOM_EXISTS');
  assert.equal((await b.call('channel_room_create', { room: 'proj' })).isError, false, '大文字と小文字は別のルーム');
  for (const bad of ['a b', 'x'.repeat(33), '開発', '', ' proj2']) {
    assert.equal((await J('POST', 'rooms', { room: bad })).data.error.code, 'INVALID_ARGUMENT', `「${bad}」は断る`);
  }
  assert.equal((await J('POST', 'rooms', { room: 'y'.repeat(32) })).status, 200);
  assert.equal((await J('POST', 'rooms', { room: 'a.b_c-1' })).status, 200);
  const list = (await b.call('channel_rooms')).data.rooms;
  assert.deepEqual(['Proj', 'a.b_c-1', 'proj'].every(r => list.some(x => x.room === r)), true);
  assert.ok(list.find(r => r.room === 'Proj').created_at > 0);
  const del = await b.call('channel_room_delete', { room: 'a.b_c-1' });
  assert.equal(del.isError, false, JSON.stringify(del.data));
  assert.equal(await roomOf('a.b_c-1'), undefined);
  assert.equal((await b.call('channel_room_delete', { room: 'a.b_c-1' })).data.error.code, 'ROOM_NOT_FOUND');
  assert.equal((await req('POST', '/api/join/rooms', { token: 'wrong', body: { room: 'z' } })).status, 401, '参加用キーが要る');
});

test('ルーム：指定がない・ないルームへの参加は断り、ユーザーに尋ねさせる', async () => {
  const b = await startBridge('claude');
  const schema = (await b.c.listTools()).tools.find(t => t.name === 'channel_join').inputSchema;
  assert.ok(schema.required.includes('room'), '会話の中から参加する方法では room が必須');
  const noRoom = await J('POST', 'self', { provider: 'claude', agent_id: 'qq', display_name: 'q', role: 'x' });
  assert.equal(noRoom.data.error.code, 'INVALID_ARGUMENT');
  assert.match(noRoom.data.error.hint, /ユーザーに尋ね/);
  const none = await b.call('channel_join', { room: 'nowhere', agent_id: 'qq', display_name: 'q', role: 'x' });
  assert.equal(none.data.error.code, 'ROOM_NOT_FOUND');
  assert.match(none.data.error.hint, /自分で作らず/);
  assert.equal(await roomOf('nowhere'), undefined, 'ルームは作られない');
});

test('ルーム：ID はルームごと。全員宛て・一覧・宛先はルームの中だけ', async () => {
  await J('POST', 'rooms', { room: 'ra' });
  await J('POST', 'rooms', { room: 'rb' });
  const aDev = await selfJoin({ room: 'ra', agent_id: 'dev', display_name: '開発' });
  const bDev = await selfJoin({ room: 'rb', agent_id: 'dev', display_name: '開発' });
  assert.equal(aDev.status, 200, JSON.stringify(aDev.data));
  assert.equal(bDev.status, 200, '別のルームなら同じ ID・同じ表示名で、同時に接続中になれる');
  const aQa = (await selfJoin({ room: 'ra', agent_id: 'qa' })).data.token;
  const bQa = (await selfJoin({ room: 'rb', agent_id: 'qa' })).data.token;
  await selfJoin({ room: 'rb', agent_id: 'only-b' });
  const all = await AT(aDev.data.token, 'send', { to: 'all', body: 'ra の全員へ', client_message_id: 'ra-all-1' });
  assert.deepEqual(all.data.recipients.map(r => r.id), ['qa']);
  assert.equal((await AT(aQa, 'receive', {})).data.messages.length, 1);
  assert.equal((await AT(bQa, 'receive', {})).data.messages.length, 0, '別のルームには届かない');
  const mem = await AT(aDev.data.token, 'members');
  assert.equal(mem.data.room, 'ra');
  assert.deepEqual(mem.data.members.map(m => m.id).sort(), ['dev', 'qa']);
  assert.equal((await AT(aDev.data.token, 'send', { to: 'only-b', body: 'x', client_message_id: 'ra-x-1' })).data.error.code, 'UNKNOWN_RECIPIENT');
  const dm = await AT(bDev.data.token, 'send', { to: 'qa', body: 'rb の qa へ', client_message_id: 'rb-dm-1' });
  assert.equal(dm.status, 200);
  assert.equal((await AT(aQa, 'receive', {})).data.messages.length, 0, '同じ ID でも別のルームの qa には届かない');
  assert.equal((await AT(bQa, 'receive', {})).data.messages[0].body, 'rb の qa へ');
});

test('ルーム：一覧の参加者と、削除できる条件（全員が退出してから）', async () => {
  await J('POST', 'rooms', { room: 'rd' });
  admin('provision', '--room', 'rd', '--agent', 'pv', '--provider', 'claude', '--conversation', 'S-PV');
  const x = (await selfJoin({ room: 'rd', agent_id: 'x', display_name: '検証' })).data.token;
  const y = (await selfJoin({ room: 'rd', agent_id: 'y', display_name: '退出者' })).data.token;
  await AT(x, 'send', { to: 'y', body: '残るメッセージ', client_message_id: 'rd-1' });
  await AT(y, 'leave', { confirm: true });
  await AT(x, 'disconnect', { generation: 0 });
  assert.deepEqual((await roomOf('rd')).members, [{ id: 'x', display_name: '検証' }], '切断中も載る。退出済みと登録だけの ID は載らない');

  const busy = await J('DELETE', 'rooms/rd');
  assert.equal(busy.data.error.code, 'ROOM_NOT_EMPTY', '切断中でも退出していなければ消せない');
  assert.match(busy.data.error.message, /x/);
  await AT(x, 'leave', { confirm: true });
  assert.equal((await J('DELETE', 'rooms/rd')).status, 200, '登録だけの ID が残っていても消せる');
  assert.equal((await AT(x, 'members')).status, 401, '削除したルームのトークンは使えない');
  assert.equal((await req('GET', '/api/agent/members', { token: tok('pv', 'rd') })).status, 401);
  await J('POST', 'rooms', { room: 'rd' });
  assert.deepEqual((await roomOf('rd')).members, [], '作り直したルームは空');
  const again = (await selfJoin({ room: 'rd', agent_id: 'x', display_name: '検証' })).data.token;
  assert.equal((await AT(again, 'receive', {})).data.messages.length, 0);
});

test('ルーム：退出すれば、同じセッションのまま別のルームに移れる', async () => {
  await J('POST', 'rooms', { room: 'ma' });
  await J('POST', 'rooms', { room: 'mb' });
  const b = await startBridge('claude');
  assert.equal((await b.call('channel_join', { room: 'ma', agent_id: 'mv', display_name: '移動', role: 'x' })).isError, false);
  for (const args of [{ room: 'mb', agent_id: 'mv' }, { room: 'ma', agent_id: 'mv2' }]) {
    const r = await b.call('channel_join', { ...args, display_name: '移動', role: 'x' });
    assert.equal(r.isError, true, '参加中に別のルーム・別の ID は断る');
    assert.match(r.data.error.hint, /channel_leave/);
  }
  assert.equal((await b.call('channel_leave', { confirm: true })).isError, false);
  const j = await b.call('channel_join', { room: 'mb', agent_id: 'mv', display_name: '移動', role: 'x' });
  assert.equal(j.isError, false, JSON.stringify(j.data));
  assert.equal(j.data.room, 'mb');
  const peer = (await selfJoin({ room: 'mb', agent_id: 'peer' })).data.token;
  await AT(peer, 'send', { to: 'mv', body: 'mb で届く', client_message_id: 'mb-1' });
  assert.equal((await b.call('channel_receive')).data.messages[0].body, 'mb で届く');
  const back = await selfJoin({ room: 'ma', agent_id: 'mv', display_name: '後任' });
  assert.equal(back.status, 200, '退出した ID には、別のセッションがすぐ入れる');
});

test('ルーム：トークンファイルの参加者（provision）', async () => {
  assert.throws(() => admin('provision', '--agent', 'nr', '--provider', 'claude', '--conversation', 'S'), 'ルームの指定は必須');
  assert.throws(() => admin('provision', '--room', 'nowhere', '--agent', 'nr', '--provider', 'claude', '--conversation', 'S'), 'ないルームは断る');
  await J('POST', 'rooms', { room: 'Tf.1' });
  await J('POST', 'rooms', { room: 'tf.1' });
  admin('provision', '--room', 'Tf.1', '--agent', 'tw', '--provider', 'claude', '--conversation', 'S-TW1');
  admin('provision', '--room', 'tf.1', '--agent', 'tw', '--provider', 'claude', '--conversation', 'S-TW2');
  assert.notEqual(tok('tw', 'Tf.1'), tok('tw', 'tf.1'), '大文字と小文字だけが違うルームでも、別のファイルになる');
  const t = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'dist/bridge/main.js')], env: { ...env, SESSION_MAIL_TOKEN_FILE: tokPath('tw', 'Tf.1') }, stderr: 'pipe' });
  const c = new Client({ name: 'claude-code', version: '0' });
  await c.connect(t); clients.push(c);
  const r = JSON.parse((await c.callTool({ name: 'channel_join', arguments: { room: 'tf.1', display_name: 'tw', role: 'x' } })).content[0].text);
  assert.match(r.error.hint, /変えられません/);
  const ok = JSON.parse((await c.callTool({ name: 'channel_join', arguments: { display_name: 'tw', role: 'x' } })).content[0].text);
  assert.equal(ok.room, 'Tf.1');

  // 前の版（ルームなし）のトークンファイルでも、ブリッジは起動し、理由を返す
  const old = join(HOME, 'old-token.json');
  writeFileSync(old, JSON.stringify({ version: 1, broker_url: BASE, agent_id: 'x', provider: 'claude', duty: 'worker', token: 'x' }));
  const t2 = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'dist/bridge/main.js')], env: { ...env, SESSION_MAIL_TOKEN_FILE: old }, stderr: 'pipe' });
  const c2 = new Client({ name: 'claude-code', version: '0' });
  await c2.connect(t2); clients.push(c2);
  const bad = JSON.parse((await c2.callTool({ name: 'channel_join', arguments: { room: 'r1', agent_id: 'x', display_name: 'x', role: 'x' } })).content[0].text);
  assert.equal(bad.error.code, 'INVALID_TOKEN_FILE');
  assert.match(bad.error.message, /provision --room/);
});

test('ルーム：WebUI はルームを選んで見る（LAN 側には一覧の閲覧だけ）', async () => {
  const viewer = readFileSync(join(HOME, 'tokens', 'viewer.token'), 'utf8').trim();
  const cookie = (await req('POST', '/api/ui/login', { body: { token: viewer }, origin: BASE })).headers.get('set-cookie').split(';')[0];
  const rooms = await req('GET', '/api/ui/rooms', { cookie });
  assert.ok(rooms.data.rooms.some(r => r.room === 'ra'));
  assert.equal((await req('GET', '/api/members', { cookie })).data.error.code, 'INVALID_ARGUMENT', 'ルームの指定が要る');
  assert.equal((await req('GET', '/api/messages?room=nowhere', { cookie })).data.error.code, 'ROOM_NOT_FOUND');
  const ra = await req('GET', '/api/messages?room=ra', { cookie });
  assert.ok(ra.data.messages.length >= 1 && ra.data.messages.every(m => m.room === 'ra'), '選んだルームのメッセージだけ');
  assert.deepEqual((await req('GET', '/api/members?room=rb', { cookie })).data.members.map(m => m.id).sort(), ['dev', 'only-b', 'qa']);

  const H = `192.168.1.50:${UI_PORT}`;
  const lc = (await lanReq('POST', '/api/ui/login', H, { origin: `http://${H}`, body: { token: viewer } })).headers['set-cookie'][0].split(';')[0];
  assert.equal((await lanReq('GET', '/api/ui/rooms', H, { cookie: lc })).status, 200);
  assert.equal((await lanReq('GET', '/api/join/rooms', H)).status, 404, 'ルームの操作は LAN 側にない');
  assert.equal((await lanReq('POST', '/api/join/rooms', H, { body: { room: 'lan' } })).status, 404);
});

test('ルーム：新しい DB で始め、前の DB は読まずに残す', async () => {
  assert.equal(readFileSync(join(HOME, 'session-mail.db'), 'utf8'), OLD_DB, '前の DB ファイルは変わらない');
  assert.ok(existsSync(join(HOME, 'session-mail-v2.db')));
  const viewer = readFileSync(join(HOME, 'tokens', 'viewer.token'), 'utf8').trim();
  assert.notEqual(viewer, 'sm1.c_00000000000000000000000000.oldviewer', '閲覧用トークンは発行し直す');
  assert.equal((await req('POST', '/api/ui/login', { body: { token: 'sm1.c_00000000000000000000000000.oldviewer' }, origin: BASE })).status, 401);
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
