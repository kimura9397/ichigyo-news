import {
  type Dispatch,
  type FormEvent as ReactFormEvent,
  type SetStateAction,
} from 'react'

interface SearchBarProps {
  searchInput: string
  setSearchInput: Dispatch<SetStateAction<string>>
  submitSearch: (e: ReactFormEvent) => void
  searchQuery: string
  keywords: string[]
  registerSearchKeyword: () => Promise<void>
}

/**
 * キーワード検索ビューの上部バー（入力フォーム＋検索語のキーワード登録ボタン）。
 * 状態と検索・登録のロジックはすべて App 側に残し、props 経由で受け取る。
 * ここに移したのは .search-bar の表示だけ。
 */
export default function SearchBar(props: SearchBarProps) {
  const {
    searchInput,
    setSearchInput,
    submitSearch,
    searchQuery,
    keywords,
    registerSearchKeyword,
  } = props
  return (
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
  )
}
