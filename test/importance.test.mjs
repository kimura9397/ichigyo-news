// 重要度スコア（2026-11-15 改善）の検証。
// B: 配信の重複割引（正規化タイトルの署名グループで数える）
// D: 社説ボーナス（found 1媒体 +6、上限 +18）
// A: カテゴリ減衰（スポーツ / 文化・エンタメは社説ボーナス以外の小計に ×0.7）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { importanceFor } from '../src/collector.mjs';

const NOW = new Date().toISOString();
let seq = 0;

function makeCluster(db, { category = '社会', articles = [], editorials = [] } = {}) {
  seq++;
  const c = db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .run(`テストニュース${seq}`, category, NOW, NOW);
  const clusterId = Number(c.lastInsertRowid);
  const v = db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1, ?, ?)')
    .run(clusterId, `テストニュース${seq}`, NOW);
  const versionId = Number(v.lastInsertRowid);
  for (const a of articles) {
    db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(clusterId, versionId, a.source, a.title, `https://example.com/t${seq}-${Math.random()}`, a.summary || '', a.publishedAt || NOW, NOW);
  }
  for (const e of editorials) {
    db.prepare('INSERT INTO editorials (cluster_id, paper, found, title, summary, url, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(clusterId, e.paper, e.found, '', '', '', NOW);
  }
  return clusterId;
}

function approx(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `score ${actual} != ${expected}`);
}

test('B: 同一配信（同じ正規化タイトル）は記事数・媒体重みとも1回分だけ数える', () => {
  const db = openDb(':memory:');
  const id = makeCluster(db, {
    articles: [
      { source: '読売', title: '国際車いすマラソン、大分で熱戦' },
      { source: '西日本新聞me', title: '国際車いすマラソン、大分で熱戦' },
      { source: 'Yahoo!ニュース', title: '国際車いすマラソン、大分で熱戦' },
      // 句読点・空白の違いは正規化で同一署名になる
      { source: '朝日', title: '国際車いすマラソン 大分で熱戦' },
    ],
  });
  // グループ1つ、重みは最大の3（主要媒体）、記事数成分=グループ数1、版1つで+2、新しさ+5
  approx(importanceFor(db, id), 3 + 1 + 2 + 5);
});

test('B: 独自報道（署名が異なる記事）は社ごとに数える', () => {
  const db = openDb(':memory:');
  const id = makeCluster(db, {
    articles: [
      { source: '読売', title: '国際車いすマラソン、大分で熱戦' },
      { source: '西日本新聞me', title: '国際車いすマラソン、大分で熱戦' },
      { source: '毎日', title: '車いすマラソン 金華が優勝 記者が現地で見た熱戦' },
    ],
  });
  // グループ2つ: 重み 3（読売グループの最大）+ 3（毎日）= 6、記事数成分=2、版+2、新しさ+5
  approx(importanceFor(db, id), 6 + 2 + 2 + 5);
});

test('D: 社説が found の媒体1つにつき +6、上限は +18', () => {
  const db = openDb(':memory:');
  const base = [{ source: '朝日', title: '消費税の減税法案 参議院で審議入り' }];
  const id2 = makeCluster(db, {
    articles: base,
    editorials: [{ paper: '朝日', found: 1 }, { paper: '毎日', found: 1 }, { paper: '読売', found: 0 }],
  });
  // 素点: 重み3 + グループ1 + 版2 + 新しさ5 = 11、社説2媒体で +12
  approx(importanceFor(db, id2), 11 + 12);
  const id4 = makeCluster(db, {
    articles: base,
    editorials: [
      { paper: '朝日', found: 1 }, { paper: '毎日', found: 1 },
      { paper: '読売', found: 1 }, { paper: '産経', found: 1 },
    ],
  });
  // 社説4媒体でも上限 +18
  approx(importanceFor(db, id4), 11 + 18);
});

test('A: スポーツは社説ボーナスを除いた小計に ×0.7 が掛かる', () => {
  const db = openDb(':memory:');
  const id = makeCluster(db, {
    category: 'スポーツ',
    articles: [{ source: '朝日', title: 'サッカー日本代表 ブラジルに勝利' }],
    editorials: [{ paper: '朝日', found: 1 }],
  });
  // 素点 11 × 0.7 = 7.7、社説ボーナス +6 は減衰されない
  approx(importanceFor(db, id), 11 * 0.7 + 6);
  const idSociety = makeCluster(db, {
    category: '社会',
    articles: [{ source: '朝日', title: 'サッカー日本代表 ブラジルに勝利' }],
    editorials: [{ paper: '朝日', found: 1 }],
  });
  approx(importanceFor(db, idSociety), 11 + 6);
});
