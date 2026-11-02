// 業務処理（DESIGN §4）：参加・送信・受信（取得したら既読）・接続・表示用の集計
import { Db, Row } from './db.js';
import { Config, Duty, Provider } from '../shared/config.js';
import { newMessageId, newToken, parseToken, safeEqualHex, sha256 } from '../shared/ids.js';
import {
  ApiError, checkAgentId, checkBody, checkClientId, checkMessageId, checkTo, normalizeName, normalizeRole,
} from '../shared/validation.js';
import { guideFor } from '../shared/text.js';

export type Delivery = 'ready' | 'queued' | 'unavailable';

export interface MemberView {
  id: string; display_name: string | null; role: string | null; provider: Provider;
  membership: string; connection: 'online' | 'offline'; last_seen_at: number | null;
  auto_receive: string; activity: string; can_send: boolean; delivery: Delivery; reason: string | null;
  is_self?: boolean; pending_count?: number;
}

const REASON = {
  self: '自分自身には送信できません',
  provisioned: '未参加（まだ join していません）',
  left: '退出済み',
  offline: '切断中。再接続後に通知します',
  approval: '承認待ち。通知を保留しています',
  interrupted: '中断後のため停止中（ユーザーの入力で再開します）',
  unverified: '自動受信は未確認です（通知後の受信をまだ確認できていません）',
  not_configured: '自動受信は未準備です',
};

export class Core {
  // 接続状態はメモリで持つ（REVIEW-2 N4）。起動直後は全員 offline
  private lastSeen = new Map<string, number>();
  // Codex 向けの通知を遅らせる判断に使う（PoC R2）
  readonly lastToolAt = new Map<string, number>();
  onSent: (recipients: string[]) => void = () => {};

  constructor(readonly db: Db, readonly cfg: Config, readonly now: () => number = Date.now) {
    db.run("UPDATE participants SET conn_state = 'offline' WHERE conn_state = 'online'");
  }

  // ---- 資格情報 ---------------------------------------------------------------

