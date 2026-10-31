#!/usr/bin/env node
// 管理者用 CLI（DESIGN §6.5）。モデルのツールには公開しない
import { existsSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { Db } from '../broker/db.js';
import { Core } from '../broker/core.js';
import { Notifier } from '../broker/notifier.js';
import { createBroker } from '../broker/http.js';
import { dataDir, ensureDataDir, loadConfig, Provider, Duty, TokenFile } from '../shared/config.js';

const USAGE = `使い方:
  session-mail-admin serve                         ブローカーを起動する
  session-mail-admin provision --agent <id> --provider codex|claude --conversation <会話ID> [--duty coordinator|worker] [--rotate]
  session-mail-admin viewer-token [--rotate]      WebUI のログイン用トークンを表示する
  session-mail-admin status                        参加者の状態を表示する
  session-mail-admin probe <agent_id> [--wait 120] 自動受信を確認する（通知を出し、受信されるまで待つ）
  session-mail-admin export [--from ISO] [--to ISO] [--out file.json]`;

function parse(argv: string[]) {
  const o: Record<string, string> = {}; const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? 'true' : argv[++i];
    else rest.push(argv[i]);
  }
  return { o, rest };
}

const dir = () => ensureDataDir();
const lockPath = () => join(dir(), 'broker.lock');
const dbPath = () => join(dir(), 'session-mail.db');

