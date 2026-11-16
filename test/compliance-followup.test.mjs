// コンプライアンス対応の残件（2026-11-16）の検証。
// - 外部応答の読み取り上限（readResponseText）: 上限内は読み切れ、上限超は例外になる
// - 静的ガード: 既定ループバック、SW の同一オリジン限定とキャッシュ版数、
//   build-sea の Node バージョン固定と SHASUMS256 照合、キーワードの Google 送信注記、
//   第三者ライセンス一覧の同梱
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readResponseText, MAX_FEED_BYTES } from '../src/collector.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

function streamResponse(text) {
  const bytes = new TextEncoder().encode(text);
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

test('readResponseText: ストリーム応答は上限内なら読み切れる', async () => {
  const xml = '<rss><channel><title>検証</title></channel></rss>';
  assert.equal(await readResponseText(streamResponse(xml), 1024), xml);
});

test('readResponseText: ストリーム応答が上限を超えたら例外になる', async () => {
  const big = 'x'.repeat(2048);
  await assert.rejects(() => readResponseText(streamResponse(big), 1024), /too large/);
});

test('readResponseText: text() だけの応答（スタブ）も上限で判定される', async () => {
  assert.equal(await readResponseText({ ok: true, text: async () => 'abc' }, 1024), 'abc');
  await assert.rejects(
    () => readResponseText({ ok: true, text: async () => 'x'.repeat(2048) }, 1024),
    /too large/,
  );
});

test('readResponseText: 既定の上限は 5MB', () => {
  assert.equal(MAX_FEED_BYTES, 5 * 1024 * 1024);
});

test('サーバーの既定の待ち受けはループバック', () => {
  const server = read('server.mjs');
  assert.ok(server.includes("process.env.HOST || '127.0.0.1'"), 'HOST の既定が 127.0.0.1 になっていません');
  assert.ok(!server.includes('全インターフェース'), '「全インターフェース」待ち受けの記述が残っています');
  assert.ok(server.includes('MAX_JSON_BODY_BYTES'), 'JSON 受信上限がありません');
});

test('サービスワーカーは同一オリジンだけをキャッシュし、キャッシュ名は v2', () => {
  const sw = read('frontend/public/sw.js');
  assert.ok(sw.includes('url.origin !== self.location.origin'), '外部オリジンを素通りさせる判定がありません');
  assert.ok(sw.includes("const CACHE = 'ichigyo-news-shell-v2'"), 'キャッシュ名が v2 に上がっていません');
});

test('build-sea は Node のバージョン固定とチェックサム照合を行う', () => {
  const buildSea = read('scripts/build-sea.mjs');
  assert.ok(buildSea.includes("const NODE_VERSION = 'v24.22.3'"), 'Node のバージョンが固定されていません');
  assert.ok(buildSea.includes('SHASUMS256.txt'), 'SHASUMS256 での照合がありません');
  assert.ok(!buildSea.includes('dist/index.json'), '「最新に追随」する取得が残っています');
});

test('キーワードウォッチの注記（Google ニュース検索への送信）が設定画面にある', () => {
  const app = read('frontend/src/App.tsx');
  assert.ok(app.includes('Google ニュース検索に送信されます'), '設定画面に送信の注記がありません');
});

test('第三者ライセンス一覧が同梱され、React と Node.js を含む', () => {
  const path = join(ROOT, 'frontend/public/third-party-licenses.txt');
  assert.ok(existsSync(path), 'frontend/public/third-party-licenses.txt がありません');
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes('react'), 'React のライセンスが含まれていません');
  assert.ok(text.includes('MIT License'), 'MIT ライセンス文が含まれていません');
  assert.ok(text.includes('Node.js'), 'Node.js のライセンスが含まれていません');
});
