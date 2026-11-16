/**
 * キーワードウォッチの登録キーワード（サーバー側保存）。
 *
 * キーワードは二役を担う（2026-11-15 ユーザー決定）:
 * 1. ウォッチ/検索ビューの照合条件（src/normalize.mjs の正規化＋タイトル・要約への照合）
 * 2. 更新時の収集クエリ — 登録キーワードごとに Google News のキーワード検索RSSを
 *    取得し、通常のパイプラインで取り込む（src/collector.mjs の refresh が使う）。
 * 以前は localStorage 保存だったが、収集に使うためサーバー側（DB）へ移した。
 */

/** 登録できるキーワード数の上限。 */
export const MAX_KEYWORDS = 20;
/** 1キーワードの最大文字数。 */
export const MAX_KEYWORD_LENGTH = 50;

/** 入力の正規化: カンマは区切りと衝突するので空白に置換し、空白を畳む（旧フロント側の規則を継承）。 */
export function cleanKeywordInput(raw) {
  return String(raw ?? '').replace(/,/g, ' ').trim().replace(/\s+/g, ' ');
}

/** 登録順にキーワードを返す。 */
export function listKeywords(db) {
  return db.prepare('SELECT keyword FROM watch_keywords ORDER BY id').all().map((r) => r.keyword);
}

/**
 * キーワードを追加する。戻り値: { added, keywords, error? }
 * 空・長すぎ・上限到達は error を返し、重複は added=false で現状を返す。
 */
export function addKeyword(db, raw) {
  const keyword = cleanKeywordInput(raw);
  if (!keyword) return { added: false, keywords: listKeywords(db), error: 'キーワードが空です' };
  if (keyword.length > MAX_KEYWORD_LENGTH) {
    return { added: false, keywords: listKeywords(db), error: `キーワードは${MAX_KEYWORD_LENGTH}文字以内にしてください` };
  }
  const current = listKeywords(db);
  if (current.includes(keyword)) return { added: false, keywords: current };
  if (current.length >= MAX_KEYWORDS) {
    return { added: false, keywords: current, error: `キーワードは${MAX_KEYWORDS}件までです` };
  }
  db.prepare('INSERT INTO watch_keywords (keyword, created_at) VALUES (?, ?)').run(keyword, new Date().toISOString());
  return { added: true, keywords: listKeywords(db) };
}

/** キーワードを削除する。戻り値: { removed, keywords } */
export function removeKeyword(db, raw) {
  const keyword = cleanKeywordInput(raw);
  const info = db.prepare('DELETE FROM watch_keywords WHERE keyword = ?').run(keyword);
  return { removed: Number(info.changes) > 0, keywords: listKeywords(db) };
}
