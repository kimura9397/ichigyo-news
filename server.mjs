// ニュースアプリ サーバー（Node標準のみ）。
// 起動: node server.mjs  （PORT / HOST / ACCESS_TOKEN / NEWS_DB_PATH 環境変数で変更可、既定 8787 / 127.0.0.1 / 無認証 / data/news.db）
// SEA（単一 exe）として実行した場合は、静的ファイルを埋め込み assets から返し、
// DB はユーザーデータ領域（ICHIGYO_DATA_DIR で上書き可）に置き、既定ブラウザを開く。
// 収集は「開いた時だけ」: データがあれば即返し、古ければ背後で更新する（stale-while-revalidate）。
// DBが空の初回だけ収集を待つ。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { extname, join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './src/db.mjs';
import { refresh } from './src/collector.mjs';
import { fetchEditorials, checkTopEditorials } from './src/editorials.mjs';
import { addBookmark, removeBookmark, isBookmarked, recordRead, foldOldReadEvents, pruneOldClusters, pruneFetchRuns, purgeBodyData, splitOverMergedClusters, splitForeignVersions, foldNumericOnlyVersions, reevaluateEditorials, refreshSearchText } from './src/lifecycle.mjs';
import { normalizeForSearch } from './src/normalize.mjs';
import { listKeywords, addKeyword as addKeywordToDb, removeKeyword as removeKeywordFromDb } from './src/keywords.mjs';
import { runningAsSea, readSeaAsset, defaultDataDir, openBrowser } from './src/sea.mjs';
import { APP_VERSION } from './src/version.mjs';
import { checkLatestRelease, LATEST_RELEASE_URL } from './src/update-check.mjs';

// SEA 実行時は import.meta.url が得られないため、その場合は cwd を基点にする
// （SEA では静的配信も DB パスも ROOT を使わないので、基点はダミーでよい）。
let ROOT;
try {
  ROOT = dirname(fileURLToPath(import.meta.url));
} catch {
  ROOT = process.cwd();
}
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);
// 既定はループバックのみ（2026-11-16 コンプライアンス対応 #1）。LAN 等の別端末から
// 開きたい場合だけ HOST=0.0.0.0 のように明示指定する。その場合は ACCESS_TOKEN が
// 必須で、未設定なら起動しない（2回目のチェック 2026-11-16 の指摘で強制化）。
const HOST = process.env.HOST || '127.0.0.1';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
// ループバックとして扱うのはリテラルな 127.0.0.1 / ::1 / localhost のみ
// （名前解決はしない。それ以外の HOST はすべて「外向け」として扱う）。
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
if (!LOOPBACK_HOSTS.has(HOST.replace(/^\[|\]$/g, '').toLowerCase()) && !ACCESS_TOKEN) {
  console.error(`ichigyo-news: HOST=${HOST} はループバック以外のため、ACCESS_TOKEN の設定が必須です。ACCESS_TOKEN を設定してから起動してください`);
  process.exit(1);
}
const AS_SEA = runningAsSea();
// DB の置き場所: NEWS_DB_PATH が最優先。SEA ではユーザーデータ領域、それ以外は従来の data/news.db
const DB_PATH = process.env.NEWS_DB_PATH
  || (AS_SEA ? join(defaultDataDir(), 'news.db') : join(ROOT, 'data', 'news.db'));
const db = openDb(DB_PATH);
// 本文機能の廃止（2026-11-16）前に保存された本文・画像等のデータを起動時に消去する
// （移行処理。2回目以降は何も変えない）。あわせて検索用シャドウテキスト
// （title_norm / search_text）を現在値へ揃える（旧バージョンで作られたDBや、
// 直接投入された行でも検索が効くように）。
purgeBodyData(db);
refreshSearchText(db);

function dbBytes() {
  try { return statSync(DB_PATH).size; } catch { return 0; }
}

