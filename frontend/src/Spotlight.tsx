// スポットライト表示（2026-11-16 ユーザー承認）。
// 重要タブの上位10件を1件ずつ大きく（新聞の一面のイメージで）表示し、
// 20秒ごとに次へ進む常駐表示モード。ポーリング・全画面とは独立に動く。
// 停止は表示内の「スポットライトを停止」ボタンだけ（ユーザーの明示指示）:
// マウス移動・他の場所のクリック・キー操作では止めない。
import { useEffect, useRef, useState } from 'react'
import { fetchClusterDetail, fetchTabRows, formatWhen, safeUrl } from './api'
import type { StoryRow } from './types'

/** 1件あたりの表示時間 */
const ROTATE_MS = 20_000
/** ローテーション対象は重要タブの上位この件数まで */
const TOP_COUNT = 10

interface SpotlightProps {
  /** 一覧の再読み込みが完了するたびに増える世代カウンタ（組み直しの契機） */
  refreshGen: number
  /** 重要タブのミュートカテゴリ（重要タブの取得条件に合わせる） */
  mutedCategories: string[]
  onStop: () => void
}

interface DetailEntry {
  /** 詳細の最新版の行（各紙の RSS 抜粋入り） */
  row: StoryRow
  /** そのクラスタの全版数 */
  versionCount: number
}

export default function Spotlight({
  refreshGen,
  mutedCategories,
  onStop,
}: SpotlightProps) {
  const [items, setItems] = useState<StoryRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [slot, setSlot] = useState(0)
  const [details, setDetails] = useState<Record<number, DetailEntry>>({})
  const [progress, setProgress] = useState(0)

  const itemsRef = useRef<StoryRow[]>([])
  const slotRef = useRef(0)
  const slotStartRef = useRef(0)
  const detailsRef = useRef<Record<number, DetailEntry>>({})
  const requestedRef = useRef<Set<string>>(new Set())
  const lastGenRef = useRef(refreshGen)
  const mutedKey = mutedCategories.join(',')

  const effIndex = items.length > 0 ? slot % items.length : 0
  const current = items[effIndex] ?? null
  const currentDetail = current ? details[current.clusterId] : undefined
  // 詳細が表示中の行（版）に対応している場合だけ使う（版が進んでいたら取り直す）
  const detailRow =
    current && currentDetail && currentDetail.row.id === current.id
      ? currentDetail.row
      : null
  const displayRow = detailRow ?? current
  // 各紙の RSS 抜粋: 抜粋本文があるもの、または記事見出しのみのものを出す。
  // 社説だけの coverage（記事なし）はこの表示の対象外。
  const paperCoverages = (detailRow?.coverages ?? []).filter(
    (c) => c.summary || (c.headline && !c.editorial),
  )

  /** ローテーション対象を重要タブの最新上位で組み直す。
   *  表示中の記事が新しい一覧に残っていれば、そのまま表示し続ける
   *  （位置だけ合わせ、残り時間も維持する）。外れた場合だけ次の表示に移る。 */
  const rebuild = async () => {
    try {
      const page = await fetchTabRows(
        'important',
        'すべて',
        0,
        TOP_COUNT,
        mutedKey ? mutedKey.split(',') : [],
      )
      const next = page.rows
      const curItems = itemsRef.current
      const curIdx = curItems.length > 0 ? slotRef.current % curItems.length : 0
      const curCluster = curItems[curIdx]?.clusterId
      const pos =
        curCluster !== undefined
          ? next.findIndex((r) => r.clusterId === curCluster)
          : -1
      itemsRef.current = next
      setItems(next)
      if (pos >= 0) {
        slotRef.current = pos
        setSlot(pos)
      } else {
        const ni = Math.min(curIdx, Math.max(0, next.length - 1))
        slotRef.current = ni
        setSlot(ni)
        slotStartRef.current = Date.now()
        setProgress(0)
      }
    } catch {
      /* 取得に失敗したら今のローテーションを続ける */
    } finally {
      setLoaded(true)
    }
  }
  const rebuildRef = useRef(rebuild)
  rebuildRef.current = rebuild

  // 初回組み立て
  useEffect(() => {
    void rebuildRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 更新完了（手動更新・ポーリング・背後収集の完了）のたびに組み直す
  useEffect(() => {
    if (refreshGen === lastGenRef.current) return
    lastGenRef.current = refreshGen
    void rebuildRef.current()
  }, [refreshGen])

  // ミュートカテゴリが変わったら組み直す
  const lastMutedRef = useRef(mutedKey)
  useEffect(() => {
    if (mutedKey === lastMutedRef.current) return
    lastMutedRef.current = mutedKey
    void rebuildRef.current()
  }, [mutedKey])

  // 20秒ごとのローテーションとプログレスバー
  useEffect(() => {
    slotStartRef.current = Date.now()
    const timer = setInterval(() => {
      const now = Date.now()
      let elapsed = now - slotStartRef.current
      if (elapsed >= ROTATE_MS) {
        const steps = Math.floor(elapsed / ROTATE_MS)
        slotStartRef.current += steps * ROTATE_MS
        elapsed -= steps * ROTATE_MS
        const ns = slotRef.current + steps
        slotRef.current = ns
        setSlot(ns)
      }
      setProgress(elapsed / ROTATE_MS)
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

  return (
    <div className="spotlight">
      <div className="spotlight-head">
        <div className="spotlight-topbar">
          <span className="spotlight-kicker">スポットライト</span>
          <span className="spotlight-position" aria-label="表示位置">
            {items.length > 0 ? `${effIndex + 1} / ${items.length}` : ''}
          </span>
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
              <div className="spotlight-papers">
                {paperCoverages.map((c) => (
                  <section key={c.outletId} className="spotlight-paper">
                    <p className="spotlight-paper-kicker">
                      <span>{c.outletName}</span>
                      {c.publishedAt ? (
                        <time dateTime={c.publishedAt}>
                          {formatWhen(c.publishedAt)}
                        </time>
                      ) : null}
                    </p>
                    {c.headline ? <h3>{c.headline}</h3> : null}
                    {c.summary ? (
                      <p className="spotlight-paper-summary">{c.summary}</p>
                    ) : null}
                    {safeUrl(c.url) ? (
                      <a
                        className="spotlight-paper-link"
                        href={safeUrl(c.url)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        元記事を読む
                      </a>
                    ) : null}
                  </section>
                ))}
              </div>
            ) : (
              <p className="spotlight-note">各紙の抜粋はまだありません。</p>
            )
          ) : (
            <p className="spotlight-note">各紙の抜粋を読み込み中…</p>
          )}
        </article>
      )}
    </div>
  )
}
