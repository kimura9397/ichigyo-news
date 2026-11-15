// 収集モジュール: RSS取得・パース、同一ニュースのクラスタリング、
// バージョン判定（Q4: 新事実を含む続報のみ版を上げる）、抽出サマリー。
// サーバー/UIから分離してあるので、後から cron 等で常時収集に拡張できる。
// 外部依存なし（fetch / 正規表現ベースのXMLパースのみ）。LLMは使わない。
import { openDb} from './db.mjs';
import { runLifecycle } from './lifecycle.mjs';

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
...[
['top-picks', ''], ['domestic', '社会'], ['world', '国際'], ['business', '経済'],
['entertainment', '文化・エンタメ'], ['sports', 'スポーツ'], ['it', '科学'], ['science', '科学'],
].map(([t, category]) => ({
name: `Yahoo ${t}`,
source: '',
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
// 公式RSSで記事ページへの直接URLが返るもの（ラッパーURLを経由しないため本文取得の材料になる）。
// 2026-11-15 実測でアイテムが返ることを確認したものだけを採用している。
// （毎日・47newsの公式RSSはこの環境では403で取得できず未採用。読売・日経・産経は公開RSSのURLを確認できず未採用）
{ name: '朝日 見出し', source: '朝日', category: '', url: 'https://www.asahi.com/rss/asahi/newsheadlines.rdf' },
{ name: '朝日 政治', source: '朝日', category: '政治', url: 'https://www.asahi.com/rss/asahi/politics.rdf' },
{ name: '朝日 国際', source: '朝日', category: '国際', url: 'https://www.asahi.com/rss/asahi/international.rdf' },
{ name: '時事 ランキング', source: '時事', category: '', url: 'https://www.jiji.com/rss/ranking.rdf' },
];

/**
 * 中継（ラッパー）URLか。本文取得では実ページに辿り着けないため、直接URLと区別する。
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

/** Yahoo!ニュースの記事ページ（/articles/）か。配信記事の本文がYahoo側に掲載されていることが多い。 */
export function isYahooArticleUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.hostname === 'news.yahoo.co.jp' && u.pathname.startsWith('/articles/');
  } catch {
    return false;
  }
}

/** アグリゲータ（配信元であって発信元ではない媒体）。表示はそのままだが、重要度スコアの媒体数には数えない。 */
export const AGGREGATORS = ['Yahoo!ニュース', 'au Webポータル', 'SmartNews', 'ライブドアニュース', 'dメニューニュース', 'Infoseek'];

const FETCH_TIMEOUT_MS = 8000;

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

/**
 * アイテムブロックからサムネイル画像のURLを取り出す（段階1: RSSに画像があれば拾う）。
 * media:thumbnail / media:content（image のもの）/ enclosure（image/*）/ description 内の <img> の順に探す。
 * http/https のURLだけを採用する。画像そのものは保存せず、URLの参照表示のみ。
 * 現在の主要フィードは記事ごとの画像をほぼ含まないため、通常は '' になる（壊れないこと優先）。
 */
export function extractFeedImage(block, descriptionHtml = '') {
const candidates = [];
for (const m of String(block).matchAll(/<media:(thumbnail|content)\b[^>]*>/gi)) {
const tag = m[0];
const url = (tag.match(/\burl="([^"]+)"/i) || [])[1];
if (!url) continue;
if (m[1].toLowerCase() === 'content') {
const type = (tag.match(/\btype="([^"]+)"/i) || [])[1] || '';
const medium = (tag.match(/\bmedium="([^"]+)"/i) || [])[1] || '';
if (type && !type.startsWith('image/')) continue;
if (medium && medium !== 'image') continue;
}
candidates.push(url);
}
for (const m of String(block).matchAll(/<enclosure\b[^>]*>/gi)) {
const tag = m[0];
const type = (tag.match(/\btype="([^"]+)"/i) || [])[1] || '';
if (!type.startsWith('image/')) continue;
const url = (tag.match(/\burl="([^"]+)"/i) || [])[1];
if (url) candidates.push(url);
}
const img = String(descriptionHtml).match(/<img[^>]*\bsrc="([^"]+)"/i);
if (img) candidates.push(img[1]);
for (const c of candidates) {
const url = decodeEntities(c).trim();
try {
const u = new URL(url);
if (u.protocol === 'http:' || u.protocol === 'https:') return url;
} catch { /* 不正なURLは読み飛ばす */ }
}
return '';
}

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
imageUrl: extractFeedImage(block, descriptionRaw),
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
return m? m[1].trim(): '';
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
return t;
}

