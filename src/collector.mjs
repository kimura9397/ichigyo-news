// 収集モジュール: RSS取得・パース、同一ニュースのクラスタリング、
// バージョン判定（Q4: 新事実を含む続報のみ版を上げる）、抽出サマリー。
// サーバー/UIから分離してあるので、後から cron 等で常時収集に拡張できる。
// 外部依存なし（fetch / 正規表現ベースのXMLパースのみ）。LLMは使わない。
import { openDb} from './db.mjs';
import { runLifecycle } from './lifecycle.mjs';
import { normalizeForSearch, buildArticleSearchText } from './normalize.mjs';
import { listKeywords } from './keywords.mjs';

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
// '発表' と '初' は除いてある: どちらの語も無関係な見出しに頻出し、「新しい事実」の
// 証拠としては弱すぎる（例: 別会社の情報漏えい記事が「発表」を含むだけで新事実扱いになる）。
const FACT_KEYWORDS = ['死者', '死亡', '逮捕', '起訴', '確定', '判明', '再開', '中止', '延期', '優勝', '成立', '可決', '否決', '辞任', '就任', '地震', '津波', '避難', '解除', '発令', '上昇', '下落', '最高', '最低'];
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
 * 数値トークンの「単位の型」を返す。数値は値ではなく型で比べるための正規化で、
 * 数値トークンでなければ null、単位のない数値は '' を返す（% と ％ は同一視する）。
 */
export function numericUnitType(token) {
const m = String(token).match(/^[0-9０-９]+(?:\.[0-9０-９]+)?\s*(.*)$/);
return m ? m[1].replace('％', '%') : null;
}

/** 見出しの数値部分を伏せた文字列（数値以外の文面の同一性を見るため）。 */
function maskNumbers(title) {
return String(title).replace(/[0-9０-９]+(?:\.[0-9０-９]+)?/g, '#');
}

/** 改訂の根拠にしない数値の型: 日付（日・月・年）と単位のない裸数値。 */
const NON_FACT_NUMERIC_TYPES = new Set(['', '日', '月', '年']);

/**
 * 候補見出しの新規性が「既存の版にある型の数値の値の変化」だけでできているか
 * （得票率 45.8% → 46.2% のような、同じ量の改訂）。版は「新しい事実が足された
 * とき」だけ作るという定義（2026-11-16 ユーザー決定）に合わせ、改訂は新しい
 * 事実に数えない。条件は次の全てを満たすこと:
 * - 単位のある数値（%、人、円、件など）で、値が変わり、型は既存の版にある
 *   ものが1つ以上ある（型ごと新しい数値は新しい事実として扱い、対象外）
 * - 事実キーワードの新規出現がない（あれば新しい事実）
 * - 数値を伏せて比べたとき、候補の文面の新規バイグラム比率が 0.5 未満である
 *   （数値以外に実質的な新情報がある場合は改訂とみなさない。例: 防衛費の
 *   「防衛省は70兆円台を要求」は、新しい主体の新しい主張を含むため対象外）
 * 日付と裸数値は改訂の根拠にも、改訂を妨げる根拠にもしない。日付はシリーズ
 * 見出しの日付欄のように話題自体でないことが多く、裸数値はスコアや日付の
 * 断片など何にでも現れて「同じ型」と言えてしまうため（実DBでの誤判定:
 * 日替わりコーナーの別日分同士、地方スポーツ面の別試合同士が、共有する
 * 定型文と裸数値だけで改訂と判定された）。
 */
export function isNumericOnlyRevision(existingTitles, newTitle) {
const existingTokens = new Set();
const existingTypes = new Set();
for (const et of existingTitles) for (const t of factTokens(et)) {
existingTokens.add(t);
const ty = numericUnitType(t);
if (ty !== null) existingTypes.add(ty);
}
let sawNumericChange = false;
for (const t of factTokens(newTitle)) {
if (existingTokens.has(t)) continue;
const ty = numericUnitType(t);
if (ty === null) return false;
if (NON_FACT_NUMERIC_TYPES.has(ty)) continue;
if (!existingTypes.has(ty)) return false;
sawNumericChange = true;
}
if (!sawNumericChange) return false;
const maskedExisting = new Set();
for (const et of existingTitles) for (const b of bigrams(maskNumbers(et))) maskedExisting.add(b);
const nb = bigrams(maskNumbers(newTitle));
if (!nb.size) return false;
let novel = 0;
for (const b of nb) if (!maskedExisting.has(b)) novel++;
return novel / nb.size < 0.5;
}

/** アンカー判定から外す汎用ユニット（どの話題にも出てくる語・数量の型・単位語・バズワード）。 */
const ANCHOR_GENERIC_UNITS = new Set(['可能性', '情報', 'ガバナンス']);
const ANCHOR_GENERIC_UNIT_RE = /^最大|^(メートル|キロ|センチ|ミリ|グラム|リットル)$/;
/**
 * ジャンル定型ユニット: 事件・事故・政治・芸能報道の「型」としてどの話にも出てくる語。
 * タイトル共有の集計では話題の同一性の根拠にしない（例: 別のひき逃げ事件同士が
 * 「死亡」「容疑」「逮捕」の共有だけで同一視されるのを防ぐ）。
 */
const ANCHOR_GENRE_UNITS = new Set(['死亡', '容疑', '逮捕', '殺人', '被害', '事故', '事件', '発生', '確認', '発見', '捜査', '起訴', '発表', '開催', '実施', '検討', '方針', '対応', '問題', '議論', '影響', '懸念', '期待', '重要', '課題', '安全', '確保', '強化', '支援', '制度', '改革', '関係', '当局', '現場', '説明', '批判', '主張', '政府', '首相', '社会', '経済', '政治', '全国', '年度', '大臣', '知事', '市長', '社長', '喜び', '報告', '祝福']);

function isAnchorGenreUnit(text) {
return ANCHOR_GENRE_UNITS.has(text) || /人(死亡|けが|負傷|搬送|重傷|軽傷)$/.test(text);
}