const CATEGORIES = ['社会', '政治', '経済', '国際', 'スポーツ', '文化・エンタメ', '科学', 'その他'];
const IMPORTANT_THRESHOLD = 40; // 重要度スコアv3（直近24時間の活動のみ）の実DB分布で再設定（2026-11-15計測: 40以上が31クラスタ）

let refreshing = null;
/**
 * 収集を開始する。既に実行中なら新しい収集は開始せず、started: false で返す
 * （更新の連打対策、2026-11-16 ユーザー指示: 複数タブ・複数ウィンドウから
 * 同時に要求されても、収集は常に1本だけ走る状態にする。固定のクールダウンは
 * 設けず、ロックは実行中の間だけ）。
 */
function startRefresh() {
  if (refreshing) return { promise: refreshing, started: false };
  refreshing = refresh(db, { nextRunScheduled: pollState.enabled })
    .then((r) => { kickEditorialBatch(); return r; })
    .catch((e) => { console.error('refresh failed:', e); return null; })
    .finally(() => { refreshing = null; });
  return { promise: refreshing, started: true };
}

/** 収集の完了を待つ（実行中ならその収集に相乗りする）。背後更新（SWR）用。 */
function doRefresh() {
  return startRefresh().promise;
}

/* ---------- ポーリング（サーバー側スケジューリング、2026-11-17 ユーザー承認） ---------- */
// ポーリングのタイマーはサーバープロセス側で持つ。タブ側のタイマーだと、他の
// タブへ切り替えた際のタイマー絞りで間隔がずれたり、タブを閉じると収集が
// 止まってしまうため。状態は DB（app_settings）に保存し、サーバー再起動時に
// 復元する（有効だった場合はスケジュールも再開する、2026-11-17 永続化）。
// 本体が起動している間だけ回るので、「開いた時だけ取得・運用コスト0」の
// 原則は維持される。設定項目は増やさず、既存のトグル＋間隔（2/5/10分）の
// 裏側だけを移した。
const POLL_INTERVAL_MINUTES = [2, 5, 10];
const POLLING_SETTING_KEY = 'polling_state';
const pollState = { enabled: false, minutes: 5, nextAt: null };
let pollTimer = null;

function pollingStatus() {
  return { enabled: pollState.enabled, minutes: pollState.minutes, nextAt: pollState.nextAt };
}

function schedulePoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  pollState.nextAt = null;
  if (!pollState.enabled) return;
  const intervalMs = pollState.minutes * 60 * 1000;
  pollState.nextAt = Date.now() + intervalMs;
  pollTimer = setTimeout(() => {
    // 収集は単一飛行の startRefresh に相乗りする（実行中ならその回は見送る）
    startRefresh();
    schedulePoll();
  }, intervalMs);
  pollTimer.unref?.();
}

/** ポーリング状態を変更し、変更後の状態を返す。minutes が不正なら null。 */
function setPolling(enabled, minutes) {
  if (minutes !== undefined && !POLL_INTERVAL_MINUTES.includes(minutes)) return null;
  if (minutes !== undefined) pollState.minutes = minutes;
  if (enabled !== undefined) pollState.enabled = Boolean(enabled);
  savePolling();
  schedulePoll();
  return pollingStatus();
}

/** ポーリング状態を DB に保存する（再起動時に復元するため）。 */
function savePolling() {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(POLLING_SETTING_KEY, JSON.stringify({ enabled: pollState.enabled, minutes: pollState.minutes }));
}

/** 起動時にポーリング状態を DB から復元し、有効だった場合はスケジュールを再開する。 */
function restorePolling() {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(POLLING_SETTING_KEY);
    if (row) {
      const saved = JSON.parse(row.value);
      if (POLL_INTERVAL_MINUTES.includes(saved.minutes)) pollState.minutes = saved.minutes;
      pollState.enabled = Boolean(saved.enabled);
    }
  } catch { /* 保存値が読めなくても既定（OFF・5分）で起動する */ }
  schedulePoll();
}
restorePolling();

