// ブリッジと CLI が共通で使う、ブローカーへの呼び出し
import { TokenFile } from './config.js';

export interface CallResult { ok: boolean; status: number; data: any }

export async function call(tf: TokenFile, method: 'GET' | 'POST', path: string, body?: unknown, retryOnNetworkError = false): Promise<CallResult> {
  const attempt = async (): Promise<CallResult> => {
    const res = await fetch(tf.broker_url + path, {
      method,
      headers: { authorization: `Bearer ${tf.token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : {} };
  };
  try {
    return await attempt();
  } catch (e) {
    if (retryOnNetworkError) {
      await new Promise(r => setTimeout(r, 500));
      try { return await attempt(); } catch { /* 下で BROKER_UNAVAILABLE を返す */ }
    }
    return {
      ok: false, status: 0,
      data: { error: { code: 'BROKER_UNAVAILABLE', message: `ブローカー（${tf.broker_url}）に接続できません。送信は受理されていません。`, hint: 'ブローカーが起動しているか確認し、同じ client_message_id で後から再送してください。' } },
    };
  }
}
