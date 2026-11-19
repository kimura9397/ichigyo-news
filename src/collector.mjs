// 収集の統括モジュール: 記事の取り込み（ingestArticles）と収集の実行（refresh）。
// RSS取得・パースは src/rss.mjs、同一ニュース判定は src/matching.mjs、分類・重要度は
// src/classify.mjs、社説の収集・照合は src/editorials.mjs に分割した（Issue #12）。
// サーバー/UIから分離してあるので、後から cron 等で常時収集に拡張できる。
// 外部依存なし（fetch / 正規表現ベースのXMLパースのみ）。LLMは使わない。
import { openDb} from './db.mjs';
import { runLifecycle } from './lifecycle.mjs';
import { normalizeForSearch, buildArticleSearchText } from './normalize.mjs';
import { listKeywords } from './keywords.mjs';
import { FEEDS, isWrapperUrl, normalizeSource, extractSourceFromTitle, cleanTitle, fetchFeed, feedFailureMessage } from './rss.mjs';
import { bigrams, jaccard, matchScore, filterWeakBigrams, summaryWords, sharedCount, strongTerms, properTerms, stripBoilerplate, hasStoryAnchor, isNumericOnlyRevision, isNewFactFollowUp, CLUSTER_THRESHOLD, CLUSTER_WINDOW_MS } from './matching.mjs';
import { refineCategory, importanceFor } from './classify.mjs';

