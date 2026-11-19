// スポットライト表示（2026-11-16 ユーザー承認、同日改修）。
// 今開いているビュー（タブ／検索／ウォッチ／ブックマーク）の一覧の全件を
// 1件ずつ大きく（新聞の一面のイメージで）表示し、設定した表示時間（既定20秒）
// ごとに次へ進む常駐表示モード。対象が重要タブ固定だった初期版から、
// 「重要は入れ替わりが遅く、同じニュースが流れ続ける」というユーザー指摘で
// 現在のビューの一覧を流す形に変更した（2026-11-16）。当初は上位10件だけ
// だったが、「一覧で保持してるのをずっと流し続けたい」というユーザー指示で
// 一覧の全件を先頭から末尾まで流してループする形に変更した（同日）。
// 社説タブから開いた場合は、各紙の表示も社説中心（社説の見出しと本文）に寄せる。
// ポーリング・全画面とは独立に動く。表示中はマストヘッドを隠し、画面全体を使う。
// 再取得（更新）が完了したら、そのビューの最新の一覧で1件目から流し直し、
// 「更新しました」と短く知らせる（表示中の記事を維持する旧挙動から変更）。
// 表示は必ず1画面に収める（スクロールさせない）。収まらない分は各紙の
// 抜粋を行数クランプで切り落とす（2026-11-16 ユーザー指示）。
// 左上には、いまどのビューの一覧を流しているかを小さく出す（同日追加指示）。
// マストヘッドが隠れて全画面の開始・終了ができなくなるため、全画面ボタンも
// トップバーに出す（同日追加指示。挙動はマストヘッド側と共通の props 経由）。
// 停止は表示内の「スポットライトを停止」ボタンだけ（ユーザーの明示指示）:
// マウス移動・他の場所のクリック・キー操作では止めない。
// トップバーの右側には現在時刻（日付・曜日つき、外部依存なし）と天気
// （サーバーが Open-Meteo から取得した分だけ）を出す（Issue #28）。
// 時刻・天気・出典でサイズと揃えが混在して段差に見えたため、行全体の
// 垂直位置を center に統一し、時刻と気温を大きく、日付と詳細を小さく
// 従える二層の見た目に整えた（Issue #35）。
// その後、細字が「カスカスに見える」という指摘を受け、候補モックから
// 選ばれた案28（TV ニュースの隅表示の並び＋半透明チップ）に置き換えた
// （Issue #39）: ブロック全体を1つのチップにまとめ、先頭に LIVE タグを
// 置き、時刻と気温は太字にした。データ項目と並びは従来どおり。
// 天気の表示には利用条件として open-meteo.com への CC BY 4.0 出典リンクを付ける。
import { useEffect, useRef, useState } from 'react'
import {
  fetchClusterDetail,
  fetchTabRows,
  formatDateNow,
  formatTimeNow,
  formatWhen,
  safeUrl,
  type WeatherInfo,
} from './api'
import type { FeedTab, StoryRow } from './types'

/** 一覧取得のページサイズ（一覧側の loadPage と同じ100件ずつ、全ページを辿って全件を保持する） */
const PAGE_SIZE = 100
/** 流し直しの通知を出す時間 */
const NOTICE_MS = 3_500

interface SpotlightProps {
  /** 一覧の再読み込みが完了するたびに増える世代カウンタ（組み直しの契機） */
  refreshGen: number
  /** 流す対象のビュー（開始時点で開いていたタブ／ビュー） */
  sourceTab: FeedTab
  /** 流す対象のカテゴリフィルタ（開始時点のもの） */
  sourceCategory: string
  /** 重要タブのミュートカテゴリ（重要タブの取得条件に合わせる） */
  mutedCategories: string[]
  /** ウォッチ／検索ビューの照合キーワード（他ビューでは空） */
  sourceWatchKeywords: string[]
  /** 流しているビューの表示名（左上に小さく出す） */
  sourceLabel: string
  /** 1件あたりの表示時間（ミリ秒）。設定で変更でき、次の見出しから反映される */
  rotateMs: number
  /** 天気（サーバーが取得できた時だけ非 null。null の間は天気だけ出さない） */
  weather: WeatherInfo | null
  /** 天気の場所の表示名（都道府県＋市区町村） */
  weatherLocationName: string
  /** 全画面かどうか（マストヘッド側のボタンと状態を共有する） */
  isFullscreen: boolean
  /** 全画面の開始・終了（マストヘッド側のボタンと同じ処理） */
  onToggleFullscreen: () => void
  onStop: () => void
}

