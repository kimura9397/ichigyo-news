// バックエンドAPI（server.mjs）と画面モデル（types.ts の StoryRow）の変換層。
// 旧モック（data/stories.ts）の置き換え。
import type { FeedTab, OutletCoverage, StoryRow } from './types'

/* ---------- バックエンドの生レスポンス型 ---------- */

interface RawStoryRow {
  version_id: number
  version_no: number
  version_title: string
  version_created_at: string
  cluster_id: number
  cluster_title: string
  category: string
  bookmarked?: number
  /** 既読（read_events に記録がある）なら 1 */
  read_flag?: number
  first_seen_at: string
  last_seen_at: string
  importance_score: number
  article_count: number
  source_count: number
  latest_published: string | null
  sources: string | null
  lead: string | null
  /** 社説が確認できた媒体名（カンマ区切り、紙の並び順）。無ければ null */
  editorial_papers?: string | null
}

interface RawArticle {
  source: string
  title: string
  url: string
  summary: string
  published_at: string | null
}

interface RawVersion {
  id: number
  cluster_id: number
  version_no: number
  title: string
  created_at: string
  articles: RawArticle[]
}

interface RawCluster {
  id: number
  title: string
  category: string
  first_seen_at: string
  last_seen_at: string
  importance_score: number
  bookmarked?: number
}

interface RawEditorial {
  paper: string
  found: number | boolean
  title: string
  summary: string
  url: string
  checked_at?: string
}

interface RawStoryDetail {
  cluster: RawCluster
  versions: RawVersion[]
  editorials: RawEditorial[]
}

export interface StoriesPage {
  rows: StoryRow[]
  total: number
  /** 背後で収集中か（stale-while-revalidate） */
  refreshing: boolean
  /** 現在のタブ条件でのカテゴリ別件数 */
  categories: { category: string; count: number }[]
  /** サーバー側ポーリングの現在状態（一覧レスポンスにも付いてくる） */
  polling: PollingState | null
}

/** 社説1件（確認できた紙のみ）。coverages へ流し込む形。 */
export interface EditorialInfo {
  outletId: string
  outletName: string
  title: string
  /** 表示用テキスト（見出し＋抜粋） */
  text: string
  url: string
}

export interface ClusterDetail {
  rows: StoryRow[]
  /** 詳細取得時点で既に社説チェック済みだったか */
  editorialsChecked: boolean
}

/* ---------- URLの安全化 ---------- */

/** href に使うURLは http/https のみ許可する。それ以外は空文字（リンクにしない）。 */
export function safeUrl(url: string | null | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : ''
  } catch {
    return ''
  }
}

/** 時刻だけを「HH:mm」形式に整える（スポットライトの時計表示用）。 */
export function formatTimeNow(date: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

/** 日付だけを「YYYY年M月D日(曜)」形式に整える（スポットライトの時計表示用）。
 *  年つきにしたのは Issue #45（年が無いと何か足りないというユーザー指摘） */
export function formatDateNow(date: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(date)
}

/** 秒だけを「:SS」形式に整える（スポットライトの時計表示用、Issue #45）。
 *  時刻（HH:mm）の右に小さく添えるため、区切りのコロンごと返す。
 *  Intl の second は環境によってゼロ埋めされないため getSeconds で組み立てる */
export function formatSecondsNow(date: Date): string {
  return `:${String(date.getSeconds()).padStart(2, '0')}`
}

/**
 * スポットライトの手動移動用：現在位置から delta だけ進めた位置を返す。
 * 端では反対側に回る（ローテーションのループと一貫させる）。件数が0以下
 * のときは 0 を返す。現在位置が範囲外でも結果は必ず [0, length) に収める。
 */
export function steppedIndex(
  current: number,
  delta: number,
  length: number,
): number {
  if (length <= 0) return 0
  return (((current + delta) % length) + length) % length
}

/** ISO日時を「M/D(曜) HH:mm」形式に整える（一覧・詳細・スポットライトで共用）。 */
export function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).format(date)
}

/* ---------- テキスト整形（ルールベース抽出の後処理） ---------- */

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
}

export function cleanText(input: string | null | undefined): string {
  if (!input) return ''
  let s = String(input).replace(/<[^>]*>/g, ' ')
  for (const [k, v] of Object.entries(ENTITIES)) s = s.split(k).join(v)
  s = s.replace(/&#(\d+);/g, (_m, n: string) =>
    String.fromCodePoint(Number(n)),
  )
  return s.replace(/\s+/g, ' ').trim()
}