// ---------- 類似度・新規性判定 ----------

function normalizeForMatch(s) {
return String(s)
.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角数字→半角
.replace(/[0-9]+月[0-9]+日/g, '') // 日付表記は同一ニュース判定のノイズになるので落とす
.replace(/[0-9]+時[0-9]+分/g, '')
.replace(/[「」『』（）()［］\[\]・、。，．:：;；!！?？'"“”‘’\s]/g, '')
.replace(/[-―–—]/g, '')
.toLowerCase();
}

/** 文字バイグラム集合（日本語見出しの類似度判定用）。 */
export function bigrams(s) {
const n = normalizeForMatch(s);
const set = new Set();
for (let i = 0; i < n.length - 1; i++) set.add(n.slice(i, i + 2));
if (n.length === 1) set.add(n);
return set;
}

export function jaccard(a, b) {
if (!a.size ||!b.size) return 0;
let inter = 0;
for (const x of a) if (b.has(x)) inter++;
return inter / (a.size + b.size - inter);
}

/** クラスタ照合用スコア: 小さい方の集合に対する一致率（包含率）。続報は言い換えで見出しが長くなるため Jaccard だけだと取りこぼす。 */
export function matchScore(a, b) {
if (!a.size || !b.size) return 0;
let inter = 0;
for (const x of a) if (b.has(x)) inter++;
const containment = inter / Math.min(a.size, b.size);
const jac = inter / (a.size + b.size - inter);
// 汎用語だけの一致で無関係な記事が連鎖的に合体するのを防ぐ:
// 共有バイグラム4以上を必須とし、包含率かJaccardのどちらかが高い場合のみ一致とみなす。
return inter >= 4 && (containment >= 0.35 || jac >= 0.30) ? containment : 0;
}

/** 事実要素トークン: 数値＋単位、英字語、事実系キーワード。 */
const FACT_KEYWORDS = ['死者', '死亡', '逮捕', '起訴', '発表', '確定', '判明', '再開', '中止', '延期', '優勝', '成立', '可決', '否決', '辞任', '就任', '地震', '津波', '避難', '解除', '発令', '上昇', '下落', '最高', '最低', '初'];
export function factTokens(title) {
const tokens = new Set();
for (const m of String(title).matchAll(/[0-9０-９]+(?:\.[0-9０-９]+)?\s*(?:人|円|%|％|件|歳|日|月|年|km|キロ|メートル|m|度|ドル|ポイント)?/g)) {
const t = m[0].replace(/\s/g, '');
if (/[0-9０-９]/.test(t) && t.length >= 2) tokens.add(t);
}
for (const kw of FACT_KEYWORDS) if (title.includes(kw)) tokens.add(kw);
return tokens;
}

/**
* バージョン判定（ヒューリスティクス）。
* 既存バージョン群のタイトルと比べ、
* - 同一クラスタとみなせる類似度があること
* - 新規バイグラム比率が高い AND（新規の事実トークンがある OR 新規比率が非常に高い）
* を満たす場合のみ「新事実を含む続報」として新バージョンにする。
*/
export function isNewFactFollowUp(existingTitles, newTitle) {
const nb = bigrams(newTitle);
if (!nb.size) return false;
const allExisting = new Set();
for (const t of existingTitles) for (const b of bigrams(t)) allExisting.add(b);
const newFacts = new Set([...factTokens(newTitle)].filter((t) => ![...existingTitles].some((et) => factTokens(et).has(t))));
let novel = 0;
for (const b of nb) if (!allExisting.has(b)) novel++;
const novelRatio = novel / nb.size;
return (novelRatio >= 0.5 && newFacts.size > 0) || novelRatio >= 0.8;
}

/** 汎用語のバイグラムは照合から外す（「速報」「情報」等の一致だけで無関係な記事が寄るのを防ぐ）。 */
const WEAK_CHARS = new Set([...'速報続報情報話題動画写真映像提供配信会社関係者向最大級台']);
export function filterWeakBigrams(set) {
const out = new Set();
for (const b of set) {
if (b.length === 2 && WEAK_CHARS.has(b[0]) && WEAK_CHARS.has(b[1])) continue;
out.add(b);
}
return out;
}

const SUMMARY_STOP = new Set(['こと', 'もの', 'ため', 'これ', 'それ', 'あれ', 'ここ', 'そこ', 'よう', 'さん', 'ます', 'です', 'した', 'して', 'する', 'なる', 'ある', 'いる', 'れる', 'から', 'まで', 'など', 'という', 'として', 'について', 'による', 'により', 'ている', 'ていた', 'ました', 'でした', '記者', '写真', '動画', '記事', '配信', '提供']);
/** 概要テキストから照合補助用の語彙集合を作る（固有名詞っぽい語を中心に）。 */
export function summaryWords(text) {
const words = new Set();
const t = String(text || '');
for (const m of t.matchAll(/[ァ-ヶー]{2,}/g)) words.add(m[0]);
for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)) words.add(m[0]);
for (const m of t.matchAll(/[\u4e00-\u9fff]{2,4}/g)) words.add(m[0]);
for (const w of SUMMARY_STOP) words.delete(w);
return words;
}

