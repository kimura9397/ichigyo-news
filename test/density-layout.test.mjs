// 一覧の密度（コンパクト表示）の静的検査（2026-11-16 ユーザー決定、Issue #4）。
// モニター用途で1画面に入る見出し行を増やすため、設定「一覧の密度」で
// 行の構造を詰める。コンパクト時はフッター行をメタ行へ畳み、リード文を
// 1行に絞り、余白を詰める。標準時の見た目が変わらないことも併せて固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const appCss = readFileSync(join(ROOT, 'frontend/src/App.css'), 'utf8');
const appTsx = readFileSync(join(ROOT, 'frontend/src/App.tsx'), 'utf8');
const settingsMenuTsx = readFileSync(join(ROOT, 'frontend/src/SettingsMenu.tsx'), 'utf8');
// 一覧ペインは StoryListPane.tsx に切り出し済み（該当アサーションはこちらを見る）
const storyListPaneTsx = readFileSync(join(ROOT, 'frontend/src/StoryListPane.tsx'), 'utf8');

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

test('コンパクト時: 行のパディングと見出しの余白を詰める', () => {
  const row = rules.get('.list-pane.is-compact .row');
  assert.ok(row, '.list-pane.is-compact .row の定義がありません');
  assert.match(row, /padding:\s*10px 20px 9px/, '行パディングを詰めるはず');
  const title = rules.get('.list-pane.is-compact .row-title');
  assert.ok(title, '.list-pane.is-compact .row-title の定義がありません');
  assert.match(title, /margin:\s*3px 0 2px/, '見出しの余白を詰めるはず');
});

test('コンパクト時: リード文は1行で省略する', () => {
  const lead = rules.get('.list-pane.is-compact .row-lead');
  assert.ok(lead, '.list-pane.is-compact .row-lead の定義がありません');
  assert.match(lead, /-webkit-line-clamp:\s*1/, 'line-clamp 1 のはず');
  assert.match(lead, /overflow:\s*hidden/, 'はみ出しを隠すはず');
});

test('メタ行へ移したバッジは右端へ float で寄せる', () => {
  const badges = rules.get('.row-meta .badges');
  assert.ok(badges, '.row-meta .badges の定義がありません');
  assert.match(badges, /float:\s*right/, 'バッジは float: right のはず');
});

test('標準時: 行パディングは従来のまま（密度で変えない）', () => {
  const row = rules.get('.row');
  assert.ok(row, '.row の定義がありません');
  assert.match(row, /padding:\s*16px 20px 14px/, '標準のパディングが変わっています');
});

test('App.tsx: 密度のデフォルトはコンパクトで、保存済みの standard は尊重する', () => {
  // 初期化ブロックを取り出して中身を固定する（2026-11-16 実機確認の上でデフォルト化）
  const m = appTsx.match(/useState<DensitySetting>\(\(\) => \{([\s\S]*?)\}\)/);
  assert.ok(m, '密度の初期化ブロックがありません');
  const init = m[1];
  assert.ok(
    init.includes("localStorage.getItem('ichigyo:density') === 'standard'"),
    '保存済み standard を判定するはず',
  );
  assert.ok(init.includes(": 'compact'"), '未保存時はコンパクトになるはず');
  assert.ok(init.includes("return 'compact'"), '読み取り失敗時もコンパクトになるはず');
});

test('App.tsx: 密度設定は localStorage（ichigyo:density）に保存し、一覧へ is-compact で適用する', () => {
  assert.ok(appTsx.includes("localStorage.getItem('ichigyo:density')"), 'ichigyo:density の読み込みがありません');
  assert.ok(appTsx.includes("localStorage.setItem('ichigyo:density', density)"), 'ichigyo:density の保存がありません');
  assert.ok(settingsMenuTsx.includes('一覧の密度'), '設定メニューの「一覧の密度」項目がありません');
  assert.ok(storyListPaneTsx.includes("'list-pane is-compact'"), 'コンパクト時に is-compact が付きません');
  assert.ok(storyListPaneTsx.includes("density === 'compact' ? null : ("), 'コンパクト時にフッター行を出さない分岐がありません');
});
