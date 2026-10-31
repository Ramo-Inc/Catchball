// WebUI の静的ファイルを dist/web にコピーする
import { cpSync } from 'node:fs';
cpSync('src/web', 'dist/web', { recursive: true });