  createCredential(kind: 'agent' | 'viewer' | 'admin' | 'ui_session', agentId: string | null = null, ttlMs?: number): string {
    const t = newToken();
    this.db.run('INSERT INTO credentials (credential_id, kind, agent_id, secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      t.credentialId, kind, agentId, t.hash, this.now(), ttlMs ? this.now() + ttlMs : null);
    return t.token;
  }

  revokeCredentials(kind: string, agentId: string | null, reason: string): void {
    this.db.run(`UPDATE credentials SET revoked_at = ?, revoked_reason = ? WHERE kind = ? AND revoked_at IS NULL ${agentId ? 'AND agent_id = ?' : ''}`,
      ...[this.now(), reason, kind, ...(agentId ? [agentId] : [])]);
  }

  verify(token: string | undefined, kind: string): Row {
    const parsed = token ? parseToken(token) : null;
    const c = parsed ? this.db.get('SELECT * FROM credentials WHERE credential_id = ?', parsed.credentialId) : undefined;
    if (!parsed || !c || c.kind !== kind || c.revoked_at || (c.expires_at && c.expires_at < this.now()) || !safeEqualHex(c.secret_hash, sha256(parsed.secret))) {
      throw new ApiError('UNAUTHENTICATED', 401, '認証に失敗しました。', '接続設定（トークンファイル）を確認してください。');
    }
    return c;
  }

  agentFromToken(token: string | undefined): Row {
    const c = this.verify(token, 'agent');
    return this.participant(c.agent_id)!;
  }

  // ---- 参加者 -----------------------------------------------------------------

  provision(o: { agent: string; provider: Provider; conversation: string; duty: Duty; rotate?: boolean }): string {
    checkAgentId(o.agent);
    return this.db.tx(() => {
      const existing = this.participant(o.agent);
      if (existing && !o.rotate) throw new ApiError('INVALID_ARGUMENT', 400, `${o.agent} は登録済みです。トークンを再発行するには --rotate を付けてください。`);
      if (existing) {
        this.db.run('UPDATE participants SET provider = ?, conversation_id = ?, duty = ?, receiver_kind = ? WHERE agent_id = ?',
          o.provider, o.conversation, o.duty, o.provider === 'codex' ? 'codex_queue' : 'claude_channel', o.agent);
        this.revokeCredentials('agent', o.agent, 'rotated');
      } else {
        this.db.run('INSERT INTO participants (agent_id, channel_id, provider, duty, conversation_id, receiver_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          o.agent, this.cfg.channel_id, o.provider, o.duty, o.conversation, o.provider === 'codex' ? 'codex_queue' : 'claude_channel', this.now());
        this.db.run('INSERT INTO notify_state (agent_id) VALUES (?)', o.agent);
      }
      return this.createCredential('agent', o.agent);
    });
  }

  // 会話の中から「参加して」と頼まれたときの参加（トークンファイルなしで起動したブリッジ用）。
  // 参加用のキーはブリッジがこの PC のデータフォルダーから読む。同じ固定 ID が接続中なら断る。
  selfJoin(o: { provider: unknown; agent_id?: unknown; display_name: unknown; role: unknown; conversation_id?: unknown; coordinator?: unknown }) {
    const provider = o.provider === 'claude' ? 'claude' : o.provider === 'codex' ? 'codex' : null;
    if (!provider) throw new ApiError('INVALID_ARGUMENT', 400, 'provider は codex か claude です。');
    normalizeName(o.display_name);
    normalizeRole(o.role);
    const conv = typeof o.conversation_id === 'string' ? o.conversation_id.trim() : '';
    let agentId: string;
    if (o.agent_id != null && o.agent_id !== '') agentId = checkAgentId(o.agent_id);
    else {
      let n = 1;
      while (this.participant(`${provider}-${n}`)) n++;
      agentId = `${provider}-${n}`;
    }
    const token = this.db.tx(() => {
      const p = this.participant(agentId);
      if (p) {
        if (p.provider !== provider) throw new ApiError('INVALID_ARGUMENT', 400, `${agentId} は ${p.provider} 用の ID です。別の ID を指定してください。`);
        if (this.isOnline(p)) throw new ApiError('AGENT_IN_USE', 409, `${agentId} は別のセッションが接続中です。`, '別の固定 ID（agent_id）を指定してください。');
        if (conv) this.db.run('UPDATE participants SET conversation_id = ? WHERE agent_id = ?', conv, agentId);
        if (o.coordinator === true) this.db.run("UPDATE participants SET duty = 'coordinator' WHERE agent_id = ?", agentId);
        this.revokeCredentials('agent', agentId, 'self_join');
      } else {
        this.db.run('INSERT INTO participants (agent_id, channel_id, provider, duty, conversation_id, receiver_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          agentId, this.cfg.channel_id, provider, o.coordinator === true ? 'coordinator' : 'worker', conv, provider === 'codex' ? 'codex_queue' : 'claude_channel', this.now());
        this.db.run('INSERT INTO notify_state (agent_id) VALUES (?)', agentId);
      }
      // Codex は会話 ID がないと通知（codex queue）を届けられない
      const missing = provider === 'codex' && !(conv || this.participant(agentId)!.conversation_id);
      this.db.run('UPDATE participants SET receiver_state = ?, receiver_detail = ? WHERE agent_id = ?',
        missing ? 'not_configured' : 'unverified', missing ? '会話 ID が未登録です（channel_join の conversation_id に $CODEX_THREAD_ID を指定）' : null, agentId);
      return this.createCredential('agent', agentId);
    });
    const agent = this.participant(agentId)!;
    return { token, agent_id: agentId, provider, duty: agent.duty, ...this.join(agent, o.display_name, o.role) };
  }

  participant(id: string): Row | undefined {
    return this.db.get('SELECT * FROM participants WHERE agent_id = ?', id);
  }

  isOnline(p: Row): boolean {
    const t = this.lastSeen.get(p.agent_id);
    return p.conn_state === 'online' && t !== undefined && this.now() - t <= this.cfg.offline_after_ms;
  }

  reach(p: Row, viewer: string | null): { can_send: boolean; delivery: Delivery; reason: string | null } {
    if (viewer !== null && p.agent_id === viewer) return { can_send: false, delivery: 'unavailable', reason: REASON.self };
    if (p.membership === 'provisioned') return { can_send: false, delivery: 'unavailable', reason: REASON.provisioned };
    if (p.membership === 'left') return { can_send: false, delivery: 'unavailable', reason: REASON.left };
    if (!this.isOnline(p)) return { can_send: true, delivery: 'queued', reason: REASON.offline };
    if (p.activity_state === 'awaiting_approval') return { can_send: true, delivery: 'queued', reason: REASON.approval };
    if (p.activity_state === 'interrupted') return { can_send: true, delivery: 'queued', reason: REASON.interrupted };
    switch (p.receiver_state) {
      case 'verified': return { can_send: true, delivery: 'ready', reason: null };
      case 'failing': return { can_send: true, delivery: 'queued', reason: `自動受信の通知に失敗しています：${p.receiver_detail ?? '詳細不明'}` };
      case 'not_configured': return { can_send: true, delivery: 'queued', reason: p.receiver_detail ? `自動受信は未準備です：${p.receiver_detail}` : REASON.not_configured };
      default: return { can_send: true, delivery: 'queued', reason: REASON.unverified };
    }
  }

  memberView(p: Row, viewer: string | null, forUi = false): MemberView {
    const v: MemberView = {
      id: p.agent_id, display_name: p.display_name, role: p.role, provider: p.provider,
      membership: p.membership, connection: this.isOnline(p) ? 'online' : 'offline',
      last_seen_at: this.lastSeen.get(p.agent_id) ?? p.last_seen_at ?? null,
      auto_receive: p.receiver_state, activity: p.activity_state, ...this.reach(p, viewer),
    };
    if (viewer !== null) v.is_self = p.agent_id === viewer;
    if (forUi) v.pending_count = (this.db.get("SELECT COUNT(*) n FROM deliveries WHERE recipient_id = ? AND state = 'pending'", p.agent_id) as Row).n;
    return v;
  }

  members(viewer: string | null, forUi = false): MemberView[] {
    return this.db.all('SELECT * FROM participants WHERE channel_id = ? ORDER BY CASE duty WHEN \'coordinator\' THEN 0 ELSE 1 END, agent_id', this.cfg.channel_id)
      .map(p => this.memberView(p, viewer, forUi));
  }

  join(agent: Row, rawName: unknown, rawRole: unknown) {
    const { name, key } = normalizeName(rawName);
    const role = normalizeRole(rawRole);
    try {
      this.db.tx(() => {
        this.db.run(`UPDATE participants SET display_name = ?, display_name_key = ?, role = ?, profile_updated_at = ?,
          joined_at = CASE WHEN membership <> 'joined' THEN ? ELSE joined_at END, left_at = NULL, membership = 'joined' WHERE agent_id = ?`,
          name, key, role, this.now(), this.now(), agent.agent_id);
      });
    } catch (e) {
      if (String((e as Error).message).includes('UNIQUE')) {
        throw new ApiError('NAME_TAKEN', 409, `表示名「${name}」は他の参加者が使っています。以前の登録はそのまま残っています。`, '別の表示名で channel_join し直してください。');
      }
      throw e;
    }
    const self = this.participant(agent.agent_id)!;
    return { channel_id: this.cfg.channel_id, self: this.memberView(self, agent.agent_id), members: this.members(agent.agent_id), guide: guideFor(self.duty) };
  }

  leave(agent: Row) {
    return this.db.tx(() => {
      if (this.participant(agent.agent_id)!.membership !== 'joined') throw new ApiError('NOT_JOINED', 409, '参加していません。');
      this.db.run("UPDATE participants SET membership = 'left', left_at = ? WHERE agent_id = ?", this.now(), agent.agent_id);
      const ids = this.db.all("SELECT message_id FROM deliveries WHERE recipient_id = ? AND state = 'pending'", agent.agent_id).map(r => r.message_id);
      this.db.run("UPDATE deliveries SET state = 'cancelled_left', cancelled_at = ? WHERE recipient_id = ? AND state = 'pending'", this.now(), agent.agent_id);
      for (const id of ids) this.db.run('UPDATE messages SET updated_seq = ? WHERE message_id = ?', this.db.nextSeq(), id);
      this.db.run('UPDATE notify_state SET outstanding_notify_id = NULL, outstanding_since = NULL WHERE agent_id = ?', agent.agent_id);
      return { left: true, cancelled_deliveries: ids.length };
    });
  }

  private requireJoined(agent: Row): Row {
    const p = this.participant(agent.agent_id)!;
    if (p.membership !== 'joined') throw new ApiError('NOT_JOINED', 409, 'チャンネルに参加していません。', 'channel_join を呼んでください。');
    return p;
  }

  // ---- 送信 -------------------------------------------------------------------

  send(agent: Row, input: { to?: unknown; body?: unknown; client_message_id?: unknown; reply_to?: unknown }) {
    const to = checkTo(input.to);
    const body = checkBody(input.body, this.cfg.limits.body_max_chars);
    const clientId = checkClientId(input.client_message_id);
    const replyTo = input.reply_to == null || input.reply_to === '' ? null : checkMessageId(input.reply_to, 'reply_to');
    const hash = sha256(JSON.stringify([to, body, replyTo]));

    const result = this.db.tx(() => {
      const prev = this.db.get('SELECT * FROM messages WHERE sender_id = ? AND client_message_id = ?', agent.agent_id, clientId);
      if (prev) {
        if (prev.request_hash !== hash) throw new ApiError('IDEMPOTENCY_CONFLICT', 409, 'この client_message_id は別の内容の送信に使われています。', '新しい client_message_id で送り直してください。');
        return { ...this.sendResult(prev), duplicate: true };
      }
      const sender = this.requireJoined(agent);
      if (replyTo) {
        const r = this.db.get(`SELECT 1 FROM messages m WHERE m.message_id = ? AND (m.sender_id = ? OR EXISTS
          (SELECT 1 FROM deliveries d WHERE d.message_id = m.message_id AND d.recipient_id = ?))`, replyTo, agent.agent_id, agent.agent_id);
        if (!r) throw new ApiError('INVALID_REPLY_TO', 400, '返信先のメッセージが見つからないか、あなたが関わっていないメッセージです。');
      }
      let recipients: Row[];
      if (to === 'all') {
        recipients = this.db.all("SELECT agent_id, display_name FROM participants WHERE channel_id = ? AND membership = 'joined' AND agent_id <> ? ORDER BY agent_id",
          this.cfg.channel_id, agent.agent_id);
        if (recipients.length === 0) throw new ApiError('NO_RECIPIENTS', 409, '送信できる相手がいません（参加者が自分だけです）。');
      } else {
        if (to === agent.agent_id) throw new ApiError('SELF_SEND', 400, '自分自身には送信できません。');
        const r = this.participant(to);
        if (!r) throw new ApiError('UNKNOWN_RECIPIENT', 404, `宛先 ${to} は存在しません。`, 'channel_members で固定IDを確認してください。');
        if (r.membership !== 'joined') throw new ApiError('RECIPIENT_NOT_JOINED', 409, `宛先 ${to} は${r.membership === 'left' ? '退出済み' : '未参加'}です。`, 'channel_members で状態を確認してください。');
        recipients = [r];
      }
      const seq = this.db.nextSeq();
      const id = newMessageId();
      this.db.run(`INSERT INTO messages (message_id, channel_id, sender_id, sender_display_name, kind, to_spec, body, reply_to, client_message_id,
        request_hash, recipient_count, created_at, created_seq, updated_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, this.cfg.channel_id, agent.agent_id, sender.display_name, to === 'all' ? 'broadcast' : 'direct', to, body, replyTo, clientId,
        hash, recipients.length, this.now(), seq, seq);
      for (const r of recipients) {
        this.db.run('INSERT INTO deliveries (message_id, recipient_id, recipient_display_name, created_seq) VALUES (?, ?, ?, ?)',
          id, r.agent_id, r.display_name, seq);
      }
      return { ...this.sendResult(this.db.get('SELECT * FROM messages WHERE message_id = ?', id)!), duplicate: false };
    });
    if (!result.duplicate) this.onSent(result.recipients.map(r => r.id));
    return result;
  }

  private sendResult(m: Row) {
    const ds = this.db.all('SELECT d.recipient_id, d.recipient_display_name FROM deliveries d WHERE d.message_id = ? ORDER BY d.recipient_id', m.message_id);
    return {
      message_id: m.message_id, kind: m.kind, to: m.to_spec, created_at: m.created_at,
      recipients: ds.map(d => {
        const p = this.participant(d.recipient_id)!;
        return { id: d.recipient_id, display_name: d.recipient_display_name, ...this.reach(p, null) };
      }).map(({ can_send, ...rest }) => rest),
    };
  }

  // ---- 受信（本文を返した時点で既読にする。D-016） -----------------------------

  receive(agent: Row, rawLimit: unknown) {
    const limit = Math.min(Math.max(Number(rawLimit) || this.cfg.limits.receive_default, 1), this.cfg.limits.receive_max);
    return this.db.tx(() => {
      const p = this.requireJoined(agent);
      const rows = this.db.all(`SELECT d.*, m.sender_id, m.sender_display_name, m.kind, m.to_spec, m.reply_to, m.created_at AS m_created_at, m.body
        FROM deliveries d JOIN messages m USING (message_id) WHERE d.recipient_id = ? AND d.state = 'pending' ORDER BY d.created_seq LIMIT ?`, p.agent_id, limit);
      const now = this.now();
      for (const r of rows) {
        this.db.run(`UPDATE deliveries SET state = 'acked', acked_at = ?, first_received_at = COALESCE(first_received_at, ?), last_received_at = ?,
          receive_count = receive_count + 1 WHERE message_id = ? AND recipient_id = ?`, now, now, now, r.message_id, p.agent_id);
        this.db.run('UPDATE messages SET updated_seq = ? WHERE message_id = ?', this.db.nextSeq(), r.message_id);
      }
      const ns = this.db.get('SELECT * FROM notify_state WHERE agent_id = ?', p.agent_id)!;
      if (ns.outstanding_notify_id && ns.outstanding_generation === p.conn_generation && p.receiver_state !== 'verified') {
        this.db.run("UPDATE participants SET receiver_state = 'verified', receiver_detail = NULL, receiver_verified_generation = ? WHERE agent_id = ?", p.conn_generation, p.agent_id);
      }
      const maxSeq = (this.db.get("SELECT COALESCE(MAX(created_seq), 0) s FROM deliveries WHERE recipient_id = ? AND state = 'pending'", p.agent_id) as Row).s;
      this.db.run(`UPDATE notify_state SET outstanding_notify_id = NULL, outstanding_since = NULL, renotify_streak = 0, last_receive_at = ?,
        known_seq = MAX(known_seq, ?) WHERE agent_id = ?`, now, maxSeq, p.agent_id);
      const remaining = (this.db.get("SELECT COUNT(*) n FROM deliveries WHERE recipient_id = ? AND state = 'pending'", p.agent_id) as Row).n;
      return {
        messages: rows.map(r => ({
          message_id: r.message_id, from: { id: r.sender_id, display_name: r.sender_display_name }, kind: r.kind, to: r.to_spec,
          reply_to: r.reply_to, created_at: r.m_created_at, created_at_iso: new Date(r.m_created_at).toISOString(),
          body: r.body,
        })),
        remaining,
        members: this.members(p.agent_id),
      };
    });
  }

  // ---- 接続 -------------------------------------------------------------------

  connect(agent: Row, info: Record<string, unknown>) {
    return this.db.tx(() => {
      const p = this.participant(agent.agent_id)!;
      const gen = p.conn_generation + 1;
      let receiver = p.receiver_state, detail = p.receiver_detail;
      if (info.provider && info.provider !== p.provider) { receiver = 'not_configured'; detail = `トークンファイルの provider（${info.provider}）が登録（${p.provider}）と違います`; }
      else if (receiver === 'verified' && p.receiver_verified_generation !== gen) receiver = 'unverified';
      else if (receiver === 'not_configured' && !(p.provider === 'codex' && !p.conversation_id)) { receiver = 'unverified'; detail = null; }
      this.db.run(`UPDATE participants SET conn_generation = ?, conn_state = 'online', connected_at = ?, last_seen_at = ?, bridge_info = ?,
        receiver_state = ?, receiver_detail = ? WHERE agent_id = ?`,
        gen, this.now(), this.now(), JSON.stringify({ version: info.bridge_version, pid: info.pid }), receiver, detail, p.agent_id);
      this.lastSeen.set(p.agent_id, this.now());
      if (this.hasPending(p.agent_id)) this.db.run('UPDATE notify_state SET force_on_connect = 1 WHERE agent_id = ?', p.agent_id);
      return { agent_id: p.agent_id, provider: p.provider, generation: gen, membership: p.membership, heartbeat_interval_ms: this.cfg.heartbeat_interval_ms };
    });
  }

  heartbeat(agent: Row, generation: unknown): void {
    const p = this.participant(agent.agent_id)!;
    if (generation !== p.conn_generation) throw new ApiError('STALE_GENERATION', 409, '古い接続です。', undefined, { generation: p.conn_generation });
    const wasOnline = this.isOnline(p);
    this.lastSeen.set(p.agent_id, this.now());
    if (!wasOnline) {
      this.db.run("UPDATE participants SET conn_state = 'online', last_seen_at = ? WHERE agent_id = ?", this.now(), p.agent_id);
      if (this.hasPending(p.agent_id)) this.db.run('UPDATE notify_state SET force_on_connect = 1 WHERE agent_id = ?', p.agent_id);
    }
  }

  disconnect(agent: Row, generation: unknown): void {
    const p = this.participant(agent.agent_id)!;
    if (generation !== p.conn_generation) return;
    this.lastSeen.delete(p.agent_id);
    this.db.run("UPDATE participants SET conn_state = 'offline', disconnected_at = ?, last_seen_at = ? WHERE agent_id = ?", this.now(), this.now(), p.agent_id);
  }

  sweep(): void {
    for (const p of this.db.all("SELECT * FROM participants WHERE conn_state = 'online'")) {
      const t = this.lastSeen.get(p.agent_id);
      if (t === undefined || this.now() - t > this.cfg.offline_after_ms) {
        this.db.run("UPDATE participants SET conn_state = 'offline', disconnected_at = ?, last_seen_at = ? WHERE agent_id = ?", this.now(), t ?? null, p.agent_id);
      }
    }
  }

  setActivity(agent: Row, state: unknown): void {
    if (!['unknown', 'awaiting_approval', 'interrupted'].includes(String(state))) throw new ApiError('INVALID_ARGUMENT', 400, 'state が不正です。');
    this.db.run('UPDATE participants SET activity_state = ?, activity_updated_at = ? WHERE agent_id = ?', state, this.now(), agent.agent_id);
  }

  hasPending(agentId: string): boolean {
    return !!this.db.get("SELECT 1 FROM deliveries WHERE recipient_id = ? AND state = 'pending' LIMIT 1", agentId);
  }

  // ---- WebUI 向け -------------------------------------------------------------

  maxSeq(): number {
    return (this.db.get('SELECT value FROM seq_counter WHERE id = 1') as Row).value;
  }

  deliveryView(d: Row, p: Row, m?: Row) {
    const t = (x: number) => new Date(x).toLocaleTimeString('ja-JP', { hour12: false, hour: '2-digit', minute: '2-digit' });
    let ui_state: 'pending' | 'acked' | 'cancelled_left' | 'attention' = 'pending', detail: string;
    if (d.state === 'acked') { ui_state = 'acked'; detail = `取得済み ${t(d.acked_at)}`; }
    else if (d.state === 'cancelled_left') { ui_state = 'cancelled_left'; detail = '退出で配送停止'; }
    else if (!this.isOnline(p)) detail = '未取得（切断中のため待機）';
    else if (p.activity_state === 'awaiting_approval') detail = '未取得（承認待ちのため通知を保留中）';
    else if (p.activity_state === 'interrupted') detail = '未取得（中断後のため停止中）';
    else if (p.receiver_state === 'failing' || d.last_notify_result === 'failed') { ui_state = 'attention'; detail = `要確認（通知に失敗：${p.receiver_detail ?? '詳細不明'}）`; }
    else if (d.last_notify_at && this.now() - d.last_notify_at > this.cfg.notify.attention_after_ms) {
      ui_state = 'attention'; detail = `要確認（通知後${Math.round((this.now() - d.last_notify_at) / 60000)}分、受信を確認できません）`;
    } else if (d.last_notify_at) detail = '未取得（通知済み・受信待ち）';
    else detail = '未取得（通知待ち）';
    return {
      recipient_id: d.recipient_id, recipient_display_name: d.recipient_display_name, state: d.state, ui_state, detail,
      first_received_at: d.first_received_at, acked_at: d.acked_at, cancelled_at: d.cancelled_at,
      notify_count: d.notify_count, last_notify_at: d.last_notify_at, last_notify_result: d.last_notify_result,
    };
  }

  messageViews(rows: Row[]) {
    if (rows.length === 0) return [];
    const ids = rows.map(r => r.message_id);
    const ds = this.db.all(`SELECT * FROM deliveries WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY recipient_id`, ...ids);
    const ps = new Map(this.db.all('SELECT * FROM participants').map(p => [p.agent_id, p]));
    return rows.map(m => {
      const views = ds.filter(d => d.message_id === m.message_id).map(d => this.deliveryView(d, ps.get(d.recipient_id)!, m));
      const first = views.find(v => v.state === 'pending');
      return {
        message_id: m.message_id, created_at: m.created_at, created_seq: m.created_seq, updated_seq: m.updated_seq,
        sender: { id: m.sender_id, display_name: m.sender_display_name }, kind: m.kind, to: m.to_spec,
        to_display_name: m.kind === 'direct' ? views[0]?.recipient_display_name ?? null : null,
        body: m.body, reply_to: m.reply_to,
        summary: {
          total: views.length,
          acked: views.filter(v => v.state === 'acked').length,
          pending: views.filter(v => v.state === 'pending').length,
          cancelled: views.filter(v => v.state === 'cancelled_left').length,
          attention: views.filter(v => v.ui_state === 'attention').length,
          note: first ? `${first.recipient_display_name}は${first.detail.replace(/^.*?（(.*)）$/, '$1')}` : null,
        },
        deliveries: views,
      };
    });
  }

  listMessages(q: { limit?: string | null; before_seq?: string | null; since_seq?: string | null; participant?: string | null; kind?: string | null; q?: string | null }) {
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 200);
    const where = ['m.channel_id = ?'];
    const params: any[] = [this.cfg.channel_id];
    if (q.participant) { where.push('(m.sender_id = ? OR EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.message_id AND d.recipient_id = ?))'); params.push(q.participant, q.participant); }
    if (q.kind === 'direct' || q.kind === 'broadcast') { where.push('m.kind = ?'); params.push(q.kind); }
    if (q.q) { where.push("m.body LIKE ? ESCAPE '\\'"); params.push('%' + q.q.replace(/[\\%_]/g, c => '\\' + c) + '%'); }
    let rows: Row[];
    if (q.since_seq != null) {
      rows = this.db.all(`SELECT * FROM messages m WHERE ${where.join(' AND ')} AND m.updated_seq > ? ORDER BY m.updated_seq LIMIT ?`, ...params, Number(q.since_seq), limit);
    } else {
      const extra = q.before_seq != null ? ' AND m.created_seq < ?' : '';
      const p2 = q.before_seq != null ? [...params, Number(q.before_seq)] : params;
      rows = this.db.all(`SELECT * FROM messages m WHERE ${where.join(' AND ')}${extra} ORDER BY m.created_seq DESC LIMIT ?`, ...p2, limit).reverse();
    }
    const oldest = rows.length ? Math.min(...rows.map(r => r.created_seq)) : null;
    const has_older = oldest !== null && !!this.db.get(`SELECT 1 FROM messages m WHERE ${where.join(' AND ')} AND m.created_seq < ? LIMIT 1`, ...params, oldest);
    return { messages: this.messageViews(rows), has_older, oldest_seq: oldest, max_seq: this.maxSeq() };
  }

  getMessage(id: string) {
    const m = this.db.get('SELECT * FROM messages WHERE message_id = ?', id);
    if (!m) throw new ApiError('NOT_FOUND', 404, 'メッセージが見つかりません。');
    return this.messageViews([m])[0];
  }

  export(from = 0, to = Number.MAX_SAFE_INTEGER) {
    const rows = this.db.all('SELECT * FROM messages WHERE created_at BETWEEN ? AND ? ORDER BY created_seq', from, to);
    return {
      exported_at: new Date(this.now()).toISOString(),
      participants: this.members(null, true),
      messages: this.messageViews(rows),
    };
  }
}
