// 背景社説チェック（2026-11-15 ユーザー承認）の検証。
// - 候補選定: 重要タブ上位（スコア40以上）のうち未チェックを優先し、
//   「最終チェックから24時間超」かつ「first_seen から3日以内」のチェック済みを再チェック対象にする。
// - バッチ実行: 1回あたり最大20件・並列2で fetchEditorials を回し、
//   完了時に重要度スコアが再計算される（社説ボーナスの配線）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { PAPERS, editorialCheckCandidates, checkTopEditorials, importanceFor } from '../src/collector.mjs';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const hoursAgo = (h, base = NOW) => new Date(base.getTime() - h * 3600000).toISOString();
let seq = 0;

function makeCluster(db, { score = 100, firstSeenH = 1, lastSeenH = 1 } = {}) {
  seq++;
  const c = db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at, importance_score) VALUES (?, ?, ?, ?, ?)')
    .run(`背景社説検証${seq} 大きな出来事`, '社会', hoursAgo(firstSeenH), hoursAgo(lastSeenH), score);
  const clusterId = Number(c.lastInsertRowid);
  const v = db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1, ?, ?)')
    .run(clusterId, `背景社説検証${seq}`, hoursAgo(lastSeenH));
  const versionId = Number(v.lastInsertRowid);
  db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(clusterId, versionId, '朝日', `背景社説検証${seq} 大きな出来事`, `https://example.com/ed${seq}`, '概要', hoursAgo(lastSeenH), hoursAgo(lastSeenH));
  return clusterId;
}

/** 全紙チェック済みの状態を作る（checked_at を指定時刻にする）。 */
function markChecked(db, clusterId, checkedAtIso) {
  const ins = db.prepare('INSERT INTO editorials (cluster_id, paper, found, title, summary, url, checked_at) VALUES (?, ?, 0, ?, ?, ?, ?)');
  for (const paper of PAPERS) ins.run(clusterId, paper, '', '', '', checkedAtIso);
}

const emptyFetch = async () => ({
  ok: true,
  text: async () => '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>empty</title></channel></rss>',
});

test('候補選定: 未チェックのみ・再チェック条件（24時間超かつ3日以内）・スコア下限', () => {
  const db = openDb(':memory:');
  const unchecked = makeCluster(db);
  const lowScore = makeCluster(db, { score: 39 });
  const checkedRecent = makeCluster(db);
  markChecked(db, checkedRecent, hoursAgo(1));
  const recheck = makeCluster(db, { firstSeenH: 24 });
  markChecked(db, recheck, hoursAgo(25));
  const tooOldTopic = makeCluster(db, { firstSeenH: 4 * 24 });
  markChecked(db, tooOldTopic, hoursAgo(25));
  const checkedStaleButFresh = makeCluster(db, { firstSeenH: 2 * 24 });
  markChecked(db, checkedStaleButFresh, hoursAgo(23)); // 24時間以内なので再チェック対象外

  const cands = editorialCheckCandidates(db, { now: NOW });
  const byId = new Map(cands.map((c) => [c.id, c.force]));
  assert.equal(byId.get(unchecked), false, '未チェックは force=false で候補になる');
  assert.equal(byId.has(lowScore), false, 'スコア下限（40）未満は候補外');
  assert.equal(byId.has(checkedRecent), false, 'チェック直後は候補外');
  assert.equal(byId.get(recheck), true, '24時間超＋発生3日以内は force=true で再チェック');
  assert.equal(byId.has(tooOldTopic), false, '発生から3日を超えたら再チェックしない');
  assert.equal(byId.has(checkedStaleButFresh), false, '最終チェックから24時間以内は再チェックしない');
});

test('候補選定: 未チェックが再チェック対象より先に並ぶ', () => {
  const db = openDb(':memory:');
  // 再チェック対象の方が last_seen が新しく（順位は上でも）、未チェックを先に処理する
  const recheck = makeCluster(db, { firstSeenH: 24, lastSeenH: 0 });
  markChecked(db, recheck, hoursAgo(30));
  const unchecked = makeCluster(db, { lastSeenH: 10 });
  const cands = editorialCheckCandidates(db, { now: NOW });
  assert.deepEqual(cands.map((c) => c.id), [unchecked, recheck]);
});

test('バッチ実行: 候補をチェックして社説行を作り、重要度を再計算する（上限20件）', async () => {
  const db = openDb(':memory:');
  const ids = [];
  for (let k = 0; k < 25; k++) ids.push(makeCluster(db));
  const before = db.prepare('SELECT COUNT(*) AS c FROM editorials').get().c;
  assert.equal(before, 0);
  const result = await checkTopEditorials(db, { fetchImpl: emptyFetch, now: NOW });
  assert.equal(result.candidates, 25);
  assert.equal(result.checked, 20, '1回のバッチは最大20クラスタまで');
  const rows = db.prepare('SELECT COUNT(*) AS c FROM editorials').get().c;
  assert.equal(rows, 20 * PAPERS.length, 'チェックしたクラスタごとに全紙分の行ができる');
  // 重要度再計算の配線: チェック済みクラスタのスコアは importanceFor と一致する
  const checkedId = ids[0];
  const stored = db.prepare('SELECT importance_score AS s FROM clusters WHERE id = ?').get(checkedId).s;
  assert.equal(stored, importanceFor(db, checkedId));
});

test('バッチ実行: 24時間超で再チェックされ checked_at が更新される', async () => {
  const db = openDb(':memory:');
  const id = makeCluster(db, { firstSeenH: 24 });
  markChecked(db, id, hoursAgo(30));
  const result = await checkTopEditorials(db, { fetchImpl: emptyFetch, now: NOW });
  assert.equal(result.checked, 1);
  const last = db.prepare('SELECT MAX(checked_at) AS m FROM editorials WHERE cluster_id = ?').get(id).m;
  assert.ok(new Date(last).getTime() > new Date(hoursAgo(30)).getTime(), 'checked_at が新しい時刻に更新される');
});
