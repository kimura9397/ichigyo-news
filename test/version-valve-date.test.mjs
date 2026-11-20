// 要約バルブの固有名詞条件（監査の方向5）と日替わり定型の日付例外（方向6）の
// 回帰テスト（Issue #59）。
// 方向5: 修復の記事単位判定では、要約の語彙共有（4以上）だけでは足りず、
// タイトル同士で固有名詞っぽい語（カタカナ・英字）を共有することを必須にする。
// 取り込み側の既定は従来の 'or' のまま: properTerms は漢字の固有名詞を拾えない
// ため、必須化すると漢字見出しだけの正当な続報がバルブを通らなくなる
// （下の取り込みフィクスチャで対照を示す）。
// 方向6: 「N月N日」が両方にあり食い違う見出し同士は同一視しない。日付除去
// そのものは続報の言い換え対策として残し、「両方に日付があり食い違う」場合
// だけを否定証拠にする。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { summaryValvePasses, titleDates, hasDateConflict, hasStoryAnchor } from '../src/matching.mjs';
import { splitForeignVersions } from '../src/lifecycle.mjs';
import { ingestArticles } from '../src/collector.mjs';

/* ---------- ユニット: バルブ条件の形 ---------- */

test('バルブ条件: or は従来どおり（固有1 か 強語2）', () => {
assert.equal(summaryValvePasses(0, 2, 'or'), true);
assert.equal(summaryValvePasses(0, 1, 'or'), false);
assert.equal(summaryValvePasses(1, 0, 'or'), true);
assert.equal(summaryValvePasses(0, 2), true, '既定モードは or');
});

test('バルブ条件: proper は固有名詞っぽい語の共有を必須にする', () => {
assert.equal(summaryValvePasses(0, 2, 'proper'), false);
assert.equal(summaryValvePasses(0, 5, 'proper'), false);
assert.equal(summaryValvePasses(1, 0, 'proper'), true);
});

test('バルブ条件: and は固有1 かつ 強語2 を必須にする', () => {
assert.equal(summaryValvePasses(1, 1, 'and'), false);
assert.equal(summaryValvePasses(0, 2, 'and'), false);
assert.equal(summaryValvePasses(1, 2, 'and'), true);
});

/* ---------- ユニット: 日付の抽出と食い違い ---------- */

test('日付抽出: 「N月N日」を月/日の集合にする（全角数字も拾う）', () => {
assert.deepEqual([...titleDates('高市首相動静 2026年11月17日')], ['11/17']);
assert.deepEqual([...titleDates('１１月１７日の市長往来')], ['11/17']);
assert.deepEqual([...titleDates('11月13日～15日')], ['11/13'], '範囲表記は開始日だけを拾う（既知の限界）');
assert.equal(titleDates('18日の高市首相の動静').size, 0, '月のない表記は拾えない（既知の限界）');
assert.equal(titleDates('大阪・枚方3歳女児虐待死 3月にも女児の顔にあざ').size, 0);
});

test('日付例外: 両方に日付があり食い違う場合だけ true', () => {
assert.equal(hasDateConflict('高市首相動静 2026年11月18日', ['高市首相動静 2026年11月17日']), true);
assert.equal(hasDateConflict('高市首相動静 2026年11月17日', ['高市首相動静 2026年11月17日']), false, '同じ日付は衝突しない');
assert.equal(hasDateConflict('首相動静', ['高市首相動静 2026年11月17日']), false, '候補に日付がなければ対象外');
assert.equal(hasDateConflict('高市首相動静 2026年11月18日', ['首相動静']), false, 'ベースに日付がなければ対象外');
assert.equal(hasDateConflict('11月13日の動静', ['高市首相動静 11月13日～15日']), false, '範囲の開始日と一致すれば衝突しない');
});

test('日付例外: アンカーは別日分の動静を通さない（同日は通す）', () => {
const base = ['高市首相動静 2026年11月16日'];
assert.equal(hasStoryAnchor('高市首相動静 2026年11月18日', base[0], base, base), false);
assert.equal(hasStoryAnchor('高市首相動静 2026年11月16日', base[0], base, base), true);
});

