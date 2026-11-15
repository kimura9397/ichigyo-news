// SQLite (node:sqlite) ヘルパー。スキーマ定義とDBオープンだけを担う。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  importance_score REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_id INTEGER NOT NULL REFERENCES clusters(id),
  version_no INTEGER NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(cluster_id, version_no)
);
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_id INTEGER NOT NULL REFERENCES clusters(id),
  version_id INTEGER NOT NULL REFERENCES versions(id),
  source TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  body_text TEXT NOT NULL DEFAULT '',
  body_fetched_at TEXT,
  resolved_url TEXT NOT NULL DEFAULT '',
  body_url TEXT NOT NULL DEFAULT '',
  body_via TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  image_via TEXT NOT NULL DEFAULT '',
  image_fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS editorials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_id INTEGER NOT NULL REFERENCES clusters(id),
  paper TEXT NOT NULL,
  found INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL,
  UNIQUE(cluster_id, paper)
);
CREATE TABLE IF NOT EXISTS fetch_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  feeds_ok INTEGER NOT NULL DEFAULT 0,
  feeds_failed INTEGER NOT NULL DEFAULT 0,
  articles_seen INTEGER NOT NULL DEFAULT 0,
  articles_new INTEGER NOT NULL DEFAULT 0,
  pruned_clusters INTEGER NOT NULL DEFAULT 0
);
-- ブックマーク（2026-11-15追加）: ブックマーク済みクラスタは保持期間の削除から免除される
CREATE TABLE IF NOT EXISTS bookmarks (
  cluster_id INTEGER PRIMARY KEY REFERENCES clusters(id),
  created_at TEXT NOT NULL
);
-- 閲覧ログ（生イベント）: 詳細を開いた記録。30日より古いものは read_daily へ集計して削除する
CREATE TABLE IF NOT EXISTS read_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_id INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  opened_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_read_events_opened ON read_events(opened_at);
-- 閲覧の日次集計（日付×カテゴリ×開封数）: 無期限保持
CREATE TABLE IF NOT EXISTS read_daily (
  date TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  opens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, category)
);
`;

/** 既存DBへの後方互換マイグレーション（カラムがなければ足す）。 */
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.exec('CREATE INDEX IF NOT EXISTS idx_articles_version ON articles(version_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_articles_cluster ON articles(cluster_id)');
  ensureColumn(db, 'articles', 'body_text', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'articles', 'body_fetched_at', 'TEXT');
  // GoogleニュースのラッパーURLから解決した実URLのキャッシュ
  ensureColumn(db, 'articles', 'resolved_url', "TEXT NOT NULL DEFAULT ''");
  // 本文を実際に取得したURLと経路（direct / resolved / yahoo）。出所の帰属表示に使う
  ensureColumn(db, 'articles', 'body_url', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'articles', 'body_via', "TEXT NOT NULL DEFAULT ''");
  // サムネイル画像のURL（画像自体は保存せず参照表示のみ）と取得元（rss / og）、og:image の取得試行時刻
  ensureColumn(db, 'articles', 'image_url', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'articles', 'image_via', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'articles', 'image_fetched_at', 'TEXT');
  ensureColumn(db, 'fetch_runs', 'pruned_clusters', 'INTEGER NOT NULL DEFAULT 0');
  return db;
}
