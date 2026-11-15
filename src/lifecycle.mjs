// データライフサイクル（2026-11-15 ユーザー決定）とブックマーク・閲覧集計。
// - ニュースの保持は一律「最終確認（last_seen_at）から7日」。ブックマーク済みは免除。
// - fetch_runs は直近30件のみ保持する。
// - 閲覧ログの生イベントは30日で read_daily（日次集計）へ畳んで削除し、集計は無期限保持する。
// - VACUUM は起動時には行わず、refresh 時の prune 後に空きページ率が高い場合だけ自動実行する
//   （手動実行は /api/maintenance から）。
// - 保存済み本文には行単位のノイズ除去フィルタを後がけする（本文ノイズ除去、2026-11-15）。
import { filterBodyLines } from './body.mjs';

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

/* ---------- 保存済み本文へのノイズ除去の後がけ ---------- */

/**
 * 保存済みの本文（articles.body_text）に、行単位のノイズ除去フィルタを後がけする。
 * フィルタで内容が変わった記事だけを更新する。更新した記事数を返す。
 */
export function refilterBodies(db) {
  const rows = db.prepare("SELECT id, body_text FROM articles WHERE body_text != ''").all();
  if (!rows.length) return 0;
  const update = db.prepare('UPDATE articles SET body_text = ? WHERE id = ?');
  let changed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows) {
      const cleaned = filterBodyLines(r.body_text);
      if (cleaned !== r.body_text) { update.run(cleaned, r.id); changed++; }
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  return changed;
}

/**
 * refresh 時に行うライフサイクル一式: 閲覧集計 → prune → fetch_runs 整理 → 本文の後がけ → 自動 VACUUM 判定。
 * 戻り値: { prunedClusters, foldedReads, refilteredBodies, vacuumed }
 */
export function runLifecycle(db, now = new Date()) {
  const foldedReads = foldOldReadEvents(db, now);
  const prunedClusters = pruneOldClusters(db, now);
  pruneFetchRuns(db);
  const refilteredBodies = refilterBodies(db);
  const vacuumed = vacuumIfNeeded(db);
  return { prunedClusters, foldedReads, refilteredBodies, vacuumed };
}
