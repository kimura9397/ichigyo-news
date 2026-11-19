import { useState } from 'react'
import { formatWhen, type UpdateInfo } from './api'

interface UpdateNoticeProps {
  update: UpdateInfo
}

/**
 * 更新通知（Issue #26、表示形式は Issue #51 で変更）: 新しい版がある時だけ
 * マストヘッドに「vX.Y.Z があります」とテキストで出す。版番号は朱
 * （--vermillion、テーマ連動）の太字、それ以外は muted。
 * マウスオーバー（またはフォーカス）でパネルが開き、リリースノートをその中で
 * 読める。クリックでリリースページを開く（開くのは利用者がクリックした時
 * だけ。自動でページへ飛ばすことはしない）。
 * 表示条件（新しい版がある時だけ出す）はサーバー側で判定済みで、ここは
 * 渡された update を出すだけ。
 */
export default function UpdateNotice({ update }: UpdateNoticeProps) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className="update-notice"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <a
        className="update-link"
        href={update.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`新しいバージョン ${update.version} があります。リリースページを開く`}
        title={`新しいバージョン ${update.version} があります`}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <span className="update-link-version">v{update.version}</span> があります
      </a>
      {open ? (
        <div className="update-panel">
          <p className="update-panel-title">
            新しいバージョン {update.version} があります
            {update.publishedAt ? (
              <span className="update-panel-date">
                {formatWhen(update.publishedAt)} 公開
              </span>
            ) : null}
          </p>
          {update.notes ? (
            <div className="update-panel-notes">{update.notes}</div>
          ) : null}
          <p className="update-panel-foot">クリックするとリリースページを開きます</p>
        </div>
      ) : null}
    </div>
  )
}
