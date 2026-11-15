// 記者バイライン（2026-11-15 ユーザー希望）の検証。
// - 署名抽出: 本文テキストの典型パターン（（○○記者）・文・○○・文＝○○）と
// 取得HTMLの JSON-LD / meta author から抽出する。
// - 誤抽出防止: 署名なし記事は空、配信記事のクレジット（）や
// デスク表記（政治部記者など）・媒体名は人名として拾わない。
// - 取得経路: fetchClusterBodies で本文と一緒に署名が保存される（fetch はモック、ネットワーク不要）。
// - 後がけ: 保存済み本文から backfillAuthors で抽出できる。
import { test} from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync} from 'node:sqlite';
import { mkdtempSync, rmSync} from 'node:fs';
import { tmpdir} from 'node:os';
import { join} from 'node:path';
import { openDb} from '../src/db.mjs';
import {
cleanAuthorName,
extractAuthorFromText,
extractAuthorFromHtml,
fetchClusterBodies,
} from '../src/body.mjs';
import { backfillAuthors} from '../src/lifecycle.mjs';

/* ---------- 本文テキストからの抽出 ---------- */

test('抽出（本文）: 末尾の（○○記者）を拾う', () => {
const text = '政府は十五日、新しい経済対策を閣議決定した。物価高への対応として所得減税と給付金を組み合わせた内容で、規模は十兆円を超える見通しだ。（山田太郎記者）';
assert.equal(extractAuthorFromText(text), '山田太郎');
});

test('抽出（本文）: 空白区切りの姓名、文・○○、文＝○○を拾う', () => {
assert.equal(extractAuthorFromText('現地で取材に応じた。（佐藤 花子記者）'), '佐藤 花子');
assert.equal(extractAuthorFromText('この特集は現地取材に基づく。文・鈴木一郎'), '鈴木一郎');
assert.equal(extractAuthorFromText('現地の様子を伝える。（文＝高橋健）'), '高橋健');
assert.equal(extractAuthorFromText('現地の様子を伝える。文・渡辺真理、写真・小林誠'), '渡辺真理');
});

test('抽出（本文）: 末尾行が「○○記者」だけの行も拾う', () => {
assert.equal(extractAuthorFromText('現地では混乱が続いている。けが人の情報はない。\n中村翔太記者'), '中村翔太');
});

test('抽出（本文）: 署名のない記事は空になる', () => {
assert.equal(extractAuthorFromText('事件は未明に発生した。警察が当時の状況を調べている。'), '');
assert.equal(extractAuthorFromText(''), '');
});

test('抽出（本文）: 配信記事のクレジットやデスク表記は人名として拾わない', () => {
// 通信社の配信クレジット（地名＋社名）には「記者」が含まれないため対象にならない
assert.equal(extractAuthorFromText('米政府は十五日、声明を発表した。'), '');
assert.equal(extractAuthorFromText('仏政府は十五日、声明を発表した。'), '');
assert.equal(extractAuthorFromText('首脳会談は二日間の日程で行われた。（ワシントン＝共同）'), '');
// デスク表記（部署名＋記者）は人名ではない
assert.equal(extractAuthorFromText('国会で審議が続いた。（政治部記者）'), '');
assert.equal(extractAuthorFromText('事件の続報が入った。（社会部記者）'), '');
assert.equal(extractAuthorFromText('続報が入った。（編集部記者）'), '');
// 「本文＝」のような通常文の表記を誤って拾わない
assert.equal(extractAuthorFromText('詳しくは本文＝次ページに続く。'), '');
});

/* ---------- HTMLのメタ情報からの抽出 ---------- */

test('抽出（HTML）: JSON-LD の Person と文字列 author を拾う', () => {
const person = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","author":{"@type":"Person","name":"山田太郎"}}</script>';
assert.equal(extractAuthorFromHtml(person), '山田太郎');
const str = '<script type="application/ld+json">{"@type":"NewsArticle","author":"鈴木一郎"}</script>';
assert.equal(extractAuthorFromHtml(str), '鈴木一郎');
const arr = '<script type="application/ld+json">{"@type":"NewsArticle","author":[{"@type":"Organization","name":"Example新聞社"},{"@type":"Person","name":"佐藤花子"}]}</script>';
assert.equal(extractAuthorFromHtml(arr), '佐藤花子');
});

test('抽出（HTML）: 組織名・媒体名は人名として拾わない', () => {
const org = '<script type="application/ld+json">{"@type":"NewsArticle","author":{"@type":"Organization","name":"朝日新聞社"}}</script>';
assert.equal(extractAuthorFromHtml(org), '');
assert.equal(extractAuthorFromHtml('<meta name="author" content="鈴木一郎">'), '鈴木一郎');
assert.equal(extractAuthorFromHtml('<meta name="author" content="朝日新聞デジタル">'), '');
assert.equal(extractAuthorFromHtml('<meta property="article:author" content="高橋健">'), '高橋健');
assert.equal(extractAuthorFromHtml('<html><head><title>署名なし</title></head></html>'), '');
});

test('人名検証: 役割語・組織語・長すぎる候補を弾き、末尾の「記者」を落とす', () => {
assert.equal(cleanAuthorName('山田太郎記者'), '山田太郎');
assert.equal(cleanAuthorName('（山田太郎）'), '山田太郎');
assert.equal(cleanAuthorName('政治部'), '');
assert.equal(cleanAuthorName('共同'), '');
assert.equal(cleanAuthorName('朝日新聞デジタル'), '');
assert.equal(cleanAuthorName(''), '');
assert.equal(cleanAuthorName('あ'), '');
});

/* ---------- 取得経路（fetchClusterBodies、fetch はモック） ---------- */

