// スポットライトの前へ／次へボタン（Issue #41）の移動ロジックのテスト。
// 方式: frontend-transforms.test.mjs と同じく、Node のタイプストリッピングで
// api.ts の純粋関数を直接 import する（新規依存なし）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { steppedIndex } from '../frontend/src/api.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const spotlightTsx = readFileSync(
  join(ROOT, 'frontend/src/Spotlight.tsx'),
  'utf8',
);

test('steppedIndex: 通常の前進・後退', () => {
  assert.equal(steppedIndex(0, 1, 5), 1);
  assert.equal(steppedIndex(3, -1, 5), 2);
  assert.equal(steppedIndex(2, 0, 5), 2);
});

test('steppedIndex: 端では反対側に回る', () => {
  assert.equal(steppedIndex(4, 1, 5), 0);
  assert.equal(steppedIndex(0, -1, 5), 4);
});

test('steppedIndex: 件数が1以下・0以下では動かない', () => {
  assert.equal(steppedIndex(0, 1, 1), 0);
  assert.equal(steppedIndex(0, -1, 1), 0);
  assert.equal(steppedIndex(2, 1, 0), 0);
  assert.equal(steppedIndex(2, 1, -3), 0);
});

test('steppedIndex: 範囲外の現在位置も [0, length) に収める', () => {
  assert.equal(steppedIndex(7, 0, 5), 2);
  assert.equal(steppedIndex(-1, 0, 5), 4);
  assert.equal(steppedIndex(12, 1, 5), 3);
});

test('Spotlight: 前へ／次へボタンがあり、移動でタイマーを数え直す', () => {
  assert.ok(spotlightTsx.includes('aria-label="前のニュース"'), '前へボタンがありません');
  assert.ok(spotlightTsx.includes('aria-label="次のニュース"'), '次へボタンがありません');
  assert.ok(
    spotlightTsx.includes('moveSlot(-1)') && spotlightTsx.includes('moveSlot(1)'),
    'moveSlot への配線がありません',
  );
  // 手動移動では表示開始時刻と適用中の表示時間をリセットする
  const moveSlotBody = spotlightTsx.slice(
    spotlightTsx.indexOf('const moveSlot'),
    spotlightTsx.indexOf('const moveSlot') + 600,
  );
  assert.ok(moveSlotBody.includes('slotStartRef.current = Date.now()'));
  assert.ok(moveSlotBody.includes('slotMsRef.current = rotateMsRef.current'));
  assert.ok(moveSlotBody.includes('setProgress(0)'));
  // 1件以下ではボタンを無効化する
  assert.ok(spotlightTsx.includes('disabled={items.length <= 1}'));
});