function anchorUnits(title) {
return topicUnits(title).filter((u) => !ANCHOR_GENERIC_UNITS.has(u.text) && !ANCHOR_GENERIC_UNIT_RE.test(u.text));
}

function anchorSharesAny(a, b) {
for (const w of a) if (b.has(w)) return true;
return false;
}

function anchorSharedCount(a, b) {
let n = 0;
for (const x of a) if (b.has(x)) n++;
return n;
}

/**
* 「同じ話の続報である」ことのアンカー判定（2026-11-16、バージョン誤判定対策）。
* 新規性だけでは版を作らないための裏付けで、社説の関連判定（editorialRelated）と
* 同じ考え方（ユニット単位で数え、裏付け＝複数の見出しに現れることを要求する）を
* バージョン判定向けに調整したもの。次のいずれかを満たせばアンカーありとする:
* - P0: バイグラムの包含が成立し、候補側の包含率も 0.3 以上ある（短い定型見出しへの
*   包含だけで通さない）。ベース側がごく短い見出し（バイグラム8以下）の場合は
*   候補側包含率を免除する（長い続報見出しでは構造的に低くなるため）
* - P0s: ごく短いベース見出し向け。共有バイグラム3以上＋ベース側包含率0.5以上
*   （matchScore の「共有4以上」フロアに届かない短さへの対応。例: 「大の里６連勝」）
* - P6: クラスタタイトルと完全一致するユニット（ジャンル定型・汎用を除く）が2つ以上ある
* - P7: 完全一致ユニットが1つあり、かつクラスタタイトルとバイグラムを4以上共有し
*   包含率が0.25以上ある（例: 「ヒ素含む古書」への「ヒ素を含む古書、全国で100点以上確認」）
* - P1: クラスタタイトルと強い語で一致するユニットに裏付け（後述）があり、どちらか一方が
*   もう一方の部分文字列（短い側が4字以上）になっている（例: 「空中回収」⊂「宇宙船空中回収」。
*   最長共通部分文字列での判定は「流通経済大学」vs「流通経済大柏」のような接頭辞だけが
*   同じ別エンティティや「ファイナル」のような汎用語でも通ってしまうため採用しない）
* - P5: 6字以上の複合語ユニットが、クラスタタイトル＋v1 の2つ以上のユニットに
*   またがって窓を3つ以上共有する（例: 「議員定数削減」が「衆院議員定数」と「削減法案」に跨る）
* - P2: 強い語で一致する裏付けありユニットが2つ以上あり、うち1つ以上がクラスタタイトルとも一致
* - P3: クラスタタイトルと一致する裏付けありユニット（ジャンル定型を除く）が2つ以上あり、
*   語彙全体と一致するユニットが3つ以上ある
* - P4: P3 の語彙条件が2つでも、その2つが同一タイトルユニットの異なる部分を
*   合計5字以上カバーし、うち1つが強い語で一致すれば通す
* 裏付け（support）は記事タイトル側で数える。同一見出しを複数媒体が報じている場合は
* それぞれ独立した裏付けとして数える（記事タイトルの多重集合で数えるのはそのため）。
* versionTitles は版タイトル（[0] が v1）、articleTitles はクラスタ所属記事のタイトル。
*/
export function hasStoryAnchor(newTitle, clusterTitle, versionTitles = [], articleTitles = []) {
const candUnits = anchorUnits(newTitle);
const baseAll = [...new Set([clusterTitle, ...versionTitles, ...articleTitles].filter(Boolean))];
if (!candUnits.length || !baseAll.length) return false;
const nb = filterWeakBigrams(bigrams(newTitle));
for (const t of baseAll) {
const tb = filterWeakBigrams(bigrams(t));
if (tb.size > 0 && tb.size <= 8) {
let inter = 0;
for (const x of nb) if (tb.has(x)) inter++;
if (inter >= 3 && inter / tb.size >= 0.5) return true; // P0s
}
if (matchScore(nb, tb) > 0) {
let inter = 0;
for (const x of nb) if (tb.has(x)) inter++;
if (nb.size && (inter / nb.size >= 0.3 || tb.size <= 8)) return true; // P0
}
}
const titleUnits = anchorUnits(clusterTitle);
{ // P6 / P7: クラスタタイトルとの完全一致ユニット
const titleTexts = new Set(titleUnits.map((v) => v.text));
let exact = 0;
for (const u of candUnits) if (!isAnchorGenreUnit(u.text) && titleTexts.has(u.text)) exact++;
if (exact >= 2) return true; // P6
if (exact >= 1) {
const tb = filterWeakBigrams(bigrams(clusterTitle));
let inter = 0;
for (const x of nb) if (tb.has(x)) inter++;
if (tb.size && inter >= 4 && inter / tb.size >= 0.25) return true; // P7
}
}
const coreUnits = [...titleUnits, ...anchorUnits(versionTitles[0] || '')];
const supportTitles = [...articleTitles];
if (clusterTitle && !articleTitles.includes(clusterTitle)) supportTitles.push(clusterTitle);
const supportUnitsList = supportTitles.map((t) => anchorUnits(t));
const baseUnitsList = baseAll.map((t) => anchorUnits(t));
let strongBacked = 0;
let strongTitleShared = 0;
let topicTitleShared = 0;
let topicVocabShared = 0;
const backedUnits = [];
for (const u of candUnits) {
const strongTitle = titleUnits.some((v) => anchorSharesAny(u.strong, v.strong));
const anyTitle = strongTitle || titleUnits.some((v) => {
const s = anchorSharedCount(u.weak, v.weak);
return s >= 2 || (u.weak.size > 0 && s === u.weak.size)
|| (v.text.length >= 2 && u.text.includes(v.text)) || (u.text.length >= 2 && v.text.includes(u.text));
});
let support = 0;
let strongBase = false;
let anyBase = false;
for (const bus of supportUnitsList) {
const s = bus.some((v) => anchorSharesAny(u.strong, v.strong));
const a = s || bus.some((v) => anchorSharesAny(u.weak, v.weak));
if (a) { support++; if (s) strongBase = true; }
}
for (const bus of baseUnitsList) {
const s = bus.some((v) => anchorSharesAny(u.strong, v.strong));
const a = s || bus.some((v) => anchorSharesAny(u.weak, v.weak));
if (a) anyBase = true;
}
// 裏付けは原則2件以上。ただし裏付けプール自体が2件以下しかない若いクラスタでは
// 2件を要求すると構造的に永遠に裏付けが成立しないため、プールが小さい場合は1件で足りる
const backed = support >= 2 || (supportTitles.length <= 2 && support >= 1);
if (backed) {
backedUnits.push(u);
if (strongTitle && titleUnits.some((v) => anchorSharesAny(u.strong, v.strong)
&& ((u.text.length >= 4 && v.text.length > u.text.length && v.text.includes(u.text))
|| (v.text.length >= 4 && u.text.length > v.text.length && u.text.includes(v.text))))) return true; // P1
if (u.text.length >= 6) { // P5
const hitUnits = new Set();
let windows = 0;
let strongWindows = 0;
for (const v of coreUnits) {
const ws = anchorSharedCount(u.strong, v.strong);
const w = ws + anchorSharedCount(u.weak, v.weak);
if (w > 0) { hitUnits.add(v.text); windows += w; strongWindows += ws; }
}
if (hitUnits.size >= 2 && windows >= 3 && strongWindows >= 1) return true;
}
}
if (strongBase && backed) strongBacked++;
if (strongTitle) strongTitleShared++;
if (anyTitle && backed && !isAnchorGenreUnit(u.text)) topicTitleShared++;
if (anyTitle || anyBase) topicVocabShared++;
}
if (strongBacked >= 2 && strongTitleShared >= 1) return true; // P2
if (topicTitleShared >= 2 && topicVocabShared >= 3) return true; // P3
if (topicTitleShared >= 2 && topicVocabShared >= 2) { // P4
for (const v of titleUnits) {
const union = new Array(v.text.length).fill(false);
let unitCount = 0;
let anyStrong = false;
for (const u of backedUnits) {
const cov = matchedCoverage(u, v);
if (!cov.some(Boolean)) continue;
unitCount++;
if (anchorSharesAny(u.strong, v.strong)) anyStrong = true;
cov.forEach((c, i) => { if (c) union[i] = true; });
}
if (unitCount >= 2 && anyStrong && union.filter(Boolean).length >= 5) return true;
}
}
return false;
}

