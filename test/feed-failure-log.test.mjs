// フィード取得失敗のログ文面（2026-11-17 方針）の検証。
// - 429 を含む HTTP エラーではリトライも間隔調整もしない（旧対策は撤回）。
//   代わりに、失敗を「フィード名＋コード＋次にどうなるか」の分かる言葉で
//   コンソールに残す
// - 「次の更新で再取得します」と言えるのはポーリング有効時だけ。手動更新
//   のみの状態では再取得を約束しない文面にする
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';
import { refresh, feedFailureMessage } from '../src/collector.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const FEED = { name: 'Google 朝日 (site:asahi.com)', source: '', category: '', url: 'https://news.google.com/rss/search?q=site%3Aasahi.com' };
const httpErr = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

test('feedFailureMessage: フィード名とコードが入り、再取得の約束はポーリング有効時だけ付く', () => {
  assert.equal(
    feedFailureMessage(FEED, httpErr(429), { willRetry: true }),
    'Google 朝日 (site:asahi.com) の取得に失敗しました（HTTP 429）。次の更新で再取得します',
  );
  assert.equal(
    feedFailureMessage(FEED, httpErr(429), { willRetry: false }),
    'Google 朝日 (site:asahi.com) の取得に失敗しました（HTTP 429）',
    'ポーリング無効時は再取得を約束しない',
  );
  assert.equal(
    feedFailureMessage(FEED, httpErr(500), { willRetry: true }),
    'Google 朝日 (site:asahi.com) の取得に失敗しました（HTTP 500）。次の更新で再取得します',
    '429 以外の HTTP エラーでも形式が揃う',
  );
});

test('feedFailureMessage: コードの無い失敗は事実だけを言葉にする', () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(feedFailureMessage(FEED, abort), 'Google 朝日 (site:asahi.com) の取得に失敗しました（応答が時間切れになりました）');
  assert.equal(feedFailureMessage(FEED, new Error('fetch failed')), 'Google 朝日 (site:asahi.com) の取得に失敗しました');
  assert.equal(
    feedFailureMessage({ url: 'https://example.com/feed.xml' }, httpErr(404)),
    'https://example.com/feed.xml の取得に失敗しました（HTTP 404）',
    '名前が無いフィードは URL で出す',
  );
});

async function captureErrors(fn) {
  const logs = [];
  const orig = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    return { result: await fn(), logs };
  } finally {
    console.error = orig;
  }
}

test('refresh: 429 でもリトライせず、失敗を分かる文面でログに残す', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  const stub = async () => {
    calls++;
    return { ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }), text: async () => '' };
  };
  const { result, logs } = await captureErrors(() => refresh(db, { fetchImpl: stub, feeds: [FEED] }));
  assert.equal(calls, 1, '429 でも再試行しない');
  assert.equal(result.feedsFailed, 1);
  assert.deepEqual(logs, ['Google 朝日 (site:asahi.com) の取得に失敗しました（HTTP 429）'], 'ポーリング無効（既定）では再取得を約束しない文面');
});

test('refresh: ポーリング有効時は「次の更新で再取得します」が付く', async () => {
  const db = openDb(':memory:');
  const stub = async () => ({ ok: false, status: 503, text: async () => '' });
  const { logs } = await captureErrors(() => refresh(db, { fetchImpl: stub, feeds: [FEED], nextRunScheduled: true }));
  assert.deepEqual(logs, ['Google 朝日 (site:asahi.com) の取得に失敗しました（HTTP 503）。次の更新で再取得します']);
});

test('方針の固定: 取得経路にリトライとホスト単位のスロットルが残っていない', () => {
  const collector = readFileSync(join(ROOT, 'src/collector.mjs'), 'utf8');
  assert.ok(!collector.includes('withHostSlot'), 'ホスト単位のスロットルが残っています');
  assert.ok(!collector.includes('retryAfterMs'), 'Retry-After のリトライ処理が残っています');
  assert.ok(!collector.includes('HOST_MIN_INTERVAL_MS'), '開始間隔の調整が残っています');
});
