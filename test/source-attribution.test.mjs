// 媒体名の帰属（Issue #21）。
// 実フィード確認（2026-11-19）: Yahoo!ニュース・トピックスRSS のアイテムには
// <source> も <description> も無く、見出しに媒体名も付かない。媒体名はフィード
// 定義（配信元 = Yahoo!ニュース）で明示し、発信元は捏造しない。
// また、スコア表記を含む見出し（「森保J 3-2で…」）を「見出し - 媒体名」形式と
// 誤認して媒体名を取り出す不具合（実DBで1件発生）の再発防止。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRss, extractSourceFromTitle, cleanTitle, FEEDS } from '../src/rss.mjs';

const YAHOO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Yahoo!ニュース・トピックス - 主要</title>
<item>
  <title>21日にかけ風強まる 暴風など警戒</title>
  <link>https://news.yahoo.co.jp/pickup/6603109?source=rss</link>
  <pubDate>Wed, 18 Nov 2026 23:35:57 GMT</pubDate>
</item>
<item>
  <title>森保J 3-2でブラジル相手に勝利</title>
  <link>https://news.yahoo.co.jp/pickup/6602593?source=rss</link>
  <pubDate>Wed, 18 Nov 2026 23:30:00 GMT</pubDate>
</item>
</channel></rss>`;

test('Yahooフィード定義は媒体名 Yahoo!ニュース を持つ', () => {
  const yahooFeeds = FEEDS.filter((f) => f.url.includes('news.yahoo.co.jp'));
  assert.ok(yahooFeeds.length > 0);
  for (const f of yahooFeeds) assert.equal(f.source, 'Yahoo!ニュース');
});

test('source要素の無いフィードではフィード定義の媒体名が付く', () => {
  const feed = FEEDS.find((f) => f.url.includes('news.yahoo.co.jp'));
  const items = parseRss(YAHOO_XML, feed);
  assert.equal(items.length, 2);
  assert.equal(items[0].source, 'Yahoo!ニュース');
  // フィードに description が無いので要約は空のまま（捏造しない）
  assert.equal(items[0].summary, '');
});

test('スコア表記を見出しから媒体名として取り出さない', () => {
  assert.equal(extractSourceFromTitle('森保J 3-2でブラジル相手に勝利'), '');
  const feed = FEEDS.find((f) => f.url.includes('news.yahoo.co.jp'));
  const items = parseRss(YAHOO_XML, feed);
  assert.equal(items[1].source, 'Yahoo!ニュース');
  // 見出しもスコア部分を落とさず保持する
  assert.equal(cleanTitle(items[1].title, items[1].source), '森保J 3-2でブラジル相手に勝利');
});

test('Googleニュース形式の「見出し - 媒体名」は従来どおり取り出す', () => {
  assert.equal(extractSourceFromTitle('衆院削減に声明 - 共同通信'), '共同通信');
  assert.equal(cleanTitle('衆院削減に声明 - 共同通信', '共同'), '衆院削減に声明');
  assert.equal(extractSourceFromTitle('サフィックスの無い見出し'), '');
});
