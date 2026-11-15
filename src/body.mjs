// 本文取得モジュール: 詳細を開いたクラスタについて、記事ページから本文抽出を試みる。
// サムネイル（articles.image_url）も同じ経路で取得する: ページ取得時に og:image を拾い（段階2）、
// refresh 後には重要タブ上位クラスタ分を裏でまとめて取得する（段階3、fetchTopImages）。
// 画像はURLの参照表示のみで、ダウンロード保存はしない。
// ルールベース抽出のみ（Q2決定）。取得結果は articles.body_text にキャッシュし、
// 失敗も body_fetched_at に記録して再試行は24時間空ける。
// SSRF対策: http/https のみ、プライベート/ループバック等のアドレスは取得しない。
// リダイレクトは手動でたどり（最大5回）、各ホップで同じチェックを行う。
//
// 取得候補の優先順位（2026-11-15 B+C→A 対応）:
//   1. 記事自身の直接URL（媒体サイト）
//   2. GoogleニュースのラッパーURLを解決した実URL（src/gnews-resolve.mjs、非公式プロトコル依存・失敗時は次へ）
//   3. 同一クラスタ内にある同一記事の Yahoo!ニュース記事ページ版（本文の出所は body_via='yahoo' で帰属を明示する）
//   ラッパーURLそのものは実ページに辿り着けないため原則として取得対象にしない。
// 取得できたら body_url（実際に取得したURL）と body_via（経路）を記録し、出所を取り違えないようにする。
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { stripTags, decodeEntities, isWrapperUrl, isYahooArticleUrl, bigrams, filterWeakBigrams, matchScore } from './collector.mjs';
import { resolveGoogleNewsUrl } from './gnews-resolve.mjs';

const TIMEOUT_MS = 15000; // 遅い回線・重いページでも本文ダウンロードが間に合うよう余裕を持たせる
const RETRY_MS = 24 * 3600000;
const MAX_PARALLEL = 4;
const MAX_REDIRECTS = 5;
const MAX_RESOLUTIONS = 60; // 1回の呼び出しで試みるラッパーURL解決の上限
const FULL_BODY_CHARS = 200; // これ以上取れたら「十分な本文」として後続候補を試さない
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/** プライベート/ループバック/リンクローカル等のIPアドレスか。 */
export function isPrivateIp(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      a >= 224 // マルチキャスト/予約
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    return (
      s === '::1' || s === '::' ||
      s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || // リンクローカル fe80::/10
      s.startsWith('fc') || s.startsWith('fd') || // ULA fc00::/7
      s.startsWith('::ffff:') && isPrivateIp(s.slice(7))
    );
  }
  return true; // IPとして解釈できないものは安全側に倒す
}

/**
 * 取得してよい公開URLか: スキームが http/https で、ホスト名が localhost 等でなく、
 * 解決先IPがすべて公開アドレスであること（DNSリバインディング対策として解決結果も見る）。
 */
export async function checkUrlAllowed(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (isIP(host)) return !isPrivateIp(host);
  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    return false;
  }
  if (!addrs.length) return false;
  return addrs.every((a) => !isPrivateIp(a.address));
}

/**
 * HTMLの <head> から og:image（なければ twitter:image）のURLを取り出す（段階2: サムネイル）。
 * 画像そのものはダウンロード保存せず、URLの参照表示のみ（権利配慮）。
 * 相対URLは baseUrl で解決し、http/https のものだけを返す。
 */
export function extractOgImage(html, baseUrl = '') {
  const h = String(html || '');
  let fallback = '';
  for (const m of h.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = ((tag.match(/\b(?:property|name)\s*=\s*"([^"]+)"/i) || [])[1] || '').toLowerCase();
    const isOg = key === 'og:image' || key === 'og:image:url' || key === 'og:image:secure_url';
    const isTw = key === 'twitter:image' || key === 'twitter:image:src';
    if (!isOg && !isTw) continue;
    const content = (tag.match(/\bcontent\s*=\s*"([^"]+)"/i) || [])[1];
    if (!content) continue;
    let url = decodeEntities(content).trim();
    try {
      url = new URL(url, baseUrl || undefined).toString();
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    } catch { continue; }
    if (isOg) return url; // og:image を優先する
    if (!fallback) fallback = url;
  }
  return fallback;
}

/** HTMLから本文らしき <p> テキストを連結する（ナビ・広告等の定型ブロックは除去）。 */
export function extractBody(html) {
  let h = String(html || '');
  h = h
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|header|footer|aside|form|noscript|select|button)[\s\S]*?<\/\1>/gi, ' ');
  const paras = [];
  for (const m of h.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const t = stripTags(m[1]).trim();
    if (t.length < 25) continue; // 短い断片（リンク・キャプション類）は本文とみなさない
    if (paras[paras.length - 1] === t) continue;
    paras.push(t);
  }
  return paras.join('\n').slice(0, 20000);
}

/**
 * ページを取得し、本文テキストと og:image をまとめて返す（取れなければ各々 ''）。
 * リダイレクトは手動でたどり、各ホップでSSRFチェックを行う。
 */
