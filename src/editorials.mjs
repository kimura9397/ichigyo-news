// 社説の収集・照合: 5大紙の社説検索、関連判定、背景社説チェック。
// src/collector.mjs から分割した（Issue #12）。
import { PAPERS, parseRss, fetchRssText, normalizeSource, cleanTitle } from './rss.mjs';
import { topicUnits, matchedCoverage, sharesAny } from './matching.mjs';
import { importanceFor } from './classify.mjs';

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
