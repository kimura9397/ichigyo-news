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
import { buildArticleSearchText, normalizeForSearch } from './normalize.mjs';
import { extractKeyPoints } from './extract.mjs';

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

// ---------- 記者署名（バイライン）の抽出（2026-11-15 ユーザー希望） ----------
// 「同じ記者の他の記事を読んで、その記者の傾向を自分で判断したい」という用途のため、
// 署名の抽出・保存・表示だけを行う。記者の傾向や偏向の自動ラベル付けは行わない。
// 抽出元は (1) 本文テキスト中の署名表記（（○○記者）・文・○○ 等）、
// (2) 取得HTMLの JSON-LD / meta の author。
// 通信社の配信記事や NHK は署名が無いことが多い前提で、取れなければ空のままにする（捏造しない）。
// 誤抽出を避けるため、候補は人名らしさの検証（cleanAuthorName）を通ったものだけを採用する。

/** 媒体名・組織名に含まれがちな語。人名候補に含まれていたら人名ではないとみなす。 */
const AUTHOR_ORG_WORDS = [
  '新聞', '通信', '放送', 'テレビ', 'ラジオ', '編集', 'デスク', 'デジタル', 'ニュース',
  '写真', '映像', '支局', '支社', '本社', '総局', '論説', '特派員', '記者クラブ', 'ウェブ', 'オンライン',
];
/** 配信元・媒体の略称そのものは人名ではない。 */
const AUTHOR_NON_NAMES = new Set(['共同', '時事', 'ロイター', 'ブルームバーグ']);

/**
 * 署名候補を人名として検証・正規化する。人名らしくなければ '' を返す。
 * 末尾の「記者」は役割表記なので落とす。デスク表記（政治部・社会部など、末尾が「部」）や
 * 媒体・組織名は弾く。実在の姓名は概ね2〜7字（区切りを除く）という前提で長さも見る。
 */
export function cleanAuthorName(raw) {
  let s = String(raw || '').replace(/[\s　]+/g, ' ').trim();
  s = s.replace(/^[（(【\[「『]+/, '').replace(/[）)】\]」』]+$/, '').trim();
  s = s.replace(/記者$/, '').trim();
  if (!s) return '';
  if (/[0-9０-９]/.test(s)) return '';
  if (/[。、！？!?：:；;／/=＝@]/.test(s)) return '';
  // 人名に使われる文字種だけを許可する（漢字・かな・カタカナ・長音・中黒・空白・ラテン文字・ハイフン・ピリオド）
  if (!/^[A-Za-z\u3040-\u30ff\u4e00-\u9fff][A-Za-z\u3040-\u30ff\u4e00-\u9fff・\s.-]*$/u.test(s)) return '';
  const core = s.replace(/[\s・.-]/g, '');
  if (core.length < 2 || core.length > 10) return '';
  if (AUTHOR_ORG_WORDS.some((w) => s.includes(w))) return '';
  if (s.endsWith('部')) return ''; // 政治部・社会部などのデスク表記は人名ではない
  if (AUTHOR_NON_NAMES.has(core)) return '';
  return s;
}

// 署名パターン中の人名部分: 漢字・かなの1連（2〜7字）、または空白区切りの姓名
const AUTHOR_NAME_SRC = String.raw`(?:[\u3040-\u30ff\u4e00-\u9fff]{2,7}|[\u3040-\u30ff\u4e00-\u9fff]{1,4}[\s　][\u3040-\u30ff\u4e00-\u9fff]{1,4})`;
const BYLINE_BRACKET_RE = new RegExp(String.raw`[（(【](${AUTHOR_NAME_SRC})記者[）)】]`, 'gu');
const BYLINE_BUN_RE = new RegExp(String.raw`(?:^|[\s（(【「。、\n])文\s*[・＝=：:／/]\s*(${AUTHOR_NAME_SRC})(?:\s*記者)?`, 'gmu');
const BYLINE_TRAILING_RE = new RegExp(String.raw`(?:^|\n)[\s　]*(${AUTHOR_NAME_SRC})記者[\s　]*$`, 'gmu');

/**
 * 本文テキストから記者署名を抽出する。対象は日本語新聞の典型パターン:
 * 「（○○記者）」という括弧表記、「文・○○」「文＝○○」というクレジット表記、
 * 末尾行が「○○記者」だけの行。どれも人名検証を通った場合だけ採用する。
 * 配信記事のクレジット（【○○共同】や（○○＝共同））は「記者」を含まないため対象にならない。
 */