function fakeResponse(html) {
return {
status: 200,
ok: true,
headers: {
get: (name) => (String(name).toLowerCase() === 'content-type'? 'text/html; charset=utf-8': null),
},
text: async () => html,
};
}

const BODY_PAGE = `<html><head><title>署名あり記事</title></head><body>
<p>政府は十五日、新しい経済対策を閣議決定した。物価高への対応として、所得減税と給付金を組み合わせた内容で、規模は十兆円を超える見通しだ。</p>
<p>与党内では財源をめぐる議論が続いており、国債発行に頼らない形を目指す声がある。（山田太郎記者）</p>
</body></html>`;

const META_PAGE = `<html><head><title>メタ署名記事</title>
<script type="application/ld+json">{"@type":"NewsArticle","author":{"@type":"Person","name":"佐藤花子"}}</script>
</head><body>
<p>市議会は十五日、新年度の予算案を賛成多数で可決した。教育費の拡充が柱で、来年度から順次実施される見通しだという。</p>
<p>野党側は財源の裏付けが不十分だと批判しており、今後の審議で改めて説明を求める方針を示している。</p>
</body></html>`;

const NO_BYLINE_PAGE = `<html><head><title>署名なし記事</title></head><body>
<p>政府は十五日、新しい経済対策を閣議決定した。物価高への対応として給付金を組み合わせた内容で、規模は十兆円を超える見通しだ。</p>
<p>与党内では財源をめぐる議論が続いており、野党は規模ありきの姿勢を批判しているという。</p>
</body></html>`;

test('取得経路: 本文と一緒に署名が保存される（本文表記・メタ情報・署名なし）', async () => {
const db = openDb(':memory:');
const now = new Date().toISOString();
const c = db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at) VALUES (?,?,?,?)')
.run('署名検証クラスタ', '政治', now, now);
const clusterId = Number(c.lastInsertRowid);
const v = db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1,?,?)')
.run(clusterId, '署名検証クラスタ', now);
const versionId = Number(v.lastInsertRowid);
const ins = db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at) VALUES (?,?,?,?,?,?,?,?)');
// 公開IPのリテラルURLを使う（DNS解決なしで SSRF チェックを通すため。fetch 自体はモック）
ins.run(clusterId, versionId, '朝日', '署名あり記事', 'https://93.184.216.34/news/byline1', '', now, now);
ins.run(clusterId, versionId, '読売', 'メタ署名記事', 'https://93.184.216.34/news/byline2', '', now, now);
ins.run(clusterId, versionId, '共同', '署名なし記事', 'https://93.184.216.34/news/byline3', '', now, now);
const pages = new Map([
['https://93.184.216.34/news/byline1', BODY_PAGE],
['https://93.184.216.34/news/byline2', META_PAGE],
['https://93.184.216.34/news/byline3', NO_BYLINE_PAGE],
]);
const fetchImpl = async (url) => fakeResponse(pages.get(url)?? '');
const result = await fetchClusterBodies(db, clusterId, { fetchImpl});
assert.equal(result.attempted, 3);
assert.equal(result.got, 3);
assert.equal(result.authors, 2);
const rows = db.prepare('SELECT source, author FROM articles ORDER BY id').all();
assert.deepEqual(
rows.map((r) => [r.source, r.author]),
[['朝日', '山田太郎'], ['読売', '佐藤花子'], ['共同', '']],
);
});

/* ---------- 後がけ（backfillAuthors） ---------- */

test('後がけ: 保存済み本文から署名を抽出し、2回目は変更なし（冪等）', () => {
const db = openDb(':memory:');
const now = new Date().toISOString();
const c = db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at) VALUES (?,?,?,?)')
.run('後がけ検証', '社会', now, now);
const clusterId = Number(c.lastInsertRowid);
const v = db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1,?,?)')
.run(clusterId, '後がけ検証', now);
const versionId = Number(v.lastInsertRowid);
const ins = db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at, body_text) VALUES (?,?,?,?,?,?,?,?,?)');
ins.run(clusterId, versionId, '毎日', '署名あり', 'https://example.com/bf1', '', now, now,
'市議会は予算案を可決した。教育費の拡充が柱で、来年度から実施される。（鈴木一郎記者）');
ins.run(clusterId, versionId, '共同', '署名なし', 'https://example.com/bf2', '', now, now,
'市議会は予算案を可決した。教育費の拡充が柱だという。');
assert.equal(backfillAuthors(db), 1);
const rows = db.prepare('SELECT source, author FROM articles ORDER BY id').all();
assert.deepEqual(rows.map((r) => [r.source, r.author]), [['毎日', '鈴木一郎'], ['共同', '']]);
assert.equal(backfillAuthors(db), 0);
});

/* ---------- マイグレーション ---------- */

test('マイグレーション: author カラムのない既存DBにもカラムが追加される', () => {
const dir = mkdtempSync(join(tmpdir(), 'ichigyo-byline-mig-'));
const path = join(dir, 'old.db');
try {
const old = new DatabaseSync(path);
old.exec(`CREATE TABLE articles (
id INTEGER PRIMARY KEY AUTOINCREMENT,
cluster_id INTEGER NOT NULL, version_id INTEGER NOT NULL,
source TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, url TEXT NOT NULL UNIQUE,
summary TEXT NOT NULL DEFAULT '', published_at TEXT, fetched_at TEXT NOT NULL,
body_text TEXT NOT NULL DEFAULT '', body_fetched_at TEXT
)`);
old.close();
const db = openDb(path);
const cols = db.prepare('PRAGMA table_info(articles)').all().map((c2) => c2.name);
assert.ok(cols.includes('author'), 'author カラムが追加される');
db.close();
} finally {
rmSync(dir, { recursive: true, force: true});
}
});
