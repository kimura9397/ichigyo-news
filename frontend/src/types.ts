// 実データの媒体は多様なため、OutletId は固定unionではなく文字列に緩めている。
// 主要媒体は api.ts の正規化マップで 'asahi' などのIDに寄せ、それ以外は媒体名そのままをIDにする。
export type OutletId = string

export type CoverageKind = 'report' | 'summary' | 'editorial'

export interface OutletCoverage {
  outletId: OutletId
  outletName: string
  headline: string
  publishedAt: string
  /** 報道: 抽出文の全文（本文が取れている場合は body が優先表示される） */
  report: string
  /** 記事ページから抽出した本文（取れた場合のみ） */
  body?: string
  /** 要約: 抽出文の先頭部分 */
  summary: string
  /** 元記事URL（報道・要約タブで「元記事を読む」リンクになる） */
  url?: string
  /** 社説（クラスタ単位・版共通）。確認できた紙だけ入る */
  editorial?: string
  editorialTitle?: string
  editorialUrl?: string
}

export interface StoryRow {
  id: string
  eventId: string
  /** バックエンドのクラスタID（詳細APIのキー） */
  clusterId: number
  eventTitle: string
  version: number
  title: string
  lead: string
  publishedAt: string
  category: string
  isImportant: boolean
  isNew: boolean
  coverages: OutletCoverage[]
  /** この版の代表サムネイル画像URL（あれば一覧の左側に表示。URL参照のみで保存はしない） */
  imageUrl?: string
  /** 本文が取れている記事の数（この版） */
  bodyCount?: number
  /** 本文の合計文字数（この版） */
  bodyChars?: number
  /** 詳細APIで coverages を実データに差し替え済みか */
  detailLoaded?: boolean
  /** ブックマーク済みか（ブックマークしたニュースは保持期間の削除から免除される） */
  bookmarked?: boolean
}

export type FeedTab = 'important' | 'fresh' | 'all' | 'bookmarks'
