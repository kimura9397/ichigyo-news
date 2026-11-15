/**
 * 「要点」抽出（ルールベース、LLM不採用 — 2026-11-15 再確認）。
 *
 * 従来の表示は RSS 由来の要約（実質リード文の抜粋）で、「見出しに付随する情報」に
 * 留まっていた。本文が取れている記事では、本文の中から「新しい事実を含む文」を
 * 選んで要点とする。文そのものは原文ママ（書き換えはしない）、並びは記事内の出現順。
 *
 * 文の選択:
 * - 見出しの言い換えにすぎない文は落とす（見出しとのバイグラム包含率が高い文）。
 * - 数値・引用・固有名詞らしい語（カタカナ長めの語など）を含む文を優先する。
 * - 長さの規律: 最大3文・合計240字まで（現行のバラつきを抑える）。
 */

/** 要点の最大文数。 */
export const EXTRACT_MAX_SENTENCES = 3;
/** 要点の最大文字数。 */
export const EXTRACT_MAX_CHARS = 240;

function bigrams(text) {
  const s = String(text || '').replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 本文を文に割る（。！？と改行を境界にする）。 */
export function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[。！？])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function sentenceScore(sentence) {
  let score = 0;
  if (/[0-9０-９]/.test(sentence)) score += 3; // 数値は事実の核になりやすい
  if (/「|『|【/.test(sentence)) score += 2; // 引用・発言
  const katakana = sentence.match(/[ァ-ヶー]{3,}/g) || [];
  score += Math.min(katakana.length, 3); // 固有名詞らしいカタカナ語
  const latin = sentence.match(/[A-Za-z]{4,}/g) || [];
  score += Math.min(latin.length, 2);
  const kanjiRuns = sentence.match(/[一-龯]{5,}/g) || [];
  score += Math.min(kanjiRuns.length, 2); // 長い漢字連続（制度名・組織名など）
  if (sentence.length >= 20 && sentence.length <= 120) score += 1;
  return score;
}

/**
 * 見出しと本文から要点を作る。本文が無い・短すぎる場合は '' を返す
 * （その場合は従来どおり RSS 要約が表示される）。
 */
export function extractKeyPoints(title, bodyText) {
  const all = splitSentences(bodyText).filter((s) => s.length >= 10);
  if (!all.length) return '';
  // 本文の末尾に混ざる「関連見出しの羅列」のような断片は、句点で終わらず長さも
  // バラバラで、数値を含むためスコアが高くなりがち（実測: NHK本文）。
  // 句点（。！？）で終わる文だけを候補にする。無ければ全てを候補にする。
  const terminated = all.filter((s) => /[。！？][」』）)]?$/.test(s));
  const sentences = terminated.length ? terminated : all;
  const titleBg = bigrams(title);
  // 話題の基準: 見出し＋本文の最初の文。これと語彙を共有しない文は、本文末尾に
  // 混ざる無関係な見出し断片（句点や「？」で終わるものもある）の可能性が高いので
  // 候補にしない（最初の文自身は常に候補）。
  const refBg = bigrams(`${title} ${sentences[0] || ''}`);
  const candidates = [];
  sentences.forEach((s, idx) => {
    const bg = bigrams(s);
    let shared = 0;
    for (const g of bg) if (titleBg.has(g)) shared++;
    const containment = bg.size ? shared / bg.size : 0;
    // 見出しの言い換えにすぎない文は落とす。判定は2軸: 文の側の包含率が高い場合と、
    // 見出しの大部分をカバーしつつ新しい情報が薄い場合（詳細を含むリード文は
    // 包含率が低くなるので巻き込まない）。
    const titleCoverage = titleBg.size ? shared / titleBg.size : 0;
    if (containment >= 0.55 || (titleCoverage >= 0.7 && containment >= 0.4)) return;
    if (idx > 0) {
      // 共有の数え方は内容語のバイグラムだけにする（「ます」「す。」のような
      // 文法・句読点の断片は、無関係な定型文でも一致してしまうため）
      let refShared = 0;
      for (const g of bg) {
        if (!/^[ぁ-ヶ一-龯A-Za-z0-9０-９]{2}$/.test(g)) continue;
        if (refBg.has(g)) refShared++;
      }
      if (refShared < 2) return; // 話題と無関係な断片は落とす
    }
    candidates.push({ s, idx, score: sentenceScore(s) });
  });
  if (!candidates.length) return '';
  // スコア順（同点は出現順）に、文字数上限の範囲で貪欲に選ぶ
  const ranked = [...candidates].sort((a, b) => b.score - a.score || a.idx - b.idx);
  const picked = [];
  let total = 0;
  for (const c of ranked) {
    if (picked.length >= EXTRACT_MAX_SENTENCES) break;
    if (picked.length > 0 && total + c.s.length > EXTRACT_MAX_CHARS) continue;
    picked.push(c);
    total += c.s.length;
  }
  if (!picked.length) {
    // 全文が上限を超える長文ばかりの場合は、最も短い文を1つだけ採る
    const shortest = [...candidates].sort((a, b) => a.s.length - b.s.length)[0];
    return shortest.s;
  }
  picked.sort((a, b) => a.idx - b.idx); // 並びは記事内の出現順に戻す
  return picked.map((c) => c.s).join('');
}
