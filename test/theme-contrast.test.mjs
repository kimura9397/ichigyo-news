// テーマのコントラスト監査（WCAG AA 相当を数値で固定する）。
// - 通常テキストのペアは 4.5:1 以上（ink / muted / 朱色アクセント / fresh の各前景 × paper / 背景）
// - 朱色地の上の文字（危険ボタン等）も 4.5:1 以上
// - バッジ（アクセント色テキスト × 同色12%の色混合地）も 4.5:1 以上
// - 境界線（--line）は UI 要素として 3:1 以上
// - 既読の薄表示（.row.is-read の opacity で ink を paper に混ぜた実効色）も 4.5:1 以上
// パレットは frontend/src/index.css の :root（ライト）と [data-theme='dark']（ダーク）から読む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'frontend/src/index.css'), 'utf8');
const appCss = readFileSync(join(ROOT, 'frontend/src/App.css'), 'utf8');

function blockVars(selectorRe) {
  const m = css.match(selectorRe);
  assert.ok(m, `CSSブロックが見つかりません: ${selectorRe}`);
  const vars = {};
  for (const vm of m[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) vars[vm[1]] = vm[2];
  const bg = m[1].match(/background:\s*(#[0-9a-fA-F]{6})/);
  if (bg) vars.__bg = bg[1];
  return vars;
}

const light = blockVars(/:root\s*\{([\s\S]*?)\n\}/);
const darkOverrides = blockVars(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/);
const dark = { ...light, ...darkOverrides };

function rgb(hex) {
  return [0, 2, 4].map((i) => parseInt(hex.slice(1).slice(i, i + 2), 16));
}
function luminance(hex) {
  const [r, g, b] = rgb(hex)
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
function mix(hex1, p, hex2) {
  const a = rgb(hex1);
  const b = rgb(hex2);
  return `#${a.map((v, i) => Math.round(v * p + b[i] * (1 - p)).toString(16).padStart(2, '0')).join('')}`;
}

const TEXT_MIN = 4.5;
const UI_MIN = 3.0;

// アクセント色（data-accent の --vermillion 上書き）: 朱以外の選択肢が両テーマ分の値を持ち、
// 朱色と同じペア基準を満たすことを固定する。
const accentLight = new Map();
const accentDark = new Map();
for (const m of css.matchAll(/:root\[data-accent='(\w+)'\]\s*\{\s*--vermillion:\s*(#[0-9a-fA-F]{6})/g)) {
  accentLight.set(m[1], m[2]);
}
for (const m of css.matchAll(/:root\[data-theme='dark'\]\[data-accent='(\w+)'\]\s*\{\s*--vermillion:\s*(#[0-9a-fA-F]{6})/g)) {
  accentDark.set(m[1], m[2]);
}

test('アクセント色の選択肢が両テーマ分の値を持つ', () => {
  assert.ok(accentLight.size >= 3, `アクセントの選択肢が少なすぎます: ${accentLight.size}`);
  for (const id of accentLight.keys()) {
    assert.ok(accentDark.has(id), `アクセント ${id} のダーク値がありません`);
  }
});

for (const [id, lightValue] of accentLight) {
  test(`アクセント ${id}: 両テーマで ${TEXT_MIN}:1 以上`, () => {
    const darkValue = accentDark.get(id);
    const pairs = [
      ['ライト accent/paper', lightValue, light.paper],
      ['ライト accent/bg', lightValue, light.__bg],
      ['ライト paper/accent', light.paper, lightValue],
      ['ライト バッジ', lightValue, mix(lightValue, 0.12, light['tint-base'])],
      ['ダーク accent/paper', darkValue, dark.paper],
      ['ダーク accent/bg', darkValue, dark.__bg],
      ['ダーク paper/accent', dark.paper, darkValue],
      ['ダーク バッジ', darkValue, mix(darkValue, 0.12, dark['tint-base'])],
    ];
    for (const [label, fg, bg] of pairs) {
      const r = contrast(fg, bg);
      assert.ok(r >= TEXT_MIN, `${label} = ${r.toFixed(2)} < ${TEXT_MIN}`);
    }
  });
}

for (const [name, t] of [['ライト', light], ['ダーク', dark]]) {
  test(`${name}テーマ: テキストペアが ${TEXT_MIN}:1 以上`, () => {
    const pairs = [
      ['ink/paper', t.ink, t.paper],
      ['ink/bg', t.ink, t.__bg],
      ['muted/paper', t.muted, t.paper],
      ['muted/bg', t.muted, t.__bg],
      ['vermillion/paper', t.vermillion, t.paper],
      ['vermillion/bg', t.vermillion, t.__bg],
      ['fresh/paper', t.fresh, t.paper],
      ['paper/vermillion（朱地の文字）', t.paper, t.vermillion],
    ];
    for (const [label, fg, bg] of pairs) {
      assert.ok(fg && bg, `${label} の色が読めません`);
      const r = contrast(fg, bg);
      assert.ok(r >= TEXT_MIN, `${name} ${label} = ${r.toFixed(2)} < ${TEXT_MIN}`);
    }
  });

  test(`${name}テーマ: バッジ（色混合地）が ${TEXT_MIN}:1 以上、境界線が ${UI_MIN}:1 以上`, () => {
    const badgeImportant = contrast(t.vermillion, mix(t.vermillion, 0.12, t['tint-base']));
    assert.ok(badgeImportant >= TEXT_MIN, `${name} 重要バッジ = ${badgeImportant.toFixed(2)}`);
    const badgeFresh = contrast(t.fresh, mix(t.fresh, 0.12, t['tint-base']));
    assert.ok(badgeFresh >= TEXT_MIN, `${name} 新着バッジ = ${badgeFresh.toFixed(2)}`);
    assert.ok(contrast(t.line, t.paper) >= UI_MIN, `${name} line/paper = ${contrast(t.line, t.paper).toFixed(2)}`);
    assert.ok(contrast(t.line, t.__bg) >= UI_MIN, `${name} line/bg = ${contrast(t.line, t.__bg).toFixed(2)}`);
  });

  test(`${name}テーマ: 既読の薄表示でも ${TEXT_MIN}:1 以上`, () => {
    const m = appCss.match(/\.row\.is-read\s*\{\s*opacity:\s*([\d.]+)/);
    assert.ok(m, '.row.is-read の opacity が読めません');
    const opacity = Number(m[1]);
    const effective = mix(t.ink, opacity, t.paper);
    const r = contrast(effective, t.paper);
    assert.ok(r >= TEXT_MIN, `${name} 既読行 = ${r.toFixed(2)} < ${TEXT_MIN}（opacity ${opacity}）`);
  });
}
