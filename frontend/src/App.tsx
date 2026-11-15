import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addBookmark,
  applyEditorials,
  fetchClusterBodies,
  fetchClusterDetail,
  fetchDbStatus,
  fetchEditorials,
  fetchTabRows,
  postReadEvent,
  refreshFeed,
  removeBookmark,
  runMaintenance,
  versionsOfEvent,
} from './api'
import type { CoverageKind, FeedTab, StoryRow } from './types'
import './App.css'

const TABS: { id: FeedTab; label: string; hint: string }[] = [
  { id: 'important', label: '重要', hint: '社会的影響が大きい出来事' },
  { id: 'fresh', label: '新着', hint: '直近で入った初報と続報' },
  { id: 'all', label: 'すべて', hint: '版を含む全行' },
  { id: 'bookmarks', label: 'ブックマーク', hint: '保存したニュース' },
]

function formatBytes(bytes: number) {
  if (!bytes) return ''
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
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

function formatWhen(iso: string) {
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

type DetailState = 'loading' | 'loaded'
type EditorialState = 'unchecked' | 'loading' | 'done'
type BodyState = 'loading' | 'done'

interface ListPage {
  ids: string[]
  total: number
}

const listKey = (tab: FeedTab, category: string) => `${tab}|${category}`

function App() {
  const [tab, setTab] = useState<FeedTab>('important')
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
  const [bodyState, setBodyState] = useState<Record<number, BodyState>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [bgRefreshing, setBgRefreshing] = useState(false)
  const [dbBytes, setDbBytes] = useState<number | null>(null)
  const [maintaining, setMaintaining] = useState(false)
  const detailRef = useRef<HTMLElement | null>(null)

  // DB容量の表示（マストヘッド片隅）。失敗しても画面は止めない
  useEffect(() => {
    fetchDbStatus()
      .then((s) => setDbBytes(s.dbBytes))
      .catch(() => {})
  }, [])

  const key = listKey(tab, category)
  const page = pages[key] ?? null

  const loadPage = useCallback(
    async (target: FeedTab, cat: string, offset: number, append: boolean) => {
      try {
        const result = await fetchTabRows(target, cat, offset)
        setRows((prev) => {
          const next = { ...prev }
          for (const row of result.rows) {
            // 詳細取得済みの行は coverages を保持する
            if (!next[row.id]?.detailLoaded) next[row.id] = row
            else if ((row.bodyCount ?? 0) > 0 || row.imageUrl) {
              // 一覧側の本文バッジとサムネイルだけは新しい情報で更新する
              next[row.id] = {
                ...next[row.id],
                bodyCount: row.bodyCount,
                bodyChars: row.bodyChars,
                imageUrl: row.imageUrl ?? next[row.id].imageUrl,
              }
            }
          }
          return next
        })
        setPages((prev) => {
          const k = listKey(target, cat)
          const cur = prev[k]
          const ids = append && cur
            ? [...cur.ids, ...result.rows.map((r) => r.id)]
            : result.rows.map((r) => r.id)
          return { ...prev, [k]: { ids, total: result.total } }
        })
        setCatCounts((prev) => ({ ...prev, [target]: result.categories }))
        if (result.refreshing) setBgRefreshing(true)
        setLoadError(null)
        return result
      } catch {
        setLoadError('ニュースの取得に失敗しました。')
        setPages((prev) => ({
          ...prev,
          [listKey(target, cat)]: prev[listKey(target, cat)] ?? { ids: [], total: 0 },
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
        clearInterval(timer)
      }
    }, 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgRefreshing])

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

  const activeOutlet =
    selected?.coverages.find((coverage) => coverage.outletId === outletId) ??
    selected?.coverages[0]

  const related = selected ? versionsOfEvent(allRows, selected.eventId) : []

  // 詳細（各紙の報道）を開いたクラスタについて取得し、全バージョン行へ反映する
  const selectedClusterId = selected?.clusterId
  useEffect(() => {
    if (selectedClusterId === undefined) return
    if (detailState[selectedClusterId]) return
    const cid = selectedClusterId
    setDetailState((prev) => ({ ...prev, [cid]: 'loading' }))
    // 閲覧ログ（日次集計の材料）を fire-and-forget で送る
    postReadEvent(cid)
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
        if (detail.bodiesAttempted) {
          setBodyState((prev) => ({ ...prev, [cid]: 'done' }))
        }
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

  // 本文が未試行のクラスタは、詳細を開いた時点で本文取得も試みる（社説と並行）
  const selectedBodyState = selected ? bodyState[selected.clusterId] : undefined
  useEffect(() => {
    if (selectedClusterId === undefined) return
    if (detailState[selectedClusterId] !== 'loaded') return
    if (selectedBodyState !== undefined) return
    const cid = selectedClusterId
    setBodyState((prev) => ({ ...prev, [cid]: 'loading' }))
    fetchClusterBodies(cid)
      .then((detail) => {
        setRows((prev) => {
          const next = { ...prev }
          for (const row of detail.rows) {
            // 本文取得で coverages が並べ替わる。社説の取得結果は保持する
            const old = next[row.id]
            next[row.id] = old
              ? {
                  ...row,
                  imageUrl: row.imageUrl ?? old.imageUrl,
                  coverages: row.coverages.map((c) => {
                    const oc = old.coverages.find(
                      (x) => x.outletId === c.outletId,
                    )
                    return oc?.editorial && !c.editorial
                      ? {
                          ...c,
                          editorial: oc.editorial,
                          editorialTitle: oc.editorialTitle,
                          editorialUrl: oc.editorialUrl,
                        }
                      : c
                  }),
                }
              : row
          }
          return next
        })
        setBodyState((prev) => ({ ...prev, [cid]: 'done' }))
      })
      .catch(() => {
        setBodyState((prev) => ({ ...prev, [cid]: 'done' }))
      })
  }, [selectedClusterId, detailState, selectedBodyState])

  function openStory(id: string) {
    setSelectedId(id)
    setOutletId(null)
    setCoverageKind('summary')
    // 詳細ペインを先頭に戻し、スマホでは詳細が視界に入るようスクロールする
    requestAnimationFrame(() => {
      detailRef.current?.scrollTo({ top: 0 })
      if (window.matchMedia('(max-width: 860px)').matches) {
        detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    })
  }

  function switchTab(next: FeedTab) {
    setTab(next)
    setSelectedId(null)
    setOutletId(null)
    setCoverageKind('summary')
  }

  function switchCategory(next: string) {
    setCategory(next)
    setSelectedId(null)
    setOutletId(null)
    setCoverageKind('summary')
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
      // ブックマークタブの一覧は古くなるので破棄し、次に開いたときに取り直す
      setPages((prev) => {
        const updated = { ...prev }
        for (const k of Object.keys(updated)) {
          if (k.startsWith('bookmarks|')) delete updated[k]
        }
        return updated
      })
    } catch {
      setLoadError('ブックマークの更新に失敗しました。')
    }
  }

  async function handleMaintenance() {
    if (maintaining) return
    setMaintaining(true)
    try {
      const result = await runMaintenance()
      setDbBytes(result.afterBytes)
    } catch {
      setLoadError('データの整理に失敗しました。')
    } finally {
      setMaintaining(false)
    }
  }

  async function handleRefresh() {
    if (refreshing) return
    setRefreshing(true)
    try {
      await refreshFeed()
      setRows({})
      setPages({})
      setDetailState({})
      setEditorialState({})
      setBodyState({})
      setSelectedId(null)
      setOutletId(null)
      await loadPage(tab, category, 0, false)
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
  const bodyLoading = selectedBodyState === 'loading'
  const hasMore = page !== null && page.ids.length < page.total
  const counts = catCounts[tab] ?? []
  const totalInTab = counts.reduce((n, c) => n + c.count, 0)

  return (
    <div className="shell">
      <header className="masthead">
        <div className="brand">
          <p className="brand-kicker">同じニュースは、一行。</p>
          <h1>一行ニュース</h1>
        </div>
        <div className="masthead-side">
          <p className="masthead-note">
            各紙の報道・要約・社説を並べ、初報を v1、続報を別行の v2 として開きます。
          </p>
          <div className="masthead-actions">
            {bgRefreshing ? (
              <span className="refreshing-note">背後で更新中…</span>
            ) : null}
            {dbBytes !== null ? (
              <span className="db-size">DB {formatBytes(dbBytes)}</span>
            ) : null}
            <button
              type="button"
              className="refresh-btn"
              onClick={handleMaintenance}
              disabled={maintaining}
            >
              {maintaining ? '整理中…' : 'データを整理'}
            </button>
            <button
              type="button"
              className="refresh-btn"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              {refreshing ? '更新中…' : '更新'}
            </button>
          </div>
        </div>
      </header>

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

      <div className="workspace">
        <section className="list-pane" aria-label="ニュース一覧">
          {page === null ? (
            <p className="empty">読み込み中…</p>
          ) : visible.length === 0 ? (
            <p className="empty">
              {loadError ?? 'この条件に表示するニュースはありません。'}
            </p>
          ) : (
            <>
              <ul>
                {visible.map((story) => {
                  const isActive = selected?.id === story.id
                  return (
                    <li key={story.id}>
                      <button
                        type="button"
                        className={isActive ? 'row is-active' : 'row'}
                        onClick={() => openStory(story.id)}
                      >
                        {story.imageUrl ? (
                          <img
                            className="row-thumb"
                            src={story.imageUrl}
                            alt=""
                            width={72}
                            height={54}
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none'
                            }}
                          />
                        ) : null}
                        <div className="row-main">
                          <div className="row-meta">
                            <span className="version">v{story.version}</span>
                            <time dateTime={story.publishedAt}>
                              {formatWhen(story.publishedAt)}
                            </time>
                            <span className="category">{story.category}</span>
                          </div>
                          <p className="row-title">{story.title}</p>
                          <p className="row-lead">{story.lead}</p>
                          <div className="row-foot">
                            <span>
                              {story.coverages.length}紙
                              {story.version === 1 ? ' · 初報' : ' · 続報'}
                            </span>
                            <span className="badges">
                              {(story.bodyCount ?? 0) > 0 ? (
                                <span className="badge body">本文あり</span>
                              ) : null}
                              {story.isImportant ? (
                                <span className="badge important">重要</span>
                              ) : null}
                              {story.isNew ? (
                                <span className="badge fresh">新着</span>
                              ) : null}
                            </span>
                          </div>
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

        {selected ? (
          <article className="detail-pane" ref={detailRef}>
            <header className="detail-head">
              <p className="event-title">{selected.eventTitle}</p>
              <h2>{selected.title}</h2>
              <p className="detail-lead">{selected.lead}</p>
              <div className="detail-actions">
                <button
                  type="button"
                  className={
                    selected.bookmarked
                      ? 'bookmark-btn is-active'
                      : 'bookmark-btn'
                  }
                  onClick={toggleBookmark}
                  aria-pressed={!!selected.bookmarked}
                >
                  {selected.bookmarked
                    ? 'ブックマーク済み（削除されません）'
                    : 'ブックマーク'}
                </button>
              </div>
              <ol className="version-rail" aria-label="この出来事の版">
                {related.map((story) => (
                  <li key={story.id}>
                    <button
                      type="button"
                      className={
                        story.id === selected.id
                          ? 'version-chip is-active'
                          : 'version-chip'
                      }
                      onClick={() => openStory(story.id)}
                    >
                      v{story.version}
                      {story.version === 1 ? ' 初報' : ' 続報'}
                    </button>
                  </li>
                ))}
              </ol>
            </header>

            {detailLoading ? (
              <p className="empty">詳細を読み込み中…</p>
            ) : activeOutlet ? (
              <>
                <div className="outlet-bar" role="tablist" aria-label="新聞社">
                  {selected.coverages.map((coverage) => (
                    <button
                      key={coverage.outletId}
                      type="button"
                      role="tab"
                      aria-selected={coverage.outletId === activeOutlet.outletId}
                      className={
                        coverage.outletId === activeOutlet.outletId
                          ? 'outlet is-active'
                          : 'outlet'
                      }
                      onClick={() => setOutletId(coverage.outletId)}
                    >
                      {coverage.outletName}
                      {coverage.body ? (
                        <span className="body-badge">本文あり</span>
                      ) : null}
                    </button>
                  ))}
                </div>

                <div className="kind-bar" role="tablist" aria-label="記事の種類">
                  {(
                    [
                      ['summary', '要約'],
                      ['report', '報道'],
                      ['editorial', '社説'],
                    ] as const
                  ).map(([kind, label]) => (
                    <button
                      key={kind}
                      type="button"
                      role="tab"
                      aria-selected={coverageKind === kind}
                      className={
                        coverageKind === kind ? 'kind is-active' : 'kind'
                      }
                      onClick={() => setCoverageKind(kind)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="paper">
                  <p className="paper-kicker">
                    {activeOutlet.outletName}
                    <time dateTime={activeOutlet.publishedAt}>
                      {formatWhen(activeOutlet.publishedAt)}
                    </time>
                  </p>
                  <h3>{activeOutlet.headline}</h3>
                  {coverageKind === 'editorial' ? (
                    editorialLoading ? (
                      <p className="muted">社説を確認中…</p>
                    ) : activeOutlet.editorial ? (
                      <>
                        <p className="paper-body">{activeOutlet.editorial}</p>
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
                      <p className="muted">社説は確認できませんでした。</p>
                    )
                  ) : coverageKind === 'report' ? (
                    <>
                      {bodyLoading && !activeOutlet.body ? (
                        <p className="muted">本文を取得中…</p>
                      ) : null}
                      <p className="paper-body">
                        {activeOutlet.body ||
                          activeOutlet.report ||
                          activeOutlet.summary ||
                          '（本文の抜粋はありません）'}
                      </p>
                      {!activeOutlet.body ? (
                        <p className="paper-note">
                          本文は取得できなかったため、抜粋のみを表示しています。
                        </p>
                      ) : null}
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
                  ) : (
                    <>
                      <p className="paper-body">
                        {activeOutlet.summary || '（要約はありません）'}
                      </p>
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
              </>
            ) : null}
          </article>
        ) : null}
      </div>
    </div>
  )
}

export default App
