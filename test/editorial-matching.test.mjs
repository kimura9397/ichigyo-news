// 社説の誤マッチ対策（2026-11-15）の回帰テスト。
// - 誤マッチ再現: ソウルで開催された車いすマラソンのニュースに、ソウルへの原爆投下に
//   関する社説が紐づいた実例。旧判定（見出し和集合と特徴語2つ以上共有）では採用されていた。
// - 正例: 具体的な政策名を共有するペアと、2字の話題語（日銀・利上げ）しか共有語が
//   無いペアが、厳格化後も「関連あり」を維持すること。
// - フォールバック廃止: topicTerms が取れないクラスタでは社説検索自体を行わないこと。
// - 再評価: 旧判定で保存された誤った found=1 が降格され、正例は残り、
//   降格したクラスタの重要度（社説ボーナス）が再計算されること。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { editorialRelated, fetchEditorials, importanceFor, PAPERS } from '../src/collector.mjs';
import { reevaluateEditorials } from '../src/lifecycle.mjs';

const MARATHON_TITLE = '車いすマラソン、ソウルで開催　日本選手が入賞';
const MARATHON_HEADS = [
  '車いすマラソン、ソウルで開催　日本選手が入賞',
  'ソウル車いすマラソンに3万人が参加　沿道に声援',
  '車いすの部、ソウル大会で日本勢が表彰台',
  '韓国・ソウルで車いすマラソン、交通規制を実施',
];
const BOMB_EDITORIAL = '社説：ソウルへの原爆投下計画が問うもの';

const POLICY_TITLE = '政治資金規正法の改正案、衆院を通過';
const POLICY_HEADS = [
  POLICY_TITLE,
  '資金規正法改正案が衆院通過、野党は反発',
  '政治資金規正法改正、今国会で成立へ',
];
const POLICY_EDITORIAL = '社説：政治資金規正法の改正を急げ';

test('誤マッチ再現: 車いすマラソン（ソウル開催）と原爆投下の社説は関連なし', () => {
  assert.equal(editorialRelated(BOMB_EDITORIAL, MARATHON_TITLE, MARATHON_HEADS), false);
});

test('正例: 政策名（政治資金規正法）を共有する社説は関連ありを維持', () => {
  assert.equal(editorialRelated(POLICY_EDITORIAL, POLICY_TITLE, POLICY_HEADS), true);
});

test('正例: 2字の話題語（日銀・利上げ）のみの共有でも関連ありを維持', () => {
  const bojTitle = '日銀が利上げを決定、追加利上げも示唆';
  const bojHeads = [bojTitle, '日銀、利上げ決定　植田総裁が会見で説明', '利上げ決定で円高進む　日銀の判断に市場注目'];
  assert.equal(editorialRelated('社説：日銀の利上げ判断は妥当か', bojTitle, bojHeads), true);
});

test('無関係な社説: 共通の地名しかない別話題は関連なし', () => {
  const title = '韓国大統領が来日、首脳会談へ';
  const heads = [title, '韓国大統領、羽田に到着　歓迎式典も'];
  assert.equal(editorialRelated('社説：韓国の原爆被害者への支援を急げ', title, heads), false);
});

/* ---------- fetchEditorials のフィクスチャ ---------- */

let seq = 0;
function makeCluster(db, title, heads) {
  seq++;
  const nowIso = new Date().toISOString();
  const c = db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at, importance_score) VALUES (?, ?, ?, ?, 0)')
    .run(title, '社会', nowIso, nowIso);
  const clusterId = Number(c.lastInsertRowid);
  const v = db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1, ?, ?)')
    .run(clusterId, title, nowIso);
  const versionId = Number(v.lastInsertRowid);
  const ins = db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  heads.forEach((h, i) => ins.run(clusterId, versionId, '朝日', h, `https://example.com/m${seq}-${i}`, '概要', nowIso, nowIso));
  return clusterId;
}

function rssFetch(xml, counter = { calls: 0 }) {
  return async () => {
    counter.calls++;
    return { ok: true, text: async () => xml };
  };
}

const POLICY_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>search</title>
<item><title>${POLICY_EDITORIAL}</title><link>https://example.com/editorial1</link><description>政治資金規正法の改正についての社説。</description><source url="https://www.asahi.com">朝日新聞</source><pubDate>Sat, 15 Nov 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`;

test('fetchEditorials: 一致する社説は従来どおり見つかる（朝日のみ found=1）', async () => {
  const db = openDb(':memory:');
  const id = makeCluster(db, POLICY_TITLE, POLICY_HEADS);
  const rows = await fetchEditorials(db, id, { fetchImpl: rssFetch(POLICY_RSS) });
  assert.equal(rows.length, PAPERS.length);
  const byPaper = new Map(rows.map((r) => [r.paper, r.found]));
  assert.equal(byPaper.get('朝日'), 1);
  assert.equal(byPaper.get('毎日'), 0);
  assert.equal(byPaper.get('読売'), 0);
});

test('fetchEditorials: topicTerms が無いクラスタでは検索自体をスキップする（フォールバック廃止）', async () => {
  const db = openDb(':memory:');
  // 「首相」「動静」は topicTerms のストップ語のみで構成され、検索語が取れないタイトル
  const id = makeCluster(db, '首相 動静', ['首相 動静']);
  const counter = { calls: 0 };
  const rows = await fetchEditorials(db, id, { fetchImpl: rssFetch(POLICY_RSS, counter) });
  assert.equal(counter.calls, 0, '素の「○○新聞 社説」検索を含め、一切検索しない');
  assert.ok(rows.every((r) => r.found === 0));
});

/* ---------- 再評価（reevaluateEditorials） ---------- */

function insertEditorial(db, clusterId, paper, title) {
  db.prepare('INSERT INTO editorials (cluster_id, paper, found, title, summary, url, checked_at) VALUES (?, ?, 1, ?, ?, ?, ?)')
    .run(clusterId, paper, title, '概要', 'https://example.com/ed', new Date().toISOString());
}

test('再評価: 誤った found は降格され、正例は残り、重要度が再計算される', () => {
  const db = openDb(':memory:');
  const bad = makeCluster(db, MARATHON_TITLE, MARATHON_HEADS);
  insertEditorial(db, bad, '読売', BOMB_EDITORIAL);
  const good = makeCluster(db, POLICY_TITLE, POLICY_HEADS);
  insertEditorial(db, good, '朝日', POLICY_EDITORIAL);
  // 両クラスタとも found=1 前提でスコアを確定させておく（社説ボーナス込み）
  for (const id of [bad, good]) {
    db.prepare('UPDATE clusters SET importance_score = ? WHERE id = ?').run(importanceFor(db, id), id);
  }
  const badBefore = db.prepare('SELECT importance_score AS s FROM clusters WHERE id = ?').get(bad).s;

  const demoted = reevaluateEditorials(db);
  assert.equal(demoted, 1, '誤マッチの1件だけが降格される');

  const badRow = db.prepare('SELECT found, title FROM editorials WHERE cluster_id = ?').get(bad);
  assert.equal(badRow.found, 0);
  assert.equal(badRow.title, '', '降格時はタイトルを空に戻す');
  const goodRow = db.prepare('SELECT found FROM editorials WHERE cluster_id = ?').get(good);
  assert.equal(goodRow.found, 1, '正例は降格されない');

  const badAfter = db.prepare('SELECT importance_score AS s FROM clusters WHERE id = ?').get(bad).s;
  assert.equal(badAfter, importanceFor(db, bad), '降格したクラスタのスコアは再計算値と一致する');
  assert.ok(badAfter < badBefore, '社説ボーナス分だけスコアが下がる');
});
