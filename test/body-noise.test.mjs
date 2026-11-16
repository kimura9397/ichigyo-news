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

test('末尾の他記事見出しリスト: 3行以上連なれば落とし、本文は残す', () => {
  const input = [
    '熊本市長選が投開票され、現職の大西氏が新人4人を破り、4選を果たした。投票率は39.40％で前回を上回った。',
    '',
    '自民、公明両党の県組織から推薦を受けた大西氏は、生活再建を強調し、支持を集めた。',
    '',
    '高市首相、フィリピン・中国訪問へ出発 マニラと深センで国際会議',
    '',
    '立民再結集に高い壁 「公明」「リベラル」両立困難―落選者慎重、新党論も',
    '',
    '松山市長に中野泰誠氏初当選 16年ぶり新人対決制す',
    '',
    '防衛省AI指針、月末に公表 小泉氏「現場で使えるものに」',
  ].join('\n');
  const out = filterBodyLines(input);
  assert.equal(out, [
    '熊本市長選が投開票され、現職の大西氏が新人4人を破り、4選を果たした。投票率は39.40％で前回を上回った。',
    '',
    '自民、公明両党の県組織から推薦を受けた大西氏は、生活再建を強調し、支持を集めた。',
  ].join('\n'));
});

test('末尾の他記事見出しリスト: 2行だけなら落とさない（誤爆防止）', () => {
  const input = [
    '第一の本文段落です。事実を述べています。',
    '',
    '第二の本文段落です。これも事実を述べています。',
    '',
    '関連する見出しのような行その一',
    '',
    '関連する見出しのような行その二',
  ].join('\n');
  assert.equal(filterBodyLines(input), input);
});

test('末尾の他記事見出しリスト: 実文が残らない場合は空にしない', () => {
  const input = [
    '見出しのような行が一つ目にあります',
    '',
    '見出しのような行が二つ目にあります',
    '',
    '見出しのような行が三つ目にあります',
    '',
    '見出しのような行が四つ目にあります',
  ].join('\n');
  assert.equal(filterBodyLines(input), input);
});

test('末尾の他記事見出しリスト: 1ブロック内の行の連なり（ランキング形式）も落とす', () => {
  const input = [
    'サッカー日本代表がブラジルを3―2で破った。通算2勝目で、アジア勢初の快挙となった。',
    '「海外に移籍して苦しい時間も多かった。代表に帰ってきてゴールを決められて感慨深い」と実感を込めて話した。',
    '猛抗議で退場のブラジル監督 会見でも怒り収まらず 審判団を批判',
    '2 「恥ずかしい限り」日本代表に敗戦でブラジルメディアが猛批判',
    '3 「審判のミスが多すぎる」日本の勝利に大激怒 退場処分の戦士が不満爆発',
    '4 侍ジャパンの決勝相手は韓国 台湾との激闘を制す',
  ].join('\n');
  const out = filterBodyLines(input);
  assert.equal(out, [
    'サッカー日本代表がブラジルを3―2で破った。通算2勝目で、アジア勢初の快挙となった。',
    '「海外に移籍して苦しい時間も多かった。代表に帰ってきてゴールを決められて感慨深い」と実感を込めて話した。',
  ].join('\n'));
});

test('末尾の他記事見出しリスト: 直前の投票ウィジェットの設問行も一緒に落とす', () => {
  const input = [
    'ロックバンドが公式サイトを更新し、長野公演の延期を発表した。ボーカルがインフルエンザと診断されたためだ。',
    '',
    'メンバーの診断を受け、開催を予定していた公演の延期を発表した。',
    '',
    '感染症の拡大防止のために、特に意識している対策は何ですか？',
    '',
    '松山千春「これは思い切ったな」紅白出場歌手巡り発言',
    '',
    '女優さんが急逝 23歳 事務所が発表',
    '',
    '元お笑い芸人の被告に懲役4年の実刑判決 東京地裁',
  ].join('\n');
  const out = filterBodyLines(input);
  assert.ok(!out.includes('何ですか'), '設問行が落ちる');
  assert.ok(!out.includes('松山千春'), '見出しが落ちる');
  assert.ok(out.includes('長野公演の延期を発表した'), '本文は残る');
});

