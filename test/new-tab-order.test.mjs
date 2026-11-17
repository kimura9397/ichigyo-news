// 新着タブの並び（2026-11-17 ユーザー承認）の統合テスト（一時DBで実サーバーを起動）。
// - 主キーは発表時刻（その版の最新記事の published_at）降順。検知時刻（versions.created_at）は第2キー
// - 発表時刻が無い（全記事 published_at が NULL の）版は検知時刻で並ぶ
// - 対象条件（検知から24時間以内）は従来どおり
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';
import { normalizeForSearch } from '../src/normalize.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8925;
const BASE = `http://127.0.0.1:${PORT}`;

let proc;
let dir;
const ids = {};

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const iso = (t) => new Date(t).toISOString();

function seed(dbPath) {
  const db = openDb(dbPath);
  const base = Date.now();
  const mk = (title, versionCreatedAt, publishedAt) => {
    const c = db.prepare(
      'INSERT INTO clusters (title, title_norm, category, first_seen_at, last_seen_at, importance_score) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(title, normalizeForSearch(title), '社会', iso(base), iso(base), 10);
    const cid = Number(c.lastInsertRowid);
    const v = db.prepare(
      'INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1, ?, ?)',
    ).run(cid, title, iso(versionCreatedAt));
    const vid = Number(v.lastInsertRowid);
    db.prepare(
      'INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(cid, vid, '朝日', title, `https://example.com/${cid}`, '要約', publishedAt, iso(base), normalizeForSearch(title));
    return cid;
  };
  // A: 検知は一番新しいが、発表は6時間前 → 発表時刻順では最後になる
  ids.a = mk('検知は新しいが発表は古いニュース', base - 10 * MIN, iso(base - 6 * HOUR));
  // B: 検知は3時間前だが、発表は20分前 → 発表時刻順では先頭になる
  ids.b = mk('検知は古いが発表は新しいニュース', base - 3 * HOUR, iso(base - 20 * MIN));
  // C: 発表時刻なし → 検知時刻（1時間前）で並び、B と A の間に入る
  ids.c = mk('発表時刻のないニュース', base - 1 * HOUR, null);
  // D: 検知が25時間前 → 発表が新しくても新着タブの対象外（24時間条件は不変）
  ids.d = mk('検知が24時間より前のニュース', base - 25 * HOUR, iso(base - 5 * MIN));
  // 直近に収集が終わったことにして、テスト中に背景 refresh が走らないようにする
  db.prepare('INSERT INTO fetch_runs (started_at, finished_at) VALUES (?, ?)').run(iso(base), iso(base));
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
  dir = mkdtempSync(join(tmpdir(), 'ichigyo-new-order-'));
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

test('新着タブは発表時刻の降順で並び、発表時刻なしは検知時刻で並ぶ', async () => {
  const res = await fetch(`${BASE}/api/stories?tab=new&limit=100`);
  assert.equal(res.ok, true);
  const data = await res.json();
  assert.equal(data.total, 3, '検知24時間以内の3件だけが対象');
  assert.deepEqual(
    data.stories.map((s) => s.cluster_id),
    [ids.b, ids.c, ids.a],
    '発表時刻順（B: 20分前 → C: 発表なし・検知1時間前 → A: 6時間前）',
  );
});
