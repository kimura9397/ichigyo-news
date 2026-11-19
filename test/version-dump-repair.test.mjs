// 版ダンプの最低条件と修復パスの独立基準の回帰テスト（Issue #53、監査 2026-11-19）。
//
// 監査で見つかった誤合体の実例パターンを再現する:
// - 定型句（媒体サフィックス）だけで接着した別ニュースが取り込みで混ざらないこと
// - クラスタには参加したが、どの版ともタイトルが一致しない記事が、版へ無条件に
// 捨てられず独立クラスタになること（版ダンプの最低条件: matchScore > 0）
// - 既に混ざった版を、修復パスが取り込みより厳しい独立基準（strict）で遡って
// 分割できること（人物名・ジャンル語の接着を含む）

import { test} from 'node:test';
import assert from 'node:assert/strict';
import { openDb} from '../src/db.mjs';
import { ingestArticles} from '../src/collector.mjs';
import { splitForeignVersions} from '../src/lifecycle.mjs';
import { hasStoryAnchor} from '../src/matching.mjs';

const NOW = new Date('2026-11-19T05:00:00.000Z');
const item = (title, url, source = '共同', summary = null) => ({
title, url, source,
summary: summary?? (title + '。'),
publishedAt: '2026-11-19T01:00:00.000Z',
});
const clusterOf = (db, url) => db.prepare('SELECT cluster_id FROM articles WHERE url =?').get(url)?.cluster_id;
const versionOf = (db, url) => db.prepare('SELECT v.version_no FROM articles a JOIN versions v ON v.id = a.version_id WHERE a.url =?').get(url)?.version_no;

test('取り込み: 47NEWS サフィックスだけが共通する別ニュースは混ざらない（クラスタ3835型）', () => {
const db = openDb(':memory:');
ingestArticles(db, [item('球磨村で震度1 - 47NEWS', 'https://e.com/q1')], NOW);
ingestArticles(db, [item('鹿沼でサル約20匹目撃 - 47NEWS', 'https://e.com/m1')], NOW);
ingestArticles(db, [item('大根をおいしく使い切り 冬場は甘みとみずみずしさアップ - 47NEWS', 'https://e.com/d1')], NOW);
const quake = clusterOf(db, 'https://e.com/q1');
assert.notEqual(clusterOf(db, 'https://e.com/m1'), quake);
assert.notEqual(clusterOf(db, 'https://e.com/d1'), quake);
// 同じ地震の続報は同じクラスタに入る（数値だけの変化は v1 に収容、事実の追加は新版）
ingestArticles(db, [item('球磨村で震度2 - 47NEWS', 'https://e.com/q2')], NOW);
assert.equal(clusterOf(db, 'https://e.com/q2'), quake);
assert.equal(versionOf(db, 'https://e.com/q2'), 1);
ingestArticles(db, [item('球磨村で震度2、住民が避難を開始 けが人なし - 47NEWS', 'https://e.com/q3', '共同', '球磨村で震度2の地震があり、住民が避難を開始した。けが人はいない。')], NOW);
assert.equal(clusterOf(db, 'https://e.com/q3'), quake);
assert.equal(versionOf(db, 'https://e.com/q3'), 2);
});

test('取り込み: ジャンル語（住宅火災）だけが共通する別の火災は混ざらない', () => {
const db = openDb(':memory:');
ingestArticles(db, [item('秋田 湯沢で住宅火災 けが人なし', 'https://e.com/f1')], NOW);
ingestArticles(db, [item('青森で住宅火災、女性1人死亡', 'https://e.com/f2')], NOW);
assert.notEqual(clusterOf(db, 'https://e.com/f1'), clusterOf(db, 'https://e.com/f2'));
});

test('版ダンプの最低条件: どの版とも一致しない記事は独立クラスタになる', () => {
const db = openDb(':memory:');
const t1 = 'アルプス、新型エンジンを発表 燃費の改善が特徴、ドローンへの搭載も視野に';
ingestArticles(db, [item(t1, 'https://e.com/t1', '日経', 'アルプスは新型エンジンを発表した。燃費の改善が特徴で、ドローンへの搭載も視野に入れている。')], NOW);
// 既存記事と似た記事は v1 に収容される（従来どおり）
const x = 'アルプスの新型エンジン、ドローンへの搭載を発表 燃費の向上も';
ingestArticles(db, [item(x, 'https://e.com/x1', '朝日', 'アルプスの新型エンジンでドローンへの搭載を発表した。燃費の向上も特徴。')], NOW);
assert.equal(clusterOf(db, 'https://e.com/x1'), clusterOf(db, 'https://e.com/t1'));
assert.equal(versionOf(db, 'https://e.com/x1'), 1);
// 概要の特徴語共有でクラスタ照合には引っかかるが、版タイトルとはバイグラムの
// 実質一致がない記事は、最新版へ無条件に捨てず独立クラスタとして立てる
const y = 'ドローンへの搭載を前提に、燃費の向上と新型の特徴を伝える映像が各地で届く';
ingestArticles(db, [item(y, 'https://e.com/y1', '共同', 'ドローンへの搭載を前提にしたモデルは、燃費の向上と新型の特徴が伝わる映像とともに紹介された。')], NOW);
assert.notEqual(clusterOf(db, 'https://e.com/y1'), clusterOf(db, 'https://e.com/t1'));
});

