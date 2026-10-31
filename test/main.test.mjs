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
const FAKE_LOG = join(HOME, 'fake-codex.log');
const env = { ...process.env, SESSION_MAIL_HOME: HOME, FAKE_CODEX_LOG: FAKE_LOG };
writeFileSync(join(HOME, 'config.json'), JSON.stringify({ port: PORT, codex: { command: [process.execPath, join(ROOT, 'test/fake-codex.mjs')] }, notify: { codex_quiet_after_tool_ms: 0 } }));

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

test('receive / ack：自分宛てだけ・他人の ACK は効かない・reply_to', async () => {
  const sub = await A('sub1', 'receive', {});
  assert.ok(sub.data.messages.every(m => m.to === 'all' || m.to === 'sub1'), '他人の受信箱が混ざらない');
  const clMsgs = (await A('cl1', 'receive', {})).data.messages;
  const req1 = clMsgs.find(m => m.body.startsWith('[依頼 T-01]'));
  assert.ok(req1.receive_count >= 2, '再取得は receive_count で分かる');
  assert.equal((await A('sub1', 'ack', { message_ids: [req1.message_id] })).data.results[0].error, 'NOT_FOUND');
  assert.equal((await A('cl1', 'ack', { message_ids: [req1.message_id] })).data.results[0].state, 'acked');
  assert.equal((await A('cl1', 'ack', { message_ids: [req1.message_id] })).data.results[0].already, true);
  const rep = await A('cl1', 'send', { to: 'main', body: '[受領 T-01] 着手します', client_message_id: 'cl1-T01-ack', reply_to: req1.message_id });
  assert.equal(rep.status, 200);
  assert.equal((await A('sub1', 'send', { to: 'main', body: 'x', client_message_id: 'bad-reply', reply_to: req1.message_id })).data.error.code, 'INVALID_REPLY_TO');
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

test('WebUI：ログイン、一覧、ACK による更新を増分で取りこぼさない', async () => {
  const viewer = readFileSync(join(HOME, 'tokens', 'viewer.token'), 'utf8').trim();
  const login = await req('POST', '/api/ui/login', { body: { token: viewer }, origin: BASE });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const first = await req('GET', '/api/messages?limit=100', { cookie });
  assert.ok(first.data.messages.length >= 4);
  const bc = first.data.messages.find(m => m.kind === 'broadcast');
  assert.equal(bc.summary.total, 2, '全員送信は投稿1件・宛先2件');
  const sub = await A('sub1', 'receive', {});
  await A('sub1', 'ack', { message_ids: sub.data.messages.map(m => m.message_id).concat([bc.message_id]) });
  const inc = await req('GET', `/api/messages?since_seq=${first.data.max_seq}`, { cookie });
  const upd = inc.data.messages.find(m => m.message_id === bc.message_id);
  assert.ok(upd, 'ACK で変わった投稿が増分に含まれる');
  assert.ok(upd.deliveries.find(d => d.recipient_id === 'sub1').state === 'acked');
  const mem = await req('GET', '/api/members', { cookie });
  assert.equal(mem.data.members.length, 4);
});

test('MCP ブリッジ：6ツール、Claude には channel 通知、Codex には codex queue', async () => {
  const start = async (id, provider, onChannel) => {
    const t = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'dist/bridge/main.js')],
      env: { ...env, SESSION_MAIL_TOKEN_FILE: join(HOME, 'tokens', `${id}.json`) }, stderr: 'pipe' });
    const c = new Client({ name: 't', version: '0' });
    c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') onChannel?.(n.params); };
    await c.connect(t); clients.push(c); return c;
  };
  const events = [];
  const cl = await start('cl1', 'claude', p => events.push(p));
  const cx = await start('sub1', 'codex');
  assert.deepEqual((await cl.listTools()).tools.map(t => t.name).sort(), ['channel_ack', 'channel_join', 'channel_leave', 'channel_members', 'channel_receive', 'channel_send']);
  assert.ok(cl.getServerCapabilities().experimental['claude/channel']);
  assert.equal(cl.getServerCapabilities().experimental['claude/channel/permission'], undefined);
  assert.match(cl.getInstructions(), /承認を代行・突破しません/);

  // 既存の未取得（main からの依頼など）は、接続した時点で通知される
  const ev = await until(() => events[0], 12000, 'channel 通知');
  assert.equal(ev.meta.kind, 'mail_notice');
  assert.match(ev.content, /channel_receive/);
  const r = JSON.parse((await cl.callTool({ name: 'channel_receive', arguments: {} })).content[0].text);
  await cl.callTool({ name: 'channel_ack', arguments: { message_ids: r.messages.map(m => m.message_id) } });

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
