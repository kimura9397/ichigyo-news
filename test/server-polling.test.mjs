// ポーリングのサーバー側スケジューリング（2026-11-17 移行）の統合テスト。
// - 状態はサーバー側で DB に保存され、再起動時に復元される（有効なら
//   スケジュールも再開）。保存が無ければ初期は OFF。POST /api/polling で
//   変更でき、GET /api/status と GET /api/stories の両方に次回実行予定
//   （nextAt）が載る
// - 間隔は既存の 2/5/10 分のみ。それ以外は 400
// - フロントはタブ側タイマーで収集を開始せず、サーバー状態の設定と同期だけを行う
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';
import { normalizeForSearch } from '../src/normalize.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8926;
const BASE = `http://127.0.0.1:${PORT}`;
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let proc;
let dir;

function seed(dbPath) {
  const db = openDb(dbPath);
  const now = new Date().toISOString();
  const c = db.prepare(
    'INSERT INTO clusters (title, title_norm, category, first_seen_at, last_seen_at, importance_score) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('ポーリングテスト用のニュース', normalizeForSearch('ポーリングテスト用のニュース'), '社会', now, now, 10);
  const cid = Number(c.lastInsertRowid);
  const v = db.prepare(
    'INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1, ?, ?)',
  ).run(cid, 'ポーリングテスト用のニュース', now);
  const vid = Number(v.lastInsertRowid);
  db.prepare(
    'INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(cid, vid, '朝日', 'ポーリングテスト用のニュース', `https://example.com/${cid}`, '要約', now, now, normalizeForSearch('ポーリングテスト用のニュース'));
  // 直近に収集が終わったことにして、テスト中に背景 refresh が走らないようにする
  db.prepare('INSERT INTO fetch_runs (started_at, finished_at) VALUES (?, ?)').run(now, now);
  db.close();
}

async function waitReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/status`);
      if (res.ok) return;
    } catch {
      /* 起動待ち */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('サーバーが起動しませんでした');
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ichigyo-polling-'));
  const dbPath = join(dir, 'news.db');
  seed(dbPath);
  proc = spawn('node', ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NEWS_DB_PATH: dbPath },
    stdio: 'ignore',
  });
  await waitReady();
});

after(() => {
  proc?.kill('SIGKILL');
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function status() {
  const res = await fetch(`${BASE}/api/status`);
  assert.equal(res.ok, true);
  return res.json();
}

async function postPolling(body) {
  return fetch(`${BASE}/api/polling`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('初期状態は OFF で、/api/status に polling が載る', async () => {
  const s = await status();
  assert.deepEqual(s.polling, { enabled: false, minutes: 5, nextAt: null });
});

test('POST /api/polling で有効化でき、nextAt が間隔どおりに立つ', async () => {
  const before = Date.now();
  const res = await postPolling({ enabled: true, minutes: 2 });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.polling.enabled, true);
  assert.equal(data.polling.minutes, 2);
  assert.ok(typeof data.polling.nextAt === 'number', 'nextAt が数値で返る');
  assert.ok(data.polling.nextAt > before + 100 * 1000, 'nextAt は約2分先');
  assert.ok(data.polling.nextAt <= Date.now() + 120 * 1000, 'nextAt は2分以内');
  const s = await status();
  assert.equal(s.polling.enabled, true);
  assert.equal(s.polling.minutes, 2);
  assert.equal(s.polling.nextAt, data.polling.nextAt);
});

test('/api/stories のレスポンスにも polling が載る', async () => {
  const res = await fetch(`${BASE}/api/stories?tab=all&limit=10`);
  assert.equal(res.ok, true);
  const data = await res.json();
  assert.equal(data.polling.enabled, true);
  assert.equal(data.polling.minutes, 2);
  assert.ok(typeof data.polling.nextAt === 'number');
});

test('不正な間隔は 400 で、状態は変わらない', async () => {
  const res = await postPolling({ enabled: true, minutes: 7 });
  assert.equal(res.status, 400);
  const s = await status();
  assert.equal(s.polling.minutes, 2);
});

test('無効化すると nextAt が null に戻る', async () => {
  const res = await postPolling({ enabled: false, minutes: 2 });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.polling, { enabled: false, minutes: 2, nextAt: null });
  const s = await status();
  assert.equal(s.polling.enabled, false);
  assert.equal(s.polling.nextAt, null);
});

test('サーバー再起動でポーリング状態が復元され、スケジュールが再開する', async () => {
  const res = await postPolling({ enabled: true, minutes: 10 });
  assert.equal(res.status, 200);
  proc.kill('SIGKILL');
  await new Promise((r) => proc.once('exit', r));
  proc = spawn('node', ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NEWS_DB_PATH: join(dir, 'news.db') },
    stdio: 'ignore',
  });
  await waitReady();
  const s = await status();
  assert.equal(s.polling.enabled, true, '有効状態が復元される');
  assert.equal(s.polling.minutes, 10, '間隔が復元される');
  assert.ok(typeof s.polling.nextAt === 'number', 'スケジュールが再開し nextAt が立つ');
  assert.ok(s.polling.nextAt > Date.now(), 'nextAt は未来に立つ');
});

test('サーバー: タイマーは単一飛行の startRefresh に相乗りする', () => {
  const server = read('server.mjs');
  assert.ok(server.includes('function schedulePoll()'), 'schedulePoll がありません');
  const timerBody = server.slice(server.indexOf('pollTimer = setTimeout'));
  assert.ok(timerBody.includes('startRefresh();'), 'タイマーが startRefresh を呼んでいません');
  assert.ok(server.includes("p === '/api/polling' && req.method === 'POST'"), 'POST /api/polling がありません');
});

test('フロント: 収集開始はタブ側で行わず、サーバー状態の設定と同期だけを行う', () => {
  const app = read('frontend/src/App.tsx');
  const api = read('frontend/src/api.ts');
  assert.ok(api.includes("'/api/polling'"), 'api.ts に /api/polling の呼び出しがありません');
  assert.ok(app.includes('setPollingRemote'), 'App.tsx が setPollingRemote を使っていません');
  assert.ok(app.includes('fetchServerStatus'), 'App.tsx が fetchServerStatus で同期していません');
  assert.ok(!app.includes('pollTick'), 'タブ側の収集タイマー（pollTick）が残っています');
  assert.ok(!app.includes("localStorage.getItem('ichigyo:polling')"), 'ポーリング状態の localStorage 復元が残っています');
});