let seq = 0;
function buildCluster(db, title, versions) {
const nowIso = '2026-11-19T01:00:00.000Z';
const cid = Number(db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at, importance_score) VALUES (?,?,?,?, 0)')
.run(title, '社会', nowIso, nowIso).lastInsertRowid);
versions.forEach((v, i) => {
const vid = Number(db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?,?,?,?)')
.run(cid, i + 1, v.title, nowIso).lastInsertRowid);
for (const a of v.articles) {
seq++;
db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at) VALUES (?,?,?,?,?,?,?,?)')
.run(cid, vid, '共同', a.title, `https://example.com/dr-${seq}`, a.summary?? (a.title + '。'), nowIso, nowIso);
}
});
return cid;
}
const versionCount = (db, cid) => db.prepare('SELECT COUNT(*) c FROM versions WHERE cluster_id =?').get(cid).c;

test('修復: 47NEWS 接着で混ざった版を分割し、正当な続報の版は残す（クラスタ3835型）', () => {
const db = openDb(':memory:');
const cid = buildCluster(db, '球磨村で震度1 - 47NEWS', [
{ title: '球磨村で震度1 - 47NEWS', articles: [{ title: '球磨村で震度1 - 47NEWS'}]},
{ title: '鹿沼でサル約20匹目撃 - 47NEWS', articles: [{ title: '鹿沼でサル約20匹目撃 - 47NEWS'}]},
{ title: '大根をおいしく使い切り 冬場は甘みとみずみずしさアップ - 47NEWS', articles: [{ title: '大根をおいしく使い切り 冬場は甘みとみずみずしさアップ - 47NEWS'}]},
{ title: '球磨村で震度2 - 47NEWS', articles: [{ title: '球磨村で震度2 - 47NEWS'}]},
]);
assert.equal(splitForeignVersions(db), 2);
assert.equal(versionCount(db, cid), 2);
assert.equal(splitForeignVersions(db), 0); // 冪等
});

test('修復: 人物名の共有だけで接着した世論調査の版を分割する', () => {
const db = openDb(':memory:');
const cid = buildCluster(db, '高市首相、中国でプーチン露大統領と接触へ', [
{ title: '高市首相、中国でプーチン露大統領と接触へ', articles: [{ title: '高市首相、中国でプーチン露大統領と接触へ'}, { title: 'プーチン氏との接触、日ロ関係の焦点に'}]},
{ title: '高市首相、プーチン氏と会談 中国で', articles: [{ title: '高市首相、プーチン氏と会談 中国で'}]},
{ title: '高市首相の国会出席減、賛成４割 反対は２７％―時事世論調査', articles: [{ title: '高市首相の国会出席減、賛成４割 反対は２７％―時事世論調査', summary: '時事通信の世論調査で、高市首相の国会出席を減らすことに賛成が4割となった。'}]},
]);
assert.equal(splitForeignVersions(db), 1);
assert.equal(versionCount(db, cid), 2);
});

test('修復: ジャンル語の共有だけで接着した別の火災の版を分割する', () => {
const db = openDb(':memory:');
const cid = buildCluster(db, '秋田 湯沢で住宅火災 けが人なし', [
{ title: '秋田 湯沢で住宅火災 けが人なし', articles: [{ title: '秋田 湯沢で住宅火災 けが人なし'}, { title: '湯沢の住宅火災、焼け跡から遺体が見つかる'}]},
{ title: '青森で住宅火災、女性1人死亡', articles: [{ title: '青森で住宅火災、女性1人死亡', summary: '青森市の住宅で火災があり、女性1人が死亡した。消防が原因を調べている。'}]},
]);
assert.equal(splitForeignVersions(db), 1);
assert.equal(versionCount(db, cid), 1);
});

test('修復専用アンカー（strict）は取り込み用より厳しい', () => {
// 住宅火災の共有は取り込み用アンカーを通るが、修復用（strict）では通らない
const cand = '青森で住宅火災、女性1人死亡';
const cluster = '秋田 湯沢で住宅火災 けが人なし';
const arts = ['秋田 湯沢で住宅火災 けが人なし', '湯沢の住宅火災、焼け跡から遺体が見つかる'];
assert.equal(hasStoryAnchor(cand, cluster, [cluster], arts), true);
assert.equal(hasStoryAnchor(cand, cluster, [cluster], arts, { strict: true}), false);
// 定型句だけの一致はどちらの物差しでも通らない
const foreign = '鹿沼でサル約20匹目撃 - 47NEWS';
const quake = '球磨村で震度1 - 47NEWS';
assert.equal(hasStoryAnchor(foreign, quake, [quake], [quake]), false);
assert.equal(hasStoryAnchor(foreign, quake, [quake], [quake], { strict: true}), false);
});
