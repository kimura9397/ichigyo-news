// スクロールバーの静的検査（2026-11-16 ユーザーフィードバック「太いのでモダナイズ」、Issue #1）。
// - 既定の太いバーをやめ、WebKit 系は ::-webkit-scrollbar で 8px・角丸、色はテーマ変数
//   （thumb は --line、hover で --muted、track は透明）に従わせる。
// - 標準プロパティ（scrollbar-width / scrollbar-color）は Firefox 向けに
//   @supports not selector(::-webkit-scrollbar) で切り分ける。無条件に書くと
//   Chrome が標準側を優先し、WebKit 側の 8px 指定と hover が効かなくなる。
// - バー非表示が意図の領域（狭幅ページャー .workspace、チップ列 .cat-bar / .watch-bar）は
//   非表示のままであることも固定する。
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

// セレクタ → 宣言本文の対応表（font-stack.test.mjs と同じ流儀）
function rulesBySelector(css) {
  const map = new Map();
  for (const m of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    if (!selector || selector.startsWith('@')) continue;
    map.set(selector, `${map.get(selector) ?? ''}\n${m[2]}`);
  }
  return map;
}

const indexRules = rulesBySelector(indexCss);
const appRules = rulesBySelector(appCss);

test('::-webkit-scrollbar: 幅・高さ 8px', () => {
  const body = indexRules.get('::-webkit-scrollbar');
  assert.ok(body, '::-webkit-scrollbar の定義がありません');
  assert.match(body, /width:\s*8px/, '幅 8px のはず');
  assert.match(body, /height:\s*8px/, '高さ 8px のはず');
});

test('thumb は --line の角丸、hover で --muted、track は透明', () => {
  const thumb = indexRules.get('::-webkit-scrollbar-thumb');
  assert.ok(thumb, '::-webkit-scrollbar-thumb の定義がありません');
  assert.match(thumb, /background:\s*var\(--line\)/, 'thumb は --line のはず');
  assert.match(thumb, /border-radius:\s*4px/, 'thumb は角丸（4px）のはず');
  const hover = indexRules.get('::-webkit-scrollbar-thumb:hover');
  assert.ok(hover, '::-webkit-scrollbar-thumb:hover の定義がありません');
  assert.match(hover, /background:\s*var\(--muted\)/, 'hover は --muted のはず');
  const track = indexRules.get('::-webkit-scrollbar-track');
  assert.ok(track, '::-webkit-scrollbar-track の定義がありません');
  assert.match(track, /background:\s*transparent/, 'track は透明のはず');
});

test('標準プロパティは @supports で Firefox 系にだけ適用する', () => {
  const idx = indexCss.indexOf('@supports not selector(::-webkit-scrollbar)');
  assert.ok(idx >= 0, '@supports not selector(::-webkit-scrollbar) の切り分けがありません');
  const block = indexCss.slice(idx, idx + 300);
  assert.match(block, /scrollbar-width:\s*thin/, 'scrollbar-width: thin のはず');
  assert.match(
    block,
    /scrollbar-color:\s*var\(--line\) transparent/,
    'scrollbar-color は --line / transparent のはず',
  );
});

test('バー非表示が意図の領域は非表示のまま', () => {
  for (const sel of ['.workspace', '.cat-bar', '.watch-bar']) {
    const body = appRules.get(sel);
    assert.ok(body, `${sel} の定義がありません`);
    assert.match(body, /scrollbar-width:\s*none/, `${sel} は scrollbar-width: none のはず`);
  }
  const workspaceWk = appRules.get('.workspace::-webkit-scrollbar');
  assert.ok(workspaceWk, '.workspace::-webkit-scrollbar の定義がありません');
  assert.match(workspaceWk, /display:\s*none/, '.workspace は WebKit でも非表示のはず');
  const chipsWk = appRules.get('.cat-bar::-webkit-scrollbar, .watch-bar::-webkit-scrollbar');
  assert.ok(chipsWk, '.cat-bar / .watch-bar の ::-webkit-scrollbar がありません');
  assert.match(chipsWk, /display:\s*none/, 'チップ列は WebKit でも非表示のはず');
});

test('.version-rail は独自の scrollbar-width を持たない（全体指定に任せる）', () => {
  const body = appRules.get('.version-rail');
  assert.ok(body, '.version-rail の定義がありません');
  assert.ok(
    !/scrollbar-width/.test(body),
    '.version-rail に scrollbar-width があると Chrome でテーマ色の thumb が効かなくなる',
  );
});
