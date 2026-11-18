// 版作成の厳格化（2026-11-16）の回帰テスト。
// ユーザー指摘: 数字が変わっただけの続報でも版が増え、「版は違うのに同じような
// 内容」になる（実例: 福岡市長選の投票率速報が v15 まで増殖していた）。
// 版は「新しい事実が足されたとき」だけ作るという定義に合わせ、数値トークンは
// 値ではなく単位の型で比べ、同じ型の数値の変化だけの見出しは「改訂」として
// 現在版に取り込む。経緯と方針は REQUIREMENTS.md の「版作成の厳格化」参照。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { ingestArticles } from '../src/collector.mjs';
import { hasStoryAnchor, isNewFactFollowUp, isNumericOnlyRevision, numericUnitType } from '../src/matching.mjs';
import { foldNumericOnlyVersions } from '../src/lifecycle.mjs';

const clusterOf = (db, url) => db.prepare('SELECT cluster_id FROM articles WHERE url = ?').get(url)?.cluster_id;
const versionOf = (db, url) => db.prepare('SELECT v.version_no FROM articles a JOIN versions v ON v.id = a.version_id WHERE a.url = ?').get(url)?.version_no;
const versionTitle = (db, cid, no) => db.prepare('SELECT title FROM versions WHERE cluster_id = ? AND version_no = ?').get(cid, no)?.title;

/* ---------- numericUnitType ---------- */

test('型: 数値トークンは単位の型に正規化される', () => {
assert.equal(numericUnitType('46.2%'), '%');
assert.equal(numericUnitType('45.8％'), '%', '全角％も同一視する');
assert.equal(numericUnitType('12人'), '人');
assert.equal(numericUnitType('2026年'), '年');
assert.equal(numericUnitType('60'), '', '単位のない数値は空の型');
assert.equal(numericUnitType('死亡'), null, 'キーワードは数値トークンではない');
});

/* ---------- isNumericOnlyRevision ---------- */

test('改訂: 得票率の値が変わっただけの見出しは改訂', () => {
assert.equal(isNumericOnlyRevision(['福岡市長選 投票率45.8%'], '福岡市長選 投票率46.2%'), true);
assert.equal(isNumericOnlyRevision(['福岡市長選 投票率45.8%'], '福岡市長選 投票率46.2% 前回を上回る'), true,
'多少の文言追加があっても、数値以外の新規性が半分未満なら改訂');
});

test('改訂ではない: 数値以外に実質的な新情報がある（防衛費の実例）', () => {
assert.equal(isNumericOnlyRevision(['防衛費5年で60兆円規模 政府調整'],
'5年間の防衛費、60兆円前後で調整 防衛省は70兆円台を要求'), false,
'70 は既存の裸数値と同じ型だが、新しい主体の新しい主張を含むため改訂ではない');
});

test('改訂ではない: 日付だけが違う日替わりコーナーの別日分（実DBの実例）', () => {
assert.equal(isNumericOnlyRevision(
['【きょうのおはBiz 11月13日（金）】「良品計画」顧客情報漏えい'],
'【きょうのおはBiz 11月12日（木）】"個人情報持たない"企業も'), false,
'日付は話題の事実ではないため、改訂の根拠にしない');
});

test('改訂ではない: 裸数値（スコア）だけが重なる別試合（実DBの実例）', () => {
assert.equal(isNumericOnlyRevision(
['ヴァンラーレ連敗ストップも降格圏18位に｜青森スポーツ｜青森ニュース｜Web東奥'],
'ワッツ、91－95で敗戦 通算4勝13敗｜青森スポーツ｜青森ニュース｜Web東奥'), false,
'単位のない数値はどの見出しにも現れるため、改訂の根拠にしない');
assert.equal(isNumericOnlyRevision(
['東芝の中間最終利益2.5兆円、キオクシア株の評価益などで前年同期の8倍…営業利益は倍増2347億円'],
'東芝 純利益4.4兆円→2.5兆円 キオクシア株が大きく影響'), false,
'兆円は単位として拾えない裸数値になるため、金額の改訂も根拠にしない（保守側）');
});

test('改訂ではない: 事実キーワードの新規出現と、型ごと新しい数値', () => {
assert.equal(isNumericOnlyRevision(['市内で火災が発生 けが人なし'], '市内で火災が発生 死者2人が確認される'), false,
'死者の出現は新しい事実');
assert.equal(isNumericOnlyRevision(['福岡市長選 投票率45.8%'], '福岡市長選 投票率46.2% けが3人'), false,
'人という型自体が新しい数値は新しい事実');
assert.equal(isNumericOnlyRevision(['福岡市長選 投票率45.8%'], '福岡市長選 投票率は高水準'), false,
'事実トークンの変化が無い見出しは改訂判定の対象外（通常の判定に任せる）');
});

