// Service worker: precache the whole app so it works offline after first load.
//
// Update model: a new version installs into its own cache and then WAITS.
// Pages opened from the old version keep working from the old cache. The
// page shows "Update ready" when a worker is waiting; tapping it posts
// 'skip-waiting', the new worker activates, deletes the old speeder cache,
// and the page reloads on controllerchange.
//
// Sounds, icons and media are cache-first. Code files are
// stale-while-revalidate within a version, so a config tweak without a
// version bump still arrives on the next online open; the page asks with
// 'check-update' once it is listening.
const VERSION = '0.1.0';
const CACHE = `speeder-${VERSION}`;
const PRECACHE = [
  './',
  './app.css',
  './app.js',
  './audio.js',
  './config.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon.svg',
  './index.html',
  './manifest.webmanifest',
  './motion.js',
  './sensors.js',
  './silence.m4a',
  './sounds/brake-1.m4a',
  './sounds/brake-2.m4a',
  './sounds/drone.m4a',
  './sounds/whoosh-1.m4a',
  './sounds/whoosh-2.m4a',
  './store.js',
  './ui.js',
  './wake.mp4',
];
const CACHE_FIRST = /\.(m4a|mp4|png|svg)$/;
let updatePending = false;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('speeder-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
  if (event.data?.type === 'check-update' && updatePending) event.source?.postMessage({ type: 'update-ready' });
});

async function notifyUpdate() {
  updatePending = true;
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const c of clients) c.postMessage({ type: 'update-ready' });
}

function sameBody(a, b) {
  const tag = (r) => r.headers.get('etag') || r.headers.get('last-modified') || r.headers.get('content-length');
  return tag(a) != null && tag(a) === tag(b);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (CACHE_FIRST.test(req.url)) {
      if (cached) return cached;
      const fresh = await fetch(req);
      if (fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    }
    const revalidate = fetch(req).then(async (fresh) => {
      if (!fresh.ok) return fresh;
      if (cached && !sameBody(cached, fresh)) notifyUpdate();
      await cache.put(req, fresh.clone());
      return fresh;
    }).catch(() => null);
    if (cached) { event.waitUntil(revalidate); return cached; }
    return (await revalidate) || new Response('offline', { status: 503 });
  })());
});
