#!/usr/bin/env node
// MCP ブリッジ（DESIGN §6）：Codex / Claude が stdio で起動する、普通の MCP サーバー。
// 参加のしかたは2通り：
//   1. 会話の中で channel_join を呼ぶ（通常）。この PC のデータフォルダーにある参加用キーで認証し、固定 ID を割り当ててもらう
//   2. 環境変数 SESSION_MAIL_TOKEN_FILE でトークンファイルを渡して起動する（従来の方法）
// Claude には claude/channel を宣言し、ハートビートの応答に載った通知を Channel 通知として送る。
// claude/channel/permission は宣言しない（承認をメッセージで中継しない）。stdout は MCP 専用、ログは stderr。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Duty, Provider, TokenFile, dataDir, loadConfig, readTokenFile } from '../shared/config.js';
import { call } from '../shared/client.js';
import { COMMON_GUIDE } from '../shared/text.js';

const VERSION = '0.2.0';
let bound: TokenFile | null = readTokenFile(process.env.SESSION_MAIL_TOKEN_FILE);
const logErr = (m: string) => process.stderr.write(`[session-mail-bridge ${bound?.agent_id ?? 'unbound'}] ${m}\n`);

const server = new McpServer(
  { name: 'session_mail', version: VERSION },
  {
    // Claude 以外のクライアントは未知の experimental 機能を無視する
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions: `${COMMON_GUIDE}\n\n参加していない場合は、ユーザーに頼まれたときに channel_join で参加します。参加すると、役割に応じた運用指示（guide）が返ります。`,
  },
);

// 接続してきたのが Claude か Codex か（環境変数で上書きできる）
function provider(): Provider {
  if (bound) return bound.provider;
  const env = process.env.SESSION_MAIL_PROVIDER;
  if (env === 'claude' || env === 'codex') return env;
  return /claude/i.test(server.server.getClientVersion()?.name ?? '') ? 'claude' : 'codex';
}

function brokerUrl(): string {
  return `http://127.0.0.1:${loadConfig().port}`;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const result = (data: unknown, isError = false): ToolResult => ({ isError: isError || undefined, content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] });

async function tool(method: 'GET' | 'POST', path: string, body?: unknown, retry = false): Promise<ToolResult> {
  if (!bound) return result({ error: { code: 'NOT_JOINED', message: 'まだチャンネルに参加していません。', hint: 'channel_join で参加してください。' } }, true);
  const r = await call(bound, method, path, body, retry);
  return result(r.data, !r.ok);
}

server.registerTool('channel_join', {
  description: [
    '表示名と担当内容（role）を登録して、チャンネル（キャッチボール）に参加する。参加済みなら自分のプロフィールだけを更新する。',
    'agent_id は英小文字・数字・ハイフンの固定 ID（例 codex-main, claude-1）。ユーザーに指定されたものを使い、なければ省略する（自動で割り当てる）。',
    'Codex の場合は conversation_id に自分の会話 ID を必ず入れる：シェルで echo $CODEX_THREAD_ID（PowerShell は $env:CODEX_THREAD_ID）を実行して得た値。',
    '統括（ユーザーと対話し、仕事を振り分ける役）として参加するときは coordinator=true。応答の guide に運用指示がある。',
  ].join(' '),
  inputSchema: {
    display_name: z.string().describe('表示名（1〜40文字）'),
    role: z.string().describe('担当内容。何を担当し、どんな依頼を受ける相手か（1〜200文字）'),
    agent_id: z.string().optional().describe('固定 ID（例 claude-1）。省略すると自動で割り当てる'),
    conversation_id: z.string().optional().describe('Codex のみ必須：$CODEX_THREAD_ID の値'),
    coordinator: z.boolean().optional().describe('統括として参加するなら true'),
  },
}, async a => {
  if (bound) return tool('POST', '/api/agent/join', { display_name: a.display_name, role: a.role });
  const keyPath = join(dataDir(), 'tokens', 'join.key');
  if (!existsSync(keyPath)) {
    return result({ error: { code: 'BROKER_NOT_READY', message: 'キャッチボールのブローカーがこの PC で起動していません。', hint: 'ユーザーに session-mail-admin serve の起動を頼んでください。' } }, true);
  }
  const key = readFileSync(keyPath, 'utf8').trim();
  const url = brokerUrl();
  const r = await call({ version: 1, broker_url: url, agent_id: '', provider: provider(), duty: 'worker', token: key }, 'POST', '/api/join/self',
    { provider: provider(), ...a });
  if (!r.ok) return result(r.data, true);
  const { token, agent_id, duty, ...rest } = r.data as { token: string; agent_id: string; duty: Duty };
  bound = { version: 1, broker_url: url, agent_id, provider: provider(), duty, token };
  logErr(`joined as ${agent_id}`);
  void beat();
  return result({ agent_id, ...rest });
});

