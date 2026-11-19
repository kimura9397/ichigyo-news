// 天気の場所設定で使う市区町村リスト（frontend/src/cities.ts）の生成スクリプト。
// アプリの実行時には使わない（同梱済みリストを再生成するときだけ手で実行する）。
//
// データの出所:
//   国土交通省 位置参照情報ダウンロードサービスで配布されている
//   「大字・町丁目レベル位置参照情報」（全国の大字・町丁目の代表点の緯度経度）を、
//   Geolonia が加工・公開している japanese-addresses の latest.csv 経由で取得した。
//   https://github.com/geolonia/japanese-addresses
//   元データ: https://nlftp.mlit.go.jp/isj/ （国土交通省 位置参照情報）
//
// 代表点の決め方:
//   市区町村ごとに、その市区町村に属する全ての大字・町丁目代表点の重心
//   （緯度経度の平均）を求め、重心に最も近い実在の町丁目代表点を、その
//   市区町村の代表点とする。重心そのものは海や山の中になることがあるため、
//   実在の町丁目の点から選ぶ。天気の取得グリッド（Open-Meteo は約 0.06 度）
//   に対して十分な精度がある。
//
// 使い方:
//   curl -o /tmp/japanese-addresses.csv https://geolonia.github.io/japanese-addresses/latest.csv
//   node scripts/build-cities.mjs /tmp/japanese-addresses.csv
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const csvPath = process.argv[2];
if (!csvPath) {
  console.error('usage: node scripts/build-cities.mjs <latest.csv のパス>');
  process.exit(1);
}

/** 引用符つき CSV の1行を列に分解する（このデータは値にカンマを含まない前提で、引用符だけ処理する）。 */
function parseLine(line) {
  const cols = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cols.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

const lines = readFileSync(csvPath, 'utf8').split('\n');
// 列: 0 都道府県コード, 1 都道府県名, 4 市区町村コード, 5 市区町村名, 12 緯度, 13 経度
const byCode = new Map();
for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  const cols = parseLine(line);
  const code = cols[4];
  const lat = Number(cols[12]);
  const lng = Number(cols[13]);
  if (!code || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  let entry = byCode.get(code);
  if (!entry) {
    entry = { code, pref: cols[1], name: cols[5], points: [] };
    byCode.set(code, entry);
  }
  entry.points.push([lat, lng]);
}

const cities = [...byCode.values()]
  .sort((a, b) => (a.code < b.code ? -1 : 1))
  .map((entry) => {
    let sumLat = 0;
    let sumLng = 0;
    for (const [lat, lng] of entry.points) {
      sumLat += lat;
      sumLng += lng;
    }
    const cLat = sumLat / entry.points.length;
    const cLng = sumLng / entry.points.length;
    let best = entry.points[0];
    let bestDist = Number.POSITIVE_INFINITY;
    for (const p of entry.points) {
      const d = (p[0] - cLat) ** 2 + (p[1] - cLng) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return {
      code: entry.code,
      pref: entry.pref,
      name: entry.name,
      lat: Math.round(best[0] * 10000) / 10000,
      lng: Math.round(best[1] * 10000) / 10000,
    };
  });

const today = new Date().toISOString().slice(0, 10);
const header = `// 天気の場所設定で使う市区町村リスト（同梱データ、${cities.length}件）。
// 出所: 国土交通省 位置参照情報ダウンロードサービスの「大字・町丁目レベル
// 位置参照情報」を、Geolonia が加工・公開する japanese-addresses 経由で取得し、
// 市区町村ごとに全町丁目代表点の重心に最も近い町丁目代表点を代表点とした。
// 生成方法と再生成手順は scripts/build-cities.mjs を参照（生成日: ${today}）。
// 地名はこのリストの中でだけ照合し、外部 API へは送らない（Open-Meteo へ
// 送るのは選んだ市区町村の緯度経度だけ）。
export interface CityEntry {
  /** 市区町村コード（5桁、総務省の全国地方公共団体コード） */
  code: string
  pref: string
  name: string
  lat: number
  lng: number
}

export const CITIES: CityEntry[] = [
`;
const body = cities
  .map(
    (c) =>
      `  { code: '${c.code}', pref: '${c.pref}', name: '${c.name}', lat: ${c.lat}, lng: ${c.lng} },`,
  )
  .join('\n');
const out = `${header}${body}\n]\n`;

const outDir = join(ROOT, 'frontend', 'src');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'cities.ts'), out);
console.log(`市区町村 ${cities.length} 件を frontend/src/cities.ts に書きました`);
const soka = cities.find((c) => c.code === '11221');
console.log('草加市 (11221):', soka);