function brokerRunning(): boolean {
  if (!existsSync(lockPath())) return false;
  const pid = Number(readFileSync(lockPath(), 'utf8'));
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function writeSecret(name: string, content: string): string {
  const p = join(dir(), 'tokens', name);
  writeFileSync(p, content, { mode: 0o600 });
  return p;
}

function adminToken(): string { return readFileSync(join(dir(), 'tokens', 'admin.token'), 'utf8').trim(); }

async function adminCall(method: string, path: string, body?: unknown) {
  const cfg = loadConfig();
  const res = await fetch(`http://127.0.0.1:${cfg.port}${path}`, {
    method, headers: { authorization: `Bearer ${adminToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
  return data;
}

// DB を直接開く操作（ブローカーが止まっているときだけ）
function withCore<T>(fn: (core: Core) => T): T {
  if (brokerRunning()) throw new Error('ブローカーが稼働中です。先に止めてから実行してください（DB を開けるのはブローカーだけです）。');
  const db = new Db(dbPath());
  try { return fn(new Core(db, loadConfig())); } finally { db.close(); }
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  const { o, rest } = parse(args);
  const cfg = loadConfig();
  switch (cmd) {
    case 'serve': {
      if (brokerRunning()) { console.error('ブローカーはすでに起動しています。'); return 2; }
      writeFileSync(lockPath(), String(process.pid));
      const db = new Db(dbPath());
      const core = new Core(db, cfg);
      if (!existsSync(join(dir(), 'tokens', 'admin.token'))) writeSecret('admin.token', core.createCredential('admin'));
      if (!existsSync(join(dir(), 'tokens', 'viewer.token'))) writeSecret('viewer.token', core.createCredential('viewer'));
      const logFile = join(dir(), 'logs', 'broker.log');
      const log = (s: string) => { const line = `${new Date().toISOString()} ${s}`; console.log(line); appendFileSync(logFile, line + '\n'); };
      const notifier = new Notifier(core, log);
      core.onSent = () => notifier.tick();
      notifier.start();
      const server = createBroker(core, notifier, log);
      server.listen(cfg.port, '127.0.0.1', () => {
        log(`session-mail ブローカー起動 http://127.0.0.1:${cfg.port}/ （データ: ${dataDir()}）`);
        log(`WebUI のログイン用トークン: session-mail-admin viewer-token で表示できます`);
      });
      const stop = () => { notifier.stop(); server.close(); db.close(); try { unlinkSync(lockPath()); } catch { /* 既に無い */ } process.exit(0); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return -1;
    }
    case 'provision': {
      const provider = o.provider as Provider, duty = (o.duty ?? 'worker') as Duty;
      if (!o.agent || !['codex', 'claude'].includes(provider) || !o.conversation || !['coordinator', 'worker'].includes(duty)) { console.error(USAGE); return 2; }
      const token = brokerRunning()
        ? (await adminCall('POST', '/api/admin/provision', { agent: o.agent, provider, conversation: o.conversation, duty, rotate: o.rotate === 'true' })).token
        : withCore(core => core.provision({ agent: o.agent, provider, conversation: o.conversation, duty, rotate: o.rotate === 'true' }));
      const tf: TokenFile = { version: 1, broker_url: `http://127.0.0.1:${cfg.port}`, agent_id: o.agent, provider, duty, token };
      const p = writeSecret(`${o.agent}.json`, JSON.stringify(tf, null, 2));
      console.log(`登録しました: ${o.agent}（${provider}、${duty}）\nトークンファイル: ${p}\n`);
      if (provider === 'codex') {
        console.log(`起動コマンド（PowerShell / bash 共通）:\n  codex resume ${o.conversation} -c "mcp_servers.session_mail.env.SESSION_MAIL_TOKEN_FILE='${p.replace(/\\/g, '/')}'"`);
      } else {
        console.log(`起動コマンド（PowerShell）:\n  $env:SESSION_MAIL_TOKEN_FILE = "${p}"\n  claude --resume ${o.conversation} --dangerously-load-development-channels server:session_mail`);
        console.log(`起動コマンド（bash）:\n  SESSION_MAIL_TOKEN_FILE="${p}" claude --resume ${o.conversation} --dangerously-load-development-channels server:session_mail`);
      }
      return 0;
    }
    case 'viewer-token': {
      if (o.rotate === 'true') withCore(core => { core.revokeCredentials('viewer', null, 'rotated'); writeSecret('viewer.token', core.createCredential('viewer')); });
      const p = join(dir(), 'tokens', 'viewer.token');
      if (!existsSync(p)) { console.error('まだ発行されていません。先に serve を一度起動してください。'); return 2; }
      console.log(readFileSync(p, 'utf8').trim());
      return 0;
    }
    case 'status': {
      const s = await adminCall('GET', '/api/admin/status');
      for (const m of s.members) {
        const n = s.notify.find((x: any) => x.agent_id === m.id);
        console.log(`${m.id.padEnd(11)} ${m.provider.padEnd(6)} ${(m.display_name ?? '-').padEnd(10)} ${m.membership.padEnd(11)} ${m.connection.padEnd(7)} 自動受信:${m.auto_receive.padEnd(10)} 未取得:${m.pending_count}  ${m.reason ?? ''}${n?.last_notify_error ? '  通知エラー:' + n.last_notify_error : ''}`);
      }
      return 0;
    }
    case 'probe': {
      const id = rest[0];
      if (!id) { console.error(USAGE); return 2; }
      const r = await adminCall('POST', '/api/admin/probe', { agent_id: id });
      console.log(`確認の通知を送りました（${r.result}）。受信を待っています…`);
      const until = Date.now() + Number(o.wait ?? 120) * 1000;
      while (Date.now() < until) {
        await new Promise(res => setTimeout(res, 2000));
        const m = (await adminCall('GET', '/api/admin/status')).members.find((x: any) => x.id === id);
        if (m?.auto_receive === 'verified') { console.log(`自動受信 確認済み（${id}）`); return 0; }
      }
      console.log(`時間内に受信を確認できませんでした（${id}）。通知: ${r.result}`);
      return 1;
    }
    case 'export': {
      const q = new URLSearchParams();
      if (o.from) q.set('from', o.from);
      if (o.to) q.set('to', o.to);
      const data = await adminCall('GET', `/api/admin/export?${q}`);
      const text = JSON.stringify(data, null, 2);
      if (o.out) { writeFileSync(o.out, text); console.log(`書き出しました: ${o.out}（${data.messages.length} 件）`); } else console.log(text);
      return 0;
    }
    default:
      console.log(USAGE);
      return cmd ? 2 : 0;
  }
}

main().then(code => { if (code >= 0) process.exitCode = code; }).catch(e => { console.error(`エラー: ${(e as Error).message}`); process.exitCode = 3; });
