#!/usr/bin/env node
// MCP ブリッジ（DESIGN §6）：Codex / Claude が stdio で起動する。自分の ID はトークンファイルで決まる。
// Claude のときだけ claude/channel を宣言し、ハートビートの応答に載った通知を Channel 通知として送る。
// claude/channel/permission は宣言しない（承認をメッセージで中継しない）。stdout は MCP 専用、ログは stderr。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readTokenFile } from '../shared/config.js';
import { call } from '../shared/client.js';
import { instructionsFor } from '../shared/text.js';

const VERSION = '0.1.0';
const tf = readTokenFile(process.env.SESSION_MAIL_TOKEN_FILE);
const logErr = (m: string) => process.stderr.write(`[session-mail-bridge ${tf?.agent_id ?? '?'}] ${m}\n`);

const server = new McpServer(
  { name: 'session_mail', version: VERSION },
  {
    capabilities: tf?.provider === 'claude' ? { experimental: { 'claude/channel': {} } } : {},
    instructions: instructionsFor(tf?.duty ?? 'worker'),
  },
);

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

async function tool(method: 'GET' | 'POST', path: string, body?: unknown, retry = false): Promise<ToolResult> {
  if (!tf) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'NOT_CONFIGURED', message: '接続設定が未完了です（SESSION_MAIL_TOKEN_FILE が未設定、またはファイルがありません）。', hint: '起動スクリプトでセッションを起動し直してください。' } }) }] };
  }
  const r = await call(tf, method, path, body, retry);
  return { isError: !r.ok || undefined, content: [{ type: 'text', text: JSON.stringify(r.data, null, 1) }] };
}

server.registerTool('channel_join', {
  description: '表示名と担当内容（role）を登録してチャンネルに参加する。再実行すると自分のプロフィールだけを更新する。表示名が他の参加者と重複したらエラーになり、以前の登録は維持される。応答の guide に運用指示がある。',
  inputSchema: {
    display_name: z.string().describe('表示名（1〜40文字）'),
    role: z.string().describe('担当内容。何を担当し、どんな依頼を受ける相手か（1〜200文字）'),
  },
}, async ({ display_name, role }) => tool('POST', '/api/agent/join', { display_name, role }));

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
let stopped = false;

async function beat(): Promise<void> {
  if (!tf) return;
  if (generation === 0) {
    const r = await call(tf, 'POST', '/api/agent/connect', { bridge_version: VERSION, pid: process.pid, provider: tf.provider });
    if (!r.ok) { logErr(`connect 失敗: ${JSON.stringify(r.data.error ?? r.status)}`); return; }
    generation = r.data.generation;
    logErr(`connected generation=${generation}`);
  }
  const sending = results;
  results = [];
  const r = await call(tf, 'POST', '/api/agent/heartbeat', { generation, notify_results: sending });
  if (!r.ok) {
    if (r.status !== 0) results.unshift(...sending);
    generation = 0;
    return;
  }
  const n = r.data.notify;
  if (n && tf.provider === 'claude') {
    try {
      await server.server.notification({ method: 'notifications/claude/channel', params: { content: n.content, meta: n.meta } });
      results.push({ notify_id: n.notify_id, result: 'written' });
    } catch (e) {
      results.push({ notify_id: n.notify_id, result: 'error', error: (e as Error).message });
    }
  }
}

async function shutdown(): Promise<void> {
  if (stopped) return;
  stopped = true;
  if (tf && generation > 0) {
    await Promise.race([call(tf, 'POST', '/api/agent/disconnect', { generation }), new Promise(r => setTimeout(r, 1000))]);
  }
  process.exit(0);
}

await server.connect(new StdioServerTransport());
if (tf) {
  logErr(`started provider=${tf.provider} broker=${tf.broker_url}`);
  void beat();
  setInterval(() => void beat(), 5000);
} else {
  logErr('SESSION_MAIL_TOKEN_FILE が未設定のため、ブローカーには接続しません。');
}
process.stdin.on('end', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
