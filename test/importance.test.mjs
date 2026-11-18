// 重要度スコアの検証。成分の設計は v2（2026-11-15）、v3 で「直近24時間の活動だけを
// 材料にする」窓化と新しさボーナスの廃止が入った（窓の検証は importance-24h.test.mjs）。
// このファイルのフィクスチャは全て現在時刻の記事なので、窓の影響を受けない。
// - 主要媒体成分: 主要媒体グループの重み合計 W に 10 × log2(1 + W) の圧縮
// - 広がり成分: その他媒体のグループは +0.5/グループ、上限 +5
// - グループ数成分: min(G, 20) × 0.8 / バージョン成分: min(版数, 5) × 2
// - D: 社説ボーナス（found 1媒体 +6、上限 +18）
// - A: カテゴリ減衰（スポーツ / 文化・エンタメは社説ボーナス以外の小計に ×0.7）
// - カテゴリ補正: 見出しのスポーツ語で「スポーツ」に分類する
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { importanceFor, refineCategory } from '../src/classify.mjs';

const NOW = new Date().toISOString();
let seq = 0;

function makeCluster(db, { category = '社会', articles = [], editorials = [], extraVersions = 0 } = {}) {
  seq++;
  const c = db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .run(`テストニュース${seq}`, category, NOW, NOW);
  const clusterId = Number(c.lastInsertRowid);
  const v = db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1, ?, ?)')
    .run(clusterId, `テストニュース${seq}`, NOW);
  const versionId = Number(v.lastInsertRowid);
  for (let i = 0; i < extraVersions; i++) {
    db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, ?, ?, ?)')
      .run(clusterId, i + 2, `テストニュース${seq} 続報${i + 2}`, NOW);
  }
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
  assert.ok(Math.abs(actual - expected) < 0.01, `score ${actual} != ${expected}`);
}

// 主要媒体1グループだけの基本形: 10*log2(1+3) + グループ数 0.8 + 版 2 = 22.8
const BASE_MAJOR = 10 * Math.log2(4) + 0.8 + 2;

test('B: 同一配信（同じ正規化タイトル）は1グループに畳み、最大重みの媒体で代表する', () => {
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
  // グループ1つ（最大重み3=主要媒体）→ 主要媒体成分のみで基本形と同値
  approx(importanceFor(db, id), BASE_MAJOR);
});

test('主要媒体の独自報道はグループごとに積み上がるが log で圧縮される', () => {
  const db = openDb(':memory:');
  const id = makeCluster(db, {
    articles: [
      { source: '読売', title: '国際車いすマラソン、大分で熱戦' },
      { source: '西日本新聞me', title: '国際車いすマラソン、大分で熱戦' },
      { source: '毎日', title: '車いすマラソン 金華が優勝 記者が現地で見た熱戦' },
    ],
  });
  // 主要媒体グループ2つ: W=6 → 10*log2(7)、グループ数 2×0.8、版 2
  approx(importanceFor(db, id), 10 * Math.log2(7) + 1.6 + 2);
});

test('広がり成分: 主要媒体でない媒体のグループは +0.5 ずつ、上限 +5', () => {
  const db = openDb(':memory:');
  const articles = [];
  for (let i = 0; i < 15; i++) {
    articles.push({ source: '西日本新聞me', title: `地域の話題 その${i + 1} 地区で催し` });
  }
  const id = makeCluster(db, { articles });
  // 主要媒体成分 0、広がり min(15*0.5, 5)=5、グループ数 min(15,20)*0.8=12、版 2
  approx(importanceFor(db, id), 0 + 5 + 12 + 2);
});

test('上限: グループ数成分は20グループ、バージョン成分は5版で頭打ち', () => {
  const db = openDb(':memory:');
  const articles = [];
  for (let i = 0; i < 30; i++) {
    articles.push({ source: '朝日', title: `大規模な出来事 側面${i + 1}からの報道` });
  }
  const id = makeCluster(db, { articles, extraVersions: 6 });
  // W=90 → 10*log2(91)、グループ数 min(30,20)*0.8=16、版 min(7,5)*2=10
  approx(importanceFor(db, id), 10 * Math.log2(91) + 16 + 10);
  // 旧式（重み合計90＋記事数30＋版14＋新しさ5=139）より大幅に圧縮されていること
  assert.ok(importanceFor(db, id) < 100);
});

test('D: 社説が found の媒体1つにつき +6、上限は +18', () => {
  const db = openDb(':memory:');
  const base = [{ source: '朝日', title: '消費税の減税法案 参議院で審議入り' }];
  const id2 = makeCluster(db, {
    articles: base,
    editorials: [{ paper: '朝日', found: 1 }, { paper: '毎日', found: 1 }, { paper: '読売', found: 0 }],
  });
  approx(importanceFor(db, id2), BASE_MAJOR + 12);
  const id4 = makeCluster(db, {
    articles: base,
    editorials: [
      { paper: '朝日', found: 1 }, { paper: '毎日', found: 1 },
      { paper: '読売', found: 1 }, { paper: '産経', found: 1 },
    ],
  });
  // 社説4媒体でも上限 +18
  approx(importanceFor(db, id4), BASE_MAJOR + 18);
});

test('A: スポーツは社説ボーナスを除いた小計に ×0.7 が掛かる', () => {
  const db = openDb(':memory:');
  const id = makeCluster(db, {
    category: 'スポーツ',
    articles: [{ source: '朝日', title: 'サッカー日本代表 ブラジルに勝利' }],
    editorials: [{ paper: '朝日', found: 1 }],
  });
  approx(importanceFor(db, id), BASE_MAJOR * 0.7 + 6);
  const idSociety = makeCluster(db, {
    category: '社会',
    articles: [{ source: '朝日', title: 'サッカー日本代表 ブラジルに勝利' }],
    editorials: [{ paper: '朝日', found: 1 }],
  });
  approx(importanceFor(db, idSociety), BASE_MAJOR + 6);
});

test('カテゴリ補正: 見出しのスポーツ語で「スポーツ」に分類する', () => {
  assert.equal(refineCategory('大分国際車いすマラソン開会式 有力選手が意気込み', '国際'), 'スポーツ');
  assert.equal(refineCategory('サッカー日本代表 ブラジルに勝利', ''), 'スポーツ');
  assert.equal(refineCategory('大相撲九州場所 初日見どころ', '科学'), 'スポーツ');
  assert.equal(refineCategory('プロ野球 日本シリーズ第3戦', '文化・エンタメ'), 'スポーツ');
  // スポーツ語が無ければ元のカテゴリをそのまま返す
  assert.equal(refineCategory('首相、消費減税法案の審議入りを表明', '政治'), '政治');
  assert.equal(refineCategory('市街地で陸上自衛隊の車両が走行', '社会'), '社会');
  assert.equal(refineCategory('見出しのみ', ''), '');
});