function sharedCount(a, b) {
let n = 0;
for (const x of a) if (b.has(x)) n++;
return n;
}

const CLUSTER_THRESHOLD = 0.20;
const CLUSTER_WINDOW_MS = 3 * 24 * 3600000; // 照合対象は直近3日のクラスタに限る

// ---------- DB取り込み ----------

/** 主要媒体（全国紙・通信社・NHK）はキュレーション上の「質の重み」を大きくする（Menthas参考）。 */
export const MAJOR_SOURCES = [...PAPERS, '共同', '時事', 'NHK'];
export function sourceWeight(source) {
if (AGGREGATORS.includes(source)) return 0; // アグリゲータは媒体数に数えない
return MAJOR_SOURCES.includes(source) ? 3 : 1;
}

/**
 * カテゴリ補正: 見出しに明確なスポーツ語が含まれていれば「スポーツ」に分類する。
 * フィード由来のカテゴリは付け間違いが少なくない（例: 車いすマラソンのニュースが
 * 「国際」で届く、カテゴリ空欄で届く）。スポーツ語は誤判定がほぼ無い語に絞る。
 * スポーツへの補正のみを行い、それ以外は元のカテゴリをそのまま返す（最小限の補正）。
 */
export const SPORTS_KEYWORDS = [
'マラソン', '大相撲', '初場所', '夏場所', '名古屋場所', '秋場所', '九州場所', '横綱', '大関', '力士',
'競馬', '競輪', '競艇', 'プロ野球', '高校野球', '甲子園', 'センバツ',
'サッカー', 'ワールドカップ', 'W杯', 'Jリーグ', 'Ｊリーグ', 'Bリーグ', 'Ｂリーグ', 'Vリーグ', '大リーグ', 'メジャーリーグ', 'プレミアリーグ',
'オリンピック', 'パラリンピック', '五輪',
'ラグビー', 'テニス', 'ゴルフ', 'バスケットボール', 'バレーボール', 'バドミントン', '卓球',
'柔道', '剣道', '空手', 'ボクシング', 'レスリング', '競泳', '水泳', '陸上競技', '駅伝',
'スキー', 'スノーボード', 'フィギュアスケート', 'スピードスケート', 'アイスホッケー',
'ハンドボール', 'ホッケー', 'フェンシング', '体操', '新体操', 'トライアスロン', 'カヌー',
'セーリング', 'アーチェリー', 'ウエイトリフティング', 'テコンドー', 'サーフィン',
'スケートボード', 'スポーツクライミング', 'モータースポーツ',
];
export function refineCategory(title, category) {
const t = String(title || '');
for (const kw of SPORTS_KEYWORDS) if (t.includes(kw)) return 'スポーツ';
return category || '';
}

/** 配信記事の署名: クラスタリングと同じ正規化をかけたタイトル。タイトルが空なら要約冒頭で代用する。 */
export function articleSignature(article) {
const base = String(article.title || '').trim() || String(article.summary || '').slice(0, 60);
return normalizeForMatch(base);
}

