// RSS取得・パース: フィード定義、取得（サイズ上限・タイムアウトつき）、
// 正規表現ベースのパースとテキスト整形。
// src/collector.mjs から分割した（Issue #12）。外部依存なし。LLMは使わない。

export const PAPERS = ['朝日', '毎日', '読売', '産経', '日経'];

export const FEEDS = [
// NHK（カテゴリ別）
...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({
name: `NHK cat${n}`,
source: 'NHK',
category: ['', '社会', '政治', '経済', '国際', 'スポーツ', '文化・エンタメ', '科学'][n] || '',
url: `https://www.nhk.or.jp/rss/news/cat${n}.xml`,
})),
// Googleニュース（トップ＋セクション検索）
{ name: 'Google トップ', source: '', category: '', url: 'https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja'},
...[
['政治', '政治'], ['経済', '経済'], ['社会', '社会'], ['国際', '国際'],
['スポーツ', 'スポーツ'], ['エンタメ', '文化・エンタメ'], ['科学', '科学'],
].map(([q, category]) => ({
name: `Google ${q}`,
source: '',
category,
url: `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ja&gl=JP&ceid=JP:ja`,
})),
// Yahoo!ニュース（トピックス別）
// このフィードのアイテムには <source> も description も無く、見出しにも媒体名が
// 付かない（2026-11-19 実フィードで確認）。配信元はフィード自体（Yahoo!ニュース・
// トピックス）なので、媒体名はフィード定義で明示する。個別記事の発信元は
// フィードからは分からないため、捏造して付けない（Issue #21）。
...[
['top-picks', ''], ['domestic', '社会'], ['world', '国際'], ['business', '経済'],
['entertainment', '文化・エンタメ'], ['sports', 'スポーツ'], ['it', '科学'], ['science', '科学'],
].map(([t, category]) => ({
name: `Yahoo ${t}`,
source: 'Yahoo!ニュース',
category,
url: `https://news.yahoo.co.jp/rss/topics/${t}.xml`,
})),
// 各紙ドメインのGoogleニュース検索（5大紙＋時事・共同のシェアを確保する）
...[
['朝日', 'asahi.com'], ['読売', 'yomiuri.co.jp'], ['毎日', 'mainichi.jp'],
['日経', 'nikkei.com'], ['産経', 'sankei.com'], ['時事', 'jiji.com'], ['共同', '47news.jp'],
].map(([paper, domain]) => ({
name: `Google ${paper} (site:${domain})`,
source: '',
category: '',
url: `https://news.google.com/rss/search?q=${encodeURIComponent(`site:${domain}`)}&hl=ja&gl=JP&ceid=JP:ja`,
})),
// 公式RSSで記事ページへの直接URLが返るもの（ラッパーURLを経由しないため、「元記事を読む」のリンクが媒体のページへ直接届く）。
// 2026-11-15 実測でアイテムが返ることを確認したものだけを採用している。
// （毎日・47newsの公式RSSはこの環境では403で取得できず未採用。読売・日経・産経は公開RSSのURLを確認できず未採用）
{ name: '朝日 見出し', source: '朝日', category: '', url: 'https://www.asahi.com/rss/asahi/newsheadlines.rdf' },
{ name: '朝日 政治', source: '朝日', category: '政治', url: 'https://www.asahi.com/rss/asahi/politics.rdf' },
{ name: '朝日 国際', source: '朝日', category: '国際', url: 'https://www.asahi.com/rss/asahi/international.rdf' },
{ name: '時事 ランキング', source: '時事', category: '', url: 'https://www.jiji.com/rss/ranking.rdf' },
];

/**
 * 中継（ラッパー）URLか。同一記事が直接URLでも届いた場合は、「元記事を読む」の
 * リンク先として直接URL側を残すために区別する。
 * 現状のラッパーは Googleニュース（news.google.com の記事URL）のみ。
 */
export function isWrapperUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.hostname === 'news.google.com' && /^\/(rss\/)?articles\//.test(u.pathname);
  } catch {
    return false;
  }
}

