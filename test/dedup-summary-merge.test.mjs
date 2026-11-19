// 重複排除時の要約マージ（Issue #22/#23）。
// 同じ記事が「直接URL（公式RSS・要約なし）」と「GoogleニュースのラッパーURL
// （description あり）」の両方で届いた場合、従来は直接URL側を残してラッパー側を
// 捨てるため、ラッパー側が持っていた要約まで失われていた。残す側の要約が空で
// 捨てる側にある場合は、要約を残す側へ移す（その記事自身のフィード由来の
// 抜粋であり、他記事からの流用ではない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { ingestArticles } from '../src/collector.mjs';

const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
const TITLE = '市内で火災が発生 けが人なし';
const SUMMARY = '市内で火災が発生し、けが人はなかった。消防が原因を調べている。';

const directNoSummary = {
  title: TITLE,
  url: 'https://www.asahi.com/articles/ASVTEST0001.html?ref=rss',
  source: '朝日',
  summary: '',
  publishedAt: hoursAgo(5),
};
const wrapperWithSummary = {
  title: `${TITLE} - 朝日新聞`,
  url: 'https://news.google.com/rss/articles/CBMiTEST?oc=5',
  source: '朝日',
  summary: SUMMARY,
  publishedAt: hoursAgo(5),
};

function onlyArticle(db) {
  const rows = db.prepare('SELECT * FROM articles').all();
  assert.equal(rows.length, 1);
  return rows[0];
}

test('直接URL（要約なし）の後にラッパー（要約あり）が来たら、要約が残る側へ移る', () => {
  const db = openDb(':memory:');
  ingestArticles(db, [directNoSummary]);
  ingestArticles(db, [wrapperWithSummary]);
  const a = onlyArticle(db);
  assert.equal(a.url, directNoSummary.url);
  assert.equal(a.summary, SUMMARY);
  // 検索用テキストにも要約が反映される
  assert.ok(a.search_text.includes('消防'));
});

test('ラッパー（要約なし）の後に直接URL（要約あり）が来たら、URL差し替えと同時に要約が入る', () => {
  const db = openDb(':memory:');
  ingestArticles(db, [{ ...wrapperWithSummary, summary: '' }]);
  ingestArticles(db, [{ ...directNoSummary, summary: SUMMARY }]);
  const a = onlyArticle(db);
  assert.equal(a.url, directNoSummary.url);
  assert.equal(a.summary, SUMMARY);
});

test('残す側に既に要約があれば上書きしない', () => {
  const db = openDb(':memory:');
  ingestArticles(db, [{ ...directNoSummary, summary: '先に届いた要約。' }]);
  ingestArticles(db, [wrapperWithSummary]);
  const a = onlyArticle(db);
  assert.equal(a.summary, '先に届いた要約。');
});

test('見出しが異なる記事は重複扱いせず、要約も移らない', () => {
  const db = openDb(':memory:');
  ingestArticles(db, [directNoSummary]);
  ingestArticles(db, [{
    ...wrapperWithSummary,
    title: 'まったく別の出来事が起きた - 朝日新聞',
    url: 'https://news.google.com/rss/articles/CBMiOTHER?oc=5',
  }]);
  const rows = db.prepare('SELECT * FROM articles ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].summary, '');
});