/**
* 重要度スコア v2（2026-11-15 再設計）。
* v1（同日先行改善）の式は署名グループごとの重み合計が主成分で、言い換え見出しの多い
* 大型クラスタほど重みが積み上がり膨張した（例: 接続障害クラスタ 124→285）。
* v2 は「主要媒体が独自に報じているか」を軸にし、各成分に上限と圧縮を入れて暴走を防ぐ。
* - 主要媒体成分: 署名グループのうち、最大重みの媒体が主要媒体（重み3）のグループだけを
*      本計算に入れる。その重み合計 W に log 圧縮 10 × log2(1 + W) を掛ける。
* - 広がり成分: それ以外の媒体（重み1）のグループは +0.5/グループ、上限 +5。
*      アグリゲータのみのグループ（重み0）はどちらの成分にも入れない。
* - グループ数成分: 署名グループ総数に上限を付け min(G, 20) × 0.8。
* - バージョン成分: min(版数, 5) × 2（続報の積み上がりにも上限）。
* - 新しさボーナス: 最新記事が6時間以内 +5 / 24時間以内 +2（従来どおり）。
* - A: カテゴリがスポーツ / 文化・エンタメのクラスタは、社説ボーナスを除いた
*      小計に ×0.7 の減衰を掛ける。カテゴリは refineCategory で補正済みの前提。
* - D: 社説が found で確認できた媒体1つにつき +6（上限 +18）。各紙が社説で
*      取り上げたニュースは「重要」と判断された証拠とみなす。
*/
export function importanceFor(db, clusterId) {
const cluster = db.prepare('SELECT category FROM clusters WHERE id = ?').get(clusterId);
const row = db.prepare(`
SELECT (SELECT COUNT(*) FROM versions WHERE cluster_id = ?) AS versions,
MAX(published_at) AS latest
FROM articles WHERE cluster_id = ?`).get(clusterId, clusterId);
const articles = db.prepare('SELECT source, title, summary FROM articles WHERE cluster_id = ?').all(clusterId);
// 署名グループごとに最大の媒体重みを保持する（配信の複製は1グループに畳む）
const groupMaxWeight = new Map();
for (const a of articles) {
const sig = articleSignature(a);
const w = sourceWeight(a.source);
if (!groupMaxWeight.has(sig) || groupMaxWeight.get(sig) < w) groupMaxWeight.set(sig, w);
}
let majorWeight = 0; // 主要媒体グループの重み合計 W
let otherGroups = 0; // 主要媒体でもアグリゲータでもない媒体のグループ数
for (const w of groupMaxWeight.values()) {
if (w >= 3) majorWeight += w;
else if (w === 1) otherGroups++;
}
let score = 10 * Math.log2(1 + majorWeight)
+ Math.min(otherGroups * 0.5, 5)
+ Math.min(groupMaxWeight.size, 20) * 0.8
+ Math.min(row.versions, 5) * 2;
if (row.latest) {
const ageH = (Date.now() - new Date(row.latest).getTime()) / 3600000;
if (ageH <= 6) score += 5; else if (ageH <= 24) score += 2;
}
// A: カテゴリ減衰（弱め）。社説ボーナスは減衰の対象外なので、この後に加える
if (cluster && (cluster.category === 'スポーツ' || cluster.category === '文化・エンタメ')) {
score *= 0.7;
}
// D: 社説ボーナス
const editorialCount = db.prepare('SELECT COUNT(*) AS c FROM editorials WHERE cluster_id = ? AND found = 1').get(clusterId).c;
score += Math.min(editorialCount * 6, 18);
return score;
}

