// 詳細ペインの画像表示の静的検査（2026-11-16 ユーザー希望）。
// 一覧の行サムネイルと同じ代表画像（StoryRow.imageUrl）を詳細ヘッダーにも出す。
// 画像は見出しブロックの下に通常フローで置き、本文テキストの表示幅を狭めない
// （一覧で是正した「画像の横で本文が狭くなる」問題を詳細で再発させないため、
// float の回り込みにはしない）。画像が無い記事では何も描画しない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const appTsx = readFileSync(join(ROOT, 'frontend/src/App.tsx'), 'utf8');
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

test('詳細ヘッダー: 代表画像（selected.imageUrl）を detail-photo として描画する', () => {
  const head = appTsx.slice(
    appTsx.indexOf('detail-head'),
    appTsx.indexOf('version-rail'),
  );
  assert.match(head, /selected\.imageUrl/, '詳細ヘッダーが代表画像を参照しているはず');
  assert.match(head, /className="detail-photo"/, 'detail-photo として描画するはず');
  assert.match(head, /showThumbs/, 'サムネイル表示設定に従うはず');
});

test('.detail-photo: 通常フローのブロック表示で、float の回り込みにしない', () => {
  const body = rules.get('.detail-photo');
  assert.ok(body, '.detail-photo の定義がありません');
  assert.match(body, /display:\s*block/, 'display: block のはず');
  assert.doesNotMatch(body, /float:/, 'float で本文を回り込ませないはず');
  assert.match(body, /object-fit:\s*cover/, 'object-fit: cover のはず');
});
