import {
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from 'react'

interface PaneDividerProps {
  paneDragging: boolean
  paneRatio: number
  paneRatioDefault: number
  setPaneDragging: Dispatch<SetStateAction<boolean>>
  setPaneRatio: Dispatch<SetStateAction<number>>
  handleDividerPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  handleDividerPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
  handleDividerKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void
}

/**
 * 一覧と詳細の境界（幅調整ハンドル）。
 * 比率の状態・保存・クランプとドラッグ／キーボードの処理はすべて App 側に
 * 残し、props 経由で受け取る。ここに移したのは .pane-divider の表示だけ。
 */
export default function PaneDivider(props: PaneDividerProps) {
  const {
    paneDragging,
    paneRatio,
    paneRatioDefault,
    setPaneDragging,
    setPaneRatio,
    handleDividerPointerDown,
    handleDividerPointerMove,
    handleDividerKeyDown,
  } = props
  return (
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
      onDoubleClick={() => setPaneRatio(paneRatioDefault)}
      onKeyDown={handleDividerKeyDown}
    />
  )
}