/**
* 記事配列をDBに取り込む。fetchに依存しない純粋な取り込み処理（テスト可能）。
* 戻り値: { seen, inserted}
*/
export function ingestArticles(db, rawItems, now = new Date()) {
db.exec('BEGIN IMMEDIATE');
try {
const result = ingestInner(db, rawItems, now);
db.exec('COMMIT');
return result;
} catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

function ingestInner(db, rawItems, now = new Date()) {
const nowIso = now.toISOString();
const items = [...rawItems].sort((a, b) => String(a.publishedAt || '').localeCompare(String(b.publishedAt || '')));
let inserted = 0;
const existsUrl = db.prepare('SELECT id FROM articles WHERE url = ?');
// クラスタ照合のメモ化: クラスタ標題と所属記事タイトルのバイグラム（汎用語除去済み）、
// 概要の語彙集合、最終出現時刻を一度だけ計算する
const clusterCache = new Map(); // id -> { titleBg, articleBgs: [Set], summaryWords: Set, lastSeenMs }
for (const c of db.prepare('SELECT id, title, last_seen_at FROM clusters').all()) {
  clusterCache.set(c.id, { titleBg: filterWeakBigrams(bigrams(c.title)), articleBgs: [], summaryWords: new Set(), lastSeenMs: Date.parse(c.last_seen_at) || 0 });
}
for (const a of db.prepare('SELECT cluster_id, title, summary FROM articles').all()) {
  const entry = clusterCache.get(a.cluster_id);
  if (!entry) continue;
  entry.articleBgs.push(filterWeakBigrams(bigrams(cleanTitle(a.title, ''))));
  for (const w of summaryWords(a.summary)) entry.summaryWords.add(w);
}
const versionTitlesStmt = db.prepare('SELECT title FROM versions WHERE cluster_id = ? ORDER BY version_no');
for (const raw of items) {
if (!raw.url || !raw.title) continue;
if (existsUrl.get(raw.url)) continue;
const source = normalizeSource(raw.source || extractSourceFromTitle(raw.title));
const title = cleanTitle(raw.title, source);
const titleBg = filterWeakBigrams(bigrams(title));
const itemSummaryWords = summaryWords(raw.summary);
const itemMs = Date.parse(raw.publishedAt || nowIso) || now.getTime();
let best = null;
for (const [cid, entry] of clusterCache) {
  // 照合対象は直近のクラスタに限る（古い出来事との誤合体と計算量を抑える）
  if (entry.lastSeenMs && Math.abs(itemMs - entry.lastSeenMs) > CLUSTER_WINDOW_MS) continue;
  let maxSim = matchScore(titleBg, entry.titleBg);
  for (const bg of entry.articleBgs) maxSim = Math.max(maxSim, matchScore(titleBg, bg));
  if (maxSim === 0) {
    // 見出しバイグラムで届かない場合の補助: 弱い見出し類似（生Jaccard）＋概要の特徴語共有が両方あれば同一視する
    let graded = jaccard(titleBg, entry.titleBg);
    for (const bg of entry.articleBgs) graded = Math.max(graded, jaccard(titleBg, bg));
    if (graded >= 0.12 && sharedCount(itemSummaryWords, entry.summaryWords) >= 3) maxSim = CLUSTER_THRESHOLD;
  }
  if (!best || maxSim > best.sim) best = { id: cid, sim: maxSim };
}
let clusterId, versionId;
if (best && best.sim >= CLUSTER_THRESHOLD) {
clusterId = best.id;
const vTitles = versionTitlesStmt.all(clusterId).map((r) => r.title);
const latest = db.prepare('SELECT id, version_no FROM versions WHERE cluster_id = ? ORDER BY version_no DESC LIMIT 1').get(clusterId);
if (isNewFactFollowUp(vTitles, title)) {
const info = db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, ?, ?, ?)').run(clusterId, latest.version_no + 1, title, nowIso);
versionId = Number(info.lastInsertRowid);
} else {
versionId = latest.id;
}
db.prepare('UPDATE clusters SET last_seen_at = ? WHERE id = ?').run(nowIso, clusterId);
} else {
const info = db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)').run(title, refineCategory(title, raw.category || ''), raw.publishedAt || nowIso, nowIso);
clusterId = Number(info.lastInsertRowid);
const v = db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1, ?, ?)').run(clusterId, title, nowIso);
versionId = Number(v.lastInsertRowid);
clusterCache.set(clusterId, { titleBg, articleBgs: [], summaryWords: new Set(), lastSeenMs: now.getTime() });
}
// 同一記事が「ラッパーURL」と「直接URL」の両方で届いた場合は直接URL側を残す
// （ラッパーURLでは本文取得ができないため）。同一媒体・同一版・見出しがほぼ同一のものを同一記事とみなす。
const sameVersionArticles = db.prepare('SELECT id, url, title FROM articles WHERE version_id = ? AND source = ?').all(versionId, source);
let duplicateHandled = false;
for (const ex of sameVersionArticles) {
if (matchScore(titleBg, filterWeakBigrams(bigrams(ex.title))) < 0.8) continue;
const exWrapper = isWrapperUrl(ex.url);
const newWrapper = isWrapperUrl(raw.url);
if (exWrapper && !newWrapper) {
// 既存がラッパーで新規が直接URL: 既存行のURLを直接URLに差し替える（本文キャッシュ等はそのまま）
db.prepare('UPDATE articles SET url = ? WHERE id = ?').run(raw.url, ex.id);
// RSS由来の画像が新規側にだけあれば引き継ぐ
if (raw.imageUrl) {
db.prepare("UPDATE articles SET image_url = ?, image_via = 'rss' WHERE id = ? AND image_url = ''").run(raw.imageUrl, ex.id);
}
duplicateHandled = true;
} else if (!exWrapper && newWrapper) {
// 既存が直接URLで新規がラッパー: 直接URL側を残し、新規は取り込まない
duplicateHandled = true;
}
break;
}
if (duplicateHandled) continue;
db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at, image_url, image_via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(clusterId, versionId, source, title, raw.url, raw.summary || '', raw.publishedAt || null, nowIso, raw.imageUrl || '', raw.imageUrl ? 'rss' : '');
db.prepare('UPDATE clusters SET importance_score = ? WHERE id = ?').run(importanceFor(db, clusterId), clusterId);
const entry = clusterCache.get(clusterId);
if (entry) {
  entry.articleBgs.push(titleBg);
  for (const w of itemSummaryWords) entry.summaryWords.add(w);
  entry.lastSeenMs = Math.max(entry.lastSeenMs || 0, itemMs);
}
inserted++;
}
return { seen: items.length, inserted };
}

