// URLハッシュルーティング（Issue #24）の純粋関数テスト＋App配線の静的検査。
// 形式: #/<tab>[/<storyId>][?cat=..&q=..&kw=..]。storyId は行ID（c<cluster>-v<version>）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseHashRoute,
  buildHashRoute,
  clusterIdOfStoryId,
} from '../frontend/src/api.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const appTsx = readFileSync(join(ROOT, 'frontend/src/App.tsx'), 'utf8');

test('parseHashRoute: タブのみ・ストーリー付き・パラメータ付きを解釈する', () => {
  assert.deepEqual(parseHashRoute('#/important'), {
    tab: 'important', storyId: null, category: null, query: null, watchKeyword: null,
  });
  assert.deepEqual(parseHashRoute('#/fresh/c917-v996'), {
    tab: 'fresh', storyId: 'c917-v996', category: null, query: null, watchKeyword: null,
  });
  const r = parseHashRoute('#/search/c1-v2?q=%E6%83%85%E5%A0%B1%20%E6%BC%8F%E3%81%88%E3%81%84&cat=%E7%A4%BE%E4%BC%9A');
  assert.equal(r.tab, 'search');
  assert.equal(r.storyId, 'c1-v2');
  assert.equal(r.query, '情報 漏えい');
  assert.equal(r.category, '社会');
  const w = parseHashRoute('#/watch?kw=%E4%BB%8A%E7%94%B0%E7%BE%8E%E6%A1%9C');
  assert.equal(w.tab, 'watch');
  assert.equal(w.watchKeyword, '今田美桜');
});

test('parseHashRoute: 空・不正なハッシュは null', () => {
  assert.equal(parseHashRoute(''), null);
  assert.equal(parseHashRoute('#'), null);
  assert.equal(parseHashRoute('#/'), null);
  assert.equal(parseHashRoute('#/unknown-tab'), null);
  assert.equal(parseHashRoute('important'), null);
  assert.equal(parseHashRoute('#/important/a/b/c'), null);
});

test('parseHashRoute: 不正な storyId は落とし、タブは活かす', () => {
  const r = parseHashRoute('#/important/not-a-story');
  assert.equal(r.tab, 'important');
  assert.equal(r.storyId, null);
});

test('buildHashRoute と parseHashRoute は往復できる', () => {
  const cases = [
    { tab: 'important', storyId: null, category: null, query: null, watchKeyword: null },
    { tab: 'editorials', storyId: 'c42-v3', category: '政治', query: null, watchKeyword: null },
    { tab: 'search', storyId: null, category: null, query: '情報 漏えい', watchKeyword: null },
    { tab: 'watch', storyId: 'c7-v1', category: null, query: null, watchKeyword: '今田美桜' },
    { tab: 'bookmarks', storyId: null, category: null, query: null, watchKeyword: null },
  ];
  for (const c of cases) {
    assert.deepEqual(parseHashRoute(buildHashRoute(c)), c);
  }
  assert.equal(buildHashRoute(cases[0]), '#/important');
});

test('clusterIdOfStoryId: 行IDからクラスタIDを取り出す', () => {
  assert.equal(clusterIdOfStoryId('c917-v996'), 917);
  assert.equal(clusterIdOfStoryId('c1-v1'), 1);
  assert.equal(clusterIdOfStoryId('x917'), null);
  assert.equal(clusterIdOfStoryId(''), null);
});

test('App: ハッシュで初期化し、hashchange と復元取得が配線されている', () => {
  assert.match(appTsx, /INITIAL_ROUTE/);
  assert.match(appTsx, /parseHashRoute\(window\.location\.hash\)/);
  assert.match(appTsx, /addEventListener\('hashchange'/);
  assert.match(appTsx, /history\.pushState/);
  assert.match(appTsx, /history\.replaceState/);
  // 復元: 選択行が一覧に無いときはクラスタ詳細を直接取得する
  assert.match(appTsx, /clusterIdOfStoryId\(selectedId\)/);
});