// ---------- DB取り込み ----------

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
    allStrong: strongTerms(stripBoilerplate(c.title)), allProper: properTerms(stripBoilerplate(c.title)),
  });
}
for (const a of db.prepare('SELECT cluster_id, title, summary FROM articles').all()) {
  const entry = clusterCache.get(a.cluster_id);
  if (!entry) continue;
  entry.articleBgs.push(filterWeakBigrams(bigrams(cleanTitle(a.title, ''))));
  for (const w of summaryWords(a.summary)) entry.summaryWords.add(w);
  // 強い語・固有名詞っぽい語の集合にも定型句（媒体サフィックス等）を持ち込まない。
  // 「47NEWS」の "NEWS" のような語が残ると、要約バルブの固有名詞共有が
  // 定型句だけで満たせてしまう（監査 2026-11-19）
  for (const w of strongTerms(stripBoilerplate(a.title))) entry.allStrong.add(w);
  for (const w of properTerms(stripBoilerplate(a.title))) entry.allProper.add(w);
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
const itemStrong = strongTerms(stripBoilerplate(title));
const itemProper = properTerms(stripBoilerplate(title));
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
let joinedCluster = false;
if (best && best.sim >= CLUSTER_THRESHOLD) {
const vRows = db.prepare('SELECT id, version_no, title FROM versions WHERE cluster_id = ? ORDER BY version_no').all(best.id);
const vTitles = vRows.map((r) => r.title);
const latest = vRows[vRows.length - 1];
const clusterTitle = clusterCache.get(best.id)?.title || '';
const articleTitles = articleTitlesStmt.all(best.id).map((r) => r.title);
if (isNewFactFollowUp(vTitles, title, { clusterTitle, articleTitles })) {
const info = db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, ?, ?, ?)').run(best.id, latest.version_no + 1, title, nowIso);
clusterId = best.id;
versionId = Number(info.lastInsertRowid);
joinedCluster = true;
} else {
// 新版を作らない記事は、タイトルが最も似た既存バージョンに入れる。ただし
// 振り分け先の版との matchScore > 0 を必須とする（2026-11-19 監査、Issue #53）。
// 従来は全て類似0でも最新版へ無条件に入れていたため、クラスタ照合の弱い一致で
// 紛れ込んだ記事が既存版の中に静かに混ざり続けていた（版へのダンプ）。
// どの版とも一致しない記事はクラスタ参加自体を取り消し、下の新規クラスタ
// 作成に落とす（設計原則: 迷ったら分ける。誤合体の削減を優先し、分割過多は許容）。
let target = null;
let bestScore = 0;
for (const v of vRows) {
const s = matchScore(titleBg, filterWeakBigrams(bigrams(v.title)));
if (s > bestScore) { bestScore = s; target = v; }
}
// 数値の改訂だけの記事は現在版（最新版）に取り込み、版の代表見出しを新しい方へ
// 更新する（古い速報値の見出しが版の顔として残り続けないようにする）。
// 判定は最新版の見出しに対して行い、錨が無い記事（別ニュースの紛れ込み）は
// 代表見出しを書き換えない。改訂は定義上、最新版と数値以外の文面をほぼ共有
// するため、この経路も最新版との matchScore > 0 を条件にする。
if (hasStoryAnchor(title, clusterTitle, vTitles, articleTitles) && isNumericOnlyRevision([latest.title], title)
&& matchScore(titleBg, filterWeakBigrams(bigrams(latest.title))) > 0) {
target = latest;
if (latest.title !== title) {
db.prepare('UPDATE versions SET title = ? WHERE id = ?').run(title, latest.id);
latest.title = title;
}
}
if (target) {
clusterId = best.id;
versionId = target.id;
joinedCluster = true;
}
}
if (joinedCluster) {
db.prepare('UPDATE clusters SET last_seen_at = ? WHERE id = ?').run(nowIso, clusterId);
}
}
if (!joinedCluster) {
const info = db.prepare('INSERT INTO clusters (title, title_norm, category, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(title, normalizeForSearch(title), refineCategory(title, raw.category || ''), raw.publishedAt || nowIso, nowIso);
clusterId = Number(info.lastInsertRowid);
const v = db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1, ?, ?)').run(clusterId, title, nowIso);
versionId = Number(v.lastInsertRowid);
clusterCache.set(clusterId, { title, titleBg, articleBgs: [], summaryWords: new Set(), lastSeenMs: now.getTime(), firstSeenMs: Date.parse(raw.publishedAt || nowIso) || now.getTime(), allStrong: new Set(itemStrong), allProper: new Set(itemProper) });
}
// 同一記事が「ラッパーURL」と「直接URL」の両方で届いた場合は直接URL側を残す
// （「元記事を読む」のリンクが媒体のページへ直接届くようにするため）。
// 同一媒体・同一版・見出しがほぼ同一のものを同一記事とみなす。
const sameVersionArticles = db.prepare('SELECT id, url, title, summary FROM articles WHERE version_id = ? AND source = ?').all(versionId, source);
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
if (duplicateHandled) {
// 要約の補完（Issue #22/#23）: 直接URL側のフィード（朝日・時事の公式RSS等）は
// 要約を持たないことがあり、同じ記事のGoogleニュース側には description が
// ある。重複として捨てる側が要約を持ち、残す側が空なら、捨てる側の要約を
// 残す側へ移す。要約はその記事自身のフィード由来の抜粋であり、他記事の
// 要約の流用ではない。検索用テキストも合わせて作り直す。
const incomingSummary = String(raw.summary || '').trim();
if (!String(ex.summary || '').trim() && incomingSummary) {
db.prepare('UPDATE articles SET summary = ?, search_text = ? WHERE id = ?')
.run(raw.summary, buildArticleSearchText(ex.title, raw.summary), ex.id);
ex.summary = raw.summary;
}
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

/**
 * 全フィードを取得してDBに取り込む。失敗したフィードはスキップし、失敗は
 * feedFailureMessage の文面でコンソールに残す。nextRunScheduled は「次の
 * 自動更新が予約されているか」（ポーリング有効か）で、ログで再取得を
 * 約束してよいかの出し分けに使う。
 */
export async function refresh(db, { fetchImpl = fetch, feeds = FEEDS, nextRunScheduled = false } = {}) {
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
} else { failed++; console.error(feedFailureMessage(batch[j], r.reason, { willRetry: nextRunScheduled })); }
});
}
const { seen, inserted } = ingestArticles(db, allItems);
const { prunedClusters: pruned } = runLifecycle(db);
db.prepare('UPDATE fetch_runs SET finished_at =?, feeds_ok =?, feeds_failed =?, articles_seen =?, articles_new =?, pruned_clusters =? WHERE id =?')
.run(new Date().toISOString(), ok, failed, seen, inserted, pruned, Number(run.lastInsertRowid));
return { feedsOk: ok, feedsFailed: failed, seen, inserted, pruned};
}

export { openDb};
