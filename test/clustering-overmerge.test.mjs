// クラスタリングの過剰統合対策（2026-11-15、ユーザー実機の実例に基づく回帰テスト）。
// 実例: 車いすマラソンのクラスタが11/9〜11/15にわたり首相動静・熊本地震基金・
// 福井の共生フォーラム・放送案内ページまで吸い込み続けた（連鎖統合＋時間窓の実質無制限化）。
// 別の実例: 会社も事案も違う「情報漏えい」同士（Yeny／ステップゴルフ／マネックス証券）の合体、
// サイト説明文のような「記事でないアイテム」の取り込み。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { ingestArticles, isGarbageItem } from '../src/collector.mjs';
import { splitOverMergedClusters } from '../src/lifecycle.mjs';

const clusterOf = (db, url) => db.prepare('SELECT cluster_id FROM articles WHERE url = ?').get(url)?.cluster_id;
const clusterCount = (db) => db.prepare('SELECT COUNT(*) c FROM clusters').get().c;

test('実例の統合再現: 首相動静・熊本地震基金・福井共生フォーラム・放送案内は1クラスタに合体しない', () => {
  // 2026-11-15 ユーザー実機のメガクラスタ（11/9〜11/15に吸い込み続けた）の素材を時系列で入れる
  const db = openDb(':memory:');
  const items = [
    { title: '高市首相動静 2026年11月6日～8日', url: 'https://example.com/x1', source: 'NHK', summary: '高市首相の動静。', publishedAt: '2026-11-09T01:00:00.000Z', at: '2026-11-09T02:00:00.000Z' },
    { title: '熊本地震の復興基金に520億円 高市首相が表明', url: 'https://example.com/x2', source: 'NHK', summary: '高市首相は熊本地震の復興基金に520億円を表明した。', publishedAt: '2026-11-13T01:00:00.000Z', at: '2026-11-13T02:00:00.000Z' },
    { title: '外国人との共生社会を考える 福井市でフォーラム', url: 'https://example.com/x3', source: '日テレNEWS', summary: '福井市で外国人との共生社会を考えるフォーラムが開かれた。', publishedAt: '2026-11-14T01:00:00.000Z', at: '2026-11-14T02:00:00.000Z' },
    { title: '大分国際車いすマラソン 選手が力走', url: 'https://example.com/x4', source: 'NHK', summary: '大分市で国際車いすマラソンが開かれた。', publishedAt: '2026-11-15T01:00:00.000Z', at: '2026-11-15T02:00:00.000Z' },
  ];
  for (const it of items) ingestArticles(db, [it], new Date(it.at));
  const clusters = new Set(items.map((it) => clusterOf(db, it.url)));
  assert.equal(clusters.size, 4, '4件とも別クラスタになる');
  // 放送案内のようなゴミは取り込まれない
  const junk = { title: '日本取引所グループ 放送・配信のご案内 ~!@', url: 'https://example.com/x5', source: '日本取引所グループ', summary: '地上波放送と配信の案内ページ。', publishedAt: '2026-11-15T01:00:00.000Z' };
  assert.equal(isGarbageItem(junk), true);
  ingestArticles(db, [junk], new Date('2026-11-15T03:00:00.000Z'));
  assert.equal(clusterOf(db, junk.url), undefined, 'ゴミは取り込まれない');
});