/**
* バージョン判定（ヒューリスティクス）。
* 既存バージョン群のタイトルと比べ、
* - アンカー（同じ話の続報であることの裏付け、hasStoryAnchor）があること
* - 新規バイグラム比率が高い AND（新規の事実トークンがある OR 新規比率が非常に高い）
* を満たす場合のみ「新事実を含む続報」として新バージョンにする。
* ただし新規性が数値の改訂だけでできている場合（isNumericOnlyRevision）は、
* 比率が高くても版を作らない（版作成の厳格化、2026-11-16）。
* 旧判定は新規性しか見ていなかったため、クラスタに紛れ込んだ別ニュースの記事が
* 「版タイトル群とほぼ重ならない＝新規性が高い」という理由でほぼ必ず新バージョンに
* なっていた（2026-11-16 ユーザー報告の誤判定）。anchor を渡さない呼び出しでは
* 従来どおり新規性だけで判定する（後方互換）。
*/
export function isNewFactFollowUp(existingTitles, newTitle, anchor = null) {
const nb = bigrams(newTitle);
if (!nb.size) return false;
if (anchor && !hasStoryAnchor(newTitle, anchor.clusterTitle || '', existingTitles, anchor.articleTitles || [])) return false;
const allExisting = new Set();
for (const t of existingTitles) for (const b of bigrams(t)) allExisting.add(b);
const newFacts = new Set([...factTokens(newTitle)].filter((t) => ![...existingTitles].some((et) => factTokens(et).has(t))));
let novel = 0;
for (const b of nb) if (!allExisting.has(b)) novel++;
const novelRatio = novel / nb.size;
if (isNumericOnlyRevision(existingTitles, newTitle)) return false;
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
/** 外交・国際会議の明確な語。文化・エンタメ等に誤って届いた場合の補正にだけ使う。 */
export const DIPLOMACY_KEYWORDS = [
'首脳会議', 'サミット', '外相会談', '外相会議', '国連総会', '国連安保理', 'ASEAN', 'アセアン', 'APEC', 'G7', 'G20', 'Ｇ７', 'Ｇ２０',
];
/** 「スポーツ」が複合語の一部でしかない見出し（競技そのものではない）。 */
const SPORTS_COMPOUND_RE = /スポーツカー|スポーツバイク|スポーツセダン|スポーツモデル/;
const COMMERCE_RE = /値引き|相場|新車|中古車|販売|価格|受注|発売/;

export function refineCategory(title, category) {
const t = String(title || '');
for (const kw of SPORTS_KEYWORDS) if (t.includes(kw)) return 'スポーツ';
let cat = category || '';
// 「スポーツ」分類でも、見出しの証拠がスポーツカー等の複合語だけなら競技ニュースではない
if (cat === 'スポーツ' && SPORTS_COMPOUND_RE.test(t)) {
return COMMERCE_RE.test(t) ? '経済' : '';
}
// 外交の明確な語があるのに文化・エンタメ/空欄で届いたら国際に補正する（政治・経済等の妥当な分類は触らない）
if ((cat === '文化・エンタメ' || cat === '') && DIPLOMACY_KEYWORDS.some((kw) => t.includes(kw))) {
return '国際';
}
return cat;
}

/** 配信記事の署名: クラスタリングと同じ正規化をかけたタイトル。タイトルが空なら要約冒頭で代用する。 */
export function articleSignature(article) {
const base = String(article.title || '').trim() || String(article.summary || '').slice(0, 60);
return normalizeForMatch(base);
}

/**
* 重要度スコア v3（2026-11-15 ユーザー定義による再設計）。
* 定義: 重要度とは「直近24時間で、新聞の1面・2面に載る水準の話か」。
* そのため材料は直近24時間の活動だけで計算し、それ以前の蓄積では膨らませない
* （v2 は全期間の記事・版を数えたため、数日かけて育っただけの話題が上位に居座った。
*  例: 車いすマラソンが重要度3位になるのはおかしい、というユーザー指摘）。
* - 対象記事: 公開時刻（無ければ取得時刻）が直近24時間以内の記事だけ。
*   窓内に記事が1件も無ければスコアは 0（重要タブには出ない）。
* - バージョン成分: 直近24時間に作られた版の数で数える min(版数, 5) × 2。
* - 主要媒体成分・広がり成分・グループ数成分・カテゴリ減衰（×0.7）は v2 のまま、
*   ただし窓内の記事だけで計算する。
* - 新しさボーナス（v2 の +5/+2）と一覧側の時間減衰（HN式）は廃止する。
*   24時間窓そのものが新しさの条件であり、二重に効かせないため。
* - D: 社説ボーナスは維持する（found 1媒体 +6、上限 +18）。社説は翌朝に出ることが
*   多いが、窓内の活動がある話にだけボーナスが効く形にした（窓内に記事が無ければ
*   社説があっても 0）。翌朝の社説時点で続報・反応記事が出ているのが通常で、
*   その場合は窓内の活動として数えられる。完全に続報の無い話＋24時間超の社説だけが
*   落ちるが、それは「24時間で測る」という定義どおりの割り切りとする。
*/
export function importanceFor(db, clusterId, now = new Date()) {
const cluster = db.prepare('SELECT category FROM clusters WHERE id = ?').get(clusterId);
const windowStart = new Date(now.getTime() - 24 * 3600000).toISOString();
const articles = db.prepare(`
SELECT source, title, summary FROM articles
WHERE cluster_id = ? AND julianday(COALESCE(published_at, fetched_at)) >= julianday(?)`).all(clusterId, windowStart);
if (articles.length === 0) return 0;
const versionCount = db.prepare(`
SELECT COUNT(*) AS c FROM versions
WHERE cluster_id = ? AND julianday(created_at) >= julianday(?)`).get(clusterId, windowStart).c;
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
+ Math.min(versionCount, 5) * 2;
// A: カテゴリ減衰（弱め）。社説ボーナスは減衰の対象外なので、この後に加える
if (cluster && (cluster.category === 'スポーツ' || cluster.category === '文化・エンタメ')) {
score *= 0.7;
}
// D: 社説ボーナス（窓内の活動がある場合にのみここへ到達する）
const editorialCount = db.prepare('SELECT COUNT(*) AS c FROM editorials WHERE cluster_id = ? AND found = 1').get(clusterId).c;
score += Math.min(editorialCount * 6, 18);
return score;
}

/** 「記事でないアイテム」のタイトルパターン（サイト説明文・案内ページ等）。 */
const GARBAGE_TITLE_PATTERNS = [
  /が運営する(ニュース)?サイト/, // 例: 「時事ドットコム：時事通信社が運営するニュースサイト」
  /の公式(サイト|ホームページ)(です|へようこそ)/,
];

/**
* 記事でないアイテム（サイトの説明文・放送/配信の案内ページ・日付の異常なアイテム）を
* 取り込み段階で弾くための判定。実例: 時事ドットコムのサイト説明文（日付が数か月前）が
* ニュースクラスタの v1 になっていた、放送案内ページの見出しに「~!@」等のゴミが混入していた。
*/
export function isGarbageItem(item, now = new Date()) {
  const title = String(item?.title || '');
  if (GARBAGE_TITLE_PATTERNS.some((re) => re.test(title))) return true;
  // 記号のゴミ: 見出しに ASCII 記号が2つ以上混じるものは案内ページ等の抽出ミスとみなす
  // （「支持率30%」のように正当な見出しで1つだけ出る記号は許容する）
  const symbols = title.match(/[~!@#$%^*\\|<>]/g);
  if (symbols && symbols.length >= 2) return true;
  // 日付の異常: 公開が14日以上前、または3日以上先のアイテムはニュースとして扱わない
  if (item?.publishedAt) {
    const ms = Date.parse(item.publishedAt);
    if (Number.isFinite(ms)) {
      const nowMs = now.getTime();
      if (nowMs - ms > 14 * 24 * 3600000) return true;
      if (ms - nowMs > 3 * 24 * 3600000) return true;
    }
  }
  return false;
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
// 概要の語彙集合、出現時刻、強い語の集合を一度だけ計算する
const clusterCache = new Map(); // id -> { titleBg, articleBgs, summaryWords, lastSeenMs, firstSeenMs, allStrong, allProper }
for (const c of db.prepare('SELECT id, title, last_seen_at, first_seen_at FROM clusters').all()) {
  clusterCache.set(c.id, {
    title: c.title,
    titleBg: filterWeakBigrams(bigrams(c.title)), articleBgs: [], summaryWords: new Set(),
    lastSeenMs: Date.parse(c.last_seen_at) || 0, firstSeenMs: Date.parse(c.first_seen_at) || 0,
    allStrong: strongTerms(c.title), allProper: properTerms(c.title),
  });
}
for (const a of db.prepare('SELECT cluster_id, title, summary FROM articles').all()) {
  const entry = clusterCache.get(a.cluster_id);
  if (!entry) continue;
  entry.articleBgs.push(filterWeakBigrams(bigrams(cleanTitle(a.title, ''))));
  for (const w of summaryWords(a.summary)) entry.summaryWords.add(w);
  for (const w of strongTerms(a.title)) entry.allStrong.add(w);
  for (const w of properTerms(a.title)) entry.allProper.add(w);
}
const articleTitlesStmt = db.prepare('SELECT title FROM articles WHERE cluster_id = ?');
for (const raw of items) {
if (!raw.url || !raw.title) continue;
if (isGarbageItem(raw, now)) continue;
if (existsUrl.get(raw.url)) continue;
const source = normalizeSource(raw.source || extractSourceFromTitle(raw.title));
const title = cleanTitle(raw.title, source);
const titleBg = filterWeakBigrams(bigrams(title));
const itemSummaryWords = summaryWords(raw.summary);
const itemStrong = strongTerms(title);
const itemProper = properTerms(title);
const itemMs = Date.parse(raw.publishedAt || nowIso) || now.getTime();
let best = null;
for (const [cid, entry] of clusterCache) {
  // 照合対象は直近のクラスタに限る（古い出来事との誤合体と計算量を抑える）
  if (entry.lastSeenMs && Math.abs(itemMs - entry.lastSeenMs) > CLUSTER_WINDOW_MS) continue;
  // 時間窓は first_seen 起点でも制限する。last_seen 基準だけだと、記事を吸い込むたびに
  // 窓が延び続け、数日〜1週間にわたって無関係な記事を吸い込み続ける（連鎖統合の温床）。
  if (entry.firstSeenMs && itemMs - entry.firstSeenMs > CLUSTER_WINDOW_MS) continue;
  // 主判定: クラスタタイトルとの一致を基本とする。タイトルと合わない場合は、所属記事の
  // 複数と強く一致する場合（裏付けがある場合）に限って同一視する。「いずれか1記事との
  // 最大類似」だけで判定すると、大きなクラスタほど1件の偶然の類似で別ニュースを吸い込み、
  // 吸い込んだ記事が次の吸収の足がかりになる（連鎖的過剰統合）。
  const simTitle = matchScore(titleBg, entry.titleBg);
  let bestArticleSim = 0;
  let articleHits = 0;
  for (const bg of entry.articleBgs) {
    const s = matchScore(titleBg, bg);
    if (s > bestArticleSim) bestArticleSim = s;
    if (s >= CLUSTER_THRESHOLD) articleHits++;
  }
  let maxSim = 0;
  if (simTitle >= CLUSTER_THRESHOLD) maxSim = Math.max(simTitle, bestArticleSim);
  else if (bestArticleSim >= 0.5 && articleHits >= 2) maxSim = bestArticleSim;
  if (maxSim === 0) {
    // 補助経路: 見出しの弱い類似＋概要の特徴語共有。テーマだけ似た別ニュース（例: 別の会社の
    // 情報漏えい）を拾わないよう、閾値を引き上げ、固有名詞っぽい強い語の共有を必須にする。
    let graded = jaccard(titleBg, entry.titleBg);
    for (const bg of entry.articleBgs) graded = Math.max(graded, jaccard(titleBg, bg));
    const strongShared = sharedCount(itemStrong, entry.allStrong);
    const properShared = sharedCount(itemProper, entry.allProper);
    if (graded >= 0.2 && sharedCount(itemSummaryWords, entry.summaryWords) >= 4 && (properShared >= 1 || strongShared >= 2)) {
      maxSim = CLUSTER_THRESHOLD;
    }
  }
  if (!best || maxSim > best.sim) best = { id: cid, sim: maxSim };
}
let clusterId, versionId;
if (best && best.sim >= CLUSTER_THRESHOLD) {
clusterId = best.id;
const vRows = db.prepare('SELECT id, version_no, title FROM versions WHERE cluster_id = ? ORDER BY version_no').all(clusterId);
const vTitles = vRows.map((r) => r.title);
const latest = vRows[vRows.length - 1];
const clusterTitle = clusterCache.get(clusterId)?.title || '';
const articleTitles = articleTitlesStmt.all(clusterId).map((r) => r.title);
if (isNewFactFollowUp(vTitles, title, { clusterTitle, articleTitles })) {
const info = db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, ?, ?, ?)').run(clusterId, latest.version_no + 1, title, nowIso);
versionId = Number(info.lastInsertRowid);
} else {
// 新版を作らない記事は、タイトルが最も似た既存バージョンに入れる。従来は無条件に
// 最新版へ入れていたため、誤って作られた最新版に正当な記事が積み上がり、その版が
// 実在の続報のように見える状態を招いていた。全て類似0なら従来どおり最新版に入れる。
let target = latest;
let bestScore = 0;
for (const v of vRows) {
const s = matchScore(titleBg, filterWeakBigrams(bigrams(v.title)));
if (s > bestScore) { bestScore = s; target = v; }
}
// 数値の改訂だけの記事は現在版（最新版）に取り込み、版の代表見出しを新しい方へ
// 更新する（古い速報値の見出しが版の顔として残り続けないようにする）。
// 判定は最新版の見出しに対して行い、錨が無い記事（別ニュースの紛れ込み）は
// 代表見出しを書き換えない。
if (hasStoryAnchor(title, clusterTitle, vTitles, articleTitles) && isNumericOnlyRevision([latest.title], title)) {
target = latest;
if (latest.title !== title) {
db.prepare('UPDATE versions SET title = ? WHERE id = ?').run(title, latest.id);
latest.title = title;
}
}
versionId = target.id;
}
db.prepare('UPDATE clusters SET last_seen_at = ? WHERE id = ?').run(nowIso, clusterId);
} else {
const info = db.prepare('INSERT INTO clusters (title, title_norm, category, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(title, normalizeForSearch(title), refineCategory(title, raw.category || ''), raw.publishedAt || nowIso, nowIso);
clusterId = Number(info.lastInsertRowid);
const v = db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1, ?, ?)').run(clusterId, title, nowIso);
versionId = Number(v.lastInsertRowid);
clusterCache.set(clusterId, { title, titleBg, articleBgs: [], summaryWords: new Set(), lastSeenMs: now.getTime(), firstSeenMs: Date.parse(raw.publishedAt || nowIso) || now.getTime(), allStrong: new Set(itemStrong), allProper: new Set(itemProper) });
}
// 同一記事が「ラッパーURL」と「直接URL」の両方で届いた場合は直接URL側を残す
// （「元記事を読む」のリンクが媒体のページへ直接届くようにするため）。
// 同一媒体・同一版・見出しがほぼ同一のものを同一記事とみなす。
const sameVersionArticles = db.prepare('SELECT id, url, title FROM articles WHERE version_id = ? AND source = ?').all(versionId, source);
let duplicateHandled = false;
for (const ex of sameVersionArticles) {
if (matchScore(titleBg, filterWeakBigrams(bigrams(ex.title))) < 0.8) continue;
const exWrapper = isWrapperUrl(ex.url);
const newWrapper = isWrapperUrl(raw.url);
if (exWrapper && !newWrapper) {
// 既存がラッパーで新規が直接URL: 既存行のURLを直接URLに差し替える
db.prepare('UPDATE articles SET url = ? WHERE id = ?').run(raw.url, ex.id);
duplicateHandled = true;
} else if (!exWrapper && newWrapper) {
// 既存が直接URLで新規がラッパー: 直接URL側を残し、新規は取り込まない
duplicateHandled = true;
}
break;
}
if (duplicateHandled) continue;
db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(clusterId, versionId, source, title, raw.url, raw.summary || '', raw.publishedAt || null, nowIso, buildArticleSearchText(title, raw.summary || ''));
db.prepare('UPDATE clusters SET importance_score = ? WHERE id = ?').run(importanceFor(db, clusterId), clusterId);
const entry = clusterCache.get(clusterId);
if (entry) {
  entry.articleBgs.push(titleBg);
  for (const w of itemSummaryWords) entry.summaryWords.add(w);
  for (const w of itemStrong) entry.allStrong.add(w);
  for (const w of itemProper) entry.allProper.add(w);
  entry.lastSeenMs = Math.max(entry.lastSeenMs || 0, itemMs);
}
inserted++;
}
return { seen: items.length, inserted };
}

// ---------- フィード取得 ----------

/**
 * RSS テキストを取得する（通常フィードと社説検索の共用）。
 * タイムアウトは応答本文の読み取りが終わるまで解除しない。ヘッダーだけ返して
 * 止まる応答でも待ち続けず、FETCH_TIMEOUT_MS で打ち切る。
 * （社説側は以前 fetch 直後にタイマーを解除しており、2回目のコンプライアンス
 * チェック 2026-11-16 の指摘でこの形に統一した。）
 */
async function fetchRssText(url, fetchImpl = fetch) {
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
try {
const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'user-agent': 'news-app/0.1 (+personal use)' } });
if (!res.ok) throw new Error(`HTTP ${res.status}`);
return await readResponseText(res);
} finally {
clearTimeout(timer);
}
}

