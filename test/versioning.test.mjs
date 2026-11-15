// バージョン判定の検証（合成記事、ネットワーク不要）。
// Q4決定: 同内容の他紙報道が増えただけでは版は上がらない。
//         新しい事実を含む続報が来たら v2 の行ができる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { ingestArticles } from '../src/collector.mjs';

function counts(db) {
  return {
    clusters: db.prepare('SELECT COUNT(*) c FROM clusters').get().c,
    versions: db.prepare('SELECT COUNT(*) c FROM versions').get().c,
    articles: db.prepare('SELECT COUNT(*) c FROM articles').get().c,
  };
}

const v1Asahi = {
  title: '市内で火災が発生 けが人なし',
  url: 'https://example.com/a1', source: '朝日',
  summary: '市内で火災が発生し、けが人はなかった。',
  publishedAt: '2026-11-14T01:00:00.000Z',
};
const sameYomiuri = {
  title: '市内で火災、けが人なし',
  url: 'https://example.com/y1', source: '読売',
  summary: '市内で火災があり、けが人はなかった。',
  publishedAt: '2026-11-14T02:00:00.000Z',
};
const followUp = {
  title: '市内で火災が発生 死者2人が確認される',
  url: 'https://example.com/a2', source: '朝日',
  summary: '市内で発生した火災で、死者2人が確認された。',
  publishedAt: '2026-11-14T05:00:00.000Z',
};

test('初報は v1 の1クラスタ・1バージョンになる', () => {
  const db = openDb(':memory:');
  ingestArticles(db, [v1Asahi]);
  assert.deepEqual(counts(db), { clusters: 1, versions: 1, articles: 1 });
  assert.equal(db.prepare('SELECT version_no FROM versions').get().version_no, 1);
});

test('同内容の他紙報道が増えても版は上がらず、同じ版に追加される', () => {
  const db = openDb(':memory:');
  ingestArticles(db, [v1Asahi]);
  ingestArticles(db, [sameYomiuri]);
  const c = counts(db);
  assert.equal(c.clusters, 1);
  assert.equal(c.versions, 1, '版は上がらないはず');
  assert.equal(c.articles, 2);
  const v = db.prepare('SELECT id FROM versions').get();
  const arts = db.prepare('SELECT source FROM articles WHERE version_id = ? ORDER BY source').all(v.id);
  assert.deepEqual(arts.map((a) => a.source).sort(), ['朝日', '読売']);
});

test('新しい事実を含む続報で v2 の行ができる', () => {
  const db = openDb(':memory:');
  ingestArticles(db, [v1Asahi, sameYomiuri]);
  ingestArticles(db, [followUp]);
  const c = counts(db);
  assert.equal(c.clusters, 1, '同じニュースとして1クラスタのまま');
  assert.equal(c.versions, 2, 'v2ができるはず');
  const v2 = db.prepare('SELECT * FROM versions WHERE version_no = 2').get();
  assert.ok(v2);
  const v2Articles = db.prepare('SELECT title FROM articles WHERE version_id = ?').all(v2.id);
  assert.equal(v2Articles.length, 1);
  assert.match(v2Articles[0].title, /死者2人/);
});

test('同じURLの再取得では記事も版も増えない', () => {
  const db = openDb(':memory:');
  ingestArticles(db, [v1Asahi]);
  const res = ingestArticles(db, [v1Asahi]);
  assert.equal(res.inserted, 0);
  assert.deepEqual(counts(db), { clusters: 1, versions: 1, articles: 1 });
});

test('同一記事がラッパーURLと直接URLの両方で届いたら直接URLが残る', () => {
  const wrapper = { ...v1Asahi, url: 'https://news.google.com/rss/articles/CBMiXXXX?oc=5' };
  const direct = { ...v1Asahi, url: 'https://example.com/a1-direct' };
  // ラッパー → 直接 の順
  const db = openDb(':memory:');
  ingestArticles(db, [wrapper]);
  ingestArticles(db, [direct]);
  let arts = db.prepare('SELECT url FROM articles').all();
  assert.equal(arts.length, 1, '同一記事は1件のまま');
  assert.equal(arts[0].url, 'https://example.com/a1-direct', '直接URLに差し替わるはず');
  // 直接 → ラッパー の順でも直接URLが残る
  const db2 = openDb(':memory:');
  ingestArticles(db2, [direct]);
  ingestArticles(db2, [wrapper]);
  arts = db2.prepare('SELECT url FROM articles').all();
  assert.equal(arts.length, 1);
  assert.equal(arts[0].url, 'https://example.com/a1-direct');
});

test('全く別のニュースは別クラスタになる', () => {
  const db = openDb(':memory:');
  ingestArticles(db, [v1Asahi]);
  ingestArticles(db, [{
    title: '株価が大幅に上昇し日経平均が最高値を更新',
    url: 'https://example.com/k1', source: '日経',
    summary: '日経平均株価が最高値を更新した。',
    publishedAt: '2026-11-14T03:00:00.000Z',
  }]);
  assert.equal(counts(db).clusters, 2);
});