/** アグリゲータ（配信元であって発信元ではない媒体）。表示はそのままだが、重要度スコアの媒体数には数えない。 */
export const AGGREGATORS = ['Yahoo!ニュース', 'au Webポータル', 'SmartNews', 'ライブドアニュース', 'dメニューニュース', 'Infoseek'];

const FETCH_TIMEOUT_MS = 8000;

/** 外部応答（RSS）の読み取り上限（バイト）。これを超える応答は異常として打ち切る（2026-11-16 コンプライアンス対応 #7）。 */
export const MAX_FEED_BYTES = 5 * 1024 * 1024;

/**
 * fetch の応答をテキストで読む（サイズ上限つき）。
 * ストリームがあれば上限を超えた時点で読み取りを中断する。ストリームを持たない
 * 応答（テスト用のスタブ等）は text() の結果をバイト長で判定する。
 * 上限超過は例外にして、呼び出し側の失敗扱い（フィードのスキップ等）に乗せる。
 */
export async function readResponseText(res, limitBytes = MAX_FEED_BYTES) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`response too large (> ${limitBytes} bytes)`);
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(buf);
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > limitBytes) {
    throw new Error(`response too large (> ${limitBytes} bytes)`);
  }
  return text;
}

// ---------- テキストユーティリティ ----------

