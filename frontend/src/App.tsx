import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  addBookmark,
  addKeywordRemote,
  applyEditorials,
  fetchClusterDetail,
  fetchDbStatus,
  fetchEditorials,
  fetchKeywords,
  fetchServerStatus,
  fetchTabRows,
  formatWhen,
  postReadEvent,
  refreshFeed,
  removeBookmark,
  removeKeywordRemote,
  runMaintenance,
  setPollingRemote,
  versionsOfEvent,
  type PollingState,
} from './api'
import type { CoverageKind, FeedTab, StoryRow } from './types'
import Spotlight from './Spotlight'
import SettingsMenu from './SettingsMenu'
import './App.css'

const TABS: { id: FeedTab; label: string; hint: string }[] = [
  { id: 'important', label: '重要', hint: '社会的影響が大きい出来事' },
  { id: 'fresh', label: '新着', hint: '直近で入った初報と続報' },
  { id: 'editorials', label: '社説', hint: '社説が確認できたニュース' },
]

function formatBytes(bytes: number) {
  if (!bytes) return ''
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

const BASE_TITLE = '一行ニュース — 一行で、五紙を読む。'
const POLL_INTERVALS = [2, 5, 10]
// スポットライトで1件を表示する時間（秒）の選択肢（2026-11-16 ユーザー指示）
const SPOTLIGHT_SECONDS_OPTIONS = [10, 20, 30, 60]

// 一覧ペインの幅比率（PCレイアウト、2026-11-15 ユーザー決定でドラッグ調整可能に）
const PANE_RATIO_DEFAULT = 0.38
const PANE_RATIO_MIN_PX = 270
const PANE_RATIO_MAX = 0.65

// 狭幅レイアウトの境界（App.css の @media と一致させる）。
// 狭幅では一覧と詳細を横に並べた全画面ページャーになる（2026-11-15 ユーザー決定）
const NARROW_MEDIA = '(max-width: 860px)'

/** 要約・社説のテキストを段落ごとに <p> で描く（改行を行・段落の区切りとして扱う）。 */
function Paragraphs({ text }: { text: string }) {
  const paras = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (paras.length === 0) return null
  return (
    <div className="paper-body">
      {paras.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  )
}

// 表示順（データに無いものは件数0として出さない）
const CATEGORY_ORDER = [
  '社会',
  '政治',
  '経済',
  '国際',
  'スポーツ',
  '文化・エンタメ',
  '科学',
  'その他',
]
const ALL_CATEGORY = 'すべて'

type DetailState = 'loading' | 'loaded'
type EditorialState = 'unchecked' | 'loading' | 'done'
export type FontSizeSetting = 'small' | 'medium' | 'large'
/** 一覧の密度（2026-11-16 ユーザー決定、Issue #4）。コンパクトは行の構造を詰めて
 * 1画面に入る行数を増やす（モニター用途）。フォントサイズは変えない */
export type DensitySetting = 'standard' | 'compact'
/**
 * テーマプリセット（2026-11-16 ユーザー決定）。旧「テーマ（ライト/ダーク/端末）」と
 * 「アクセント色（5色）」を一本化したもので、各プリセットがパレット全体を決める。
 * 'system' は端末に合わせる（ライト→紙、ダーク→墨）。
 */
const THEME_PRESETS = [
  { id: 'kami', label: '紙', title: '紙色の背景に墨の文字、朱の差し色（これまでのライト）', color: '#f4eee3' },
  { id: 'koshi', label: '古紙', title: '茶色く沈めた、古い紙のような明るい色', color: '#efddba' },
  { id: 'shirokuro', label: '白黒', title: '純白と真っ黒の高コントラスト', color: '#ffffff' },
  { id: 'akari', label: '灯', title: '墨より一段明るい、灯りの下で読むような暗さ', color: '#453b30' },
  { id: 'sumi', label: '墨', title: '柔らかい暗茶の地に明るい文字（ダーク）', color: '#38322a' },
  {
    id: 'system',
    label: '端末に合わせる',
    title: '端末がライトなら「紙」、ダークなら「墨」',
    color: 'linear-gradient(90deg, #f4eee3 50%, #38322a 50%)',
  },
] as const
export type ThemePreset = (typeof THEME_PRESETS)[number]['id']

/**
 * 保存済みテーマの初期値。新しい保存先（ichigyo:themePreset）があればそれを使い、
 * 無ければ旧キー（ichigyo:theme）から移行する（ダーク→墨、端末→system、それ以外→紙）。
 * アクセント色の旧キー（ichigyo:accent）は廃止され、読み捨てる。
 */
function initialThemePreset(): ThemePreset {
  try {
    const v = localStorage.getItem('ichigyo:themePreset')
    if (THEME_PRESETS.some((p) => p.id === v)) return v as ThemePreset
    const old = localStorage.getItem('ichigyo:theme')
    return old === 'dark' ? 'sumi' : old === 'system' ? 'system' : 'kami'
  } catch {
    return 'kami'
  }
}

interface ListPage {
  ids: string[]
  total: number
}

const listKey = (tab: FeedTab, category: string, scope = '') =>
  scope ? `${tab}:${scope}|${category}` : `${tab}|${category}`

function App() {
  const [tab, setTab] = useState<FeedTab>('important')
  // ブックマーク件数（タブ行右端のボタンの併記用。不明な間は null）
  const [bookmarkCount, setBookmarkCount] = useState<number | null>(null)
  const [category, setCategory] = useState<string>(ALL_CATEGORY)
  // タブ×カテゴリごとに取得したページ（APIの返却順をそのまま使う）
  const [pages, setPages] = useState<Record<string, ListPage | null>>({})
  // タブごとのカテゴリ別件数（チップ表示用）
  const [catCounts, setCatCounts] = useState<
    Partial<Record<FeedTab, { category: string; count: number }[]>>
  >({})
  // 取得済みの全行（詳細で埋まった行もここに蓄積し、版の行き来に使う）
  const [rows, setRows] = useState<Record<string, StoryRow>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [outletId, setOutletId] = useState<string | null>(null)
  const [coverageKind, setCoverageKind] = useState<CoverageKind>('summary')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [detailState, setDetailState] = useState<Record<number, DetailState>>({})
  const [editorialState, setEditorialState] = useState<
    Record<number, EditorialState>
  >({})
  const [refreshing, setRefreshing] = useState(false)
  const [bgRefreshing, setBgRefreshing] = useState(false)
  const [dbBytes, setDbBytes] = useState<number | null>(null)
  const [maintaining, setMaintaining] = useState(false)
  // データ整理（保守）の確認ダイアログと、実行結果のトースト
  const [confirmingMaintenance, setConfirmingMaintenance] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const detailRef = useRef<HTMLElement | null>(null)
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const versionRailRef = useRef<HTMLOListElement | null>(null)

  // 一覧ペインの幅比率。境界ドラッグで変え、localStorage に保存して復元する
  const [paneRatio, setPaneRatio] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem('ichigyo:paneRatio'))
      return v >= 0.15 && v <= PANE_RATIO_MAX ? v : PANE_RATIO_DEFAULT
    } catch {
      return PANE_RATIO_DEFAULT
    }
  })
  const [paneDragging, setPaneDragging] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem('ichigyo:paneRatio', String(paneRatio))
    } catch {
      /* 保存できなくても動作は続ける */
    }
  }, [paneRatio])

  // ドラッグ中はカーソルとテキスト選択を画面全体で固定する
  useEffect(() => {
    if (!paneDragging) return
    const prevCursor = document.body.style.cursor
    const prevSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
    }
  }, [paneDragging])

  /** 一覧の最小幅（px）と最大比率で比率をクランプする。 */
  const clampPaneRatio = useCallback((ratio: number) => {
    const width = workspaceRef.current?.clientWidth ?? 0
    const min =
      width > 0
        ? Math.min(PANE_RATIO_MIN_PX / width, PANE_RATIO_MAX)
        : 0.15
    return Math.min(PANE_RATIO_MAX, Math.max(min, ratio))
  }, [])

  function handleDividerPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setPaneDragging(true)
  }

  function handleDividerPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!paneDragging) return
    const rect = workspaceRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    setPaneRatio(clampPaneRatio((e.clientX - rect.left) / rect.width))
  }

  function handleDividerKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 0.05 : 0.02
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setPaneRatio((r) => clampPaneRatio(r - step))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      setPaneRatio((r) => clampPaneRatio(r + step))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setPaneRatio(PANE_RATIO_DEFAULT)
    }
  }

  // 設定メニュー（ハンバーガー、2026-11-15 ユーザー決定）。全設定は localStorage に保存し、
  // テーマとフォントサイズは index.html の先行スクリプトが描画前に同じキーで適用する。
  const [fontSize, setFontSize] = useState<FontSizeSetting>(() => {
    try {
      const v = localStorage.getItem('ichigyo:fontSize')
      return v === 'small' || v === 'large' ? v : 'medium'
    } catch {
      return 'medium'
    }
  })
  const [themePreset, setThemePreset] = useState<ThemePreset>(
    initialThemePreset,
  )
  const [density, setDensity] = useState<DensitySetting>(() => {
    try {
      // 未保存時のデフォルトはコンパクト（2026-11-16 実機確認の上で決定）。
      // 保存済みの値（standard / compact）はそのまま尊重する。
      return localStorage.getItem('ichigyo:density') === 'standard'
        ? 'standard'
        : 'compact'
    } catch {
      return 'compact'
    }
  })
  const [dimRead, setDimRead] = useState<boolean>(() => {
    try {
      return localStorage.getItem('ichigyo:dimRead') !== '0'
    } catch {
      return true
    }
  })
  const [mutedCategories, setMutedCategories] = useState<string[]>(() => {
    try {
      const v: unknown = JSON.parse(
        localStorage.getItem('ichigyo:mutedCategories') || '[]',
      )
      return Array.isArray(v)
        ? v.filter(
            (c): c is string =>
              typeof c === 'string' && CATEGORY_ORDER.includes(c),
          )
        : []
    } catch {
      return []
    }
  })
  const [menuOpen, setMenuOpen] = useState(false)
  /** このセッションで詳細を開いたクラスタ（サーバーの read_flag と合わせて薄表示に使う） */
  const [readClusters, setReadClusters] = useState<ReadonlySet<number>>(
    new Set(),
  )
  const mutedRef = useRef<string[]>(mutedCategories)

  useEffect(() => {
    try {
      localStorage.setItem('ichigyo:fontSize', fontSize)
    } catch {
      /* 保存できなくても動作は続ける */
    }
    document.documentElement.dataset.fontSize = fontSize
  }, [fontSize])

  useEffect(() => {
    try {
      localStorage.setItem('ichigyo:themePreset', themePreset)
      // 旧キーは移行済みなので残っていれば片付ける
      localStorage.removeItem('ichigyo:theme')
      localStorage.removeItem('ichigyo:accent')
    } catch {
      /* 同上 */
    }
  }, [themePreset])

  // テーマの実効値（「端末に合わせる」は 紙／墨 に解決）を <html data-theme> に反映する
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const resolved =
        themePreset === 'system'
          ? mq.matches
            ? 'sumi'
            : 'kami'
          : themePreset
      document.documentElement.dataset.theme = resolved
    }
    apply()
    if (themePreset !== 'system') return
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [themePreset])

  useEffect(() => {
    try {
      localStorage.setItem('ichigyo:density', density)
    } catch {
      /* 同上 */
    }
  }, [density])

  useEffect(() => {
    try {
      localStorage.setItem('ichigyo:dimRead', dimRead ? '1' : '0')
    } catch {
      /* 同上 */
    }
  }, [dimRead])

  useEffect(() => {
    mutedRef.current = mutedCategories
    try {
      localStorage.setItem(
        'ichigyo:mutedCategories',
        JSON.stringify(mutedCategories),
      )
    } catch {
      /* 同上 */
    }
  }, [mutedCategories])

  // キーワードウォッチ（2026-11-15 ユーザー決定）。キーワードはサーバー側（DB）に保存する
  // （照合条件であると同時に、更新時の収集クエリでもあるため）。
  // 移行措置: 初回読み込み時にサーバー側が空で localStorage に旧キーワードがあれば
  // アップロードして引き継ぎ、ローカル側は消す。
  const [keywords, setKeywords] = useState<string[]>([])
  /** ウォッチビューで選択中のキーワード（null は「すべて」= 全キーワードの OR） */
  const [watchKeyword, setWatchKeyword] = useState<string | null>(null)
  const [keywordInput, setKeywordInput] = useState('')
  const keywordsRef = useRef<string[]>(keywords)
  const watchKeywordRef = useRef<string | null>(watchKeyword)

  useEffect(() => {
    keywordsRef.current = keywords
  }, [keywords])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        let serverKeywords = await fetchKeywords()
        if (serverKeywords.length === 0) {
          let local: string[] = []
          try {
            const v: unknown = JSON.parse(
              localStorage.getItem('ichigyo:keywords') || '[]',
            )
            if (Array.isArray(v)) {
              local = v.filter(
                (k): k is string => typeof k === 'string' && k.trim().length > 0,
              )
            }
          } catch {
            local = []
          }
          for (const kw of local) {
            try {
              serverKeywords = await addKeywordRemote(kw)
            } catch {
              /* 上限など個別の失敗は飛ばして残りを引き継ぐ */
            }
          }
        }
        try {
          localStorage.removeItem('ichigyo:keywords')
        } catch {
          /* 消せなくても動作は続ける */
        }
        if (!cancelled) setKeywords(serverKeywords)
      } catch {
        /* 取得できなくても画面は続ける（キーワードなしとして扱う） */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    watchKeywordRef.current = watchKeyword
  }, [watchKeyword])

  /** ウォッチのページキャッシュを捨てる（キーワード集合が変わると「すべて」の中身が変わるため）。 */
  function clearWatchPages() {
    setPages((prev) => {
      const updated = { ...prev }
      for (const k of Object.keys(updated)) {
        if (k.startsWith('watch')) delete updated[k]
      }
      return updated
    })
  }

  /** キーワードをサーバーに登録する（カンマは区切りと衝突するので空白に置換、重複は追加しない）。追加できたら true。 */
  async function addKeyword(raw: string): Promise<boolean> {
    const kw = raw.replace(/,/g, ' ').trim().replace(/\s+/g, ' ')
    if (!kw || keywordsRef.current.includes(kw)) return false
    try {
      const next = await addKeywordRemote(kw)
      setKeywords(next)
      clearWatchPages()
      return next.includes(kw)
    } catch {
      return false
    }
  }

  function removeKeyword(kw: string) {
    setKeywords((prev) => prev.filter((k) => k !== kw))
    if (watchKeywordRef.current === kw) setWatchKeyword(null)
    clearWatchPages()
    void (async () => {
      try {
        setKeywords(await removeKeywordRemote(kw))
      } catch {
        try {
          setKeywords(await fetchKeywords())
        } catch {
          /* 復旧できなくても画面は続ける */
        }
      }
    })()
  }

  function selectWatchKeyword(kw: string | null) {
    acknowledgeNew()
    setWatchKeyword(kw)
    setSelectedId(null)
    setOutletId(null)
    setCoverageKind('summary')
    goToListPane()
  }

  // キーワード検索（2026-11-15 ユーザー決定）。一致判定はウォッチと同じ tab=watch を使う
  const [searchInput, setSearchInput] = useState('')
  /** 検索を実行した語（'' は未検索） */
  const [searchQuery, setSearchQuery] = useState('')
  const searchQueryRef = useRef('')

  useEffect(() => {
    searchQueryRef.current = searchQuery
  }, [searchQuery])

  function submitSearch(e: ReactFormEvent) {
    e.preventDefault()
    const q = searchInput.replace(/,/g, ' ').trim().replace(/\s+/g, ' ')
    acknowledgeNew()
    setSearchQuery(q)
    setSelectedId(null)
    setOutletId(null)
    setCoverageKind('summary')
    goToListPane()
  }

  /** 検索中の語をウォッチのキーワードに登録し、結果をトーストで知らせる。 */
  async function registerSearchKeyword() {
    if (!searchQuery) return
    if (await addKeyword(searchQuery)) {
      setToast(`「${searchQuery}」をキーワードウォッチに登録しました`)
    } else {
      setToast(`「${searchQuery}」はすでに登録されています`)
    }
  }

  /** 重要タブのカテゴリミュート切替。条件が変わるので重要タブのキャッシュは捨てる。 */
  function toggleMuteCategory(cat: string) {
    setMutedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    )
    setPages((prev) => {
      const updated = { ...prev }
      for (const k of Object.keys(updated)) {
        if (k.startsWith('important|')) delete updated[k]
      }
      return updated
    })
    pollSnapshotRef.current = null
    if (tab === 'important') setSelectedId(null)
  }

  // ポーリング（横ディスプレイ常駐表示用、2026-11-15 ユーザー承認）。
  // スケジューリングはサーバー側（2026-11-17 移行）: 状態の正はサーバーで、
  // このタブはサーバーと同期して表示・残り時間バー・収集完了の検知だけを行う。
  // タブを閉じても本体が起動している間は収集が続く。状態はサーバー側に
  // 保存され、サーバー再起動時も復元される（有効ならスケジュールも再開）。
  const [polling, setPolling] = useState(false)
  const [pollMinutes, setPollMinutes] = useState(5)
  /** 次回ポーリング更新までの残り割合（1→0）。残り時間バーに使う */
  const [pollProgress, setPollProgress] = useState(1)
  /** ポーリングで新しく現れたクラスタ（ハイライト対象） */
  const [highlightClusters, setHighlightClusters] = useState<ReadonlySet<number>>(
    new Set(),
  )
  /** 未確認の新着重要件数（タブタイトルに出す） */
  const [unseenCount, setUnseenCount] = useState(0)
  /** 重要タブの前回スナップショット（clusterId -> 最新の版番号） */
  const pollSnapshotRef = useRef<Map<number, number> | null>(null)
  const nextPollAtRef = useRef(0)
  /** 最後に反映済みの fetch_runs.id（サーバー側収集の完了検知に使う） */
  const lastRunIdRef = useRef<number | null>(null)
  const wakeLockRef = useRef<{ release: () => void } | null>(null)

  // 全画面表示（横ディスプレイ常駐表示用、2026-11-16 ユーザー承認）。
  // 状態の正はブラウザ側（document.fullscreenElement）で、fullscreenchange で
  // 同期する。F11 や Esc で切り替えた場合もボタンの表示がずれないようにするため。
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const sync = () => setIsFullscreen(Boolean(document.fullscreenElement))
    sync()
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {
        /* 終了できなくても状態は fullscreenchange 側で同期される */
      })
    } else {
      void document.documentElement.requestFullscreen().catch(() => {
        /* 許可されなかった場合は何もしない（ボタン表示は実状態のまま） */
      })
    }
  }

  // スポットライト表示（2026-11-16 ユーザー承認）。ポーリング・全画面とは独立の
  // 表示モードで、開始はマストヘッドのボタン、停止は表示内のボタンだけ。
  const [spotlightActive, setSpotlightActive] = useState(false)
  /** 一覧の再読み込みが完了するたびに増える世代。スポットライトの組み直しの契機 */
  const [refreshGen, setRefreshGen] = useState(0)
  // スポットライトで1件を表示する時間（秒、2026-11-16 ユーザー指示）。
  // 他の設定と同じく localStorage に保存し、実行中の変更は次の見出しから反映される
  const [spotlightSeconds, setSpotlightSeconds] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem('ichigyo:spotlightSeconds'))
      return SPOTLIGHT_SECONDS_OPTIONS.includes(v) ? v : 20
    } catch {
      return 20
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('ichigyo:spotlightSeconds', String(spotlightSeconds))
    } catch {
      /* 保存できなくても動作は続ける */
    }
  }, [spotlightSeconds])

  /** サーバー側のポーリング状態をこのタブの表示へ反映する（状態の正はサーバー）。 */
  const applyServerPolling = useCallback((p: PollingState) => {
    setPolling(p.enabled)
    setPollMinutes(p.minutes)
    nextPollAtRef.current = p.nextAt ?? 0
  }, [])

  /** ポーリングの ON/OFF と間隔をサーバーへ設定する（既存UIの裏側だけを移した）。 */
  const applyPolling = useCallback(
    async (enabled: boolean, minutes: number) => {
      try {
        applyServerPolling(await setPollingRemote(enabled, minutes))
      } catch {
        /* 失敗したらサーバーの現在値に同期し直す（表示と実状態をずらさない） */
        fetchServerStatus()
          .then((s) => applyServerPolling(s.polling))
          .catch(() => {})
      }
    },
    [applyServerPolling],
  )

  /** 自前で完了を扱った収集を「反映済み」として記録する（状態同期側の二重反映を防ぐ）。 */
  const markRunReflected = useCallback(() => {
    fetchServerStatus()
      .then((s) => {
        lastRunIdRef.current = s.lastRunId
      })
      .catch(() => {})
  }, [])

  // 未確認件数をタブタイトルに出す
  useEffect(() => {
    document.title =
      unseenCount > 0 ? `(${unseenCount}) ${BASE_TITLE}` : BASE_TITLE
  }, [unseenCount])

  /** 一覧を操作したら「確認済み」として件数とハイライトを消す。 */
  const acknowledgeNew = useCallback(() => {
    setUnseenCount(0)
    setHighlightClusters(new Set())
  }, [])

  // DB容量の表示（マストヘッド片隅）と、サーバー側ポーリング状態の初期同期。
  // 失敗しても画面は止めない
  useEffect(() => {
    fetchServerStatus()
      .then((s) => {
        setDbBytes(s.dbBytes)
        applyServerPolling(s.polling)
        if (lastRunIdRef.current === null) lastRunIdRef.current = s.lastRunId
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** ブックマーク件数だけを軽く取り直す（limit=1 で total のみ使う）。 */
  const refreshBookmarkCount = useCallback(() => {
    fetchTabRows('bookmarks', ALL_CATEGORY, 0, 1)
      .then((r) => setBookmarkCount(r.total))
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshBookmarkCount()
  }, [refreshBookmarkCount])

  const key = listKey(
    tab,
    category,
    tab === 'watch'
      ? (watchKeyword ?? '__all__')
      : tab === 'search'
        ? `q:${searchQuery}`
        : '',
  )
  // スポットライトが流す対象は「今開いているビュー」の一覧（2026-11-16
  // ユーザー指示で重要タブ固定から変更）。loadPage と同じ条件で組み立てる
  const spotlightWatchKeywords =
    tab === 'watch'
      ? watchKeyword
        ? [watchKeyword]
        : keywords
      : tab === 'search'
        ? searchQuery
          ? [searchQuery]
          : []
        : []
  // スポットライト中に「いまどのビューの一覧を流しているか」を左上に
  // 小さく出すための表示名（2026-11-16 ユーザー指示）
  const spotlightSourceLabel =
    tab === 'important'
      ? '重要'
      : tab === 'fresh'
        ? '新着'
        : tab === 'editorials'
          ? '社説'
          : tab === 'all'
            ? 'すべて'
            : tab === 'bookmarks'
              ? 'ブックマーク'
              : tab === 'watch'
                ? watchKeyword
                  ? `キーワードウォッチ「${watchKeyword}」`
                  : 'キーワードウォッチ'
                : searchQuery
                  ? `検索「${searchQuery}」`
                  : 'キーワード検索'
  const page = pages[key] ?? null

  const loadPage = useCallback(
    async (target: FeedTab, cat: string, offset: number, append: boolean) => {
      const scope =
        target === 'watch'
          ? (watchKeywordRef.current ?? '__all__')
          : target === 'search'
            ? `q:${searchQueryRef.current}`
            : ''
      const watchKeywords =
        target === 'watch'
          ? watchKeywordRef.current
            ? [watchKeywordRef.current]
            : keywordsRef.current
          : target === 'search'
            ? searchQueryRef.current
              ? [searchQueryRef.current]
              : []
            : []
      try {
        const result = await fetchTabRows(
          target,
          cat,
          offset,
          100,
          mutedRef.current,
          watchKeywords,
        )
        setRows((prev) => {
          const next = { ...prev }
          for (const row of result.rows) {
            // 詳細取得済みの行は coverages を保持する
            if (!next[row.id]?.detailLoaded) next[row.id] = row
          }
          return next
        })
        setPages((prev) => {
          const k = listKey(target, cat, scope)
          const cur = prev[k]
          const ids = append && cur
            ? [...cur.ids, ...result.rows.map((r) => r.id)]
            : result.rows.map((r) => r.id)
          return { ...prev, [k]: { ids, total: result.total } }
        })
        setCatCounts((prev) => ({ ...prev, [target]: result.categories }))
        if (result.refreshing) setBgRefreshing(true)
        // 一覧レスポンスに付いてくる次回ポーリング予定で残り時間バーを寄せておく
        if (result.polling?.nextAt != null) {
          nextPollAtRef.current = result.polling.nextAt
        }
        setLoadError(null)
        return result
      } catch {
        setLoadError('ニュースの取得に失敗しました。')
        setPages((prev) => ({
          ...prev,
          [listKey(target, cat, scope)]: prev[listKey(target, cat, scope)] ?? { ids: [], total: 0 },
        }))
        return null
      }
    },
    [],
  )

  useEffect(() => {
    if (page === null) void loadPage(tab, category, 0, false)
  }, [page, tab, category, loadPage])

  // 背後で収集中なら、終わるまでポーリングして一覧を取り直す（stale-while-revalidate）
  useEffect(() => {
    if (!bgRefreshing) return
    let tries = 0
    let cancelled = false
    const timer = setInterval(async () => {
      tries++
      const result = await loadPage(tab, category, 0, false)
      if (cancelled) return
      if (!result?.refreshing || tries >= 15) {
        setBgRefreshing(false)
        setRefreshGen((g) => g + 1)
        // この収集はここで反映済みにする（ポーリングの状態同期が同じ収集を
        // 検知して二重に組み直ししないように）
        markRunReflected()
        clearInterval(timer)
      }
    }, 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgRefreshing])

  // サーバー側で収集が完了したときの反映: 表示中の一覧を取り直してから、
  // 重要タブを前回スナップショットと比較し、新規クラスタと版が増えたクラスタを検出する。
  // refreshGen の増加がスポットライトの組み直し（1件目から流し直す）の契機になる
  const reflectServerRefresh = useCallback(async () => {
    await loadPage(tab, category, 0, false)
    setRefreshGen((g) => g + 1)
    try {
      const page = await fetchTabRows(
        'important',
        ALL_CATEGORY,
        0,
        100,
        mutedRef.current,
      )
      const prev = pollSnapshotRef.current
      pollSnapshotRef.current = new Map(
        page.rows.map((r) => [r.clusterId, r.version]),
      )
      if (!prev) return // 初回は基準作りのみ（既存分を新着扱いしない）
      const fresh = page.rows.filter((r) => {
        const before = prev.get(r.clusterId)
        return before === undefined || r.version > before
      })
      if (fresh.length > 0) {
        setUnseenCount((n) => n + fresh.length)
        setHighlightClusters(
          (old) => new Set([...old, ...fresh.map((r) => r.clusterId)]),
        )
      }
    } catch {
      /* 検出に失敗してもポーリング自体は続ける */
    }
  }, [tab, category, loadPage])

  // ポーリングの状態同期と残り時間バーの進行。スケジューリング自体はサーバー側で、
  // このタブは一定間隔で /api/status を見て次回予定を取り直し、収集の完了
  // （fetch_runs の進行）を検知して一覧へ反映する。タブ側で収集は開始しない
  useEffect(() => {
    if (!polling) {
      pollSnapshotRef.current = null
      setPollProgress(1)
      return
    }
    // 開始時点の重要タブを基準スナップショットにする（既存分を新着にしない）
    if (pollSnapshotRef.current === null) {
      fetchTabRows('important', ALL_CATEGORY, 0, 100, mutedRef.current)
        .then((page) => {
          if (pollSnapshotRef.current === null) {
            pollSnapshotRef.current = new Map(
              page.rows.map((r) => [r.clusterId, r.version]),
            )
          }
        })
        .catch(() => {})
    }
    let cancelled = false
    const sync = async () => {
      try {
        const s = await fetchServerStatus()
        if (cancelled) return
        applyServerPolling(s.polling)
        if (!s.polling.enabled || s.lastRunId === null) return
        if (lastRunIdRef.current === null) {
          // 初回同期は基準作りのみ（既存の収集を「完了した」と扱わない）
          lastRunIdRef.current = s.lastRunId
        } else if (s.lastRunId !== lastRunIdRef.current) {
          lastRunIdRef.current = s.lastRunId
          await reflectServerRefresh()
        }
      } catch {
        /* 失敗しても次の周期で再試行する */
      }
    }
    void sync()
    const syncTimer = setInterval(() => void sync(), 10000)
    const progressTimer = setInterval(() => {
      const intervalMs = pollMinutes * 60 * 1000
      let remain = nextPollAtRef.current - Date.now()
      // 同期前に予定時刻を過ぎていたら、周期分だけ繰り上げて見積もる
      if (remain < 0) remain = intervalMs - (Math.abs(remain) % intervalMs)
      setPollProgress(Math.min(1, Math.max(0, remain) / intervalMs))
    }, 250)
    return () => {
      cancelled = true
      clearInterval(syncTimer)
      clearInterval(progressTimer)
    }
  }, [polling, pollMinutes, reflectServerRefresh, applyServerPolling])

  // ポーリング中は画面スリープを防ぐ（Wake Lock、対応環境のみ）
  useEffect(() => {
    if (!polling) return
    const nav = navigator as Navigator & {
      wakeLock?: {
        request: (type: 'screen') => Promise<{ release: () => void }>
      }
    }
    if (!nav.wakeLock) return
    const acquire = async () => {
      try {
        wakeLockRef.current = await nav.wakeLock!.request('screen')
      } catch {
        /* 取得できなくてもポーリングは続ける */
      }
    }
    void acquire()
    // Wake Lock はタブが不可視になると自動で解放されるため、戻ってきたら取り直す
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      try {
        wakeLockRef.current?.release()
      } catch {
        /* 解放済みでも問題ない */
      }
      wakeLockRef.current = null
    }
  }, [polling])

  const visible = useMemo(() => {
    const ids = page?.ids ?? []
    return ids
      .map((id) => rows[id])
      .filter((row): row is StoryRow => Boolean(row))
  }, [page, rows])

  const allRows = useMemo(() => Object.values(rows), [rows])

  const selected =
    (selectedId ? rows[selectedId] : undefined) ?? visible[0] ?? null

  // 選択がなければ表示中リストの先頭行（＝最新版）を選ぶ
  useEffect(() => {
    if (!selectedId && visible.length > 0) setSelectedId(visible[0].id)
  }, [selectedId, visible])

  const related = selected ? versionsOfEvent(allRows, selected.eventId) : []

  // 版チップ列（横スクロール）では、選択中のチップが常に視界に入るよう列側だけをスクロールする
  const selectedRowId = selected?.id
  useEffect(() => {
    const rail = versionRailRef.current
    if (!rail || !selectedRowId) return
    const active = rail.querySelector<HTMLElement>('.version-chip.is-active')
    if (!active) return
    const left = active.offsetLeft
    const right = left + active.offsetWidth
    if (left < rail.scrollLeft || right > rail.scrollLeft + rail.clientWidth) {
      rail.scrollLeft = Math.max(0, left - 8)
    }
  }, [selectedRowId, related.length])

  // 詳細（各紙の報道）を開いたクラスタについて取得し、全バージョン行へ反映する
  const selectedClusterId = selected?.clusterId
  useEffect(() => {
    if (selectedClusterId === undefined) return
    if (detailState[selectedClusterId]) return
    const cid = selectedClusterId
    setDetailState((prev) => ({ ...prev, [cid]: 'loading' }))
    // 閲覧ログ（日次集計の材料）を fire-and-forget で送る
    postReadEvent(cid)
    // 開いたクラスタはこのセッションでも既読として扱う（一覧の薄表示用）
    setReadClusters((prev) =>
      prev.has(cid) ? prev : new Set(prev).add(cid),
    )
    fetchClusterDetail(cid)
      .then((detail) => {
        setRows((prev) => {
          const next = { ...prev }
          for (const row of detail.rows) next[row.id] = row
          return next
        })
        setDetailState((prev) => ({ ...prev, [cid]: 'loaded' }))
        setEditorialState((prev) => ({
          ...prev,
          [cid]: detail.editorialsChecked ? 'done' : 'unchecked',
        }))
      })
      .catch(() => {
        setDetailState((prev) => ({ ...prev, [cid]: 'loaded' }))
      })
  }, [selectedClusterId, detailState])

  // 社説が未チェックのクラスタは、詳細を開いた時点で検索する（クラスタ単位・版共通）
  const selectedEditorialState = selected
    ? editorialState[selected.clusterId]
    : undefined
  useEffect(() => {
    if (selectedClusterId === undefined) return
    if (selectedEditorialState !== 'unchecked') return
    const cid = selectedClusterId
    setEditorialState((prev) => ({ ...prev, [cid]: 'loading' }))
    fetchEditorials(cid)
      .then((infos) => {
        setRows((prev) => {
          const mine = Object.values(prev).filter((r) => r.clusterId === cid)
          const next = { ...prev }
          for (const row of applyEditorials(mine, infos)) next[row.id] = row
          return next
        })
        setEditorialState((prev) => ({ ...prev, [cid]: 'done' }))
      })
      .catch(() => {
        setEditorialState((prev) => ({ ...prev, [cid]: 'done' }))
      })
  }, [selectedClusterId, selectedEditorialState])

  // 社説の切替は「中身がある場合だけ」出す（空表示の廃止、2026-11-15 ユーザー要望）。
  // 確認の試行前・試行中は切替を出したままにし、完了して初めて「無かった」と確定したら隠す。
  const hasEditorialCoverage =
    selected?.coverages.some((c) => c.editorial) ?? false
  const showEditorialTab =
    selectedEditorialState !== 'done' || hasEditorialCoverage
  const effectiveKind: CoverageKind =
    coverageKind === 'editorial' && !showEditorialTab ? 'summary' : coverageKind
  // 社説ビューでは媒体を絞り込まない: 選択中の媒体に社説が無い場合は、別媒体の社説を
  // 無言で代替表示せず「その媒体の社説は無い」と明示する（帰属の誤解防止、2026-11-15 是正）。
  const visibleCoverages = !selected ? [] : selected.coverages
  /** 社説が確認できている媒体（社説ビューでの案内文に使う） */
  const editorialOutlets =
    selected?.coverages.filter((c) => c.editorial) ?? []
  const activeOutlet =
    visibleCoverages.find((coverage) => coverage.outletId === outletId) ??
    visibleCoverages[0]

  /** 狭幅ページャーで一覧ペインへ戻す（広い画面では横スクロールしないため無害）。 */
  function goToListPane() {
    workspaceRef.current?.scrollTo({ left: 0, behavior: 'auto' })
  }

  /** 狭幅ページャーで詳細ペイン（右隣）へスムーズスクロールする。 */
  function goToDetailPane() {
    const ws = workspaceRef.current
    if (!ws) return
    ws.scrollTo({ left: ws.clientWidth, behavior: 'smooth' })
  }

  function openStory(id: string) {
    acknowledgeNew()
    setSelectedId(id)
    setOutletId(null)
    setCoverageKind('summary')
    // 詳細ペインを先頭に戻し、スマホではページャーを詳細側へスクロールする
    requestAnimationFrame(() => {
      detailRef.current?.scrollTo({ top: 0 })
      if (window.matchMedia(NARROW_MEDIA).matches) goToDetailPane()
    })
  }

  function switchTab(next: FeedTab) {
    acknowledgeNew()
    setTab(next)
    setSelectedId(null)
    setOutletId(null)
    setCoverageKind('summary')
    goToListPane()
  }

  function switchCategory(next: string) {
    acknowledgeNew()
    setCategory(next)
    setSelectedId(null)
    setOutletId(null)
    setCoverageKind('summary')
    goToListPane()
  }

  async function toggleBookmark() {
    if (!selected) return
    const cid = selected.clusterId
    const next = !selected.bookmarked
    try {
      if (next) await addBookmark(cid)
      else await removeBookmark(cid)
      setRows((prev) => {
        const updated = { ...prev }
        for (const row of Object.values(updated)) {
          if (row.clusterId === cid) updated[row.id] = { ...row, bookmarked: next }
        }
        return updated
      })
      // ブックマーク一覧は古くなるので破棄し、次に開いたときに取り直す
      setPages((prev) => {
        const updated = { ...prev }
        for (const k of Object.keys(updated)) {
          if (k.startsWith('bookmarks|')) delete updated[k]
        }
        return updated
      })
      refreshBookmarkCount()
    } catch {
      setLoadError('ブックマークの更新に失敗しました。')
    }
  }

  // トーストは一定時間で自動的に消す
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

  async function handleMaintenance() {
    if (maintaining) return
    setConfirmingMaintenance(false)
    setMaintaining(true)
    try {
      const result = await runMaintenance()
      setDbBytes(result.afterBytes)
      setToast(
        `古いニュースを ${result.prunedClusters} 件削除しました（DB ${formatBytes(result.beforeBytes)} → ${formatBytes(result.afterBytes)}）`,
      )
    } catch {
      setToast('古いデータの削除と圧縮に失敗しました。')
    } finally {
      setMaintaining(false)
    }
  }

  async function handleRefresh() {
    if (refreshing || bgRefreshing) return
    setRefreshing(true)
    try {
      const { alreadyRunning } = await refreshFeed()
      if (alreadyRunning) {
        // 別のタブ・ウィンドウ等が開始した収集が実行中。自分では開始せず、
        // 背後更新の仕組み（bgRefreshing のポーリング）で完了後に取り直す
        setBgRefreshing(true)
        await loadPage(tab, category, 0, false)
        return
      }
      setRows({})
      setPages({})
      setDetailState({})
      setEditorialState({})
      setSelectedId(null)
      setOutletId(null)
      goToListPane()
      await loadPage(tab, category, 0, false)
      setRefreshGen((g) => g + 1)
      // この収集はここで反映済みにする（ポーリングの状態同期側の二重反映を防ぐ）
      markRunReflected()
      fetchDbStatus()
        .then((s) => setDbBytes(s.dbBytes))
        .catch(() => {})
    } catch {
      setLoadError('更新に失敗しました。')
    } finally {
      setRefreshing(false)
    }
  }

  const detailLoading = selected ? !selected.detailLoaded : false
  const editorialLoading = selectedEditorialState === 'loading'
  // RSS 抜粋は常時、社説は中身がある（または確認中）場合だけ切替を出す
  const visibleKinds = (
    [
      ['summary', 'RSS 抜粋'],
      ['editorial', '社説'],
    ] as const
  ).filter(
    ([kind]) => kind === 'summary' || (kind === 'editorial' && showEditorialTab),
  )
  const hasMore = page !== null && page.ids.length < page.total
  const counts = catCounts[tab] ?? []
  const totalInTab = counts.reduce((n, c) => n + c.count, 0)

  return (
    <div className="shell">
      {/* スポットライト中はマストヘッドを隠し、表示が画面全体を占有する
          （2026-11-16 ユーザー指示） */}
      {!spotlightActive ? (
      <header className="masthead">
        <div className="brand">
          <h1>一行ニュース</h1>
          <p className="brand-kicker">一行で、五紙を読む。</p>
        </div>
        <div className="masthead-side">
          <p className="masthead-contact">
            要望・不具合の報告は
            <a
              href="https://x.com/ichigyo_news"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="X（@ichigyo_news）"
            >
              X
            </a>
            まで
          </p>
          <div className="masthead-actions">
            {bgRefreshing ? (
              <span className="refreshing-note">背後で更新中…</span>
            ) : null}
            <div className="util-set">
              <button
                type="button"
                className="switch"
                role="switch"
                aria-checked={polling}
                onClick={() => void applyPolling(!polling, pollMinutes)}
                title="ポーリング（一定間隔で自動更新）"
              >
                <span className="switch-track">
                  <span className="switch-thumb" />
                </span>
                <span className="switch-label">ポーリング</span>
              </button>
              {polling ? (
                <div
                  className="segmented"
                  role="group"
                  aria-label="ポーリング間隔"
                >
                  {POLL_INTERVALS.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={pollMinutes === m ? 'seg is-active' : 'seg'}
                      onClick={() => void applyPolling(polling, m)}
                      aria-pressed={pollMinutes === m}
                    >
                      {m}分
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={handleRefresh}
              disabled={refreshing || bgRefreshing}
              title="最新ニュースに更新"
              aria-label="最新ニュースに更新"
            >
              <svg
                className={refreshing || bgRefreshing ? 'spin' : undefined}
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
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
            <button
              type="button"
              className="spotlight-start"
              onClick={() => setSpotlightActive(true)}
              disabled={spotlightActive}
              title="今開いているビューの一覧を1件ずつ大きく表示します"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
                <path
                  d="M10.2 8.1v4.3l3.8-2.15z"
                  fill="currentColor"
                  stroke="none"
                />
                <line x1="9" y1="20.5" x2="15" y2="20.5" />
              </svg>
              <span>
                {spotlightActive ? 'スポットライト表示中' : 'スポットライト表示'}
              </span>
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={toggleFullscreen}
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
            <SettingsMenu
              menuOpen={menuOpen}
              setMenuOpen={setMenuOpen}
              fontSize={fontSize}
              setFontSize={setFontSize}
              density={density}
              setDensity={setDensity}
              spotlightSeconds={spotlightSeconds}
              setSpotlightSeconds={setSpotlightSeconds}
              spotlightSecondsOptions={SPOTLIGHT_SECONDS_OPTIONS}
              themePreset={themePreset}
              setThemePreset={setThemePreset}
              themePresets={THEME_PRESETS}
              dimRead={dimRead}
              setDimRead={setDimRead}
              categoryOrder={CATEGORY_ORDER}
              mutedCategories={mutedCategories}
              toggleMuteCategory={toggleMuteCategory}
              keywords={keywords}
              keywordInput={keywordInput}
              setKeywordInput={setKeywordInput}
              addKeyword={addKeyword}
              removeKeyword={removeKeyword}
              dbBytes={dbBytes}
              formatBytes={formatBytes}
              maintaining={maintaining}
              setConfirmingMaintenance={setConfirmingMaintenance}
            />
          </div>
        </div>
      </header>
      ) : null}

      {confirmingMaintenance ? (
        <div
          className="modal-overlay"
          onClick={() => setConfirmingMaintenance(false)}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="maintenance-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="maintenance-dialog-title">古いデータを削除しますか？</h2>
            <p>
              7日より前のニュース（ブックマークしたものを除く）を削除し、データベースを圧縮します。
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="modal-btn"
                onClick={() => setConfirmingMaintenance(false)}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="modal-btn is-danger"
                onClick={() => void handleMaintenance()}
                disabled={maintaining}
              >
                {maintaining ? '削除中…' : '削除して圧縮する'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}

      {polling && !spotlightActive ? (
        <div
          className="poll-progress"
          role="progressbar"
          aria-label="次の更新までの残り時間"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pollProgress * 100)}
        >
          <div
            className="poll-progress-bar"
            style={{ width: `${pollProgress * 100}%` }}
          />
        </div>
      ) : null}

      {spotlightActive ? (
        <Spotlight
          refreshGen={refreshGen}
          sourceTab={tab}
          sourceCategory={category}
          mutedCategories={mutedCategories}
          sourceWatchKeywords={spotlightWatchKeywords}
          sourceLabel={spotlightSourceLabel}
          rotateMs={spotlightSeconds * 1000}
          isFullscreen={isFullscreen}
          onToggleFullscreen={toggleFullscreen}
          onStop={() => setSpotlightActive(false)}
        />
      ) : (
        <>
      <nav className="tabs" aria-label="ニュースの種類">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? 'tab is-active' : 'tab'}
            onClick={() => switchTab(item.id)}
            aria-current={tab === item.id ? 'page' : undefined}
          >
            <span>{item.label}</span>
            <small>{item.hint}</small>
          </button>
        ))}
        <button
          type="button"
          className={
            tab === 'bookmarks' ? 'bookmark-nav is-active' : 'bookmark-nav'
          }
          onClick={() => switchTab('bookmarks')}
          aria-current={tab === 'bookmarks' ? 'page' : undefined}
          aria-label="ブックマークしたニュースを表示"
          title="ブックマーク"
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill={tab === 'bookmarks' ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
          {bookmarkCount !== null && bookmarkCount > 0 ? (
            <span className="bookmark-count">{bookmarkCount}</span>
          ) : null}
        </button>
        <button
          type="button"
          className={tab === 'watch' ? 'watch-nav is-active' : 'watch-nav'}
          onClick={() => switchTab('watch')}
          aria-current={tab === 'watch' ? 'page' : undefined}
          aria-label="キーワードウォッチを表示"
          title="キーワードウォッチ"
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
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          {keywords.length > 0 ? (
            <span className="bookmark-count">{keywords.length}</span>
          ) : null}
        </button>
        <button
          type="button"
          className={tab === 'search' ? 'search-nav is-active' : 'search-nav'}
          onClick={() => switchTab('search')}
          aria-current={tab === 'search' ? 'page' : undefined}
          aria-label="キーワード検索を開く"
          title="キーワード検索"
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
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.5" y2="16.5" />
          </svg>
        </button>
      </nav>

      <div className="cat-bar" role="tablist" aria-label="カテゴリ">
        <button
          type="button"
          role="tab"
          aria-selected={category === ALL_CATEGORY}
          className={category === ALL_CATEGORY ? 'cat-chip is-active' : 'cat-chip'}
          onClick={() => switchCategory(ALL_CATEGORY)}
        >
          すべて
          {totalInTab > 0 ? <small>{totalInTab}</small> : null}
        </button>
        {CATEGORY_ORDER.filter((c) => counts.some((x) => x.category === c)).map(
          (c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={category === c}
              className={category === c ? 'cat-chip is-active' : 'cat-chip'}
              onClick={() => switchCategory(c)}
            >
              {c}
              <small>{counts.find((x) => x.category === c)?.count}</small>
            </button>
          ),
        )}
      </div>

      {tab === 'search' ? (
        <div className="search-bar">
          <form className="search-form" onSubmit={submitSearch} role="search">
            <input
              className="search-input"
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="キーワードを入力（例: 今田美桜）"
              aria-label="検索キーワード"
              maxLength={50}
            />
            <button type="submit" className="kw-add search-submit">
              検索
            </button>
          </form>
          {searchQuery ? (
            keywords.includes(searchQuery) ? (
              <button type="button" className="search-register" disabled>
                「{searchQuery}」は登録済み
              </button>
            ) : (
              <button
                type="button"
                className="search-register"
                onClick={registerSearchKeyword}
              >
                「{searchQuery}」をキーワードに登録する
              </button>
            )
          ) : null}
        </div>
      ) : null}

      {tab === 'watch' ? (
        <div className="watch-bar" role="tablist" aria-label="キーワード">
          <button
            type="button"
            role="tab"
            aria-selected={watchKeyword === null}
            className={
              watchKeyword === null ? 'cat-chip is-active' : 'cat-chip'
            }
            onClick={() => selectWatchKeyword(null)}
          >
            すべて
          </button>
          {keywords.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={watchKeyword === k}
              className={
                watchKeyword === k ? 'cat-chip is-active' : 'cat-chip'
              }
              onClick={() => selectWatchKeyword(k)}
            >
              {k}
            </button>
          ))}
        </div>
      ) : null}

      <div
        className="workspace"
        ref={workspaceRef}
        style={{ '--list-ratio': paneRatio } as CSSProperties}
      >
        <section
          className={
            density === 'compact' ? 'list-pane is-compact' : 'list-pane'
          }
          aria-label="ニュース一覧"
          onFocus={acknowledgeNew}
          onPointerDown={acknowledgeNew}
        >
          {page === null ? (
            <p className="empty">読み込み中…</p>
          ) : visible.length === 0 ? (
            <p className="empty">
              {loadError ??
                (tab === 'search' && !searchQuery
                    ? '上の入力欄にキーワードを入れて検索してください。一致はクラスタと記事の見出し・要約が対象です。'
                    : tab === 'search'
                      ? `「${searchQuery}」に一致するニュースはありません。`
                      : tab === 'watch' && keywords.length === 0
                        ? 'キーワードが登録されていません。設定メニュー（右上のハンバーガー）からキーワードを登録してください。'
                        : tab === 'watch' && watchKeyword
                          ? `「${watchKeyword}」に一致するニュースはまだありません。`
                          : 'この条件に表示するニュースはありません。')}
            </p>
          ) : (
            <>
              <ul>
                {visible.map((story) => {
                  const isActive = selected?.id === story.id
                  // フッター行の中身（コンパクト時はメタ行へ畳む、Issue #4）
                  const coverageNote = (
                    <span>
                      {story.coverages.length}紙
                      {story.version === 1 ? ' · 初報' : ' · 続報'}
                      {tab === 'editorials' &&
                      story.editorialPapers &&
                      story.editorialPapers.length > 0 ? (
                        <span className="editorial-papers">
                          {' · 社説 '}
                          {story.editorialPapers.join('・')}
                        </span>
                      ) : null}
                    </span>
                  )
                  const rowBadges = (
                    <span className="badges">
                      {story.isImportant ? (
                        <span className="badge important">重要</span>
                      ) : null}
                      {story.isNew ? (
                        <span className="badge fresh">新着</span>
                      ) : null}
                    </span>
                  )
                  const rowClass = [
                    'row',
                    isActive ? 'is-active' : '',
                    highlightClusters.has(story.clusterId) ? 'is-new' : '',
                    dimRead &&
                    (story.read || readClusters.has(story.clusterId))
                      ? 'is-read'
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' ')
                  return (
                    <li key={story.id}>
                      <button
                        type="button"
                        className={rowClass}
                        onClick={() => openStory(story.id)}
                      >
                        <div className="row-main">
                          <div className="row-meta">
                            <span className="version">v{story.version}</span>
                            <time dateTime={story.publishedAt}>
                              {formatWhen(story.publishedAt)}
                            </time>
                            <span className="category">{story.category}</span>
                            {density === 'compact' ? (
                              <>
                                {coverageNote}
                                {rowBadges}
                              </>
                            ) : null}
                          </div>
                          <p className="row-title">{story.title}</p>
                          <p className="row-lead">{story.lead}</p>
                          {density === 'compact' ? null : (
                            <div className="row-foot">
                              {coverageNote}
                              {rowBadges}
                            </div>
                          )}
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
              {hasMore ? (
                <button
                  type="button"
                  className="load-more"
                  onClick={() => void loadPage(tab, category, page.ids.length, true)}
                >
                  もっと見る（残り{page.total - page.ids.length}件）
                </button>
              ) : null}
            </>
          )}
        </section>

        <div
          className={paneDragging ? 'pane-divider is-dragging' : 'pane-divider'}
          role="separator"
          aria-orientation="vertical"
          aria-label="一覧と詳細の幅を調整"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(paneRatio * 100)}
          aria-valuetext={`一覧の幅 ${Math.round(paneRatio * 100)}%`}
          tabIndex={0}
          title="ドラッグで一覧と詳細の幅を調整（ダブルクリックで既定に戻す）"
          onPointerDown={handleDividerPointerDown}
          onPointerMove={handleDividerPointerMove}
          onPointerUp={() => setPaneDragging(false)}
          onPointerCancel={() => setPaneDragging(false)}
          onDoubleClick={() => setPaneRatio(PANE_RATIO_DEFAULT)}
          onKeyDown={handleDividerKeyDown}
        />

        {selected ? (
          <article className="detail-pane" ref={detailRef}>
            <header className="detail-head">
              <button
                type="button"
                className="back-to-list"
                onClick={goToListPane}
              >
                ← 一覧へ戻る
              </button>
              <p className="event-title">{selected.eventTitle}</p>
              <h2>
                {selected.title}
                <button
                  type="button"
                  className={
                    selected.bookmarked
                      ? 'bookmark-toggle is-active'
                      : 'bookmark-toggle'
                  }
                  onClick={toggleBookmark}
                  aria-pressed={!!selected.bookmarked}
                  aria-label={
                    selected.bookmarked
                      ? 'ブックマーク済み（解除する）'
                      : 'ブックマークする'
                  }
                  title={
                    selected.bookmarked
                      ? 'ブックマーク済み（データを整理しても削除されません）'
                      : 'ブックマークする'
                  }
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill={selected.bookmarked ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                  </svg>
                </button>
              </h2>
              <p className="version-meta">
                v{selected.version}
                {selected.version === 1 ? ' · 初報' : ' · 続報'}
                {' · '}
                <time dateTime={selected.versionCreatedAt}>
                  {formatWhen(selected.versionCreatedAt)}
                </time>
              </p>
              <p className="detail-lead">{selected.lead}</p>
              <ol
                className="version-rail"
                aria-label="この出来事の版"
                ref={versionRailRef}
              >
                {related.map((story) => (
                  <li key={story.id}>
                    <button
                      type="button"
                      className={
                        story.id === selected.id
                          ? 'version-chip is-active'
                          : 'version-chip'
                      }
                      aria-current={story.id === selected.id || undefined}
                      title={`v${story.version}${story.version === 1 ? '（初報）' : '（続報）'} · ${formatWhen(story.versionCreatedAt)}`}
                      onClick={() => openStory(story.id)}
                    >
                      v{story.version}
                    </button>
                  </li>
                ))}
              </ol>
            </header>

            {detailLoading ? (
              <p className="empty">詳細を読み込み中…</p>
            ) : (
              <>
                <div className="outlet-bar" role="tablist" aria-label="新聞社">
                  {visibleCoverages.map((coverage) => (
                    <button
                      key={coverage.outletId}
                      type="button"
                      role="tab"
                      aria-selected={coverage.outletId === activeOutlet?.outletId}
                      className={
                        coverage.outletId === activeOutlet?.outletId
                          ? 'outlet is-active'
                          : 'outlet'
                      }
                      onClick={() => setOutletId(coverage.outletId)}
                    >
                      {coverage.outletName}
                      {coverage.editorial ? (
                        <span className="editorial-badge">社説あり</span>
                      ) : null}
                    </button>
                  ))}
                </div>

                <div className="kind-bar" role="tablist" aria-label="記事の種類">
                  {visibleKinds.map(([kind, label]) => (
                    <button
                      key={kind}
                      type="button"
                      role="tab"
                      aria-selected={effectiveKind === kind}
                      className={
                        effectiveKind === kind ? 'kind is-active' : 'kind'
                      }
                      onClick={() => {
                        // 媒体の選択は種別を切り替えても維持する（社説ビューで
                        // 「選択中の媒体に社説があるか」を正しく判定するため）
                        setCoverageKind(kind)
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {activeOutlet ? (
                  <div className="paper">
                    <p className="paper-kicker">
                      {activeOutlet.outletName}
                      <time dateTime={activeOutlet.publishedAt}>
                        {formatWhen(activeOutlet.publishedAt)}
                      </time>
                    </p>
                    <h3>{activeOutlet.headline}</h3>
                    {effectiveKind === 'editorial' ? (
                      editorialLoading ? (
                        <p className="paper-note">社説を確認中…</p>
                      ) : activeOutlet.editorial ? (
                        <>
                          <p className="paper-owner">
                            {activeOutlet.outletName}の社説
                          </p>
                          <Paragraphs text={activeOutlet.editorial ?? ''} />
                          {activeOutlet.editorialUrl ? (
                            <a
                              className="paper-link"
                              href={activeOutlet.editorialUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              社説の元記事を読む
                            </a>
                          ) : null}
                          <p className="paper-note">
                            社説は版ごとではなく、この出来事全体に対するものです。
                          </p>
                        </>
                      ) : (
                        <p className="paper-notice">
                          {activeOutlet.outletName}の社説はありません。
                          {editorialOutlets.length > 0
                            ? `社説があるのは ${editorialOutlets
                                .map((c) => c.outletName)
                                .join('・')} です。上の媒体ボタン（「社説あり」の印が付いたもの）から選んでください。`
                            : ''}
                        </p>
                      )
                    ) : (
                      <>
                        <Paragraphs
                          text={activeOutlet.summary || '（RSS 抜粋はありません）'}
                        />
                        {activeOutlet.url ? (
                          <a
                            className="paper-link"
                            href={activeOutlet.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            元記事を読む
                          </a>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : effectiveKind === 'editorial' && editorialLoading ? (
                  <p className="muted">社説を確認中…</p>
                ) : null}
              </>
            )}
          </article>
        ) : null}
      </div>
        </>
      )}
    </div>
  )
}

export default App
