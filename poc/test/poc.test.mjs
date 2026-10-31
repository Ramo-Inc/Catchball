// PoC の自動試験：実際の Codex / Claude の代わりに、MCP SDK のクライアントでブリッジを起動し、
// 偽の codex コマンドで queue の呼び出しを記録する。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 47950 + Math.floor(Math.random() * 40);
const BROKER = `http://127.0.0.1:${PORT}`;
const TMP = mkdtempSync(join(tmpdir(), 'poc-test-'));
const FAKE_LOG = join(TMP, 'fake-codex.log');

let broker;
const clients = [];
const channelEvents = [];          // claude-a のブリッジから届いた channel 通知

const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = async (path, body) => (await fetch(BROKER + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const get = async path => (await fetch(BROKER + path)).json();
const queueCalls = () => existsSync(FAKE_LOG) ? readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
async function until(cond, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await cond(); if (v) return v; await sleep(200); }
  throw new Error(`タイムアウト: ${label}`);
}
const toolJson = r => JSON.parse(r.content[0].text);

async function startBridge(agent, provider, { onChannel } = {}) {
  const env = { ...process.env, POC_PROVIDER: provider, POC_BROKER_URL: BROKER };
  if (agent) env.POC_AGENT_ID = agent; else delete env.POC_AGENT_ID;
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'dist/bridge.js')], env, stderr: 'pipe' });
  const client = new Client({ name: 'poc-test', version: '0' });
  client.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') onChannel?.(n.params); };
  await client.connect(transport);
  clients.push(client);
  return client;
}

before(async () => {
  broker = spawn(process.execPath, [join(ROOT, 'dist/broker.js')], {
    env: { ...process.env, POC_PORT: String(PORT), POC_CODEX_BIN: process.execPath, POC_CODEX_PREFIX_ARGS: JSON.stringify([join(ROOT, 'test/fake-codex.mjs')]), POC_LOG_DIR: TMP, FAKE_CODEX_LOG: FAKE_LOG },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await until(async () => { try { await get('/status'); return true; } catch { return false; } }, 5000, 'broker start');
  for (const [agent, provider, thread] of [['codex-a', 'codex', 'T-A'], ['claude-a', 'claude', 'S-A'], ['codex-x', 'codex', 'fail-thread']]) {
    await post('/register', { agent, provider, thread });
  }
});

after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  broker?.kill();
});

let codex, claude;

test('ブリッジ：capabilities・ツール・識別（G3 相当）', async () => {
  codex = await startBridge('codex-a', 'codex');
  claude = await startBridge('claude-a', 'claude', { onChannel: p => channelEvents.push(p) });

  assert.equal(claude.getServerCapabilities().experimental?.['claude/channel'] !== undefined, true, 'claude は claude/channel を宣言する');
  assert.equal(claude.getServerCapabilities().experimental?.['claude/channel/permission'], undefined, 'permission relay は宣言しない');
  assert.equal(codex.getServerCapabilities().experimental?.['claude/channel'], undefined, 'codex は claude/channel を宣言しない');
  assert.match(claude.getInstructions() ?? '', /poc-mail 通知/);

  const names = (await codex.listTools()).tools.map(t => t.name).sort();
  assert.deepEqual(names, ['poc_ack', 'poc_receive', 'poc_send', 'poc_whoami']);

  assert.equal(toolJson(await codex.callTool({ name: 'poc_whoami', arguments: {} })).agent_id, 'codex-a');
  assert.equal(toolJson(await claude.callTool({ name: 'poc_whoami', arguments: {} })).agent_id, 'claude-a');

  await until(async () => (await get('/status')).agents.filter(a => a.connected).length === 2, 8000, '2つとも接続');
});

test('Claude：通知がハートビート経由で channel 通知として届き、受信・ACK できる（G2 相当）', async () => {
  const { message_id } = await post('/send', { from: 'user-test', to: 'claude-a', body: 'T4 相当' });
  const ev = await until(() => channelEvents[0], 12000, 'channel 通知');
  assert.equal(ev.meta.kind, 'mail_notice');
  assert.equal(ev.meta.unread, '1');
  assert.match(ev.content, /未取得メッセージが 1 件/);
  assert.doesNotMatch(ev.content, /T4 相当/, '通知文に本文を含めない');

  const got = toolJson(await claude.callTool({ name: 'poc_receive', arguments: {} }));
  assert.equal(got.messages[0].message_id, message_id);
  assert.equal(got.messages[0].body, 'T4 相当');
  const acked = toolJson(await claude.callTool({ name: 'poc_ack', arguments: { message_ids: [message_id] } }));
  assert.equal(acked.results[0].state, 'acked');

  // ブリッジからの書き込み結果がブローカーに記録される
  await until(async () => (await get('/log')).events.some(e => e.type === 'bridge_written' && e.result === 'written'), 8000, 'bridge_written');
});

test('Codex：通知が codex queue の引数で呼ばれる（G1 相当）', async () => {
  await post('/send', { from: 'user-test', to: 'codex-a', body: 'T3 相当' });
  const calls = await until(() => queueCalls().length >= 1 && queueCalls(), 6000, 'codex queue');
  const [sub, f1, thread, f2, text] = calls[0];
  assert.deepEqual([sub, f1, thread, f2], ['queue', '--thread', 'T-A', '--message']);
  assert.match(text, /^\[poc-mail 通知\]/);
  await until(async () => (await get('/status')).agents.find(a => a.agent === 'codex-a').last_notify?.result === 'queued_ok', 3000, 'queued_ok');
});