async function fetchPage(fetchImpl, url, timeoutMs = TIMEOUT_MS) {
  const empty = { text: '', imageUrl: '' };
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await checkUrlAllowed(current))) return empty;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers?.get?.('location');
        if (!loc || hop === MAX_REDIRECTS) return empty;
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) return empty;
      const ct = res.headers?.get?.('content-type') || '';
      if (ct && !/html|xml/i.test(ct)) return empty;
      const html = await res.text();
      return { text: extractBody(html), imageUrl: extractOgImage(html, current) };
    } catch {
      return empty;
    } finally {
      clearTimeout(timer);
    }
  }
  return empty;
}

async function runPool(items, size, worker) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await worker(items[idx]);
      }
    }),
  );
}

/**
 * 同一クラスタ内から、この記事と同一記事と判断できる Yahoo!ニュース記事ページ版を探す。
 * 見出しの類似（包含率）が十分高いものだけを同一記事とみなす。なければ null。
 */
function findYahooAlt(article, clusterArticles) {
  const titleBg = filterWeakBigrams(bigrams(article.title));
  let best = null;
  for (const a of clusterArticles) {
    if (a.id === article.id || !isYahooArticleUrl(a.url)) continue;
    const sim = matchScore(titleBg, filterWeakBigrams(bigrams(a.title)));
    if (sim >= 0.5 && (!best || sim > best.sim)) best = { article: a, sim };
  }
  return best?.article || null;
}

/**
 * 1記事分の本文取得: 候補URLを優先順に試し、最初に十分な長さが取れたものを採用する。
 * あわせて、取得したページの og:image（サムネイル）も拾う。本文が取れないページでも
 * og:image だけ取れればそれで良い。画像は最初に取得できた候補のものを採用する。
 * 戻り値: { text, url, via, imageUrl, imageIds }（imageIds は画像を帰属させる記事ID群。
 * Yahoo代替のページから取った画像は、同一記事と判断した代替元記事にも帰属させる）。
 */
async function fetchArticleBody(db, article, clusterArticles, ctx) {
  const candidates = [];
  if (!isWrapperUrl(article.url)) {
    candidates.push({ url: article.url, via: 'direct' });
  } else if (ctx.resolveGoogle) {
    // ラッパーURL: 実URLの解決を試みる（成功したらDBにキャッシュし、以後は解決済みURLを使う）
    let resolved = article.resolved_url || '';
    if (!resolved && ctx.resolveBudget.left > 0) {
      ctx.resolveBudget.left--;
      resolved = await resolveGoogleNewsUrl(article.url, { fetchImpl: ctx.fetchImpl });
      if (resolved) {
        db.prepare('UPDATE articles SET resolved_url = ? WHERE id = ?').run(resolved, article.id);
        article.resolved_url = resolved;
        ctx.resolvedCount++;
      }
    }
    if (resolved && resolved !== article.url) candidates.push({ url: resolved, via: 'resolved' });
  }
  const alt = findYahooAlt(article, clusterArticles);
  if (alt) candidates.push({ url: alt.url, via: 'yahoo', altArticle: alt });

  let best = { text: '', url: '', via: '', imageUrl: '', imageIds: [] };
  for (const cand of candidates) {
    // Yahoo代替元の記事に既に本文がキャッシュされていれば、それを再利用する（再取得しない）
    let text = cand.altArticle?.body_text || '';
    let imageUrl = '';
    if (!text) {
      const page = await fetchPage(ctx.fetchImpl, cand.url);
      text = page.text;
      imageUrl = page.imageUrl;
    }
    if (imageUrl && !best.imageUrl) {
      best.imageUrl = imageUrl;
      best.imageIds = cand.altArticle ? [article.id, cand.altArticle.id] : [article.id];
    }
    if (text.length > best.text.length) best = { ...best, text, url: cand.url, via: cand.via };
    if (text.length >= FULL_BODY_CHARS) break;
  }
  return best;
}

/**
 * クラスタ内の全記事について本文取得を試みる（未試行か、前回試行から24時間経ったものだけ）。
 * 戻り値: { attempted, got, resolved }（got は今回新たに本文が取れた件数、
 * resolved は今回新たに実URLを解決できた件数）。クラスタがなければ null。
 * オプション resolveGoogle=false でラッパーURL解決を無効化できる（計測・切り分け用）。
 */
