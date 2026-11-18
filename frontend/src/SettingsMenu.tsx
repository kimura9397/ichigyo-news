import {
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react'
import type { DensitySetting, FontSizeSetting, ThemePreset } from './App'

interface SettingsMenuProps {
  menuOpen: boolean
  setMenuOpen: Dispatch<SetStateAction<boolean>>
  fontSize: FontSizeSetting
  setFontSize: Dispatch<SetStateAction<FontSizeSetting>>
  density: DensitySetting
  setDensity: Dispatch<SetStateAction<DensitySetting>>
  spotlightSeconds: number
  setSpotlightSeconds: Dispatch<SetStateAction<number>>
  spotlightSecondsOptions: readonly number[]
  themePreset: ThemePreset
  setThemePreset: Dispatch<SetStateAction<ThemePreset>>
  themePresets: readonly {
    id: ThemePreset
    label: string
    title: string
    color: string
  }[]
  dimRead: boolean
  setDimRead: Dispatch<SetStateAction<boolean>>
  categoryOrder: readonly string[]
  mutedCategories: string[]
  toggleMuteCategory: (cat: string) => void
  keywords: string[]
  keywordInput: string
  setKeywordInput: Dispatch<SetStateAction<string>>
  addKeyword: (raw: string) => Promise<boolean>
  removeKeyword: (kw: string) => void
  dbBytes: number | null
  formatBytes: (bytes: number) => string
  maintaining: boolean
  setConfirmingMaintenance: Dispatch<SetStateAction<boolean>>
}

/**
 * 設定メニュー（ハンバーガー）。状態はすべて App 側に残し、props 経由で受け取る。
 * ここに移したのは .menu-wrap（ボタン＋パネル）と、外側クリック／Esc で閉じる処理だけ。
 */
export default function SettingsMenu(props: SettingsMenuProps) {
  const {
    menuOpen,
    setMenuOpen,
    fontSize,
    setFontSize,
    density,
    setDensity,
    spotlightSeconds,
    setSpotlightSeconds,
    spotlightSecondsOptions,
    themePreset,
    setThemePreset,
    themePresets,
    dimRead,
    setDimRead,
    categoryOrder,
    mutedCategories,
    toggleMuteCategory,
    keywords,
    keywordInput,
    setKeywordInput,
    addKeyword,
    removeKeyword,
    dbBytes,
    formatBytes,
    maintaining,
    setConfirmingMaintenance,
  } = props
  const menuRef = useRef<HTMLDivElement | null>(null)

  // 設定メニューは外側クリックと Esc で閉じる
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  return (
            <div className="menu-wrap" ref={menuRef}>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title="設定"
                aria-label="設定メニューを開く"
              >
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
              {menuOpen ? (
                <div className="menu-panel" role="menu" aria-label="設定">
                  <section className="menu-section">
                    <h3>表示</h3>
                    <div className="menu-row is-stack">
                      <span className="menu-label">文字の大きさ</span>
                      <div
                        className="segmented"
                        role="group"
                        aria-label="文字の大きさ"
                      >
                        {(
                          [
                            ['small', '小'],
                            ['medium', '中'],
                            ['large', '大'],
                          ] as const
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            className={
                              fontSize === value ? 'seg is-active' : 'seg'
                            }
                            onClick={() => setFontSize(value)}
                            aria-pressed={fontSize === value}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="menu-row is-stack">
                      <span className="menu-label">一覧の密度</span>
                      <div
                        className="segmented"
                        role="group"
                        aria-label="一覧の密度"
                      >
                        {(
                          [
                            ['standard', '標準'],
                            ['compact', 'コンパクト'],
                          ] as const
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            className={
                              density === value ? 'seg is-active' : 'seg'
                            }
                            onClick={() => setDensity(value)}
                            aria-pressed={density === value}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="menu-row is-stack">
                      <span className="menu-label">
                        スポットライトの表示時間
                      </span>
                      <div
                        className="segmented"
                        role="group"
                        aria-label="スポットライトで1件を表示する時間"
                      >
                        {spotlightSecondsOptions.map((s) => (
                          <button
                            key={s}
                            type="button"
                            className={
                              spotlightSeconds === s ? 'seg is-active' : 'seg'
                            }
                            onClick={() => setSpotlightSeconds(s)}
                            aria-pressed={spotlightSeconds === s}
                          >
                            {s}秒
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="menu-row is-stack">
                      <span className="menu-label">テーマ</span>
                      <div
                        className="preset-swatches"
                        role="group"
                        aria-label="テーマ"
                      >
                        {themePresets.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            className={
                              themePreset === p.id
                                ? 'preset-swatch is-active'
                                : 'preset-swatch'
                            }
                            onClick={() => setThemePreset(p.id)}
                            aria-pressed={themePreset === p.id}
                            title={p.title}
                          >
                            <span
                              className="preset-dot"
                              style={{ background: p.color }}
                            />
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="menu-row">
                      <span className="menu-label">
                        読んだニュースを薄く表示
                      </span>
                      <button
                        type="button"
                        className="switch"
                        role="switch"
                        aria-checked={dimRead}
                        onClick={() => setDimRead((v) => !v)}
                        aria-label="詳細を開いたニュースの行を薄く表示する"
                      >
                        <span className="switch-track">
                          <span className="switch-thumb" />
                        </span>
                      </button>
                    </div>
                  </section>
                  <section className="menu-section">
                    <h3>重要タブに出さないカテゴリ</h3>
                    <p className="menu-note">
                      オンにしたカテゴリは重要タブに表示されません。新着・すべて・社説タブには影響しません。
                    </p>
                    {categoryOrder.map((c) => (
                      <div className="menu-row" key={c}>
                        <span className="menu-label">{c}</span>
                        <button
                          type="button"
                          className="switch"
                          role="switch"
                          aria-checked={mutedCategories.includes(c)}
                          onClick={() => toggleMuteCategory(c)}
                          aria-label={`${c}を重要タブに出さない`}
                        >
                          <span className="switch-track">
                            <span className="switch-thumb" />
                          </span>
                        </button>
                      </div>
                    ))}
                  </section>
                  <section className="menu-section">
                    <h3>キーワードウォッチ</h3>
                    <p className="menu-note">
                      登録したキーワードを含むニュースだけを、タブ行のキーワードボタンから見られます。一致は見出しと要約が対象で、表記ゆれ（漏洩／漏えい等）も吸収します。キーワードはサーバーに保存され、更新のたびにそのキーワードのニュースも自動で集めます。登録したキーワードは、収集のために更新のたび Google ニュース検索に送信されます。
                    </p>
                    <form
                      className="kw-form"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void (async () => {
                          if (await addKeyword(keywordInput)) setKeywordInput('')
                        })()
                      }}
                    >
                      <input
                        className="kw-input"
                        type="text"
                        value={keywordInput}
                        onChange={(e) => setKeywordInput(e.target.value)}
                        placeholder="例: 今田美桜"
                        aria-label="登録するキーワード"
                        maxLength={50}
                      />
                      <button type="submit" className="kw-add">
                        追加
                      </button>
                    </form>
                    {keywords.length > 0 ? (
                      <ul className="kw-list">
                        {keywords.map((k) => (
                          <li key={k} className="kw-item">
                            <span>{k}</span>
                            <button
                              type="button"
                              className="kw-remove"
                              onClick={() => removeKeyword(k)}
                              aria-label={`「${k}」をキーワードから削除`}
                            >
                              削除
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="menu-note">まだ登録されていません。</p>
                    )}
                  </section>
                  <section className="menu-section">
                    <h3>データの管理</h3>
                    <div className="menu-row">
                      <span className="menu-label">データベース容量</span>
                      <span className="menu-value">
                        {dbBytes !== null ? formatBytes(dbBytes) : '—'}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="menu-action-btn"
                      onClick={() => {
                        setMenuOpen(false)
                        setConfirmingMaintenance(true)
                      }}
                      disabled={maintaining}
                    >
                      古いデータを削除してDBを圧縮
                    </button>
                    <p className="menu-note">
                      7日より前のニュース（ブックマークしたものを除く）を削除します。実行前に確認ダイアログが出ます。
                    </p>
                  </section>
                </div>
              ) : null}
            </div>
  )
}