interface DetailEntry {
  /** 詳細の最新版の行（各紙の RSS 抜粋入り） */
  row: StoryRow
  /** そのクラスタの全版数 */
  versionCount: number
}

/** 天気コード（WMO）をアイコンの種類に対応づける（サーバー側の天気名の区分けに合わせる） */
function weatherIconKind(
  code: number,
): 'sun' | 'partly' | 'cloud' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'thunder' {
  if (code === 0 || code === 1) return 'sun'
  if (code === 2) return 'partly'
  if (code === 3) return 'cloud'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 51 && code <= 57) return 'drizzle'
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain'
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow'
  if (code >= 95) return 'thunder'
  return 'cloud'
}

const CLOUD_PATH = 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z'
const SUN_RAY_PATHS = [
  'M12 2v2',
  'M12 20v2',
  'M4.93 4.93l1.41 1.41',
  'M17.66 17.66l1.41 1.41',
  'M2 12h2',
  'M20 12h2',
  'M4.93 19.07l1.41-1.41',
  'M17.66 6.34l1.41-1.41',
]

/** 天気アイコン（inline SVG）。天気名のテキストが隣にあるため装飾のみ（aria-hidden）。 */
function WeatherIcon({ code }: { code: number }) {
  const kind = weatherIconKind(code)
  return (
    <svg
      width="27"
      height="27"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {kind === 'sun' ? (
        <>
          <circle cx="12" cy="12" r="4" />
          {SUN_RAY_PATHS.map((d) => (
            <path key={d} d={d} />
          ))}
        </>
      ) : null}
      {kind === 'partly' ? (
        <>
          <g transform="translate(0 -1.5) scale(0.55)">
            <circle cx="12" cy="12" r="4" />
            {SUN_RAY_PATHS.map((d) => (
              <path key={d} d={d} />
            ))}
          </g>
          <g transform="translate(5 7) scale(0.7)">
            <path d={CLOUD_PATH} />
          </g>
        </>
      ) : null}
      {kind === 'cloud' ? <path d={CLOUD_PATH} /> : null}
      {kind === 'fog' ? (
        <>
          <g transform="translate(0 -3) scale(0.95)">
            <path d={CLOUD_PATH} />
          </g>
          <path d="M5 19h14" />
          <path d="M7.5 21.5h9" />
        </>
      ) : null}
      {kind === 'drizzle' || kind === 'rain' || kind === 'snow' || kind === 'thunder' ? (
        <>
          <g transform="translate(1 -1) scale(0.92)">
            <path d={CLOUD_PATH} />
          </g>
          {kind === 'drizzle' ? (
            <>
              <path d="M8 20.5v1.4" />
              <path d="M12 20.5v1.4" />
              <path d="M16 20.5v1.4" />
            </>
          ) : null}
          {kind === 'rain' ? (
            <>
              <path d="M8.5 20l-1 2.2" />
              <path d="M12.5 20l-1 2.2" />
              <path d="M16.5 20l-1 2.2" />
            </>
          ) : null}
          {kind === 'snow' ? (
            <>
              <circle cx="8" cy="21" r="1.1" fill="currentColor" stroke="none" />
              <circle cx="12.5" cy="22" r="1.1" fill="currentColor" stroke="none" />
              <circle cx="17" cy="21" r="1.1" fill="currentColor" stroke="none" />
            </>
          ) : null}
          {kind === 'thunder' ? (
            <path
              d="M12.6 16.8l-2.5 3.8h2l-1.2 3 3.6-4.4h-2.1l1.2-2.4z"
              fill="currentColor"
              stroke="none"
            />
          ) : null}
        </>
      ) : null}
    </svg>
  )
}

