// 詳細ヘッダーの圧縮の静的検査（2026-11-16 ユーザー要望、Issue #7）。
// 詳細ペインの表示量を増やすため、ブックマークは独立行のピルボタンを廃して
// 見出し末尾のアイコンボタンにし、版チップ〜各紙ボタンの隙間とヘッダー内の
// 余白を詰める。各紙ボタンは折り返し可のままとし、横スクロール1行には
// しない（ユーザー訂正）。見出しのフォントサイズは変えない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 詳細ペインは StoryDetailPane.tsx に切り出し済み（App.tsx と合わせて対象にする）
const appTsx =
  readFileSync(join(ROOT, 'frontend/src/App.tsx'), 'utf8') +
  readFileSync(join(ROOT, 'frontend/src/StoryDetailPane.tsx'), 'utf8');
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

test('ブックマーク: 独立行のピルボタンを廃し、見出し末尾のアイコンボタンにする', () => {
  assert.doesNotMatch(appTsx, /detail-actions/, '独立行の置き場は廃止したはず');
  assert.doesNotMatch(appTsx, /bookmark-btn/, '旧ピルボタンは廃止したはず');
  assert.equal(rules.get('.bookmark-btn'), undefined, '.bookmark-btn の CSS も無いこと');
  const headStart = appTsx.indexOf('detail-head');
  const h2Start = appTsx.indexOf('<h2>', headStart);
  const h2 = appTsx.slice(h2Start, appTsx.indexOf('</h2>', h2Start));
  assert.match(h2, /bookmark-toggle/, '見出し内にトグルボタンがあるはず');
  assert.match(h2, /onClick=\{toggleBookmark\}/, 'トグル挙動は従来どおりのはず');
  assert.match(h2, /aria-pressed/, '状態を aria-pressed で伝えるはず');
  assert.match(
    h2,
    /fill=\{selected\.bookmarked \? 'currentColor' : 'none'\}/,
    '状態はアイコンの塗りで判別できるはず',
  );
  const active = rules.get('.bookmark-toggle.is-active');
  assert.ok(active, '.bookmark-toggle.is-active の定義がありません');
  assert.match(active, /background:\s*var\(--ink\)/, '済みは反転地で判別できるはず');
});

test('版チップと各紙ボタンの隙間: レールとバーのマージンを詰める', () => {
  const rail = rules.get('.version-rail');
  assert.ok(rail, '.version-rail の定義がありません');
  assert.match(rail, /margin:\s*12px 0 0/, '版チップ行の上マージンは 12px のはず');
  const bar = rules.get('.outlet-bar');
  assert.ok(bar, '.outlet-bar の定義がありません');
  assert.match(bar, /margin-top:\s*12px/, '各紙バーの上マージンは 12px のはず');
});

test('各紙ボタン: 折り返し可のまま、チップの余白と行間・チップ間を詰める', () => {
  const shared = rules.get('.outlet-bar, .kind-bar');
  assert.ok(shared, '.outlet-bar, .kind-bar の定義がありません');
  assert.match(shared, /flex-wrap:\s*wrap/, '折り返し可のままのはず');
  const bar = rules.get('.outlet-bar');
  assert.match(bar, /gap:\s*5px 6px/, '行間・チップ間を詰めたはず');
  assert.doesNotMatch(
    bar,
    /overflow-x/,
    '横スクロール1行化はしない（ユーザー訂正）',
  );
  const outlet = rules.get('.outlet');
  assert.ok(outlet, '.outlet の定義がありません');
  assert.match(outlet, /padding:\s*7px 10px/, 'チップの余白を詰めたはず');
});