/** RSS 抜粋の先頭部分を、文の切れ目を保ったまま最大 max 字程度に整形する（文の選び直しはしない）。 */
export function summarize(text: string, max = 140): string {
  const clean = cleanText(text)
  if (clean.length <= max) return clean
  const sentences = clean.match(/[^。]*。/g) ?? []
  let out = ''
  for (const s of sentences) {
    if (out.length + s.length > max) break
    out += s
  }
  if (!out) out = clean.slice(0, max)
  if (out.length > max) out = out.slice(0, max)
  return out.endsWith('。') ? out : `${out}…`
}

/* ---------- 媒体の正規化 ---------- */

const OUTLET_MAP: Record<string, { id: string; name: string }> = {
  朝日: { id: 'asahi', name: '朝日新聞' },
  朝日新聞: { id: 'asahi', name: '朝日新聞' },
  読売: { id: 'yomiuri', name: '読売新聞' },
  読売新聞: { id: 'yomiuri', name: '読売新聞' },
  毎日: { id: 'mainichi', name: '毎日新聞' },
  毎日新聞: { id: 'mainichi', name: '毎日新聞' },
  日経: { id: 'nikkei', name: '日本経済新聞' },
  日経新聞: { id: 'nikkei', name: '日本経済新聞' },
  日本経済新聞: { id: 'nikkei', name: '日本経済新聞' },
  産経: { id: 'sankei', name: '産経新聞' },
  産経新聞: { id: 'sankei', name: '産経新聞' },
  共同: { id: 'kyodo', name: '共同通信' },
  共同通信: { id: 'kyodo', name: '共同通信' },
  時事: { id: 'jiji', name: '時事通信' },
  時事通信: { id: 'jiji', name: '時事通信' },
  NHK: { id: 'nhk', name: 'NHK' },
}

export function outletOf(source: string): { id: string; name: string } {
  const key = (source ?? '').trim()
  if (!key) return { id: 'unknown', name: '媒体不明' }
  return OUTLET_MAP[key] ?? { id: key, name: key }
}

/* ---------- 変換 ---------- */

const IMPORTANT_THRESHOLD = 40 // server.mjs の重要タブ閾値と合わせる
const NEW_WINDOW_MS = 24 * 3600 * 1000

function isWithinNewWindow(iso: string): boolean {
  const t = Date.parse(iso)
  return Number.isFinite(t) && Date.now() - t < NEW_WINDOW_MS
}

function rowId(clusterId: number, versionId: number): string {
  return `c${clusterId}-v${versionId}`
}

function editorialInfo(raw: RawEditorial): EditorialInfo | null {
  if (!raw.found) return null
  const { id, name } = outletOf(raw.paper)
  const title = cleanText(raw.title)
  let body = cleanText(raw.summary)
  // RSS抜粋は「見出し + 媒体名」だけのことが多いので、見出しと媒体名の重複を取り除く
  if (title && body.startsWith(title)) body = body.slice(title.length).trim()
  const names = [
    '朝日新聞',
    '読売新聞',
    '毎日新聞',
    '日本経済新聞',
    '産経新聞',
    '産経ニュース',
    '共同通信',
    '時事通信',
    'NHK',
    cleanText(raw.paper),
  ]
  for (const n of names) {
    if (!n) continue
    if (body === n) {
      body = ''
      break
    }
    if (body.endsWith(` ${n}`)) {
      body = body.slice(0, -(n.length + 1)).trim()
      break
    }
  }
  const text = body && body !== title ? `${title}\n${body}` : title
  if (!text) return null
  return { outletId: id, outletName: name, title, text, url: safeUrl(raw.url) }
}

/** その版に記事はないが社説だけ確認できた紙のための coverage。 */
function editorialOnlyCoverage(info: EditorialInfo): OutletCoverage {
  return {
    outletId: info.outletId,
    outletName: info.outletName,
    headline: info.title,
    publishedAt: '',
    summary: '',
    url: '',
    editorial: info.text,
    editorialTitle: info.title,
    editorialUrl: info.url,
  }
}

