// フィード取得の 429 対策（2026-11-17）の検証。
// - 本命: 同一ホストへの取得は同時実行を絞り、開始間隔を空けてバーストにしない
// - 保険: 429 のときだけ Retry-After（無ければ10秒）待って1回だけリトライし、
//   再度失敗したらそのフィードを諦める（それ以上叩かない）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { refresh, retryAfterMs, HOST_MAX_CONCURRENT, HOST_MIN_INTERVAL_MS, RETRY_AFTER_DEFAULT_MS, RETRY_AFTER_MAX_MS } from '../src/collector.mjs';

function rssXml(items) {
  const body = items.map((it) => `<item><title>${it.title}</title><link>${it.url}</link><description></description><pubDate>${new Date().toUTCString()}</pubDate></item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>feed</title>${body}</channel></rss>`;
}
const okRes = (xml) => ({ ok: true, status: 200, text: async () => xml });
const gnewsFeed = (n) => ({ name: `G${n}`, source: '', category: '', url: `https://news.google.com/rss/search?q=q${n}&hl=ja&gl=JP&ceid=JP:ja` });

test('retryAfterMs: 秒指定・HTTP-date・既定値・上限キャップ', () => {
  const withHeader = (v) => ({ headers: new Headers(v ? { 'retry-after': v } : {}) });
  assert.equal(retryAfterMs(withHeader('5')), 5000);
  assert.equal(retryAfterMs(withHeader('0')), 0);
  assert.equal(retryAfterMs(withHeader('3600')), RETRY_AFTER_MAX_MS, '異常に長い指定は上限で頭打ち');
  assert.equal(retryAfterMs(withHeader(null)), RETRY_AFTER_DEFAULT_MS, 'ヘッダーが無ければ既定10秒');
  assert.equal(retryAfterMs(withHeader('garbage')), RETRY_AFTER_DEFAULT_MS, '解釈できない値も既定');
  assert.equal(retryAfterMs({}), RETRY_AFTER_DEFAULT_MS, 'headers 自体が無いスタブでも既定');
  const now = Date.parse('2026-11-17T00:00:00.000Z');
  assert.equal(retryAfterMs(withHeader('Tue, 17 Nov 2026 00:00:03 GMT'), now), 3000, 'HTTP-date は残り時間に変換');
  assert.equal(retryAfterMs(withHeader('Tue, 17 Nov 2026 00:00:03 GMT'), now + 10000), 0, '過去の日付は0');
});

test('スロットル: 同一ホストの同時実行が上限を超えず、開始が間隔を空けて広がる', async () => {
  const db = openDb(':memory:');
  let running = 0;
  let maxRunning = 0;
  const starts = [];
  const stub = async () => {
    starts.push(Date.now());
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 120));
    running--;
    return okRes(rssXml([{ title: 'スロットル検証のニュース', url: `https://example.com/${starts.length}` }]));
  };
  const feeds = [0, 1, 2, 3, 4, 5].map(gnewsFeed);
  const result = await refresh(db, { fetchImpl: stub, feeds });
  assert.equal(result.feedsOk, 6);
  assert.ok(maxRunning <= HOST_MAX_CONCURRENT, `同時実行 ${maxRunning} が上限 ${HOST_MAX_CONCURRENT} を超えました`);
  assert.equal(starts.length, 6);
  const sorted = [...starts].sort((a, b) => a - b);
  const span = sorted[sorted.length - 1] - sorted[0];
  assert.ok(span >= (feeds.length - 1) * HOST_MIN_INTERVAL_MS * 0.75, `開始が ${span}ms しか広がっていません（バーストになっています）`);
});

test('429: Retry-After に従って1回だけリトライし、成功すれば取り込む', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  const stub = async () => {
    calls++;
    if (calls === 1) {
      return { ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }), text: async () => '' };
    }
    return okRes(rssXml([{ title: 'リトライ後に届いたニュース', url: 'https://example.com/after429' }]));
  };
  const result = await refresh(db, { fetchImpl: stub, feeds: [gnewsFeed(1)] });
  assert.equal(calls, 2, '429 の後は1回だけ再試行する');
  assert.equal(result.feedsOk, 1);
  assert.equal(result.feedsFailed, 0);
  assert.equal(result.inserted, 1);
});

test('429: 再試行でも 429 ならそのフィードを諦め、それ以上叩かない', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  const stub = async () => {
    calls++;
    return { ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }), text: async () => '' };
  };
  const result = await refresh(db, { fetchImpl: stub, feeds: [gnewsFeed(1)] });
  assert.equal(calls, 2, '初回＋リトライ1回で打ち止め');
  assert.equal(result.feedsOk, 0);
  assert.equal(result.feedsFailed, 1, '諦めたフィードは失敗として数える');
});

test('429 以外の HTTP エラーはリトライしない', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  const stub = async () => {
    calls++;
    return { ok: false, status: 500, text: async () => '' };
  };
  const result = await refresh(db, { fetchImpl: stub, feeds: [gnewsFeed(1)] });
  assert.equal(calls, 1);
  assert.equal(result.feedsFailed, 1);
});
