// 本文のノイズ除去（2026-11-15 ユーザー承認）の検証。
// - 構造での除外: class/id に share / newsletter / related 等を含む要素を丸ごと落とす。
// - 行単位のフィルタ: 定型の勧誘・案内・フッター行を落とし、実文（「市場シェア」等）は残す。
// - 保存済み本文への後がけ（refilterBodies）: 既存DBの body_text にも同じフィルタが効く。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { extractBody, filterBodyLines } from '../src/body.mjs';
import { refilterBodies } from '../src/lifecycle.mjs';

const FIXTURE_HTML = `<html><head><title>テスト記事</title></head><body>
<div class="article-body">
  <p>政府は十五日、新しい経済対策を閣議決定した。物価高への対応として、所得減税と給付金を組み合わせた内容で、規模は十兆円を超える見通しだ。</p>
  <p>与党内では財源をめぐる議論が続いており、国債発行に頼らない形を目指す声がある一方で、野党は規模ありきの姿勢を批判している。</p>
  <div class="share-buttons">
    <p>この記事をXでポストしたり、LINEで送ったり、はてなブックマークに登録したりして、友達にシェアすることができます。</p>
  </div>
  <p>市場関係者の間では対策の効果を見極めたいとの声が多く、日経平均株価は小幅な値動きにとどまった。市場シェアの拡大を狙う企業の動きも目立つ。</p>
  <div class="newsletter-box">
    <p>メールマガジンに登録すると、最新ニュースの見出しを毎朝メールでお届けします。今すぐ無料で登録できます。</p>
  </div>
  <div class="related-articles">
    <p>関連記事として、昨年の経済対策の効果を検証した特集や、物価高の背景を解説した記事もあわせて公開しています。</p>
  </div>
  <p class="promo-banner">アプリで読むと便利です。当社アプリをダウンロードして、通知を受け取る設定にすると速報が届きます。</p>
  <p>この記事はいかがでしたか。よろしければ感想を聞かせてください。今後の紙面づくりの参考にさせていただきます。</p>
  <p>© 2026 Example News Media. 本サイトの記事や写真の無断転載、複製、再配布を固く禁じます。</p>
</div>
</body></html>`;

test('抽出: シェア・メルマガ・関連記事などのノイズブロックが構造ごと除去され、実本文だけが残る', () => {
  const body = extractBody(FIXTURE_HTML);
  // 実本文は残る
  assert.ok(body.includes('経済対策を閣議決定した'), '実本文1が残る');
  assert.ok(body.includes('財源をめぐる議論が続いており'), '実本文2が残る');
  assert.ok(body.includes('市場シェアの拡大を狙う'), '「市場シェア」を含む実文が残る');
  // ノイズは消える
  for (const noise of ['Xでポスト', 'はてなブックマーク', 'メールマガジン', '関連記事として', 'アプリで読む', 'この記事はいかがでしたか', '無断転載']) {
    assert.ok(!body.includes(noise), `ノイズ「${noise}」が除去される`);
  }
  // 段落構造は空行区切りで保持される（実本文3段落）
  assert.equal(body.split('\n\n').length, 3);
});

test('行フィルタ: 定型の勧誘・案内・フッター行を落とし、実文は残す', () => {
  const input = [
    '政府は新しい経済対策を閣議決定した。規模は十兆円を超える見通しだ。',
    'この記事をXでポストする',
    'メールマガジン登録はこちら',
    '会員登録すると全ての記事が読めます',
    '公式アカウントをフォローする',
    '対策の詳細は有料会員向けに公開されている。続きを読む',
    '© 2026 Example News. 無断転載を禁じます',
    'お問い合わせ・プライバシーポリシー・利用規約',
    '彼は自分の体験を多くの人とシェアすることを大切にしている。',
    '市場シェアが拡大した。企業の競争は激しさを増している。',
    'LINEで連絡を取り合い、現地で合流することになった。',
  ].join('\n');
  const out = filterBodyLines(input);
  const lines = out.split('\n').filter(Boolean);
  assert.deepEqual(lines, [
    '政府は新しい経済対策を閣議決定した。規模は十兆円を超える見通しだ。',
    '彼は自分の体験を多くの人とシェアすることを大切にしている。',
    '市場シェアが拡大した。企業の競争は激しさを増している。',
    'LINEで連絡を取り合い、現地で合流することになった。',
  ]);
});

test('行フィルタ: 段落構造（空行区切り）を保持したままノイズ段落を落とす', () => {
  const input = [
    '第一段落の本文です。これは実文なので残ります。',
    '',
    '関連記事\nおすすめ記事へのリンク集です。',
    '',
    '第二段落の本文です。これも実文なので残ります。',
  ].join('\n');
  const out = filterBodyLines(input);
  assert.equal(out, '第一段落の本文です。これは実文なので残ります。\n\n第二段落の本文です。これも実文なので残ります。');
});

test('後がけ: 保存済み本文にもフィルタが効き、2回目は変更なし（冪等）', () => {
  const db = openDb(':memory:');
  const now = new Date().toISOString();
  const c = db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .run('後がけ検証', '社会', now, now);
  const clusterId = Number(c.lastInsertRowid);
  const v = db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1, ?, ?)')
    .run(clusterId, '後がけ検証', now);
  const versionId = Number(v.lastInsertRowid);
  const noisy = [
    '実際の本文の一文目です。これは残るべき実文です。',
    'この記事をXでポストする',
    'メールマガジンに登録すると最新ニュースが届きます',
    '実際の本文の二文目です。これも残るべき実文です。',
  ].join('\n');
  db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at, body_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(clusterId, versionId, '朝日', '記事', 'https://example.com/refilter1', '', now, now, noisy);
  assert.equal(refilterBodies(db), 1);
  const a = db.prepare('SELECT body_text FROM articles').get();
  assert.equal(a.body_text, '実際の本文の一文目です。これは残るべき実文です。\n実際の本文の二文目です。これも残るべき実文です。');
  assert.equal(refilterBodies(db), 0);
});