function buildCoverages(
  articles: RawArticle[],
  editorials: EditorialInfo[],
): OutletCoverage[] {
  const order: string[] = []
  const grouped = new Map<string, { base: OutletCoverage; summaries: string[] }>()
  const counts = new Map<string, number>()
  for (const a of articles) {
    const o = outletOf(a.source)
    counts.set(o.id, (counts.get(o.id) ?? 0) + 1)
  }
  for (const a of articles) {
    const o = outletOf(a.source)
    const full = cleanText(a.summary)
    if (!grouped.has(o.id)) {
      order.push(o.id)
      grouped.set(o.id, {
        base: {
          outletId: o.id,
          outletName: o.name,
          headline: cleanText(a.title),
          publishedAt: a.published_at ?? '',
          summary: summarize(a.summary),
          url: safeUrl(a.url),
        },
        summaries: [],
      })
    }
    const g = grouped.get(o.id)!
    // 同一媒体が同じ版に複数記事を持つ場合は見出し付きで連結する
    g.summaries.push(
      (counts.get(o.id) ?? 0) > 1 ? `${cleanText(a.title)}\n${full}` : full,
    )
  }
  const byOutlet = new Map(editorials.map((e) => [e.outletId, e]))
  const coverages = order.map((id) => {
    const g = grouped.get(id)!
    const coverage: OutletCoverage = { ...g.base }
    // 複数記事がある媒体は、RSS 抜粋にも全文（連結した要約）を使う
    if ((counts.get(id) ?? 0) > 1) {
      const joined = g.summaries.filter(Boolean).join('\n\n')
      if (joined) coverage.summary = joined
    }
    const ed = byOutlet.get(id)
    if (ed) {
      coverage.editorial = ed.text
      coverage.editorialTitle = ed.title
      coverage.editorialUrl = ed.url
    }
    return coverage
  })
  // 記事は無いが社説だけ確認できた紙も、社説タブから辿れるよう coverage を足す
  for (const ed of editorials) {
    if (!grouped.has(ed.outletId)) coverages.push(editorialOnlyCoverage(ed))
  }
  return coverages
}

/** 社説（後からPOSTで取得した分）を既存の行へ流し込む。 */
export function applyEditorials(
  rows: StoryRow[],
  editorials: EditorialInfo[],
): StoryRow[] {
  if (editorials.length === 0) return rows
  const byOutlet = new Map(editorials.map((e) => [e.outletId, e]))
  return rows.map((row) => {
    const coverages = row.coverages.map((c) => {
      const ed = byOutlet.get(c.outletId)
      return ed
        ? { ...c, editorial: ed.text, editorialTitle: ed.title, editorialUrl: ed.url }
        : c
    })
    for (const ed of editorials) {
      if (!coverages.some((c) => c.outletId === ed.outletId)) {
        coverages.push(editorialOnlyCoverage(ed))
      }
    }
    return { ...row, coverages }
  })
}

/** 一覧APIの生行→StoryRow 変換（純粋関数。テストからも使うため公開する）。 */
export function rowFromListItem(item: RawStoryRow): StoryRow {
  const seen = new Set<string>()
  const coverages: OutletCoverage[] = []
  for (const src of (item.sources ?? '').split(',')) {
    const o = outletOf(src)
    if (seen.has(o.id)) continue
    seen.add(o.id)
    coverages.push({
      outletId: o.id,
      outletName: o.name,
      headline: '',
      publishedAt: item.latest_published ?? item.version_created_at,
      summary: '',
    })
  }
  return {
    id: rowId(item.cluster_id, item.version_id),
    eventId: `c${item.cluster_id}`,
    clusterId: item.cluster_id,
    eventTitle: item.cluster_title,
    version: item.version_no,
    versionCreatedAt: item.version_created_at,
    title: item.version_title,
    lead: cleanText(item.lead),
    publishedAt: item.latest_published ?? item.version_created_at,
    category: item.category ?? '',
    isImportant: item.importance_score >= IMPORTANT_THRESHOLD,
    isNew: isWithinNewWindow(item.version_created_at),
    bookmarked: !!item.bookmarked,
    read: !!item.read_flag,
    editorialPapers: item.editorial_papers
      ? item.editorial_papers.split(',').filter(Boolean)
      : undefined,
    coverages,
  }
}

function detailFromRaw(data: RawStoryDetail): ClusterDetail {
  const editorials = (data.editorials ?? [])
    .map(editorialInfo)
    .filter((e): e is EditorialInfo => e !== null)
  const rows = data.versions.map((v) =>
    rowFromDetailVersion(data.cluster, v, editorials),
  )
  return {
    rows,
    editorialsChecked: (data.editorials ?? []).length > 0,
  }
}

