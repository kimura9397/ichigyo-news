// カテゴリ分類（refineCategory）の実例フィクスチャ。
// 過去に誤判定した実例を固定し、再発を防ぐ。補正は「明確な語がある場合だけ」の最小限。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refineCategory } from '../src/collector.mjs';

test('車いすマラソンは、フィードのカテゴリが違ってもスポーツに補正される', () => {
  assert.equal(refineCategory('大分国際車いすマラソンで日本新記録', '国際'), 'スポーツ');
  assert.equal(refineCategory('大分国際車いすマラソンで日本新記録', ''), 'スポーツ');
});

test('スポーツカーの値引き相場はスポーツではない', () => {
  // フィードが経済ならそのまま（「スポーツ」の語だけで誤って引き上げない）
  assert.equal(refineCategory('スポーツカーの値引き相場が下落', '経済'), '経済');
  // スポーツ節・検索経由で「スポーツ」と付いて届いても、証拠が複合語だけなら外す
  assert.equal(refineCategory('スポーツカーの値引き相場が下落', 'スポーツ'), '経済');
  assert.equal(refineCategory('新型スポーツカーを発表', 'スポーツ'), '');
});

test('ASEAN首脳会議は文化・エンタメではない', () => {
  assert.equal(refineCategory('ASEAN首脳会議が開幕、経済連携を協議', '文化・エンタメ'), '国際');
  assert.equal(refineCategory('ASEAN首脳会議が開幕', ''), '国際');
  // 妥当な分類（政治）は触らない
  assert.equal(refineCategory('ASEAN首脳会議が開幕', '政治'), '政治');
});

test('通常の分類はそのまま保持される', () => {
  assert.equal(refineCategory('市議会が補正予算案を可決', '政治'), '政治');
  assert.equal(refineCategory('近所の祭りで賑わい', '文化・エンタメ'), '文化・エンタメ');
  assert.equal(refineCategory('大谷翔平が2試合連続ホームラン', 'スポーツ'), 'スポーツ');
  assert.equal(refineCategory('新しい惑星を発見', ''), '');
});
