interface WatchBarProps {
  keywords: string[]
  watchKeyword: string | null
  selectWatchKeyword: (kw: string | null) => void
}

/**
 * キーワードウォッチビューの上部バー（「すべて」＋キーワードごとのチップ）。
 * 状態と選択時の処理はすべて App 側に残し、props 経由で受け取る。
 * ここに移したのは .watch-bar の表示だけ。キーワードの登録・削除は設定メニュー側。
 */
export default function WatchBar(props: WatchBarProps) {
  const { keywords, watchKeyword, selectWatchKeyword } = props
  return (
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
  )
}