function rowFromDetailVersion(
  cluster: RawCluster,
  version: RawVersion,
  editorials: EditorialInfo[],
): StoryRow {
  const coverages = buildCoverages(version.articles, editorials)
  const published = version.articles
    .map((a) => a.published_at)
    .filter((p): p is string => Boolean(p))
    .sort()
  const firstSummary = version.articles.find((a) => cleanText(a.summary))
  return {
    id: rowId(cluster.id, version.id),
    eventId: `c${cluster.id}`,
    clusterId: cluster.id,
    eventTitle: cluster.title,
    version: version.version_no,
    versionCreatedAt: version.created_at,
    title: version.title,
    lead: firstSummary ? summarize(firstSummary.summary, 120) : '',
    publishedAt: published[published.length - 1] ?? version.created_at,
    category: cluster.category ?? '',
    isImportant: cluster.importance_score >= IMPORTANT_THRESHOLD,
    isNew: isWithinNewWindow(version.created_at),
    bookmarked: !!cluster.bookmarked,
    coverages,
    detailLoaded: true,
  }
}

/** 旧 versionsOfEvent の代替: 取得済みの全行から同じ出来事の版を新しい順に並べる（最新が左）。 */
export function versionsOfEvent(rows: StoryRow[], eventId: string): StoryRow[] {
  return rows
    .filter((row) => row.eventId === eventId)
    .sort((a, b) => b.version - a.version)
}