export function decodeEntities(s) {
return String(s?? '')
.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
.replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function stripTags(s) {
return decodeEntities(String(s?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** ルールベース抽出サマリー: 抜粋テキストを整形し、文単位で最大 maxLen 字まで。 */
export function extractSummary(text, maxLen = 220) {
const clean = stripTags(text)
.replace(/^(続きを読む|詳細は).*$/, '')
.trim();
if (clean.length <= maxLen) return clean;
const cut = clean.slice(0, maxLen);
const lastSentence = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('、'));
return (lastSentence > maxLen * 0.5? cut.slice(0, lastSentence + 1): cut) + (lastSentence > maxLen * 0.5? '': '…');
}

// ---------- RSSパース（正規表現ベース） ----------

export function parseRss(xml, feed = {}) {
const items = [];
const blocks = String(xml).match(/<item[\s>][\s\S]*?<\/item>/g) || [];
for (const block of blocks) {
const pick = (tag) => {
const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
return m? decodeEntities(m[1]).trim(): '';
};
const title = stripTags(pick('title'));
const link = decodeEntities(pick('link')) || (block.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
if (!title ||!link) continue;
const sourceTag = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
const descriptionRaw = pick('description');
items.push({
title,
url: link,
summary: extractSummary(descriptionRaw),
publishedAt: (pick('pubDate') || pick('dc:date')) ? new Date(pick('pubDate') || pick('dc:date')).toISOString() : null,
source: normalizeSource(stripTags(sourceTag) || feed.source || extractSourceFromTitle(title)),
category: feed.category || '',
});
}
return items;
}

/** Googleニュース形式の「見出し - 媒体名」から媒体名を取り出す。 */
export function extractSourceFromTitle(title) {
const m = String(title).match(/[-―–—]\s*([^-―–—]{2,20})$/);
if (!m) return '';
const suffix = m[1].trim();
// スコア表記（例: 「森保J 3-2でブラジル相手に勝利」の「2で…」）を媒体名と
// 誤認しない。数字で始まるサフィックスは原則として媒体名ではない（Issue #21 実例）。
// ただし「47NEWS」のような数字始まりの媒体名は実在し、サフィックスとして残ると
// 照合の接着剤になる（監査 2026-11-19）。数字＋英字だけで構成され、既知媒体名に
// 正規化できるものだけを例外として媒体名と認める。
if (/^[0-9０-９]/.test(suffix)) {
const compact = suffix.replace(/[\s　]/g, '');
if (!/^[0-9０-９]+[A-Za-zＡ-Ｚａ-ｚ]+$/.test(compact)) return '';
if (normalizeSource(suffix) === suffix) return '';
}
return suffix;
}

/**
 * 配信元らしい末尾表記か（既知媒体名を含む、または配信元の定型語で終わる）。
 * strict の場合は、コロン区切りのように本文側にも現れやすい区切り向けに、
 * 既知媒体名を含むか「ドットコム／ネットワーク」で終わる場合だけに絞る。
 */
function isSourceLikeTail(s, strict = false) {
const t = String(s || '').trim();
if (!t || t.length > 30) return false;
if (normalizeSource(t) !== t) return true;
if (/(ドットコム|ネットワーク)$/.test(t)) return true;
if (strict) return false;
return /(新聞|通信社|放送|テレビ|ラジオ|スポーツ|ニュース)$/.test(t);
}

export function normalizeSource(name) {
const n = String(name || '').trim();
if (/朝日/.test(n)) return '朝日';
if (/毎日/.test(n)) return '毎日';
if (/読売/.test(n)) return '読売';
if (/産経/.test(n)) return '産経';
if (/日経|日本経済新聞/.test(n)) return '日経';
if (/NHK/.test(n)) return 'NHK';
if (/共同|47NEWS/.test(n)) return '共同';
if (/時事/.test(n)) return '時事';
return n;
}

/** タイトル表示用に「 - 媒体名」サフィックスを落とす（Googleニュース形式）。 */
export function cleanTitle(title, source) {
let t = String(title).trim();
const suffix = extractSourceFromTitle(t);
if (suffix && normalizeSource(suffix) === normalizeSource(source || suffix)) {
t = t.slice(0, t.length - suffix.length).replace(/[-―–—]\s*$/, '').trim();
}
// 全角コロン区切りの配信元表記（例: 「…：時事ドットコム」）。ダッシュ区切りしか
// 見ない extractSourceFromTitle では落ちず、残ると照合の接着剤になる（監査 2026-11-19）
const colon = t.match(/^(.*?)[：:]\s*([^\s：:]{2,30})$/);
if (colon && isSourceLikeTail(colon[2], true)) t = colon[1].trim();
// 末尾の括弧書きの配信元表記（例: 「…（みんなの経済新聞ネットワーク）」「…（中日スポーツ）」）
const paren = t.match(/^(.*?)[（(]([^（）()]{2,30})[）)]\s*$/);
if (paren && isSourceLikeTail(paren[2])) t = paren[1].trim();
return t;
}

// ---------- フィード取得 ----------

/**
 * RSS テキストを取得する（通常フィードと社説検索の共用）。
 * タイムアウトは応答本文の読み取りが終わるまで解除しない。ヘッダーだけ返して
 * 止まる応答でも待ち続けず、FETCH_TIMEOUT_MS で打ち切る。
 * （社説側は以前 fetch 直後にタイマーを解除しており、2回目のコンプライアンス
 * チェック 2026-11-16 の指摘でこの形に統一した。）
 * 429 を含む HTTP エラーではリトライしない（2026-11-17 方針: 実害が小さい
 * ため回復処理は足さず、失敗を分かる言葉でログに残す）。HTTP エラーの
 * 例外には status を持たせ、ログ側がコードを取り出せるようにする。
 */
export async function fetchRssText(url, fetchImpl = fetch) {
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
try {
const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'user-agent': 'news-app/0.1 (+personal use)' } });
if (!res.ok) {
const err = new Error(`HTTP ${res.status}`);
err.status = res.status;
throw err;
}
return await readResponseText(res);
} finally {
clearTimeout(timer);
}
}

/**
 * フィード取得失敗のログ文面（2026-11-17）。コンソールに「HTTP 429」だけが
 * 出ても何事かと心配になるため、フィード名とコードと「次にどうなるか」を
 * 言葉にする。「次の更新で再取得します」と言えるのは、次の自動更新が予約
 * されている（ポーリング有効）ときだけ。手動更新のみの状態では再取得を
 * 約束せず、失敗の事実とコードまでに留める。
 */
export function feedFailureMessage(feed, err, { willRetry = false } = {}) {
const name = feed?.name || feed?.url || '不明なフィード';
let detail = '';
if (err?.status) detail = `（HTTP ${err.status}）`;
else if (err?.name === 'AbortError') detail = '（応答が時間切れになりました）';
const base = `${name} の取得に失敗しました${detail}`;
return willRetry ? `${base}。次の更新で再取得します` : base;
}

export async function fetchFeed(feed, fetchImpl = fetch) {
return parseRss(await fetchRssText(feed.url, fetchImpl), feed);
}