server.registerTool('channel_members', {
  description: '自分を含む参加者の固定ID・表示名・役割・接続・送信可否と理由を返す。宛先は表示名ではなく、ここで返る id で指定する。',
  inputSchema: {},
}, async () => tool('GET', '/api/agent/members'));

server.registerTool('channel_send', {
  description: '個別（to=固定ID）または全員（to="all"）へ送る。返信・報告では元の依頼の message_id を reply_to に入れる。client_message_id は送信ごとに一意にし、同じ値で再送すると同じ結果が返る（投稿は増えない）。',
  inputSchema: {
    to: z.string().describe('宛先の固定ID、または "all"'),
    body: z.string().describe('本文。1行目に [依頼 T-01] などの表題タグを付ける'),
    client_message_id: z.string().describe('送信ごとに一意な文字列（例 codex-main-T01-req-1）'),
    reply_to: z.string().optional().describe('返信元の message_id'),
  },
}, async a => tool('POST', '/api/agent/send', a, true));

server.registerTool('channel_receive', {
  description: '自分宛ての未取得メッセージの本文を古い順に返す。remaining が 0 になるまで繰り返す。receive_count が 2 以上なら以前にも受け取った同じメッセージ。',
  inputSchema: { limit: z.number().int().min(1).max(50).optional() },
}, async ({ limit }) => tool('POST', '/api/agent/receive', { limit }));

server.registerTool('channel_ack', {
  description: '本文を取得したことを記録する。依頼の完了報告ではない（完了は channel_send で報告する）。',
  inputSchema: { message_ids: z.array(z.string()).min(1).max(100) },
}, async ({ message_ids }) => tool('POST', '/api/agent/ack', { message_ids }));

server.registerTool('channel_leave', {
  description: 'チャンネルから退出する。自分宛ての未取得は配送停止になる。ユーザーまたは統括に指示されたときだけ使う。',
  inputSchema: { confirm: z.literal(true) },
}, async () => tool('POST', '/api/agent/leave', { confirm: true }));

// ---- ハートビート ------------------------------------------------------------
let generation = 0;
let results: { notify_id: string; result: 'written' | 'error'; error?: string }[] = [];
let beating = false;
let stopped = false;

async function beat(): Promise<void> {
  if (!bound || beating) return;
  beating = true;
  try {
    if (generation === 0) {
      const r = await call(bound, 'POST', '/api/agent/connect', { bridge_version: VERSION, pid: process.pid, provider: bound.provider });
      if (!r.ok) { logErr(`connect 失敗: ${JSON.stringify(r.data.error ?? r.status)}`); return; }
      generation = r.data.generation;
      logErr(`connected generation=${generation}`);
    }
    const sending = results;
    results = [];
    const r = await call(bound, 'POST', '/api/agent/heartbeat', { generation, notify_results: sending });
    if (!r.ok) {
      if (r.status !== 0) results.unshift(...sending);
      generation = 0;
      return;
    }
    const n = r.data.notify;
    if (n && bound.provider === 'claude') {
      try {
        await server.server.notification({ method: 'notifications/claude/channel', params: { content: n.content, meta: n.meta } });
        results.push({ notify_id: n.notify_id, result: 'written' });
      } catch (e) {
        results.push({ notify_id: n.notify_id, result: 'error', error: (e as Error).message });
      }
    }
  } finally {
    beating = false;
  }
}

async function shutdown(): Promise<void> {
  if (stopped) return;
  stopped = true;
  if (bound && generation > 0) {
    await Promise.race([call(bound, 'POST', '/api/agent/disconnect', { generation }), new Promise(r => setTimeout(r, 1000))]);
  }
  process.exit(0);
}

await server.connect(new StdioServerTransport());
logErr(bound ? `started with token file (provider=${bound.provider})` : 'started; waiting for channel_join');
setInterval(() => void beat(), 5000);
void beat();
process.stdin.on('end', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