/* ---------- 修復: 要約バルブの固有名詞条件（方向5） ---------- */

let seq = 0;
function buildValveCluster(db) {
const nowIso = '2026-11-19T01:00:00.000Z';
const cid = Number(db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at, importance_score) VALUES (?,?,?,?, 0)')
.run('倉庫火災 消防出動', '社会', nowIso, nowIso).lastInsertRowid);
const mk = (vno, title, arts) => {
const vid = Number(db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?,?,?,?)')
.run(cid, vno, title, nowIso).lastInsertRowid);
for (const a of arts) {
seq++;
db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at) VALUES (?,?,?,?,?,?,?,?)')
.run(cid, vid, '共同', a.title, `https://example.com/vd-${seq}`, a.summary, nowIso, nowIso);
}
};
mk(1, '倉庫火災 消防出動', [
{ title: '倉庫火災 消防出動', summary: '市内の倉庫で火災が発生し、消防が出動した。倉庫には資材が保管されており、消防が消火活動を行った。' },
{ title: '倉庫火災 男性が搬送', summary: '倉庫の火災で男性が煙を吸って病院に搬送された。消防が消火活動を続け、倉庫の資材への延焼は防がれた。' },
]);
// v2: 別ニュース（2記事）。要約の語（倉庫・資材・消防・出動・保管）はベースと
// 5語共有するが、タイトル同士では固有名詞っぽい語を共有せず、タイトルの
// アンカーも届かない。単一記事版はバルブの対象外（タイトルだけで決める既存
// 仕様）のため、バルブの効きを見るには複数記事の版にする
mk(2, '港の倉庫で資材が燃える', [
{ title: '港の倉庫で資材が燃える', summary: '港の倉庫で資材が燃え、消防が出動した。倉庫の資材は保管されていたもので、消防が消火にあたった。' },
{ title: '港で資材が燃える 倉庫に延焼', summary: '港の倉庫で資材が燃え、消防が出動した。保管されていた資材が焼けた。' },
]);
return cid;
}
const versionsOf = (db, cid) => db.prepare('SELECT COUNT(*) c FROM versions WHERE cluster_id =?').get(cid).c;

test('修復: 要約共有だけで固有名詞を共有しない版は切り出される（方向5の既定）', () => {
const db = openDb(':memory:');
const cid = buildValveCluster(db);
assert.equal(splitForeignVersions(db), 1);
assert.equal(versionsOf(db, cid), 1);
});

test('修復: バルブを or に戻すと同じ版が残る（対照）', () => {
const db = openDb(':memory:');
const cid = buildValveCluster(db);
assert.equal(splitForeignVersions(db, { summaryValve: 'or' }), 0);
assert.equal(versionsOf(db, cid), 2);
});

/* ---------- 取り込み: バルブ必須化が漢字見出しの続報を落とす対照（方向5） ---------- */

const NOW = new Date('2026-11-19T12:00:00.000Z');
function seedValveCluster(db) {
const nowIso = '2026-11-19T01:00:00.000Z';
const cid = Number(db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at, importance_score) VALUES (?,?,?,?, 0)')
.run('倉庫火災 消防', '社会', nowIso, nowIso).lastInsertRowid);
const vid = Number(db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?,?,?,?)')
.run(cid, 1, '倉庫火災 消防', nowIso).lastInsertRowid);
const arts = [
{ title: '倉庫火災 消防', summary: '市内の倉庫で火災が発生し、消防が出動した。倉庫には資材が保管されていた。' },
{ title: '消火活動が難航', summary: '港の油槽近くで消火活動が難航した。' },
];
arts.forEach((a, i) => {
db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at) VALUES (?,?,?,?,?,?,?,?)')
.run(cid, vid, '共同', a.title, `https://example.com/vs-${i}`, a.summary, nowIso, nowIso);
});
return cid;
}
// 漢字だけの見出しの正当な続報: タイトル経路は届かず、バルブ＋アンカー（P2）が唯一の経路
const FOLLOWUP = { title: '消火活動 倉庫火災 2人死亡か', url: 'https://example.com/vs-cand', source: '朝日',
summary: '倉庫で発生した火災の消火活動が続いた。消防が倉庫の資材への延焼を防ぎ、消防署員が現場で確認した。',
publishedAt: '2026-11-19T03:00:00.000Z' };

