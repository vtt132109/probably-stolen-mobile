/* BUILD is injected by package-web.mjs. This worker never opens or deletes save databases. */
const SCOPE = self.registration.scope;
const PREFIX = 'probably-stolen:' + SCOPE + ':';
const CACHE = PREFIX + BUILD.version;
const assets = new Map(BUILD.files.map(file => [new URL(file.url, SCOPE).href, file]));
const required = BUILD.files.filter(file => file.required);
let download = null;

async function status() {
  const cache = await caches.open(CACHE);
  let present = 0;
  for (const file of required) if (await cache.match(new URL(file.url, SCOPE).href)) present++;
  return { type: 'OFFLINE_STATUS', version: BUILD.version, ready: present === required.length,
    present, total: required.length, bytes: BUILD.requiredTransferBytes };
}

async function verifiedFetch(url, file) {
  const response = await fetch(url, { integrity: file.integrity, cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok || response.type === 'opaque') throw new Error('Unable to download ' + file.path);
  return response;
}

async function assetResponse(url, file) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(url);
  if (cached) return cached;
  const response = await verifiedFetch(url, file);
  try { await cache.put(url, response.clone()); } catch (_) { /* Online play remains available when cache quota is full. */ }
  return response;
}

self.addEventListener('install', event => {
  // Precache only the small shell. The large game download is explicit.
  // No skipWaiting: the previous worker remains active while its clients are open.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      for (const file of required.filter(file => !/^(Build|StreamingAssets)\//.test(file.path))) {
        const url = new URL(file.url, SCOPE).href;
        await cache.put(url, await verifiedFetch(url, file));
      }
    } catch (error) {
      await caches.delete(CACHE);
      throw error;
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  let key = url.href;
  if (event.request.mode === 'navigate' && (key === SCOPE || key === new URL('index.html', SCOPE).href)) {
    key = new URL('index.html', SCOPE).href;
  }
  const file = assets.get(key);
  if (file) event.respondWith(assetResponse(key, file));
});

self.addEventListener('message', event => {
  if (!event.ports?.[0]) return;
  const port = event.ports[0];
  if (event.data?.type === 'OFFLINE_STATUS') {
    event.waitUntil(status().then(result => port.postMessage(result)).catch(error => port.postMessage({ type: 'OFFLINE_ERROR', message: error.message })));
  } else if (event.data?.type === 'OFFLINE_DOWNLOAD') {
    if (download) { port.postMessage({ type: 'OFFLINE_ERROR', message: 'Một lượt tải khác đang chạy.' }); return; }
    download = (async () => {
      const cache = await caches.open(CACHE);
      let complete = 0;
      for (const file of required) {
        const url = new URL(file.url, SCOPE).href;
        if (!(await cache.match(url))) await cache.put(url, await verifiedFetch(url, file));
        port.postMessage({ type: 'OFFLINE_PROGRESS', complete: ++complete, total: required.length });
      }
      port.postMessage(await status());
    })().catch(error => port.postMessage({ type: 'OFFLINE_ERROR', message: error.message }))
      .finally(() => { download = null; });
    event.waitUntil(download);
  }
});
