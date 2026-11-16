// バージョン誤判定対策（2026-11-16）の回帰テスト。
// ユーザー報告: 別のニュースが既存ストーリーの別バージョン（続報）として登録される
// ケースが散見される。実データ（VM DB）では後続バージョン348件のうち約8%が明確に
// 別ニュースだった。原因と対策は REQUIREMENTS.md の「バージョン誤判定対策」参照。
// 素材の見出しは実データから採ったもの（クラスタ112 海老名/埼玉ひき逃げ、
// クラスタ69 北海道新聞記者拘束/金正恩、クラスタ2 枚方女児虐待死、
// クラスタ1678 ヒ素古書、クラスタ899 防衛費）。
import { test} from 'node:test';
import assert from 'node:assert/strict';
import { openDb} from '../src/db.mjs';
import { ingestArticles, hasStoryAnchor, isNewFactFollowUp} from '../src/collector.mjs';
import { splitForeignVersions} from '../src/lifecycle.mjs';

const clusterOf = (db, url) => db.prepare('SELECT cluster_id FROM articles WHERE url =?').get(url)?.cluster_id;
const versionOf = (db, url) => db.prepare('SELECT v.version_no FROM articles a JOIN versions v ON v.id = a.version_id WHERE a.url =?').get(url)?.version_no;

/* ---------- hasStoryAnchor: 実例ペア ---------- */

test('アンカー: 別のひき逃げ事件（埼玉）は海老名のクラスタにアンカーを持たない', () => {
const clusterTitle = '神奈川 海老名 2人死亡 ひき逃げ疑いで運転手逮捕 容疑否認';
const vTitles = [clusterTitle,
'神奈川・海老名で２人死亡のひき逃げ事件、容疑で逮捕の男「事故については全くわからない」と否認',
'海老名2人死亡 ひき逃げ疑い、トラック運転の49歳会社員逮捕 [写真特集1/4]'];
const aTitles = [...vTitles,
'海老名市ひき逃げ事件 トラック運転の49歳男逮捕 容疑否認「全く分からない」',
'歩行中の高齢女性2人が死亡 トラックがひき逃げか 海老名 [写真特集1/4]',
'神奈川の2人死亡ひき逃げ、男を逮捕'];
assert.equal(hasStoryAnchor('埼玉で死亡ひき逃げ容疑 32歳の男を逮捕「人だった認識なかった」 [埼玉県]', clusterTitle, vTitles, aTitles), false);
});

test('アンカー: 金正恩氏の最側近のロシア訪問は北海道新聞記者拘束のアンカーを持たない', () => {
const clusterTitle = 'ロシアによる北海道新聞記者の拘束続く 日本新聞協会が声明';
const vTitles = [clusterTitle, '北海道新聞 ロシアで拘束の記者の実名 初めて報道'];
const aTitles = [clusterTitle,
'ロシアによる北海道新聞記者拘束1か月 即時解放求め続ける',
'北海道新聞記者拘束あす1か月 木原長官“即時解放強く求める”',
'北海道新聞 ロシアで拘束の記者の実名 初めて報道'];
assert.equal(hasStoryAnchor('【速報】金正恩氏の最側近がロシア訪問へ', clusterTitle, vTitles, aTitles), false,
'共有するのは「ロシア」だけで、話題のアンカーにはならない');
});

test('アンカー: 見出しが大きく乖離した正当な続報（枚方）は通る', () => {
const clusterTitle = '大阪 枚方女児死亡 体に古いもの含め数10か所のあざ';
// v3 時点のベース（クラスタタイトル＋v1, v2 のタイトルと記事）
const vTitles = [clusterTitle, '大阪 枚方 3歳女児死亡で両親逮捕 虐待か'];
const aTitles = [...vTitles];
assert.equal(hasStoryAnchor('大阪・枚方3歳女児虐待死 3月にも女児の顔にあざ 8月の死亡時には数十カ所確認', clusterTitle, vTitles, aTitles), true);
// v4 時点のベース（v3 まで受理済み）
const vTitles2 = [...vTitles, '大阪・枚方3歳女児虐待死 3月にも女児の顔にあざ 8月の死亡時には数十カ所確認'];
const aTitles2 = [...aTitles, '大阪・枚方3歳女児虐待死 3月にも女児の顔にあざ 8月の死亡時には数十カ所確認',
'3歳娘虐待か、殺人容疑で父親逮捕 あざ数十カ所、放置疑いで母親も [大阪府]'];
assert.equal(hasStoryAnchor('3歳長女を殴り殺害か、容疑で父親逮捕 母親も遺棄致死容疑', clusterTitle, vTitles2, aTitles2), true,
'地名も事件名も見出しに出ない続報でも、受理済みの版・記事が裏付ける');
});

test('アンカー: 初報が記事1件だけの若いクラスタでも正当な続報が通る（ヒ素古書）', () => {
const clusterTitle = 'ヒ素含む古書 22年以降100点超';
assert.equal(hasStoryAnchor('ヒ素を含む古書、全国で１００点以上確認…保管方法見直しや現物触れずに閲覧できるデジタル化の動き',
clusterTitle, [clusterTitle], [clusterTitle]), true,
'裏付けプールが小さい場合は1件の裏付けで足りる（でないと若いクラスタの続報が永遠に作れない）');
});

