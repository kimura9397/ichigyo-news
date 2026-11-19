// 更新通知（Issue #26、2026-11-19）のテスト。
// - バージョン比較（parseVersion / compareVersions / isNewerVersion）の単体テスト
// - checkLatestRelease / fetchLatestRelease の単体テスト（fetch をスタブに差し替え）:
//   checkLatestRelease は新しい版がある時だけ情報を返し、同版・旧版・取得失敗・
//   想定外の応答ではすべて null（=何も出さない）になること。
//   fetchLatestRelease（Issue #47 の手動再チェック用）は新旧によらず最新版の
//   情報を返し、失敗時だけ null になること
// - サーバー統合テスト: 起動時に1回だけ確認し、結果が /api/status の
//   update に載ること。確認先は環境変数 ICHIGYO_UPDATE_CHECK_URL で
//   ローカルのスタブに差し替える（実 GitHub にはアクセスしない）
// - 手動再チェック（Issue #47）: POST /api/update-check が再確認して
//   { currentVersion, update, failed } を返し、結果が /api/status の update にも
//   反映されること。/api/status に version（現行バージョン）が載ること
// - フロント: updateFromRaw の変換と、UpdateNotice がホバー表示＋
//   クリック遷移のみで強制遷移をしないことの静的検査。設定メニューの
//   バージョン表示・「更新を確認」・データ整理のインライン確認の静的検査
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';
import { normalizeForSearch } from '../src/normalize.mjs';
import { parseVersion, compareVersions, isNewerVersion, checkLatestRelease, fetchLatestRelease } from '../src/update-check.mjs';
import { APP_VERSION } from '../src/version.mjs';
import { updateFromRaw } from '../frontend/src/api.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/* ---------- バージョン比較 ---------- */

test('parseVersion: v 接頭辞とプレリリースを分解し、解釈できない値は null', () => {
  assert.deepEqual(parseVersion('v0.4.0'), { core: [0, 4, 0], prerelease: null });
  assert.deepEqual(parseVersion('0.4'), { core: [0, 4], prerelease: null });
  assert.deepEqual(parseVersion('1.2.3-beta.1'), { core: [1, 2, 3], prerelease: ['beta', '1'] });
  assert.deepEqual(parseVersion('v1.0.0+build5'), { core: [1, 0, 0], prerelease: null });
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion('v'), null);
  assert.equal(parseVersion('0.4.x'), null);
  assert.equal(parseVersion(null), null);
  assert.equal(parseVersion(undefined), null);
});

test('compareVersions: 数値として桁ごとに比べる（文字列順では 0.10 が 0.9 より古くなる）', () => {
  assert.equal(compareVersions('v0.5.0', '0.4.0'), 1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.4.0', 'v0.4.0'), 0);
  assert.equal(compareVersions('0.4', '0.4.0'), 0);
  assert.equal(compareVersions('0.3.9', '0.4.0'), -1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
});

test('compareVersions: プレリリースは正式版より古く、解釈できない値は新しくない扱い', () => {
  assert.equal(compareVersions('0.5.0-beta', '0.5.0'), -1);
  assert.equal(compareVersions('0.5.0', '0.5.0-beta'), 1);
  assert.equal(compareVersions('0.5.0-beta.2', '0.5.0-beta.1'), 1);
  assert.equal(compareVersions('not-a-version', '0.4.0'), 0);
  assert.equal(compareVersions('0.5.0', 'not-a-version'), 0);
});

test('isNewerVersion: 厳密に新しい時だけ true', () => {
  assert.equal(isNewerVersion('v0.5.0', '0.4.0'), true);
  assert.equal(isNewerVersion('v0.4.0', '0.4.0'), false);
  assert.equal(isNewerVersion('v0.3.0', '0.4.0'), false);
  assert.equal(isNewerVersion('', '0.4.0'), false);
});

/* ---------- checkLatestRelease（fetch スタブ） ---------- */

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => JSON.stringify(data) };
}