test('Codex：受信前の新着では通知を重ねず、受信後の新着で再び通知する（REVIEW C3）', async () => {
  const before = queueCalls().length;
  await post('/send', { from: 'user-test', to: 'codex-a', body: '追加1' });
  await post('/send', { from: 'user-test', to: 'codex-a', body: '追加2' });
  await sleep(4000);
  assert.equal(queueCalls().length, before, '通知済み・未受信の間は重ねない');

  const got = toolJson(await codex.callTool({ name: 'poc_receive', arguments: {} }));
  assert.equal(got.messages.length, 3);
  await codex.callTool({ name: 'poc_ack', arguments: { message_ids: got.messages.map(m => m.message_id) } });

  await post('/send', { from: 'user-test', to: 'codex-a', body: '受信後の新着' });
  await until(() => queueCalls().length === before + 1, 6000, '受信後の通知');
});

test('受信済み・ACK 待ちのメッセージでは、もう一度通知しない（実機の試験で見つかった不具合）', async () => {
  const leftover = toolJson(await codex.callTool({ name: 'poc_receive', arguments: {} }));
  if (leftover.messages.length) await codex.callTool({ name: 'poc_ack', arguments: { message_ids: leftover.messages.map(m => m.message_id) } });
  await sleep(500);
  const before = queueCalls().length;
  await post('/send', { from: 'user-test', to: 'codex-a', body: 'ACK を遅らせる' });
  await until(() => queueCalls().length === before + 1, 6000, '最初の通知');
  const got = toolJson(await codex.callTool({ name: 'poc_receive', arguments: {} }));   // 受信だけして ACK しない
  await sleep(4000);
  assert.equal(queueCalls().length, before + 1, '受信済み・未 ACK では再通知しない');
  await codex.callTool({ name: 'poc_ack', arguments: { message_ids: got.messages.map(m => m.message_id) } });
});

test('往復：AI どうしの送信と reply_to（G4 相当）', async () => {
  // codex-a は前の試験の未取得を片付けておく
  const leftover = toolJson(await codex.callTool({ name: 'poc_receive', arguments: {} }));
  if (leftover.messages.length) await codex.callTool({ name: 'poc_ack', arguments: { message_ids: leftover.messages.map(m => m.message_id) } });

  const req = toolJson(await codex.callTool({ name: 'poc_send', arguments: { to: 'claude-a', body: '1 から 10 の和は？' } }));
  await until(() => channelEvents.length >= 2, 12000, 'claude への 2 回目の通知');
  const inbox = toolJson(await claude.callTool({ name: 'poc_receive', arguments: {} }));
  assert.equal(inbox.messages[0].from, 'codex-a');
  await claude.callTool({ name: 'poc_ack', arguments: { message_ids: [req.message_id] } });

  const rep = toolJson(await claude.callTool({ name: 'poc_send', arguments: { to: 'codex-a', body: '55', reply_to: req.message_id } }));
  const back = await until(async () => {
    const r = toolJson(await codex.callTool({ name: 'poc_receive', arguments: {} }));
    return r.messages.find(m => m.message_id === rep.message_id);
  }, 6000, 'codex への返信');
  assert.equal(back.reply_to, req.message_id);
  assert.equal(back.from, 'claude-a');
});

test('Claude：切断中の未取得は、再接続したときにすぐ通知される', async () => {
  const idx = clients.indexOf(claude);
  await claude.close();
  clients.splice(idx, 1);
  await sleep(500);
  await post('/send', { from: 'user-test', to: 'claude-a', body: '切断中に送信' });

  const events2 = [];
  claude = await startBridge('claude-a', 'claude', { onChannel: p => events2.push(p) });
  const ev = await until(() => events2[0], 12000, '再接続後の通知');
  assert.equal(ev.meta.unread, '1');
  assert.ok((await get('/log')).events.some(e => e.type === 'notify_start' && e.agent === 'claude-a' && e.reason === 'reconnect'));
});

test('Codex：queue の失敗（存在しないスレッド）が記録される', async () => {
  const { generation } = await post('/connect', { agent: 'codex-x', provider: 'codex' });
  assert.ok(generation >= 1);
  await post('/send', { from: 'user-test', to: 'codex-x', body: 'fail' });
  const st = await until(async () => {
    const a = (await get('/status')).agents.find(x => x.agent === 'codex-x');
    return a.last_notify?.result === 'failed' && a;
  }, 6000, 'failed');
  assert.match(st.last_notify.error, /thread not found/);
});

test('POC_AGENT_ID がない場合：プロセスは落ちず、ツールが理由を返す', async () => {
  const c = await startBridge(undefined, 'codex');
  const r = await c.callTool({ name: 'poc_whoami', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /POC_AGENT_ID が未設定/);
});

test('ブローカー：未登録の宛先・自分宛て・空の本文を拒否する', async () => {
  assert.match((await post('/send', { from: 'codex-a', to: 'nobody', body: 'x' })).error, /未登録の宛先/);
  assert.match((await post('/send', { from: 'codex-a', to: 'codex-a', body: 'x' })).error, /自分自身/);
  assert.match((await post('/send', { from: 'codex-a', to: 'claude-a', body: '  ' })).error, /空/);
});
