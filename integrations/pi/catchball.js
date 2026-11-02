// Catchball（session_mail）の Pi 拡張機能：ブリッジからの通知を受け取り、Pi の会話に入れる。
// Claude の起動時の引数（--dangerously-load-development-channels）に当たるもの。ツールは持たない（ツールは mcp.json に登録したブリッジが出す）。
// 受け口の場所は Pi のプロセス番号で決める。Pi はブリッジを直接起動するので、ブリッジから見た親のプロセス番号と一致する。
// 流れてくるのは、1行に1つの JSON（{"content":"<通知文>"}）。通知文に本文は入っていない。
import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const socketPath = pid => process.platform === 'win32' ? `\\\\.\\pipe\\catchball-pi-${pid}` : join(tmpdir(), `catchball-pi-${pid}.sock`);

export default function catchball(pi) {
  const path = socketPath(process.pid);
  let server = null;   // 開いている受け口
  let opening = null;  // 開いている途中（同じ拡張機能に session_start が2回届くことがある）

  const open = async () => {
    if (process.platform !== 'win32') rmSync(path, { force: true });  // 前に落ちた Pi が残したファイル
    const s = createServer(conn => {
      let buf = '';
      conn.setEncoding('utf8');
      conn.on('error', () => {});
      conn.on('data', d => {
        buf += d;
        if (buf.length > 65536) { conn.destroy(); return; }  // 通知文は短い。改行のない長い入力は受け付けない
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let n;
          try { n = JSON.parse(line); } catch { continue; }
          if (typeof n?.content !== 'string') continue;
          // 待機中ならすぐ動き出し、作業中なら作業がすべて終わってから処理される。
          // 例外を Pi に漏らさない（セッションの切り替えの途中などで、古い pi が使えないことがある。届かなかった分は再通知で届く）
          try {
            pi.sendMessage({ customType: 'catchball', content: n.content, display: true }, { triggerTurn: true, deliverAs: 'followUp' });
          } catch (e) {
            console.error(`[catchball] 通知を会話に入れられませんでした: ${e?.message ?? e}`);
          }
        }
      });
    });
    await new Promise((resolve, reject) => { s.once('error', reject); s.listen(path, () => { s.off('error', reject); resolve(); }); });
    server = s;  // 開けたときだけ覚える（開けなければ、次の session_start でまた試す）
  };

  pi.on('session_start', async () => {
    if (server) return;
    opening ??= open().finally(() => { opening = null; });
    await opening;
  });

  pi.on('session_shutdown', async () => {
    if (opening) await opening.catch(() => {});
    const s = server;
    server = null;
    if (!s) return;
    await new Promise(resolve => s.close(() => resolve()));
    if (process.platform !== 'win32') rmSync(path, { force: true });
  });
}
