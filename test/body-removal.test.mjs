// 本文機能廃止（2026-11-16）に伴う移行処理の検証。
// 旧スキーマのDB（本文・画像・記者名などのカラムに中身が残っている状態）で
// purgeBodyData を実行すると、旧カラムの中身が全て消え、search_text が
// タイトル＋要約だけで作り直されること。2回目の実行では何も変わらないこと（冪等）。
// 新規スキーマのDB（旧カラム自体が無い）でもエラーにならないこと。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { purgeBodyData } from '../src/lifecycle.mjs';
import { buildArticleSearchText } from '../src/normalize.mjs';

const LEGACY_COLUMNS = [
  'body_text TEXT', 'body_fetched_at TEXT', 'author TEXT',
  'resolved_url TEXT', 'body_url TEXT', 'body_via TEXT',
  'image_url TEXT', 'image_via TEXT', 'image_fetched_at TEXT',
  'extract_text TEXT',
];

function makeOldDb() {
  const db = openDb(':memory:');
  for (const col of LEGACY_COLUMNS) db.exec(`ALTER TABLE articles ADD COLUMN ${col}`);
  const now = new Date().toISOString();
  const c = db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .run('移行検証クラスタ', '社会', now, now);
  const cid = Number(c.lastInsertRowid);
  const v = db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1, ?, ?)')
    .run(cid, '移行検証クラスタ', now);
  const vid = Number(v.lastInsertRowid);
  // 本文にだけある語（秘情報キーワード）を含む旧形式の search_text を入れておく
  const oldSearch = buildArticleSearchText('記事タイトル', '記事の要約') + ' 秘情報キーワード';
  db.prepare(`INSERT INTO articles
    (cluster_id, version_id, source, title, url, summary, published_at, fetched_at, search_text,
     body_text, body_fetched_at, author, resolved_url, body_url, body_via,
     image_url, image_via, image_fetched_at, extract_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(cid, vid, '朝日', '記事タイトル', 'https://example.com/mig1', '記事の要約', now, now, oldSearch,
      '取得済みの本文テキスト', now, '山田太郎', 'https://example.com/resolved', 'https://example.com/body', 'direct',
      'https://example.com/img.jpg', 'og', now, '本文から抽出した要点');
  return db;
}

test('purgeBodyData: 旧カラムの中身が全て消え、search_text がタイトル＋要約で作り直される', () => {
  const db = makeOldDb();
  assert.equal(purgeBodyData(db), 1);
  const row = db.prepare('SELECT * FROM articles').get();
  assert.equal(row.body_text, '');
  assert.equal(row.body_fetched_at, null);
  assert.equal(row.author, '');
  assert.equal(row.resolved_url, '');
  assert.equal(row.body_url, '');
  assert.equal(row.body_via, '');
  assert.equal(row.image_url, '');
  assert.equal(row.image_via, '');
  assert.equal(row.image_fetched_at, null);
  assert.equal(row.extract_text, '');
  // search_text はタイトル＋要約だけ。本文にだけあった語は残らない
  assert.equal(row.search_text, buildArticleSearchText('記事タイトル', '記事の要約'));
  assert.ok(!row.search_text.includes('秘情報'));
});

test('purgeBodyData: 2回目は冪等（消去件数0で何も変わらない）', () => {
  const db = makeOldDb();
  purgeBodyData(db);
  const before = db.prepare('SELECT search_text FROM articles').get().search_text;
  assert.equal(purgeBodyData(db), 0);
  assert.equal(db.prepare('SELECT search_text FROM articles').get().search_text, before);
});

test('purgeBodyData: 新規スキーマのDB（旧カラム無し）でもエラーにならず0を返す', () => {
  const db = openDb(':memory:');
  assert.equal(purgeBodyData(db), 0);
});
