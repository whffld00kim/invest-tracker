const CACHE = 'invest-tracker-v35';   // v35: 2026-11-27 에이피알/삼성전자·에이피알/하이닉스 비율 뺌 —   // v34: 2026-11-25 그래프 탭 보완(점 표시·곧은 선·보이는 구간과 변화·값 창·이전/다음 지표·축 눈금·태블릿 목록) —   // v33: 2026-11-25 표 탭 지표 이름을 누르면 그 지표 그래프로 —   // v32: 2026-11-24 탭만 가로 설정 파일(manifest-tab.json) —   // v31: 화면 방향 natural(폰 세로·태블릿 가로, 2026-11-20) —   // v30: 점검 수정 — 라이브러리를 앱과 함께 배포(vendor/), 기본 자료 파일 뺌 (2026-11-14)
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './manifest-tab.json',
  './icons/app-any-192.png',
  './icons/app-maskable-512.png',
  './vendor/chart.umd.js',
  './vendor/hammer.min.js',
  './vendor/chartjs-plugin-zoom.min.js',
  './vendor/Sortable.min.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js',
];

// 옛 주소(github.io)에서는 이 서비스워커가 일을 접는다 (2026-11-14 — index.html 맨 위 스크립트가 새 주소로 넘긴다).
// 옛 판이 깔려 있던 기기가 이 파일을 새로 받으면: 이 앱의 캐시를 지우고 → 등록을 풀고 → 열려 있는 창을 다시 불러온다.
// 다시 불러온 index.html 이 새 주소로 넘긴다. 옛 판 화면에는 스스로 새로고침하는 코드가 없어서, 여기서 다시 불러 주지
// 않으면 두 번째로 열 때에야 넘어간다(그 길도 그대로 된다 — 캐시가 없어 새 index.html 을 받는다)
const RETIRED = /(^|\.)github\.io$/.test(self.location.hostname);

// 설치 시 모든 리소스 캐시
self.addEventListener('install', e => {
  if (!RETIRED) {
    e.waitUntil(
      caches.open(CACHE).then(cache => cache.addAll(ASSETS))
    );
  }
  self.skipWaiting();
});

// 오래된 캐시 정리
self.addEventListener('activate', e => {
  if (RETIRED) {
    e.waitUntil((async () => {
      // 이 앱의 캐시만 지운다 (웹앱들이 github.io 한 주소를 나눠 써서 캐시 저장소가 하나다)
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k.startsWith('invest-tracker-')).map(k => caches.delete(k)));
      await self.clients.claim();
      const wins = await self.clients.matchAll({ type: 'window' });
      await self.registration.unregister();
      // 다시 부르는 것은 창마다 한 번뿐이다 — 주소에 moved= 가 이미 붙어 있으면 그만둔다. 다시 받은 index.html 이 아직 옛 판이면
      // (배포가 퍼지는 몇 분 사이, 또는 방금 받아 둔 사본) 그 화면이 이 서비스워커를 또 등록해 끝없이 새로고침하게 된다.
      // moved= 는 주소를 바꿔 브라우저가 간직한 옛 index.html 사본을 비켜 가는 구실도 한다
      wins.forEach(c => {
        if (/[?&]moved=/.test(c.url)) return;
        try { c.navigate(c.url + (c.url.indexOf('?') < 0 ? '?' : '&') + 'moved=' + Date.now()).catch(() => {}); } catch (err) {}
      });
    })());
    return;
  }
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
// Firestore 통신(firestore.googleapis.com)은 건드리지 않는다.
// 2026-11-14: 내용을 볼 수 없는 응답(opaque)은 저장하지 않는다 — 오류 응답인지 가릴 수 없고, 하나에 저장 공간을 7MB 씩 잡았다.
// 그래프 라이브러리는 이제 같은 주소(vendor/)에서 오고, Firebase(gstatic)는 앱이 CORS 로 부른다
const HOSTS = [self.location.host, 'www.gstatic.com'];
self.addEventListener('fetch', e => {
  if (RETIRED) return;   // 옛 주소: 아무것도 저장하지 않고 그대로 통신에 맡긴다
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!HOSTS.includes(url.host)) return;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: url.host === self.location.host });
      const fresh = fetch(req).then(res => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      });
      if (cached) { e.waitUntil(fresh.catch(() => {})); return cached; }
      return fresh;
    })
  );
});