// 「現行版より新しい版」の役。実在の次版番号を使うと、その版へ bump した
// 途端に「新しくない」扱いになりサーバー統合テストが落ちるため、遠い将来版にする。
const RELEASE = {
  tag_name: 'v9.9.9',
  html_url: 'https://github.com/kimura9397/ichigyo-news/releases/tag/v9.9.9',
  body: '## 変更点\n新しい版です。',
  published_at: '2026-11-19T00:00:00Z',
};

test('checkLatestRelease: 新しい版があれば版・URL・ノート・公開日時を返す', async () => {
  const info = await checkLatestRelease({
    currentVersion: '0.4.0',
    fetchImpl: async () => jsonResponse(RELEASE),
  });
  assert.deepEqual(info, {
    version: '9.9.9',
    url: 'https://github.com/kimura9397/ichigyo-news/releases/tag/v9.9.9',
    notes: '## 変更点\n新しい版です。',
    publishedAt: '2026-11-19T00:00:00Z',
  });
});

test('checkLatestRelease: 同じ版・古い版では null（何も出さない）', async () => {
  const same = await checkLatestRelease({
    currentVersion: '0.4.0',
    fetchImpl: async () => jsonResponse({ ...RELEASE, tag_name: 'v0.4.0' }),
  });
  assert.equal(same, null);
  const older = await checkLatestRelease({
    currentVersion: '0.4.0',
    fetchImpl: async () => jsonResponse({ ...RELEASE, tag_name: 'v0.3.0' }),
  });
  assert.equal(older, null);
});

test('checkLatestRelease: 取得に失敗したら null（例外・HTTPエラー・壊れたJSON）', async () => {
  const thrown = await checkLatestRelease({
    currentVersion: '0.4.0',
    fetchImpl: async () => { throw new Error('network down'); },
  });
  assert.equal(thrown, null);
  const httpError = await checkLatestRelease({
    currentVersion: '0.4.0',
    fetchImpl: async () => jsonResponse({}, { ok: false, status: 503 }),
  });
  assert.equal(httpError, null);
  const broken = await checkLatestRelease({
    currentVersion: '0.4.0',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not json' }),
  });
  assert.equal(broken, null);
});

test('checkLatestRelease: tag_name が無い応答は null、ノートが無ければ空文字で返す', async () => {
  const noTag = await checkLatestRelease({
    currentVersion: '0.4.0',
    fetchImpl: async () => jsonResponse({ html_url: 'https://example.com' }),
  });
  assert.equal(noTag, null);
  const noNotes = await checkLatestRelease({
    currentVersion: '0.4.0',
    fetchImpl: async () => jsonResponse({ tag_name: 'v9.9.9', html_url: 'https://example.com/r', body: null, published_at: null }),
  });
  assert.deepEqual(noNotes, { version: '9.9.9', url: 'https://example.com/r', notes: '', publishedAt: null });
});

test('fetchLatestRelease: 新旧によらず最新版の情報を返し、失敗時だけ null', async () => {
  const newer = await fetchLatestRelease({
    fetchImpl: async () => jsonResponse(RELEASE),
  });
  assert.equal(newer.version, '9.9.9');
  const same = await fetchLatestRelease({
    fetchImpl: async () => jsonResponse({ ...RELEASE, tag_name: 'v0.4.0' }),
  });
  assert.equal(same.version, '0.4.0', '同版でも情報を返す（最新版かどうかの判定用）');
  const older = await fetchLatestRelease({
    fetchImpl: async () => jsonResponse({ ...RELEASE, tag_name: 'v0.3.0' }),
  });
  assert.equal(older.version, '0.3.0');
  const failed = await fetchLatestRelease({
    fetchImpl: async () => { throw new Error('network down'); },
  });
  assert.equal(failed, null);
  const httpError = await fetchLatestRelease({
    fetchImpl: async () => jsonResponse({}, { ok: false, status: 503 }),
  });
  assert.equal(httpError, null);
  const noTag = await fetchLatestRelease({
    fetchImpl: async () => jsonResponse({ html_url: 'https://example.com' }),
  });
  assert.equal(noTag, null);
});

