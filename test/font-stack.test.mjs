// フォントスタックの静的検査（2026-11-15 ユーザー実機の「文字が掠れる」報告への是正を固定する）。
// - 明朝（--serif）を使ってよいのはブランド要素だけ: マストヘッドのタイトル（.brand h1）のみ
//   （2026-11-16 ユーザー決定で詳細タイトルも含め全面ゴシック化）。本文サイズの要素に
//   明朝を戻すと Windows で掠れる。
// - ゴシック（--sans）は Windows で掠れない構成にする: Hiragino Sans（Mac）→ Noto Sans JP →
//   游ゴシック差し替え（'Yu Gothic Remap'）→ 素の Yu Gothic UI / Yu Gothic の順。
// - 'Yu Gothic Remap' は @font-face で 400 に Yu Gothic Medium、700 に Yu Gothic Bold を割り当てる
//   （素の Yu Gothic Regular は字形が細く、Chrome の本文サイズで掠れるため）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexCss = readFileSync(join(ROOT, 'frontend/src/index.css'), 'utf8');
const appCss = readFileSync(join(ROOT, 'frontend/src/App.css'), 'utf8');

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// セレクタ → 宣言本文の対応表（@media 内のルールも拾う。同一セレクタは連結する）
function rulesBySelector(css) {
  const map = new Map();
  for (const m of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    if (!selector || selector.startsWith('@')) continue;
    map.set(selector, `${map.get(selector) ?? ''}\n${m[2]}`);
  }
  return map;
}

test('--sans: Windows で掠れない順序になっている', () => {
  const m = indexCss.match(/--sans:\s*([^;]+);/);
  assert.ok(m, '--sans の定義が読めません');
  const families = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
  const order = ['Hiragino Sans', 'Noto Sans JP', 'Yu Gothic Remap', 'Yu Gothic UI', 'Yu Gothic', 'system-ui'];
  let prev = -1;
  for (const name of order) {
    const idx = families.indexOf(name);
    assert.ok(idx >= 0, `--sans に '${name}' がありません: ${families.join(' / ')}`);
    assert.ok(idx > prev, `--sans の順序が想定と違います: '${name}'`);
    prev = idx;
  }
});

test("@font-face 'Yu Gothic Remap': 400 に Medium、700 に Bold を割り当てる", () => {
  const faces = [...indexCss.matchAll(/@font-face\s*\{([^{}]*)\}/g)].map((m) => m[1]);
  const remap = faces.filter((f) => f.includes("font-family: 'Yu Gothic Remap'"));
  assert.equal(remap.length, 2, `'Yu Gothic Remap' の @font-face は 400/700 の2件のはず: ${remap.length}`);
  const byWeight = new Map();
  for (const f of remap) {
    const w = f.match(/font-weight:\s*(\d+)/);
    assert.ok(w, 'font-weight が読めません');
    byWeight.set(w[1], f);
  }
  assert.ok(byWeight.get('400')?.includes("local('Yu Gothic Medium')"), '400 は Yu Gothic Medium のはず');
  assert.ok(byWeight.get('700')?.includes("local('Yu Gothic Bold')"), '700 は Yu Gothic Bold のはず');
});

test('App.css: 明朝（--serif）を使ってよいのはブランド要素（.brand h1）だけ', () => {
  const allowed = new Set(['.brand h1']);
  const offenders = [];
  for (const [selector, body] of rulesBySelector(appCss)) {
    if (body.includes('font-family: var(--serif)') && !allowed.has(selector)) offenders.push(selector);
  }
  assert.deepEqual(offenders, [], `ブランド要素以外で明朝が使われています: ${offenders.join(', ')}`);
  // ブランド側の1件は明朝のままであることも固定する
  const rules = rulesBySelector(appCss);
  for (const selector of allowed) {
    assert.ok(rules.get(selector)?.includes('font-family: var(--serif)'), `${selector} は明朝のはず`);
  }
});

test('App.css: 本文系の見出し（.detail-head h2 / .paper h3 / .paper-owner）はゴシック', () => {
  const rules = rulesBySelector(appCss);
  for (const selector of ['.detail-head h2', '.paper h3', '.paper-owner']) {
    const body = rules.get(selector);
    assert.ok(body, `${selector} のルールが見つかりません`);
    assert.ok(body.includes('font-family: var(--sans)'), `${selector} は var(--sans) のはず`);
    assert.ok(!body.includes('font-family: var(--serif)'), `${selector} に明朝が残っています`);
  }
});
