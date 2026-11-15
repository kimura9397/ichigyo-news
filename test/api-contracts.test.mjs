// API契約の横断テスト: 各タブで total と返却行数が整合すること、
// キーワード検索の境界（空文字・LIKE特殊文字）が文字どおりに扱われることを固定する。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';
import { normalizeForSearch } from '../src/normalize.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8924;
const BASE = `http://127.0.0.1:${PORT}`;

let proc;
let dir;
const ids = {};

function seed(dbPath) {
  const db = openDb(dbPath);
  const now = new Date().toISOString();
  const mk = (title, category, score, { source = '朝日', author = '', summary = '要約' } = {}) => {
    const c = db.prepare(
      'INSERT INTO clusters (title, title_norm, category, first_seen_at, last_seen_at, importance_score) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(title, normalizeForSearch(title), category, now, now, score);
    const cid = Number(c.lastInsertRowid);
    const v = db.prepare(
      'INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1, ?, ?)',
    ).run(cid, title, now);
    const vid = Number(v.lastInsertRowid);
    db.prepare(
      'INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at, author, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(cid, vid, source, title, `https://example.com/${cid}`, summary, now, now, author, normalizeForSearch(`${title} ${summary}`));
    return cid;
  };
  ids.leak = mk('情報漏えいが判明 個人情報が流出', '政治', 100, { author: '山田太郎' });
  ids.marathon = mk('大分国際車いすマラソン 日本新記録', 'スポーツ', 100);
  ids.local = mk('市議会で一般質問が行われる', '政治', 10);
  db.prepare('INSERT INTO editorials (cluster_id, paper, found, title, summary, url, checked_at) VALUES (?, ?, 1, ?, ?, ?, ?)')
    .run(ids.leak, '朝日', '漏えい問題の社説', '社説要約', 'https://example.com/ed', now);
  db.prepare('INSERT INTO bookmarks (cluster_id, created_at) VALUES (?, ?)').run(ids.marathon, now);
  db.prepare('INSERT INTO fetch_runs (started_at, finished_at) VALUES (?, ?)').run(now, now);
  db.close();
}

async function stories(query) {
  const res = await fetch(`${BASE}/api/stories?${query}`);
  assert.equal(res.status, 200);
  return res.json();
}

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
  dir = mkdtempSync(join(tmpdir(), 'ichigyo-contracts-'));
  const dbPath = join(dir, 'news.db');
  seed(dbPath);
  proc = spawn('node', ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NEWS_DB_PATH: dbPath },
    stdio: 'ignore',
  });
  await waitReady();
});

after(() => {
  proc?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('各タブで total と返却行数が整合する', async () => {
  const cases = [
    ['important', 'tab=important&limit=100', 2],
    ['new', 'tab=new&limit=100', 3],
    ['editorials', 'tab=editorials&limit=100', 1],
    ['bookmarks', 'tab=bookmarks&limit=100', 1],
    ['watch', `tab=watch&keywords=${encodeURIComponent('情報漏えい')}&limit=100`, 1],
    ['reporter', `tab=reporter&source=${encodeURIComponent('朝日')}&author=${encodeURIComponent('山田太郎')}&limit=100`, 1],
  ];
  for (const [name, query, expected] of cases) {
    const data = await stories(query);
    assert.equal(data.total, expected, `${name} の total`);
    assert.equal(data.stories.length, data.total, `${name} の行数と total が一致する`);
  }
});

test('ページネーション: limit/offset をまたいでも total は不変で、行は重ならない', async () => {
  const page1 = await stories('tab=new&limit=2&offset=0');
  const page2 = await stories('tab=new&limit=2&offset=2');
  assert.equal(page1.total, 3);
  assert.equal(page2.total, 3);
  assert.equal(page1.stories.length, 2);
  assert.equal(page2.stories.length, 1);
  const ids1 = new Set(page1.stories.map((s) => s.version_id));
  for (const s of page2.stories) assert.ok(!ids1.has(s.version_id), 'ページ間で重複しない');
});

test('キーワード検索の境界: 空文字と LIKE 特殊文字は文字どおりに扱う', async () => {
  const pct = await stories(`tab=watch&keywords=${encodeURIComponent('%')}&limit=100`);
  assert.equal(pct.total, 0, '% がワイルドカードとして全件一致しない');
  const under = await stories(`tab=watch&keywords=${encodeURIComponent('_')}&limit=100`);
  assert.equal(under.total, 0, '_ がワイルドカードとして全件一致しない');
  const empty = await stories('tab=watch&keywords=&limit=100');
  assert.equal(empty.total, 0, 'キーワードが無ければ一致なし');
  const variant = await stories(`tab=watch&keywords=${encodeURIComponent('情報漏洩')}&limit=100`);
  assert.equal(variant.total, 1, '表記ゆれ（漏洩→漏えい）が正規化されてヒットする');
  assert.equal(variant.stories[0].cluster_id, ids.leak);
});

test('カテゴリミュートは重要タブの total からも除外される', async () => {
  const muted = await stories(`tab=important&mute=${encodeURIComponent('スポーツ')}&limit=100`);
  assert.equal(muted.total, 1);
  assert.equal(muted.stories[0].cluster_id, ids.leak);
});
