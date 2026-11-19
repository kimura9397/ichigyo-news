// スポットライトの時刻＋天気（Issue #28、2026-11-19）のテスト。
// - src/weather.mjs の単体テスト（URL組み立て・天気コード変換・応答の正規化・
//   取得失敗時は null・場所の検証）
// - 同梱市区町村リスト（frontend/src/cities.ts）の整合性: 件数・コードの
//   一意性・座標の範囲・47都道府県・千代田区がサーバー既定値と一致すること
// - サーバー統合テスト: 取得先を環境変数 ICHIGYO_WEATHER_URL でローカルの
//   スタブに差し替え、/api/weather の返却・場所変更・不正値の拒否・再起動時の
//   復元を見る（実 Open-Meteo にはアクセスしない）
// - フロント: weatherFromRaw / formatNow の変換と、スポットライトの出典
//   リンク・設定メニューの場所検索の静的検査
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildWeatherUrl,
  weatherCodeLabel,
  parseWeatherResponse,
  fetchWeather,
  validateWeatherLocation,
  DEFAULT_WEATHER_LOCATION,
} from '../src/weather.mjs';
import { weatherFromRaw, formatNow } from '../frontend/src/api.ts';
import { CITIES } from '../frontend/src/cities.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Open-Meteo の実応答と同じ形（2026-11-19 の実測形） */
const SAMPLE = {
  latitude: 35.85,
  longitude: 139.8125,
  timezone: 'Asia/Tokyo',
  current: { time: '2026-11-19T10:45', interval: 900, temperature_2m: 16.9, weather_code: 0 },
  daily: {
    time: ['2026-11-19'],
    temperature_2m_max: [19.1],
    temperature_2m_min: [9.6],
    precipitation_probability_max: [10],
  },
};

/* ---------- 天気コード・URL・正規化 ---------- */

test('weatherCodeLabel: 主なWMOコードを日本語に変換し、未知のコードは空', () => {
  assert.equal(weatherCodeLabel(0), '晴れ');
  assert.equal(weatherCodeLabel(3), '曇り');
  assert.equal(weatherCodeLabel(61), '雨');
  assert.equal(weatherCodeLabel(71), '雪');
  assert.equal(weatherCodeLabel(80), 'にわか雨');
  assert.equal(weatherCodeLabel(95), '雷雨');
  assert.equal(weatherCodeLabel(999), '');
  assert.equal(weatherCodeLabel(-1), '');
});

test('buildWeatherUrl: 座標・現在値・日別・タイムゾーンを含む', () => {
  const url = buildWeatherUrl(35.6923, 139.7607);
  assert.ok(url.startsWith('https://api.open-meteo.com/v1/forecast?'));
  const params = new URL(url).searchParams;
  assert.equal(params.get('latitude'), '35.6923');
  assert.equal(params.get('longitude'), '139.7607');
  assert.equal(params.get('current'), 'temperature_2m,weather_code');
  assert.ok(params.get('daily').includes('temperature_2m_max'));
  assert.ok(params.get('daily').includes('precipitation_probability_max'));
  assert.equal(params.get('timezone'), 'Asia/Tokyo');
  assert.equal(params.get('forecast_days'), '1');
});

test('parseWeatherResponse: 実応答形を正規化する', () => {
  assert.deepEqual(parseWeatherResponse(SAMPLE), {
    temperature: 16.9,
    weatherCode: 0,
    label: '晴れ',
    max: 19.1,
    min: 9.6,
    precipitationProbability: 10,
    time: '2026-11-19T10:45',
  });
});

test('parseWeatherResponse: 現在値が欠けた応答・未知の天気コードは null', () => {
  assert.equal(parseWeatherResponse(null), null);
  assert.equal(parseWeatherResponse({}), null);
  assert.equal(parseWeatherResponse({ current: { weather_code: 0 } }), null);
  assert.equal(parseWeatherResponse({ current: { temperature_2m: 10 } }), null);
  assert.equal(
    parseWeatherResponse({ current: { temperature_2m: 10, weather_code: 999 } }),
    null,
  );
});

