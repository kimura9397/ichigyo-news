// GoogleニュースのラッパーURL（https://news.google.com/rss/articles/... 等）から
// 媒体サイトの実URLを解決するモジュール。
//
//
// この解決は Google が公式に公開しているAPIではなく、news.google.com の記事ページが
// 内部で使っている batchexecute RPC（Fbv4je / garturlreq）の既知の方式に依存している。
// Google 側の仕様変更で予告なく動かなくなる可能性があるため、呼び出し側は
// 「失敗したら空文字が返る」前提でフォールバック（要約表示）を必ず用意すること。
// 解決できたURLは articles.resolved_url にキャッシュし、記事ごとに1回だけ試みる。
//
// 方式の概要（googlenewsdecoder 等で知られる公開手法）:
// 1. ラッパーURLの記事ページHTMLを取得し、data-n-a-sg（署名）と data-n-a-ts（時刻）を抜く
// 2. それらと記事IDを batchexecute に POST し、応答中の "garturlres" の実URLを取り出す

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const GET_TIMEOUT_MS = 8000;
const POST_TIMEOUT_MS = 8000;

/** GoogleニュースのラッパーURLか（記事ページへの実リンクではなく中継URL）。 */
export function isGoogleNewsUrl(rawUrl) {
try {
const u = new URL(rawUrl);
return u.hostname === 'news.google.com' && /^\/(rss\/)?articles\//.test(u.pathname);
} catch {
return false;
}
}

async function timedFetch(fetchImpl, url, init, timeoutMs) {
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), timeoutMs);
try {
return await fetchImpl(url, {...init, signal: ctrl.signal});
} finally {
clearTimeout(timer);
}
}

/** batchexecute の応答テキストから "garturlres" の実URLを取り出す。取れなければ ''。 */
export function parseResolvedUrl(responseText) {
const idx = String(responseText || '').indexOf('garturlres');
if (idx < 0) return '';
const rest = String(responseText).slice(idx, idx + 4000);
// URLは \" で囲まれている。生の " まではエスケープシーケンス（\u0026 等）も含めて取り出す
const m = rest.match(/https?:[^"]+/);
if (!m) return '';
let url = m[0].replace(/\\$/, ''); // 区切りの \" のバックスラッシュが末尾に残るので落とす
try {
// 応答内では \u0026 や \/ のようにエスケープされているので、JSON文字列として復元する
url = JSON.parse(`"${url}"`);
} catch { /* 復元できなければ生のまま使う */}
try {
const u = new URL(url);
return u.protocol === 'http:' || u.protocol === 'https:'? u.toString(): '';
} catch {
return '';
}
}

/**
* ラッパーURLから実URLを解決する。失敗時は例外を投げず '' を返す。
* 戻り値が '' の場合は「解決できなかった」であり、呼び出し側は要約表示にフォールバックすること。
*/
export async function resolveGoogleNewsUrl(rawUrl, { fetchImpl = fetch} = {}) {
try {
if (!isGoogleNewsUrl(rawUrl)) return '';
const articleId = new URL(rawUrl).pathname.split('/').filter(Boolean).pop();
if (!articleId) return '';

// 1. 記事ページHTMLから署名・時刻と cookie を得る
const pageRes = await timedFetch(fetchImpl, rawUrl, {
headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'ja,en;q=0.8'},
}, GET_TIMEOUT_MS);
if (!pageRes.ok) return '';
const html = await pageRes.text();
const sg = (html.match(/data-n-a-sg="([^"]+)"/) || [])[1];
const ts = (html.match(/data-n-a-ts="([^"]+)"/) || [])[1];
if (!sg ||!ts) return '';
const cookie = typeof pageRes.headers?.getSetCookie === 'function'
? pageRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
: '';

// 2. batchexecute RPC で実URLを得る
const payload = '[["Fbv4je","[\\"garturlreq\\",[[\\"en-US\\",\\"US\\",[\\"FINANCE_TOP_INDICES\\",\\"WEB_TEST_1_0_0\\"],null,null,1,1,\\"US:en\\",null,180,null,null,null,null,null,0,null,null,[1608992183,723341000]],\\"en-US\\",\\"US\\",1,[2,3,4,8],1,0,\\"655000234\\",0,0,null,0],\\"'
+ articleId + '\\",' + ts + ',\\"' + sg + '\\"]",null,"generic"]]';
const postRes = await timedFetch(fetchImpl, 'https://news.google.com/_/DotsSplashUi/data/batchexecute', {
method: 'POST',
headers: {
'user-agent': UA,
'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
...(cookie? { cookie}: {}),
referer: rawUrl,
},
body: new URLSearchParams({ 'f.req': payload}).toString(),
}, POST_TIMEOUT_MS);
if (!postRes.ok) return '';
return parseResolvedUrl(await postRes.text());
} catch {
return ''; // タイムアウト・ネットワーク失敗・形式変更はいずれも「解決失敗」として扱う
}
}