/* ---------- 更新通知（起動時に1回だけ確認、Issue #26） ---------- */
// GitHub Releases の latest を起動時に1回だけ確認し、現行バージョンより
// 新しい版がある場合だけ /api/status の update に載せる。ポーリングには
// 相乗りさせない。取得に失敗したら update は null のまま（何も知らせない）。
// 確認先はテスト用に環境変数で差し替えられる（通常は GitHub API のまま）。
const UPDATE_CHECK_URL = process.env.ICHIGYO_UPDATE_CHECK_URL || LATEST_RELEASE_URL;
let updateInfo = null;
void checkLatestRelease({ currentVersion: APP_VERSION, url: UPDATE_CHECK_URL })
  .then((info) => { updateInfo = info; });

// 背景社説チェック: refresh 完了後、重要タブ上位クラスタの社説を裏で確認する（refresh はブロックしない）
let editorialBatchRunning = false;
function kickEditorialBatch() {
  if (editorialBatchRunning) return;
  editorialBatchRunning = true;
  checkTopEditorials(db)
    .catch((e) => { console.error('editorial batch failed:', e); })
    .finally(() => { editorialBatchRunning = false; });
}

function lastFinishedRun() {
  return db.prepare('SELECT * FROM fetch_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get() || null;
}

function isStale() {
  const last = lastFinishedRun();
  return !last || Date.now() - new Date(last.finished_at).getTime() > 30 * 60 * 1000;
}

/** 既存データがある場合は待たずに背後で更新を開始する。{ kicked } を返す。 */
function kickRefreshIfStale() {
  if (!isStale()) return false;
  doRefresh();
  return true;
}

function hasData() {
  return db.prepare('SELECT COUNT(*) c FROM clusters').get().c > 0;
}

/* ---------- 一覧（バージョン行） ---------- */

/** LIKE の部分一致パターン（%, _, \ はエスケープして文字どおりに扱う）。 */
function likePattern(keyword) {
  return `%${keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function tabWhere(tab, category, muted = [], keywords = []) {
  const conds = [];
  const params = [];
  if (tab === 'important') {
    conds.push('c.importance_score >= ?'); params.push(IMPORTANT_THRESHOLD);
    // 重要タブは各ニュース（クラスタ）につき最新版の行だけを出す（2026-11-15 ユーザー承認）。
    // 新着タブは全バージョンを行表示する従来どおり。
    conds.push('v.version_no = (SELECT MAX(v2.version_no) FROM versions v2 WHERE v2.cluster_id = c.id)');
    // カテゴリのミュート（設定メニュー、2026-11-15 ユーザー決定）: 重要タブのときだけ除外する。
    // muted は DB上のカテゴリ値（「その他」は ''）の配列。行・total・カテゴリ別件数で同じ条件を使う。
    if (muted.length > 0) {
      conds.push(`c.category NOT IN (${muted.map(() => '?').join(', ')})`);
      params.push(...muted);
    }
  }
  if (tab === 'bookmarks') {
    // ブックマークタブも各クラスタにつき最新版の行だけを出す（並びはブックマーク日時順）
    conds.push('EXISTS (SELECT 1 FROM bookmarks b WHERE b.cluster_id = c.id)');
    conds.push('v.version_no = (SELECT MAX(v2.version_no) FROM versions v2 WHERE v2.cluster_id = c.id)');
  }
  if (tab === 'editorials') {
    // 社説タブ: 社説が1件以上確認できた（found=1）クラスタだけを、各クラスタ最新版の行で出す
    conds.push('EXISTS (SELECT 1 FROM editorials e WHERE e.cluster_id = c.id AND e.found = 1)');
    conds.push('v.version_no = (SELECT MAX(v2.version_no) FROM versions v2 WHERE v2.cluster_id = c.id)');
  }
  if (tab === 'watch') {
    // キーワードウォッチ/検索: 各クラスタ最新版の行だけを出す。
    // 一致は「クラスタのタイトル、またはそのクラスタの記事（全版）のタイトル/要約への
    // 部分一致」。照合は表記ゆれ正規化済みのシャドウカラム（clusters.title_norm /
    // articles.search_text）に対して行い、クエリ側も同じ正規化を通す（例: 「情報漏洩」で
    // 「情報漏えい」の記事がヒットする）。複数キーワードは OR。キーワードが無ければ一致なし（1 = 0）。
    // 重要度スコアには混ぜない（中立のランキング維持）。
    conds.push('v.version_no = (SELECT MAX(v2.version_no) FROM versions v2 WHERE v2.cluster_id = c.id)');
    const normalized = keywords.map((kw) => normalizeForSearch(kw)).filter((kw) => kw !== '');
    if (normalized.length > 0) {
      const perKeyword = normalized
        .map(() => `(c.title_norm LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM articles ak WHERE ak.cluster_id = c.id AND ak.search_text LIKE ? ESCAPE '\\'))`)
        .join(' OR ');
      conds.push(`(${perKeyword})`);
      for (const kw of normalized) {
        const pattern = likePattern(kw);
        params.push(pattern, pattern);
      }
    } else {
      conds.push('1 = 0');
    }
  }
  if (tab === 'new') { conds.push('v.created_at >= ?'); params.push(new Date(Date.now() - 24 * 3600000).toISOString()); }
  if (category && category !== 'すべて') {
    if (category === 'その他') conds.push("c.category = ''");
    else { conds.push('c.category = ?'); params.push(category); }
  }
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

function tabOrder(tab) {
  // 同一クラスタ内は常に version_no 降順（最新版が先）
  // 重要度スコア自体が「直近24時間の活動」だけで計算される（importanceFor v3）ため、
  // ここで時間減衰を掛けると二重適用になる。並びはスコアのみ。
  if (tab === 'important' || tab === 'editorials') return 'c.importance_score DESC, latest_published DESC, v.version_no DESC';
  if (tab === 'bookmarks') return '(SELECT b.created_at FROM bookmarks b WHERE b.cluster_id = c.id) DESC, v.version_no DESC';
  // 新着は発表時刻（その版の最新記事の published_at）順を主キーにする（2026-11-17
  // ユーザー承認）。検知時刻順だと、一括検知したバッチ内がフィード処理順になり
  // 発表時刻が前後して見えるため。発表時刻が無い版は検知時刻で並べる。
  if (tab === 'new') return 'COALESCE(latest_published, v.created_at) DESC, v.created_at DESC, v.version_no DESC';
  return 'c.last_seen_at DESC, v.version_no DESC';
}

const ROWS_SELECT = `
    SELECT v.id AS version_id, v.version_no, v.title AS version_title, v.created_at AS version_created_at,
           c.id AS cluster_id, c.title AS cluster_title, c.category, c.first_seen_at, c.last_seen_at, c.importance_score,
           EXISTS (SELECT 1 FROM bookmarks b WHERE b.cluster_id = c.id) AS bookmarked,
           EXISTS (SELECT 1 FROM read_events re WHERE re.cluster_id = c.id) AS read_flag,
           COUNT(a.id) AS article_count, COUNT(DISTINCT a.source) AS source_count,
           MAX(a.published_at) AS latest_published,
           GROUP_CONCAT(DISTINCT a.source) AS sources,
           (SELECT substr(a2.summary, 1, 120) FROM articles a2
             WHERE a2.version_id = v.id AND a2.summary != '' ORDER BY a2.published_at LIMIT 1) AS lead,
           (SELECT GROUP_CONCAT(e.paper) FROM (
              SELECT paper FROM editorials WHERE cluster_id = c.id AND found = 1
              ORDER BY CASE paper WHEN '朝日' THEN 1 WHEN '毎日' THEN 2 WHEN '読売' THEN 3 WHEN '産経' THEN 4 WHEN '日経' THEN 5 ELSE 6 END
            ) e) AS editorial_papers
    FROM versions v
    JOIN clusters c ON c.id = v.cluster_id
    JOIN articles a ON a.version_id = v.id`;

function versionRows(tab, category, limit, offset, muted = [], keywords = []) {
  const { where, params } = tabWhere(tab, category, muted, keywords);
  return db.prepare(`${ROWS_SELECT} ${where} GROUP BY v.id ORDER BY ${tabOrder(tab)} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
}

