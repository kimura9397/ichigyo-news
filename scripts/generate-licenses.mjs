// 配布物に含まれる第三者ソフトウェアのライセンス一覧を生成する。
// 使い方: node scripts/generate-licenses.mjs
// 出力先: frontend/public/third-party-licenses.txt
//   フロントのビルドで public/ にコピーされ、Web 配布と SEA（exe）の両方に同梱される。
// 正本は生成先の frontend/public/ 側だけ（Issue #10、案Aで現状維持を明示）。
//   ルートの public/third-party-licenses.txt は Vite ビルド時に publicDir から
//   コピーされたもので、正本ではない。両方に同一ファイルがあるのはビルドの
//   仕組み上当然の重複であり、手で片方だけ消してはいけない:
//   public/ は成果物ごと git 追跡し（clone 直後にビルド不要で
//   `node server.mjs` だけで動くため）、SEA ビルドも public/ を同梱するため、
//   public/ 側が欠けると配布物で /third-party-licenses.txt が開けなくなる。
//   内容を更新する時はこのスクリプトで正本を生成し直し、フロントのビルドで
//   public/ 側へ反映すること。
// 対象は「配布物に実際に含まれるもの」だけ:
//   - Web UI にバンドルされる npm パッケージ（frontend の dependencies のうち実行時に使うもの）
//   - Windows exe の土台になる Node.js 本体（バージョンは build-sea.mjs の NODE_VERSION と一致させる）
// ビルド時だけの道具（Vite / esbuild / postject / TypeScript 等）は配布物に含まれないため載せない。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND_MODULES = join(ROOT, 'frontend', 'node_modules');
const OUT = join(ROOT, 'frontend', 'public', 'third-party-licenses.txt');

// UI にバンドルされる実行時依存（frontend/package.json の dependencies に対応）
const UI_PACKAGES = ['react', 'react-dom', 'scheduler'];

function nodeVersion() {
  const src = readFileSync(join(ROOT, 'scripts', 'build-sea.mjs'), 'utf8');
  const m = src.match(/const NODE_VERSION = '(v[0-9.]+)'/);
  if (!m) throw new Error('build-sea.mjs から NODE_VERSION を読めませんでした');
  return m[1];
}

function packageEntry(name) {
  const dir = join(FRONTEND_MODULES, name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const licensePath = ['LICENSE', 'LICENSE.md', 'LICENSE.txt']
    .map((f) => join(dir, f))
    .find((f) => existsSync(f));
  if (!licensePath) throw new Error(`${name} の LICENSE ファイルが見つかりません`);
  return { name: pkg.name, version: pkg.version, license: pkg.license, text: readFileSync(licensePath, 'utf8').trim() };
}

async function nodeEntry(version) {
  const url = `https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Node.js の LICENSE 取得に失敗: ${res.status} ${url}`);
  return { name: 'Node.js', version, license: 'Node.js License（同梱ライブラリ分を含む）', text: (await res.text()).trim() };
}

async function main() {
  const version = nodeVersion();
  const entries = [...UI_PACKAGES.map(packageEntry), await nodeEntry(version)];
  const parts = [
    '一行ニュースに同梱している第三者ソフトウェアのライセンス一覧です。',
    '一行ニュース本体のライセンスは MIT（リポジトリの LICENSE）です。',
    'ここに挙げるのは配布物（Web ビルドと Windows exe）に実際に含まれるものだけで、',
    'ビルド時だけ使う道具（Vite / esbuild / postject / TypeScript 等）は含まれないため載せていません。',
    `Node.js は Windows exe の土台として使う公式配布バイナリ（${version}）の分です。`,
    '',
  ];
  for (const e of entries) {
    parts.push('='.repeat(72));
    parts.push(`${e.name} ${e.version}`);
    parts.push(`License: ${e.license}`);
    parts.push('='.repeat(72));
    parts.push(e.text);
    parts.push('');
  }
  writeFileSync(OUT, parts.join('\n'));
  console.log(`生成: ${OUT}（${entries.map((e) => `${e.name} ${e.version}`).join(', ')}）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
