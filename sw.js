/*
 * Service worker справочника: работа без интернета и обновления без застревания кэша.
 *
 * GitHub Pages разрешает браузеру 10 минут держать старую копию (max-age=600) — из-за
 * этого iPhone подолгу показывал прежнюю версию. Поэтому страница и data.js берутся
 * из сети с вопросом к серверу «не изменилось ли?» (cache: no-cache → 304, если нет),
 * и только если сеть молчит дольше NETWORK_TIMEOUT_MS или её нет — из своего кэша.
 * Шрифты, картинки, контакты .vcf не меняются без смены имени — их отдаём из кэша сразу.
 *
 * VERSION менять при каждой выкладке — ВМЕСТЕ с версией в index.html:
 *   node "инструменты/bump-version.cjs"
 * Новая версия = новый кэш; старые кэши удаляются при активации.
 */
const VERSION = "2026.11.23-1";
const CACHE_PREFIX = "aura-";
const CACHE = CACHE_PREFIX + VERSION;
const NETWORK_TIMEOUT_MS = 3000;
const PRECACHE = [
  "./",
  "data.js?v=" + VERSION,
  "manifest.webmanifest",
  "favicon.svg",
  "favicon-32.png",
  "apple-touch-icon.png",
  "icon-192.png",
  "fonts/manrope-400.woff2",
  "fonts/manrope-600.woff2",
  "fonts/manrope-700.woff2",
  "fonts/manrope-800.woff2",
  "fonts/unbounded-500.woff2",
  "fonts/unbounded-700.woff2",
];
const STATIC_FILE = /\.(woff2|png|jpe?g|webp|avif|svg|vcf|webmanifest)$/i;
const MATCH = { ignoreVary: true };

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate" || url.pathname.endsWith("/data.js")) event.respondWith(networkFirst(event));
  else if (STATIC_FILE.test(url.pathname)) event.respondWith(cacheFirst(event));
});

// Страница сама присылает список того, что успела загрузить до появления service worker
// (картинку дома нужного формата и размера) — кладём это в кэш для захода без сети.
self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "warm" || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.filter((u) => {
    const url = new URL(u, self.location.href);
    return url.origin === self.location.origin && STATIC_FILE.test(url.pathname);
  });
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.all(urls.map((u) =>
    cache.match(u, MATCH).then((hit) => hit || cache.add(u)).catch(() => null)))));
});

function networkFirst(event) {
  const req = event.request;
  let stored = Promise.resolve();
  const network = fresh(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      stored = caches.open(CACHE).then((cache) => cache.put(req, copy));
    }
    return res;
  });
  event.waitUntil(network.then(() => stored, () => null));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (res) => { if (!settled && res) { settled = true; resolve(res); } };
    const timer = setTimeout(() => fromCache(req).then(finish), NETWORK_TIMEOUT_MS);
    network.then(
      async (res) => { clearTimeout(timer); finish(res.ok ? res : (await fromCache(req)) || res); },
      async (err) => {
        clearTimeout(timer);
        const cached = await fromCache(req);
        if (cached) finish(cached);
        else if (!settled) { settled = true; reject(err); }
      },
    );
  });
}

// Мимо HTTP-кэша браузера: сервер ответит 304, если файл не менялся, — это дёшево.
function fresh(req) {
  const request = req.mode === "navigate"
    ? new Request(req.url, { credentials: "same-origin", cache: "no-cache" })
    : new Request(req, { cache: "no-cache" });
  return fetch(request).then((res) => (res.redirected ? withoutRedirect(res) : res));
}

// Ответ после перенаправления (/aura → /aura/) браузер не примет как ответ на переход по ссылке.
async function withoutRedirect(res) {
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function fromCache(req) {
  const hit = (await caches.match(req, MATCH)) || (await caches.match(req, { ...MATCH, ignoreSearch: true }));
  if (hit || req.mode !== "navigate") return hit;
  const scope = new URL(self.registration.scope);
  const path = new URL(req.url).pathname;
  return path === scope.pathname || path === scope.pathname + "index.html" ? caches.match("./", MATCH) : undefined;
}

async function cacheFirst(event) {
  const req = event.request;
  const hit = await caches.match(req, MATCH);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === "basic") {
    const copy = res.clone();
    event.waitUntil(caches.open(CACHE).then((cache) => cache.put(req, copy)));
  }
  return res;
}
