// 更新確認: GitHub Releases の latest を確認し、現行バージョンより新しい版が
// あればその情報を返す（Issue #26、2026-11-19 ユーザー設計）。
// - 呼び出しは server.mjs の起動時に1回と、設定メニューの「更新を確認」
//   （POST /api/update-check）の手動再チェック時。ポーリングには相乗りさせない
// - 取得に失敗したら null を返す（何も知らせない）。新しい版がなくても null
// - /releases/latest は GitHub の仕様でドラフトとプレリリースを除いた最新の
//   安定版を返すので、ここで追加の除外はしない
// - 外部依存なし。タイムアウトと応答サイズ上限は RSS 取得と同じ流儀
import { readResponseText } from './rss.mjs';

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/kimura9397/ichigyo-news/releases/latest';

const FETCH_TIMEOUT_MS = 8000;
/** リリース情報（JSON）の読み取り上限（バイト）。リリースノートを含んでも十分な大きさ。 */
const MAX_RELEASE_BYTES = 1024 * 1024;

/**
 * バージョン文字列を { core: number[], prerelease: string[] | null } に分解する。
 * 先頭の 'v' とビルドメタデータ（'+' 以降）は無視する。コアが数値でない部分を
 * 含むなど解釈できない場合は null。
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  let s = value.trim().replace(/^v/i, '');
  const plus = s.indexOf('+');
  if (plus >= 0) s = s.slice(0, plus);
  const dash = s.indexOf('-');
  const corePart = dash >= 0 ? s.slice(0, dash) : s;
  const prePart = dash >= 0 ? s.slice(dash + 1) : null;
  if (!corePart) return null;
  const core = [];
  for (const part of corePart.split('.')) {
    if (!/^\d+$/.test(part)) return null;
    core.push(Number(part));
  }
  return { core, prerelease: prePart === null ? null : prePart.split('.') };
}

/** プレリリース同士の比較（SemVer の規則: 数値識別子は数値として、短い方が小さい）。 */
function comparePrerelease(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) < Number(y) ? -1 : 1;
    if (xNum) return -1; // 数値識別子は英数字識別子より小さい
    if (yNum) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * a が b より新しければ 1、同じなら 0、古ければ -1。
 * どちらかが解釈できない場合は 0（=新しくない扱い。誤って知らせない側に倒す）。
 */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;
  const len = Math.max(va.core.length, vb.core.length);
  for (let i = 0; i < len; i++) {
    const x = va.core[i] ?? 0;
    const y = vb.core[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  // コアが同じなら、プレリリース付きは正式版より古い
  if (va.prerelease === null && vb.prerelease === null) return 0;
  if (va.prerelease === null) return 1;
  if (vb.prerelease === null) return -1;
  return comparePrerelease(va.prerelease, vb.prerelease);
}

/** latest が current より新しい版か。 */
export function isNewerVersion(latest, current) {
  return compareVersions(latest, current) > 0;
}

/**
 * GitHub Releases の latest を1回取得し、版の新旧によらずリリース情報を
 * { version, url, notes, publishedAt } で返す。取得に失敗した・応答が想定外の
 * 場合は null。手動の「更新を確認」（POST /api/update-check）が、最新版か
 * どうかと取得失敗を区別するために使う。
 * fetchImpl はテスト用の差し替え口（通常はグローバルの fetch）。
 */
export async function fetchLatestRelease({ url = LATEST_RELEASE_URL, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'ichigyo-news update check',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res || !res.ok) return null;
    const data = JSON.parse(await readResponseText(res, MAX_RELEASE_BYTES));
    const tag = typeof data?.tag_name === 'string' ? data.tag_name : '';
    if (!tag) return null;
    return {
      version: tag.replace(/^v/i, ''),
      url: typeof data.html_url === 'string' ? data.html_url : '',
      notes: typeof data.body === 'string' ? data.body : '',
      publishedAt: typeof data.published_at === 'string' ? data.published_at : null,
    };
  } catch {
    return null;
  }
}

/**
 * GitHub Releases の latest を1回確認する。新しい版がある場合だけ
 * { version, url, notes, publishedAt } を返し、それ以外（新版なし・取得失敗・
 * 応答が想定外）はすべて null を返す。
 * fetchImpl はテスト用の差し替え口（通常はグローバルの fetch）。
 */
export async function checkLatestRelease({ currentVersion, url = LATEST_RELEASE_URL, fetchImpl = fetch } = {}) {
  const latest = await fetchLatestRelease({ url, fetchImpl });
  if (!latest || !isNewerVersion(latest.version, currentVersion)) return null;
  return latest;
}