// ---------- フィード取得 ----------

async function fetchFeed(feed, fetchImpl = fetch) {
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
try {
const res = await fetchImpl(feed.url, { signal: ctrl.signal, headers: { 'user-agent': 'news-app/0.1 (+personal use)'}});
if (!res.ok) throw new Error(`HTTP ${res.status}`);
return parseRss(await res.text(), feed);
} finally {
clearTimeout(timer);
}
}

// 保持期間（prune）・閲覧集計・VACUUM は src/lifecycle.mjs に分離した
// （2026-11-15 決定: 保持は最終確認から7日、ブックマーク済みは免除）。

/** 全フィードを取得してDBに取り込む。失敗したフィードはスキップする。 */
export async function refresh(db, { fetchImpl = fetch, feeds = FEEDS} = {}) {
const started = new Date();
const run = db.prepare('INSERT INTO fetch_runs (started_at) VALUES (?)').run(started.toISOString());
let ok = 0, failed = 0;
// 全フィードのアイテムを集めてから一括で取り込む（取り込み側のクラスタ照合キャッシュ構築を
// フィードごとに繰り返すと、DBが育つほど遅くなるため）
const allItems = [];
const BATCH = 8;
for (let i = 0; i < feeds.length; i += BATCH) {
const results = await Promise.allSettled(feeds.slice(i, i + BATCH).map((f) => fetchFeed(f, fetchImpl)));
for (const r of results) {
if (r.status === 'fulfilled') {
ok++;
allItems.push(...r.value);
} else { failed++; console.error('feed failed:', r.reason?.message || r.reason); }
}
}
const { seen, inserted } = ingestArticles(db, allItems);
const { prunedClusters: pruned } = runLifecycle(db);
db.prepare('UPDATE fetch_runs SET finished_at =?, feeds_ok =?, feeds_failed =?, articles_seen =?, articles_new =?, pruned_clusters =? WHERE id =?')
.run(new Date().toISOString(), ok, failed, seen, inserted, pruned, Number(run.lastInsertRowid));
return { feedsOk: ok, feedsFailed: failed, seen, inserted, pruned};
}

// ---------- 社説検索 ----------

/** クラスタ見出しから検索用キーワード（最長の日本語チャンク等）を取り出す。 */
export function storyKeywords(title) {
const chunks = String(title).split(/[\s「」『』（）・、。，:：]/).filter((c) => c.length >= 2);
chunks.sort((a, b) => b.length - a.length);
return chunks.slice(0, 2).join(' ');
}

