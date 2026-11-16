// フロント変換層（frontend/src/api.ts の純粋関数）のユニットテスト。
// 方式: Node のタイプストリッピングで api.ts を直接 import する（新規依存なし。
// api.ts の import は型のみで、実行時には消えるため）。サーバーと同じ Node ≥22 前提に乗る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeUrl,
  cleanText,
  summarize,
  outletOf,
  applyEditorials,
  versionsOfEvent,
  rowFromListItem,
} from '../frontend/src/api.ts';

test('safeUrl: http/https のみ通し、それ以外は空にする', () => {
  assert.equal(safeUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeUrl('http://example.com'), 'http://example.com');
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('data:text/html;base64,x'), '');
  assert.equal(safeUrl(null), '');
  assert.equal(safeUrl(''), '');
  assert.equal(safeUrl('not a url'), '');
});

test('cleanText: タグ除去・エンティティ復号・空白の正規化', () => {
  assert.equal(cleanText('<p>見出し</p>  本文'), '見出し 本文');
  assert.equal(cleanText('A &amp; B &lt;tag&gt;'), 'A & B <tag>');
  assert.equal(cleanText('数値 &#49; 件'), '数値 1 件');
  assert.equal(cleanText(null), '');
});

test('summarize: 文単位で切り、収まらなければ … を付ける', () => {
  const text = '一文目です。二文目です。三文目です。';
  assert.equal(summarize(text, 100), text);
  assert.equal(summarize(text, 12), '一文目です。二文目です。');
  const long = 'あ'.repeat(50);
  const cut = summarize(long, 10);
  assert.ok(cut.length <= 11 && cut.endsWith('…'));
});

test('outletOf: 紙名の正規化と未知媒体の扱い', () => {
  assert.deepEqual(outletOf('朝日'), { id: 'asahi', name: '朝日新聞' });
  assert.deepEqual(outletOf('朝日新聞'), { id: 'asahi', name: '朝日新聞' });
  assert.deepEqual(outletOf('日本経済新聞'), { id: 'nikkei', name: '日本経済新聞' });
  assert.deepEqual(outletOf('地方紙X'), { id: '地方紙X', name: '地方紙X' });
  assert.deepEqual(outletOf(''), { id: 'unknown', name: '媒体不明' });
});

function coverage(outletId, outletName) {
  return {
    outletId,
    outletName,
    headline: `${outletName}の見出し`,
    publishedAt: '2026-11-15T00:00:00.000Z',
    summary: '',
  };
}
function row(coverages) {
  return {
    id: 'c1-v1',
    eventId: 'c1',
    clusterId: 1,
    eventTitle: '出来事',
    version: 1,
    versionCreatedAt: '2026-11-15T00:00:00.000Z',
    title: '見出し',
    lead: '',
    publishedAt: '2026-11-15T00:00:00.000Z',
    category: '政治',
    isImportant: false,
    isNew: true,
    coverages,
  };
}
const ed = (outletId, outletName, title) => ({
  outletId,
  outletName,
  title,
  text: `${title}\n社説本文`,
  url: 'https://example.com/editorial',
});

test('applyEditorials: 社説が無い場合は行をそのまま返す', () => {
  const rows = [row([coverage('asahi', '朝日新聞')])];
  assert.equal(applyEditorials(rows, []), rows);
});

test('applyEditorials: 記事のある紙には社説が帰属し、無い紙は社説のみの coverage が足される', () => {
  const rows = [row([coverage('asahi', '朝日新聞'), coverage('yomiuri', '読売新聞')])];
  const out = applyEditorials(rows, [
    ed('yomiuri', '読売新聞', '読売の社説'),
    ed('nikkei', '日本経済新聞', '日経の社説'),
  ]);
  const coverages = out[0].coverages;
  const yomiuri = coverages.find((c) => c.outletId === 'yomiuri');
  assert.equal(yomiuri.editorialTitle, '読売の社説');
  assert.equal(yomiuri.headline, '読売新聞の見出し'); // 記事側の見出しは保持される
  const asahi = coverages.find((c) => c.outletId === 'asahi');
  assert.equal(asahi.editorial, undefined);
  const nikkei = coverages.find((c) => c.outletId === 'nikkei');
  assert.ok(nikkei, '記事の無い紙の社説 coverage が足される');
  assert.equal(nikkei.editorialTitle, '日経の社説');
  assert.equal(nikkei.headline, '日経の社説');
});

test('versionsOfEvent: 同じ出来事だけを、新しい版から順に返す', () => {
  const mk = (eventId, version) => ({ ...row([]), eventId, version, id: `${eventId}-v${version}` });
  const rows = [mk('c1', 1), mk('c2', 3), mk('c1', 14), mk('c1', 2)];
  const out = versionsOfEvent(rows, 'c1');
  assert.deepEqual(out.map((r) => r.version), [14, 2, 1]);
  assert.deepEqual(versionsOfEvent(rows, 'c9'), []);
});

test('rowFromListItem: 既読フラグ・重要度閾値・社説紙・媒体の重複排除が反映される', () => {
  const base = {
    version_id: 7,
    version_no: 2,
    version_title: '続報タイトル',
    version_created_at: '2026-11-15T01:00:00.000Z',
    cluster_id: 42,
    cluster_title: '出来事タイトル',
    category: '政治',
    first_seen_at: '2026-11-15T00:00:00.000Z',
    last_seen_at: '2026-11-15T01:00:00.000Z',
    importance_score: 40,
    article_count: 3,
    source_count: 2,
    latest_published: '2026-11-15T00:30:00.000Z',
    sources: '朝日,Google,Google',
    lead: 'リード',
    editorial_papers: '朝日新聞,読売新聞',
    read_flag: 1,
    bookmarked: 0,
  };
  const r = rowFromListItem(base);
  assert.equal(r.read, true);
  assert.equal(r.isImportant, true); // 閾値ちょうど 40 は重要
  assert.deepEqual(r.editorialPapers, ['朝日新聞', '読売新聞']);
  assert.deepEqual(r.coverages.map((c) => c.outletId), ['asahi', 'Google']);
  const unread = rowFromListItem({ ...base, read_flag: 0, importance_score: 39 });
  assert.equal(unread.read, false);
  assert.equal(unread.isImportant, false);
});
