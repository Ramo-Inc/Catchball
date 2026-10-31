#!/usr/bin/env node
// 試験用の偽 codex：受け取った引数を FAKE_CODEX_LOG に1行ずつ追記する。
// スレッド名が fail-thread のときは、存在しないスレッドとして失敗する。
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + '\n');
if (args.includes('fail-thread')) {
  process.stderr.write('Error: thread not found: fail-thread\n');
  process.exit(1);
}
