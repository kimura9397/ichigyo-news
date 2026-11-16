// テーマプリセットのコントラスト監査（WCAG AA 相当を数値で固定する）。
// - 通常テキストのペアは 4.5:1 以上（ink / muted / アクセント / fresh の各前景 × paper / 背景）
// - アクセント地の上の文字も 4.5:1 以上
// - バッジ（色テキスト × 同色12%の色混合地）も 4.5:1 以上
// - 境界線（--line）は UI 要素として 3:1 以上
// - 既読の薄表示（.row.is-read の opacity で ink を paper に混ぜた実効色）も 4.5:1 以上
// パレットは frontend/src/index.css の :root（紙）と [data-theme='...']（古紙／白黒／灯／墨）から読む。
// プリセット構成は 2026-11-16 のユーザー決定（旧テーマ＋アクセント色の一本化）。
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

const base = blockVars(/:root\s*\{([\s\S]*?)\n\}/);
// :root 自体が「紙」プリセット。各プリセットは :root の変数を上書きする形で解決する。
const PRESETS = [
  ['紙', base],
  ['古紙', { ...base, ...blockVars(/:root\[data-theme='koshi'\]\s*\{([\s\S]*?)\n\}/) }],
  ['白黒', { ...base, ...blockVars(/:root\[data-theme='shirokuro'\]\s*\{([\s\S]*?)\n\}/) }],
  ['灯', { ...base, ...blockVars(/:root\[data-theme='akari'\]\s*\{([\s\S]*?)\n\}/) }],
  ['墨', { ...base, ...blockVars(/:root\[data-theme='sumi'\]\s*\{([\s\S]*?)\n\}/) }],
];

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
const COLOR_VARS = ['ink', 'muted', 'paper', 'line', 'vermillion', 'fresh', 'tint-base'];

test('アクセント色の単独設定（data-accent）は廃止されている', () => {
  assert.ok(!css.includes('data-accent'), 'index.css に data-accent が残っています');
});

test('プリセットの id が App.tsx の定義と index.html の先行スクリプトに揃っている', () => {
  const appTsx = readFileSync(join(ROOT, 'frontend/src/App.tsx'), 'utf8');
  const indexHtml = readFileSync(join(ROOT, 'frontend/index.html'), 'utf8');
  // :root（紙）以外の data-theme プリセット＋ system を対象にする
  const ids = ['koshi', 'shirokuro', 'akari', 'sumi', 'system'];
  for (const id of ids) {
    assert.ok(appTsx.includes(`id: '${id}'`), `App.tsx の THEME_PRESETS に '${id}' がありません`);
    assert.ok(indexHtml.includes(`'${id}'`), `index.html の PRESETS に '${id}' がありません`);
  }
  for (const id of ['koshi', 'shirokuro', 'akari', 'sumi']) {
    assert.ok(css.includes(`[data-theme='${id}']`), `index.css に '${id}' のパレットがありません`);
  }
});

test('紙プリセットのアクセントはブランドの朱', () => {
  assert.equal(base.vermillion, '#b13224');
});

for (const [name, t] of PRESETS) {
  test(`${name}プリセット: パレットの色変数が揃っている`, () => {
    for (const v of COLOR_VARS) assert.ok(t[v], `${name} の --${v} が読めません`);
    assert.ok(t.__bg, `${name} の background が読めません`);
  });

  test(`${name}プリセット: テキストペアが ${TEXT_MIN}:1 以上`, () => {
    const pairs = [
      ['ink/paper', t.ink, t.paper],
      ['ink/bg', t.ink, t.__bg],
      ['muted/paper', t.muted, t.paper],
      ['muted/bg', t.muted, t.__bg],
      ['vermillion/paper', t.vermillion, t.paper],
      ['vermillion/bg', t.vermillion, t.__bg],
      ['fresh/paper', t.fresh, t.paper],
      ['paper/vermillion（アクセント地の文字）', t.paper, t.vermillion],
    ];
    for (const [label, fg, bg] of pairs) {
      const r = contrast(fg, bg);
      assert.ok(r >= TEXT_MIN, `${name} ${label} = ${r.toFixed(2)} < ${TEXT_MIN}`);
    }
  });

  test(`${name}プリセット: バッジ（色混合地）が ${TEXT_MIN}:1 以上、境界線が ${UI_MIN}:1 以上`, () => {
    const badgeImportant = contrast(t.vermillion, mix(t.vermillion, 0.12, t['tint-base']));
    assert.ok(badgeImportant >= TEXT_MIN, `${name} 重要バッジ = ${badgeImportant.toFixed(2)}`);
    const badgeFresh = contrast(t.fresh, mix(t.fresh, 0.12, t['tint-base']));
    assert.ok(badgeFresh >= TEXT_MIN, `${name} 新着バッジ = ${badgeFresh.toFixed(2)}`);
    assert.ok(contrast(t.line, t.paper) >= UI_MIN, `${name} line/paper = ${contrast(t.line, t.paper).toFixed(2)}`);
    assert.ok(contrast(t.line, t.__bg) >= UI_MIN, `${name} line/bg = ${contrast(t.line, t.__bg).toFixed(2)}`);
  });

  test(`${name}プリセット: 既読の薄表示でも ${TEXT_MIN}:1 以上`, () => {
    const m = appCss.match(/\.row\.is-read\s*\{\s*opacity:\s*([\d.]+)/);
    assert.ok(m, '.row.is-read の opacity が読めません');
    const opacity = Number(m[1]);
    const effective = mix(t.ink, opacity, t.paper);
    const r = contrast(effective, t.paper);
    assert.ok(r >= TEXT_MIN, `${name} 既読行 = ${r.toFixed(2)} < ${TEXT_MIN}（opacity ${opacity}）`);
  });
}
