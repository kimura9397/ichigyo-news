// サムネイル画像URLの抽出・保存の検証（合成データ、ネットワーク不要）。
// 段階1: RSSに画像があれば image_url として拾う。段階2: 記事ページの og:image 抽出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { parseRss, ingestArticles } from '../src/collector.mjs';
import { extractOgImage } from '../src/body.mjs';

test('RSSの media:thumbnail があれば imageUrl として拾う', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
    <item><title>画像つき記事</title><link>https://example.com/i1</link>
    <description>本文の抜粋です。</description><pubDate>Sat, 15 Nov 2026 01:00:00 GMT</pubDate>
    <media:thumbnail url="https://example.com/thumb.jpg" width="120" height="90" /></item>
  </channel></rss>`;
  const items = parseRss(xml, {});
  assert.equal(items.length, 1);
  assert.equal(items[0].imageUrl, 'https://example.com/thumb.jpg');
});

test('RSSの enclosure（image）と description 内 img からも拾う', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>エンクロージャ記事</title><link>https://example.com/i2</link>
    <description>抜粋。</description><pubDate>Sat, 15 Nov 2026 01:00:00 GMT</pubDate>
    <enclosure url="https://example.com/enc.png" type="image/png" length="123" /></item>
    <item><title>img埋め込み記事</title><link>https://example.com/i3</link>
    <description>&lt;p&gt;本文&lt;img src="https://example.com/in-desc.jpg" /&gt;続き&lt;/p&gt;</description>
    <pubDate>Sat, 15 Nov 2026 02:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const items = parseRss(xml, {});
  assert.equal(items.length, 2);
  assert.equal(items[0].imageUrl, 'https://example.com/enc.png');
  assert.equal(items[1].imageUrl, 'https://example.com/in-desc.jpg');
});

test('画像のないRSSでは imageUrl は空（壊れない）', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>画像なし記事</title><link>https://example.com/i4</link>
    <description>抜粋のみ。</description><pubDate>Sat, 15 Nov 2026 01:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const items = parseRss(xml, {});
  assert.equal(items.length, 1);
  assert.equal(items[0].imageUrl, '');
});

test('取り込みで image_url と image_via=rss が保存される', () => {
  const db = openDb(':memory:');
  ingestArticles(db, [{
    title: '画像つき初報が届いた',
    url: 'https://example.com/with-image', source: '朝日',
    summary: '画像つきの記事。',
    imageUrl: 'https://example.com/thumb.jpg',
    publishedAt: '2026-11-15T01:00:00.000Z',
  }]);
  const a = db.prepare('SELECT image_url, image_via FROM articles').get();
  assert.equal(a.image_url, 'https://example.com/thumb.jpg');
  assert.equal(a.image_via, 'rss');
});

test('og:image を優先し、twitter:image にフォールバックし、相対URLを解決する', () => {
  const both = `<html><head>
    <meta name="twitter:image" content="https://example.com/tw.jpg">
    <meta property="og:image" content="https://example.com/og.jpg">
  </head><body></body></html>`;
  assert.equal(extractOgImage(both, 'https://example.com/a'), 'https://example.com/og.jpg');
  const twOnly = `<html><head><meta name="twitter:image" content="/img/tw.jpg"></head></html>`;
  assert.equal(extractOgImage(twOnly, 'https://example.com/news/a'), 'https://example.com/img/tw.jpg');
  const none = `<html><head><title>x</title></head></html>`;
  assert.equal(extractOgImage(none, 'https://example.com/a'), '');
  const bad = `<html><head><meta property="og:image" content="javascript:alert(1)"></head></html>`;
  assert.equal(extractOgImage(bad, 'https://example.com/a'), '');
});