export default function Spotlight({
  refreshGen,
  sourceTab,
  sourceCategory,
  mutedCategories,
  sourceWatchKeywords,
  sourceLabel,
  rotateMs,
  weather,
  weatherLocationName,
  isFullscreen,
  onToggleFullscreen,
  onStop,
}: SpotlightProps) {
  /** 社説タブから開いた場合は各紙の表示を社説中心にする */
  const editorialMode = sourceTab === 'editorials'
  const [items, setItems] = useState<StoryRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [slot, setSlot] = useState(0)
  const [details, setDetails] = useState<Record<number, DetailEntry>>({})
  const [progress, setProgress] = useState(0)
  /** 流し直し直後だけ出す控えめな通知（「更新しました」） */
  const [notice, setNotice] = useState<string | null>(null)
  /** 現在時刻（時計表示用。1秒ごとに進める） */
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  const itemsRef = useRef<StoryRow[]>([])
  /** 組み直しの世代。全件取得には時間がかかるため、古い組み直しの結果が
   *  新しい組み直しを上書きしないよう、開始順を数えておく */
  const rebuildSeqRef = useRef(0)
  const slotRef = useRef(0)
  const slotStartRef = useRef(0)
  const detailsRef = useRef<Record<number, DetailEntry>>({})
  const requestedRef = useRef<Set<string>>(new Set())
  const lastGenRef = useRef(refreshGen)
  // 流す対象のビュー。表示中はマストヘッドもタブも隠れていて対象は変わらないが、
  // 組み直しのたびに最新の props で取得できるよう ref に寄せておく
  const sourceRef = useRef({
    sourceTab,
    sourceCategory,
    mutedCategories,
    sourceWatchKeywords,
  })
  sourceRef.current = {
    sourceTab,
    sourceCategory,
    mutedCategories,
    sourceWatchKeywords,
  }
  // 表示時間の設定値（最新の props）と、表示中の見出しに適用中の値。
  // 設定を変えても表示中の見出しは切り替わらず、次の見出しから新しい値を使う。
  const rotateMsRef = useRef(rotateMs)
  const slotMsRef = useRef(rotateMs)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    rotateMsRef.current = rotateMs
  }, [rotateMs])

  useEffect(
    () => () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    },
    [],
  )

  /** 「更新しました」を短時間だけ出す */
  const showNotice = () => {
    setNotice('更新しました')
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(null), NOTICE_MS)
  }

  const effIndex = items.length > 0 ? slot % items.length : 0
  const current = items[effIndex] ?? null
  const currentDetail = current ? details[current.clusterId] : undefined
  // 詳細が表示中の行（版）に対応している場合だけ使う（版が進んでいたら取り直す）
  const detailRow =
    current && currentDetail && currentDetail.row.id === current.id
      ? currentDetail.row
      : null
  const displayRow = detailRow ?? current
  // 各紙の表示内容。通常は RSS 抜粋（抜粋本文があるもの、または記事見出しのみの
  // もの。社説だけの coverage は対象外）。社説タブから開いた場合は社説が
  // 確認できた紙だけを出し、カードの中身も社説に寄せる。
  const paperCoverages = (detailRow?.coverages ?? []).filter((c) =>
    editorialMode
      ? Boolean(c.editorial)
      : c.summary || (c.headline && !c.editorial),
  )

  /** ローテーション対象を現在のビューの一覧の全件で組み直し、1件目から
   *  流し直す。一覧はページ分割されているので、全ページを辿って全件を
   *  保持する（取得条件の組み立ては一覧側の loadPage と同じ）。
   *  notify が true のときは「更新しました」の通知も出す（再取得の完了時）。 */
  const rebuild = async (notify: boolean) => {
    const seq = ++rebuildSeqRef.current
    try {
      const src = sourceRef.current
      const all: StoryRow[] = []
      const seen = new Set<string>()
      let offset = 0
      let total = Number.POSITIVE_INFINITY
      while (all.length < total) {
        const page = await fetchTabRows(
          src.sourceTab,
          src.sourceCategory,
          offset,
          PAGE_SIZE,
          src.mutedCategories,
          src.sourceWatchKeywords,
        )
        total = page.total
        if (page.rows.length === 0) break
        // 取得の途中で一覧がずれて同じ行が重なって返っても、1件として数える
        for (const row of page.rows) {
          if (seen.has(row.id)) continue
          seen.add(row.id)
          all.push(row)
        }
        offset += page.rows.length
      }
      // 取得中に新しい組み直しが始まっていたら、古い結果は破棄する
      if (seq !== rebuildSeqRef.current) return
      itemsRef.current = all
      setItems(all)
      slotRef.current = 0
      setSlot(0)
      slotStartRef.current = Date.now()
      slotMsRef.current = rotateMsRef.current
      setProgress(0)
      if (notify) showNotice()
    } catch {
      /* 取得に失敗したら今のローテーションを続ける */
    } finally {
      if (seq === rebuildSeqRef.current) setLoaded(true)
    }
  }
  const rebuildRef = useRef(rebuild)
  rebuildRef.current = rebuild

  // 初回組み立て
  useEffect(() => {
    void rebuildRef.current(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 更新完了（手動更新・ポーリング・背後収集の完了）のたびに組み直し、
  // 1件目から流し直したことが分かるよう通知も出す
  useEffect(() => {
    if (refreshGen === lastGenRef.current) return
    lastGenRef.current = refreshGen
    void rebuildRef.current(true)
  }, [refreshGen])

  // 表示時間ごとのローテーションとプログレスバー。
  // 表示中の見出しの表示時間は slotMsRef に固定し、設定変更は次の見出しから反映する
  useEffect(() => {
    slotStartRef.current = Date.now()
    const timer = setInterval(() => {
      const now = Date.now()
      let elapsed = now - slotStartRef.current
      if (elapsed >= slotMsRef.current) {
        const steps = Math.floor(elapsed / slotMsRef.current)
        slotStartRef.current += steps * slotMsRef.current
        elapsed -= steps * slotMsRef.current
        const ns = slotRef.current + steps
        slotRef.current = ns
        setSlot(ns)
        slotMsRef.current = rotateMsRef.current
      }
      setProgress(Math.min(1, elapsed / slotMsRef.current))
    }, 100)
    return () => clearInterval(timer)
  }, [])

  // 表示中と次の記事の詳細（各紙の抜粋）を先読みする
  useEffect(() => {
    if (items.length === 0) return
    const ensureDetail = (row: StoryRow) => {
      const key = `${row.clusterId}:${row.id}`
      if (requestedRef.current.has(key)) return
      if (detailsRef.current[row.clusterId]?.row.id === row.id) return
      requestedRef.current.add(key)
      fetchClusterDetail(row.clusterId)
        .then((detail) => {
          if (detail.rows.length === 0) return
          const latest = detail.rows.reduce((a, b) =>
            b.version > a.version ? b : a,
          )
          const entry: DetailEntry = {
            row: latest,
            versionCount: detail.rows.length,
          }
          detailsRef.current = {
            ...detailsRef.current,
            [row.clusterId]: entry,
          }
          setDetails(detailsRef.current)
        })
        .catch(() => {
          // 失敗したら次に表示が進んだときに取り直せるよう印を外す
          requestedRef.current.delete(key)
        })
    }
    ensureDetail(items[effIndex])
    if (items.length > 1) ensureDetail(items[(effIndex + 1) % items.length])
  }, [items, effIndex])

  /** 天気の従情報（最高／最低・降水確率）。ある分だけを並べる */
  const weatherDetail = weather
    ? [
        weather.max !== null && weather.min !== null
          ? `最高 ${Math.round(weather.max)}℃ / 最低 ${Math.round(weather.min)}℃`
          : null,
        weather.precipitationProbability !== null
          ? `降水確率 ${Math.round(weather.precipitationProbability)}%`
          : null,
      ]
        .filter((part): part is string => part !== null)
        .join('　')
    : ''

  return (
    <div className="spotlight">
      <div className="spotlight-head">
        <div className="spotlight-topbar">
          <span className="spotlight-kicker">スポットライト</span>
          {sourceLabel ? (
            <span className="spotlight-source">{sourceLabel}</span>
          ) : null}
          {notice ? (
            <span className="spotlight-notice" role="status">
              {notice}
            </span>
          ) : null}
          <div className="spotlight-now">
            <span className="spotlight-live">LIVE</span>
            <span className="spotlight-clockset">
              <span className="spotlight-date">{formatDateNow(now)}</span>
              <time className="spotlight-clock">{formatTimeNow(now)}</time>
            </span>
            {weather ? (
              <span className="spotlight-weather">
                <WeatherIcon code={weather.weatherCode} />
                <span className="spotlight-weather-main">
                  <span className="spotlight-weather-temp">
                    {weather.temperature.toFixed(1)}℃
                  </span>
                  <span className="spotlight-weather-label">{weather.label}</span>
                </span>
                <span className="spotlight-weather-sub">
                  <span>
                    {weatherLocationName}
                    {weatherDetail ? `　${weatherDetail}` : ''}
                  </span>
                  <a
                    className="spotlight-weather-source"
                    href="https://open-meteo.com/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open-Meteo (CC BY 4.0)
                  </a>
                </span>
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="icon-btn spotlight-fullscreen"
            onClick={onToggleFullscreen}
            aria-pressed={isFullscreen}
            title={isFullscreen ? '全画面を終了' : '全画面にする'}
            aria-label={isFullscreen ? '全画面を終了' : '全画面にする'}
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {isFullscreen ? (
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
              ) : (
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
              )}
            </svg>
          </button>
          <button type="button" className="spotlight-stop" onClick={onStop}>
            スポットライトを停止
          </button>
        </div>
        <div
          className="spotlight-progress"
          role="progressbar"
          aria-label="次のニュースまでの時間"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <div
            className="spotlight-progress-bar"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>

      {!loaded ? (
        <p className="spotlight-note">読み込み中…</p>
      ) : !displayRow ? (
        <p className="spotlight-note">
          表示できるニュースがありません。新しいニュースが入ると、ここに表示されます。
        </p>
      ) : (
        <article className="spotlight-story">
          <p className="spotlight-meta">
            {displayRow.category ? (
              <span className="spotlight-category">{displayRow.category}</span>
            ) : null}
            <span>
              v{displayRow.version}
              {displayRow.version === 1 ? ' · 初報' : ' · 続報'}
              {detailRow && currentDetail
                ? ` · 全${currentDetail.versionCount}版`
                : ''}
            </span>
            <time dateTime={displayRow.publishedAt}>
              {formatWhen(displayRow.publishedAt)}
            </time>
          </p>
          <h2 className="spotlight-title">{displayRow.title}</h2>
          {displayRow.lead ? (
            <p className="spotlight-lead">{displayRow.lead}</p>
          ) : null}

          {detailRow ? (
            paperCoverages.length > 0 ? (
              <div
                className={`spotlight-papers ${
                  paperCoverages.length >= 6 ? 'is-many' : 'is-few'
                }`}
              >
                {paperCoverages.map((c) => {
                  // 社説モードではカードの見出し・本文・リンクを社説に寄せる。
                  // 社説テキストは先頭に社説の見出しを含む形で組み立てられて
                  // いるため、見出しとして別に出す場合は先頭行を取り除く
                  const cardTitle = editorialMode
                    ? c.editorialTitle || c.headline
                    : c.headline
                  let cardBody = editorialMode ? c.editorial : c.summary
                  if (
                    editorialMode &&
                    cardBody &&
                    c.editorialTitle &&
                    cardBody.startsWith(c.editorialTitle)
                  ) {
                    cardBody =
                      cardBody.slice(c.editorialTitle.length).replace(/^\n+/, '') ||
                      undefined
                  }
                  const cardUrl = safeUrl(
                    editorialMode ? c.editorialUrl : c.url,
                  )
                  return (
                    <section key={c.outletId} className="spotlight-paper">
                      <p className="spotlight-paper-kicker">
                        <span>{c.outletName}</span>
                        {c.publishedAt ? (
                          <time dateTime={c.publishedAt}>
                            {formatWhen(c.publishedAt)}
                          </time>
                        ) : null}
                      </p>
                      {cardTitle ? <h3>{cardTitle}</h3> : null}
                      {cardBody ? (
                        <p className="spotlight-paper-summary">{cardBody}</p>
                      ) : null}
                      {cardUrl ? (
                        <a
                          className="spotlight-paper-link"
                          href={cardUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {editorialMode ? '社説の元記事を読む' : '元記事を読む'}
                        </a>
                      ) : null}
                    </section>
                  )
                })}
              </div>
            ) : (
              <p className="spotlight-note">
                {editorialMode
                  ? '社説はまだ確認できていません。'
                  : '各紙の抜粋はまだありません。'}
              </p>
            )
          ) : (
            <p className="spotlight-note">
              {editorialMode
                ? '社説を読み込み中…'
                : '各紙の抜粋を読み込み中…'}
            </p>
          )}
        </article>
      )}
    </div>
  )
}