test('連鎖統合の防止: クラスタ内の1記事とだけ強く一致する別ニュースは合体しない', () => {
  const db = openDb(':memory:');
  const now = new Date('2026-11-15T05:00:00.000Z');
  const m0 = { title: '大分国際車いすマラソン 選手が力走', url: 'https://example.com/m0', source: 'NHK', summary: '大分市で国際車いすマラソンが開かれた。', publishedAt: '2026-11-15T01:00:00.000Z' };
  const m1 = { title: '大分国際車いすマラソン、海外選手も参加', url: 'https://example.com/m1', source: '朝日', summary: '大分国際車いすマラソンには海外選手も参加した。', publishedAt: '2026-11-15T02:00:00.000Z' };
  // 空港の到着ニュースは m1（海外選手も参加）と見出しの語を多く共有するが、マラソンとは別ニュース
  const airport = { title: '大分国際空港、海外選手の到着で混雑', url: 'https://example.com/ap', source: '読売', summary: '大分国際空港は海外選手の到着で混雑した。', publishedAt: '2026-11-15T03:00:00.000Z' };
  const m2 = { title: '車いすマラソン大分大会、選手が力走', url: 'https://example.com/m2', source: '毎日', summary: '車いすマラソンの大分大会で選手が力走した。', publishedAt: '2026-11-15T04:00:00.000Z' };
  ingestArticles(db, [m0], now);
  ingestArticles(db, [m1], now);
  assert.equal(clusterCount(db), 1, 'マラソンの2記事は1クラスタ');
  ingestArticles(db, [airport], now);
  assert.notEqual(clusterOf(db, airport.url), clusterOf(db, m0.url), '空港ニュースは合体しない');
  ingestArticles(db, [m2], now);
  assert.equal(clusterOf(db, m2.url), clusterOf(db, m0.url), '同じマラソンの記事は従来どおり合体する');
});

test('時間窓は first_seen 起点: last_seen が延びても3日を超えた合体はしない', () => {
  const db = openDb(':memory:');
  const a0 = { title: '市内で火災が発生 けが人なし', url: 'https://example.com/f0', source: '朝日', summary: '市内で火災が発生した。', publishedAt: '2026-11-10T01:00:00.000Z' };
  const a2 = { title: '市内で火災、けが人なし', url: 'https://example.com/f2', source: '読売', summary: '市内で火災があり、けが人はなかった。', publishedAt: '2026-11-12T01:00:00.000Z' };
  const a4 = { title: '市内で火災が発生 死者2人が確認される', url: 'https://example.com/f4', source: '朝日', summary: '市内で発生した火災で、死者2人が確認された。', publishedAt: '2026-11-14T01:00:00.000Z' };
  ingestArticles(db, [a0], new Date('2026-11-10T02:00:00.000Z'));
  ingestArticles(db, [a2], new Date('2026-11-12T02:00:00.000Z'));
  assert.equal(clusterCount(db), 1, '2日目の同内容は合体する（last_seen がここで延びる）');
  ingestArticles(db, [a4], new Date('2026-11-14T02:00:00.000Z'));
  assert.equal(clusterCount(db), 2, '発生から4日目の記事は、窓が first_seen 起点のため合体しない');
});

test('テーマ類似の防止: 会社・事案の違う「情報漏えい」同士は合体しない', () => {
  const db = openDb(':memory:');
  const now = new Date('2026-11-14T05:00:00.000Z');
  const y1 = { title: 'Yeny 最大133万件漏えい', url: 'https://example.com/y1', source: '日経', summary: 'フィンテック企業のYenyは、最大133万件の個人情報が漏えいした可能性があると発表した。', publishedAt: '2026-11-14T01:00:00.000Z' };
  const bridge = { title: '情報漏えい相次ぐ', url: 'https://example.com/y2', source: 'NHK', summary: '企業による個人情報の漏えいが相次いでいる。専門家は管理体制の見直しを訴えた。', publishedAt: '2026-11-14T02:00:00.000Z' };
  const s1 = { title: 'ステップゴルフ 顔写真や口座情報漏えいか', url: 'https://example.com/s1', source: '朝日', summary: 'ゴルフスクールのステップゴルフは、会員の顔写真や口座情報が漏えいした可能性があると発表した。個人情報の管理体制を調査している。', publishedAt: '2026-11-14T03:00:00.000Z' };
  const m9 = { title: 'マネックス証券、マイナカード画像漏えいか', url: 'https://example.com/m9', source: '読売', summary: 'マネックス証券は、顧客のマイナンバーカード画像が漏えいした可能性があると発表した。個人情報の管理体制を調査している。', publishedAt: '2026-11-14T04:00:00.000Z' };
  for (const it of [y1, bridge, s1, m9]) ingestArticles(db, [it], now);
  const ids = [y1, s1, m9].map((x) => clusterOf(db, x.url));
  assert.equal(new Set(ids).size, 3, '3社の漏えいはそれぞれ別クラスタ');
});

