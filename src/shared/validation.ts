// 入力の検証と正規化（DESIGN §3.2）
export class ApiError extends Error {
  constructor(public code: string, public status: number, message: string, public hint?: string, public details?: unknown) {
    super(message);
  }
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f​‌‎‏‪-‮⁦-⁩﻿]/u;

function len(s: string): number {
  return [...s].length;
}

export function normalizeName(raw: unknown): { name: string; key: string } {
  if (typeof raw !== 'string') throw new ApiError('INVALID_ARGUMENT', 400, '表示名は文字列で指定してください。', undefined, { field: 'display_name' });
  const name = raw.trim().normalize('NFC');
  if (len(name) < 1 || len(name) > 40) throw new ApiError('INVALID_ARGUMENT', 400, '表示名は1〜40文字にしてください。', undefined, { field: 'display_name' });
  if (CONTROL.test(name)) throw new ApiError('INVALID_ARGUMENT', 400, '表示名に制御文字は使えません。', undefined, { field: 'display_name' });
  return { name, key: name.replace(/[A-Z]/g, c => c.toLowerCase()) };
}

export function normalizeRole(raw: unknown): string {
  if (typeof raw !== 'string') throw new ApiError('INVALID_ARGUMENT', 400, '役割は文字列で指定してください。', undefined, { field: 'role' });
  const role = raw.trim().normalize('NFC');
  if (len(role) < 1 || len(role) > 200) throw new ApiError('INVALID_ARGUMENT', 400, '役割は1〜200文字にしてください。', undefined, { field: 'role' });
  if (CONTROL.test(role)) throw new ApiError('INVALID_ARGUMENT', 400, '役割に改行や制御文字は使えません。', undefined, { field: 'role' });
  return role;
}

export function checkBody(raw: unknown, max: number): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new ApiError('INVALID_ARGUMENT', 400, '本文が空です。', undefined, { field: 'body' });
  if (len(raw) > max) throw new ApiError('PAYLOAD_TOO_LARGE', 413, `本文は${max}文字以内にしてください。`, '分割して送ってください。');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw)) throw new ApiError('INVALID_ARGUMENT', 400, '本文に使えない制御文字が含まれています。', undefined, { field: 'body' });
  return raw;
}

export function checkTo(raw: unknown): string {
  if (typeof raw !== 'string' || !(raw === 'all' || /^[a-z][a-z0-9-]{0,31}$/.test(raw))) {
    throw new ApiError('INVALID_ARGUMENT', 400, '宛先は "all" か参加者の固定ID（例 claude-1）で指定してください。', 'channel_members で固定IDを確認してください。', { field: 'to' });
  }
  return raw;
}

export function checkClientId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(raw)) {
    throw new ApiError('INVALID_ARGUMENT', 400, 'client_message_id は英数字と . _ : - の1〜64文字にしてください。', '送信ごとに一意な値を付けてください（例 codex-main-T03-req-1）。', { field: 'client_message_id' });
  }
  return raw;
}

export function checkMessageId(raw: unknown, field = 'message_id'): string {
  if (typeof raw !== 'string' || !/^m_[0-9A-Z]{26}$/.test(raw)) throw new ApiError('INVALID_ARGUMENT', 400, `${field} の形式が正しくありません。`, undefined, { field });
  return raw;
}

export function checkAgentId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(raw) || raw === 'all') {
    throw new ApiError('INVALID_ARGUMENT', 400, '固定IDは英小文字で始まる英小文字・数字・ハイフンの32文字以内にしてください（all は使えません）。');
  }
  return raw;
}