async function fetchFeed(feed, fetchImpl = fetch) {
return parseRss(await fetchRssText(feed.url, fetchImpl), feed);
}

// 保持期間（prune）・閲覧集計・VACUUM は src/lifecycle.mjs に分離した
// （2026-11-15 決定: 保持は最終確認から7日、ブックマーク済みは免除）。

/** キーワード1件あたりの取り込み上限（キーワードフィードは検索結果なので新しい順にこの件数まで）。 */
export const KEYWORD_FEED_LIMIT = 30;

/** 登録キーワードの収集フィード（Google News キーワード検索RSS）。 */
export function keywordFeedFor(keyword) {
return {
name: `キーワード「${keyword}」`,
source: '',
category: '',
url: `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=ja&gl=JP&ceid=JP:ja`,
limit: KEYWORD_FEED_LIMIT,
};
}

/** 全フィードを取得してDBに取り込む。失敗したフィードはスキップする。 */
export async function refresh(db, { fetchImpl = fetch, feeds = FEEDS} = {}) {
const started = new Date();
const run = db.prepare('INSERT INTO fetch_runs (started_at) VALUES (?)').run(started.toISOString());
let ok = 0, failed = 0;
// 登録キーワードのフィードも通常フィードと一緒に取得する（キーワードは照合条件であると
// 同時に収集クエリでもある、2026-11-15 ユーザー決定）。キーワードフィードの失敗は
// 他フィードと同じくスキップ扱いで、更新全体は失敗させない。件数も fetch_runs に合算する。
const effectiveFeeds = [...feeds, ...listKeywords(db).map(keywordFeedFor)];
// 全フィードのアイテムを集めてから一括で取り込む（取り込み側のクラスタ照合キャッシュ構築を
// フィードごとに繰り返すと、DBが育つほど遅くなるため）
const allItems = [];
const BATCH = 8;
for (let i = 0; i < effectiveFeeds.length; i += BATCH) {
const batch = effectiveFeeds.slice(i, i + BATCH);
const results = await Promise.allSettled(batch.map((f) => fetchFeed(f, fetchImpl)));
results.forEach((r, j) => {
if (r.status === 'fulfilled') {
ok++;
const items = batch[j].limit ? r.value.slice(0, batch[j].limit) : r.value;
allItems.push(...items);
} else { failed++; console.error('feed failed:', r.reason?.message || r.reason); }
});
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
* now は checked_at と重要度再計算（importanceFor）の時間軸。呼び出し側の
* 時間軸と揃えるため、実時間で再計算して窓外れの 0 に潰さないよう貫通させる。
*/
export async function fetchEditorials(db, clusterId, { fetchImpl = fetch, force = false, now = new Date() } = {}) {
const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
if (!cluster) return null;
const cached = db.prepare('SELECT * FROM editorials WHERE cluster_id = ?').all(clusterId);
if (!force && cached.length >= PAPERS.length) {
// 社説ボーナス（D）が重要度に反映されるよう、キャッシュ済みでも再計算だけは行う
db.prepare('UPDATE clusters SET importance_score = ? WHERE id = ?').run(importanceFor(db, clusterId, now), clusterId);
return cached;
}
const terms = topicTerms(cluster.title);
const clusterTitles = db.prepare('SELECT title FROM articles WHERE cluster_id = ? LIMIT 10').all(clusterId).map((r) => r.title);
const nowIso = now.toISOString();
const results = [];
for (const paper of PAPERS) {
let found = null;
// topicTerms が取れない場合は検索自体をスキップする。素の「○○新聞 社説」検索は
// その紙の最新社説を無関係に拾ってしまうため廃止した（2026-11-15 誤マッチ対策）。
const queries = terms.length ? [`${paper}新聞 社説 ${terms.join(' ')}`] : [];
for (const query of queries) {
if (found) break;
const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`;
try {
const items = parseRss(await fetchRssText(url, fetchImpl), {});
for (const it of items) {
if (normalizeSource(it.source) !== paper && !it.title.includes(paper)) continue;
if (!it.title.includes('社説')) continue;
// 関連判定（厳格化）: クラスタタイトル＋代表見出しと強い語・話題語を十分に共有しない社説は採用しない
if (!editorialRelated(it.title, cluster.title, clusterTitles)) continue;
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
db.prepare('UPDATE clusters SET importance_score = ? WHERE id = ?').run(importanceFor(db, clusterId, now), clusterId);
return results;
}

// ---------- 背景社説チェック（2026-11-15 ユーザー承認） ----------
// refresh 完了後にサーバーが裏で呼ぶ。重要タブ上位クラスタの社説を先回りで確認し、
// 「社説」タブの中身と社説ボーナスの材料を増やす。refresh 自体はブロックしない。

/** 背景チェックの候補に含める重要度の下限（server.mjs の重要タブ閾値と合わせる）。 */
const EDITORIAL_BATCH_THRESHOLD = 40;
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
    SELECT c.id, c.first_seen_at, c.importance_score AS rank_score
    FROM clusters c
    WHERE c.importance_score >= ?
    ORDER BY rank_score DESC
    LIMIT ?`).all(EDITORIAL_BATCH_THRESHOLD, limit);
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
          await fetchEditorials(db, t.id, { fetchImpl, force: t.force, now });
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
* 「強い語」: カタカナ3字以上・英字3字以上・漢字3字以上の語。
* カタカナと漢字は3字のスライディングウィンドウで切り出す（例: 政治資金規正法 → 政治資・治資金・…）。
* 固有名詞や専門用語はこの長さになりやすく、話題の同一性を示す根拠になる。
* 社説候補とクラスタ見出しの関連判定に使う。
*/
export function strongTerms(text) {
const terms = new Set();
const t = String(text || '');
for (const m of t.matchAll(/[ァ-ヶー]{3,}/g)) {
const s = m[0];
for (let i = 0; i + 3 <= s.length; i++) terms.add(s.slice(i, i + 3));
}
for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)) terms.add(m[0]);
for (const m of t.matchAll(/[\u4e00-\u9fff]{3,}/g)) {
const s = m[0];
for (let i = 0; i + 3 <= s.length; i++) terms.add(s.slice(i, i + 3));
}
for (const g of GENERIC_TERMS) terms.delete(g);
return terms;
}

/**
* 「固有名詞っぽい強い語」: カタカナ3字以上（3字窓）と英字3字以上。
* 会社名・人名・製品名など、外来語や固有名詞はこの形になることが多い。
* テーマだけ似た別ニュースとの照合を避けるためのアンカーとして使う。
*/
export function properTerms(text) {
const terms = new Set();
const t = String(text || '');
for (const m of t.matchAll(/[ァ-ヶー]{3,}/g)) {
const s = m[0];
for (let i = 0; i + 3 <= s.length; i++) terms.add(s.slice(i, i + 3));
}
for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)) terms.add(m[0]);
return terms;
}

