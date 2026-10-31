// PoC ブリッジ：Codex / Claude が stdio で起動する MCP サーバー。
// 自分の ID は環境変数 POC_AGENT_ID で決まる。Claude のときだけ claude/channel を宣言し、
// ブローカーのハートビート応答に載った通知を notifications/claude/channel として送る。
// stdout は MCP 専用。ログはすべて stderr に出す。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { HEARTBEAT_INTERVAL_MS, INSTRUCTIONS, Provider, brokerUrl, postJson } from './common.js';

const AGENT = process.env.POC_AGENT_ID?.trim() || '';
const PROVIDER: Provider = process.env.POC_PROVIDER === 'claude' ? 'claude' : 'codex';
const BROKER = brokerUrl();

const logErr = (msg: string) => process.stderr.write(`[poc-bridge ${AGENT || '?'}] ${msg}\n`);

const server = new McpServer(
  { name: 'poc_mail', version: '0.1.0' },
  {
    // claude/channel/permission は宣言しない（承認をメッセージで中継しない）
    capabilities: PROVIDER === 'claude' ? { experimental: { 'claude/channel': {} } } : {},
    instructions: INSTRUCTIONS,
  },
);

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true });

async function call(path: string, body: Record<string, unknown>): Promise<ToolResult> {
  if (!AGENT) return fail('POC_AGENT_ID が未設定です。起動方法（POC_PLAN.md §4）を確認してください。');
  try {
    const { status, data } = await postJson(`${BROKER}${path}`, { agent: AGENT, via: 'mcp', ...body });
    return status === 200 ? ok(data) : fail((data as { error?: string }).error ?? `HTTP ${status}`);
  } catch (e) {
    return fail(`ブローカーに接続できません（${BROKER}）: ${(e as Error).message}`);
  }
}

server.registerTool(
  'poc_whoami',
  { description: 'このセッションが通信チャンネルで名乗っている ID を返す。', inputSchema: {} },
  async () => call('/whoami', {}),
);

server.registerTool(
  'poc_send',
  {
    description: '他の参加者へメッセージを送る。返信のときは元の message_id を reply_to に入れる。',
    inputSchema: {
      to: z.string().describe('宛先の ID（例 claude-a, codex-b）'),
      body: z.string().min(1).describe('本文'),
      reply_to: z.string().optional().describe('返信元の message_id'),
    },
  },
  async ({ to, body, reply_to }) => {
    if (!AGENT) return fail('POC_AGENT_ID が未設定です。');
    // send だけは from が必要なので call() を使わずに組み立てる
    try {
      const { status, data } = await postJson(`${BROKER}/send`, { from: AGENT, to, body, reply_to, via: 'mcp' });
      return status === 200 ? ok(data) : fail((data as { error?: string }).error ?? `HTTP ${status}`);
    } catch (e) {
      return fail(`ブローカーに接続できません（${BROKER}）: ${(e as Error).message}`);
    }
  },
);

server.registerTool(
  'poc_receive',
  { description: '自分宛ての未取得メッセージの本文を取得する。読んだら poc_ack すること。', inputSchema: {} },
  async () => call('/receive', {}),
);

server.registerTool(
  'poc_ack',
  {
    description: '本文を取得したことを記録する（依頼の完了報告ではない）。',
    inputSchema: { message_ids: z.array(z.string()).min(1).describe('取得した message_id の一覧') },
  },
  async ({ message_ids }) => call('/ack', { message_ids }),
);

// ---- ハートビート ------------------------------------------------------------

let generation = 0;
let pendingResults: { notify_id: string; result: 'written' | 'error'; error?: string }[] = [];
let stopped = false;

async function connect(): Promise<boolean> {
  try {
    const { status, data } = await postJson<{ generation: number; error?: string }>(`${BROKER}/connect`, {
      agent: AGENT, provider: PROVIDER, pid: process.pid,
    });
    if (status !== 200) {
      logErr(`connect 失敗: ${data.error ?? status}`);
      return false;
    }
    generation = data.generation;
    logErr(`connected generation=${generation}`);
    return true;
  } catch (e) {
    logErr(`ブローカーに接続できません: ${(e as Error).message}`);
    return false;
  }
}

async function beat(): Promise<void> {
  if (generation === 0 && !(await connect())) return;
  try {
    const results = pendingResults;
    pendingResults = [];
    const { status, data } = await postJson<{
      notify?: { notify_id: string; content: string; meta: Record<string, string> } | null;
    }>(`${BROKER}/heartbeat`, { agent: AGENT, generation, results });
    if (status === 409 || status === 404) {
      generation = 0;                       // 世代切れ・未登録 → 次回 connect し直す
      return;
    }
    const n = data.notify;
    if (n && PROVIDER === 'claude') {
      try {
        await server.server.notification({
          method: 'notifications/claude/channel',
          params: { content: n.content, meta: n.meta },
        });
        pendingResults.push({ notify_id: n.notify_id, result: 'written' });
      } catch (e) {
        pendingResults.push({ notify_id: n.notify_id, result: 'error', error: (e as Error).message });
      }
    }
  } catch (e) {
    generation = 0;
    logErr(`heartbeat 失敗: ${(e as Error).message}`);
  }
}

async function shutdown(): Promise<void> {
  if (stopped) return;
  stopped = true;
  if (AGENT && generation > 0) {
    await Promise.race([
      postJson(`${BROKER}/disconnect`, { agent: AGENT, generation }).catch(() => undefined),
      new Promise(r => setTimeout(r, 1000)),
    ]);
  }
  process.exit(0);
}

await server.connect(new StdioServerTransport());
logErr(`started provider=${PROVIDER} broker=${BROKER}`);

if (AGENT) {
  void beat();
  setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
} else {
  logErr('POC_AGENT_ID が未設定のため、ブローカーには接続しません。');
}

process.stdin.on('end', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
