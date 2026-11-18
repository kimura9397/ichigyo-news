import { formatWhen, type StoriesPage } from './api'
import type { DensitySetting, ListPage } from './App'
import type { FeedTab, StoryRow } from './types'

interface StoryListPaneProps {
  density: DensitySetting
  acknowledgeNew: () => void
  page: ListPage | null
  visible: StoryRow[]
  loadError: string | null
  tab: FeedTab
  searchQuery: string
  keywords: string[]
  watchKeyword: string | null
  selected: StoryRow | null
  highlightClusters: ReadonlySet<number>
  dimRead: boolean
  readClusters: ReadonlySet<number>
  openStory: (id: string) => void
  hasMore: boolean
  category: string
  loadPage: (
    target: FeedTab,
    cat: string,
    offset: number,
    append: boolean,
  ) => Promise<StoriesPage | null>
}

/**
 * 一覧ペイン（行リスト＋空状態＋「もっと見る」）。
 * 状態と取得・選択のロジックはすべて App 側に残し、props 経由で受け取る。
 * ここに移したのは .list-pane の表示だけ。
 */
export default function StoryListPane(props: StoryListPaneProps) {
  const {
    density,
    acknowledgeNew,
    page,
    visible,
    loadError,
    tab,
    searchQuery,
    keywords,
    watchKeyword,
    selected,
    highlightClusters,
    dimRead,
    readClusters,
    openStory,
    hasMore,
    category,
    loadPage,
  } = props
  return (
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
  )
}