test('parseWeatherResponse: 降水確率が無い日別は null のまま残す', () => {
  const data = structuredClone(SAMPLE);
  data.daily.precipitation_probability_max = [null];
  const parsed = parseWeatherResponse(data);
  assert.equal(parsed.precipitationProbability, null);
  assert.equal(parsed.max, 19.1);
});

/* ---------- fetchWeather（fetch スタブ） ---------- */

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => JSON.stringify(data) };
}

test('fetchWeather: 正常な応答を正規化して返す', async () => {
  const w = await fetchWeather({
    lat: 35.6923,
    lng: 139.7607,
    fetchImpl: async () => jsonResponse(SAMPLE),
  });
  assert.equal(w.temperature, 16.9);
  assert.equal(w.label, '晴れ');
});

test('fetchWeather: 失敗したら null（例外・HTTPエラー・壊れたJSON）', async () => {
  const thrown = await fetchWeather({
    lat: 35.6923, lng: 139.7607,
    fetchImpl: async () => { throw new Error('network down'); },
  });
  assert.equal(thrown, null);
  const httpError = await fetchWeather({
    lat: 35.6923, lng: 139.7607,
    fetchImpl: async () => jsonResponse({}, { ok: false, status: 503 }),
  });
  assert.equal(httpError, null);
  const broken = await fetchWeather({
    lat: 35.6923, lng: 139.7607,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not json' }),
  });
  assert.equal(broken, null);
});

test('fetchWeather: URL上書きがある場合は座標から組み立てない', async () => {
  let seenUrl = '';
  await fetchWeather({
    lat: 35.6923, lng: 139.7607,
    url: 'http://127.0.0.1/stub',
    fetchImpl: async (u) => { seenUrl = u; return jsonResponse(SAMPLE); },
  });
  assert.equal(seenUrl, 'http://127.0.0.1/stub');
});

/* ---------- 場所の検証 ---------- */

test('validateWeatherLocation: 正常な場所を通し、不正な値を弾く', () => {
  assert.deepEqual(
    validateWeatherLocation({ code: '13101', name: '東京都千代田区', lat: 35.6923, lng: 139.7607 }),
    { code: '13101', name: '東京都千代田区', lat: 35.6923, lng: 139.7607 },
  );
  assert.equal(validateWeatherLocation(null), null);
  assert.equal(validateWeatherLocation({ name: '', lat: 35.8, lng: 139.8 }), null);
  assert.equal(validateWeatherLocation({ name: '千代田区', lat: 0, lng: 139.8 }), null, '日本の範囲外の緯度');
  assert.equal(validateWeatherLocation({ name: '千代田区', lat: 35.8, lng: 100 }), null, '日本の範囲外の経度');
  assert.equal(validateWeatherLocation({ name: '千代田区', lat: '35.8', lng: 139.8 }), null, '文字列の座標');
  assert.equal(validateWeatherLocation({ code: 'abc', name: '千代田区', lat: 35.8, lng: 139.8 }), null, '不正なコード');
});

/* ---------- 同梱市区町村リスト ---------- */

test('市区町村リスト: 1800件以上・コード一意・座標は日本の範囲・47都道府県を網羅', () => {
  assert.ok(CITIES.length >= 1800, `件数が不足しています (${CITIES.length})`);
  const codes = new Set(CITIES.map((c) => c.code));
  assert.equal(codes.size, CITIES.length, '市区町村コードが重複しています');
  const prefs = new Set(CITIES.map((c) => c.pref));
  assert.equal(prefs.size, 47, '都道府県が47に揃っていません');
  for (const c of CITIES) {
    assert.match(c.code, /^\d{5}$/);
    assert.ok(c.lat >= 20 && c.lat <= 46.5, `緯度が範囲外: ${c.name} ${c.lat}`);
    assert.ok(c.lng >= 122 && c.lng <= 154, `経度が範囲外: ${c.name} ${c.lng}`);
    assert.ok(c.name.length > 0 && c.pref.length > 0);
  }
  const sorted = [...CITIES].sort((a, b) => (a.code < b.code ? -1 : 1));
  assert.deepEqual(CITIES.map((c) => c.code), sorted.map((c) => c.code), 'コード順に並んでいません');
});

