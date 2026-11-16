// マストヘッド圧縮の静的検査（2026-11-16 ユーザー指示、Issue #5）。
// ノート文（各紙の報道と社説を一行に。続報は版で重ねます。）を削除し、
// タグラインをタイトルの右に横並びにしてブランドを1行に収め、
// 縦パディングを詰めたことを固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const appCss = readFileSync(join(ROOT, 'frontend/src/App.css'), 'utf8');
const appTsx = readFileSync(join(ROOT, 'frontend/src/App.tsx'), 'utf8');

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

test('ノート文は App.tsx / App.css のどちらにも残っていない', () => {
  assert.ok(!appTsx.includes('masthead-note'), 'App.tsx に masthead-note が残っています');
  assert.ok(!appTsx.includes('各紙の報道と社説を一行に'), 'App.tsx にノート文が残っています');
  assert.ok(!stripComments(appCss).includes('.masthead-note'), 'App.css に .masthead-note が残っています');
});

test('ブランドはタイトルとタグラインの横並び（ベースライン揃え）', () => {
  const brand = rules.get('.brand');
  assert.ok(brand, '.brand の定義がありません');
  assert.match(brand, /display:\s*flex/, 'ブランドは横並び（flex）のはず');
  assert.match(brand, /align-items:\s*baseline/, 'ベースライン揃えのはず');
  const h1At = appTsx.indexOf('<h1>一行ニュース</h1>');
  const kickerAt = appTsx.indexOf('brand-kicker');
  assert.ok(h1At >= 0 && kickerAt > h1At, 'タグラインはタイトルの後（右側）に置くはず');
});

test('マストヘッドの縦パディングは圧縮後の値', () => {
  const masthead = rules.get('.masthead');
  assert.ok(masthead, '.masthead の定義がありません');
  assert.match(masthead, /padding:\s*10px 32px 8px/, '縦パディングを詰めたはず');
  assert.doesNotMatch(masthead, /padding:\s*16px 32px 12px/, '圧縮前のパディングが残っています');
});

test('極狭幅ではタグラインを隠す逃がしがある', () => {
  const kicker = rules.get('.brand-kicker');
  assert.ok(kicker, '.brand-kicker の定義がありません');
  assert.match(kicker, /display:\s*none/, '狭幅でタグラインを隠す指定がありません');
  assert.match(kicker, /white-space:\s*nowrap/, 'タグラインは折り返さないはず');
});
