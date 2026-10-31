#!/usr/bin/env node
// AI・人向けの最小 CLI（DESIGN §6.4）。MCP と同じ API を呼ぶ。公開するのは6操作だけ
import { readFileSync } from 'node:fs';
import { readTokenFile } from '../shared/config.js';
import { call } from '../shared/client.js';

const USAGE = `使い方（トークンは --token-file か SESSION_MAIL_TOKEN_FILE で指定）:
  session-mail join --name <表示名> --role <役割>
  session-mail members
  session-mail send --to <固定ID|all> --id <client_message_id> (--body <本文> | --body-file <パス|->) [--reply-to <message_id>]
  session-mail receive [--limit 10]
  session-mail ack <message_id> [...]
  session-mail leave --confirm`;

function parse(argv: string[]) {
  const o: Record<string, string> = {}; const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? 'true' : argv[++i];
    else rest.push(argv[i]);
  }
  return { o, rest };
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  const { o, rest } = parse(args);
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(USAGE); return 0; }
  const tf = readTokenFile(o['token-file'] ?? process.env.SESSION_MAIL_TOKEN_FILE);
  if (!tf) { console.error('トークンファイルが見つかりません（--token-file か SESSION_MAIL_TOKEN_FILE を指定してください）。'); return 3; }
  let r;
  switch (cmd) {
    case 'join': r = await call(tf, 'POST', '/api/agent/join', { display_name: o.name, role: o.role }); break;
    case 'members': r = await call(tf, 'GET', '/api/agent/members'); break;
    case 'send': {
      const body = o['body-file'] ? readFileSync(o['body-file'] === '-' ? 0 : o['body-file'], 'utf8') : o.body;
      r = await call(tf, 'POST', '/api/agent/send', { to: o.to, body, client_message_id: o.id, reply_to: o['reply-to'] }, true);
      break;
    }
    case 'receive': r = await call(tf, 'POST', '/api/agent/receive', { limit: o.limit ? Number(o.limit) : undefined }); break;
    case 'ack': r = await call(tf, 'POST', '/api/agent/ack', { message_ids: rest }); break;
    case 'leave':
      if (o.confirm !== 'true') { console.error('退出するには --confirm を付けてください。'); return 2; }
      r = await call(tf, 'POST', '/api/agent/leave', { confirm: true }); break;
    default: console.error(USAGE); return 2;
  }
  console.log(JSON.stringify(r.data, null, 2));
  return r.ok ? 0 : r.status === 0 ? 4 : r.status === 401 ? 3 : 2;
}

main().then(code => { process.exitCode = code; });