/* ---------- isNewFactFollowUp: 改訂ガードと正当な続報の両立 ---------- */

test('版判定: 投票率の改訂は版を作らない（錨はある）', () => {
const existing = ['福岡市長選 投票率45.8%'];
const follow = '福岡市長選 投票率46.2% 前回を上回る';
const anchor = { clusterTitle: existing[0], articleTitles: existing };
assert.equal(hasStoryAnchor(follow, existing[0], existing, existing), true, '前提として錨はある');
assert.equal(isNewFactFollowUp(existing, follow, anchor), false, '改訂だけでは版を作らない');
assert.equal(isNewFactFollowUp(existing, follow), false, '錨なし呼び出しでも改訂ガードは効く');
});

test('版判定: 防衛費の正当な続報は従来どおり版を作る', () => {
const existing = ['防衛費5年で60兆円規模 政府調整'];
const follow = '5年間の防衛費、60兆円前後で調整 防衛省は70兆円台を要求';
const anchor = { clusterTitle: existing[0], articleTitles: existing };
assert.equal(isNewFactFollowUp(existing, follow, anchor), true);
});

test('版判定: 死者の確認は新しい事実として版を作る', () => {
const existing = ['市内で火災が発生 けが人なし'];
const follow = '市内で火災が発生 死者2人が確認される';
const anchor = { clusterTitle: existing[0], articleTitles: existing };
assert.equal(isNewFactFollowUp(existing, follow, anchor), true);
});

/* ---------- 取り込み: 改訂は現在版に取り込まれ、代表見出しが更新される ---------- */

const item = (title, url, source = 'NHK') => ({ title, url, source, summary: title + '。', publishedAt: '2026-11-16T01:00:00.000Z' });

test('取り込み: 投票率の改訂は v1 に取り込まれ、代表見出しが新しい方へ更新される', () => {
const db = openDb(':memory:');
const now = new Date('2026-11-16T05:00:00.000Z');
ingestArticles(db, [item('福岡市長選 投票率45.8%', 'https://e.com/e1')], now);
ingestArticles(db, [item('福岡市長選 投票率46.2% 前回を上回る', 'https://e.com/e2', '朝日')], now);
const cid = clusterOf(db, 'https://e.com/e1');
assert.equal(clusterOf(db, 'https://e.com/e2'), cid);
assert.equal(db.prepare('SELECT COUNT(*) c FROM versions WHERE cluster_id = ?').get(cid).c, 1, '版は増えない');
assert.equal(versionOf(db, 'https://e.com/e2'), 1, '改訂記事は現在版に入る');
assert.equal(versionTitle(db, cid, 1), '福岡市長選 投票率46.2% 前回を上回る', '代表見出しは新しい方へ更新される');
// さらに次の改訂も同じ版に取り込まれ、見出しはさらに新しい方へ
ingestArticles(db, [item('福岡市長選 投票率47.1%', 'https://e.com/e3', '読売')], now);
assert.equal(db.prepare('SELECT COUNT(*) c FROM versions WHERE cluster_id = ?').get(cid).c, 1);
assert.equal(versionTitle(db, cid, 1), '福岡市長選 投票率47.1%');
});

/* ---------- foldNumericOnlyVersions: 既存データの遡及適用 ---------- */

let seq = 0;
function buildCluster(db, title, versions) {
const nowIso = '2026-11-15T01:00:00.000Z';
const cid = Number(db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at, importance_score) VALUES (?,?,?,?, 0)')
.run(title, '社会', nowIso, nowIso).lastInsertRowid);
versions.forEach((v, i) => {
const vid = Number(db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?,?,?,?)')
.run(cid, i + 1, v.title, nowIso).lastInsertRowid);
for (const a of v.articles) {
seq++;
db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at) VALUES (?,?,?,?,?,?,?,?)')
.run(cid, vid, 'NHK', a.title, `https://example.com/nr-${seq}`, a.title + '。', nowIso, nowIso);
}
});
return cid;
}
const versionsOf = (db, cid) => db.prepare('SELECT COUNT(*) c FROM versions WHERE cluster_id = ?').get(cid).c;

