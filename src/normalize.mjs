/**
 * キーワード検索/ウォッチの照合用テキスト正規化。
 *
 * 背景（2026-11-15 ユーザー実機バグ）: 検索「情報漏洩」がヒットしない。記事側の表記は
 * 新聞表記の「情報漏えい」が主流（実DBで 漏えい 34件 vs 漏洩 4件）で、部分一致では拾えない。
 * 日本語の表記ゆれを吸収するため、クエリ側と対象テキスト側の両方に同じ正規化を適用する。
 *
 * 正規化の内容:
 * - NFKC（全角英数→半角など）＋英字の小文字化
 * - 表記ゆれ対応表（VARIANT_RULES）: 新聞表記で頻出するゆれを正準形に寄せる。
 *   対応表はここに集約し、[正規表現, 正準形] の組を足すだけで拡張できる。
 *   正準形は「新聞で主流の表記」に寄せる（例: 漏洩→漏えい）。
 */
const VARIANT_RULES = [
  [/漏洩/g, '漏えい'],
  [/障がい/g, '障害'],
  [/斡旋/g, 'あっせん'],
  [/捏造/g, 'ねつ造'],
  [/隠蔽/g, '隠ぺい'],
  [/遵守/g, '順守'],
];

export function normalizeForSearch(text) {
  let s = String(text ?? '').normalize('NFKC').toLowerCase();
  for (const [pattern, canonical] of VARIANT_RULES) s = s.replace(pattern, canonical);
  return s;
}

/** 記事の照合用シャドウテキスト（タイトル＋要約＋取得済み本文を正規化して連結）。 */
export function buildArticleSearchText(title, summary, bodyText) {
  return normalizeForSearch(`${title ?? ''}\n${summary ?? ''}\n${bodyText ?? ''}`);
}
