// Service Worker v4: 画面（HTML）は network-first、その他の静的ファイルはキャッシュ優先。
// キャッシュ対象は同一オリジンの静的ファイルだけに限る（2026-11-16 コンプライアンス対応 #6）。
// 外部オリジンの応答（媒体の画像など）は保存しない。ニュースデータ（/api/）もキャッシュしない。
// 旧バージョンのキャッシュは activate で削除する。
const CACHE = 'ichigyo-news-shell-v2';
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(['/manifest.webmanifest', '/favicon.svg']))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // 外部オリジンは素通り（キャッシュしない）
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return; // APIは常にネットワーク
  const isDocument =
    e.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');
  if (isDocument) {
    // network-first: 再ビルド後に古い画面が出ないようにする
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request)),
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        }),
    ),
  );
});
