const CACHE = 'invest-tracker-v19';   // v18: 저장된 사본으로 먼저 열고 뒤에서 새 파일을 받는다 (2026-09-29)
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './initial_data.js',
  './icon-192.png',
  './icon-512.png',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/hammerjs@2.0.8/hammer.min.js',
  'https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js',
  'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js',
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
      // 이 앱의 옛 캐시만 지운다 (웹앱들이 github.io 한 주소를 나눠 써서 캐시 저장소가 하나다)
      Promise.all(keys.filter(k => k.startsWith('invest-tracker-') && k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 앱 파일·라이브러리는 저장된 사본을 바로 돌려주고, 뒤에서 새 파일을 받아 캐시를 바꿔 둔다.
// 그전엔 네트워크 우선이라 열 때마다 파일 아홉 개의 응답을 기다렸다 (2026-09-29 — 처음 열 때 느림).
// ⚠ 그래서 앱을 고친 뒤 **첫 실행은 옛 화면, 두 번째 실행부터 새 화면**이다.
// Firestore 통신(firestore.googleapis.com)은 건드리지 않는다
const HOSTS = [self.location.host, 'www.gstatic.com', 'cdn.jsdelivr.net'];
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!HOSTS.includes(url.host)) return;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: url.host === self.location.host });
      const fresh = fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      });
      if (cached) { e.waitUntil(fresh.catch(() => {})); return cached; }
      return fresh;
    })
  );
});