/* ---------- isNewFactFollowUp: アンカーが版作成の前提になる ---------- */

test('版判定: 新規性が高くてもアンカーがなければ版を作らない', () => {
const existing = ['ロシアによる北海道新聞記者の拘束続く 日本新聞協会が声明'];
const foreign = '【速報】金正恩氏の最側近がロシア訪問へ';
const anchor = { clusterTitle: existing[0], articleTitles: existing};
assert.equal(isNewFactFollowUp(existing, foreign, anchor), false);
// アンカー文脈を渡さない呼び出し（従来経路）は新規性だけで判定する
assert.equal(isNewFactFollowUp(existing, foreign), true);
});

test('版判定: アンカーのある正当な続報は版を作る（防衛費の実例）', () => {
const existing = ['防衛費5年で60兆円規模 政府調整'];
const follow = '5年間の防衛費、60兆円前後で調整 防衛省は70兆円台を要求';
const anchor = { clusterTitle: existing[0], articleTitles: existing};
assert.equal(isNewFactFollowUp(existing, follow, anchor), true);
});

/* ---------- 取り込み: 版の作成と振り分け ---------- */

const item = (title, url, source = 'NHK') => ({ title, url, source, summary: title + '。', publishedAt: '2026-11-16T01:00:00.000Z'});

test('取り込み: 正当な続報は v2 になる（防衛費の実例）', () => {
const db = openDb(':memory:');
const now = new Date('2026-11-16T05:00:00.000Z');
ingestArticles(db, [item('防衛費5年で60兆円規模 政府調整', 'https://e.com/b1')], now);
ingestArticles(db, [item('5年間の防衛費、60兆円前後で調整 防衛省は70兆円台を要求', 'https://e.com/b2', '朝日')], now);
assert.equal(clusterOf(db, 'https://e.com/b2'), clusterOf(db, 'https://e.com/b1'));
assert.equal(versionOf(db, 'https://e.com/b2'), 2);
});

test('取り込み: 版を作らない記事は最新版ではなく最も合う既存版に入る', () => {
const db = openDb(':memory:');
const now = new Date('2026-11-16T05:00:00.000Z');
ingestArticles(db, [item('市内で火災が発生 けが人なし', 'https://e.com/f1')], now);
ingestArticles(db, [item('市内で火災、けが人なし', 'https://e.com/f2', '読売')], now);
ingestArticles(db, [item('市内で火災が発生 死者2人が確認される', 'https://e.com/f3', '朝日')], now);
assert.equal(versionOf(db, 'https://e.com/f3'), 2, '死者確認は新事実として v2');
// v1 の内容に近い記事が後から来たら、最新版（v2）ではなく v1 に入る
ingestArticles(db, [item('市内の火災 けが人なしと消防', 'https://e.com/f4', '毎日')], now);
assert.equal(versionOf(db, 'https://e.com/f4'), 1, '最新版への無条件の吸着をしない');
});

/* ---------- splitForeignVersions: 既存データの修復 ---------- */

let seq = 0;
function buildRichCluster(db, title, versions) {
const nowIso = '2026-11-15T01:00:00.000Z';
const cid = Number(db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at, importance_score) VALUES (?,?,?,?, 0)')
.run(title, '社会', nowIso, nowIso).lastInsertRowid);
versions.forEach((v, i) => {
const vid = Number(db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?,?,?,?)')
.run(cid, i + 1, v.title, nowIso).lastInsertRowid);
for (const a of v.articles) {
seq++;
db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at) VALUES (?,?,?,?,?,?,?,?)')
.run(cid, vid, 'NHK', a.title, `https://example.com/vm-${seq}`, a.summary?? (a.title + '。'), nowIso, nowIso);
}
});
return cid;
}
const versionsOf = (db, cid) => db.prepare('SELECT COUNT(*) c FROM versions WHERE cluster_id =?').get(cid).c;

test('修復: 別のひき逃げ事件の版が独立クラスタに切り出される', () => {
const db = openDb(':memory:');
const cid = buildRichCluster(db, '神奈川 海老名 2人死亡 ひき逃げ疑いで運転手逮捕 容疑否認', [
{ title: '神奈川 海老名 2人死亡 ひき逃げ疑いで運転手逮捕 容疑否認', articles: [{ title: '神奈川 海老名 2人死亡 ひき逃げ疑いで運転手逮捕 容疑否認'}, { title: '海老名市ひき逃げ事件 トラック運転の49歳男逮捕 容疑否認「全く分からない」'}]},
{ title: '埼玉で死亡ひき逃げ容疑 32歳の男を逮捕「人だった認識なかった」 [埼玉県]', articles: [{ title: '埼玉で死亡ひき逃げ容疑 32歳の男を逮捕「人だった認識なかった」 [埼玉県]', summary: '埼玉県警は死亡ひき逃げ事件で32歳の男を逮捕した。男は人だった認識はなかったと供述している。県警が事故の原因を調べている。'}]},
]);
assert.equal(splitForeignVersions(db), 1);
assert.equal(versionsOf(db, cid), 1, '元のクラスタには v1 だけが残る');
const nc = db.prepare('SELECT id FROM clusters WHERE title LIKE?').get('埼玉で死亡ひき逃げ%');
assert.ok(nc && nc.id!== cid, '埼玉の版は独立したクラスタになる');
assert.equal(splitForeignVersions(db), 0, '2回目は冪等');
});

