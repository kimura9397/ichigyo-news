// キーワードのサーバー側保存と「キーワード＝収集クエリ」のテスト。
// - keywords.mjs の CRUD と上限（件数・文字数）
// - refresh: 登録キーワードごとに Google News キーワード検索RSSを取得し、通常パイプラインで
//   取り込むこと／汎用フィードとの重複が二重取り込みにならないこと／キーワードフィードの
//   失敗が更新全体を失敗させないこと／キーワードあたり30件の上限
// - /api/keywords の CRUD（実サーバー）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';
import { listKeywords, addKeyword, removeKeyword, MAX_KEYWORDS } from '../src/keywords.mjs';
import { refresh, keywordFeedFor, KEYWORD_FEED_LIMIT } from '../src/collector.mjs';

test('keywords CRUD: 追加・重複・削除と入力クリーニング', () => {
  const db = openDb(':memory:');
  assert.deepEqual(listKeywords(db), []);
  const r1 = addKeyword(db, ' 今田美桜 ');
  assert.equal(r1.added, true);
  assert.deepEqual(r1.keywords, ['今田美桜']);
  const dup = addKeyword(db, '今田美桜');
  assert.equal(dup.added, false);
  assert.deepEqual(dup.keywords, ['今田美桜']);
  const comma = addKeyword(db, '宇宙,開発');
  assert.equal(comma.added, true);
  assert.ok(comma.keywords.includes('宇宙 開発'), 'カンマは空白に置換される');
  const empty = addKeyword(db, '   ');
  assert.ok(empty.error);
  const rm = removeKeyword(db, '今田美桜');
  assert.equal(rm.removed, true);
  assert.deepEqual(rm.keywords, ['宇宙 開発']);
});

test('keywords CRUD: 件数上限と文字数上限', () => {
  const db = openDb(':memory:');
  for (let i = 0; i < MAX_KEYWORDS; i++) addKeyword(db, `語${i}`);
  const over = addKeyword(db, 'あふれる語');
  assert.ok(over.error);
  assert.equal(over.keywords.length, MAX_KEYWORDS);
  const db2 = openDb(':memory:');
  const long = addKeyword(db2, 'あ'.repeat(51));
  assert.ok(long.error);
});

/* ---------- refresh への収集統合 ---------- */

function rssXml(items) {
  const body = items.map((it) => `<item><title>${it.title}</title><link>${it.url}</link><description>${it.desc || ''}</description><pubDate>${new Date().toUTCString()}</pubDate></item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>feed</title>${body}</channel></rss>`;
}

const GENERIC_FEED = [{ name: '汎用', source: '', category: '', url: 'https://example.com/feed.xml' }];

test('refresh: キーワードフィードが取得され、汎用フィードとの重複は二重取り込みにならない', async () => {
  const db = openDb(':memory:');
  addKeyword(db, '宇宙開発');
  const shared = { title: '月面探査が進展 宇宙開発の節目', url: 'https://example.com/shared' };
  const stub = async (url) => {
    if (url.includes('search?q=')) {
      assert.ok(url.includes(encodeURIComponent('宇宙開発')), 'キーワードが検索クエリに入る');
      return { ok: true, text: async () => rssXml([shared, { title: '宇宙開発で新発見 ロケット打ち上げ成功', url: 'https://example.com/kw1' }]) };
    }
    return { ok: true, text: async () => rssXml([shared, { title: '地上の天気は晴れ', url: 'https://example.com/g1' }]) };
  };
  const result = await refresh(db, { fetchImpl: stub, feeds: GENERIC_FEED });
  assert.equal(result.feedsOk, 2, '汎用＋キーワードの2フィード成功');
  assert.equal(result.feedsFailed, 0);
  const count = db.prepare('SELECT COUNT(*) c FROM articles').get().c;
  assert.equal(count, 3, '重複する shared は1件だけ取り込まれる');
  const run = db.prepare('SELECT feeds_ok, feeds_failed FROM fetch_runs ORDER BY id DESC LIMIT 1').get();
  assert.equal(run.feeds_ok, 2, 'fetch_runs にキーワード取得も記録される');
});

test('refresh: キーワードフィードの失敗は更新全体を失敗させない', async () => {
  const db = openDb(':memory:');
  addKeyword(db, '宇宙開発');
  const stub = async (url) => {
    if (url.includes('search?q=')) throw new Error('network down');
    return { ok: true, text: async () => rssXml([{ title: '地上の天気は晴れ', url: 'https://example.com/g1' }]) };
  };
  const result = await refresh(db, { fetchImpl: stub, feeds: GENERIC_FEED });
  assert.equal(result.feedsOk, 1);
  assert.equal(result.feedsFailed, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM articles').get().c, 1);
});

test('refresh: キーワードあたりの取り込み上限', async () => {
  const db = openDb(':memory:');
  addKeyword(db, '宇宙開発');
  const items = Array.from({ length: KEYWORD_FEED_LIMIT + 5 }, (_, i) => ({
    title: `宇宙開発ニュース第${i + 1}号`,
    url: `https://example.com/kw-cap-${i}`,
  }));
  const stub = async () => ({ ok: true, text: async () => rssXml(items) });
  const result = await refresh(db, { fetchImpl: stub, feeds: [] });
  assert.equal(result.seen, KEYWORD_FEED_LIMIT);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM articles').get().c, KEYWORD_FEED_LIMIT);
});

test('keywordFeedFor: Google News 検索RSSのURLを組み立てる', () => {
  const feed = keywordFeedFor('情報 漏えい');
  assert.ok(feed.url.startsWith('https://news.google.com/rss/search?q='));
  assert.ok(feed.url.includes(encodeURIComponent('情報 漏えい')));
  assert.equal(feed.limit, KEYWORD_FEED_LIMIT);
});

/* ---------- /api/keywords ---------- */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8922;
const BASE = `http://127.0.0.1:${PORT}`;
let proc;
let dir;

async function waitReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/status`);
      if (res.ok) return;
    } catch { /* 起動待ち */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('サーバーが起動しませんでした');
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ichigyo-keywords-'));
  proc = spawn('node', ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NEWS_DB_PATH: join(dir, 'news.db') },
    stdio: 'ignore',
  });
  await waitReady();
});

after(() => {
  proc?.kill('SIGKILL');
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('API: キーワードの取得・追加・重複・削除', async () => {
  const get = async () => (await (await fetch(`${BASE}/api/keywords`)).json()).keywords;
  assert.deepEqual(await get(), []);
  const post = await fetch(`${BASE}/api/keywords`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keyword: '今田美桜' }),
  });
  assert.equal(post.ok, true);
  assert.deepEqual((await post.json()).keywords, ['今田美桜']);
  const dup = await fetch(`${BASE}/api/keywords`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keyword: '今田美桜' }),
  });
  assert.equal((await dup.json()).added, false);
  const empty = await fetch(`${BASE}/api/keywords`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keyword: ' ' }),
  });
  assert.equal(empty.status, 400);
  const del = await fetch(`${BASE}/api/keywords`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keyword: '今田美桜' }),
  });
  assert.equal((await del.json()).removed, true);
  assert.deepEqual(await get(), []);
});
