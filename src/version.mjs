// 現行バージョンの正は package.json の version（RELEASING.md の方針で
// リリースタグと揃える）。JSON import で取り込むのは、SEA ビルド
// （esbuild のバンドル）でも値が埋め込まれ、exe 単体で動くため。
import pkg from '../package.json' with { type: 'json' };

export const APP_VERSION = pkg.version;