/* ---------- API呼び出し ---------- */

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${url} へのリクエストが失敗しました (${res.status})`)
  return (await res.json()) as T
}

/** タブ＋カテゴリ別の一覧を1ページ分取得する。UIの 'fresh' は API の 'new' に対応。
 *  mutedCategories は重要タブでのみサーバーへ渡す（他タブではサーバー側でも無視される）。
 *  watchKeywords は tab=watch のときだけ渡す（サーバー側で OR の部分一致になる）。 */
export async function fetchTabRows(
  tab: FeedTab,
  category: string,
  offset = 0,
  limit = 100,
  mutedCategories: string[] = [],
  watchKeywords: string[] = [],
): Promise<StoriesPage> {
  // UIの 'search' はサーバー側では tab=watch（キーワード部分一致）として扱う
  const apiTab = tab === 'fresh' ? 'new' : tab === 'search' ? 'watch' : tab
  const params = new URLSearchParams({
    tab: apiTab,
    limit: String(limit),
    offset: String(offset),
  })
  if (category && category !== 'すべて') params.set('category', category)
  if (apiTab === 'important' && mutedCategories.length > 0) {
    params.set('mute', mutedCategories.join(','))
  }
  if (apiTab === 'watch' && watchKeywords.length > 0) {
    params.set('keywords', watchKeywords.join(','))
  }
  const data = await fetchJson<{
    stories: RawStoryRow[]
    total: number
    refreshing: boolean
    categories: { category: string; count: number }[]
    polling?: RawPolling
  }>(`/api/stories?${params}`)
  return {
    rows: data.stories.map(rowFromListItem),
    total: data.total,
    refreshing: data.refreshing,
    categories: data.categories ?? [],
    polling: data.polling ? pollingFromRaw(data.polling) : null,
  }
}

/** クラスタの詳細（全バージョン＋各紙＋社説キャッシュ）を取得する。 */
export async function fetchClusterDetail(
  clusterId: number,
): Promise<ClusterDetail> {
  const data = await fetchJson<RawStoryDetail>(`/api/story/${clusterId}`)
  return detailFromRaw(data)
}

/** 社説を検索させ、確認できた紙の分だけを返す。 */
export async function fetchEditorials(
  clusterId: number,
): Promise<EditorialInfo[]> {
  const data = await fetchJson<{ editorials: RawEditorial[] }>(
    `/api/editorials/${clusterId}`,
    { method: 'POST' },
  )
  return (data.editorials ?? [])
    .map(editorialInfo)
    .filter((e): e is EditorialInfo => e !== null)
}

/** ニュースの再取得を依頼する。サーバー側で既に収集中の場合は新しい収集は
 *  開始されず、alreadyRunning: true が返る（呼び出し側は背後更新の完了を待つ）。 */
export async function refreshFeed(): Promise<{ alreadyRunning: boolean }> {
  const data = await fetchJson<{ alreadyRunning?: boolean }>('/api/refresh', {
    method: 'POST',
  })
  return { alreadyRunning: data.alreadyRunning === true }
}

/* ---------- ポーリング（サーバー側スケジューリング、2026-11-17 移行） ---------- */

/** サーバー側ポーリングの状態。スケジューリングの正はサーバーで、タブは表示と完了検知だけを行う。 */
export interface PollingState {
  enabled: boolean
  /** 間隔（分） */
  minutes: number
  /** 次回実行予定（epoch ミリ秒）。無効時は null */
  nextAt: number | null
}

interface RawPolling {
  enabled?: boolean
  minutes?: number
  nextAt?: number | null
}

function pollingFromRaw(raw: RawPolling | undefined): PollingState {
  return {
    enabled: raw?.enabled === true,
    minutes: typeof raw?.minutes === 'number' ? raw.minutes : 5,
    nextAt: typeof raw?.nextAt === 'number' ? raw.nextAt : null,
  }
}

/* ---------- 更新通知（起動時にサーバーが1回だけ確認、Issue #26） ---------- */

/** 新しい版がある時だけサーバーから渡される更新情報。なければ null。 */
export interface UpdateInfo {
  /** 新しい版のバージョン（'v' なし、例 '0.5.0'） */
  version: string
  /** リリースページのURL */
  url: string
  /** リリースノート本文（GitHub Releases の body、そのまま） */
  notes: string
  /** リリースの公開日時（ISO）。なければ null */
  publishedAt: string | null
}

interface RawUpdate {
  version?: string
  url?: string
  notes?: string
  publishedAt?: string | null
}

/** 更新情報の生レスポンス→画面モデル変換（純粋関数。テストからも使うため公開する）。
 *  版が無い・URLが不正なら null（何も出さない）。 */
export function updateFromRaw(raw: RawUpdate | null | undefined): UpdateInfo | null {
  if (!raw || typeof raw.version !== 'string' || !raw.version) return null
  const url = safeUrl(raw.url)
  if (!url) return null
  return {
    version: raw.version,
    url,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    publishedAt: typeof raw.publishedAt === 'string' ? raw.publishedAt : null,
  }
}

export interface ServerStatus {
  dbBytes: number
  refreshing: boolean
  /** 最後に完了した収集の fetch_runs.id（収集完了の検知に使う）。なければ null */
  lastRunId: number | null
  lastRunFinishedAt: string | null
  polling: PollingState
  /** 新しい版がある時だけ非 null（更新通知、Issue #26） */
  update: UpdateInfo | null
  /** 現行バージョン（サーバーが package.json から読んだ値、Issue #47）。取得できなければ null */
  version: string | null
}

/** サーバーのステータス（DB容量・収集中か・最終収集・ポーリング状態）を取得する。 */
export async function fetchServerStatus(): Promise<ServerStatus> {
  const data = await fetchJson<{
    db_bytes?: number
    refreshing?: boolean
    lastRun?: { id?: number; finished_at?: string } | null
    polling?: RawPolling
    update?: RawUpdate | null
    version?: string
  }>('/api/status')
  return {
    dbBytes: data.db_bytes ?? 0,
    refreshing: data.refreshing === true,
    lastRunId: typeof data.lastRun?.id === 'number' ? data.lastRun.id : null,
    lastRunFinishedAt: data.lastRun?.finished_at ?? null,
    polling: pollingFromRaw(data.polling),
    update: updateFromRaw(data.update),
    version: typeof data.version === 'string' && data.version ? data.version : null,
  }
}

/** 「更新を確認」の結果（Issue #47）。 */
export interface UpdateCheckResult {
  /** サーバーが答えた現行バージョン。取得できなければ null */
  currentVersion: string | null
  /** 新しい版がある時だけ非 null（サーバー保持の更新情報と一致する） */
  update: UpdateInfo | null
  /** 取得に失敗して判定できなかった場合は true */
  failed: boolean
}

/** 設定メニューの「更新を確認」: サーバーに最新版チェックの再実行を依頼する。 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const data = await fetchJson<{
    currentVersion?: string
    update?: RawUpdate | null
    failed?: boolean
  }>('/api/update-check', { method: 'POST' })
  return {
    currentVersion:
      typeof data.currentVersion === 'string' && data.currentVersion
        ? data.currentVersion
        : null,
    update: updateFromRaw(data.update),
    failed: data.failed === true,
  }
}

/** ポーリングの ON/OFF と間隔をサーバーへ設定し、設定後の状態を返す。 */
export async function setPollingRemote(
  enabled: boolean,
  minutes: number,
): Promise<PollingState> {
  const data = await fetchJson<{ polling?: RawPolling }>('/api/polling', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled, minutes }),
  })
  return pollingFromRaw(data.polling)
}

/* ---------- 天気（サーバー側で30分ごとに取得、Issue #28） ---------- */

/** スポットライトに出す天気。サーバーが取得できた時だけ非 null。 */
export interface WeatherInfo {
  /** 現在の気温（℃） */
  temperature: number
  /** 天気コード（WMO） */
  weatherCode: number
  /** 天気名（晴れ・雨など、サーバー側で変換済み） */
  label: string
  /** 今日の最高気温（℃）。無ければ null */
  max: number | null
  /** 今日の最低気温（℃）。無ければ null */
  min: number | null
  /** 今日の降水確率の最大（%）。無ければ null */
  precipitationProbability: number | null
}

/** 天気の場所（同梱市区町村リストから選んだ1件）。 */
export interface WeatherLocation {
  code: string
  name: string
  lat: number
  lng: number
}

export interface WeatherStatus {
  location: WeatherLocation
  weather: WeatherInfo | null
  fetchedAt: string | null
}

interface RawWeather {
  temperature?: number
  weatherCode?: number
  label?: string
  max?: number | null
  min?: number | null
  precipitationProbability?: number | null
}

interface RawWeatherStatus {
  location?: { code?: string; name?: string; lat?: number; lng?: number }
  weather?: RawWeather | null
  fetchedAt?: string | null
}

function numberOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 天気の生レスポンス→画面モデル変換（純粋関数。テストからも使うため公開する）。
 *  現在気温か天気名が無ければ null（天気は出さない）。 */
export function weatherFromRaw(raw: RawWeatherStatus | null | undefined): WeatherStatus | null {
  if (!raw || !raw.location) return null
  const loc = raw.location
  if (
    typeof loc.name !== 'string' || !loc.name ||
    typeof loc.lat !== 'number' || typeof loc.lng !== 'number'
  ) return null
  const w = raw.weather
  const weather: WeatherInfo | null =
    w && typeof w.temperature === 'number' && Number.isFinite(w.temperature) &&
    typeof w.label === 'string' && w.label
      ? {
          temperature: w.temperature,
          weatherCode: typeof w.weatherCode === 'number' ? w.weatherCode : -1,
          label: w.label,
          max: numberOrNull(w.max),
          min: numberOrNull(w.min),
          precipitationProbability: numberOrNull(w.precipitationProbability),
        }
      : null
  return {
    location: {
      code: typeof loc.code === 'string' ? loc.code : '',
      name: loc.name,
      lat: loc.lat,
      lng: loc.lng,
    },
    weather,
    fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : null,
  }
}

/** 天気の現在状態（場所・天気・取得時刻）をサーバーから取得する。 */
export async function fetchWeatherStatus(): Promise<WeatherStatus | null> {
  const data = await fetchJson<RawWeatherStatus>('/api/weather')
  return weatherFromRaw(data)
}

/** 天気の場所をサーバーへ設定し、設定後の状態を返す。 */
export async function setWeatherLocationRemote(
  location: WeatherLocation,
): Promise<WeatherStatus | null> {
  const data = await fetchJson<RawWeatherStatus>('/api/weather-location', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(location),
  })
  return weatherFromRaw(data)
}

/* ---------- ブックマーク・閲覧ログ・DB保守 ---------- */

/** ブックマークを追加する（ブックマークしたニュースは保持期間の削除から免除される）。 */
export async function addBookmark(clusterId: number): Promise<void> {
  await fetchJson(`/api/bookmarks/${clusterId}`, { method: 'POST' })
}

/** ブックマークを解除する。 */
export async function removeBookmark(clusterId: number): Promise<void> {
  await fetchJson(`/api/bookmarks/${clusterId}`, { method: 'DELETE' })
}

/* ---------- キーワードウォッチ（サーバー側保存） ---------- */

/** 登録キーワードをサーバーから取得する。 */
export async function fetchKeywords(): Promise<string[]> {
  const data = await fetchJson<{ keywords?: string[] }>('/api/keywords')
  return data.keywords ?? []
}

/** キーワードをサーバーに登録し、登録後の全件を返す。 */
export async function addKeywordRemote(keyword: string): Promise<string[]> {
  const data = await fetchJson<{ keywords?: string[] }>('/api/keywords', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keyword }),
  })
  return data.keywords ?? []
}

/** キーワードをサーバーから削除し、削除後の全件を返す。 */
export async function removeKeywordRemote(keyword: string): Promise<string[]> {
  const data = await fetchJson<{ keywords?: string[] }>('/api/keywords', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keyword }),
  })
  return data.keywords ?? []
}

/** 閲覧ログを1件送る（fire-and-forget: 失敗しても画面は止めない）。 */
export function postReadEvent(clusterId: number): void {
  void fetch(`/api/read/${clusterId}`, { method: 'POST' }).catch(() => {})
}

export interface DbStatus {
  dbBytes: number
}

/** DB容量を含むステータスを取得する。 */
export async function fetchDbStatus(): Promise<DbStatus> {
  const data = await fetchJson<{ db_bytes?: number }>('/api/status')
  return { dbBytes: data.db_bytes ?? 0 }
}

export interface MaintenanceResult {
  prunedClusters: number
  beforeBytes: number
  afterBytes: number
}

/** 手動整理（prune＋VACUUM）を実行し、前後のDB容量を返す。 */
export async function runMaintenance(): Promise<MaintenanceResult> {
  const data = await fetchJson<{
    pruned_clusters: number
    before_bytes: number
    after_bytes: number
  }>('/api/maintenance', { method: 'POST' })
  return {
    prunedClusters: data.pruned_clusters,
    beforeBytes: data.before_bytes,
    afterBytes: data.after_bytes,
  }
}

/* ---------- URLハッシュルーティング（Issue #24） ---------- */

/**
 * 表示状態と URL ハッシュの対応。形式は `#/<tab>` または
 * `#/<tab>/<storyId>` に、必要に応じて `?cat=<カテゴリ>&q=<検索語>&kw=<ウォッチキーワード>` を付ける。
 * storyId は行ID（`c<クラスタID>-v<版ID>`）で、詳細は /api/story/<クラスタID> から
 * 復元できる。サーバー側はハッシュを見ないため、静的配信のままで共有リンクが成立する。
 */
