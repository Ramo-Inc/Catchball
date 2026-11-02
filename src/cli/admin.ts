#!/usr/bin/env node
// 管理者用 CLI（DESIGN §6.5）。モデルのツールには公開しない
import { existsSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname, networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { sha256 } from '../shared/ids.js';
import { Db } from '../broker/db.js';
import { Core } from '../broker/core.js';
import { Notifier } from '../broker/notifier.js';
import { createBroker } from '../broker/http.js';
import { dataDir, ensureDataDir, loadConfig, Provider, Duty, TokenFile } from '../shared/config.js';

const USAGE = `使い方:
  session-mail-admin serve                         ブローカーを起動する
  session-mail-admin provision --room <ルーム> --agent <id> --provider codex|claude --conversation <会話ID> [--duty coordinator|worker] [--rotate]
  session-mail-admin viewer-token [--rotate]      WebUI のログイン用トークンを表示する
  session-mail-admin status                        参加者の状態を表示する（全ルーム）
  session-mail-admin probe <ルーム> <agent_id> [--wait 120] 自動受信を確認する（通知を出し、受信されるまで待つ）
  session-mail-admin export [--room <ルーム>] [--from ISO] [--to ISO] [--out file.json]
ルームの作成・削除・一覧は、AI に頼みます（MCP ツール channel_room_create・channel_room_delete・channel_rooms）。`;

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
// ルームを入れた版（D-018）から、新しいファイルにする。前の session-mail.db は読まずに、そのまま置いておく
const dbPath = () => join(dir(), 'session-mail-v2.db');

function brokerRunning(): boolean {
  if (!existsSync(lockPath())) return false;
  const pid = Number(readFileSync(lockPath(), 'utf8'));
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function writeSecret(name: string, content: string): string {
  const p = join(dir(), 'tokens', name);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, content, { mode: 0o600 });
  return p;
}

// ルームごとのトークンファイルのフォルダー名。ルームの ID は大文字と小文字を区別するが、Windows と macOS のファイル名は区別しないので、
// 大文字は「!＋小文字」、ドットは「~」に置き換える（「..」や末尾のドットがフォルダー名として特別扱いされないようにもする）
function roomFolder(room: string): string {
  return 'room-' + room.replace(/[A-Z]/g, c => '!' + c.toLowerCase()).replace(/\./g, '~');
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
      const fresh = !existsSync(dbPath());
      const db = new Db(dbPath());
      const core = new Core(db, cfg);
      // 管理用・閲覧用のトークンは DB の記録とひも付く。新しい DB を作ったときは発行し直す（前のファイルは使えないため）
      if (fresh || !existsSync(join(dir(), 'tokens', 'admin.token'))) writeSecret('admin.token', core.createCredential('admin'));
      if (fresh || !existsSync(join(dir(), 'tokens', 'viewer.token'))) writeSecret('viewer.token', core.createCredential('viewer'));
      const logFile = join(dir(), 'logs', 'broker.log');
      const log = (s: string) => { const line = `${new Date().toISOString()} ${s}`; console.log(line); appendFileSync(logFile, line + '\n'); };
      const notifier = new Notifier(core, log);
      core.onSent = () => notifier.tick();
      notifier.start();
      // 会話の中から参加するための参加用キー（この PC・このユーザーだけが読めるファイル）
      const joinKeyPath = join(dir(), 'tokens', 'join.key');
      if (!existsSync(joinKeyPath)) writeSecret('join.key', randomBytes(32).toString('base64url'));
      const joinKeyHash = sha256(readFileSync(joinKeyPath, 'utf8').trim());
      const server = createBroker(core, notifier, log, 'local', joinKeyHash);
      server.listen(cfg.port, '127.0.0.1', () => {
        log(`session-mail ブローカー起動 http://127.0.0.1:${cfg.port}/ （データ: ${dataDir()}）`);
        log(`WebUI のログイン用トークン: session-mail-admin viewer-token で表示できます`);
      });
      // WebUI（閲覧専用）を同じネットワークの別 PC へ公開する。AI 用・管理用の API はこちらには置かない
      let lanServer: ReturnType<typeof createBroker> | null = null;
      if (cfg.ui.lan) {
        lanServer = createBroker(core, notifier, log, 'lan');
        lanServer.on('error', e => log(`LAN 向け WebUI を起動できませんでした（ポート ${cfg.ui.port}）: ${(e as Error).message}`));
        lanServer.listen(cfg.ui.port, '0.0.0.0', () => {
          const urls = Object.values(networkInterfaces()).flat()
            .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => `http://${i!.address}:${cfg.ui.port}/`);
          urls.push(`http://${hostname()}:${cfg.ui.port}/`);
          log(`WebUI（閲覧専用）を同じネットワークに公開しました: ${urls.join('  ')}`);
          log('別の PC から開けない場合は、ファイアウォールでこのポートの受信を許可してください（この PC だけに戻すには config.json で "ui": {"lan": false}）');
        });
      }
      const stop = () => { notifier.stop(); server.close(); lanServer?.close(); db.close(); try { unlinkSync(lockPath()); } catch { /* 既に無い */ } process.exit(0); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return -1;
    }
    case 'provision': {
      const provider = o.provider as Provider, duty = (o.duty ?? 'worker') as Duty;
      if (!o.room || !o.agent || !['codex', 'claude'].includes(provider) || !o.conversation || !['coordinator', 'worker'].includes(duty)) { console.error(USAGE); return 2; }
      const args = { room: o.room, agent: o.agent, provider, conversation: o.conversation, duty, rotate: o.rotate === 'true' };
      const { token, room } = brokerRunning()
        ? await adminCall('POST', '/api/admin/provision', args)
        : withCore(core => core.provision(args));
      const tf: TokenFile = { version: 2, broker_url: `http://127.0.0.1:${cfg.port}`, room, agent_id: o.agent, provider, duty, token };
      const p = writeSecret(join(roomFolder(room), `${o.agent}.json`), JSON.stringify(tf, null, 2));
      console.log(`登録しました: ルーム ${room} の ${o.agent}（${provider}、${duty}）\nトークンファイル: ${p}\n`);
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
        const n = s.notify.find((x: any) => x.room === m.room && x.agent_id === m.id);
        console.log(`${m.room.padEnd(12)} ${m.id.padEnd(11)} ${m.provider.padEnd(6)} ${(m.display_name ?? '-').padEnd(10)} ${m.membership.padEnd(11)} ${m.connection.padEnd(7)} 自動受信:${m.auto_receive.padEnd(10)} 未取得:${m.pending_count}  ${m.reason ?? ''}${n?.last_notify_error ? '  通知エラー:' + n.last_notify_error : ''}`);
      }
      return 0;
    }
    case 'probe': {
      const [room, id] = rest;
      if (!room || !id) { console.error(USAGE); return 2; }
      const r = await adminCall('POST', '/api/admin/probe', { room, agent_id: id });
      console.log(`確認の通知を送りました（${r.result}）。受信を待っています…`);
      const until = Date.now() + Number(o.wait ?? 120) * 1000;
      while (Date.now() < until) {
        await new Promise(res => setTimeout(res, 2000));
        const m = (await adminCall('GET', '/api/admin/status')).members.find((x: any) => x.room === room && x.id === id);
        if (m?.auto_receive === 'verified') { console.log(`自動受信 確認済み（${id}）`); return 0; }
      }
      console.log(`時間内に受信を確認できませんでした（${id}）。通知: ${r.result}`);
      return 1;
    }
    case 'export': {
      const q = new URLSearchParams();
      if (o.room) q.set('room', o.room);
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
