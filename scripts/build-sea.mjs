// SEA（単一実行ファイル）配布物のビルド。
// 使い方: node scripts/build-sea.mjs [--target linux,win32]
//   --target を省略すると実行環境のプラットフォーム向けだけを作る。
//   win32 は nodejs.org から公式 node.exe をダウンロードして注入する（署名は外れる＝未署名になる）。
// 生成物は dist/sea/ に置く。ビルド時依存は esbuild と postject のみ（ランタイム依存は増やさない）。
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'dist', 'sea');
const PUBLIC_DIR = join(ROOT, 'public');
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function parseTargets() {
  const idx = process.argv.indexOf('--target');
  if (idx === -1) return [process.platform];
  return (process.argv[idx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** public/ 配下の全ファイルを SEA assets 用の { キー: 実ファイルパス } にする。キーは '/' 区切り。 */
function collectAssets() {
  const assets = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else assets[relative(PUBLIC_DIR, full).split(sep).join('/')] = full;
    }
  };
  walk(PUBLIC_DIR);
  return assets;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  await pipeline(res.body, createWriteStream(dest));
}

/**
 * Windows 向けに使う公式 Node のバージョン（固定。上げる時はここを書き換える）。
 * 「最新に追随」はしない: 再現性とチェックサム照合のため（2026-11-16 コンプライアンス対応 #9）。
 */
const NODE_VERSION = 'v24.22.3';

async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** 公式 SHASUMS256.txt から win-x64/node.exe の期待ハッシュを引く。 */
async function expectedNodeExeHash(version) {
  const res = await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`);
  if (!res.ok) throw new Error(`SHASUMS256.txt の取得に失敗: ${res.status}`);
  const text = await res.text();
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+win-x64\/node\.exe$/);
    if (m) return m[1];
  }
  throw new Error(`SHASUMS256.txt に win-x64/node.exe の項目がありません（${version}）`);
}

/**
 * Windows 向けの公式 node.exe を用意する。
 * ダウンロード後（キャッシュ済みでも毎回）公式チェックサムと照合し、
 * 一致しないファイルは使わずに落とす。
 */
async function fetchWindowsNode() {
  const cacheDir = join(OUT_DIR, 'cache');
  mkdirSync(cacheDir, { recursive: true });
  const dest = join(cacheDir, `node-${NODE_VERSION}-win-x64.exe`);
  if (!existsSync(dest)) {
    console.log(`Windows 用 Node をダウンロード: ${NODE_VERSION}`);
    await download(`https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`, dest);
  }
  const expected = await expectedNodeExeHash(NODE_VERSION);
  const actual = await sha256File(dest);
  if (actual !== expected) {
    unlinkSync(dest);
    throw new Error(`node.exe のチェックサムが公式値と一致しません（expected ${expected}, got ${actual}）。ファイルを削除しました`);
  }
  console.log(`Windows 用 Node のチェックサム照合 OK: ${NODE_VERSION}`);
  return dest;
}

async function main() {
  const targets = parseTargets();
  mkdirSync(OUT_DIR, { recursive: true });

  // 1. サーバー一式を単一 CJS ファイルへバンドル（node: 組み込みは外部のまま）
  const bundlePath = join(OUT_DIR, 'main.cjs');
  await build({
    entryPoints: [join(ROOT, 'server.mjs')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: bundlePath,
    logLevel: 'warning',
  });
  console.log(`バンドル完了: ${bundlePath}`);

  // 2. sea-config を生成して blob を作る
  //    useSnapshot は使わない（起動処理がビルド時に走ってしまうため）。
  //    useCodeCache も使わない（注入先バイナリの V8 とバージョンがずれると無効になるため）。
  const assets = collectAssets();
  const configPath = join(OUT_DIR, 'sea-config.json');
  writeFileSync(configPath, JSON.stringify({
    main: 'main.cjs',
    output: 'sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets,
  }, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: OUT_DIR, stdio: 'inherit' });
  const blobPath = join(OUT_DIR, 'sea-prep.blob');
  console.log(`SEA blob 生成完了（assets ${Object.keys(assets).length} 件）`);

  // 3. ターゲットごとに node バイナリへ注入する
  const postject = join(ROOT, 'node_modules', '.bin', 'postject');
  for (const target of targets) {
    const isWin = target === 'win32';
    const outName = `ichigyo-news-${target}-x64${isWin ? '.exe' : ''}`;
    const outPath = join(OUT_DIR, outName);
    let nodeBinary;
    if (isWin && process.platform !== 'win32') {
      nodeBinary = await fetchWindowsNode();
    } else if (target === process.platform) {
      nodeBinary = process.execPath;
    } else {
      throw new Error(`この環境（${process.platform}）から ${target} 向けは生成できません（win32 のみダウンロード生成に対応）`);
    }
    cpSync(nodeBinary, outPath);
    execFileSync(postject, [outPath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SEA_FUSE], { stdio: 'inherit' });
    if (!isWin) chmodSync(outPath, 0o755);
    const mb = (statSync(outPath).size / 1024 / 1024).toFixed(1);
    console.log(`生成: ${outPath}（${mb} MB）`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
