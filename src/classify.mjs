// 分類・重要度: 媒体の重み、カテゴリ補正、重要度スコア（importanceFor）。
// src/collector.mjs から分割した（Issue #12）。
import { PAPERS, AGGREGATORS } from './rss.mjs';
import { normalizeForMatch } from './matching.mjs';

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