test('畳み込み: 投票率の改訂版が前の版へ畳まれ、段階変化の版は残る', () => {
const db = openDb(':memory:');
const cid = buildCluster(db, '福岡市長選 投票率45.8%', [
{ title: '福岡市長選 投票率45.8%', articles: [{ title: '福岡市長選 投票率45.8%' }] },
{ title: '福岡市長選 投票率46.2% 前回を上回る', articles: [{ title: '福岡市長選 投票率46.2% 前回を上回る' }] },
{ title: '福岡市長選 現職の大西氏の当選が確定', articles: [{ title: '福岡市長選 現職の大西氏の当選が確定' }] },
]);
assert.equal(foldNumericOnlyVersions(db), 1);
assert.equal(versionsOf(db, cid), 2, '改訂版だけが畳まれる');
assert.equal(versionTitle(db, cid, 1), '福岡市長選 投票率46.2% 前回を上回る', '代表見出しは畳んだ版（新しい方）へ更新');
assert.equal(versionTitle(db, cid, 2), '福岡市長選 現職の大西氏の当選が確定', '残った版は番号が振り直される');
const moved = db.prepare('SELECT v.version_no FROM articles a JOIN versions v ON v.id = a.version_id WHERE a.title = ?').get('福岡市長選 投票率46.2% 前回を上回る');
assert.equal(moved.version_no, 1, '畳んだ版の記事は前の版へ移る');
assert.equal(foldNumericOnlyVersions(db), 0, '2回目は冪等');
});

test('畳み込み: 改訂の連鎖はまとめて畳まれる', () => {
const db = openDb(':memory:');
const cid = buildCluster(db, '福岡市長選 投票率45.8%', [
{ title: '福岡市長選 投票率45.8%', articles: [{ title: '福岡市長選 投票率45.8%' }] },
{ title: '福岡市長選 投票率46.2%', articles: [{ title: '福岡市長選 投票率46.2%' }] },
{ title: '福岡市長選 投票率47.1%', articles: [{ title: '福岡市長選 投票率47.1%' }] },
]);
assert.equal(foldNumericOnlyVersions(db), 2);
assert.equal(versionsOf(db, cid), 1);
assert.equal(versionTitle(db, cid, 1), '福岡市長選 投票率47.1%', '代表見出しは最も新しい改訂になる');
assert.equal(foldNumericOnlyVersions(db), 0, '冪等');
});

test('畳み込み: 段階変化の版を挟んだ改訂は畳まれず、冪等性が保たれる', () => {
const db = openDb(':memory:');
const cid = buildCluster(db, '福岡市長選 投票率45.8%', [
{ title: '福岡市長選 投票率45.8%', articles: [{ title: '福岡市長選 投票率45.8%' }] },
{ title: '福岡市長選 現職の大西氏の当選が確定', articles: [{ title: '福岡市長選 現職の大西氏の当選が確定' }] },
{ title: '福岡市長選 投票率46.2%', articles: [{ title: '福岡市長選 投票率46.2%' }] },
]);
// v3 は v1 の数値の改訂だが、直前の v2（当選確定という段階変化）の改訂ではない
// ため畳まない。v2 へ畳んで代表見出しを書き換えると、次の実行でさらに畳まれて
// 段階版そのものが消えてしまう（実DBの初版実装で発生した非冪等な挙動への回帰防止）
assert.equal(foldNumericOnlyVersions(db), 0);
assert.equal(versionsOf(db, cid), 3);
assert.equal(versionTitle(db, cid, 2), '福岡市長選 現職の大西氏の当選が確定', '段階版の代表見出しは書き換わらない');
assert.equal(foldNumericOnlyVersions(db), 0, '2回目も0件（冪等）');
});

test('畳み込み: 事実の追加で作られた版は畳まれない', () => {
const db = openDb(':memory:');
const fire = buildCluster(db, '市内で火災が発生 けが人なし', [
{ title: '市内で火災が発生 けが人なし', articles: [{ title: '市内で火災が発生 けが人なし' }] },
{ title: '市内で火災が発生 死者2人が確認される', articles: [{ title: '市内で火災が発生 死者2人が確認される' }] },
]);
const defense = buildCluster(db, '防衛費5年で60兆円規模 政府調整', [
{ title: '防衛費5年で60兆円規模 政府調整', articles: [{ title: '防衛費5年で60兆円規模 政府調整' }] },
{ title: '5年間の防衛費、60兆円前後で調整 防衛省は70兆円台を要求', articles: [{ title: '5年間の防衛費、60兆円前後で調整 防衛省は70兆円台を要求' }] },
]);
assert.equal(foldNumericOnlyVersions(db), 0);
assert.equal(versionsOf(db, fire), 2);
assert.equal(versionsOf(db, defense), 2);
});
