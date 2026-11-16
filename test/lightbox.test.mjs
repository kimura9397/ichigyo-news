// 詳細ペインの代表画像の拡大表示（ライトボックス）の静的検査
// （2026-11-16 ユーザー要望、Issue #6）。
// 対象は詳細ヘッダーの代表画像（detail-photo）のみ。一覧の行サムネイルは
// 行選択のクリックと競合するため対象外とする。閉じ方はオーバーレイの
// クリック・Esc キー・閉じるボタン（×）の3通り。
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

test('詳細の代表画像: クリックでライトボックスが開き、cursor は zoom-in', () => {
  const head = appTsx.slice(
    appTsx.indexOf('detail-head'),
    appTsx.indexOf('version-rail'),
  );
  assert.match(
    head,
    /onClick=\{\(\) => \{\s*if \(selected\.imageUrl\) setZoomedPhoto\(selected\.imageUrl\)/,
    'detail-photo のクリックで拡大表示が開くはず',
  );
  const body = rules.get('.detail-photo');
  assert.ok(body, '.detail-photo の定義がありません');
  assert.match(body, /cursor:\s*zoom-in/, 'クリック可能と分かる cursor のはず');
});

test('一覧の行サムネイル: ライトボックスは開かない（行選択と競合させない）', () => {
  const idx = appTsx.indexOf('row-thumb');
  assert.ok(idx >= 0, 'row-thumb の描画がありません');
  const rowThumb = appTsx.slice(idx, idx + 700);
  assert.doesNotMatch(
    rowThumb,
    /setZoomedPhoto/,
    '行サムネイルから拡大表示を開いてはいけない',
  );
});

test('オーバーレイ: 全画面固定で、クリックで閉じ、cursor は zoom-out', () => {
  assert.match(appTsx, /className="photo-lightbox"/, 'オーバーレイが描画されるはず');
  assert.match(appTsx, /aria-label="拡大表示を閉じる"/, '閉じるボタンがあるはず');
  const body = rules.get('.photo-lightbox');
  assert.ok(body, '.photo-lightbox の定義がありません');
  assert.match(body, /position:\s*fixed/, '全画面固定のはず');
  assert.match(body, /inset:\s*0/, '画面全体を覆うはず');
  assert.match(body, /cursor:\s*zoom-out/, '閉じられることが分かる cursor のはず');
  assert.match(
    body,
    /background:\s*rgba\(/,
    '背景は暗色の半透明（テーマに依らない固定色）のはず',
  );
});

test('拡大画像: ビューポートの90%以内に contain で収め、引き伸ばさない', () => {
  const body = rules.get('.photo-lightbox-img');
  assert.ok(body, '.photo-lightbox-img の定義がありません');
  assert.match(body, /max-width:\s*90vw/, '幅はビューポートの90%以内のはず');
  assert.match(body, /max-height:\s*90vh/, '高さはビューポートの90%以内のはず');
  assert.match(body, /object-fit:\s*contain/, '画像全体が見える contain のはず');
  assert.doesNotMatch(
    body,
    /(^|\s)(width|height):/,
    'width/height を指定すると小さい画像が引き伸ばされるため、max-* のみのはず',
  );
});

test('Esc キーでライトボックスが閉じる', () => {
  assert.match(
    appTsx,
    /e\.key === 'Escape'\) setZoomedPhoto\(null\)/,
    'Esc で拡大表示を閉じるハンドラがあるはず',
  );
});
