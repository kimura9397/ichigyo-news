// 記者ビュー（tab=reporter）の統合テスト（一時DBで実サーバーを起動して叩く）。
// 絞り込みは媒体（source）＋記者名（author）の組で行い、同姓同名でも媒体が違えば混ざらない。
// 行は各クラスタ最新版のみ。total・カテゴリ別件数・ページネーションが整合すること。
// あわせて詳細API（/api/story/:id）の記事に author が含まれることを確認する。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8919;
const BASE = `http://127.0.0.1:${PORT}`;

let proc;
let dir;
const ids = {};
let seq = 0;

function seed(dbPath) {
  const db = openDb(dbPath);
  const now = new Date().toISOString();
  const article = (cid, vid, source, title, author) => {
    seq++;
    db.prepare(
      'INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at, author) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(cid, vid, source, title, `https://example.com/rp${seq}`, '要約', now, now, author);
  };
  const cluster = (title, category) => {
    const c = db.prepare(
      'INSERT INTO clusters (title, category, first_seen_at, last_seen_at, importance_score) VALUES (?, ?, ?, ?, ?)',
    ).run(title, category, now, now, 10);
    return Number(c.lastInsertRowid);
  };
  const version = (cid, no, title) => {
    const v = db.prepare(
      'INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, ?, ?, ?)',
    ).run(cid, no, title, now);
    return Number(v.lastInsertRowid);
  };

  // A: 朝日・山田太郎（署名は旧版 v1 の記事にだけある。行は最新版 v2 が返ること）
  ids.a = cluster('出来事A', '政治');
  article(ids.a, version(ids.a, 1, '出来事A'), '朝日', '出来事Aの初報', '山田太郎');
  article(ids.a, version(ids.a, 2, '出来事A（続報）'), '朝日', '出来事Aの続報', '');
  // B: 読売・山田太郎（同姓同名でも媒体が違うので混ざらないこと）
  ids.b = cluster('出来事B', '経済');
  article(ids.b, version(ids.b, 1, '出来事B'), '読売', '出来事Bの記事', '山田太郎');
  // C: 朝日・佐藤花子
  ids.c = cluster('出来事C', '社会');
  article(ids.c, version(ids.c, 1, '出来事C'), '朝日', '出来事Cの記事', '佐藤花子');
  // D: 朝日・署名なし
  ids.d = cluster('出来事D', '社会');
  article(ids.d, version(ids.d, 1, '出来事D'), '朝日', '出来事Dの記事', '');
  // E: 朝日・山田太郎（2件目の対象。ページネーション確認用）
  ids.e = cluster('出来事E', '政治');
  article(ids.e, version(ids.e, 1, '出来事E'), '朝日', '出来事Eの記事', '山田太郎');

  // 直近に収集が終わったことにして、テスト中に背景 refresh が走らないようにする
  db.prepare('INSERT INTO fetch_runs (started_at, finished_at) VALUES (?, ?)').run(now, now);
  db.close();
}

async function waitReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/status`);
      if (res.ok) return;
    } catch {
      /* 起動待ち */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('サーバーが起動しませんでした');
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ichigyo-reporter-'));
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
  proc?.kill('SIGKILL');
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function stories(query) {
  const res = await fetch(`${BASE}/api/stories?${query}`);
  assert.equal(res.ok, true);
  return res.json();
}

const asahiYamada = `source=${encodeURIComponent('朝日')}&author=${encodeURIComponent('山田太郎')}`;

test('reporter: 媒体＋記者名で絞り込み、行は最新版のみ', async () => {
  const data = await stories(`tab=reporter&${asahiYamada}`);
  assert.equal(data.total, 2);
  const byCluster = new Map(data.stories.map((s) => [s.cluster_id, s]));
  assert.ok(byCluster.has(ids.a));
  assert.ok(byCluster.has(ids.e));
  assert.equal(byCluster.get(ids.a).version_no, 2); // 署名は v1 の記事でも、行は最新版
  assert.equal(byCluster.has(ids.b), false); // 読売の同姓同名は混ざらない
  assert.equal(byCluster.has(ids.c), false);
  assert.equal(byCluster.has(ids.d), false);
});

test('reporter: 媒体が違えば同姓同名でも別々に引ける', async () => {
  const data = await stories(`tab=reporter&source=${encodeURIComponent('読売')}&author=${encodeURIComponent('山田太郎')}`);
  assert.equal(data.total, 1);
  assert.equal(data.stories[0].cluster_id, ids.b);
});

test('reporter: 指定なし・片方だけでは一致なし', async () => {
  assert.equal((await stories('tab=reporter')).total, 0);
  assert.equal((await stories(`tab=reporter&source=${encodeURIComponent('朝日')}`)).total, 0);
  assert.equal((await stories(`tab=reporter&author=${encodeURIComponent('山田太郎')}`)).total, 0);
});

test('reporter: カテゴリ別件数とページネーションが total と整合する', async () => {
  const data = await stories(`tab=reporter&${asahiYamada}`);
  const sum = data.categories.reduce((n, c) => n + c.count, 0);
  assert.equal(sum, data.total);
  const page1 = await stories(`tab=reporter&${asahiYamada}&limit=1&offset=0`);
  assert.equal(page1.total, 2);
  assert.equal(page1.stories.length, 1);
  const page2 = await stories(`tab=reporter&${asahiYamada}&limit=1&offset=1`);
  assert.equal(page2.total, 2);
  assert.equal(page2.stories.length, 1);
  assert.notEqual(page1.stories[0].cluster_id, page2.stories[0].cluster_id);
});

test('reporter: 詳細APIの記事に author が含まれる', async () => {
  const res = await fetch(`${BASE}/api/story/${ids.a}`);
  assert.equal(res.ok, true);
  const story = await res.json();
  const v1 = story.versions.find((v) => v.version_no === 1);
  assert.equal(v1.articles[0].author, '山田太郎');
});
