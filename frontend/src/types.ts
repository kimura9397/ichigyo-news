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
  /**
   * 記者署名（バイライン）。署名が取れた記事がある場合のみ入る。
   * source はDB上の媒体名で、「この記者の他の記事」の絞り込み（媒体＋同名）に使う。
   * 記者の傾向の自動判定はしない（並べて読むのは利用者自身）。
   */
  bylines?: { name: string; source: string }[]
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
  | 'reporter'