/**
* 5大紙の社説をGoogleニュースRSS検索で探す。結果は editorials にキャッシュ。
* 見つからない紙は found=0（UIで「確認できず」と表示）。捏造はしない。
*/
export async function fetchEditorials(db, clusterId, { fetchImpl = fetch, force = false } = {}) {
const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
if (!cluster) return null;
const cached = db.prepare('SELECT * FROM editorials WHERE cluster_id = ?').all(clusterId);
if (!force && cached.length >= PAPERS.length) {
// 社説ボーナス（D）が重要度に反映されるよう、キャッシュ済みでも再計算だけは行う
db.prepare('UPDATE clusters SET importance_score = ? WHERE id = ?').run(importanceFor(db, clusterId), clusterId);
return cached;
}
const terms = topicTerms(cluster.title);
const clusterTitles = db.prepare('SELECT title FROM articles WHERE cluster_id = ? LIMIT 80').all(clusterId).map((r) => r.title);
const nowIso = new Date().toISOString();
const results = [];
for (const paper of PAPERS) {
let found = null;
const queries = [terms.length ? `${paper}新聞 社説 ${terms.join(' ')}` : null, `${paper}新聞 社説`].filter(Boolean);
for (const query of queries) {
if (found) break;
const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`;
try {
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'user-agent': 'news-app/0.1 (+personal use)' } });
clearTimeout(timer);
if (!res.ok) continue;
const items = parseRss(await res.text(), {});
for (const it of items) {
if (normalizeSource(it.source) !== paper && !it.title.includes(paper)) continue;
if (!it.title.includes('社説')) continue;
// 関連判定（厳格化）: 汎用語を除いた特徴語をクラスタ見出し群と2つ以上共有しない社説は採用しない
if (!editorialRelated(it.title, clusterTitles)) continue;
found = it;
break;
}
} catch { /* 取得失敗時は「確認できず」扱い */ }
}
const row = {
paper, found: found ? 1 : 0,
title: found ? cleanTitle(found.title, found.source) : '',
summary: found ? found.summary : '',
url: found ? found.url : '',
};
db.prepare('INSERT INTO editorials (cluster_id, paper, found, title, summary, url, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cluster_id, paper) DO UPDATE SET found=excluded.found, title=excluded.title, summary=excluded.summary, url=excluded.url, checked_at=excluded.checked_at')
.run(clusterId, row.paper, row.found, row.title, row.summary, row.url, nowIso);
results.push(row);
}
// 社説ボーナス（D）が重要度に反映されるよう、取得後に再計算する
db.prepare('UPDATE clusters SET importance_score = ? WHERE id = ?').run(importanceFor(db, clusterId), clusterId);
return results;
}

// ---------- 背景社説チェック（2026-11-15 ユーザー承認） ----------
// refresh 完了後にサーバーが裏で呼ぶ。重要タブ上位クラスタの社説を先回りで確認し、
// 「社説」タブの中身と社説ボーナスの材料を増やす。refresh 自体はブロックしない。

/** 背景チェックの候補に含める重要度の下限（server.mjs / body.mjs の重要タブ閾値と合わせる）。 */
const EDITORIAL_BATCH_THRESHOLD = 45;
/** 再チェックの間隔: 社説はニュースの翌朝に出ることが多いため、丸1日空けたら拾い直す。 */
const EDITORIAL_RECHECK_MS = 24 * 3600000;
/** 再チェックの対象は発生から3日以内のクラスタまで（それより古い話題に社説はほぼ付かない）。 */
const EDITORIAL_RECHECK_WINDOW_MS = 3 * 24 * 3600000;

/**
 * 背景社説チェックの候補クラスタを優先順に返す。
 * 並びは重要タブと同じ考え方（時間減衰込みの順位）で上位 limit 件を母集団にし、
 * 未チェック（全紙分の行が無い）を先に、次に再チェック対象を並べる。
 * 再チェック対象: 全紙チェック済みで、最終チェックから24時間超、かつ first_seen から3日以内。
 * 戻り値: [{ id, force }]（force=true はキャッシュを無視して再検索する）。
 */
export function editorialCheckCandidates(db, { now = new Date(), limit = 50 } = {}) {
  const ranked = db.prepare(`
    SELECT c.id, c.first_seen_at,
      (c.importance_score + MIN(COALESCE(b.body_chars, 0) / 2000.0, 5))
        / POWER(MAX((julianday(?) - julianday(COALESCE(b.latest_published, c.last_seen_at))) * 24.0, 0) + 2, 1.2) AS rank_score
    FROM clusters c
    LEFT JOIN (
      SELECT cluster_id, MAX(published_at) AS latest_published,
             SUM(CASE WHEN body_text != '' THEN length(body_text) ELSE 0 END) AS body_chars
      FROM articles GROUP BY cluster_id
    ) b ON b.cluster_id = c.id
    WHERE c.importance_score >= ?
    ORDER BY rank_score DESC
    LIMIT ?`).all(now.toISOString(), EDITORIAL_BATCH_THRESHOLD, limit);
  const stateStmt = db.prepare('SELECT COUNT(*) AS rows, MAX(checked_at) AS last_checked FROM editorials WHERE cluster_id = ?');
  const nowMs = now.getTime();
  const out = [];
  for (const c of ranked) {
    const st = stateStmt.get(c.id);
    if (!st || st.rows < PAPERS.length) {
      out.push({ id: c.id, force: false, rank: out.length });
    } else if (
      st.last_checked &&
      nowMs - new Date(st.last_checked).getTime() > EDITORIAL_RECHECK_MS &&
      nowMs - new Date(c.first_seen_at).getTime() < EDITORIAL_RECHECK_WINDOW_MS
    ) {
      out.push({ id: c.id, force: true, rank: out.length });
    }
  }
  // 未チェックを先に（母集団内の順位は維持）、再チェックは後ろ
  return [
    ...out.filter((x) => !x.force),
    ...out.filter((x) => x.force),
  ].map(({ id, force }) => ({ id, force }));
}

/**
 * 背景社説チェック本体: 候補から最大 maxChecks 件を並列 parallel で確認する。
 * チェック完了時の重要度再計算は fetchEditorials 内の配線（社説ボーナス）が担う。
 * 戻り値: { candidates, checked }。
 */
export async function checkTopEditorials(db, { fetchImpl = fetch, now = new Date(), candidateLimit = 50, maxChecks = 20, parallel = 2 } = {}) {
  const candidates = editorialCheckCandidates(db, { now, limit: candidateLimit });
  const targets = candidates.slice(0, maxChecks);
  let i = 0;
  let checked = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, targets.length) }, async () => {
      while (i < targets.length) {
        const t = targets[i++];
        try {
          await fetchEditorials(db, t.id, { fetchImpl, force: t.force });
          checked++;
        } catch (e) {
          console.error('editorial batch failed for cluster', t.id, e);
        }
      }
    }),
  );
  return { candidates: candidates.length, checked };
}

/** 社説の関連判定で除外する汎用語（どの話題にも出てくる語）。 */
const GENERIC_TERMS = new Set(['政府', '首相', '日本', '対応', '方針', '検討', '表明', '開催', '実施', '発表', '問題', '議論', '国会', '与党', '野党', '社会', '経済', '政治', '東京', '全国', '今年', '来年', '年度', '支援', '制度', '改革', '安全', '確保', '強化', '必要', '重要', '課題', '影響', '懸念', '期待', '大臣', '知事', '市長', '会長', '社長', '関係', '当局', '現場', '会見', '記者', '説明', '批判', '主張', '明らか', '求める', '求めた', '示した', '述べた', '社説']);

/**
* テキストから「特徴語」を抽出する: カタカナ語（3字以上）、英字語（3字以上）、
* 漢字の2字窓（汎用語を除く）。社説候補とクラスタ見出しの関連判定に使う。
*/
export function featureTerms(text) {
const terms = new Set();
const t = String(text || '');
for (const m of t.matchAll(/[ァ-ヶー]{3,}/g)) terms.add(m[0]);
for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)) terms.add(m[0]);
for (const m of t.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
const s = m[0];
for (let i = 0; i + 2 <= s.length; i++) terms.add(s.slice(i, i + 2));
if (s.length >= 3) terms.add(s.slice(0, 3));
}
for (const g of GENERIC_TERMS) terms.delete(g);
return terms;
}

/** 社説候補の見出しがクラスタの見出し群と特徴語を2つ以上共有すれば「関連あり」とする。 */
export function editorialRelated(candidateTitle, clusterTitles) {
const cand = featureTerms(candidateTitle);
if (!cand.size) return false;
const clusterTerms = new Set();
for (const t of clusterTitles) for (const w of featureTerms(t)) clusterTerms.add(w);
return sharedCount(cand, clusterTerms) >= 2;
}

/** 見出しから社説検索用の短いトピック語（2〜6字）を抽出する。 */
export function topicTerms(title) {
const t = String(title).replace(/【[^】]*】/g, ' ').replace(/（[^）]*）/g, ' ');
const parts = t.split(/[\s、。，・「」『』:：／/]/).flatMap((c) => c.split(/[のをにはがとでへや]/)).map((c) => c.trim()).filter((c) => c.length >= 2 && c.length <= 6);
const stop = ['与野党', '神経戦', '立場', '隔たり', '首相', '動静', '動画', '写真'];
return parts.filter((c) => !stop.includes(c)).slice(0, 2);
}

export { openDb};
