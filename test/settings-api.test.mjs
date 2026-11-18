// 設定メニュー関連のサーバー変更の統合テスト（一時DBで実サーバーを起動して叩く）。
// - 一覧行の read_flag（既読）: read_events があるクラスタだけ 1 になる。
// - カテゴリのミュート（mute パラメータ）: 重要タブでのみ除外され、
//   行・total・カテゴリ別件数が整合する。他タブでは無視される。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8917;
const BASE = `http://127.0.0.1:${PORT}`;

let proc;
let dir;
const ids = {};

function seed(dbPath) {
  const db = openDb(dbPath);
  const now = new Date().toISOString();
  const mk = (title, category, score) => {
    const c = db.prepare(
      'INSERT INTO clusters (title, category, first_seen_at, last_seen_at, importance_score) VALUES (?, ?, ?, ?, ?)',
    ).run(title, category, now, now, score);
    const cid = Number(c.lastInsertRowid);
    const v = db.prepare(
      'INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1, ?, ?)',
    ).run(cid, title, now);
    const vid = Number(v.lastInsertRowid);
    db.prepare(
      'INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(cid, vid, '朝日', title, `https://example.com/${cid}`, '要約', now, now);
    return cid;
  };
  ids.politics = mk('政治クラスタ', '政治', 100);
  ids.sports = mk('スポーツクラスタ', 'スポーツ', 100);
  ids.lowSports = mk('低スコアスポーツ', 'スポーツ', 10);
  // 政治クラスタは既読
  db.prepare('INSERT INTO read_events (cluster_id, category, opened_at) VALUES (?, ?, ?)')
    .run(ids.politics, '政治', now);
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
  dir = mkdtempSync(join(tmpdir(), 'ichigyo-settings-'));
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

async function stories(query) {
  const res = await fetch(`${BASE}/api/stories?${query}`);
  assert.equal(res.ok, true);
  return res.json();
}

test('read_flag: 既読クラスタの行だけ 1 になる', async () => {
  const data = await stories('tab=important');
  assert.equal(data.total, 2);
  const byCluster = new Map(data.stories.map((s) => [s.cluster_id, s.read_flag]));
  assert.equal(byCluster.get(ids.politics), 1);
  assert.equal(byCluster.get(ids.sports), 0);
});

test('mute: 重要タブではミュートしたカテゴリが 行・total・カテゴリ件数 から消える', async () => {
  const data = await stories('tab=important&mute=スポーツ');
  assert.equal(data.total, 1);
  assert.equal(data.stories.length, 1);
  assert.equal(data.stories[0].cluster_id, ids.politics);
  assert.equal(
    data.categories.some((c) => c.category === 'スポーツ'),
    false,
  );
  const politics = data.categories.find((c) => c.category === '政治');
  assert.equal(politics?.count, 1);
});

test('mute: 重要タブ以外では無視される', async () => {
  const data = await stories('tab=new&mute=スポーツ');
  assert.equal(data.total, 3);
});

test('read_flag: POST /api/read の後は既読になる', async () => {
  const res = await fetch(`${BASE}/api/read/${ids.sports}`, { method: 'POST' });
  assert.equal(res.ok, true);
  const data = await stories('tab=important');
  const sports = data.stories.find((s) => s.cluster_id === ids.sports);
  assert.equal(sports?.read_flag, 1);
});
