// キーワードウォッチ（tab=watch）の統合テスト（一時DBで実サーバーを起動して叩く）。
// 一致判定: クラスタのタイトル、またはそのクラスタの記事（全版）のタイトル/要約への部分一致。
// 行は各クラスタ最新版のみ。複数キーワードは OR。total・カテゴリ件数・ページネーションが整合すること。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8918;
const BASE = `http://127.0.0.1:${PORT}`;

let proc;
let dir;
const ids = {};
let seq = 0;

function seed(dbPath) {
  const db = openDb(dbPath);
  const now = new Date().toISOString();
  const article = (cid, vid, title, summary) => {
    seq++;
    db.prepare(
      'INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(cid, vid, '朝日', title, `https://example.com/kw${seq}`, summary, now, now);
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

  // P: クラスタのタイトルにキーワード
  ids.p = cluster('今田美桜、新ドラマの主演に決定', '文化・エンタメ');
  article(ids.p, version(ids.p, 1, '今田美桜、新ドラマの主演に決定'), '今田美桜が主演', '撮影が始まった');
  // Q: 記事の要約にキーワード
  ids.q = cluster('映画祭が開幕', '社会');
  article(ids.q, version(ids.q, 1, '映画祭が開幕'), '映画祭レポート', '今田美桜が登壇した');
  // S: 旧版の記事タイトルにだけキーワード（行は最新版 v2 が返ること）
  ids.s = cluster('国会で審議が続く', '政治');
  article(ids.s, version(ids.s, 1, '国会で審議が続く'), '今田美桜の起用が話題に', '初報');
  article(ids.s, version(ids.s, 2, '国会で審議が続く（続報）'), '審議が続く', '続報');
  // T: もう一方のキーワード（予算）で一致
  ids.t = cluster('来年度予算が可決', '経済');
  article(ids.t, version(ids.t, 1, '来年度予算が可決'), '予算案が可決', '本会議で可決');
  // R: どちらにも一致しない
  ids.r = cluster('国際会議が閉幕', '国際');
  article(ids.r, version(ids.r, 1, '国際会議が閉幕'), '会議が閉幕', '共同声明を採択');

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
  dir = mkdtempSync(join(tmpdir(), 'ichigyo-watch-'));
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

const kw = encodeURIComponent('今田美桜');

test('watch: クラスタ題・記事題・要約への部分一致で拾い、行は最新版のみ', async () => {
  const data = await stories(`tab=watch&keywords=${kw}`);
  assert.equal(data.total, 3);
  const byCluster = new Map(data.stories.map((s) => [s.cluster_id, s]));
  assert.ok(byCluster.has(ids.p));
  assert.ok(byCluster.has(ids.q));
  assert.ok(byCluster.has(ids.s));
  assert.equal(byCluster.get(ids.s).version_no, 2);
  assert.equal(byCluster.has(ids.r), false);
});

test('watch: 複数キーワードは OR で合算される', async () => {
  const data = await stories(`tab=watch&keywords=${kw},${encodeURIComponent('予算')}`);
  assert.equal(data.total, 4);
});

test('watch: カテゴリ絞り込みとカテゴリ別件数が整合する', async () => {
  const data = await stories(`tab=watch&keywords=${kw}&category=社会`);
  assert.equal(data.total, 1);
  assert.equal(data.stories[0].cluster_id, ids.q);
  const sum = data.categories.reduce((n, c) => n + c.count, 0);
  assert.equal(sum, 3);
});

test('watch: キーワードなしでは一致なし、% はワイルドカードにならない', async () => {
  const none = await stories('tab=watch');
  assert.equal(none.total, 0);
  const pct = await stories(`tab=watch&keywords=${encodeURIComponent('%')}`);
  assert.equal(pct.total, 0);
});

test('watch: ページネーションが total と整合する', async () => {
  const page1 = await stories(`tab=watch&keywords=${kw}&limit=2&offset=0`);
  assert.equal(page1.total, 3);
  assert.equal(page1.stories.length, 2);
  const page2 = await stories(`tab=watch&keywords=${kw}&limit=2&offset=2`);
  assert.equal(page2.total, 3);
  assert.equal(page2.stories.length, 1);
});
