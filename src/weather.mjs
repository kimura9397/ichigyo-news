// 天気取得: Open-Meteo（キー不要）から現在の天気と今日の予報を取得する
// （Issue #28、2026-11-19）。
// - 呼び出しは server.mjs 側でアプリ起動中のみ・30分間隔（ポーリングとは独立）
// - 取得に失敗したら null を返す（スポットライトでは天気だけ出さない）
// - 外部へ送るのは選んだ市区町村の緯度経度だけ。地名は送らない
// - 表示には CC BY 4.0 の出典リンク（open-meteo.com）が必須（利用条件）
import { readResponseText } from './rss.mjs';

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
/** 天気データの出典表示先（スポットライトの出典リンクにも使う） */
export const WEATHER_ATTRIBUTION_URL = 'https://open-meteo.com/';

const FETCH_TIMEOUT_MS = 8000;
/** 天気応答（JSON）の読み取り上限（バイト）。現在値と日別1件だけなので小さくてよい。 */
const MAX_WEATHER_BYTES = 256 * 1024;

/** 既定の場所は東京都千代田区。座標は同梱市区町村リストの代表点と一致させる。 */
export const DEFAULT_WEATHER_LOCATION = { code: '13101', name: '東京都千代田区', lat: 35.6923, lng: 139.7607 };

/**
 * Open-Meteo の forecast URL を組み立てる。現在値（気温・天気コード）と
 * 今日の日別（最高／最低気温・降水確率の最大）だけを取り、タイムゾーンは
 * Asia/Tokyo 固定（「今日」を日本の暦日に合わせるため）。
 */
export function buildWeatherUrl(lat, lng, base = OPEN_METEO_URL) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    current: 'temperature_2m,weather_code',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'Asia/Tokyo',
    forecast_days: '1',
  });
  return `${base}?${params}`;
}

/** WMO 天気コード→日本語の天気名。Open-Meteo が返すコードの全範囲を覆う。 */
const WEATHER_CODE_LABELS = new Map([
  [0, '晴れ'],
  [1, '晴れ'],
  [2, '晴れ時々曇り'],
  [3, '曇り'],
  [45, '霧'],
  [48, '霧'],
  [51, '霧雨'],
  [53, '霧雨'],
  [55, '霧雨'],
  [56, '霧雨'],
  [57, '霧雨'],
  [61, '雨'],
  [63, '雨'],
  [65, '雨'],
  [66, '雨'],
  [67, '雨'],
  [71, '雪'],
  [73, '雪'],
  [75, '雪'],
  [77, '雪'],
  [80, 'にわか雨'],
  [81, 'にわか雨'],
  [82, 'にわか雨'],
  [85, '雪'],
  [86, '雪'],
  [95, '雷雨'],
  [96, '雷雨'],
  [99, '雷雨'],
]);

export function weatherCodeLabel(code) {
  return WEATHER_CODE_LABELS.get(code) ?? '';
}

function finiteOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Open-Meteo の応答 JSON を表示用に正規化する。必須の現在気温・天気コードが
 * 無ければ null（天気として出せる形でない）。日別の欠けは null のまま残す。
 */
export function parseWeatherResponse(data) {
  const temperature = finiteOrNull(data?.current?.temperature_2m);
  const code = data?.current?.weather_code;
  if (temperature === null || typeof code !== 'number' || !WEATHER_CODE_LABELS.has(code)) {
    return null;
  }
  const daily = data?.daily ?? {};
  const first = (arr) => (Array.isArray(arr) ? finiteOrNull(arr[0]) : null);
  return {
    temperature,
    weatherCode: code,
    label: weatherCodeLabel(code),
    max: first(daily.temperature_2m_max),
    min: first(daily.temperature_2m_min),
    precipitationProbability: first(daily.precipitation_probability_max),
    time: typeof data?.current?.time === 'string' ? data.current.time : null,
  };
}

/**
 * Open-Meteo から天気を1回取得する。新しいデータが取れた場合だけ正規化した
 * 天気を返し、失敗（例外・HTTPエラー・想定外の応答）はすべて null。
 * url はテスト用の差し替え口（通常は buildWeatherUrl で組み立てる）。
 * fetchImpl もテスト用の差し替え口（通常はグローバルの fetch）。
 */
export async function fetchWeather({ lat, lng, url, fetchImpl = fetch } = {}) {
  try {
    const target = url || buildWeatherUrl(lat, lng);
    const res = await fetchImpl(target, {
      headers: { 'user-agent': 'ichigyo-news weather (personal use)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res || !res.ok) return null;
    const data = JSON.parse(await readResponseText(res, MAX_WEATHER_BYTES));
    return parseWeatherResponse(data);
  } catch {
    return null;
  }
}

/**
 * 場所の入力値を検証し、保存できる形に整える。不正なら null。
 * 名前は同梱リストの表示名（都道府県＋市区町村）をそのまま受け取る前提だが、
 * ここでは形式だけを見る（リストとの照合は画面側の責務）。
 * 座標は日本の範囲（離島を含む概ねの範囲）に限る。
 */
export function validateWeatherLocation(input) {
  if (!input || typeof input !== 'object') return null;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const lat = input.lat;
  const lng = input.lng;
  if (!name || name.length > 50) return null;
  if (code && !/^\d{5}$/.test(code)) return null;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < 20 || lat > 46.5) return null;
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < 122 || lng > 154) return null;
  return { code, name, lat, lng };
}