export function extractAuthorFromText(text) {
  const t = String(text || '');
  if (!t) return '';
  for (const re of [BYLINE_BRACKET_RE, BYLINE_BUN_RE, BYLINE_TRAILING_RE]) {
    re.lastIndex = 0;
    for (const m of t.matchAll(re)) {
      const name = cleanAuthorName(m[1]);
      if (name) return name;
    }
  }
  return '';
}

/** JSON-LD の中から author（Person の name、または文字列）を探す。Organization は採らない。 */
function findJsonLdAuthor(node, depth) {
  if (!node || depth > 4) return '';
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = findJsonLdAuthor(item, depth + 1);
      if (r) return r;
    }
    return '';
  }
  if (typeof node === 'object') {
    if ('author' in node) {
      const candidates = Array.isArray(node.author) ? node.author : [node.author];
      for (const c of candidates) {
        if (typeof c === 'string') {
          const n = cleanAuthorName(c);
          if (n) return n;
        } else if (c && typeof c === 'object' && typeof c.name === 'string') {
          const type = String(c['@type'] || '');
          if (type && !/person/i.test(type)) continue; // 組織名は人名ではない
          const n = cleanAuthorName(c.name);
          if (n) return n;
        }
      }
    }
    for (const key of ['@graph', 'mainEntity', 'itemListElement']) {
      if (key in node) {
        const r = findJsonLdAuthor(node[key], depth + 1);
        if (r) return r;
      }
    }
  }
  return '';
}

/**
 * 取得HTMLから記者署名を抽出する: JSON-LD の author を優先し、次に
 * meta name="author" / article:author を見る。どちらも人名検証を通った場合だけ採用する
 * （媒体名が入っている場合は検証で落ちて '' になる）。
 */
