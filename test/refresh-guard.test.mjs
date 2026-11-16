// 更新の連打対策（2026-11-16 ユーザー指示）の検証。
// - サーバー: 収集の実行中は新しい収集を開始せず、現在の状態（alreadyRunning）を返す。
//   収集は常に1本だけ走る。固定クールダウンは設けない（ロックは実行中のみ）
// - フロント: 収集中は更新ボタンを無効化し、実行中と分かる表示にする。
//   別ウィンドウ等が開始した収集に対しては、背後更新の完了待ちに切り替える
// 実フィードへの収集はネットワークが要るため、ここでは配線の静的ガードで担保する
// （compliance-followup.test.mjs と同じ方式）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('サーバー: 収集の開始は startRefresh に一本化され、実行中は開始しない', () => {
  const server = read('server.mjs');
  assert.ok(server.includes('function startRefresh()'), 'startRefresh がありません');
  assert.ok(
    server.includes('if (refreshing) return { promise: refreshing, started: false }'),
    '実行中は開始せず started: false を返す分岐がありません',
  );
  // 収集本体 refresh(db) の呼び出しは startRefresh の中だけ（迂回経路を作らない）
  const calls = server.split('refresh(db)').length - 1;
  assert.equal(calls, 1, 'refresh(db) の呼び出しが startRefresh 以外にあります');
});

test('サーバー: POST /api/refresh は実行中なら alreadyRunning で現在の状態を返す', () => {
  const server = read('server.mjs');
  assert.ok(
    server.includes("if (!started) return sendJson(res, 200, { alreadyRunning: true, refreshing: true, lastRun: lastFinishedRun() })"),
    '実行中の即時応答（alreadyRunning）がありません',
  );
  assert.ok(
    server.includes('alreadyRunning: false, refreshing: false'),
    '開始できた場合の応答に alreadyRunning: false がありません',
  );
});

test('フロント: refreshFeed は alreadyRunning を呼び出し側へ返す', () => {
  const api = read('frontend/src/api.ts');
  assert.ok(api.includes('alreadyRunning: data.alreadyRunning === true'), 'refreshFeed が alreadyRunning を返していません');
});

test('フロント: 更新ボタンは自前の更新中も背後更新中も無効化され、アイコンが回る', () => {
  const app = read('frontend/src/App.tsx');
  assert.ok(app.includes('disabled={refreshing || bgRefreshing}'), '更新ボタンの無効化条件に bgRefreshing が含まれていません');
  assert.ok(app.includes("className={refreshing || bgRefreshing ? 'spin' : undefined}"), '更新中アイコンの回転条件に bgRefreshing が含まれていません');
  assert.ok(app.includes('if (refreshing || bgRefreshing) return'), 'handleRefresh のガードに bgRefreshing が含まれていません');
});

test('フロント: 他所で開始された収集中は開始せず、背後更新の完了待ちに切り替える', () => {
  const app = read('frontend/src/App.tsx');
  assert.ok(app.includes('const { alreadyRunning } = await refreshFeed()'), 'handleRefresh が alreadyRunning を見ていません');
  assert.ok(app.includes('setBgRefreshing(true)'), 'alreadyRunning 時に bgRefreshing へ切り替える処理がありません');
});