test('ゴミフィルタ: サイト説明文・案内ページ・日付異常は取り込まない', () => {
  const now = new Date('2026-11-14T05:00:00.000Z');
  assert.equal(isGarbageItem({ title: '時事ドットコム：時事通信社が運営するニュースサイト', publishedAt: '2026-06-15T01:00:00.000Z' }, now), true, 'サイト説明文（日付も数か月前）');
  assert.equal(isGarbageItem({ title: '日本取引所グループ 地上波放送・配信のご案内 ~!@', publishedAt: '2026-11-14T01:00:00.000Z' }, now), true, '記号ゴミ入りの案内ページ');
  assert.equal(isGarbageItem({ title: '市内で火災が発生', publishedAt: '2026-06-15T01:00:00.000Z' }, now), true, '公開が14日以上前');
  assert.equal(isGarbageItem({ title: '支持率30%に低下 内閣の課題は', publishedAt: '2026-11-14T02:00:00.000Z' }, now), false, '正当な見出し（%が1つ）は弾かない');

  const db = openDb(':memory:');
  const res = ingestArticles(db, [
    { title: '時事ドットコム：時事通信社が運営するニュースサイト', url: 'https://example.com/g1', source: '時事', summary: 'サイト説明。', publishedAt: '2026-06-15T01:00:00.000Z' },
    { title: '支持率30%に低下 内閣の課題は', url: 'https://example.com/ok1', source: '朝日', summary: '世論調査で支持率が30%に低下した。', publishedAt: '2026-11-14T02:00:00.000Z' },
  ], now);
  assert.equal(res.inserted, 1, '取り込まれるのは正当な記事だけ');
});

/* ---------- 過剰統合クラスタの分離 ---------- */

function buildCluster(db, title, category, versionTitles) {
  const nowIso = '2026-11-15T01:00:00.000Z';
  const cid = Number(db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at, importance_score) VALUES (?, ?, ?, ?, 0)')
    .run(title, category, nowIso, nowIso).lastInsertRowid);
  versionTitles.forEach((t, i) => {
    const vid = Number(db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, ?, ?, ?)')
      .run(cid, i + 1, t, nowIso).lastInsertRowid);
    db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(cid, vid, 'NHK', t, `https://example.com/sp-${cid}-${i}`, '概要', nowIso, nowIso);
  });
  return cid;
}

test('分離: 無関係な版は別クラスタに切り出され、正当な続報は残る', () => {
  const db = openDb(':memory:');
  const bad = buildCluster(db, '大分国際車いすマラソン 選手が力走', 'スポーツ', [
    '大分国際車いすマラソン 選手が力走',
    '高市首相動静 2026年11月6日～8日',
  ]);
  const good = buildCluster(db, '市内で火災が発生 けが人なし', '社会', [
    '市内で火災が発生 けが人なし',
    '市内で火災が発生 死者2人が確認される',
  ]);
  const split = splitOverMergedClusters(db);
  assert.equal(split, 1, '切り出しは首相動静の1版だけ');
  const pm = db.prepare('SELECT * FROM clusters WHERE title LIKE ?').get('高市首相動静%');
  assert.ok(pm && pm.id !== bad, '首相動静は独立したクラスタになる');
  assert.equal(db.prepare('SELECT version_no FROM versions WHERE cluster_id = ?').get(pm.id).version_no, 1, '切り出した版は v1 に繰り上がる');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM versions WHERE cluster_id = ?').get(good).c, 2, '正当な続報のあるクラスタは分離されない');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM versions WHERE cluster_id = ?').get(bad).c, 1, '元のクラスタには v1 だけが残る');
});