export interface HashRoute {
  tab: FeedTab
  storyId: string | null
  category: string | null
  query: string | null
  watchKeyword: string | null
}

const ROUTE_TABS: readonly FeedTab[] = [
  'important',
  'fresh',
  'editorials',
  'bookmarks',
  'watch',
  'search',
]

const STORY_ID_PATTERN = /^c\d+-v\d+$/

/** 行ID（`c<クラスタID>-v<版ID>`）からクラスタIDを取り出す。不正な形式は null。 */
export function clusterIdOfStoryId(storyId: string): number | null {
  const m = /^c(\d+)-v\d+$/.exec(storyId)
  return m ? Number(m[1]) : null
}

/** ハッシュ文字列をルートに解釈する。空・不正な場合は null（呼び出し側が既定表示にする）。 */
export function parseHashRoute(hash: string): HashRoute | null {
  const raw = String(hash ?? '').replace(/^#/, '')
  if (!raw.startsWith('/')) return null
  const [pathPart, queryPart = ''] = raw.slice(1).split('?', 2)
  const segments = pathPart.split('/').filter((s) => s !== '')
  if (segments.length < 1 || segments.length > 2) return null
  const tab = segments[0] as FeedTab
  if (!ROUTE_TABS.includes(tab)) return null
  const storyId =
    segments[1] !== undefined && STORY_ID_PATTERN.test(segments[1])
      ? segments[1]
      : null
  const params = new URLSearchParams(queryPart)
  const get = (k: string) => {
    const v = params.get(k)
    return v !== null && v !== '' ? v : null
  }
  return {
    tab,
    storyId,
    category: get('cat'),
    query: get('q'),
    watchKeyword: get('kw'),
  }
}

/** ルートからハッシュ文字列を組み立てる。parseHashRoute と往復できる形にする。 */
export function buildHashRoute(route: HashRoute): string {
  const path = route.storyId
    ? `/${route.tab}/${route.storyId}`
    : `/${route.tab}`
  const params = new URLSearchParams()
  if (route.category) params.set('cat', route.category)
  if (route.query) params.set('q', route.query)
  if (route.watchKeyword) params.set('kw', route.watchKeyword)
  const qs = params.toString()
  return `#${path}${qs ? `?${qs}` : ''}`
}