test('APP_VERSION は package.json の version と一致する', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(APP_VERSION, pkg.version);
});

/* ---------- サーバー統合（確認先はローカルスタブ） ---------- */

function seed(dbPath) {
  const db = openDb(dbPath);
  const now = new Date().toISOString();
  const c = db.prepare(
    'INSERT INTO clusters (title, title_norm, category, first_seen_at, last_seen_at, importance_score) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('更新通知テスト用のニュース', normalizeForSearch('更新通知テスト用のニュース'), '社会', now, now, 10);
  const cid = Number(c.lastInsertRowid);
  const v = db.prepare(
    'INSERT INTO versions (cluster_id, version_no, title, created_at) VALUES (?, 1, ?, ?)',
  ).run(cid, '更新通知テスト用のニュース', now);
  const vid = Number(v.lastInsertRowid);
  db.prepare(
    'INSERT INTO articles (cluster_id, version_id, source, title, url, summary, published_at, fetched_at, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(cid, vid, '朝日', '更新通知テスト用のニュース', `https://example.com/${cid}`, '要約', now, now, normalizeForSearch('更新通知テスト用のニュース'));
  db.prepare('INSERT INTO fetch_runs (started_at, finished_at) VALUES (?, ?)').run(now, now);
  db.close();
}

async function freePort() {
  const srv = createNetServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/** リリースAPIのスタブを立てる。handler は (req, res) を受け取る。 */
async function startStub(handler) {
  const stub = createHttpServer(handler);
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${stub.address().port}/releases/latest`,
    stop: () => new Promise((resolve) => stub.close(resolve)),
  };
}

async function startAppServer(updateCheckUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'ichigyo-update-'));
  const dbPath = join(dir, 'news.db');
  seed(dbPath);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn('node', ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NEWS_DB_PATH: dbPath, ICHIGYO_UPDATE_CHECK_URL: updateCheckUrl },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/status`);
      if (res.ok) break;
    } catch { /* 起動待ち */ }
    if (Date.now() > deadline) throw new Error('サーバーが起動しませんでした');
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    base,
    stop: async () => {
      proc.kill('SIGKILL');
      await new Promise((r) => proc.once('exit', r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function statusJson(base) {
  const res = await fetch(`${base}/api/status`);
  assert.equal(res.ok, true);
  return res.json();
}

/** update が非 null になるまで待つ（起動時確認は非同期のため）。 */
async function waitUpdate(base, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await statusJson(base);
    if (s.update) return s.update;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('サーバー: 新しい版があると /api/status の update に載る', async () => {
  const stub = await startStub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(RELEASE));
  });
  const app = await startAppServer(stub.url);
  try {
    const update = await waitUpdate(app.base);
    assert.ok(update, 'update が載りませんでした');
    assert.equal(update.version, '9.9.9');
    assert.equal(update.url, RELEASE.html_url);
    assert.equal(update.notes, RELEASE.body);
    assert.equal(update.publishedAt, RELEASE.published_at);
  } finally {
    await app.stop();
    await stub.stop();
  }
});

test('サーバー: 現行と同じ版では update は null のまま', async () => {
  const stub = await startStub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...RELEASE, tag_name: `v${APP_VERSION}` }));
  });
  const app = await startAppServer(stub.url);
  try {
    // 起動時確認が終わるまで十分に待ち、その間も update が立たないことを見る
    await new Promise((r) => setTimeout(r, 2000));
    const s = await statusJson(app.base);
    assert.equal(s.update, null);
  } finally {
    await app.stop();
    await stub.stop();
  }
});

test('サーバー: 確認先がエラーを返しても update は null で、サーバーは動き続ける', async () => {
  const stub = await startStub((req, res) => {
    res.writeHead(500);
    res.end('error');
  });
  const app = await startAppServer(stub.url);
  try {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await statusJson(app.base);
    assert.equal(s.update, null);
  } finally {
    await app.stop();
    await stub.stop();
  }
});

