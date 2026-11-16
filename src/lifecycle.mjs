// データライフサイクル（2026-11-15 ユーザー決定）とブックマーク・閲覧集計。
// - ニュースの保持は一律「最終確認（last_seen_at）から7日」。ブックマーク済みは免除。
// - fetch_runs は直近30件のみ保持する。
// - 閲覧ログの生イベントは30日で read_daily（日次集計）へ畳んで削除し、集計は無期限保持する。
// - VACUUM は起動時には行わず、refresh 時の prune 後に空きページ率が高い場合だけ自動実行する
//   （手動実行は /api/maintenance から）。
// - 保存済みの社説（found=1）は現在の関連判定で再評価し、通らないものは found=0 に降格する（社説の誤マッチ対策、2026-11-15）。
// - 本文機能の廃止（2026-11-16）に伴い、既存DBに残る本文・画像・記者名の保存データは
//   purgeBodyData で消去する（サーバー起動時と refresh のライフサイクルで実行、冪等）。
import { editorialRelated, importanceFor, bigrams, filterWeakBigrams, matchScore, jaccard, strongTerms, summaryWords, refineCategory, hasStoryAnchor } from './collector.mjs';
import { normalizeForSearch, buildArticleSearchText } from './normalize.mjs';

export const RETENTION_DAYS = 7;
export const FETCH_RUNS_KEPT = 30;
export const READ_EVENTS_KEPT_DAYS = 30;

/* ---------- ブックマーク ---------- */

export function addBookmark(db, clusterId, now = new Date()) {
  const cluster = db.prepare('SELECT id FROM clusters WHERE id = ?').get(clusterId);
  if (!cluster) return false;
  db.prepare('INSERT OR IGNORE INTO bookmarks (cluster_id, created_at) VALUES (?, ?)')
    .run(clusterId, now.toISOString());
  return true;
}

export function removeBookmark(db, clusterId) {
  db.prepare('DELETE FROM bookmarks WHERE cluster_id = ?').run(clusterId);
}

export function isBookmarked(db, clusterId) {
  return Boolean(db.prepare('SELECT cluster_id FROM bookmarks WHERE cluster_id = ?').get(clusterId));
}

/* ---------- 保持期間（prune） ---------- */

/**
 * 最終確認が保持期間（7日）より古いクラスタを、関連行（社説・記事・版）ごと削除する。
 * ブックマーク済みクラスタは免除する。削除したクラスタ数を返す。
 */
export function pruneOldClusters(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 3600000).toISOString();
  const rows = db.prepare(`SELECT c.id FROM clusters c
    WHERE c.last_seen_at < ?
    AND NOT EXISTS (SELECT 1 FROM bookmarks b WHERE b.cluster_id = c.id)`).all(cutoff);
  if (!rows.length) return 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const delEd = db.prepare('DELETE FROM editorials WHERE cluster_id = ?');
    const delAr = db.prepare('DELETE FROM articles WHERE cluster_id = ?');
    const delVe = db.prepare('DELETE FROM versions WHERE cluster_id = ?');
    const delCl = db.prepare('DELETE FROM clusters WHERE id = ?');
    for (const r of rows) { delEd.run(r.id); delAr.run(r.id); delVe.run(r.id); delCl.run(r.id); }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  return rows.length;
}

/** fetch_runs は直近30件だけ残す。削除した件数を返す。 */
export function pruneFetchRuns(db) {
  const info = db.prepare(`DELETE FROM fetch_runs
    WHERE id NOT IN (SELECT id FROM fetch_runs ORDER BY id DESC LIMIT ?)`).run(FETCH_RUNS_KEPT);
  return Number(info.changes);
}

/* ---------- 閲覧ログと日次集計 ---------- */