function versionTotal(tab, category, muted = [], keywords = []) {
  const { where, params } = tabWhere(tab, category, muted, keywords);
  const row = db.prepare(`SELECT COUNT(*) AS total FROM (
    SELECT v.id FROM versions v JOIN clusters c ON c.id = v.cluster_id JOIN articles a ON a.version_id = v.id
    ${where} GROUP BY v.id)`).get(...params);
  return row.total;
}

/** タブ条件（カテゴリ絞りなし）でのカテゴリ別件数。空カテゴリは「その他」。 */
function categoryCounts(tab, muted = [], keywords = []) {
  const { where, params } = tabWhere(tab, null, muted, keywords);
  const rows = db.prepare(`
    SELECT CASE WHEN c.category = '' THEN 'その他' ELSE c.category END AS category, COUNT(DISTINCT v.id) AS count
    FROM versions v JOIN clusters c ON c.id = v.cluster_id JOIN articles a ON a.version_id = v.id
    ${where} GROUP BY 1`).all(...params);
  const map = new Map(rows.map((r) => [r.category, r.count]));
  return CATEGORIES.filter((c) => map.has(c)).map((c) => ({ category: c, count: map.get(c) }));
}

async function apiStories(url) {
  // stale-while-revalidate: データがあれば収集を待たずに返し、背後で更新する
  let kicked = false;
  if (!hasData()) {
    await doRefresh();
  } else {
    kicked = kickRefreshIfStale();
  }
  const tabParam = url.searchParams.get('tab') || 'important';
  const tab = ['important', 'new', 'bookmarks', 'editorials', 'watch'].includes(tabParam) ? tabParam : 'important';
  const catParam = url.searchParams.get('category') || 'すべて';
  const category = ['すべて', ...CATEGORIES].includes(catParam) ? catParam : 'すべて';
  const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  // ミュートカテゴリ（カンマ区切りの表示名）。重要タブでのみ tabWhere が適用する。
  // 表示名「その他」は DB値 '' に読み替える。未知の名前は無視する。
  const muted = (url.searchParams.get('mute') || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => CATEGORIES.includes(s))
    .map((s) => (s === 'その他' ? '' : s));
  // キーワードウォッチ/検索のキーワード（カンマ区切り、OR 結合）。tab=watch でのみ tabWhere が使う。
  const keywords = [...new Set(
    (url.searchParams.get('keywords') || '')
      .split(',')
      .map((s) => s.trim().slice(0, 100))
      .filter(Boolean),
  )].slice(0, 20);
  return {
    stories: versionRows(tab, category, limit, offset, muted, keywords),
    total: versionTotal(tab, category, muted, keywords),
    limit,
    offset,
    refreshing: kicked || refreshing !== null,
    lastRun: lastFinishedRun(),
    polling: pollingStatus(),
    categories: categoryCounts(tab, muted, keywords),
  };
}

