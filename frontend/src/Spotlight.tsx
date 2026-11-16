// スポットライト表示（2026-11-16 ユーザー承認、同日改修）。
// 今開いているビュー（タブ／検索／ウォッチ／ブックマーク）の一覧の上位10件を
// 1件ずつ大きく（新聞の一面のイメージで）表示し、設定した表示時間（既定20秒）
// ごとに次へ進む常駐表示モード。対象が重要タブ固定だった初期版から、
// 「重要は入れ替わりが遅く、同じニュースが流れ続ける」というユーザー指摘で
// 現在のビューの一覧を流す形に変更した（2026-11-16）。
// 社説タブから開いた場合は、各紙の表示も社説中心（社説の見出しと本文）に寄せる。
// ポーリング・全画面とは独立に動く。表示中はマストヘッドを隠し、画面全体を使う。
// 再取得（更新）が完了したら、そのビューの最新の一覧で1件目から流し直し、
// 「更新しました」と短く知らせる（表示中の記事を維持する旧挙動から変更）。
// 表示は必ず1画面に収める（スクロールさせない）。収まらない分は各紙の
// 抜粋を行数クランプで切り落とす（2026-11-16 ユーザー指示）。
// 左上には、いまどのビューの一覧を流しているかを小さく出す（同日追加指示）。
// 停止は表示内の「スポットライトを停止」ボタンだけ（ユーザーの明示指示）:
// マウス移動・他の場所のクリック・キー操作では止めない。
import { useEffect, useRef, useState } from 'react'
import { fetchClusterDetail, fetchTabRows, formatWhen, safeUrl } from './api'
import type { FeedTab, StoryRow } from './types'

/** ローテーション対象は現在のビューの一覧の上位この件数まで */
const TOP_COUNT = 10
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
  sourceTab,
  sourceCategory,
  mutedCategories,
  sourceWatchKeywords,
  sourceLabel,
  rotateMs,
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

  const itemsRef = useRef<StoryRow[]>([])
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

  /** ローテーション対象を現在のビューの最新上位で組み直し、1件目から流し直す。
   *  notify が true のときは「更新しました」の通知も出す（再取得の完了時）。 */
  const rebuild = async (notify: boolean) => {
    try {
      const src = sourceRef.current
      const page = await fetchTabRows(
        src.sourceTab,
        src.sourceCategory,
        0,
        TOP_COUNT,
        src.mutedCategories,
        src.sourceWatchKeywords,
      )
      itemsRef.current = page.rows
      setItems(page.rows)
      slotRef.current = 0
      setSlot(0)
      slotStartRef.current = Date.now()
      slotMsRef.current = rotateMsRef.current
      setProgress(0)
      if (notify) showNotice()
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
