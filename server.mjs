// ニュースアプリ サーバー（Node標準のみ）。
// 起動: node server.mjs  （PORT / HOST / ACCESS_TOKEN / NEWS_DB_PATH 環境変数で変更可、既定 8787 / 全インターフェース / 無認証 / data/news.db）
// 収集は「開いた時だけ」: データがあれば即返し、古ければ背後で更新する（stale-while-revalidate）。
// DBが空の初回だけ収集を待つ。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { extname, join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './src/db.mjs';
import { refresh, fetchEditorials, checkTopEditorials } from './src/collector.mjs';
import { fetchClusterBodies, fetchTopImages } from './src/body.mjs';
import { addBookmark, removeBookmark, isBookmarked, recordRead, foldOldReadEvents, pruneOldClusters, pruneFetchRuns, refilterBodies, backfillAuthors, splitOverMergedClusters, reevaluateEditorials, refreshSearchText } from './src/lifecycle.mjs';
import { normalizeForSearch } from './src/normalize.mjs';
import { listKeywords, addKeyword as addKeywordToDb, removeKeyword as removeKeywordFromDb } from './src/keywords.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || undefined; // 未指定なら全インターフェースで待ち受け
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const DB_PATH = process.env.NEWS_DB_PATH || join(ROOT, 'data', 'news.db');
const db = openDb(DB_PATH);
// 検索用シャドウテキスト（title_norm / search_text）を起動時に現在値へ揃える
// （旧バージョンで作られたDBや、直接投入された行でも検索が効くように）。
refreshSearchText(db);

function dbBytes() {
  try { return statSync(DB_PATH).size; } catch { return 0; }
}

const CATEGORIES = ['社会', '政治', '経済', '国際', 'スポーツ', '文化・エンタメ', '科学', 'その他'];
const IMPORTANT_THRESHOLD = 45; // 重要度スコアv2（2026-11-15再設計）の分布に合わせて再設定（対象が上位約60クラスタになる値）