/**
* 「弱い語」: 漢字2字の複合語（2字窓）。「日銀」「利上げ」のように話題を示す語も多いが、
* 地名や「国際」等のありふれた語も混ざるため、単独では関連の根拠にしない。
*/
export function weakTerms(text) {
const terms = new Set();
const t = String(text || '');
for (const m of t.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
const s = m[0];
for (let i = 0; i + 2 <= s.length; i++) terms.add(s.slice(i, i + 2));
}
for (const g of GENERIC_TERMS) terms.delete(g);
return terms;
}

/**
* 関連判定に使う「語（ユニット）」: カタカナ・漢字・英字の連続。
* ひらがな・数字・記号が区切りになる（例: 「サイバー攻撃」は1ユニット、
* 「日銀の利上げ」は「日銀」「利上」の2ユニット）。
* 対象は3字以上の並びと漢字2字の複合語に限る。各ユニットは内部の表記ごとの
* ランから strongTerms / weakTerms で窓集合を持つ。
*/
export function topicUnits(text) {
const units = [];
for (const m of String(text || '').matchAll(/[ァ-ヶーA-Za-z\u4e00-\u9fff]+/g)) {
const s = m[0];
const kanjiOnly = /^[\u4e00-\u9fff]+$/.test(s);
if (s.length < 3 && !(kanjiOnly && s.length === 2)) continue;
const strong = strongTerms(s);
const weak = weakTerms(s);
if (strong.size || weak.size) units.push({ text: s, strong, weak });
}
return units;
}