test('サーバー: 更新確認は起動時の1回だけで、ポーリングには相乗りしない', () => {
  const server = read('server.mjs');
  assert.ok(server.includes('checkLatestRelease({ currentVersion: APP_VERSION'), '起動時の確認がありません');
  assert.ok(server.includes('update: updateInfo'), '/api/status に update が載っていません');
  const pollBody = server.slice(server.indexOf('function schedulePoll()'), server.indexOf('function setPolling'));
  assert.ok(!pollBody.includes('checkLatestRelease'), 'ポーリングのタイマーで更新確認をしています');
  assert.ok(!server.includes('setInterval'), '定期実行で更新確認をしています');
});

test('サーバー: /api/status に現行バージョン（version）が載る', async () => {
  const stub = await startStub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...RELEASE, tag_name: `v${APP_VERSION}` }));
  });
  const app = await startAppServer(stub.url);
  try {
    const s = await statusJson(app.base);
    assert.equal(s.version, APP_VERSION);
  } finally {
    await app.stop();
    await stub.stop();
  }
});

test('サーバー: POST /api/update-check は再確認し、結果が /api/status にも反映される', async () => {
  // スタブの応答を途中で切り替える: 最初は同版（新版なし）→ 後から新版を出す
  let stubData = { ...RELEASE, tag_name: `v${APP_VERSION}` };
  let stubStatus = 200;
  const stub = await startStub((req, res) => {
    res.writeHead(stubStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify(stubData));
  });
  const app = await startAppServer(stub.url);
  try {
    // 起動時確認（同版→ update なし）が済むまで待つ
    await new Promise((r) => setTimeout(r, 2000));
    const post = async () => {
      const res = await fetch(`${app.base}/api/update-check`, { method: 'POST' });
      assert.equal(res.ok, true);
      return res.json();
    };
    const sameResult = await post();
    assert.equal(sameResult.currentVersion, APP_VERSION);
    assert.equal(sameResult.update, null, '同版では update は null（最新版）');
    assert.equal(sameResult.failed, false);

    // 新版が出たら、手動チェックで拾えて /api/status の update にも載る
    stubData = RELEASE;
    const newerResult = await post();
    assert.equal(newerResult.failed, false);
    assert.equal(newerResult.update.version, '9.9.9');
    assert.equal(newerResult.update.url, RELEASE.html_url);
    const s = await statusJson(app.base);
    assert.equal(s.update.version, '9.9.9', 'マストヘッド通知用に /api/status の update も置き換わる');

    // 取得失敗時は failed=true で、update は据え置き
    stubStatus = 500;
    const failedResult = await post();
    assert.equal(failedResult.failed, true);
    assert.equal(failedResult.update.version, '9.9.9', '失敗時は前回の update を保持する');
  } finally {
    await app.stop();
    await stub.stop();
  }
});

/* ---------- フロント ---------- */

test('updateFromRaw: 正常な更新情報を変換し、不正な値は null にする', () => {
  assert.deepEqual(
    updateFromRaw({ version: '0.5.0', url: 'https://example.com/r', notes: 'ノート', publishedAt: '2026-11-19T00:00:00Z' }),
    { version: '0.5.0', url: 'https://example.com/r', notes: 'ノート', publishedAt: '2026-11-19T00:00:00Z' },
  );
  assert.equal(updateFromRaw(null), null);
  assert.equal(updateFromRaw(undefined), null);
  assert.equal(updateFromRaw({ url: 'https://example.com/r' }), null, '版が無ければ出さない');
  assert.equal(updateFromRaw({ version: '0.5.0', url: 'javascript:alert(1)' }), null, '不正なURLは出さない');
  assert.deepEqual(
    updateFromRaw({ version: '0.5.0', url: 'https://example.com/r' }),
    { version: '0.5.0', url: 'https://example.com/r', notes: '', publishedAt: null },
  );
});

