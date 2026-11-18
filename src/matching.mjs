// 同一ニュース判定: バイグラム類似度、事実トークン、アンカー判定、バージョン判定と、
// 照合に使う語彙（強い語・固有名詞っぽい語・話題ユニット）。
// src/collector.mjs から分割した（Issue #12）。

// ---------- 類似度・新規性判定 ----------

export function normalizeForMatch(s) {
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

export function sharedCount(a, b) {
let n = 0;
for (const x of a) if (b.has(x)) n++;
return n;
}

export const CLUSTER_THRESHOLD = 0.20;
export const CLUSTER_WINDOW_MS = 3 * 24 * 3600000; // 照合対象は直近3日のクラスタに限る

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

export function sharesAny(a, b) {
for (const w of a) if (b.has(w)) return true;
return false;
}

/**
* 候補ユニット u の窓と一致した、タイトルユニット v の文字位置を返す。
* v 内部の表記ごとのランについて、強い窓（3字・英字はラン全体）と
* 弱い窓（漢字2字）の一致箇所をマークする。
*/
export function matchedCoverage(u, v) {
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
