// 一覧サムネイルのレイアウトの静的検査（2026-11-16 ユーザー実機報告）。
// flex の固定列だと、サムネイルがある行はテキスト幅が画像の高さを超えても
// 狭いままになり、画像なしの行より1行の文字数が大きく減っていた。
// 画像を float にしてテキストを回り込ませる方式を固定する。
// flex コンテナ（.row-meta / .row-foot）の中身は float を回り込めないため、
// そちらも通常フローにしていることも併せて固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const appCss = readFileSync(join(ROOT, 'frontend/src/App.css'), 'utf8');

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function rulesBySelector(css) {
  const map = new Map();
  for (const m of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    if (!selector || selector.startsWith('@')) continue;
    map.set(selector, `${map.get(selector) ?? ''}\n${m[2]}`);
  }
  return map;
}

const rules = rulesBySelector(appCss);

test('.row-thumb: float で左に置く（固定列にしない）', () => {
  const body = rules.get('.row-thumb');
  assert.ok(body, '.row-thumb の定義がありません');
  assert.match(body, /float:\s*left/, 'float: left のはず');
  assert.doesNotMatch(body, /flex:/, 'flex 項目に戻っていないはず');
});

test('.row: flow-root で float を行内に収め、flex に戻っていない', () => {
  const body = rules.get('.row');
  assert.ok(body, '.row の定義がありません');
  assert.match(body, /display:\s*flow-root/, 'display: flow-root のはず');
  assert.doesNotMatch(body, /display:\s*flex/, 'display: flex に戻っていないはず');
});

test('.row-main: テキスト列を固定幅にしない', () => {
  const body = rules.get('.row-main');
  if (body) assert.doesNotMatch(body, /flex:/, 'flex 宣言が残っていないはず');
});

test('.row-meta / .row-foot: flex にせず、バッジは右 float', () => {
  const meta = rules.get('.row-meta');
  assert.ok(meta, '.row-meta の定義がありません');
  assert.doesNotMatch(meta, /display:\s*flex/, '.row-meta が flex だと float を回り込めない');
  const foot = rules.get('.row-foot');
  assert.ok(foot, '.row-foot の定義がありません');
  assert.doesNotMatch(foot, /display:\s*flex/, '.row-foot が flex だと float を回り込めない');
  const badges = rules.get('.row-foot .badges');
  assert.ok(badges, '.row-foot .badges の定義がありません');
  assert.match(badges, /float:\s*right/, 'バッジは float: right のはず');
});