export function extractAuthorFromHtml(html) {
  const h = String(html || '');
  if (!h) return '';
  for (const m of h.matchAll(/<script\b[^>]*type\s*=\s*"application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const name = findJsonLdAuthor(data, 0);
    if (name) return name;
  }
  for (const m of h.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = ((tag.match(/\b(?:property|name)\s*=\s*"([^"]+)"/i) || [])[1] || '').toLowerCase();
    if (key !== 'author' && key !== 'article:author') continue;
    const content = (tag.match(/\bcontent\s*=\s*"([^"]+)"/i) || [])[1];
    if (!content) continue;
    const name = cleanAuthorName(decodeEntities(content));
    if (name) return name;
  }
  return '';
}

/** 本文テキストの署名表記を優先し、無ければHTMLのメタ情報から抽出する。 */
export function extractAuthor(html, text) {
  return extractAuthorFromText(text) || extractAuthorFromHtml(html);
}

// ---------- 本文のノイズ除去（2026-11-15 ユーザー承認、2026-11-16 拡張） ----------
// 取得本文に「Xでシェア！」「メールマガジン登録！」等の定型文が混ざると読む気を削ぐため、
// (1) 構造での除外: class/id にノイズ語を含む要素を丸ごと落とす
// (2) 行単位のフィルタ: 段落テキストから定型の勧誘・案内・フッター行を落とす
// の2段で除去する。実文の誤爆を避けるため、パターンは具体形に絞り、
// 行フィルタの多くは「短い行」にだけ適用する（実文は通常長い）。
//
// 2026-11-16 の拡張（ユーザー指摘「別記事のリンク文言が本文に入る」への対応、実データで分類）:
// 実フィードの本文を実測すると、残っていたノイズの最大要因は本文末尾に付く
// 「他記事の見出しリスト」（Yahoo!/朝日/NHK/時事いずれでも発生。関連・おすすめ記事の
// 見出しが段落として何行も連なる）だった。あわせて次の定型も実例を確認した:
// - 朝日の有料勧誘（「有料会員になると…」「読み放題」キャンペーン、「詳しくは こちら」）
// - 有料記事のティーザー段落（行頭「記事の後半では」）
// - 関連記事カードの見出し行（末尾に「出典： 媒体名 日付」）
// - 先頭での記事タイトル重複（タイトルそのままの行、タイトル＋配信日時の行）
// - 著者プロフィール段落（メールアドレス＋執筆・著書等の語を含む）
// - 投票ウィジェットの設問（見出しリストの直前に単独行で残る質問文）
// 対策は filterBodyLines に集約する: 行フィルタへの定型追加に加え、ブロック単位の
// 処理（プロフィール段落の除外、先頭のタイトル重複行の除外、末尾の見出し行ランの除去）
// を行う。写真キャプションや中見出しのような正当な要素は対象にしない（末尾の見出しランは
// 「文で終わらない行が3行以上連続し、前に文のある行が残る場合」に限って落とす）。
//
// 2026-11-16 の追加（単独で本文中盤に挟まる他記事見出し行への対応、ユーザー承認）:
// 中盤に単独で挟まる見出し行は、テキストの形だけでは中見出しと区別できないため、
// 「出自」の信号を2つ使う。
// 方式1（取得時の構造信号）: 関連記事の見出しは元のHTMLでは段落全体が別記事への
//   <a> リンクになっている（<p><a>見出し</a></p>、または <a> が <p> を包む形）。
//   抽出時に「段落のテキスト全体がリンクで構成される」段落を落とす。本物の中見出しは
//   見出しタグ（h2〜h4）由来でリンクではない（現行の抽出は <p> のみを対象とするため
//   見出しタグはそもそも本文に入らず、この判定で消えることもない）。文の一部だけが
//   リンクになっている実文は「行全体がリンク」ではないので落とさない。
// 方式2（DBの他記事タイトルとの照合）: 挟まる見出しは実在する別記事のタイトル
//   そのものであることが多い。後がけ（refilterBodies）で、本文の各行を正規化して
//   DB内の他クラスタ記事のタイトルと照合し、一致した行を落とす。誤爆防止のため、
//   照合キーが10字以上・行が文（。）で終わらない・完全一致（または末尾の配信日時を
//   除いた一致）に限る。自クラスタのタイトルと一致する行は落とさない（同一記事の
//   再掲や自記事タイトルは方式2の対象外。先頭の重複は従来の仕組みが担当する）。

/** class/id のトークン（空白・ハイフン等で分割した断片）がこの語で始まる要素はノイズとみなす。 */
const NOISE_ATTR_TOKENS = [
  'share', 'sns', 'social', 'newsletter', 'mailmag', 'mailmagazine', 'magazine',
  'related', 'recommend', 'ranking', 'promo', 'advert',
  'signup', 'follow', 'subscribe', 'subscription', 'login', 'member', 'notify', 'notification',
];
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** タグの属性文字列（class / id）の値がノイズ語を含むか。 */
function attrsHaveNoise(attrs) {
  for (const m of String(attrs || '').matchAll(/\b(?:class|id)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = (m[1] ?? m[2] ?? '').toLowerCase();
    for (const token of value.split(/[\s\-_./:]+/)) {
      if (!token) continue;
      if (NOISE_ATTR_TOKENS.some((w) => token === w || token.startsWith(w))) return true;
    }
  }
  return false;
}

/**
 * class/id にノイズ語を含む要素を、対応する終了タグまで丸ごと取り除く。
 * 記事本文のルート要素（article-body 等）はノイズ語を含まない前提だが、
 * 万一の誤判定で全文が消える事故を避けるため、呼び出し側で安全弁を持つ。
 */
function stripNoiseElements(html) {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let out = '';
  let last = 0;
  let m;
  let skipTag = null; // 除去中の要素名（同名タグのネストを数える）
  let depth = 0;
  while ((m = tagRe.exec(html)) !== null) {
    const isClose = m[1] === '/';
    const name = m[2].toLowerCase();
    const attrs = m[3] || '';
    if (skipTag) {
      if (name === skipTag) {
        if (isClose) { depth--; if (depth === 0) { skipTag = null; last = tagRe.lastIndex; } }
        else if (!VOID_TAGS.has(name) && !/\/\s*$/.test(attrs)) depth++;
      }
      continue;
    }
    if (!isClose && !VOID_TAGS.has(name) && !/\/\s*$/.test(attrs) && attrsHaveNoise(attrs)) {
      out += html.slice(last, m.index);
      skipTag = name;
      depth = 1;
      last = tagRe.lastIndex;
    }
  }
  if (!skipTag) out += html.slice(last);
  // 閉じタグが見つからず末尾まで除去してしまった場合は壊れた入力とみなし、原文を返す
  return skipTag ? html : out;
}

/**
 * 段落のテキスト全体がリンク（<a>）で構成されているか（方式1の構造信号）。
 * 関連記事カードの見出し段落はこの形になる。文の一部だけがリンクになっている
 * 実文は、リンク外のテキストが残るため false になる（落とさない）。
 */
function isLinkOnlyParagraph(innerHtml) {
  const inner = String(innerHtml || '');
  if (!/<a\b/i.test(inner)) return false;
  let linkText = '';
  for (const m of inner.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) linkText += stripTags(m[1]);
  const squash = (s) => s.replace(/[\s　]+/g, '');
  const full = squash(stripTags(inner));
  return full.length > 0 && full === squash(linkText);
}

/** 行がノイズ（定型の勧誘・案内・フッター）かどうか。実文を消さないよう具体形に絞る。 */
function isNoiseLine(line) {
  const t = line.trim();
  if (!t) return true;
  const short = t.length < 50;
  const mid = t.length < 80;
  // 見出し型の定型ブロック（行頭一致）
  if (/^(関連記事|関連ニュース|関連リンク|おすすめ記事|おすすめの記事|あわせて読みたい|こちらもおすすめ|人気記事|人気の記事|今読まれている記事|新着記事|最新記事|編集部おすすめ|アクセスランキング|動画アクセスランキング|ランキング)/.test(t)) return true;
  // シェア系（「市場シェア」のような実文に当たらない具体形のみ）
  if (/(X|Ｔｗｉｔｔｅｒ|Twitter|Facebook|LINE|はてな).{0,8}(で|に|へ)?(シェア|ポスト|送る|登録|追加)/.test(t)) return true;
  if (/(記事をシェア|シェアする$|シェアしよう)/.test(t) && t.length < 40) return true;
  if (/^(シェア|共有する|共有|Ｓｈａｒｅ|Share)/.test(t) && short) return true;
  if (/はてなブックマーク/.test(t)) return true;
  // 登録・フォロー・通知系の勧誘
  if (/(メールマガジン|メルマガ)/.test(t) && (/(登録|配信|購読|申し込|受信)/.test(t) || t.length < 30)) return true;
  if (/(会員登録|無料登録|新規登録|読者登録)/.test(t) && mid) return true;
  if (/フォロー(する|して|ボタン)/.test(t) && short) return true;
  if (/通知を受け取る|通知をオン/.test(t)) return true;
  if (/アプリで(読む|開く|見る)|アプリをダウンロード|アプリのダウンロード/.test(t)) return true;
  if (/ログイン(して|すると|が必要|画面)/.test(t) && mid) return true;
  if (/この記事はいかがでしたか/.test(t)) return true;
  // リンク文言の残骸（「詳しくは こちら」はタグ除去で空白が挟まる形でも現れる。実文には現れない）
  if (/詳しくは\s*こちら/.test(t)) return true;
  // 有料会員・購読の勧誘とキャンペーン文言（朝日で実例確認）
  if (/有料会員になると/.test(t)) return true;
  if (/会員限定の有料記事/.test(t) && /(お読み|ご覧)いただけます/.test(t)) return true;
  if (/読み放題/.test(t)) return true;
  // 有料記事のティーザー段落（後半の内容予告）
  if (/^記事の後半では/.test(t)) return true;
  // 関連記事カードの見出し行（末尾に「出典： 媒体名 日付」が付く形。出典に触れる実文は長いので長さで絞る）
  if (/出典[：:]/.test(t) && t.length <= 150) return true;
  // アンケート・投票への誘導（短い行だけ）
  if (/アンケート/.test(t) && t.length < 60) return true;
  // PR・広告の単独表記行
  if (/^(PR|【PR】|［PR］|広告)$/i.test(t)) return true;
  // NHK の配信サービス案内（定型文そのままの断片だけを対象にする）
  if (/NHK ONEはどなたでも|受信契約がお済みの世帯|契約をされていない世帯の方が利用した場合は|受信契約の詳細や/.test(t)) return true;
  // 有料ティーザーの末尾行（「続きを読む」は短い行だけを対象にする）
  if (/続きを読む/.test(t) && short) return true;
  // フッター系
  if (/(©|Copyright|（C）|\(c\))/.test(t) && /(無断|転載|複製|rights reserved|コピーライト)/i.test(t)) return true;
  if (/無断(転載|複製|引用)を(禁じ|お断り)/.test(t)) return true;
  if (/(お問い合わせ|プライバシーポリシー|プライバシー・ポリシー|利用規約|特定商取引法|サイトマップ|会社概要)/.test(t) && mid) return true;
  // 極端に短い行のCTA（ボタン文言の残骸）
  if (t.length < 15 && /(登録|シェア|フォロー|購入|ダウンロード|申し込|今すぐ|クリック|応募する)/.test(t)) return true;
  return false;
}

/** メールアドレスらしき文字列（著者プロフィール段落の判定用）。 */
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
/** 著者プロフィール・連絡先ブロックに現れる語。 */
const PROFILE_WORD_RE = /(執筆|著書|ライター|ご依頼|プロフィール|生まれ)/;

/**
 * ブロックが著者プロフィール（連絡先含む）かどうか。本文の段落がメールアドレスと
 * プロフィール語の両方を含むことはまず無いため、この組合せに限って丸ごと落とす。
 */
function isProfileBlock(block) {
  return EMAIL_RE.test(block) && PROFILE_WORD_RE.test(block);
}

/** タイトル照合用の正規化（空白・句読点・括弧類を落として比べる）。 */
function normalizeTitleText(s) {
  return String(s || '').replace(/[\s　、。・,，.．「」『』【】［］()（）<>＜＞:：;；!！?？'"“”‘’|｜/／\-―]/g, '');
}

/**
 * 行が記事タイトルそのもの（またはタイトル＋配信日時だけの見出し行）かどうか。
 * 時事・Yahoo!ピックアップでは本文先頭にタイトルがそのまま再掲される。
 */
function isTitleDupLine(line, title) {
  const t = String(title || '').trim();
  if (t.length < 6) return false;
  if (normalizeTitleText(line) === normalizeTitleText(t)) return true;
  // タイトル＋「11/14(土) 23:01」形式の日時だけが続く行
  const squash = (s) => s.replace(/[\s　]+/g, '');
  const ls = squash(line);
  const ts = squash(t);
  if (ls.length > ts.length && ls.startsWith(ts)) {
    if (/^\d{1,2}\/\d{1,2}\([月火水木金土日]\)\d{1,2}:\d{2}/.test(ls.slice(ts.length))) return true;
  }
  return false;
}

/** 先頭3行までの範囲で、タイトル重複行を落とす（本文中盤の再掲は対象にしない）。 */
function dropTitleDupLines(blocks, title) {
  if (!title) return;
  let seen = 0;
  for (const block of blocks) {
    for (let i = 0; i < block.length && seen < 3; i++, seen++) {
      if (isTitleDupLine(block[i], title)) { block.splice(i, 1); i--; seen--; }
    }
    if (seen >= 3) break;
  }
}

/** 文末の句点（「。」または「．」）の位置。小数点（数字に挟まれた点）は除く。無ければ -1。 */
function lastSentencePeriodIndex(t) {
  for (let i = t.length - 1; i >= 0; i--) {
    const ch = t[i];
    if (ch !== '。' && ch !== '．') continue;
    const prev = t[i - 1] || '';
    const next = t[i + 1] || '';
    if (/[0-9０-９]/.test(prev) && /[0-9０-９]/.test(next)) continue;
    return i;
  }
  return -1;
}

/**
 * 見出し的な行か（末尾の他記事見出しリストの判定用）。新聞の本文段落はほぼ必ず
 * 「。」で終わる（引用で終わる段落も文なので同様）ため、「文で終わらない短めの行」を
 * 見出しとみなす。途中に「。」を含む断片（団体紹介文など）も見出し側に倒すため、
 * 判定は文末で行う。写真キャプション等の正当な行は通常は文で終わるか、
 * 末尾に3行以上は連ならない。
 */
function isHeadlineLikeLine(line) {
  const t = line.trim();
  if (t.length < 8 || t.length > 110) return false;
  if (/[。．]$/.test(t)) return false; // 文で終わる行は本文
  if (/」$/.test(t) && t.includes('。')) return false; // 引用文で終わる段落も本文
  // 文の連なりの末尾が「…」等で切れた行（最後の「。」の後ろが短い）は本文とみなす。
  // 逆に、団体紹介文のような断片は最後の「。」の後ろに長い続きがある。
  // 小数点（数字に挟まれた「．」）は文の区切りではないため、文末の句点として数えない
  // （例: 「４．８兆円関税下げへ議論」という見出し行が本文扱いになり、末尾の
  // 見出しラン全体が残ってしまう実例が時事の記事であったため、2026-11-16 に是正）。
  const lastPeriod = lastSentencePeriodIndex(t);
  if (lastPeriod >= 0 && t.length - lastPeriod - 1 < 15) return false;
  return true;
}

/**
 * 本文末尾に連なる他記事見出しの行（3行以上）を落とす。関連・おすすめ記事の
 * 見出しリストは媒体を問わず本文の後ろに付く。誤爆防止のため、落とした後に
 * 「。」を含む行（実文）が残る場合に限って適用する。あわせて、見出しリストの
 * 直前に単独行で残る投票ウィジェットの設問（「…は何ですか？」）も一緒に落とす。
 */
function trimTailHeadlineRun(blocks) {
  let run = 0;
  outer: for (let bi = blocks.length - 1; bi >= 0; bi--) {
    const block = blocks[bi];
    for (let li = block.length - 1; li >= 0; li--) {
      if (isHeadlineLikeLine(block[li])) run++;
      else break outer;
    }
  }
  if (run < 3) return;
  let restLines = 0;
  let restHasSentence = false;
  let total = 0;
  for (const b of blocks) total += b.length;
  restLines = total - run;
  if (restLines < 1) return;
  let idx = 0;
  for (const b of blocks) {
    for (const line of b) {
      if (idx < restLines && line.includes('。')) restHasSentence = true;
      idx++;
    }
  }
  if (!restHasSentence) return;
  let toRemove = run;
  for (let bi = blocks.length - 1; bi >= 0 && toRemove > 0; bi--) {
    const block = blocks[bi];
    const take = Math.min(block.length, toRemove);
    block.splice(block.length - take, take);
    toRemove -= take;
  }
  // 見出しリストの直前に残った単独ブロックの質問行（投票ウィジェットの設問）
  for (let bi = blocks.length - 1; bi >= 0; bi--) {
    const block = blocks[bi];
    if (!block.length) continue;
    if (block.length === 1) {
      const t = block[0].trim();
      if (t.length < 50 && !t.includes('。') && /[？?]$/.test(t)) block.splice(0, 1);
    }
    break;
  }
}

/** タイトル照合用のキー: 検索用の正規化（NFKC・表記ゆれ）の上で、空白・句読点・括弧類を落とす。 */
export function titleMatchKey(s) {
  return normalizeTitleText(normalizeForSearch(s));
}

/** 照合キーとして短すぎるタイトルは一般的な語句と衝突しやすいため対象にしない。 */
const OTHER_TITLE_MIN_KEY = 10;
/** 行末尾に付く配信日時の表記（タイトル＋日時だけの行を照合可能にするため除いて比べる）。 */
const TRAILING_DATETIME_RES = [
  /[\s　]+\d{1,2}\/\d{1,2}\([月火水木金土日]\)[\s　]*\d{1,2}:\d{2}(?::\d{2})?[\s　]*$/,
  /[\s　]+\d{4}\/\d{1,2}\/\d{1,2}[\s　]+\d{1,2}:\d{2}(?::\d{2})?[\s　]*$/,
];

/**
 * 記事タイトル群から「照合キー → そのタイトルを持つクラスタIDの集合」の索引を作る（方式2）。
 * titleRows は { cluster_id, title } の配列。キーが短すぎるタイトルは索引に入れない。
 */
export function buildTitleClusterIndex(titleRows) {
  const index = new Map();
  for (const r of titleRows || []) {
    const key = titleMatchKey(r.title);
    if (key.length < OTHER_TITLE_MIN_KEY) continue;
    let set = index.get(key);
    if (!set) index.set(key, (set = new Set()));
    set.add(r.cluster_id);
  }
  return index;
}

/**
 * 行が「他クラスタの記事のタイトル」そのものかどうか（方式2）。
 * 誤爆防止のため、文（。）で終わる行・長すぎる行は対象にせず、一致は完全一致
 * （または末尾の配信日時を除いた一致）に限る。自クラスタにしか無いタイトルは
 * 同一記事の再掲として落とさない。
 */
export function isOtherTitleLine(line, ownClusterId, titleIndex) {
  const t = String(line || '').trim();
  if (t.length < 8 || t.length > 110) return false;
  if (/[。．]$/.test(t)) return false;
  const candidates = [t];
  for (const re of TRAILING_DATETIME_RES) {
    const stripped = t.replace(re, '');
    if (stripped !== t) candidates.push(stripped);
  }
  for (const cand of candidates) {
    const key = titleMatchKey(cand);
    if (key.length < OTHER_TITLE_MIN_KEY) continue;
    const clusters = titleIndex.get(key);
    if (clusters && [...clusters].some((c) => c !== ownClusterId)) return true;
  }
  return false;
}

/**
 * 抽出済み本文テキストからノイズ行を取り除く（保存済み本文への後がけにも使う）。
 * 段落構造（空行区切り）は保持する: 段落ブロック単位で処理し、ブロック内の
 * ノイズ行だけを落とす。連続する重複行も落とす。判定は isNoiseLine に集約する。
 * title を渡すと、先頭にある記事タイトルの重複行も落とす（任意）。
 * dropLine（任意）: 行を受け取り true を返した行も落とす。後がけで方式2
 * （他記事タイトルとの照合）の述語を差し込むために使う。
 * ブロック単位では著者プロフィール段落の除外と、末尾の他記事見出しリストの
 * 除去（trimTailHeadlineRun）も行う。
 */
export function filterBodyLines(text, title = '', dropLine = null) {
  const blocks = [];
  for (const block of String(text || '').split(/\n{2,}/)) {
    if (isProfileBlock(block)) continue;
    const lines = [];
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (!t || isNoiseLine(t)) continue;
      if (dropLine && dropLine(t)) continue;
      if (lines[lines.length - 1] === t) continue;
      lines.push(t);
    }
    if (lines.length) blocks.push(lines);
  }
  dropTitleDupLines(blocks, title);
  trimTailHeadlineRun(blocks);
  // タイトル行の除去で新たに隣接した重複行も落とす（後がけの冪等性を保つ）
  for (const block of blocks) {
    for (let i = block.length - 1; i > 0; i--) {
      if (block[i] === block[i - 1]) block.splice(i, 1);
    }
  }
  return blocks.filter((b) => b.length).map((b) => b.join('\n')).join('\n\n');
}

/**
 * HTMLから本文らしき <p> テキストを連結する（ナビ・広告等の定型ブロックは除去）。
 * title を渡すと、先頭にある記事タイトルの重複行も落とす（任意）。
 */
export function extractBody(html, title = '') {
  let h = String(html || '');
  h = h
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|header|footer|aside|form|noscript|select|button)[\s\S]*?<\/\1>/gi, ' ')
    // 方式1: <a> が <p> 全体を包むリンクカードは、段落に印を付けて collect で落とす
    .replace(/<a\b[^>]*>\s*<p\b/gi, '<p data-ichigyo-link="1"');
  const collect = (source) => {
    const paras = [];
    for (const m of source.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
      if (attrsHaveNoise(m[1])) continue; // <p> 自身がノイズ要素なら拾わない
      if (/\bdata-ichigyo-link\b/.test(m[1])) continue; // <a> で包まれた段落（リンクカード）
      if (isLinkOnlyParagraph(m[2])) continue; // 段落全体がリンク（関連記事の見出し等）
      const t = stripTags(m[2]).trim();
      if (t.length < 25) continue; // 短い断片（リンク・キャプション類）は本文とみなさない
      if (paras[paras.length - 1] === t) continue;
      paras.push(t);
    }
    return paras.join('\n\n'); // 段落構造を空行区切りで保持する（表示側で段落ごとに描く）
  };
  const stripped = stripNoiseElements(h);
  let text = collect(stripped);
  // 安全弁: 構造除去で本文の大半が消えた場合は誤判定とみなし、除去なしの抽出に戻す
  if (text.length < 200) {
    const raw = collect(h);
    if (raw.length >= 200 && text.length < raw.length * 0.2) text = raw;
  }
  return filterBodyLines(text, title).slice(0, 20000);
}

/**
 * ページを取得し、本文テキストと og:image、記者署名をまとめて返す（取れなければ各々 ''）。
 * リダイレクトは手動でたどり、各ホップでSSRFチェックを行う。
 */
async function fetchPage(fetchImpl, url, timeoutMs = TIMEOUT_MS, title = '') {
  const empty = { text: '', imageUrl: '', author: '' };
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
      const text = extractBody(html, title);
      return { text, imageUrl: extractOgImage(html, current), author: extractAuthor(html, text) };
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
 * 戻り値: { text, url, via, imageUrl, imageIds, author }（imageIds は画像を帰属させる記事ID群。
 * Yahoo代替のページから取った画像は、同一記事と判断した代替元記事にも帰属させる。
 * author は記者署名で、本文の採用元ページから取れたものを優先する）。
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

  let best = { text: '', url: '', via: '', imageUrl: '', imageIds: [], author: '' };
  let anyAuthor = ''; // 本文の採用元で署名が取れなかった場合の保険（同一記事の別経路で取れた署名）
  for (const cand of candidates) {
    // Yahoo代替元の記事に既に本文がキャッシュされていれば、それを再利用する（再取得しない）
    let text = cand.altArticle?.body_text || '';
    let imageUrl = '';
    let author = cand.altArticle?.author || '';
    if (!text) {
      // タイトル重複行の除去のため、取得ページに対応する記事のタイトルを渡す
      const page = await fetchPage(ctx.fetchImpl, cand.url, TIMEOUT_MS, cand.altArticle ? cand.altArticle.title : article.title);
      text = page.text;
      imageUrl = page.imageUrl;
      author = page.author;
    }
    if (author && !anyAuthor) anyAuthor = author;
    if (imageUrl && !best.imageUrl) {
      best.imageUrl = imageUrl;
      best.imageIds = cand.altArticle ? [article.id, cand.altArticle.id] : [article.id];
    }
    if (text.length > best.text.length) best = { ...best, text, url: cand.url, via: cand.via, author };
    if (text.length >= FULL_BODY_CHARS) break;
  }
  if (!best.author) best.author = anyAuthor;
  return best;
}

/**
 * クラスタ内の全記事について本文取得を試みる（未試行か、前回試行から24時間経ったものだけ）。
 * 戻り値: { attempted, got, resolved, images, authors }（got は今回新たに本文が取れた件数、
 * resolved は今回新たに実URLを解決できた件数、authors は今回新たに記者署名が取れた件数）。
 * クラスタがなければ null。
 * オプション resolveGoogle=false でラッパーURL解決を無効化できる（計測・切り分け用）。
 */
export async function fetchClusterBodies(db, clusterId, { fetchImpl = fetch, resolveGoogle = true } = {}) {
  const cluster = db.prepare('SELECT id FROM clusters WHERE id = ?').get(clusterId);
  if (!cluster) return null;
  const articles = db.prepare('SELECT id, source, title, summary, url, resolved_url, body_text, body_fetched_at, author FROM articles WHERE cluster_id = ?').all(clusterId);
  const now = Date.now();
  const targets = articles.filter(
    (a) => !a.body_text && (!a.body_fetched_at || now - new Date(a.body_fetched_at).getTime() > RETRY_MS),
  );
  const update = db.prepare('UPDATE articles SET body_text = ?, body_fetched_at = ?, body_url = ?, body_via = ?, author = ?, search_text = ?, extract_text = ? WHERE id = ?');
  const imgUpdate = db.prepare("UPDATE articles SET image_url = ?, image_via = 'og' WHERE id = ? AND image_url = ''");
  const imgAttempt = db.prepare('UPDATE articles SET image_fetched_at = ? WHERE id = ? AND image_fetched_at IS NULL');
  const ctx = { fetchImpl, resolveGoogle, resolveBudget: { left: MAX_RESOLUTIONS }, resolvedCount: 0 };
  let got = 0;
  let images = 0;
  let authors = 0;
  await runPool(targets, MAX_PARALLEL, async (a) => {
    const best = await fetchArticleBody(db, a, articles, ctx);
    if (best.text) got++;
    if (best.author && !a.author) authors++;
    const nowIso = new Date().toISOString();
    update.run(best.text, nowIso, best.url, best.via, best.author || a.author || '', buildArticleSearchText(a.title, a.summary, best.text), best.text ? extractKeyPoints(a.title, best.text) : '', a.id);
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
    if (best.author) { a.author = best.author; } // 同上（署名も再利用する）
  });
  return { attempted: targets.length, got, resolved: ctx.resolvedCount, images, authors };
}

// ---------- 段階3: 重要タブ上位クラスタの og:image 裏取得 ----------
// refresh 完了後に背後で回し、一覧のサムネイル充足率を底上げする。refresh 自体はブロックしない。
// 画像はURLの参照のみで、ダウンロード保存はしない。

const IMAGE_BATCH_LIMIT = 50; // 1回のバッチで処理するクラスタ数の上限
const IMAGE_BATCH_TIMEOUT_MS = 8000;
const IMAGE_BATCH_PARALLEL = 4;
const IMPORTANT_THRESHOLD = 40; // server.mjs の重要タブ閾値と合わせる

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