function sharesAny(a, b) {
for (const w of a) if (b.has(w)) return true;
return false;
}

/** 2文字列の最長共通部分文字列の長さ（ユニット同士の重なりを見るためのもの）。 */
function longestCommonSubstringLen(a, b) {
let best = 0;
const dp = new Array(b.length + 1).fill(0);
for (let i = 1; i <= a.length; i++) {
let prev = 0;
for (let j = 1; j <= b.length; j++) {
const tmp = dp[j];
dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0;
if (dp[j] > best) best = dp[j];
prev = tmp;
}
}
return best;
}

/**
* 候補ユニット u の窓と一致した、タイトルユニット v の文字位置を返す。
* v 内部の表記ごとのランについて、強い窓（3字・英字はラン全体）と
* 弱い窓（漢字2字）の一致箇所をマークする。
*/
function matchedCoverage(u, v) {
const covered = new Array(v.text.length).fill(false);
const mark = (start, len) => { for (let i = start; i < start + len && i < covered.length; i++) covered[i] = true; };
for (const m of v.text.matchAll(/[ァ-ヶー]+|[A-Za-z]+|[\u4e00-\u9fff]+/g)) {
const run = m[0];
const base = m.index;
if (/^[A-Za-z]/.test(run)) {
if (run.length >= 3 && u.strong.has(run)) mark(base, run.length);
continue;
}
for (let i = 0; i + 3 <= run.length; i++) {
if (u.strong.has(run.slice(i, i + 3))) mark(base + i, 3);
}
if (/^[\u4e00-\u9fff]/.test(run)) {
for (let i = 0; i + 2 <= run.length; i++) {
if (u.weak.has(run.slice(i, i + 2))) mark(base + i, 2);
}
}
}
return covered;
}