test('行フィルタ: 有料勧誘・キャンペーン・出典付き見出し・ティーザーを落とす', () => {
  const input = [
    '町長選は投開票があり、新顔の友田氏が初当選した。投票率は57.28％だった。',
    '有料会員になると会員限定の 有料記事もお読みいただけます。',
    '【締め切り迫る】有料記事が2カ月間 月額100円で読み放題！ 詳しくは こちら 宅配紙面の購読者なら半年割がお得です。 詳しくは こちら',
    '記事の後半では、共同議長を務めた元市長が意義を語っています。',
    '【関西実業団駅伝】痛恨ミスで失格 出典： 日刊スポーツ 2026/11/15(日)',
    '採用情報をアンケート形式で紹介する短い案内行です',
    'PR',
    '友田氏は当選が決まると、支持者とともに万歳をした。組織票を固めていたことが勝因とみられる。',
  ].join('\n');
  const out = filterBodyLines(input);
  assert.deepEqual(out.split('\n').filter(Boolean), [
    '町長選は投開票があり、新顔の友田氏が初当選した。投票率は57.28％だった。',
    '友田氏は当選が決まると、支持者とともに万歳をした。組織票を固めていたことが勝因とみられる。',
  ]);
});

test('タイトル重複: 先頭のタイトル行とタイトル＋日時行を落とし、中盤の同文は残す', () => {
  const title = '30歳苦労人 劇的弾の坂元達裕とは';
  const input = [
    '30歳苦労人 劇的弾の坂元達裕とは 11/14(土) 23:01',
    '',
    'サッカー日本代表がブラジルを破った。坂元達裕の劇的弾で王国を退けた。',
    '',
    '試合はシンガポールで行われ、王国相手に通算2勝目を挙げた。アジア勢初の快挙だった。',
    '',
    '坂元は約5年ぶりの代表招集だった。決勝ゴールを決めて大きな自信になったと話した。',
    '',
    '30歳苦労人 劇的弾の坂元達裕とは',
  ].join('\n');
  const out = filterBodyLines(input, title);
  assert.ok(!out.includes('23:01'), 'タイトル＋日時の行が落ちる');
  assert.ok(out.endsWith('30歳苦労人 劇的弾の坂元達裕とは'), '先頭の範囲を超えた位置の同文は残る');
  // タイトルを渡さなければ先頭行も残る
  assert.ok(filterBodyLines(input).includes('23:01'));
});

test('タイトル重複: 時事形式（タイトルそのままの先頭行）を落とす', () => {
  const title = '防衛省AI指針、月末に公表 小泉氏「現場で使えるものに」';
  const input = [
    title,
    '',
    '小泉防衛相は15日、AI活用の指針を今月末に公表すると明らかにした。記者団に語った。',
  ].join('\n');
  const out = filterBodyLines(input, title);
  assert.equal(out, '小泉防衛相は15日、AI活用の指針を今月末に公表すると明らかにした。記者団に語った。');
});

test('著者プロフィール: メールアドレス＋プロフィール語の段落を落とし、メールだけの段落は残す', () => {
  const input = [
    '駅伝でまさかの失格となった。なぜ位置の違いが失格につながったのだろうか。',
    '',
    '1977年生まれ。大学卒業後からスポーツライターとして活動。著書に『駅伝ノート』など。お仕事のご依頼は example@ymail.ne.jp まで。',
    '',
    '問い合わせ先は press@example.co.jp です、と大会事務局が案内している。',
  ].join('\n');
  const out = filterBodyLines(input);
  assert.ok(!out.includes('スポーツライターとして活動'), 'プロフィール段落が落ちる');
  assert.ok(out.includes('press@example.co.jp'), 'プロフィール語の無い段落は残る');
  assert.ok(out.includes('失格となった'), '本文は残る');
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

test('後がけ: タイトル重複と末尾の他記事見出しリストも落ちる（冪等）', () => {
  const db = openDb(':memory:');
  const now = new Date().toISOString();
  const title = '防衛省AI指針、月末に公表 小泉氏「現場で使えるものに」';
  const c = db.prepare('INSERT INTO clusters (title, category, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .run(title, '政治', now, now);
  const clusterId = Number(c.lastInsertRowid);
  const v = db.prepare('INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1, ?, ?)')
    .run(clusterId, title, now);
  const versionId = Number(v.lastInsertRowid);
  const noisy = [
    title,
    '',
    '小泉防衛相は15日、AI活用の指針を今月末に公表すると明らかにした。記者団に語った。',
    '',
    '高市首相、フィリピン・中国訪問へ出発 マニラと深センで国際会議',
    '',
    '立民再結集に高い壁 「公明」「リベラル」両立困難―落選者慎重、新党論も',
    '',
    '松山市長に中野泰誠氏初当選 16年ぶり新人対決制す',
  ].join('\n');
  db.prepare('INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at, body_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(clusterId, versionId, '時事', title, 'https://example.com/refilter2', '', now, now, noisy);
  assert.equal(refilterBodies(db), 1);
  const a = db.prepare('SELECT body_text FROM articles').get();
  assert.equal(a.body_text, '小泉防衛相は15日、AI活用の指針を今月末に公表すると明らかにした。記者団に語った。');
  assert.equal(refilterBodies(db), 0);
});
