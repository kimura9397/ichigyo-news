// 照合前の定型句除去（2026-11-19 監査、Issue #53）の回帰テスト。
// 媒体サフィックスや定型マーカーが残ると、そのバイグラムが接着剤になって
// 無関係な記事同士が一致する（監査の実例: 重要度1位のクラスタが震度速報を
// 標題とする 47NEWS 記事の寄せ集めになっていた）。素材の見出しは監査で
// 実際に確認された誤合体の実例から採った。
import { test} from 'node:test';
import assert from 'node:assert/strict';
import { extractSourceFromTitle, cleanTitle} from '../src/rss.mjs';
import { bigrams, matchScore, stripBoilerplate, hasStoryAnchor} from '../src/matching.mjs';

const score = (a, b) => matchScore(bigrams(a), bigrams(b));

/* ---------- extractSourceFromTitle: 数字ガードと 47NEWS の例外 ---------- */

test('媒体名抽出: 「47NEWS」は数字始まりでも媒体名として拾う', () => {
assert.equal(extractSourceFromTitle('球磨村で震度1 - 47NEWS'), '47NEWS');
});

test('媒体名抽出: スコア表記は引き続き媒体名と誤認しない（Issue #21）', () => {
assert.equal(extractSourceFromTitle('森保ジャパン 3-2でブラジル相手に勝利'), '');
assert.equal(extractSourceFromTitle('日本代表、3-2で逆転勝利 - 5G対応スタジアム'), '');
});

/* ---------- cleanTitle: 配信元表記の除去 ---------- */

test('タイトル整形: 「- 47NEWS」サフィックスが落ちる', () => {
assert.equal(cleanTitle('球磨村で震度1 - 47NEWS', '共同'), '球磨村で震度1');
});

test('タイトル整形: 「：時事ドットコム」が落ちる', () => {
assert.equal(cleanTitle('立民、職員に退職勧奨を通知：時事ドットコム', '時事'), '立民、職員に退職勧奨を通知');
assert.equal(cleanTitle('画像・写真：韓国大統領、来年１月訪日：時事ドットコム', '時事'), '画像・写真：韓国大統領、来年１月訪日');
});

test('タイトル整形: 末尾の「（…ネットワーク）」「（媒体名）」が落ちる', () => {
assert.equal(cleanTitle('城西国際大でeスポーツフォーラム開催（みんなの経済新聞ネットワーク）', ''), '城西国際大でeスポーツフォーラム開催');
assert.equal(cleanTitle('櫻井優衣「このグループは私の宝物です」（中日スポーツ）', ''), '櫻井優衣「このグループは私の宝物です」');
});

test('タイトル整形: 本文側の括弧やコロンは落とさない', () => {
assert.equal(cleanTitle('首相、年内に判断：背景に党内の事情', ''), '首相、年内に判断：背景に党内の事情');
assert.equal(cleanTitle('代表決定（サッカー） 遠征メンバー発表', ''), '代表決定（サッカー） 遠征メンバー発表');
});

/* ---------- stripBoilerplate / matchScore: 接着の解消 ---------- */

test('定型句除去: サフィックス・マーカー・前置きが照合用文字列から消える', () => {
assert.equal(stripBoilerplate('球磨村で震度1 - 47NEWS'), '球磨村で震度1');
assert.equal(stripBoilerplate('立民、職員に退職勧奨を通知：時事ドットコム'), '立民、職員に退職勧奨を通知');
assert.equal(stripBoilerplate('画像・写真：韓国大統領、来年１月訪日：時事ドットコム'), '韓国大統領、来年１月訪日');
assert.equal(stripBoilerplate('ジェイソン・ステイサム婚約者の近影 - エンタメ - ニュース'), 'ジェイソン・ステイサム婚約者の近影');
});

test('照合: 無関係な 47NEWS 速報同士は一致しない（監査前は 0.47〜0.53）', () => {
const title = '球磨村で震度1 - 47NEWS';
assert.equal(score(title, 'JT、7240億円の赤字転落へ - 47NEWS'), 0);
assert.equal(score(title, '毎日新聞、デジタル会員14万人名字漏えい - 47NEWS'), 0);
assert.equal(score(title, '鹿沼でサル約20匹目撃 - 47NEWS'), 0);
assert.equal(score(title, '大根をおいしく使い切り 冬場は甘みとみずみずしさアップ - 47NEWS'), 0);
});

test('照合: 無関係な時事ドットコム記事同士は一致しない', () => {
const title = '立民、職員に退職勧奨を通知：時事ドットコム';
assert.equal(score(title, '新潟の魅力掘り起こせ！ 観光誘致へアイデア競争―ロンドン：時事ドットコム'), 0);
assert.equal(score(title, '東武百貨店が顔認証決済を開始 手軽に支払い、デパート初：時事ドットコム'), 0);
});

test('照合: 無関係な（…ネットワーク）記事同士は一致しない', () => {
const title = '城西国際大でeスポーツフォーラム開催（みんなの経済新聞ネットワーク）';
assert.equal(score(title, '商店街に新しいパン店がオープン、開店前から行列（みんなの経済新聞ネットワーク）'), 0);
assert.equal(score(title, '高校生が地域の清掃活動に参加、駅前を美化（みんなの経済新聞ネットワーク）'), 0);
});

test('照合: 同じニュースの続報はサフィックス付きでも一致する', () => {
assert.ok(score('球磨村で震度1 - 47NEWS', '球磨村で震度2、けが人の情報なし - 47NEWS') > 0);
assert.ok(score('立民、職員に退職勧奨を通知：時事ドットコム', '立民の退職勧奨、職員側が反発 党内で波紋：時事ドットコム') > 0);
});

test('アンカー: 定型句だけを共有する別ニュースはアンカーを持たない', () => {
const clusterTitle = '球磨村で震度1 - 47NEWS';
assert.equal(hasStoryAnchor('大根をおいしく使い切り 冬場は甘みとみずみずしさアップ - 47NEWS', clusterTitle, [clusterTitle], [clusterTitle]), false);
assert.equal(hasStoryAnchor('鹿沼でサル約20匹目撃 - 47NEWS', clusterTitle, [clusterTitle], [clusterTitle]), false);
});
