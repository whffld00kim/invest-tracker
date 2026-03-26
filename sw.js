const CACHE = 'invest-tracker-v4';
const ASSETS = [
  './index.html',
  './manifest.json',
  './initial_data.js',
  './icon-192.png',
  './icon-512.png',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/hammerjs@2.0.8/hammer.min.js',
  'https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js',
];

// 설치 시 모든 리소스 캐시
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// 오래된 캐시 정리
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// HTML/JS 파일은 네트워크 우선 (항상 최신 파일), 나머지는 캐시 우선
self.addEventListener('fetch', e => {
  const url = e.request.url;
  const isAppFile = url.endsWith('.html') || url.endsWith('.js');
  if (isAppFile) {
    // 네트워크 우선: 최신 파일 fetch, 실패 시 캐시 fallback
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    // CDN 라이브러리 등은 캐시 우선 (오프라인 지원)
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});