/** 詳細を開いた記録を1件入れる。クラスタが無ければ何もしない（false）。 */
export function recordRead(db, clusterId, now = new Date()) {
  const cluster = db.prepare('SELECT category FROM clusters WHERE id = ?').get(clusterId);
  if (!cluster) return false;
  db.prepare('INSERT INTO read_events (cluster_id, category, opened_at) VALUES (?, ?, ?)')
    .run(clusterId, cluster.category || '', now.toISOString());
  return true;
}

/**
 * 30日より古い生イベントを read_daily（日付×カテゴリ）へ集計してから削除する。
 * 畳んだイベントは二度と集計し直さない（削除と同一トランザクション）ため二重計上しない。
 * 畳んだ件数を返す。
 */
export function foldOldReadEvents(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - READ_EVENTS_KEPT_DAYS * 24 * 3600000).toISOString();
  const count = db.prepare('SELECT COUNT(*) AS c FROM read_events WHERE opened_at < ?').get(cutoff).c;
  if (!count) return 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO read_daily (date, category, opens)
      SELECT substr(opened_at, 1, 10) AS d, category, COUNT(*) FROM read_events
      WHERE opened_at < ? GROUP BY d, category
      ON CONFLICT(date, category) DO UPDATE SET opens = opens + excluded.opens`).run(cutoff);
    db.prepare('DELETE FROM read_events WHERE opened_at < ?').run(cutoff);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  return count;
}

/* ---------- VACUUM ---------- */

/** DBの空きページ率（freelist / 全ページ）。 */
export function freePageRatio(db) {
  const pageCount = db.prepare('PRAGMA page_count').get().page_count;
  if (!pageCount) return 0;
  const freelist = db.prepare('PRAGMA freelist_count').get().freelist_count;
  return freelist / pageCount;
}

/** 空きページが全体の25%を超える場合のみ VACUUM する。実行したら true。 */
export function vacuumIfNeeded(db) {
  if (freePageRatio(db) <= 0.25) return false;
  db.exec('VACUUM');
  return true;
}

/* ---------- 本文機能廃止に伴う保存データの消去（移行処理） ---------- */

/**
 * 本文機能の廃止（2026-11-16）前に保存された、記事ページ取得由来のデータを消す。
 * 対象は旧カラム群（body_text / body_fetched_at / author / resolved_url / body_url /
 * body_via / image_url / image_via / image_fetched_at / extract_text）。
 * 新規DBにはこれらのカラム自体が無いため、存在するカラムだけを対象にする。
 * search_text は本文も含めて作られていたため、消去後にタイトル＋要約だけで
 * 作り直す（refreshSearchText が差分を検出して更新する）。
 * サーバー起動時と refresh のライフサイクルで呼び、2回目以降は何も変えない（冪等）。
 * 中身を消した記事数を返す。
 */
const PURGED_COLUMNS = [
  ['body_text', "''"], ['body_fetched_at', 'NULL'], ['author', "''"],
  ['resolved_url', "''"], ['body_url', "''"], ['body_via', "''"],
  ['image_url', "''"], ['image_via', "''"], ['image_fetched_at', 'NULL'],
  ['extract_text', "''"],
];

export function purgeBodyData(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(articles)').all().map((c) => c.name));
  const targets = PURGED_COLUMNS.filter(([name]) => cols.has(name));
  if (!targets.length) return 0;
  const nonempty = targets
    .map(([name, empty]) => `${name} IS NOT ${empty === 'NULL' ? 'NULL' : empty}`)
    .join(' OR ');
  const count = db.prepare(`SELECT COUNT(*) AS c FROM articles WHERE ${nonempty}`).get().c;
  if (!count) return 0;
  const sets = targets.map(([name, empty]) => `${name} = ${empty}`).join(', ');
  db.prepare(`UPDATE articles SET ${sets} WHERE ${nonempty}`).run();
  refreshSearchText(db);
  return count;
}

/* ---------- 過剰統合クラスタの分離 ---------- */

/**
 * 過剰統合（連鎖的な合体）してしまったクラスタから、クラスタタイトルと無関係な版を
 * 別クラスタへ切り出す保守処理。分離の単位は「版」で、版の代表見出しが
 * - クラスタタイトルと matchScore 0（バイグラムの実質的な一致なし）
 * - 生 Jaccard も 0.05 未満
 * - 強い語を1つも共有しない
 * - その版の記事要約と v1 の記事要約の語彙共有が3未満
 * の全てを満たす場合に限って切り出す。要約の条件は、短い見出しや言い換えで
 * 見出し同士が一致しなくても、同じ出来事の続報（例: 障害の原因報道、逮捕の続報）を
 * 誤って切り出さないための安全弁。判定のアンカーはクラスタタイトル＋v1 に限り、
 * 吸い込まれた版同士の類似（チェーンの残り）は根拠にしない。
 * 切り出した版は新しいクラスタの v1 になる。社説は元のクラスタに残るが、同じ
 * ライフサイクル内の後段で再評価（reevaluateEditorials）が新しい帰属で判定し直す。
 * 版の中に混ざった記事単位の汚染までは分離できない（その限界は ISSUES.md に明記）。
 * 切り出した版の数を返す。
 */
export function splitOverMergedClusters(db) {
  const clusters = db.prepare('SELECT id, title, category FROM clusters').all();
  if (!clusters.length) return 0;
  const versionsStmt = db.prepare('SELECT id, title FROM versions WHERE cluster_id = ? AND version_no > 1 ORDER BY version_no');
  const v1Stmt = db.prepare('SELECT id FROM versions WHERE cluster_id = ? AND version_no = 1');
  const artsStmt = db.prepare('SELECT summary, published_at, fetched_at FROM articles WHERE version_id = ?');
  const insCluster = db.prepare('INSERT INTO clusters (title, title_norm, category, first_seen_at, last_seen_at, importance_score) VALUES (?, ?, ?, ?, ?, 0)');
  const moveVersion = db.prepare('UPDATE versions SET cluster_id = ?, version_no = 1 WHERE id = ?');
  const moveArticles = db.prepare('UPDATE articles SET cluster_id = ? WHERE version_id = ?');
  const updateScore = db.prepare('UPDATE clusters SET importance_score = ? WHERE id = ?');
  let split = 0;
  const affected = new Set();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const c of clusters) {
      const versions = versionsStmt.all(c.id);
      if (!versions.length) continue;
      const titleBg = filterWeakBigrams(bigrams(c.title));
      const titleStrong = strongTerms(c.title);
      const v1 = v1Stmt.get(c.id);
      const v1Words = new Set();
      if (v1) for (const a of artsStmt.all(v1.id)) for (const w of summaryWords(a.summary)) v1Words.add(w);
      for (const v of versions) {
        const vBg = filterWeakBigrams(bigrams(v.title));
        if (matchScore(vBg, titleBg) > 0) continue;
        if (jaccard(vBg, titleBg) >= 0.05) continue;
        let sharedStrong = 0;
        for (const t of strongTerms(v.title)) if (titleStrong.has(t)) sharedStrong++;
        if (sharedStrong > 0) continue;
        const arts = artsStmt.all(v.id);
        if (!arts.length) continue;
        const vWords = new Set();
        for (const a of arts) for (const w of summaryWords(a.summary)) vWords.add(w);
        let sharedWords = 0;
        for (const w of vWords) if (v1Words.has(w)) sharedWords++;
        if (sharedWords >= 3) continue;
        const stamps = arts.map((a) => a.published_at || a.fetched_at).filter(Boolean).sort();
        const fetched = arts.map((a) => a.fetched_at || a.published_at).filter(Boolean).sort();
        const nowIso = new Date().toISOString();
        const info = insCluster.run(v.title, normalizeForSearch(v.title), refineCategory(v.title, c.category || ''), stamps[0] || nowIso, fetched[fetched.length - 1] || nowIso);
        const newId = Number(info.lastInsertRowid);
        moveVersion.run(newId, v.id);
        moveArticles.run(newId, v.id);
        affected.add(c.id);
        affected.add(newId);
        split++;
      }
    }
    for (const id of affected) updateScore.run(importanceFor(db, id), id);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  return split;
}

/* ---------- 別ニュースの版の分離 ---------- */

/**
 * 既存ストーリーの「別バージョン（続報）」として誤って登録された別ニュースの版を、
 * 独立クラスタへ切り出す保守処理（2026-11-16、バージョン誤判定対策）。
 * splitOverMergedClusters はバイグラムの実質一致ゼロを条件とするため、タイトル同士が
 * 弱く似ている別ニュース（別の会社の情報漏えい、別のひき逃げ事件、定型の速報など）は
 * 拾えない。こちらは取り込み側と同じアンカー判定（hasStoryAnchor）で版ごとに
 * 「同じ話か」を判定し直す。
 * 進め方: 版を若い順に見て、正当と判断した版だけをアンカーのベースに加える。
 * 誤った版をベースに含めると誤り同士が裏付け合って残る（連鎖）ため、切り出した版や
 * 混在型の版のタイトルはベースに加えない。
 * 版の受け入れはタイトルアンカーだけで決める。要約の語彙共有は版レベルでは使わない
 * （和集合は汎用語で簡単に閾値を超えるため。経緯は関数内のコメント参照）。
 * 受け入れない版は、所属記事の半分以上がベースにアンカーを持つ「混在型」でない限り
 * 丸ごと別クラスタへ切り出す。記事単位の判定では要約の語彙共有（4以上）も安全弁に
 * 使うが、記事が1件だけの版では混在があり得ないためタイトルアンカーだけで決める。
 * 混在型（版タイトルは別ニュースだが記事の大半は元の話）は版単位では安全に切り分け
 * られないため残し、正当な記事だけをベースに加える。
 * 切り出した版の数を返す。
 */
export function splitForeignVersions(db) {
  const clusters = db.prepare('SELECT id, title, category FROM clusters').all();
  if (!clusters.length) return 0;
  const versionsStmt = db.prepare('SELECT id, version_no, title FROM versions WHERE cluster_id = ? ORDER BY version_no');
  const artsStmt = db.prepare('SELECT id, title, summary, published_at, fetched_at FROM articles WHERE version_id = ?');
  const insCluster = db.prepare('INSERT INTO clusters (title, title_norm, category, first_seen_at, last_seen_at, importance_score) VALUES (?, ?, ?, ?, ?, 0)');
  const moveVersion = db.prepare('UPDATE versions SET cluster_id = ?, version_no = 1 WHERE id = ?');
  const moveArticles = db.prepare('UPDATE articles SET cluster_id = ? WHERE version_id = ?');
  const updateScore = db.prepare('UPDATE clusters SET importance_score = ? WHERE id = ?');
  let split = 0;
  const affected = new Set();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const c of clusters) {
      const versions = versionsStmt.all(c.id);
      if (versions.length < 2) continue;
      const baseVersionTitles = [];
      const baseArticleTitles = [];
      const baseSummaryWords = new Set();
      const addSummaryWords = (arts) => { for (const a of arts) for (const w of summaryWords(a.summary)) baseSummaryWords.add(w); };
      const articleAnchored = (a, titleOnly = false) => {
        if (hasStoryAnchor(a.title, c.title, baseVersionTitles, baseArticleTitles)) return true;
        if (titleOnly) return false;
        let n = 0;
        for (const w of summaryWords(a.summary)) if (baseSummaryWords.has(w)) n++;
        return n >= 4;
      };
      let isFirst = true;
      for (const v of versions) {
        const arts = artsStmt.all(v.id);
        if (isFirst) {
          baseVersionTitles.push(v.title);
          for (const a of arts) baseArticleTitles.push(a.title);
          addSummaryWords(arts);
          isFirst = false;
          continue;
        }
        // 版の受理はタイトルアンカーだけで決める。要約の語彙共有は版レベルでは使わない:
        // 版内全記事の要約の和集合は、ベース側の語彙が大きいほど汎用語で簡単に閾値を
        // 超えてしまう（実例: 原爆民衆法廷の版が政治資金クラスタの要約語彙と13語を共有
        // していた）。要約バルブは記事単位の混在判定でのみ使う。
        const anchored = hasStoryAnchor(v.title, c.title, baseVersionTitles, baseArticleTitles);
        if (anchored) {
          baseVersionTitles.push(v.title);
          for (const a of arts) baseArticleTitles.push(a.title);
          addSummaryWords(arts);
          continue;
        }
        if (!arts.length) continue;
        // 記事が1件だけの版では「混在」はあり得ない。要約バルブ（通信社配信の長い要約は
        // 汎用語をベースと4語以上共有しがち）で残すと別ニュースがほぼ必ず残ってしまうため、
        // 単一記事版はタイトルアンカーだけで決める（実データでは要約バルブのみで残って
        // いた単一記事版14件が全て別ニュースだった）。
        const titleOnly = arts.length === 1;
        const anchoredArts = arts.filter((a) => articleAnchored(a, titleOnly));
        if (anchoredArts.length * 2 >= arts.length) {
          // 混在型: 残し、正当な記事だけをベースに加える（版タイトルは加えない）
          for (const a of anchoredArts) baseArticleTitles.push(a.title);
          addSummaryWords(anchoredArts);
          continue;
        }
        const stamps = arts.map((a) => a.published_at || a.fetched_at).filter(Boolean).sort();
        const fetched = arts.map((a) => a.fetched_at || a.published_at).filter(Boolean).sort();
        const nowIso = new Date().toISOString();
        const info = insCluster.run(v.title, normalizeForSearch(v.title), refineCategory(v.title, c.category || ''), stamps[0] || nowIso, fetched[fetched.length - 1] || nowIso);
        const newId = Number(info.lastInsertRowid);
        moveVersion.run(newId, v.id);
        moveArticles.run(newId, v.id);
        affected.add(c.id);
        affected.add(newId);
        split++;
      }
    }
    for (const id of affected) updateScore.run(importanceFor(db, id), id);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  return split;
}

/* ---------- 保存済み社説の再評価 ---------- */

/**
 * 保存済みの社説（found=1）を現在の関連判定（collector の editorialRelated）で再チェックし、
 * 通らないものを found=0 に降格する。関連判定を厳格化した際に、旧判定で採用された
 * 誤マッチを取り除くための後がけ処理（本文ノイズ除去の後がけと同じ位置づけ）。
 * 降格時は title/summary/url を空に戻して found=0 の通常表現に揃え、
 * 降格のあったクラスタは重要度（社説ボーナス）を再計算する。
 * checked_at は更新しない（再評価は再検索ではないため。背景チェックの再検索間隔に影響させない）。
 * 降格した行数を返す。
 */
export function reevaluateEditorials(db) {
  const rows = db.prepare('SELECT id, cluster_id, title FROM editorials WHERE found = 1').all();
  if (!rows.length) return 0;
  const clusterStmt = db.prepare('SELECT title FROM clusters WHERE id = ?');
  const titlesStmt = db.prepare('SELECT title FROM articles WHERE cluster_id = ? LIMIT 10');
  const demote = db.prepare("UPDATE editorials SET found = 0, title = '', summary = '', url = '' WHERE id = ?");
  const updateScore = db.prepare('UPDATE clusters SET importance_score = ? WHERE id = ?');
  let demoted = 0;
  const affected = new Set();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows) {
      const cluster = clusterStmt.get(r.cluster_id);
      if (!cluster) continue;
      const headlines = titlesStmt.all(r.cluster_id).map((x) => x.title);
      if (!editorialRelated(r.title, cluster.title, headlines)) {
        demote.run(r.id);
        demoted++;
        affected.add(r.cluster_id);
      }
    }
    for (const cid of affected) updateScore.run(importanceFor(db, cid), cid);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  return demoted;
}

/**
 * キーワード検索/ウォッチの照合用シャドウテキスト（articles.search_text / clusters.title_norm）を
 * 現在のタイトル・要約から再計算する。旧バージョンで作られた行を取りこぼさないよう、
 * 値が変わる行だけを更新する。更新した行数を返す。
 */
export function refreshSearchText(db) {
  let updated = 0;
  const updArticle = db.prepare('UPDATE articles SET search_text = ? WHERE id = ?');
  for (const a of db.prepare('SELECT id, title, summary, search_text FROM articles').all()) {
    const next = buildArticleSearchText(a.title, a.summary);
    if (next !== a.search_text) { updArticle.run(next, a.id); updated++; }
  }
  const updCluster = db.prepare('UPDATE clusters SET title_norm = ? WHERE id = ?');
  for (const c of db.prepare('SELECT id, title, title_norm FROM clusters').all()) {
    const next = normalizeForSearch(c.title);
    if (next !== c.title_norm) { updCluster.run(next, c.id); updated++; }
  }
  return updated;
}

/**
 * 全クラスタの重要度を現在時刻で再計算する。重要度は「直近24時間の活動」だけで
 * 決まる（importanceFor v3）ため、時間の経過だけでもスコアは変わる。新規取り込みの
 * 無かったクラスタも含めて揃えないと、古い高スコアが重要タブに居座ってしまう。
 * 値が変わったクラスタ数を返す。
 */
export function recomputeAllImportance(db, now = new Date()) {
  const update = db.prepare('UPDATE clusters SET importance_score = ? WHERE id = ?');
  // 再計算が要るのは「窓内に活動がある」か「前回のスコアが残っている」クラスタだけ。
  // どちらでもないクラスタは定義上スコア0のままで、毎回計算し直す必要はない。
  const windowStart = new Date(now.getTime() - 24 * 3600000).toISOString();
  const targets = db.prepare(`
    SELECT id, importance_score FROM clusters
    WHERE importance_score > 0
       OR id IN (SELECT cluster_id FROM articles WHERE julianday(COALESCE(published_at, fetched_at)) >= julianday(?))`).all(windowStart);
  let changed = 0;
  for (const c of targets) {
    const next = importanceFor(db, c.id, now);
    if (Math.abs(next - c.importance_score) > 0.001) {
      update.run(next, c.id);
      changed++;
    }
  }
  return changed;
}

/**
 * refresh 時に行うライフサイクル一式: 閲覧集計 → prune → fetch_runs 整理 →
 * 本文データの消去（移行） → 過剰統合の分離 → 社説の再評価 → 自動 VACUUM 判定。
 * 戻り値: { prunedClusters, foldedReads, purgedBodyData, splitClusters, splitForeignVersions, reevaluatedEditorials, vacuumed }
 */
export function runLifecycle(db, now = new Date()) {
  const foldedReads = foldOldReadEvents(db, now);
  const prunedClusters = pruneOldClusters(db, now);
  pruneFetchRuns(db);
  const purgedBodyData = purgeBodyData(db);
  const splitClusters = splitOverMergedClusters(db);
  const splitForeign = splitForeignVersions(db);
  const refreshedSearchText = refreshSearchText(db);
  const reevaluatedEditorials = reevaluateEditorials(db);
  const recomputedImportance = recomputeAllImportance(db, now);
  const vacuumed = vacuumIfNeeded(db);
  return { prunedClusters, foldedReads, purgedBodyData, splitClusters, splitForeignVersions: splitForeign, refreshedSearchText, reevaluatedEditorials, recomputedImportance, vacuumed };
}
