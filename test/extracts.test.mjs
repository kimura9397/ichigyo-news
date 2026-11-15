// 「要点」抽出（ルールベース）のテスト。本文が取れている記事では、リードの言い換えでは
// なく「新しい事実を含む文」を選ぶこと、長さの規律（最大3文・240字）を守ること。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { extractKeyPoints, splitSentences, EXTRACT_MAX_CHARS, EXTRACT_MAX_SENTENCES } from '../src/extract.mjs';
import { refreshExtracts } from '../src/lifecycle.mjs';

const TITLE = '大規模システム障害 復旧の見通し立たず';
const BODY = [
  '大規模システム障害が発生し、復旧の見通しは立っていない。',
  'システム障害の影響で、全国の加盟店およそ12万店が営業できなくなった。',
  '利用者からは「仕事にならない」との声が相次いだ。',
  '見通しの立たない復旧作業について、同社は午後9時から緊急会見を開く。',
].join('');

test('抽出: リードの言い換えは落ち、後段の数値事実が拾われる', () => {
  const out = extractKeyPoints(TITLE, BODY);
  assert.ok(!out.includes('復旧の見通しは立っていない'), '見出しの言い換え文は含まない');
  assert.ok(out.includes('12万店'), '後段の数値を含む文が選ばれる');
});

test('抽出: 並びは記事内の出現順、文は原文ママ', () => {
  const out = extractKeyPoints(TITLE, BODY);
  const sentences = splitSentences(out);
  assert.ok(sentences.length >= 2);
  const positions = sentences.map((s) => BODY.indexOf(s));
  assert.ok(positions.every((p) => p >= 0), '文は原文のまま');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, '出現順に並ぶ');
});

test('抽出: 長さの規律（最大3文・240字）', () => {
  const body = Array.from({ length: 6 }, (_, i) =>
    `第${i + 1}の事実として、被害の申告は${(i + 1) * 37}件に達し、関係機関が状況の確認と再発防止に向けた調査を進めていることが分かった。`,
  ).join('');
  const out = extractKeyPoints('被害の申告が相次ぐ', body);
  assert.ok(out.length <= EXTRACT_MAX_CHARS, `${out.length}字 <= ${EXTRACT_MAX_CHARS}字`);
  assert.ok(splitSentences(out).length <= EXTRACT_MAX_SENTENCES);
});

test('抽出: 本文が無い・短い場合は空（従来の要約表示にフォールバック）', () => {
  assert.equal(extractKeyPoints(TITLE, ''), '');
  assert.equal(extractKeyPoints(TITLE, '短い。'), '');
  assert.equal(extractKeyPoints(TITLE, null), '');
});

test('ライフサイクル: 本文のある記事に要点が後がけされる', () => {
  const db = openDb(':memory:');
  const now = new Date().toISOString();
  const cid = Number(db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)').run(TITLE, '社会', now, now).lastInsertRowid);
  const vid = Number(db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1, ?, ?)').run(cid, TITLE, now).lastInsertRowid);
  db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, body_text, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(cid, vid, '朝日', TITLE, 'https://example.com/ex1', 'リード文', BODY, now, now);
  const changed = refreshExtracts(db);
  assert.equal(changed, 1);
  const row = db.prepare('SELECT extract_text FROM articles').get();
  assert.ok(row.extract_text.includes('12万店'));
  // 2回目は冪等
  assert.equal(refreshExtracts(db), 0);
});