export async function fetchClusterBodies(db, clusterId, { fetchImpl = fetch, resolveGoogle = true } = {}) {
  const cluster = db.prepare('SELECT id FROM clusters WHERE id = ?').get(clusterId);
  if (!cluster) return null;
  const articles = db.prepare('SELECT id, source, title, url, resolved_url, body_text, body_fetched_at FROM articles WHERE cluster_id = ?').all(clusterId);
  const now = Date.now();
  const targets = articles.filter(
    (a) => !a.body_text && (!a.body_fetched_at || now - new Date(a.body_fetched_at).getTime() > RETRY_MS),
  );
  const update = db.prepare('UPDATE articles SET body_text = ?, body_fetched_at = ?, body_url = ?, body_via = ? WHERE id = ?');
  const imgUpdate = db.prepare("UPDATE articles SET image_url = ?, image_via = 'og' WHERE id = ? AND image_url = ''");
  const imgAttempt = db.prepare('UPDATE articles SET image_fetched_at = ? WHERE id = ? AND image_fetched_at IS NULL');
  const ctx = { fetchImpl, resolveGoogle, resolveBudget: { left: MAX_RESOLUTIONS }, resolvedCount: 0 };
  let got = 0;
  let images = 0;
  await runPool(targets, MAX_PARALLEL, async (a) => {
    const best = await fetchArticleBody(db, a, articles, ctx);
    if (best.text) got++;
    const nowIso = new Date().toISOString();
    update.run(best.text, nowIso, best.url, best.via, a.id);
    imgAttempt.run(nowIso, a.id); // og:image の取得も試行済みとして記録する（段階3の裏取得で再試行しない）
    if (best.imageUrl) {
      let credited = false;
      for (const id of best.imageIds) {
        const info = imgUpdate.run(best.imageUrl, id);
        if (Number(info.changes) > 0) credited = true;
      }
      if (credited) images++;
    }
    if (best.text) { a.body_text = best.text; } // 同一クラスタ内のYahoo代替の再利用に備えてメモリ上も更新
  });
  return { attempted: targets.length, got, resolved: ctx.resolvedCount, images };
}

// ---------- 段階3: 重要タブ上位クラスタの og:image 裏取得 ----------
// refresh 完了後に背後で回し、一覧のサムネイル充足率を底上げする。refresh 自体はブロックしない。
// 画像はURLの参照のみで、ダウンロード保存はしない。

const IMAGE_BATCH_LIMIT = 50; // 1回のバッチで処理するクラスタ数の上限
const IMAGE_BATCH_TIMEOUT_MS = 8000;
const IMAGE_BATCH_PARALLEL = 4;
const IMPORTANT_THRESHOLD = 12; // server.mjs の重要タブ閾値と合わせる

/**
 * 重要タブの並び順（時間減衰込み。server.mjs の tabOrder と同じ考え方）で上位クラスタを選び、
 * 代表記事（直接URL優先、次に解決済み実URL）のページから og:image が未取得なら取得する。
 * 既に画像がある記事・取得試行済みの記事は対象にしない。ラッパーURLのみのクラスタは対象外。
 * 戻り値: { clusters, attempted, got }。
 */
export async function fetchTopImages(db, { fetchImpl = fetch, limit = IMAGE_BATCH_LIMIT } = {}) {
  const clusters = db.prepare(`
    SELECT c.id,
      (c.importance_score + MIN(COALESCE(b.body_chars, 0) / 2000.0, 5))
        / POWER(MAX((julianday('now') - julianday(COALESCE(b.latest_published, c.last_seen_at))) * 24.0, 0) + 2, 1.2) AS rank_score
    FROM clusters c
    LEFT JOIN (
      SELECT cluster_id, MAX(published_at) AS latest_published,
             SUM(CASE WHEN body_text != '' THEN length(body_text) ELSE 0 END) AS body_chars
      FROM articles GROUP BY cluster_id
    ) b ON b.cluster_id = c.id
    WHERE c.importance_score >= ?
    ORDER BY rank_score DESC
    LIMIT ?`).all(IMPORTANT_THRESHOLD, limit);

  const repStmt = db.prepare(`
    SELECT a.id, a.url, a.resolved_url FROM articles a
    JOIN versions v ON v.id = a.version_id
    WHERE a.cluster_id = ? AND a.image_url = '' AND a.image_fetched_at IS NULL
    ORDER BY v.version_no DESC, a.published_at DESC`);
  const imgUpdate = db.prepare("UPDATE articles SET image_url = ?, image_via = 'og', image_fetched_at = ? WHERE id = ? AND image_url = ''");
  const imgAttempt = db.prepare('UPDATE articles SET image_fetched_at = ? WHERE id = ? AND image_fetched_at IS NULL');

  const jobs = [];
  for (const c of clusters) {
    const reps = repStmt.all(c.id);
    // 代表記事: 直接URL → 解決済み実URL の順に優先する（ラッパーURLそのものは辿れないので対象外）
    let rep = null;
    for (const a of reps) {
      if (!isWrapperUrl(a.url)) { rep = { id: a.id, url: a.url }; break; }
    }
    if (!rep) {
      for (const a of reps) {
        if (a.resolved_url && a.resolved_url !== a.url) { rep = { id: a.id, url: a.resolved_url }; break; }
      }
    }
    if (rep) jobs.push(rep);
  }

  let got = 0;
  await runPool(jobs, IMAGE_BATCH_PARALLEL, async (job) => {
    const page = await fetchPage(fetchImpl, job.url, IMAGE_BATCH_TIMEOUT_MS);
    const nowIso = new Date().toISOString();
    if (page.imageUrl) {
      const info = imgUpdate.run(page.imageUrl, nowIso, job.id);
      if (Number(info.changes) > 0) got++;
    } else {
      imgAttempt.run(nowIso, job.id);
    }
  });
  return { clusters: clusters.length, attempted: jobs.length, got };
}