function apiStory(id) {
  const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(id);
  if (!cluster) return null;
  cluster.bookmarked = isBookmarked(db, id) ? 1 : 0;
  const versions = db.prepare('SELECT * FROM versions WHERE cluster_id = ? ORDER BY version_no').all(id)
    .map((v) => ({
      ...v,
      articles: db.prepare('SELECT source, title, url, summary, published_at FROM articles WHERE version_id = ? ORDER BY published_at').all(v.id),
    }));
  const editorials = db.prepare('SELECT paper, found, title, summary, url, checked_at FROM editorials WHERE cluster_id = ?').all(id);
  return { cluster, versions, editorials };
}

/* ---------- HTTP ---------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
};

/** API の JSON ボディの受信上限（バイト）。キーワード登録など小さな入力しか想定していない（2026-11-16 コンプライアンス対応 #7）。 */
const MAX_JSON_BODY_BYTES = 64 * 1024;

/**
 * リクエストの JSON ボディを読む（壊れた JSON や空ボディは {} として扱う）。
 * 上限を超えた分はメモリに載せず読み捨て、結果は {} として扱う。
 */
async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON_BODY_BYTES) { tooLarge = true; continue; }
    chunks.push(chunk);
  }
  if (tooLarge || chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  res.end(JSON.stringify(data));
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** ACCESS_TOKEN 設定時のみ: ?token= で cookie を発行し、以降は cookie で判定する。 */
function authorized(req, res, url) {
  if (!ACCESS_TOKEN) return true;
  if (parseCookies(req).news_token === ACCESS_TOKEN) return true;
  if (url.searchParams.get('token') === ACCESS_TOKEN) {
    res.setHeader('set-cookie', `news_token=${ACCESS_TOKEN}; Path=/; HttpOnly; SameSite=Lax`);
    return true;
  }
  return false;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;
    if (!authorized(req, res, url)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      return res.end('unauthorized');
    }
    if (p === '/api/stories' && req.method === 'GET') return sendJson(res, 200, await apiStories(url));
    if (p === '/api/refresh' && req.method === 'POST') {
      const { promise, started } = startRefresh();
      // 実行中は新しい収集を開始せず、現在の状態を即座に返す（呼び出し側は
      // 背後更新の完了待ちに切り替える）
      if (!started) return sendJson(res, 200, { alreadyRunning: true, refreshing: true, lastRun: lastFinishedRun() });
      const result = await promise;
      return sendJson(res, 200, result ? { ...result, alreadyRunning: false, refreshing: false } : { error: 'refresh failed' });
    }
    const storyMatch = p.match(/^\/api\/story\/(\d+)$/);
    if (storyMatch && req.method === 'GET') {
      const id = Number(storyMatch[1]);
      let story = apiStory(id);
      if (!story && !hasData()) { await doRefresh(); story = apiStory(id); }
      else if (story) kickRefreshIfStale();
      return story ? sendJson(res, 200, story) : sendJson(res, 404, { error: 'not found' });
    }
    const edMatch = p.match(/^\/api\/editorials\/(\d+)$/);
    if (edMatch && req.method === 'POST') {
      const editorials = await fetchEditorials(db, Number(edMatch[1]));
      return editorials ? sendJson(res, 200, { editorials }) : sendJson(res, 404, { error: 'not found' });
    }
    const bookmarkMatch = p.match(/^\/api\/bookmarks\/(\d+)$/);
    if (bookmarkMatch && req.method === 'POST') {
      const id = Number(bookmarkMatch[1]);
      return addBookmark(db, id) ? sendJson(res, 200, { bookmarked: true }) : sendJson(res, 404, { error: 'not found' });
    }
    if (bookmarkMatch && req.method === 'DELETE') {
      removeBookmark(db, Number(bookmarkMatch[1]));
      return sendJson(res, 200, { bookmarked: false });
    }
    if (p === '/api/keywords' && req.method === 'GET') {
      return sendJson(res, 200, { keywords: listKeywords(db) });
    }
    if (p === '/api/keywords' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = addKeywordToDb(db, body.keyword);
      if (result.error) return sendJson(res, 400, { error: result.error, keywords: result.keywords });
      return sendJson(res, 200, { keywords: result.keywords, added: result.added });
    }
    if (p === '/api/keywords' && req.method === 'DELETE') {
      const body = await readJsonBody(req);
      const result = removeKeywordFromDb(db, body.keyword);
      return sendJson(res, 200, { keywords: result.keywords, removed: result.removed });
    }
    const readMatch = p.match(/^\/api\/read\/(\d+)$/);
    if (readMatch && req.method === 'POST') {
      const id = Number(readMatch[1]);
      return recordRead(db, id) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'not found' });
    }
    if (p === '/api/maintenance' && req.method === 'POST') {
      // 手動整理: 保持期間 prune ＋ 閲覧集計 ＋ fetch_runs 整理 ＋ 本文データの消去（移行） ＋ 過剰統合の分離 ＋ 別ニュースの版の分離 ＋ 数値の改訂だけの版の畳み込み ＋ 社説の再評価 ＋ VACUUM（強制）。前後の容量を返す
      const before = dbBytes();
      const foldedReads = foldOldReadEvents(db);
      const prunedClusters = pruneOldClusters(db);
      pruneFetchRuns(db);
      const purgedBodyData = purgeBodyData(db);
      const splitClusters = splitOverMergedClusters(db);
      const splitForeign = splitForeignVersions(db);
      const foldedNumericVersions = foldNumericOnlyVersions(db);
      const refreshedSearchText = refreshSearchText(db);
      const reevaluatedEditorials = reevaluateEditorials(db);
      db.exec('VACUUM');
      return sendJson(res, 200, { pruned_clusters: prunedClusters, folded_reads: foldedReads, purged_body_data: purgedBodyData, split_clusters: splitClusters, split_foreign_versions: splitForeign, folded_numeric_versions: foldedNumericVersions, refreshed_search_text: refreshedSearchText, reevaluated_editorials: reevaluatedEditorials, before_bytes: before, after_bytes: dbBytes() });
    }
    if (p === '/api/polling' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const minutes = body.minutes === undefined ? undefined : Number(body.minutes);
      const enabled = body.enabled === undefined ? undefined : body.enabled === true;
      const polling = setPolling(enabled, minutes);
      if (!polling) return sendJson(res, 400, { error: 'invalid minutes', polling: pollingStatus() });
      return sendJson(res, 200, { polling });
    }
    if (p === '/api/status' && req.method === 'GET') {
      const counts = db.prepare('SELECT (SELECT COUNT(*) FROM clusters) AS clusters, (SELECT COUNT(*) FROM versions) AS versions, (SELECT COUNT(*) FROM articles) AS articles').get();
      return sendJson(res, 200, { lastRun: lastFinishedRun(), counts, refreshing: refreshing !== null, db_bytes: dbBytes(), polling: pollingStatus(), update: updateInfo });
    }
    // 静的配信: デコード＋正規化し、public/ 配下から出るパスは拒否する
    let rel;
    try {
      rel = decodeURIComponent(p === '/' ? '/index.html' : p).replace(/^\/+/, '');
    } catch {
      res.writeHead(400, SECURITY_HEADERS); return res.end('bad request');
    }
    const file = resolve(PUBLIC_DIR, rel);
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) {
      res.writeHead(403, SECURITY_HEADERS); return res.end('forbidden');
    }
    // SEA では埋め込み assets から、それ以外はディスクから読む（パストラバーサル検査は両方に効かせる）
    let body;
    if (AS_SEA) {
      body = readSeaAsset(rel.split(sep).join('/'));
      if (body === null) { res.writeHead(404, SECURITY_HEADERS); return res.end('not found'); }
    } else {
      body = await readFile(file);
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', ...SECURITY_HEADERS });
    res.end(body);
  } catch (e) {
    if (e.code === 'ENOENT') { res.writeHead(404, SECURITY_HEADERS); return res.end('not found'); }
    console.error(e);
    sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ichigyo-news: http://localhost:${PORT} で開いてください（待ち受け: ${HOST}:${PORT}）`);
  if (AS_SEA) {
    console.log(`データの保存先: ${DB_PATH}`);
    openBrowser(`http://localhost:${PORT}`);
  }
});
