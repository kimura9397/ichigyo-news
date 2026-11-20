// アンカー P0 のベース縮小（監査の方向4、Issue #56）の回帰テスト。
// 既定モード 'articles-vetted': P0 の足場にできる記事タイトルは、呼び出し側が
// p0ArticleTitles で渡した「アンカーを通過して受理された版に属する記事」だけ。
// v1 は無条件に受理されるため、その記事（取り込み時に既存版へ溜まった別ニュースの
// 記事を含む）は足場にしない。全面縮小（'titles'）と違い、受理済み版の記事を
// 足場にする正当な続報の連鎖（枚方）は割れない。
import { test} from 'node:test';
import assert from 'node:assert/strict';
import { openDb} from '../src/db.mjs';
import { hasStoryAnchor} from '../src/matching.mjs';
import { splitForeignVersions} from '../src/lifecycle.mjs';

/* ---------- ユニット: v1 の記事は足場にならない ---------- */

const CLUSTER_3835 = '球磨村で震度1 - 47NEWS';
// v1 にダンプされていた別ニュースの記事（実データのクラスタ3835 の型）
const DUMPED = '首都圏連続強盗 検察側 “実行役”に無期懲役求刑';
// その別ニュースの続報。標題・版タイトルとは一致せず、ダンプ記事とだけ似る
const DUMPED_FOLLOW = '首都圏連続強盗、実行役に無期懲役を求刑 検察側';

test('アンカー: v1 に溜まった別ニュースの記事は P0 の足場にならない', () => {
const vTitles = [CLUSTER_3835];
const aTitles = [CLUSTER_3835, DUMPED];
// v1 の記事しかない状態（足場ゼロ）では通らない
assert.equal(hasStoryAnchor(DUMPED_FOLLOW, CLUSTER_3835, vTitles, aTitles, { p0ArticleTitles: []}), false);
// 従来モード（'all'）では同じ候補が v1 の記事を足場に通っていた（対照）
assert.equal(hasStoryAnchor(DUMPED_FOLLOW, CLUSTER_3835, vTitles, aTitles, { p0Base: 'all'}), true);
});

test('アンカー: 受理済み版の記事は P0 の足場になる（枚方の連鎖）', () => {
const cluster = '大阪 枚方女児死亡 体に古いもの含め数10か所のあざ';
const vTitles = [cluster, '大阪 枚方 3歳女児死亡で両親逮捕 虐待か', '大阪・枚方3歳女児虐待死 3月にも女児の顔にあざ 8月の死亡時には数十カ所確認'];
const aTitles = [...vTitles, '3歳娘虐待か、殺人容疑で父親逮捕 あざ数十カ所、放置疑いで母親も [大阪府]'];
const cand = '3歳長女を殴り殺害か、容疑で父親逮捕 母親も遺棄致死容疑';
// 足場は v2・v3 の記事（v1 の記事＝標題は除く）。取り込み・修復の両物差しで通る
const vetted = aTitles.slice(1);
assert.equal(hasStoryAnchor(cand, cluster, vTitles, aTitles, { p0ArticleTitles: vetted}), true);
assert.equal(hasStoryAnchor(cand, cluster, vTitles, aTitles, { strict: true, p0ArticleTitles: vetted}), true);
// 足場がなければ通らない（この続報は標題・版タイトルとはバイグラムが一致しない）
assert.equal(hasStoryAnchor(cand, cluster, vTitles, aTitles, { p0ArticleTitles: []}), false);
});

/* ---------- 修復: v1 の記事を足場にした別ニュースの版が切り出される ---------- */

let seq = 0;
function buildScaffoldedCluster(db) {
const nowIso = '2026-11-19T01:00:00.000Z';
const cid = Number(db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at, importance_score) VALUES (?,?,?,?, 0)')
.run(CLUSTER_3835, '社会', nowIso, nowIso).lastInsertRowid);
const mk = (vno, title, arts) => {
const vid = Number(db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?,?,?,?)')
.run(cid, vno, title, nowIso).lastInsertRowid);
for (const t of arts) {
seq++;
db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at) VALUES (?,?,?,?,?,?,?,?)')
.run(cid, vid, '共同', t, `https://example.com/ab-${seq}`, t + '。', nowIso, nowIso);
}
};
// v1: 標題の記事＋ダンプされた別ニュースの記事
mk(1, CLUSTER_3835, [CLUSTER_3835, DUMPED]);
// v2: ダンプ記事の続報（旧修復では v1 の記事を足場に残っていた）
mk(2, '首都圏連続強盗、実行役の被告に無期懲役求刑', ['首都圏連続強盗、実行役の被告に無期懲役求刑']);
return cid;
}
const versionsOf = (db, cid) => db.prepare('SELECT COUNT(*) c FROM versions WHERE cluster_id =?').get(cid).c;

test('修復: v1 の記事だけを足場にする別ニュースの版は切り出される', () => {
const db = openDb(':memory:');
const cid = buildScaffoldedCluster(db);
assert.equal(splitForeignVersions(db), 1);
assert.equal(versionsOf(db, cid), 1, '元のクラスタには v1 だけが残る');
assert.equal(splitForeignVersions(db), 0, '2回目は冪等');
});

test('修復: 従来モード（all）では同じ版が v1 の記事を足場に残る（対照）', () => {
const db = openDb(':memory:');
buildScaffoldedCluster(db);
assert.equal(splitForeignVersions(db, { p0Base: 'all'}), 0);
});