test('市区町村リスト: 千代田区がサーバーの既定値と一致する', () => {
  const chiyoda = CITIES.find((c) => c.code === '13101');
  assert.ok(chiyoda, '千代田区（13101）がリストにありません');
  assert.equal(chiyoda.pref, '東京都');
  assert.equal(chiyoda.name, '千代田区');
  assert.equal(chiyoda.lat, DEFAULT_WEATHER_LOCATION.lat);
  assert.equal(chiyoda.lng, DEFAULT_WEATHER_LOCATION.lng);
  assert.equal(DEFAULT_WEATHER_LOCATION.name, '東京都千代田区');
});

/* ---------- サーバー統合（取得先はローカルスタブ） ---------- */

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

async function startStub() {
  const stub = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(SAMPLE));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${stub.address().port}/forecast`,
    stop: () => new Promise((resolve) => stub.close(resolve)),
  };
}

async function startAppServer(dbPath, weatherUrl) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn('node', ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NEWS_DB_PATH: dbPath,
      ICHIGYO_WEATHER_URL: weatherUrl,
    },
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
    },
  };
}

/** 天気が載るまで /api/weather を見に行く（起動時の取得は非同期のため）。 */
async function waitWeather(base, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${base}/api/weather`);
    assert.equal(res.ok, true);
    const data = await res.json();
    if (data.weather) return data;
    if (Date.now() > deadline) return data;
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('サーバー: /api/weather に既定の場所（千代田区）と天気が載る', async () => {
  const stub = await startStub();
  const dir = mkdtempSync(join(tmpdir(), 'ichigyo-weather-'));
  const app = await startAppServer(join(dir, 'news.db'), stub.url);
  try {
    const data = await waitWeather(app.base);
    assert.ok(data.weather, '天気が載りませんでした');
    assert.equal(data.location.code, '13101');
    assert.equal(data.location.name, '東京都千代田区');
    assert.equal(data.weather.temperature, 16.9);
    assert.equal(data.weather.label, '晴れ');
    assert.equal(data.weather.max, 19.1);
    assert.equal(data.weather.min, 9.6);
    assert.equal(data.weather.precipitationProbability, 10);
    assert.ok(typeof data.fetchedAt === 'string' && data.fetchedAt.length > 0);
  } finally {
    await app.stop();
    await stub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('サーバー: 場所の変更が反映され、再起動後も復元される。不正な場所は 400', async () => {
  const stub = await startStub();
  const dir = mkdtempSync(join(tmpdir(), 'ichigyo-weather-'));
  const dbPath = join(dir, 'news.db');
  const sapporo = CITIES.find((c) => c.code === '01101');
  const payload = {
    code: sapporo.code,
    name: `${sapporo.pref}${sapporo.name}`,
    lat: sapporo.lat,
    lng: sapporo.lng,
  };
  let app = await startAppServer(dbPath, stub.url);
  try {
    await waitWeather(app.base);
    const bad = await fetch(`${app.base}/api/weather-location`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'どこか', lat: 0, lng: 0 }),
    });
    assert.equal(bad.status, 400);
    const res = await fetch(`${app.base}/api/weather-location`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.ok, true);
    const changed = await res.json();
    assert.equal(changed.location.code, '01101');
    assert.equal(changed.location.name, '北海道札幌市中央区');
    const data = await waitWeather(app.base);
    assert.equal(data.location.code, '01101');
    assert.ok(data.weather, '変更後の天気が載りませんでした');
  } finally {
    await app.stop();
  }
  // 再起動しても場所が復元される（DB の app_settings に保存されている）
  app = await startAppServer(dbPath, stub.url);
  try {
    const data = await waitWeather(app.base);
    assert.equal(data.location.code, '01101');
    assert.equal(data.location.name, '北海道札幌市中央区');
  } finally {
    await app.stop();
    await stub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('サーバー: 天気取得はポーリングとは独立で、間隔は30分', () => {
  const server = read('server.mjs');
  assert.ok(server.includes('WEATHER_INTERVAL_MS = 30 * 60 * 1000'), '30分の間隔がありません');
  assert.ok(server.includes("p === '/api/weather'"), '/api/weather がありません');
  assert.ok(server.includes("p === '/api/weather-location'"), '/api/weather-location がありません');
  const pollBody = server.slice(server.indexOf('function schedulePoll()'), server.indexOf('function setPolling'));
  assert.ok(!pollBody.includes('fetchWeather'), 'ポーリングのタイマーで天気を取得しています');
  const weatherBody = server.slice(server.indexOf('function scheduleWeather()'), server.indexOf('function setWeatherLocation'));
  assert.ok(!weatherBody.includes('startRefresh'), '天気のタイマーでニュース収集をしています');
});

/* ---------- フロント ---------- */

test('weatherFromRaw: 正常な状態を変換し、天気なし・不正な値は天気なしにする', () => {
  const full = weatherFromRaw({
    location: { code: '13101', name: '東京都千代田区', lat: 35.6923, lng: 139.7607 },
    weather: { temperature: 16.9, weatherCode: 0, label: '晴れ', max: 19.1, min: 9.6, precipitationProbability: 10 },
    fetchedAt: '2026-11-19T01:45:00.000Z',
  });
  assert.deepEqual(full, {
    location: { code: '13101', name: '東京都千代田区', lat: 35.6923, lng: 139.7607 },
    weather: { temperature: 16.9, weatherCode: 0, label: '晴れ', max: 19.1, min: 9.6, precipitationProbability: 10 },
    fetchedAt: '2026-11-19T01:45:00.000Z',
  });
  const noWeather = weatherFromRaw({
    location: { code: '13101', name: '東京都千代田区', lat: 35.6923, lng: 139.7607 },
    weather: null,
    fetchedAt: null,
  });
  assert.equal(noWeather.weather, null);
  assert.equal(noWeather.location.name, '東京都千代田区');
  const brokenWeather = weatherFromRaw({
    location: { code: '13101', name: '東京都千代田区', lat: 35.6923, lng: 139.7607 },
    weather: { label: '晴れ' },
    fetchedAt: null,
  });
  assert.equal(brokenWeather.weather, null, '気温が無い天気は出さない');
  assert.equal(weatherFromRaw(null), null);
  assert.equal(weatherFromRaw({ weather: null }), null, '場所が無ければ null');
});

test('formatNow: 日付・曜日・時刻を含む', () => {
  const text = formatNow(new Date(2026, 10, 19, 10, 55));
  assert.ok(text.includes('11'), text);
  assert.ok(text.includes('19'), text);
  assert.ok(text.includes('木'), text);
  assert.ok(text.includes('10:55'), text);
});

test('フロント: スポットライトに時計と天気と CC BY 4.0 の出典リンクがある', () => {
  const spot = read('frontend/src/Spotlight.tsx');
  assert.ok(spot.includes('spotlight-clock'), '時計の表示がありません');
  assert.ok(spot.includes('formatNow(now)'), '現在時刻を描画していません');
  assert.ok(spot.includes('spotlight-weather'), '天気の表示がありません');
  assert.ok(spot.includes('https://open-meteo.com/'), '出典リンクがありません');
  assert.ok(spot.includes('CC BY 4.0'), 'CC BY 4.0 の表記がありません');
  assert.ok(spot.includes('weather ?'), '天気が無い時に出さない条件分岐がありません');
  const app = read('frontend/src/App.tsx');
  assert.ok(app.includes('weather={weatherStatus?.weather ?? null}'), 'App から天気を渡していません');
  assert.ok(app.includes('fetchWeatherStatus()'), '天気の状態を取得していません');
});

test('フロント: 設定メニューに天気の場所（同梱リストの検索）がある', () => {
  const menu = read('frontend/src/SettingsMenu.tsx');
  assert.ok(menu.includes('天気の場所'), '天気の場所の項目がありません');
  assert.ok(menu.includes('weather-city-list'), '市区町村リストの datalist がありません');
  assert.ok(menu.includes("from './cities'"), '同梱リストを使っていません');
  assert.ok(menu.includes('onSelectWeatherCity'), '場所の変更を親へ伝えていません');
  assert.ok(!menu.includes('geocoding-api.open-meteo'), '地名を外部のジオコーディングへ送っています');
});
