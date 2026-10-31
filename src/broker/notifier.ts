// 受信通知（DESIGN §4.8 に PoC の結果を反映）
// - 通知は「未取得がある」ことだけを伝え、本文は含めない
// - 受信されていない通知は宛先ごとに1件まで。新着の判定は「一度も受信されていないもの」だけで行う
// - Codex は時間による再通知をしない（queue は永続的で、アイドルになれば必ず処理されるため）
// - 直前にツールを使っていた Codex には少し待ってから通知する（ターン内で自分で受信することが多いため）
import { execFile } from 'node:child_process';
import { Core } from './core.js';
import { Row } from './db.js';
import { newNotifyId } from '../shared/ids.js';
import { PROBE_TEXT, noticeText } from '../shared/text.js';

export interface ChannelNotify { notify_id: string; content: string; meta: Record<string, string> }

export class Notifier {
  private inflight = new Set<string>();
  readonly pendingChannel = new Map<string, ChannelNotify>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private core: Core, private log: (msg: string) => void = () => {}) {}

  start(): void {
    this.timer = setInterval(() => { this.core.sweep(); this.tick(); }, 1000);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  tick(): void {
    const db = this.core.db;
    for (const p of db.all("SELECT * FROM participants WHERE membership = 'joined'")) {
      if (this.inflight.has(p.agent_id) || !this.core.isOnline(p) || p.activity_state === 'awaiting_approval') continue;
      const pend = db.get(`SELECT COUNT(*) n, MAX(created_seq) max_seq FROM deliveries WHERE recipient_id = ? AND state = 'pending'`, p.agent_id)!;
      if (!pend.n) continue;
      const ns = db.get('SELECT * FROM notify_state WHERE agent_id = ?', p.agent_id)!;
      const fresh = db.get(`SELECT COUNT(*) n, MAX(m.created_at) newest FROM deliveries d JOIN messages m USING (message_id)
        WHERE d.recipient_id = ? AND d.state = 'pending' AND d.first_received_at IS NULL AND d.created_seq > ?`, p.agent_id, ns.known_seq)!;
      const now = this.core.now();
      const cfg = this.core.cfg.notify;
      let reason: 'reconnect' | 'new' | 'renotify' | null = null;
      if (ns.force_on_connect) reason = 'reconnect';
      else if (!ns.outstanding_notify_id && fresh.n > 0 && now - fresh.newest >= cfg.debounce_ms) reason = 'new';
      else if (p.provider === 'claude' && ns.outstanding_notify_id && ns.last_notify_at
        && now >= ns.last_notify_at + cfg.claude_renotify_backoff_ms[Math.min(ns.renotify_streak, cfg.claude_renotify_backoff_ms.length - 1)]) reason = 'renotify';
      if (!reason) continue;
      if (reason === 'new' && p.provider === 'codex' && now - (this.core.lastToolAt.get(p.agent_id) ?? 0) < cfg.codex_quiet_after_tool_ms) continue;
      void this.dispatch(p, reason, pend.n, pend.max_seq);
    }
  }

  probe(agentId: string): Promise<{ notify_id: string; result: string }> {
    const p = this.core.participant(agentId);
    if (!p) throw new Error(`${agentId} は登録されていません`);
    return this.dispatch(p, 'probe', 0, null);
  }

  private async dispatch(p: Row, reason: string, unread: number, maxSeq: number | null): Promise<{ notify_id: string; result: string }> {
    const db = this.core.db;
    const notify_id = newNotifyId();
    const senders = reason === 'probe' ? [] : db.all(`SELECT DISTINCT m.sender_id FROM deliveries d JOIN messages m USING (message_id)
      WHERE d.recipient_id = ? AND d.state = 'pending' ORDER BY m.sender_id`, p.agent_id).map(r => r.sender_id);
    const text = reason === 'probe' ? PROBE_TEXT : noticeText(unread, senders);
    this.inflight.add(p.agent_id);
    db.run(`UPDATE notify_state SET outstanding_notify_id = COALESCE(outstanding_notify_id, ?), outstanding_since = COALESCE(outstanding_since, ?),
      outstanding_generation = ?, force_on_connect = 0, known_seq = MAX(known_seq, ?) WHERE agent_id = ?`,
      notify_id, this.core.now(), p.conn_generation, maxSeq ?? 0, p.agent_id);

    let result: string, error: string | null = null;
    if (p.receiver_kind === 'claude_channel') {
      this.pendingChannel.set(p.agent_id, { notify_id, content: text, meta: { kind: reason === 'probe' ? 'probe' : 'mail_notice', notify_id, unread: String(unread) } });
      result = 'handed_to_bridge';
    } else {
      const r = await this.codexQueue(p.conversation_id, text);
      result = r.ok ? 'queued_ok' : 'failed';
      error = r.error;
    }
    this.record(p.agent_id, notify_id, reason, result, error);
    this.inflight.delete(p.agent_id);
    this.log(`notify ${p.agent_id} ${reason} ${result}${error ? ' ' + error : ''}`);
    return { notify_id, result };
  }

  private codexQueue(thread: string, text: string): Promise<{ ok: boolean; error: string | null }> {
    const [cmd, ...pre] = this.core.cfg.codex.command;
    return new Promise(resolve => {
      execFile(cmd, [...pre, 'queue', '--thread', thread, '--message', text],
        { timeout: this.core.cfg.codex.queue_timeout_ms, windowsHide: true, shell: false },
        (err, _out, stderr) => resolve(err ? { ok: false, error: classify(String(stderr || err.message)) } : { ok: true, error: null }));
    });
  }

  // ブリッジからの結果（Claude）や codex queue の結果を記録する
  record(agentId: string, notifyId: string, reason: string | null, result: string, error: string | null): void {
    const db = this.core.db;
    const failed = result === 'failed' || result === 'error';
    db.tx(() => {
      const ns = db.get('SELECT * FROM notify_state WHERE agent_id = ?', agentId)!;
      const failures = failed ? ns.consecutive_failures + 1 : 0;
      db.run(`UPDATE notify_state SET last_notify_at = ?, last_notify_reason = COALESCE(?, last_notify_reason), last_notify_result = ?, last_notify_error = ?,
        consecutive_failures = ?, renotify_streak = renotify_streak + ? ${failed ? ', outstanding_notify_id = NULL' : ''} WHERE agent_id = ?`,
        this.core.now(), reason, failed ? 'failed' : result, error, failures, reason === 'renotify' ? 1 : 0, agentId);
      const p = this.core.participant(agentId)!;
      if (failed && failures >= this.core.cfg.notify.failing_after_consecutive_failures) {
        db.run("UPDATE participants SET receiver_state = 'failing', receiver_detail = ? WHERE agent_id = ?", error ?? '通知の書き込みに失敗', agentId);
      } else if (!failed && p.receiver_state === 'failing') {
        db.run("UPDATE participants SET receiver_state = 'unverified', receiver_detail = NULL WHERE agent_id = ?", agentId);
      }
      if (reason !== null && reason !== 'probe') {
        const ids = db.all("SELECT message_id FROM deliveries WHERE recipient_id = ? AND state = 'pending'", agentId).map(r => r.message_id);
        db.run("UPDATE deliveries SET notify_count = notify_count + 1, last_notify_at = ?, last_notify_result = ? WHERE recipient_id = ? AND state = 'pending'",
          this.core.now(), failed ? 'failed' : result, agentId);
        for (const id of ids) db.run('UPDATE messages SET updated_seq = ? WHERE message_id = ?', db.nextSeq(), id);
      } else if (reason === null) {
        db.run("UPDATE deliveries SET last_notify_result = ? WHERE recipient_id = ? AND state = 'pending' AND last_notify_result = 'handed_to_bridge'",
          failed ? 'failed' : result, agentId);
      }
    });
  }
}

function classify(stderr: string): string {
  const s = stderr.replace(/\s+/g, ' ').slice(0, 300);
  if (/ENOENT/.test(s)) return 'codex コマンドが見つかりません（config.json の codex.command を確認）';
  if (/thread not found/i.test(s)) return 'Codex の会話が見つかりません（登録した会話IDを確認）';
  if (/unarchive/i.test(s)) return 'Codex の会話がアーカイブされています（codex unarchive が必要）';
  return s;
}
