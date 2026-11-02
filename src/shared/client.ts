// ブリッジと CLI が共通で使う、ブローカーへの呼び出し
import { TokenFile } from './config.js';

export interface CallResult { ok: boolean; status: number; data: any }

// ブローカーが応答しないとき、待つのをやめるまでの時間（ハートビートや退出が止まり続けないように）
const TIMEOUT_MS = 10000;

export async function call(tf: Pick<TokenFile, 'broker_url' | 'token'>, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, retryOnNetworkError = false): Promise<CallResult> {
  const attempt = async (): Promise<CallResult> => {
    const res = await fetch(tf.broker_url + path, {
      method,
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
      data: { error: { code: 'BROKER_UNAVAILABLE', message: `ブローカー（${tf.broker_url}）から応答がありません。送信が受理されたかは確認できません。`, hint: 'ブローカーが起動しているか確認し、同じ client_message_id で後から再送してください（受理済みでも、二重には投稿されません）。' } },
    };
  }
}