test('取り込み: 既定（or）では漢字見出しの続報がバルブを通って版になる', () => {
const db = openDb(':memory:');
const cid = seedValveCluster(db);
ingestArticles(db, [FOLLOWUP], NOW);
const row = db.prepare('SELECT cluster_id FROM articles WHERE url=?').get(FOLLOWUP.url);
assert.equal(row.cluster_id, cid);
});

test('取り込み: バルブ必須化（proper / and）では同じ続報が落ちる（必須化しない理由）', () => {
for (const mode of ['proper', 'and']) {
const db = openDb(':memory:');
const cid = seedValveCluster(db);
ingestArticles(db, [FOLLOWUP], NOW, { summaryValve: mode });
const row = db.prepare('SELECT cluster_id FROM articles WHERE url=?').get(FOLLOWUP.url);
assert.notEqual(row.cluster_id, cid, `mode=${mode}`);
}
});

/* ---------- 取り込み: 日替わり定型の日付例外（方向6） ---------- */

function seedDatedCluster(db) {
const nowIso = '2026-11-16T01:00:00.000Z';
const title = '高市首相動静 2026年11月16日';
const cid = Number(db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at, importance_score) VALUES (?,?,?,?, 0)')
.run(title, '政治', nowIso, nowIso).lastInsertRowid);
const vid = Number(db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?,?,?,?)')
.run(cid, 1, title, nowIso).lastInsertRowid);
db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at) VALUES (?,?,?,?,?,?,?,?)')
.run(cid, vid, 'NHK', title, 'https://example.com/dt-seed', '', nowIso, nowIso);
return cid;
}

test('取り込み: 別日分の動静は同じクラスタに入らない（同日分は入る）', () => {
const db = openDb(':memory:');
const cid = seedDatedCluster(db);
const now = new Date('2026-11-18T12:00:00.000Z');
ingestArticles(db, [{ title: '高市首相動静 2026年11月18日', url: 'https://example.com/dt-18', source: 'NHK', summary: '', publishedAt: '2026-11-18T01:00:00.000Z' }], now);
assert.notEqual(db.prepare('SELECT cluster_id FROM articles WHERE url=?').get('https://example.com/dt-18').cluster_id, cid);
ingestArticles(db, [{ title: '高市首相動静 2026年11月16日', url: 'https://example.com/dt-16', source: '共同', summary: '', publishedAt: '2026-11-16T02:00:00.000Z' }], now);
assert.equal(db.prepare('SELECT cluster_id FROM articles WHERE url=?').get('https://example.com/dt-16').cluster_id, cid);
});

/* ---------- 修復: 日替わり系列の版分離（方向6） ---------- */

test('修復: 別日分の版は要約バルブでも残らない', () => {
const db = openDb(':memory:');
const nowIso = '2026-11-16T01:00:00.000Z';
const cid = Number(db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at, importance_score) VALUES (?,?,?,?, 0)')
.run('高市首相動静 2026年11月16日', '政治', nowIso, nowIso).lastInsertRowid);
const mk = (vno, title) => {
const vid = Number(db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?,?,?,?)')
.run(cid, vno, title, nowIso).lastInsertRowid);
seq++;
db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at) VALUES (?,?,?,?,?,?,?,?)')
.run(cid, vid, 'NHK', title, `https://example.com/dr-${seq}`, '首相は官邸で関係者と面会した。', nowIso, nowIso);
};
mk(1, '高市首相動静 2026年11月16日');
mk(2, '高市首相動静 2026年11月17日');
assert.equal(splitForeignVersions(db), 1);
assert.equal(versionsOf(db, cid), 1);
});