test('フロント: UpdateNotice はホバーでパネルを出し、遷移はクリック時のリンクだけ', () => {
  const notice = read('frontend/src/UpdateNotice.tsx');
  assert.ok(notice.includes('onMouseEnter'), 'マウスオーバーでパネルを開いていません');
  assert.ok(notice.includes('update.notes'), 'パネルにリリースノートを出していません');
  assert.ok(notice.includes('href={update.url}'), 'リリースページへのリンクがありません');
  assert.ok(!notice.includes('location.'), '強制遷移（location 操作）が含まれています');
  assert.ok(!notice.includes('useEffect'), '副作用での自動表示・遷移が含まれています');
  // 表示はバッジでなく「vX.Y.Z があります」のテキスト（Issue #51）
  assert.ok(notice.includes('v{update.version}'), '版番号のテキスト表示がありません');
  assert.ok(notice.includes('update-link-version'), '版番号の強調スパンがありません');
  assert.ok(!notice.includes('update-badge'), '旧バッジのクラスが残っています');
  const css = read('frontend/src/App.css');
  assert.ok(css.includes('.update-link-version'), '版番号のスタイルがありません');
  assert.ok(css.includes('color: var(--vermillion)'), '版番号が朱（テーマ連動）になっていません');
  assert.ok(!css.includes('#f5b921'), '旧バッジの黄色が残っています');
  const app = read('frontend/src/App.tsx');
  assert.ok(app.includes('{updateInfo ? <UpdateNotice update={updateInfo} /> : null}'), '新しい版がある時だけ出す条件分岐がありません');
  assert.ok(app.includes('setUpdateInfo(s.update)'), '/api/status の update を画面に反映していません');
});

test('フロント: 設定メニューにバージョン表示と「更新を確認」がある（Issue #47）', () => {
  const menu = read('frontend/src/SettingsMenu.tsx');
  assert.ok(menu.includes('<h3>バージョン</h3>'), 'バージョンセクションがありません');
  assert.ok(menu.includes('一行ニュース {appVersion'), '「一行ニュース vX.Y.Z」の表示がありません');
  assert.ok(menu.includes('更新を確認'), '「更新を確認」ボタンがありません');
  assert.ok(menu.includes('最新版です。'), '最新版の結果表示がありません');
  assert.ok(menu.includes('があります'), '新版ありの結果表示がありません');
  assert.ok(menu.includes('リリースページ'), 'リリースページへのリンクがありません');
  const api = read('frontend/src/api.ts');
  assert.ok(api.includes("'/api/update-check'"), 'api.ts が POST /api/update-check を呼んでいません');
  assert.ok(api.includes('version: typeof data.version'), 'fetchServerStatus が version を取り込んでいません');
  const app = read('frontend/src/App.tsx');
  assert.ok(app.includes('setAppVersion(s.version)'), '/api/status の version を画面に反映していません');
  assert.ok(app.includes('setUpdateInfo(result.update)'), '手動チェックの結果をマストヘッド通知へ同期していません');
});

test('フロント: データ整理はモーダルでなく設定メニュー内のインライン確認（Issue #47）', () => {
  const menu = read('frontend/src/SettingsMenu.tsx');
  assert.ok(menu.includes('古いデータを削除してDBを圧縮'), 'データ整理ボタンがありません');
  assert.ok(menu.includes('元に戻せません。'), '確認表示の説明文がありません');
  assert.ok(menu.includes('実行する'), '確認表示の「実行する」がありません');
  assert.ok(menu.includes('やめる'), '確認表示の「やめる」がありません');
  assert.ok(!menu.includes('confirm('), 'ブラウザ標準の confirm() を使っています');
  const app = read('frontend/src/App.tsx');
  assert.ok(!app.includes('modal-overlay'), 'App にモーダルの残骸があります');
  assert.ok(!app.includes('confirmingMaintenance'), 'App に旧確認ダイアログの状態が残っています');
});
