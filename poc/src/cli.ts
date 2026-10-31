// PoC 観察用 CLI：register / send / status / log / wait
import { USER_TEST_SENDER, brokerUrl, getJson, postJson } from './common.js';

const [, , cmd, ...rest] = process.argv;
const BROKER = brokerUrl();

function opts(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) o[args[i].slice(2)] = args[i + 1]?.startsWith('--') || args[i + 1] === undefined ? 'true' : args[++i];
  }
  return o;
}

function parseSince(s: string | undefined): number {
  if (!s) return 0;
  const m = /^(\d+)([smh])$/.exec(s);
  if (!m) throw new Error('--since は 30s / 5m / 1h の形で指定してください');
  return Date.now() - Number(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2] as 's' | 'm' | 'h'];
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString('ja-JP', { hour12: false }) + '.' + iso.slice(20, 23);
}

const USAGE = `使い方:
  cli.js register --agent <id> --provider codex|claude --thread <会話ID>
  cli.js send --to <id> --body "<本文>" [--from user-test] [--reply-to <message_id>]
  cli.js status
  cli.js log [--since 5m] [--json]
  cli.js wait --message <message_id> [--timeout 60]   送ったメッセージが ACK されるまで待ち、経過を表示する`;

async function main(): Promise<void> {
  const o = opts(rest);
  switch (cmd) {
    case 'register': {
      const { status, data } = await postJson(`${BROKER}/register`, { agent: o.agent, provider: o.provider, thread: o.thread });
      console.log(status === 200 ? `登録しました: ${o.agent} (${o.provider}, ${o.thread})` : JSON.stringify(data));
      process.exitCode = status === 200 ? 0 : 2;
      return;
    }
    case 'send': {
      const { status, data } = await postJson<{ message_id?: string; recipient_online?: boolean; error?: string }>(`${BROKER}/send`, {
        from: o.from ?? USER_TEST_SENDER, to: o.to, body: o.body, reply_to: o['reply-to'], via: 'cli',
      });
      if (status !== 200) {
        console.log(`送信失敗: ${data.error}`);
        process.exitCode = 2;
        return;
      }
      console.log(`送信しました: ${data.message_id} → ${o.to}${data.recipient_online ? '' : '（宛先は未接続です。接続後に通知されます）'}`);
      console.log(`ACK まで待つには: node dist/cli.js wait --message ${data.message_id}`);
      return;
    }
    case 'status': {
      const { data } = await getJson<{ now: string; codex_bin: string; agents: any[] }>(`${BROKER}/status`);
      console.log(`ブローカー時刻 ${data.now} / codex: ${data.codex_bin}`);
      if (data.agents.length === 0) console.log('（登録済みのエージェントはいません）');
      for (const a of data.agents) {
        const conn = a.connected ? `接続中(世代${a.generation})` : '未接続';
        const ln = a.last_notify ? `最後の通知: ${a.last_notify.result}${a.last_notify.duration_ms != null ? ` ${a.last_notify.duration_ms}ms` : ''}${a.last_notify.error ? ` エラー: ${a.last_notify.error}` : ''}` : '通知なし';
        console.log(`- ${a.agent.padEnd(9)} ${a.provider.padEnd(6)} ${conn.padEnd(12)} 未取得 ${a.pending}${a.outstanding ? '（通知済み・受信待ち）' : ''}  ${ln}`);
      }
      return;
    }
    case 'log': {
      const { data } = await getJson<{ events: any[] }>(`${BROKER}/log?since_ms=${parseSince(o.since)}`);
      for (const e of data.events) {
        if (o.json) { console.log(JSON.stringify(e)); continue; }
        const { t, iso, type, ...f } = e;
        console.log(`${time(iso)}  ${type.padEnd(15)} ${JSON.stringify(f)}`);
      }
      return;
    }
    case 'wait': {
      const timeout = Number(o.timeout ?? 60) * 1000;
      const start = Date.now();
      const seen = new Set<string>();
      let sentAt: number | null = null;
      while (Date.now() - start < timeout) {
        const { data } = await getJson<{ events: any[] }>(`${BROKER}/log?since_ms=${start - 600000}`);
        const target = data.events.find(e => e.type === 'send' && e.message_id === o.message);
        if (!target) { console.log(`message_id が見つかりません: ${o.message}`); process.exitCode = 2; return; }
        sentAt ??= target.t;
        for (const e of data.events) {
          if (e.t < target.t || seen.has(`${e.t}${e.type}`)) continue;
          const relevant = e.agent === target.to || e.message_id === o.message || (e.type === 'send' && e.reply_to === o.message);
          if (!relevant) continue;
          seen.add(`${e.t}${e.type}`);
          const label = e.type === 'send' && e.reply_to === o.message ? 'reply(返信)' : e.type;
          console.log(`+${((e.t - sentAt!) / 1000).toFixed(1).padStart(5)}s  ${label.padEnd(15)} ${e.result ?? ''}${e.error ? ' ' + e.error : ''}`);
          if (e.type === 'ack' && e.results?.some((r: any) => r.message_id === o.message)) {
            console.log(`→ ACK されました（送信から ${((e.t - sentAt!) / 1000).toFixed(1)} 秒）`);
            return;
          }
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      console.log(`→ ${timeout / 1000} 秒以内に ACK されませんでした`);
      process.exitCode = 1;
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 2 : 0;
  }
}

main().catch(e => {
  console.error(`エラー: ${(e as Error).message}（ブローカー ${BROKER} は起動していますか）`);
  process.exitCode = 3;
});
