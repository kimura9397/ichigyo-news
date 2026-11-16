# バージョニングとリリースの方針

## バージョンの付け方（SemVer）

バージョンは Semantic Versioning（SemVer）に従い、`vMAJOR.MINOR.PATCH` の形で付けます。タグ名は `v0.1.0` のように `v` を頭に付けます。`package.json` の `version` も同じ番号に揃えます。

- MAJOR: 使い方が根本から変わる変更（データ形式の互換を切る、起動方法が変わる、など）。1.0.0 までは 0 のまま進めます。
- MINOR: 機能の追加（新しいタブ、ビュー、設定項目、収集まわりの改善など）。
- PATCH: バグ修正と小さな是正のみ。

0.x の間は開発版という位置づけで、MINOR の桁で多少の仕様変更を含むことがあります。安定して人に勧められる状態になった時点で 1.0.0 に上げます。

## 初の公開リリース

初の公開リリースは **v0.1.0** とします。2026-11-15 時点の main（タブは重要／新着／社説、版管理、キーワード収集、ポーリング、設定メニューまでが入った状態）を公開の起点とするためです。以後のリリースはこの文書の方針で積みます。

## リリースの手順

1. リリースする変更が全て `main` にマージされ、`npm test` が通過していることを確認する。
2. `package.json` の `version` を新しい番号に上げる（タグと一致させる）。この変更もブランチ経由で main に入れる。
3. `main` の先端コミットにタグ `vX.Y.Z` を打つ。タグは main の先端にだけ打ち、過去のコミットへ後から付けることはしません。
4. GitHub Release をタグから作り、リリースノートを書く。

## 配布物（exe）のビルドと添付

Windows 向けの単一 exe は Node.js の SEA（Single Executable Applications）で作ります。

1. 前提として `npm install` しておく（esbuild と postject が要りますが、どちらもビルド時だけの依存です）。
2. `npm run build:sea -- --target win32,linux` で `dist/sea/` に生成します。サーバー一式を esbuild で単一ファイルにバンドルし、`public/` を SEA の assets に埋め込んで、Node バイナリへ注入します。Windows  exe は nodejs.org の公式 node.exe（v24 系 LTS）に注入して作るため、ビルド環境が Windows でなくても生成できます。サイズの実測は Windows 版が約90MB、Linux 版が約121MB です。
3. blob の生成に使った Node と、注入先バイナリは同じメジャーライン（v24）に揃えます。ずらすと SEA の形式が合わず起動しないことがあります。
4. タグから作った GitHub Release に `ichigyo-news-win32-x64.exe` を添付します。リリースノートには、未署名のため SmartScreen の警告が出ることと、「詳細情報」→「実行」の進み方を必ず書きます（README の配布節と同じ案内）。あわせて、添付した exe の SHA-256 ハッシュをリリースノートに必ず含めます（利用者がダウンロードしたファイルを照合できるようにするため）。
5. exe 実行時のデータ保存先は `%APPDATA%\ichigyo-news\`（環境変数 `ICHIGYO_DATA_DIR` で変更可）です。Node.js 版の `data/news.db` とは分けてあります。

## リリースノートの書き方

リリースノートは短く書きます。機能の箇条書きで埋めず、その版で何が変わり、使う人にとって何がどうなるかを数行で書きます。制限や既知の問題があればごまかさずに添えます。文体の考え方は README と同じです（OSS_CHECKLIST.md の7節）。

## この環境でのタグ／Release 作成について

Muse の作業環境からは SSH が使えないため、タグと Release は GitHub API で作ります。タグは Git Data API で `main` の先端（リモート側の SHA）に対して作ります（ローカルの SHA とは一致しないため、リモートの先端を取得してから打つのが手順です）。push の仕組み自体は [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

なお、Release への exe 添付（アセットのアップロード）は uploads.github.com 宛ての通信で、この環境のコネクタ登録ホスト（api.github.com のみ）の対象外のため、API 経由では 401（Bad credentials）になります（2026-11-16 の v0.1.0 で確認）。当面の添付は GitHub の画面から exe をアップロードする形になります。コネクタの登録ホストに uploads.github.com を追加できれば API 経由でも添付できます。
