import type { Dispatch, RefObject, SetStateAction } from 'react'
import { formatWhen } from './api'
import type { CoverageKind, OutletCoverage, StoryRow } from './types'

interface StoryDetailPaneProps {
  selected: StoryRow
  detailRef: RefObject<HTMLElement | null>
  versionRailRef: RefObject<HTMLOListElement | null>
  goToListPane: () => void
  toggleBookmark: () => Promise<void>
  related: StoryRow[]
  openStory: (id: string) => void
  detailLoading: boolean
  visibleCoverages: OutletCoverage[]
  activeOutlet: OutletCoverage | undefined
  setOutletId: Dispatch<SetStateAction<string | null>>
  visibleKinds: readonly (readonly [CoverageKind, string])[]
  effectiveKind: CoverageKind
  setCoverageKind: Dispatch<SetStateAction<CoverageKind>>
  editorialLoading: boolean
  editorialOutlets: OutletCoverage[]
}

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

/**
 * 詳細ペイン（見出し＋版レール＋各紙バー＋種別バー＋紙面カード）。
 * 状態と詳細・社説の取得ロジックはすべて App 側に残し、props 経由で受け取る。
 * ここに移したのは .detail-pane の表示だけ。selected が無いときの出し分けは
 * App 側に残る。
 */
export default function StoryDetailPane(props: StoryDetailPaneProps) {
  const {
    selected,
    detailRef,
    versionRailRef,
    goToListPane,
    toggleBookmark,
    related,
    openStory,
    detailLoading,
    visibleCoverages,
    activeOutlet,
    setOutletId,
    visibleKinds,
    effectiveKind,
    setCoverageKind,
    editorialLoading,
    editorialOutlets,
  } = props
  return (
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
  )
}