/**
* 社説候補とクラスタの関連判定（2026-11-16 改訂）。
* 2026-11-15 の厳格化後も残った誤判定: 判定が3字のスライディングウィンドウを
* 「語」として数えていたため、複合語1つだけで採用条件を満たすことがあった
* （実例: 皇室の大阪訪問のニュースに、クラスタ内の1記事だけが脇で触れた
* 「サイバー攻撃」の社説が3紙とも紐づいた。「サイバー」の2窓が「強い語2つ」、
* 弱い語「攻撃」と合わせて両条件を通った。クラスタタイトルがその1記事の
* 見出しだと、タイトル側のアンカーも同じ1語で満たされてしまう）。
* 新判定では一致を「語（ユニット）」単位で数え、さらにクラスタ側の裏付けとして
* 頻度（その語がタイトルを含む複数の見出しに現れること）を要求する。
* 次のいずれかを満たす場合のみ「関連あり」とする:
* - 候補のユニットがクラスタタイトルと強い語で一致し、見出し3件以上に現れ、
*   なおかつタイトル側のユニットと5字以上の共通部分を持つか、候補ユニット自体が
*   より長いタイトル側のユニットの部分文字列で4字以上ある（政策名のような
*   固有名詞の共有。「政治資金」⊂「政治資金改革」、「消費減税」⊂「消費減税法案」など。
*   人名そのもの（「高市首相」⊂「高市首相」）は同一文字列なので対象外）
* - 強い語で一致するユニットが裏付けありで2つ以上あり、うち1つ以上が
*   クラスタタイトルとも強い語で一致する
* - クラスタタイトルと一致するユニットが裏付けありで2つ以上あり、語彙全体と
*   一致するユニットが3つ以上ある（「日銀」「利上げ」のような2字の話題語のみの正例）。
*   語彙全体との一致が2つでも、その2つが同一のタイトルユニットの異なる部分を
*   合計5字以上カバーし、うち1つが強い語で一致すれば通す
*   （「食品消費税」＋「減税」で「消費税減税法案」を覆う形。地名＋一般語のように
*   別々のタイトルユニットに散る一致は通さない）
* 裏付け（support）: そのユニットが現れた見出しの件数。クラスタタイトルは
* 見出しリストに含まれない場合に限り1件として数える。
*/
export function editorialRelated(candidateTitle, clusterTitle, headlines = []) {
const candUnits = topicUnits(candidateTitle);
if (!candUnits.length) return false;
const titleUnits = topicUnits(clusterTitle);
const headUnits = headlines.map((h) => topicUnits(h));
const titleCounted = headlines.includes(clusterTitle);
let strongAnchored = 0;
let strongTitleShared = 0;
let topicTitleShared = 0;
let topicVocabShared = 0;
const backedUnits = [];
for (const u of candUnits) {
const strongTitle = titleUnits.some((v) => sharesAny(u.strong, v.strong));
const anyTitle = strongTitle || titleUnits.some((v) => sharesAny(u.weak, v.weak));
let support = 0;
let strongHead = false;
let anyHead = false;
for (const hus of headUnits) {
const s = hus.some((v) => sharesAny(u.strong, v.strong));
const a = s || hus.some((v) => sharesAny(u.weak, v.weak));
if (a) { support++; anyHead = true; if (s) strongHead = true; }
}
if (anyTitle && !titleCounted) support++;
const backed = support >= 2;
if (backed) backedUnits.push(u);
if (strongTitle) {
strongTitleShared++;
// 固有名詞の共有: 見出し3件以上の裏付けがあり、タイトル側のユニットと
// 5字以上重なるか、候補ユニットがより長いタイトル側のユニットの
// 部分文字列で4字以上ある
if (support >= 3 && titleUnits.some((v) => sharesAny(u.strong, v.strong)
&& (longestCommonSubstringLen(u.text, v.text) >= 5
|| (u.text.length >= 4 && v.text.length > u.text.length && v.text.includes(u.text))))) return true;
}
if ((strongTitle || strongHead) && backed) strongAnchored++;
if (anyTitle && backed) topicTitleShared++;
if (anyTitle || anyHead) topicVocabShared++;
}
if (strongAnchored >= 2 && strongTitleShared >= 1) return true;
if (topicTitleShared >= 2 && topicVocabShared >= 3) return true;
// 語彙全体との一致が2つだけでも、その2つが同一タイトルユニットの
// 異なる部分を合計5字以上カバーしていれば、1つの固有名詞を分け合った
// 一致として通す（うち1つは強い語での一致が必要）
if (topicTitleShared >= 2 && topicVocabShared >= 2) {
for (const v of titleUnits) {
const union = new Array(v.text.length).fill(false);
let unitCount = 0;
let anyStrong = false;
for (const u of backedUnits) {
const cov = matchedCoverage(u, v);
if (!cov.some(Boolean)) continue;
unitCount++;
if (sharesAny(u.strong, v.strong)) anyStrong = true;
cov.forEach((c, i) => { if (c) union[i] = true; });
}
if (unitCount >= 2 && anyStrong && union.filter(Boolean).length >= 5) return true;
}
}
return false;
}

/** 見出しから社説検索用の短いトピック語（2〜6字）を抽出する。 */
export function topicTerms(title) {
const t = String(title).replace(/【[^】]*】/g, ' ').replace(/（[^）]*）/g, ' ');
const parts = t.split(/[\s、。，・「」『』:：／/]/).flatMap((c) => c.split(/[のをにはがとでへや]/)).map((c) => c.trim()).filter((c) => c.length >= 2 && c.length <= 6);
const stop = ['与野党', '神経戦', '立場', '隔たり', '首相', '動静', '動画', '写真'];
return parts.filter((c) => !stop.includes(c)).slice(0, 2);
}

export { openDb};
