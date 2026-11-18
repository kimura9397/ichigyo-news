// 重要度 v3「直近24時間の活動だけを材料にする」の検証（2026-11-15 ユーザー定義:
// 重要度＝直近24時間で新聞の1面・2面に載る水準か）。
// - 24時間より前の記事しかないクラスタはスコア 0 で、重要タブに出ない
// - 窓内の活動ではスコアが付く。窓外の記事・版は材料に数えない
// - 公開時刻が無い記事は取得時刻で代替する
// - 社説ボーナスは窓内の活動がある場合にだけ効く（古い話を社説で復活させない）
// - ライフサイクルの全再計算で、古い高スコアが 0 に落ちる
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';
import { importanceFor } from '../src/classify.mjs';
import { recomputeAllImportance } from '../src/lifecycle.mjs';

const HOUR = 3600000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
let seq = 0;

function seedCluster(db, { title, category = '政治', versions = [] }) {
  seq++;
  const firstAt = versions[0]?.at ?? 0;
  const c = db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at, importance_score) VALUES (?, ?, ?, ?, 999)')
    .run(title, category, iso(firstAt), iso(0));
  const clusterId = Number(c.lastInsertRowid);
  versions.forEach((v, i) => {
    const ver = db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, ?, ?, ?)')
      .run(clusterId, i + 1, v.title || title, iso(v.at));
    const versionId = Number(ver.lastInsertRowid);
    for (const a of v.articles || []) {
      db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(clusterId, versionId, a.source, a.title, `https://example.com/h24-${seq}-${Math.random()}`, '', a.publishedAt === null ? null : iso(a.at ?? v.at), iso(a.fetchedAt ?? a.at ?? v.at));
    }
  });
  return clusterId;
}

test('24時間より前の記事しかないクラスタはスコア0', () => {
  const db = openDb(':memory:');
  const id = seedCluster(db, {
    title: '先週の大きな出来事',
    versions: [{ at: 30 * HOUR, articles: [
      { source: '朝日', title: '先週の大きな出来事 各紙が報道' },
      { source: '毎日', title: '先週の大きな出来事 続報' },
      { source: '読売', title: '先週の大きな出来事 反響' },
    ] }],
  });
  assert.equal(importanceFor(db, id), 0);
});

test('社説があっても、窓内の活動が無ければスコア0のまま', () => {
  const db = openDb(':memory:');
  const id = seedCluster(db, {
    title: '先週の大きな出来事',
    versions: [{ at: 30 * HOUR, articles: [{ source: '朝日', title: '先週の大きな出来事' }] }],
  });
  db.prepare('INSERT INTO editorials (cluster_id, paper, found, title, summary, url, checked_at) VALUES (?, ?, 1, ?, ?, ?, ?)')
    .run(id, '朝日', '社説', '', '', iso(1 * HOUR));
  assert.equal(importanceFor(db, id), 0);
});

test('窓内の活動でスコアが付き、窓外の記事は材料に数えない', () => {
  const db = openDb(':memory:');
  const freshOnly = seedCluster(db, {
    title: '今日の出来事',
    versions: [{ at: 1 * HOUR, articles: [{ source: '朝日', title: '今日の出来事 発表' }] }],
  });
  const mixed = seedCluster(db, {
    title: '今日の出来事',
    versions: [
      { at: 30 * HOUR, articles: [
        { source: '毎日', title: '今日の出来事 きのうの前段' },
        { source: '読売', title: '今日の出来事 きのうの前段その2' },
      ] },
      { at: 1 * HOUR, title: '今日の出来事（続報）', articles: [{ source: '朝日', title: '今日の出来事 発表' }] },
    ],
  });
  const s1 = importanceFor(db, freshOnly);
  assert.ok(s1 > 0);
  // 窓外の版・記事は数えないので、mixed のスコアは freshOnly と同値になる
  assert.ok(Math.abs(importanceFor(db, mixed) - s1) < 0.01, `${importanceFor(db, mixed)} != ${s1}`);
});

test('公開時刻が無い記事は取得時刻で代替する', () => {
  const db = openDb(':memory:');
  const id = seedCluster(db, {
    title: '時刻不明の記事',
    versions: [{ at: 1 * HOUR, articles: [{ source: '朝日', title: '時刻不明の記事', publishedAt: null, fetchedAt: 1 * HOUR }] }],
  });
  assert.ok(importanceFor(db, id) > 0);
});

test('ライフサイクルの全再計算で古い高スコアが0に落ちる', () => {
  const db = openDb(':memory:');
  const id = seedCluster(db, {
    title: '先週の大きな出来事',
    versions: [{ at: 30 * HOUR, articles: [{ source: '朝日', title: '先週の大きな出来事' }] }],
  });
  assert.equal(db.prepare('SELECT importance_score s FROM clusters WHERE id = ?').get(id).s, 999);
  recomputeAllImportance(db);
  assert.equal(db.prepare('SELECT importance_score s FROM clusters WHERE id = ?').get(id).s, 0);
});

/* ---------- 重要タブ（サーバー統合） ---------- */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8923;
const BASE = `http://127.0.0.1:${PORT}`;
let proc;
let dir;
const tabIds = {};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ichigyo-imp24-'));
  const dbPath = join(dir, 'news.db');
  const db = openDb(dbPath);
  tabIds.old = seedCluster(db, {
    title: '先週の大きな出来事',
    versions: [{ at: 30 * HOUR, articles: [
      { source: '朝日', title: '先週の大きな出来事 各紙が報道' },
      { source: '毎日', title: '先週の大きな出来事 続報' },
    ] }],
  });
  tabIds.fresh = seedCluster(db, {
    title: '今日の大きな出来事',
    versions: [{ at: 1 * HOUR, articles: [
      { source: '朝日', title: '今日の大きな出来事 各紙が報道' },
      { source: '毎日', title: '今日の大きな出来事 続報' },
    ] }],
  });
  // refresh 後の状態を再現する（ライフサイクルで全クラスタのスコアを現在値に揃える）
  recomputeAllImportance(db);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO fetch_runs (started_at, finished_at) VALUES (?, ?)').run(now, now);
  db.close();
  proc = spawn('node', ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NEWS_DB_PATH: dbPath },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/status`);
      if (res.ok) break;
    } catch { /* 起動待ち */ }
    if (Date.now() > deadline) throw new Error('サーバーが起動しませんでした');
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(() => {
  proc?.kill('SIGKILL');
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('重要タブ: 24時間より前の記事だけのクラスタは出ず、窓内のクラスタだけが出る', async () => {
  const res = await fetch(`${BASE}/api/stories?tab=important`);
  assert.equal(res.ok, true);
  const data = await res.json();
  const present = data.stories.map((s) => s.cluster_id);
  assert.ok(!present.includes(tabIds.old), '古いクラスタは重要タブに出ない');
  // 閾値は実DB分布で決めるため、ここでは「古いものが出ない」ことだけを固定する
});