let refreshing = null;
function doRefresh() {
  if (!refreshing) {
    refreshing = refresh(db)
      .then((r) => { kickImageBatch(); kickEditorialBatch(); return r; })
      .catch((e) => { console.error('refresh failed:', e); return null; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

// 背景社説チェック: refresh 完了後、重要タブ上位クラスタの社説を裏で確認する（refresh はブロックしない）
let editorialBatchRunning = false;
function kickEditorialBatch() {
  if (editorialBatchRunning) return;
  editorialBatchRunning = true;
  checkTopEditorials(db)
    .catch((e) => { console.error('editorial batch failed:', e); })
    .finally(() => { editorialBatchRunning = false; });
}

// 段階3: refresh 完了後、重要タブ上位クラスタの og:image を裏で取得する（refresh はブロックしない）
let imageBatchRunning = false;
function kickImageBatch() {
  if (imageBatchRunning) return;
  imageBatchRunning = true;
  fetchTopImages(db)
    .catch((e) => { console.error('image batch failed:', e); })
    .finally(() => { imageBatchRunning = false; });
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

function tabWhere(tab, category, muted = [], keywords = [], reporter = null) {
  const conds = [];
  const params = [];
  if (tab === 'important') {
    conds.push('c.importance_score >= ?'); params.push(IMPORTANT_THRESHOLD);
    // 重要タブは各ニュース（クラスタ）につき最新版の行だけを出す（2026-11-15 ユーザー承認）。
    // 新着・すべてタブは全バージョンを行表示する従来どおり。
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
    // 一致は「クラスタのタイトル、またはそのクラスタの記事（全版）のタイトル/要約/取得済み本文への
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
  if (tab === 'reporter') {
    // 記者ビュー: 指定した媒体（source）＋記者名（author）の記事があるクラスタの最新版行だけを出す。
    // 同姓同名の別人を混ぜないため媒体で絞る。指定が無ければ一致なし（1 = 0）。
    conds.push('v.version_no = (SELECT MAX(v2.version_no) FROM versions v2 WHERE v2.cluster_id = c.id)');
    if (reporter && reporter.source && reporter.author) {
      conds.push('EXISTS (SELECT 1 FROM articles ar WHERE ar.cluster_id = c.id AND ar.source = ? AND ar.author = ?)');
      params.push(reporter.source, reporter.author);
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
  // 重要タブは Hacker News 式の時間減衰を掛け、古い高スコア行が居座らないようにする（本文ブースト込み）
  if (tab === 'important' || tab === 'editorials') return `((c.importance_score + MIN(COALESCE(body_chars, 0) / 2000.0, 5)) / POWER(MAX((julianday('now') - julianday(COALESCE(latest_published, v.created_at))) * 24.0, 0) + 2, 1.2)) DESC, latest_published DESC, v.version_no DESC`;
  if (tab === 'bookmarks') return '(SELECT b.created_at FROM bookmarks b WHERE b.cluster_id = c.id) DESC, v.version_no DESC';
  if (tab === 'new') return 'v.created_at DESC, v.version_no DESC';
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
           SUM(CASE WHEN a.body_text != '' THEN 1 ELSE 0 END) AS body_count,
           SUM(CASE WHEN a.body_text != '' THEN length(a.body_text) ELSE 0 END) AS body_chars,
           (SELECT substr(a2.summary, 1, 120) FROM articles a2
             WHERE a2.version_id = v.id AND a2.summary != '' ORDER BY a2.published_at LIMIT 1) AS lead,
           (SELECT a3.image_url FROM articles a3
             WHERE a3.version_id = v.id AND a3.image_url != ''
             ORDER BY (a3.url LIKE 'https://news.google.com/%') ASC, a3.published_at DESC LIMIT 1) AS image_url,
           (SELECT GROUP_CONCAT(e.paper) FROM (
              SELECT paper FROM editorials WHERE cluster_id = c.id AND found = 1
              ORDER BY CASE paper WHEN '朝日' THEN 1 WHEN '毎日' THEN 2 WHEN '読売' THEN 3 WHEN '産経' THEN 4 WHEN '日経' THEN 5 ELSE 6 END
            ) e) AS editorial_papers
    FROM versions v
    JOIN clusters c ON c.id = v.cluster_id
    JOIN articles a ON a.version_id = v.id`;

function versionRows(tab, category, limit, offset, muted = [], keywords = [], reporter = null) {
  const { where, params } = tabWhere(tab, category, muted, keywords, reporter);
  return db.prepare(`${ROWS_SELECT} ${where} GROUP BY v.id ORDER BY ${tabOrder(tab)} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
}

function versionTotal(tab, category, muted = [], keywords = [], reporter = null) {
  const { where, params } = tabWhere(tab, category, muted, keywords, reporter);
  const row = db.prepare(`SELECT COUNT(*) AS total FROM (
    SELECT v.id FROM versions v JOIN clusters c ON c.id = v.cluster_id JOIN articles a ON a.version_id = v.id
    ${where} GROUP BY v.id)`).get(...params);
  return row.total;
}

/** タブ条件（カテゴリ絞りなし）でのカテゴリ別件数。空カテゴリは「その他」。 */
function categoryCounts(tab, muted = [], keywords = [], reporter = null) {
  const { where, params } = tabWhere(tab, null, muted, keywords, reporter);
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
  const tabParam = url.searchParams.get('tab') || 'all';
  const tab = ['important', 'new', 'all', 'bookmarks', 'editorials', 'watch', 'reporter'].includes(tabParam) ? tabParam : 'all';
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
  // 記者ビューの対象（媒体＋記者名）。両方そろった場合だけ reporter として tabWhere が使う。
  const repSource = (url.searchParams.get('source') || '').trim().slice(0, 100);
  const repAuthor = (url.searchParams.get('author') || '').trim().slice(0, 50);
  const reporter = repSource && repAuthor ? { source: repSource, author: repAuthor } : null;
  return {
    stories: versionRows(tab, category, limit, offset, muted, keywords, reporter),
    total: versionTotal(tab, category, muted, keywords, reporter),
    limit,
    offset,
    refreshing: kicked || refreshing !== null,
    lastRun: lastFinishedRun(),
    categories: categoryCounts(tab, muted, keywords, reporter),
  };
}

function apiStory(id) {
  const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(id);
  if (!cluster) return null;
  cluster.bookmarked = isBookmarked(db, id) ? 1 : 0;
  const versions = db.prepare('SELECT * FROM versions WHERE cluster_id = ? ORDER BY version_no').all(id)
    .map((v) => ({
      ...v,
      articles: db.prepare('SELECT source, title, url, resolved_url, summary, published_at, body_text, body_fetched_at, body_url, body_via, image_url, author FROM articles WHERE version_id = ? ORDER BY published_at').all(v.id),
    }));
  const editorials = db.prepare('SELECT paper, found, title, summary, url, checked_at FROM editorials WHERE cluster_id = ?').all(id);
  return { cluster, versions, editorials };
}

/* ---------- HTTP ---------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
};

/** リクエストの JSON ボディを読む（壊れた JSON や空ボディは {} として扱う）。 */
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
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
    if (p === '/api/refresh' && req.method === 'POST') return sendJson(res, 200, (await doRefresh()) || { error: 'refresh failed' });
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
    const bodyMatch = p.match(/^\/api\/body\/(\d+)$/);
    if (bodyMatch && req.method === 'POST') {
      const id = Number(bodyMatch[1]);
      const result = await fetchClusterBodies(db, id);
      return result ? sendJson(res, 200, { ...result, story: apiStory(id) }) : sendJson(res, 404, { error: 'not found' });
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
      // 手動整理: 保持期間 prune ＋ 閲覧集計 ＋ fetch_runs 整理 ＋ 本文ノイズ除去の後がけ ＋ 記者署名の後がけ ＋ 過剰統合の分離 ＋ 社説の再評価 ＋ VACUUM（強制）。前後の容量を返す
      const before = dbBytes();
      const foldedReads = foldOldReadEvents(db);
      const prunedClusters = pruneOldClusters(db);
      pruneFetchRuns(db);
      const refilteredBodies = refilterBodies(db);
      const backfilledAuthors = backfillAuthors(db);
      const splitClusters = splitOverMergedClusters(db);
      const refreshedSearchText = refreshSearchText(db);
      const reevaluatedEditorials = reevaluateEditorials(db);
      db.exec('VACUUM');
      return sendJson(res, 200, { pruned_clusters: prunedClusters, folded_reads: foldedReads, refiltered_bodies: refilteredBodies, backfilled_authors: backfilledAuthors, split_clusters: splitClusters, refreshed_search_text: refreshedSearchText, reevaluated_editorials: reevaluatedEditorials, before_bytes: before, after_bytes: dbBytes() });
    }
    if (p === '/api/status' && req.method === 'GET') {
      const counts = db.prepare('SELECT (SELECT COUNT(*) FROM clusters) AS clusters, (SELECT COUNT(*) FROM versions) AS versions, (SELECT COUNT(*) FROM articles) AS articles').get();
      return sendJson(res, 200, { lastRun: lastFinishedRun(), counts, refreshing: refreshing !== null, db_bytes: dbBytes() });
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
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', ...SECURITY_HEADERS });
    res.end(body);
  } catch (e) {
    if (e.code === 'ENOENT') { res.writeHead(404, SECURITY_HEADERS); return res.end('not found'); }
    console.error(e);
    sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => console.log(`ichigyo-news: http://localhost:${PORT} で開いてください（待ち受け: ${HOST || '全インターフェース'}:${PORT}）`));
