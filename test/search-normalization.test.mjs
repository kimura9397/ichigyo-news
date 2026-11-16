// キーワード検索/ウォッチの表記ゆれ正規化と照合範囲のテスト。
// 背景（ユーザー実機バグ）: 検索「情報漏洩」がヒットしない。記事側は新聞表記の
// 「情報漏えい」が主流で部分一致しない。正規化レイヤー（NFKC＋表記ゆれ対応表）を
// クエリ側・対象側の両方に適用し、照合範囲はクラスタ題＋全版の記事タイトル/要約。
// 本文は 2026-11-16 の本文機能廃止で照合範囲から外れた。
// シードは search_text / title_norm を入れずに投入し、サーバー起動時の
// refreshSearchText でシャドウカラムが埋まる経路もあわせて検証する。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';
import { normalizeForSearch, buildArticleSearchText } from '../src/normalize.mjs';

test('normalize: 漏洩と漏えいは同じ正準形になる', () => {
  assert.equal(normalizeForSearch('情報漏洩'), '情報漏えい');
  assert.equal(normalizeForSearch('情報漏えい'), '情報漏えい');
});

test('normalize: NFKC と英字の小文字化', () => {
  assert.equal(normalizeForSearch('ＡＢＣ１２３'), 'abc123');
  assert.equal(normalizeForSearch('NEWS'), 'news');
});

test('normalize: 対応表のペアは双方向に寄る（遵守⇔順守）', () => {
  assert.equal(normalizeForSearch('法令遵守'), normalizeForSearch('法令順守'));
});

test('normalize: 無関係な語は寄せられない', () => {
  assert.notEqual(normalizeForSearch('情報開示'), normalizeForSearch('情報漏えい'));
  assert.equal(normalizeForSearch('障害者'), '障害者');
});

test('buildArticleSearchText: 照合テキストはタイトルと要約だけ（正規化込み）', () => {
  const s = buildArticleSearchText('情報漏洩の見出し', '要約テキスト');
  assert.ok(s.includes('情報漏えい'));
  assert.ok(s.includes('要約テキスト'));
});

/* ---------- サーバー統合 ---------- */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8920;
const BASE = `http://127.0.0.1:${PORT}`;
let proc;
let dir;
const ids = {};
let seq = 0;

function seed(dbPath) {
  const db = openDb(dbPath);
  const now = new Date().toISOString();
  const cluster = (title) => Number(db.prepare(
    'INSERT INTO clusters (title, category, first_seen_at, last_seen_at, importance_score) VALUES (?, ?, ?, ?, ?)',
  ).run(title, '社会', now, now, 10).lastInsertRowid);
  const version = (cid, no, title) => Number(db.prepare(
    'INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, ?, ?, ?)',
  ).run(cid, no, title, now).lastInsertRowid);
  const article = (cid, vid, title, summary) => {
    seq++;
    db.prepare(
      'INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(cid, vid, '朝日', title, `https://example.com/sn${seq}`, summary, now, now);
  };

  // L1: 記事タイトルに「漏えい」（クラスタ題にはキーワードなし）
  ids.l1 = cluster('大手企業の情報管理に不備');
  article(ids.l1, version(ids.l1, 1, '大手企業の情報管理に不備'), '顧客の個人情報漏えいか 企業が調査開始', '調査中');
  // L2: 要約にだけ「漏えい」
  ids.l2 = cluster('通信障害が発生');
  article(ids.l2, version(ids.l2, 1, '通信障害が発生'), '通信障害が発生', '復旧作業中。調査で顧客の個人情報漏えいが判明した。');
  // L3: 旧版（v1）には無く、最新版 v2 の要約にだけ「漏えい」。行は v2 が返る
  ids.l3 = cluster('証券口座の不正アクセス');
  article(ids.l3, version(ids.l3, 1, '証券口座の不正アクセス'), '口座への不正アクセスを確認', '調査中。被害の全容は分かっていない。');
  article(ids.l3, version(ids.l3, 2, '証券口座の不正アクセス（続報）'), '続報がまとまる', '調査の結果、マイナンバー画像などの情報漏えいが確認された。');
  // L4: どこにも無い
  ids.l4 = cluster('あすの天気');
  article(ids.l4, version(ids.l4, 1, 'あすの天気'), 'あすは晴れ', '予報。全国的に晴れるでしょう。');

  db.prepare('INSERT INTO fetch_runs (started_at, finished_at) VALUES (?, ?)').run(now, now);
  db.close();
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
  dir = mkdtempSync(join(tmpdir(), 'ichigyo-searchnorm-'));
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

test('検索「情報漏洩」で「情報漏えい」の記事（タイトル・要約・旧版跨ぎ）がヒットする', async () => {
  const data = await stories(`tab=watch&keywords=${encodeURIComponent('情報漏洩')}`);
  assert.equal(data.total, 3);
  const byCluster = new Map(data.stories.map((s) => [s.cluster_id, s]));
  assert.ok(byCluster.has(ids.l1), 'タイトルの漏えい');
  assert.ok(byCluster.has(ids.l2), '要約だけの漏えい');
  assert.ok(byCluster.has(ids.l3), '最新版の要約だけの漏えい');
  assert.equal(byCluster.get(ids.l3).version_no, 2, '行は最新版');
  assert.equal(byCluster.has(ids.l4), false, 'キーワードの無い記事はヒットしない');
});

test('検索「漏えい」でも同じ結果になる（正準形は双方向）', async () => {
  const data = await stories(`tab=watch&keywords=${encodeURIComponent('漏えい')}`);
  assert.equal(data.total, 3);
});

test('通常のキーワード検索は従来どおり動く', async () => {
  const data = await stories(`tab=watch&keywords=${encodeURIComponent('晴れ')}`);
  assert.equal(data.total, 1);
  assert.equal(data.stories[0].cluster_id, ids.l4);
});
