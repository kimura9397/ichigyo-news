// データライフサイクル（2026-11-15 決定）の検証。
// - 保持は「最終確認から7日」で一律。ブックマーク済みクラスタは prune から免除。
// - fetch_runs は直近30件のみ。
// - 閲覧ログ: 生イベントは30日で read_daily（日次集計）へ畳んで削除し、二重計上しない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import {
  addBookmark, removeBookmark, isBookmarked,
  pruneOldClusters, pruneFetchRuns, recordRead, foldOldReadEvents,
} from '../src/lifecycle.mjs';

const NOW = new Date('2026-11-15T00:00:00.000Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 24 * 3600000).toISOString();
let seq = 0;

function makeCluster(db, { lastSeenDaysAgo = 0, category = '社会' } = {}) {
  seq++;
  const seen = daysAgo(lastSeenDaysAgo);
  const c = db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .run(`ライフサイクル検証${seq}`, category, seen, seen);
  const clusterId = Number(c.lastInsertRowid);
  const v = db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1, ?, ?)')
    .run(clusterId, `ライフサイクル検証${seq}`, seen);
  const versionId = Number(v.lastInsertRowid);
  db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(clusterId, versionId, '朝日', '記事', `https://example.com/lc${seq}`, '', seen, seen);
  db.prepare('INSERT INTO editorials (cluster_id, paper, found, title, summary, url, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(clusterId, '朝日', 0, '', '', '', seen);
  return clusterId;
}

const exists = (db, id) => Boolean(db.prepare('SELECT id FROM clusters WHERE id = ?').get(id));

test('prune: 最終確認から7日を超えたクラスタは関連行ごと削除され、7日以内は残る', () => {
  const db = openDb(':memory:');
  const old = makeCluster(db, { lastSeenDaysAgo: 8 });
  const fresh = makeCluster(db, { lastSeenDaysAgo: 6 });
  assert.equal(pruneOldClusters(db, NOW), 1);
  assert.equal(exists(db, old), false);
  assert.equal(exists(db, fresh), true);
  // 関連行（記事・版・社説）も消えている
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM articles WHERE cluster_id = ?').get(old).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM versions WHERE cluster_id = ?').get(old).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM editorials WHERE cluster_id = ?').get(old).c, 0);
});

test('prune: ブックマーク済みクラスタは7日を超えても免除され、解除すると削除対象に戻る', () => {
  const db = openDb(':memory:');
  const id = makeCluster(db, { lastSeenDaysAgo: 30 });
  assert.equal(addBookmark(db, id, NOW), true);
  assert.equal(isBookmarked(db, id), true);
  assert.equal(pruneOldClusters(db, NOW), 0);
  assert.equal(exists(db, id), true);
  removeBookmark(db, id);
  assert.equal(isBookmarked(db, id), false);
  assert.equal(pruneOldClusters(db, NOW), 1);
  assert.equal(exists(db, id), false);
});

test('ブックマーク: 存在しないクラスタには追加できない', () => {
  const db = openDb(':memory:');
  assert.equal(addBookmark(db, 9999, NOW), false);
});

test('fetch_runs: 直近30件だけ残る', () => {
  const db = openDb(':memory:');
  for (let i = 0; i < 35; i++) {
    db.prepare('INSERT INTO fetch_runs (started_at) VALUES (?)').run(daysAgo(0));
  }
  pruneFetchRuns(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fetch_runs').get().c, 30);
  assert.equal(db.prepare('SELECT MIN(id) AS m FROM fetch_runs').get().m, 6);
});

test('閲覧集計: 30日より古い生イベントは read_daily に畳まれて消え、二重計上しない', () => {
  const db = openDb(':memory:');
  const id = makeCluster(db, { category: '政治' });
  // 40日前のイベントを3件（直接挿入: 日付を指定するため recordRead は使わない）
  const ins = db.prepare('INSERT INTO read_events (cluster_id, category, opened_at) VALUES (?, ?, ?)');
  ins.run(id, '政治', daysAgo(40));
  ins.run(id, '政治', daysAgo(40));
  ins.run(id, '経済', daysAgo(40));
  // 直近のイベントは recordRead 経由で1件
  assert.equal(recordRead(db, id, NOW), true);
  assert.equal(recordRead(db, 9999, NOW), false);

  assert.equal(foldOldReadEvents(db, NOW), 3);
  const daily = db.prepare('SELECT date, category, opens FROM read_daily ORDER BY category').all()
    .map((r) => ({ date: r.date, category: r.category, opens: r.opens }));
  assert.deepEqual(daily, [
    { date: daysAgo(40).slice(0, 10), category: '政治', opens: 2 },
    { date: daysAgo(40).slice(0, 10), category: '経済', opens: 1 },
  ]);
  // 生イベントは直近の1件だけ残る
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM read_events').get().c, 1);
  // 再実行しても集計は増えない
  assert.equal(foldOldReadEvents(db, NOW), 0);
  assert.equal(db.prepare('SELECT SUM(opens) AS s FROM read_daily').get().s, 3);
});
