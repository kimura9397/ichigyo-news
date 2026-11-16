// 実データの媒体は多様なため、OutletId は固定unionではなく文字列に緩めている。
// 主要媒体は api.ts の正規化マップで 'asahi' などのIDに寄せ、それ以外は媒体名そのままをIDにする。
export type OutletId = string

export type CoverageKind = 'summary' | 'editorial'

export interface OutletCoverage {
  outletId: OutletId
  outletName: string
  headline: string
  publishedAt: string
  /** RSS 抜粋: RSS要約の先頭部分を整形したもの */
  summary: string
  /** 元記事URL（「元記事を読む」リンクになる） */
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
  /** その版が作られた日時（詳細ヘッダの版メタ表示用） */
  versionCreatedAt: string
  title: string
  lead: string
  publishedAt: string
  category: string
  isImportant: boolean
  isNew: boolean
  coverages: OutletCoverage[]
  /** 詳細APIで coverages を実データに差し替え済みか */
  detailLoaded?: boolean
  /** ブックマーク済みか（ブックマークしたニュースは保持期間の削除から免除される） */
  bookmarked?: boolean
  /** 社説が確認できた媒体名（短い名前、紙の並び順）。社説タブの行表示用 */
  editorialPapers?: string[]
  /** 詳細を開いたことがある（既読）クラスタか。一覧の薄表示に使う */
  read?: boolean
}

export type FeedTab =
  | 'important'
  | 'fresh'
  | 'all'
  | 'editorials'
  | 'bookmarks'
  | 'watch'
  | 'search'
