// 設定メニューのラベルの静的検査（2026-11-16 ユーザー実機報告、Issue #2）。
// 「テーマ」ラベルが1文字ずつ縦に改行される不具合の再発防止。
// .menu-row は flex で、日本語ラベルは任意位置で改行できるため、最小幅が
// 1文字分まで縮んで縦割れする。.menu-label を縮ませないことで防ぐ。
// 全設定ラベル（文字の大きさ、テーマ、サムネイル画像、読んだニュースを薄く表示、
// カテゴリ名、データベース容量）がこのクラスを使う。
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

test('.menu-label: 改行させず、flex で縮ませない', () => {
  const body = rulesBySelector(appCss).get('.menu-label');
  assert.ok(body, '.menu-label の定義がありません');
  assert.match(body, /white-space:\s*nowrap/, 'white-space: nowrap のはず');
  assert.match(body, /flex-shrink:\s*0/, 'flex-shrink: 0 のはず');
});
