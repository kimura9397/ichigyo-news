// SEA（Node Single Executable Applications）実行時のためのヘルパー。
// 通常の `node server.mjs` では isSea() が false になり、このモジュールの関数は
// どれも「SEA ではない」前提の答えを返す（従来どおりディスクから動く）。
import { isSea, getAsset } from 'node:sea';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

/** SEA として実行されているか。 */
export function runningAsSea() {
  try { return isSea(); } catch { return false; }
}

/**
 * SEA に埋め込んだ assets から、public/ 基準の相対パス（'/' 区切り）の内容を返す。
 * SEA でない場合と、キーが無い場合は null。
 */
export function readSeaAsset(rel) {
  if (!runningAsSea()) return null;
  try {
    return Buffer.from(getAsset(rel));
  } catch {
    return null;
  }
}

/**
 * exe 実行時のデータ保存先ディレクトリ。
 * ICHIGYO_DATA_DIR があればそれを優先する（環境変数での上書き）。
 * Windows: %APPDATA%\ichigyo-news / macOS: ~/Library/Application Support/ichigyo-news
 * Linux: $XDG_DATA_HOME/ichigyo-news（無ければ ~/.local/share/ichigyo-news）
 */
export function defaultDataDir() {
  if (process.env.ICHIGYO_DATA_DIR) return process.env.ICHIGYO_DATA_DIR;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'ichigyo-news');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'ichigyo-news');
  }
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'ichigyo-news');
}

/** 既定ブラウザで URL を開く。ICHIGYO_NO_BROWSER があれば開かない。失敗しても例外にしない。 */
export function openBrowser(url) {
  if (process.env.ICHIGYO_NO_BROWSER) return;
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const child = execFile(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // ブラウザが開けなくてもサーバー自体は続行する
  }
}
