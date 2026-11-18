interface PollingControlsProps {
  polling: boolean
  pollMinutes: number
  pollIntervals: readonly number[]
  applyPolling: (enabled: boolean, minutes: number) => Promise<void>
}

/**
 * マストヘッドのポーリング操作部（スイッチ＋間隔セグメント）。
 * 状態とサーバー同期はすべて App 側に残し、props 経由で受け取る。
 * ここに移したのは .util-set の表示だけで、同期や収集完了の検知は App が担う。
 */
export default function PollingControls(props: PollingControlsProps) {
  const { polling, pollMinutes, pollIntervals, applyPolling } = props
  return (
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
          {pollIntervals.map((m) => (
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
  )
}