test('修復: 要約が汎用語を多く共有するだけの単一記事版も切り出される（金正恩の実例）', () => {
const db = openDb(':memory:');
const cid = buildRichCluster(db, 'ロシアによる北海道新聞記者の拘束続く 日本新聞協会が声明', [
{ title: 'ロシアによる北海道新聞記者の拘束続く 日本新聞協会が声明', articles: [
{ title: 'ロシアによる北海道新聞記者の拘束続く 日本新聞協会が声明', summary: 'ロシア当局による北海道新聞記者の拘束が続いている。日本新聞協会は声明を出し、記者の即時解放を求めた。'},
{ title: '北海道新聞 ロシアで拘束の記者の実名 初めて報道', summary: '北海道新聞はロシアで拘束された記者の実名を報じた。日本新聞協会は解放を求めている。'}]},
// 要約はロシア・訪問・発表など汎用語をベースと共有するが、話題は別。
// 単一記事版はタイトルアンカーだけで決めるため、要約の共有では残らない
{ title: '【速報】金正恩氏の最側近がロシア訪問へ', articles: [
{ title: '【速報】金正恩氏の最側近がロシア訪問へ', summary: 'ロシア大統領府は金正恩氏の最側近がロシアを訪問すると発表した。日本政府は情報収集を進め、関係国と連携して対応するとしている。'}]},
]);
assert.equal(splitForeignVersions(db), 1);
assert.equal(versionsOf(db, cid), 1);
});

test('修復: 見出しが乖離した正当な続報の連鎖は割れない（枚方・ヒ素）', () => {
const db = openDb(':memory:');
const hirakata = buildRichCluster(db, '大阪 枚方女児死亡 体に古いもの含め数10か所のあざ', [
{ title: '大阪 枚方女児死亡 体に古いもの含め数10か所のあざ', articles: [{ title: '大阪 枚方女児死亡 体に古いもの含め数10か所のあざ'}]},
{ title: '大阪 枚方 3歳女児死亡で両親逮捕 虐待か', articles: [{ title: '大阪 枚方 3歳女児死亡で両親逮捕 虐待か'}]},
{ title: '大阪・枚方3歳女児虐待死 3月にも女児の顔にあざ 8月の死亡時には数十カ所確認', articles: [{ title: '大阪・枚方3歳女児虐待死 3月にも女児の顔にあざ 8月の死亡時には数十カ所確認'}, { title: '3歳娘虐待か、殺人容疑で父親逮捕 あざ数十カ所、放置疑いで母親も [大阪府]'}]},
{ title: '3歳長女を殴り殺害か、容疑で父親逮捕 母親も遺棄致死容疑', articles: [{ title: '3歳長女を殴り殺害か、容疑で父親逮捕 母親も遺棄致死容疑'}]},
]);
const hiso = buildRichCluster(db, 'ヒ素含む古書 22年以降100点超', [
{ title: 'ヒ素含む古書 22年以降100点超', articles: [{ title: 'ヒ素含む古書 22年以降100点超'}]},
{ title: 'ヒ素を含む古書、全国で１００点以上確認…保管方法見直しや現物触れずに閲覧できるデジタル化の動き', articles: [{ title: 'ヒ素を含む古書、全国で１００点以上確認…保管方法見直しや現物触れずに閲覧できるデジタル化の動き'}]},
]);
assert.equal(splitForeignVersions(db), 0, '正当な続報だけのクラスタは分離されない');
assert.equal(versionsOf(db, hirakata), 4);
assert.equal(versionsOf(db, hiso), 2);
});

test('修復: 版タイトルは別ニュースでも記事の大半が正当な混在型は残す', () => {
const db = openDb(':memory:');
const cid = buildRichCluster(db, 'マイクロソフトの接続障害 全面復旧と発表', [
{ title: 'マイクロソフトの接続障害 全面復旧と発表', articles: [{ title: 'マイクロソフトの接続障害 全面復旧と発表'}, { title: 'マイクロソフト365障害、「サービス全体で復旧進む」'}]},
// 版タイトルは配送会社の別ニュースだが、記事3件中2件は障害の正当な続報という混在
{ title: '【速報】佐川急便、荷物預かりの予約停止', articles: [
{ title: 'マイクロソフトの接続障害、全面復旧と発表 一部で不具合続く'},
{ title: 'マイクロソフト365障害、「サービス全体で復旧進む」 一部不具合も'},
{ title: '【速報】佐川急便、荷物預かりの予約停止'}]},
]);
assert.equal(splitForeignVersions(db), 0, '混在型は版単位では切り分けられないため残す');
assert.equal(versionsOf(db, cid), 2);
});
