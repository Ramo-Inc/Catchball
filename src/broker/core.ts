// 業務処理（DESIGN §4）：ルーム・参加・送信・受信（取得したら既読）・接続・表示用の集計
// 参加者は「ルームと ID の組み」で決まる（D-018）。内部では参加者の番号（pid）で指し、AI や画面には ID を見せる
import { Db, Row } from './db.js';
import { Config, Duty, Provider } from '../shared/config.js';
import { newMessageId, newToken, parseToken, safeEqualHex, sha256 } from '../shared/ids.js';
import {
  ApiError, checkAgentId, checkBody, checkClientId, checkMessageId, checkRoomId, checkTo, normalizeName, normalizeRole,
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

const roomNotFound = (room: string, hint?: string) => new ApiError('ROOM_NOT_FOUND', 404, `ルーム ${room} はありません。`, hint);

export class Core {
  // 接続状態はメモリで持つ（REVIEW-2 N4）。起動直後は全員 offline。鍵は参加者の番号（pid）
  private lastSeen = new Map<number, number>();
  // Codex 向けの通知を遅らせる判断に使う（PoC R2）。鍵は参加者の番号。書くのは markToolUse だけにして、鍵の取り違えを型で防ぐ
  private readonly lastToolAt = new Map<number, number>();
  onSent: (recipients: string[]) => void = () => {};

  constructor(readonly db: Db, readonly cfg: Config, readonly now: () => number = Date.now) {
    db.run("UPDATE participants SET conn_state = 'offline' WHERE conn_state = 'online'");
  }

  // ---- 資格情報 ---------------------------------------------------------------

  createCredential(kind: 'agent' | 'viewer' | 'admin' | 'ui_session', pid: number | null = null, ttlMs?: number): string {
    const t = newToken();
    this.db.run('INSERT INTO credentials (credential_id, kind, pid, secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      t.credentialId, kind, pid, t.hash, this.now(), ttlMs ? this.now() + ttlMs : null);
    return t.token;
  }

  revokeCredentials(kind: string, pid: number | null, reason: string): void {
    this.db.run(`UPDATE credentials SET revoked_at = ?, revoked_reason = ? WHERE kind = ? AND revoked_at IS NULL ${pid !== null ? 'AND pid = ?' : ''}`,
      ...[this.now(), reason, kind, ...(pid !== null ? [pid] : [])]);
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
    return this.byPid(c.pid)!;
  }

  // ---- ルーム -----------------------------------------------------------------

  roomExists(room: string): boolean {
    return !!this.db.get('SELECT 1 FROM rooms WHERE room_id = ?', room);
  }

  // 一覧に出すかどうかを確かめたいルーム。なければ ROOM_NOT_FOUND
  requireRoom(raw: unknown): string {
    const room = checkRoomId(raw);
    if (!this.roomExists(room)) throw roomNotFound(room);
    return room;
  }

  createRoom(raw: unknown) {
    const room = checkRoomId(raw);
    return this.db.tx(() => {
      if (this.roomExists(room)) throw new ApiError('ROOM_EXISTS', 409, `ルーム ${room} はすでにあります。`, '別の ID にするか、そのルームを使ってください。');
      const now = this.now();
      this.db.run('INSERT INTO rooms (room_id, created_at) VALUES (?, ?)', room, now);
      return { room, created_at: now, created_at_iso: new Date(now).toISOString() };
    });
  }

  // 一覧：ルームの ID・作成日時と、退出していない参加者（切断中も含む）の ID と表示名
  listRooms() {
    const members = this.db.all("SELECT room_id, agent_id, display_name FROM participants WHERE membership = 'joined' ORDER BY agent_id");
    return {
      rooms: this.db.all('SELECT * FROM rooms ORDER BY room_id').map(r => ({
        room: r.room_id, created_at: r.created_at, created_at_iso: new Date(r.created_at).toISOString(),
        members: members.filter(m => m.room_id === r.room_id).map(m => ({ id: m.agent_id, display_name: m.display_name })),
      })),
    };
  }

  // 全員が退出していれば、ルームを中身ごと消す（登録だけで一度も参加していない ID は、退出済みと同じに数える）
  deleteRoom(raw: unknown) {
    const room = checkRoomId(raw);
    const r = this.db.tx(() => {
      if (!this.roomExists(room)) throw roomNotFound(room);
      const left = this.db.all("SELECT agent_id FROM participants WHERE room_id = ? AND membership = 'joined' ORDER BY agent_id", room).map(p => p.agent_id);
      if (left.length) {
        throw new ApiError('ROOM_NOT_EMPTY', 409, `ルーム ${room} には、退出していない参加者がいます：${left.join(', ')}`,
          '各参加者を channel_leave で退出させてから削除してください。切断したまま残っている ID は、その ID で参加し直してから退出させます。分からなければユーザーに確認してください。',
          { members: left });
      }
      const pids = this.db.all('SELECT pid FROM participants WHERE room_id = ?', room).map(p => p.pid as number);
      this.db.run('DELETE FROM rooms WHERE room_id = ?', room);
      return { room, deleted: true, pids };
    });
    for (const pid of r.pids) { this.lastSeen.delete(pid); this.lastToolAt.delete(pid); }
    return r;
  }

  // ---- 参加者 -----------------------------------------------------------------

  provision(o: { room: unknown; agent: string; provider: Provider; conversation: string; duty: Duty; rotate?: boolean }): { token: string; room: string } {
    const room = checkRoomId(o.room);
    checkAgentId(o.agent);
    return this.db.tx(() => {
      if (!this.roomExists(room)) throw roomNotFound(room, '先に、AI に頼んで channel_room_create でルームを作ってください。');
      const existing = this.participantIn(room, o.agent);
      if (existing && !o.rotate) throw new ApiError('INVALID_ARGUMENT', 400, `${o.agent} はルーム ${room} に登録済みです。トークンを再発行するには --rotate を付けてください。`);
      let pid: number;
      if (existing) {
        pid = existing.pid;
        this.db.run('UPDATE participants SET provider = ?, conversation_id = ?, duty = ?, receiver_kind = ? WHERE pid = ?',
          o.provider, o.conversation, o.duty, o.provider === 'codex' ? 'codex_queue' : 'claude_channel', pid);
        this.revokeCredentials('agent', pid, 'rotated');
      } else {
        pid = this.insertParticipant(room, o.agent, o.provider, o.duty, o.conversation);
      }
      return { token: this.createCredential('agent', pid), room };
    });
  }

  private insertParticipant(room: string, agentId: string, provider: Provider, duty: Duty, conversation: string): number {
    const r = this.db.get(`INSERT INTO participants (room_id, agent_id, provider, duty, conversation_id, receiver_kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING pid`, room, agentId, provider, duty, conversation, provider === 'codex' ? 'codex_queue' : 'claude_channel', this.now())!;
    this.db.run('INSERT INTO notify_state (pid) VALUES (?)', r.pid);
    return r.pid as number;
  }

  // 会話の中からの参加（D-012・D-017・D-018）。ルームと ID はユーザーが決める。ハーネスが違っても、その ID が使用中でなければ入れる。
  // 検査・登録・前のキーの失効・新しいキーの発行・使用中の記録を1つのトランザクションで行い、断るときは何も残さない。
  selfJoin(o: { provider: unknown; room?: unknown; agent_id?: unknown; display_name: unknown; role: unknown; conversation_id?: unknown; coordinator?: unknown }) {
    const provider = o.provider === 'claude' ? 'claude' : o.provider === 'codex' ? 'codex' : null;
    if (!provider) throw new ApiError('INVALID_ARGUMENT', 400, 'provider は codex か claude です。');
    if (o.agent_id == null || o.agent_id === '') {
      throw new ApiError('INVALID_ARGUMENT', 400, '参加する ID（agent_id）が指定されていません。',
        'ID は自分で決めず、どの ID で参加するかユーザーに尋ねてから、もう一度 channel_join してください。');
    }
    const agentId = checkAgentId(o.agent_id);
    if (o.room == null || o.room === '') {
      throw new ApiError('INVALID_ARGUMENT', 400, '参加するルーム（room）が指定されていません。',
        'ルームは自分で決めず、どのルームに入るかユーザーに尋ねてから、もう一度 channel_join してください。');
    }
    const room = checkRoomId(o.room);
    normalizeName(o.display_name);
    normalizeRole(o.role);
    const conv = typeof o.conversation_id === 'string' ? o.conversation_id.trim() : '';
    if (provider === 'codex' && !conv) {
      throw new ApiError('INVALID_ARGUMENT', 400, 'Codex は会話 ID（conversation_id）が必要です。',
        'シェルで echo $CODEX_THREAD_ID（PowerShell は $env:CODEX_THREAD_ID）を実行し、その値を conversation_id に入れて、もう一度 channel_join してください。');
    }
    const receiverKind = provider === 'codex' ? 'codex_queue' : 'claude_channel';
    const r = this.db.tx(() => {
      if (!this.roomExists(room)) throw roomNotFound(room, 'ルームを自分で作らず、どのルームに入るかユーザーに確認してください。');
      const p = this.participantIn(room, agentId);
      let pid: number;
      if (p) {
        if (this.isOnline(p)) {
          throw new ApiError('AGENT_IN_USE', 409, `${agentId} は、ルーム ${room} で別のセッションが接続中です。`,
            '前のセッションがまだ接続中です。別の ID は使わず、ユーザーに伝えて、前のセッションが終了したか確認してもらってください。');
        }
        pid = p.pid;
        // 会話 ID は、この参加で指定されたものだけを使う（前の値を残すと、通知が前の会話に届く）
        this.db.run(`UPDATE participants SET provider = ?, receiver_kind = ?, conversation_id = ?,
          duty = CASE WHEN ? THEN 'coordinator' ELSE duty END WHERE pid = ?`,
          provider, receiverKind, provider === 'codex' ? conv : '', o.coordinator === true ? 1 : 0, pid);
        this.revokeCredentials('agent', pid, 'self_join');
      } else {
        pid = this.insertParticipant(room, agentId, provider, o.coordinator === true ? 'coordinator' : 'worker', provider === 'codex' ? conv : '');
      }
      this.db.run("UPDATE participants SET receiver_state = 'unverified', receiver_detail = NULL WHERE pid = ?", pid);
      const token = this.createCredential('agent', pid);
      const joined = this.joinProfile(this.byPid(pid)!, o.display_name, o.role);
      // 参加した時点から使用中にする（ブリッジが接続するまでの間に、同じ ID で参加されないように）
      this.db.run("UPDATE participants SET conn_state = 'online', last_seen_at = ? WHERE pid = ?", this.now(), pid);
      return { pid, token, agent_id: agentId, provider, duty: this.byPid(pid)!.duty as Duty, ...joined };
    });
    this.lastSeen.set(r.pid, this.now());
    return r;
  }

  byPid(pid: number): Row | undefined {
    return this.db.get('SELECT * FROM participants WHERE pid = ?', pid);
  }

  participantIn(room: string, agentId: string): Row | undefined {
    return this.db.get('SELECT * FROM participants WHERE room_id = ? AND agent_id = ?', room, agentId);
  }

  markToolUse(pid: number): void { this.lastToolAt.set(pid, this.now()); }
  lastToolUse(pid: number): number { return this.lastToolAt.get(pid) ?? 0; }

  isOnline(p: Row): boolean {
    const t = this.lastSeen.get(p.pid);
    return p.conn_state === 'online' && t !== undefined && this.now() - t <= this.cfg.offline_after_ms;
  }

  reach(p: Row, viewer: number | null): { can_send: boolean; delivery: Delivery; reason: string | null } {
    if (viewer !== null && p.pid === viewer) return { can_send: false, delivery: 'unavailable', reason: REASON.self };
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

  memberView(p: Row, viewer: number | null, forUi = false): MemberView {
    const v: MemberView = {
      id: p.agent_id, display_name: p.display_name, role: p.role, provider: p.provider,
      membership: p.membership, connection: this.isOnline(p) ? 'online' : 'offline',
      last_seen_at: this.lastSeen.get(p.pid) ?? p.last_seen_at ?? null,
      auto_receive: p.receiver_state, activity: p.activity_state, ...this.reach(p, viewer),
    };
    if (viewer !== null) v.is_self = p.pid === viewer;
    if (forUi) v.pending_count = (this.db.get("SELECT COUNT(*) n FROM deliveries WHERE recipient_pid = ? AND state = 'pending'", p.pid) as Row).n;
    return v;
  }

  members(room: string, viewer: number | null, forUi = false): MemberView[] {
    return this.db.all('SELECT * FROM participants WHERE room_id = ? ORDER BY CASE duty WHEN \'coordinator\' THEN 0 ELSE 1 END, agent_id', room)
      .map(p => this.memberView(p, viewer, forUi));
  }

  join(agent: Row, rawName: unknown, rawRole: unknown) {
    return this.db.tx(() => this.joinProfile(agent, rawName, rawRole));
  }

  // 表示名と役割を登録して参加中にする。トランザクションは呼び出し側が持つ（db.tx は入れ子にできない）
  private joinProfile(agent: Row, rawName: unknown, rawRole: unknown) {
    const { name, key } = normalizeName(rawName);
    const role = normalizeRole(rawRole);
    try {
      this.db.run(`UPDATE participants SET display_name = ?, display_name_key = ?, role = ?, profile_updated_at = ?,
        joined_at = CASE WHEN membership <> 'joined' THEN ? ELSE joined_at END, left_at = NULL, membership = 'joined' WHERE pid = ?`,
        name, key, role, this.now(), this.now(), agent.pid);
    } catch (e) {
      if (String((e as Error).message).includes('UNIQUE')) {
        throw new ApiError('NAME_TAKEN', 409, `表示名「${name}」は、このルームの他の参加者が使っています。以前の登録はそのまま残っています。`, '別の表示名で channel_join し直してください。');
      }
      throw e;
    }
    const self = this.byPid(agent.pid)!;
    return { room: self.room_id, self: this.memberView(self, self.pid), members: this.members(self.room_id, self.pid), guide: guideFor(self.duty) };
  }

  leave(agent: Row) {
    return this.db.tx(() => {
      if (this.byPid(agent.pid)!.membership !== 'joined') throw new ApiError('NOT_JOINED', 409, '参加していません。');
      this.db.run("UPDATE participants SET membership = 'left', left_at = ? WHERE pid = ?", this.now(), agent.pid);
      const ids = this.db.all("SELECT message_id FROM deliveries WHERE recipient_pid = ? AND state = 'pending'", agent.pid).map(r => r.message_id);
      this.db.run("UPDATE deliveries SET state = 'cancelled_left', cancelled_at = ? WHERE recipient_pid = ? AND state = 'pending'", this.now(), agent.pid);
      for (const id of ids) this.db.run('UPDATE messages SET updated_seq = ? WHERE message_id = ?', this.db.nextSeq(), id);
      this.db.run('UPDATE notify_state SET outstanding_notify_id = NULL, outstanding_since = NULL WHERE pid = ?', agent.pid);
      return { left: true, room: agent.room_id, cancelled_deliveries: ids.length };
    });
  }

  private requireJoined(agent: Row): Row {
    const p = this.byPid(agent.pid)!;
    if (p.membership !== 'joined') throw new ApiError('NOT_JOINED', 409, 'ルームに参加していません。', 'channel_join を呼んでください。');
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
      const prev = this.db.get('SELECT * FROM messages WHERE sender_pid = ? AND client_message_id = ?', agent.pid, clientId);
      if (prev) {
        if (prev.request_hash !== hash) throw new ApiError('IDEMPOTENCY_CONFLICT', 409, 'この client_message_id は別の内容の送信に使われています。', '新しい client_message_id で送り直してください。');
        return { ...this.sendResult(prev), duplicate: true };
      }
      const sender = this.requireJoined(agent);
      if (replyTo) {
        const r = this.db.get(`SELECT 1 FROM messages m WHERE m.message_id = ? AND (m.sender_pid = ? OR EXISTS
          (SELECT 1 FROM deliveries d WHERE d.message_id = m.message_id AND d.recipient_pid = ?))`, replyTo, sender.pid, sender.pid);
        if (!r) throw new ApiError('INVALID_REPLY_TO', 400, '返信先のメッセージが見つからないか、あなたが関わっていないメッセージです。');
      }
      let recipients: Row[];
      if (to === 'all') {
        recipients = this.db.all("SELECT pid, agent_id, display_name FROM participants WHERE room_id = ? AND membership = 'joined' AND pid <> ? ORDER BY agent_id",
          sender.room_id, sender.pid);
        if (recipients.length === 0) throw new ApiError('NO_RECIPIENTS', 409, '送信できる相手がいません（ルームの参加者が自分だけです）。');
      } else {
        if (to === sender.agent_id) throw new ApiError('SELF_SEND', 400, '自分自身には送信できません。');
        const r = this.participantIn(sender.room_id, to);
        if (!r) throw new ApiError('UNKNOWN_RECIPIENT', 404, `宛先 ${to} は、このルームにいません。`, 'channel_members で固定IDを確認してください。');
        if (r.membership !== 'joined') throw new ApiError('RECIPIENT_NOT_JOINED', 409, `宛先 ${to} は${r.membership === 'left' ? '退出済み' : '未参加'}です。`, 'channel_members で状態を確認してください。');
        recipients = [r];
      }
      const seq = this.db.nextSeq();
      const id = newMessageId();
      this.db.run(`INSERT INTO messages (message_id, room_id, sender_pid, sender_id, sender_display_name, kind, to_spec, body, reply_to, client_message_id,
        request_hash, recipient_count, created_at, created_seq, updated_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, sender.room_id, sender.pid, sender.agent_id, sender.display_name, to === 'all' ? 'broadcast' : 'direct', to, body, replyTo, clientId,
        hash, recipients.length, this.now(), seq, seq);
      for (const r of recipients) {
        this.db.run('INSERT INTO deliveries (message_id, recipient_pid, recipient_id, recipient_display_name, created_seq) VALUES (?, ?, ?, ?, ?)',
          id, r.pid, r.agent_id, r.display_name, seq);
      }
      return { ...this.sendResult(this.db.get('SELECT * FROM messages WHERE message_id = ?', id)!), duplicate: false };
    });
    if (!result.duplicate) this.onSent(result.recipients.map(r => r.id));
    return result;
  }

  private sendResult(m: Row) {
    const ds = this.db.all('SELECT d.recipient_pid, d.recipient_id, d.recipient_display_name FROM deliveries d WHERE d.message_id = ? ORDER BY d.recipient_id', m.message_id);
    return {
      message_id: m.message_id, kind: m.kind, to: m.to_spec, created_at: m.created_at,
      recipients: ds.map(d => {
        const p = this.byPid(d.recipient_pid)!;
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
        FROM deliveries d JOIN messages m USING (message_id) WHERE d.recipient_pid = ? AND d.state = 'pending' ORDER BY d.created_seq LIMIT ?`, p.pid, limit);
      const now = this.now();
      for (const r of rows) {
        this.db.run(`UPDATE deliveries SET state = 'acked', acked_at = ?, first_received_at = COALESCE(first_received_at, ?), last_received_at = ?,
          receive_count = receive_count + 1 WHERE message_id = ? AND recipient_pid = ?`, now, now, now, r.message_id, p.pid);
        this.db.run('UPDATE messages SET updated_seq = ? WHERE message_id = ?', this.db.nextSeq(), r.message_id);
      }
      const ns = this.db.get('SELECT * FROM notify_state WHERE pid = ?', p.pid)!;
      if (ns.outstanding_notify_id && ns.outstanding_generation === p.conn_generation && p.receiver_state !== 'verified') {
        this.db.run("UPDATE participants SET receiver_state = 'verified', receiver_detail = NULL, receiver_verified_generation = ? WHERE pid = ?", p.conn_generation, p.pid);
      }
      const maxSeq = (this.db.get("SELECT COALESCE(MAX(created_seq), 0) s FROM deliveries WHERE recipient_pid = ? AND state = 'pending'", p.pid) as Row).s;
      this.db.run(`UPDATE notify_state SET outstanding_notify_id = NULL, outstanding_since = NULL, renotify_streak = 0, last_receive_at = ?,
        known_seq = MAX(known_seq, ?) WHERE pid = ?`, now, maxSeq, p.pid);
      const remaining = (this.db.get("SELECT COUNT(*) n FROM deliveries WHERE recipient_pid = ? AND state = 'pending'", p.pid) as Row).n;
      return {
        messages: rows.map(r => ({
          message_id: r.message_id, from: { id: r.sender_id, display_name: r.sender_display_name }, kind: r.kind, to: r.to_spec,
          reply_to: r.reply_to, created_at: r.m_created_at, created_at_iso: new Date(r.m_created_at).toISOString(),
          body: r.body,
        })),
        remaining,
        members: this.members(p.room_id, p.pid),
      };
    });
  }

  // ---- 接続 -------------------------------------------------------------------

  connect(agent: Row, info: Record<string, unknown>) {
    return this.db.tx(() => {
      const p = this.byPid(agent.pid)!;
      const gen = p.conn_generation + 1;
      let receiver = p.receiver_state, detail = p.receiver_detail;
      if (info.provider && info.provider !== p.provider) { receiver = 'not_configured'; detail = `トークンファイルの provider（${info.provider}）が登録（${p.provider}）と違います`; }
      else if (receiver === 'verified' && p.receiver_verified_generation !== gen) receiver = 'unverified';
      else if (receiver === 'not_configured' && !(p.provider === 'codex' && !p.conversation_id)) { receiver = 'unverified'; detail = null; }
      this.db.run(`UPDATE participants SET conn_generation = ?, conn_state = 'online', connected_at = ?, last_seen_at = ?, bridge_info = ?,
        receiver_state = ?, receiver_detail = ? WHERE pid = ?`,
        gen, this.now(), this.now(), JSON.stringify({ version: info.bridge_version, pid: info.pid }), receiver, detail, p.pid);
      this.lastSeen.set(p.pid, this.now());
      if (this.hasPending(p.pid)) this.db.run('UPDATE notify_state SET force_on_connect = 1 WHERE pid = ?', p.pid);
      return { agent_id: p.agent_id, room: p.room_id, provider: p.provider, generation: gen, membership: p.membership, heartbeat_interval_ms: this.cfg.heartbeat_interval_ms };
    });
  }

  heartbeat(agent: Row, generation: unknown): void {
    const p = this.byPid(agent.pid)!;
    if (generation !== p.conn_generation) throw new ApiError('STALE_GENERATION', 409, '古い接続です。', undefined, { generation: p.conn_generation });
    const wasOnline = this.isOnline(p);
    this.lastSeen.set(p.pid, this.now());
    if (!wasOnline) {
      this.db.run("UPDATE participants SET conn_state = 'online', last_seen_at = ? WHERE pid = ?", this.now(), p.pid);
      if (this.hasPending(p.pid)) this.db.run('UPDATE notify_state SET force_on_connect = 1 WHERE pid = ?', p.pid);
    }
  }

  disconnect(agent: Row, generation: unknown): void {
    const p = this.byPid(agent.pid)!;
    if (generation !== p.conn_generation) return;
    this.lastSeen.delete(p.pid);
    this.db.run("UPDATE participants SET conn_state = 'offline', disconnected_at = ?, last_seen_at = ? WHERE pid = ?", this.now(), this.now(), p.pid);
  }

  sweep(): void {
    for (const p of this.db.all("SELECT * FROM participants WHERE conn_state = 'online'")) {
      const t = this.lastSeen.get(p.pid);
      if (t === undefined || this.now() - t > this.cfg.offline_after_ms) {
        this.db.run("UPDATE participants SET conn_state = 'offline', disconnected_at = ?, last_seen_at = ? WHERE pid = ?", this.now(), t ?? null, p.pid);
      }
    }
  }

  setActivity(agent: Row, state: unknown): void {
    if (!['unknown', 'awaiting_approval', 'interrupted'].includes(String(state))) throw new ApiError('INVALID_ARGUMENT', 400, 'state が不正です。');
    this.db.run('UPDATE participants SET activity_state = ?, activity_updated_at = ? WHERE pid = ?', state, this.now(), agent.pid);
  }

  hasPending(pid: number): boolean {
    return !!this.db.get("SELECT 1 FROM deliveries WHERE recipient_pid = ? AND state = 'pending' LIMIT 1", pid);
  }

  // ---- WebUI 向け -------------------------------------------------------------

  maxSeq(): number {
    return (this.db.get('SELECT value FROM seq_counter WHERE id = 1') as Row).value;
  }

  deliveryView(d: Row, p: Row) {
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
    const roomIds = [...new Set(rows.map(r => r.room_id))];
    const ps = new Map(this.db.all(`SELECT * FROM participants WHERE room_id IN (${roomIds.map(() => '?').join(',')})`, ...roomIds)
      .map(p => [p.pid as number, p]));
    return rows.map(m => {
      const views = ds.filter(d => d.message_id === m.message_id).map(d => this.deliveryView(d, ps.get(d.recipient_pid)!));
      const first = views.find(v => v.state === 'pending');
      return {
        message_id: m.message_id, room: m.room_id, created_at: m.created_at, created_seq: m.created_seq, updated_seq: m.updated_seq,
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

  listMessages(roomRaw: unknown, q: { limit?: string | null; before_seq?: string | null; since_seq?: string | null; participant?: string | null; kind?: string | null; q?: string | null }) {
    const room = this.requireRoom(roomRaw);
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 200);
    const where = ['m.room_id = ?'];
    const params: any[] = [room];
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
    return { room, messages: this.messageViews(rows), has_older, oldest_seq: oldest, max_seq: this.maxSeq() };
  }

  getMessage(id: string) {
    const m = this.db.get('SELECT * FROM messages WHERE message_id = ?', id);
    if (!m) throw new ApiError('NOT_FOUND', 404, 'メッセージが見つかりません。');
    return this.messageViews([m])[0];
  }

  // 管理用：全ルーム（または1つのルーム）の参加者
  allMembers(room: string | null = null) {
    const rooms = room ? [room] : this.db.all('SELECT room_id FROM rooms ORDER BY room_id').map(r => r.room_id as string);
    return rooms.flatMap(r => this.members(r, null, true).map(m => ({ room: r, ...m })));
  }

  export(roomRaw: unknown, from = 0, to = Number.MAX_SAFE_INTEGER) {
    const room = roomRaw == null || roomRaw === '' ? null : this.requireRoom(roomRaw);
    const rooms = this.db.all(`SELECT * FROM rooms ${room ? 'WHERE room_id = ?' : ''} ORDER BY room_id`, ...(room ? [room] : []));
    const rows = this.db.all(`SELECT * FROM messages WHERE created_at BETWEEN ? AND ? ${room ? 'AND room_id = ?' : ''} ORDER BY created_seq`, from, to, ...(room ? [room] : []));
    return {
      exported_at: new Date(this.now()).toISOString(),
      max_seq: this.maxSeq(),
      rooms: rooms.map(r => ({ room: r.room_id, created_at: r.created_at })),
      participants: this.allMembers(room),
      messages: this.messageViews(rows),
    };
  }
}
