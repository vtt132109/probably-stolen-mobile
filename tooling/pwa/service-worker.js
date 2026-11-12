/* BUILD is injected by package-web.mjs. This worker never opens or deletes save databases. */
const SCOPE = self.registration.scope;
const PREFIX = 'probably-stolen:' + SCOPE + ':';
// Small shell files (HTML/CSS/JS/icons) live in a per-version cache.
const CACHE = PREFIX + BUILD.version;
// Game content (Build/, StreamingAssets/) lives in one store shared by every version, keyed by URL plus
// the expected integrity. Unchanged files therefore survive updates, and a changed file at the same URL
// can never be mistaken for the new one. Only the active worker writes it.
const CONTENT = PREFIX + 'content-v1';
const assets = new Map(BUILD.files.map(file => [new URL(file.url, SCOPE).href, file]));
const virtual = new Map((BUILD.virtualFiles || []).map(file => [new URL(file.url, SCOPE).href, file]));
const required = BUILD.files.filter(file => file.required);
const pending = new Map(); // url -> in-flight verified network response (shared by page retries)
let download = null;
let legacyList = null;

const isShell = file => !/^(Build|StreamingAssets)\//.test(file.path);
function contentKey(url, file) {
  const key = new URL(url);
  key.searchParams.set('ps-integrity', file.integrity);
  return key.href;
}
const storeName = file => isShell(file) ? CACHE : CONTENT;
const storeKey = (url, file) => isShell(file) ? url : contentKey(url, file);
const urlOf = file => new URL(file.url, SCOPE).href;
// A worker transfer is abandoned if it cannot sustain ~24 KiB/s, so a stalled connection never
// captures later page retries forever. The page waits a little longer than this.
const transferDeadlineMs = file => Math.max(120000, Math.ceil((file.transferBytes || file.responseBytes || 0) / 24576) * 1000);

async function stored(url, file) {
  return (await caches.open(storeName(file))).match(storeKey(url, file));
}

async function store(url, file, response) {
  await (await caches.open(storeName(file))).put(storeKey(url, file), response);
}

// Caches written by releases up to 9 hold game content under plain URLs. Only caches that still contain
// game content (Build/ or StreamingAssets/) count, so a newer version's waiting shell-only cache is never
// touched, and a cache whose Build/ files already moved keeps its remaining StreamingAssets/ for migration.
const isContentUrl = url => /^(Build|StreamingAssets)\//.test(url.startsWith(SCOPE) ? url.slice(SCOPE.length) : '');
function legacyCaches() {
  legacyList ||= (async () => {
    const result = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith(PREFIX) || name === CACHE || name === CONTENT) continue;
      const cache = await caches.open(name);
      if ((await cache.keys()).some(request => isContentUrl(request.url))) result.push({ name, cache });
    }
    return result;
  })().catch(error => { legacyList = null; throw error; });
  return legacyList;
}

async function deleteLegacyCaches() {
  // A republished older release may be installing/waiting under a legacy cache name; never delete under it.
  if (self.registration.installing || self.registration.waiting) return;
  for (const { name } of await legacyCaches()) await caches.delete(name);
  legacyList = null;
}

async function integrityOf(buffer) {
  return 'sha256-' + btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))));
}

// One-time move of a byte-identical (integrity-verified) file out of a release <= 9 cache.
async function migrateFromLegacy(url, file) {
  for (const { cache } of await legacyCaches()) {
    try {
      const old = await cache.match(url);
      if (!old) continue;
      const body = await old.arrayBuffer();
      if (await integrityOf(body) !== file.integrity) continue;
      const copy = new Response(body, { status: old.status, statusText: old.statusText, headers: old.headers });
      try { await store(url, file, copy.clone()); }
      catch (error) {
        if (error?.name !== 'QuotaExceededError') throw error;
        // Free only this file's legacy copy (its verified bytes are in memory), keeping every other
        // not-yet-migrated file available offline, then store it again.
        await cache.delete(url);
        try { await store(url, file, copy.clone()); } catch (_) { /* Still serve the verified copy this time. */ }
        return copy;
      }
      await cache.delete(url);
      return copy;
    } catch (_) { /* Try the next legacy cache. */ }
  }
  return null;
}

async function cachedCopy(url, file) {
  return (await stored(url, file)) || (isShell(file) ? null : await migrateFromLegacy(url, file));
}

async function status() {
  let present = 0;
  for (const file of required) if (await stored(urlOf(file), file)) present++;
  return { type: 'OFFLINE_STATUS', version: BUILD.version, ready: present === required.length,
    present, total: required.length, bytes: BUILD.requiredTransferBytes };
}

async function verifiedFetch(url, file, signal) {
  let response;
  try { response = await fetch(url, { integrity: file.integrity, cache: 'no-store', credentials: 'same-origin', signal }); }
  catch (error) {
    if (signal?.aborted) throw new Error(`Hết thời gian tải ${file.path} (${Math.round(transferDeadlineMs(file) / 1000)} giây)`);
    throw error;
  }
  if (!response.ok || response.type === 'opaque') throw new Error('Unable to download ' + file.path);
  return response;
}

async function putWithQuotaRecovery(url, file, response) {
  try { await store(url, file, response.clone()); }
  catch (error) {
    if (error?.name !== 'QuotaExceededError' || !(await legacyCaches()).length) throw error;
    await deleteLegacyCaches(); // Old copies must not block the current version forever.
    await store(url, file, response.clone());
  }
}

// One network transfer per URL: a page retry after its own timeout joins the transfer that is still
// running instead of competing with it. The transfer has its own deadline, so a dead one is replaced.
function networkCopy(url, file, event) {
  let entry = pending.get(url);
  if (!entry) {
    const controller = new AbortController();
    const release = () => { if (pending.get(url) === entry) pending.delete(url); };
    // The deadline covers the whole transfer including the body and its storage, so a body that stalls
    // mid-stream is abandoned and the next page retry starts a fresh transfer.
    const timer = setTimeout(() => { controller.abort(); release(); }, transferDeadlineMs(file));
    // Integrity checking already buffers the whole part; read it once and serve copies of that buffer.
    const job = verifiedFetch(url, file, controller.signal).then(async response => ({
      body: await response.arrayBuffer(), status: response.status, statusText: response.statusText,
      headers: [...response.headers] }));
    const kept = job.then(copy => putWithQuotaRecovery(url, file, responseOf(copy)))
      .finally(() => { clearTimeout(timer); release(); });
    entry = { job, kept };
    pending.set(url, entry);
    kept.catch(() => { /* Online play remains available when cache quota is full. */ });
    try { event?.waitUntil?.(kept.catch(() => {})); } catch (_) { /* Event already settled. */ }
  }
  return entry;
}

const responseOf = copy => new Response(copy.body, { status: copy.status, statusText: copy.statusText, headers: copy.headers });
const servedCopy = entry => entry.job.then(responseOf);

async function assetResponse(url, file, refresh = false, event = null) {
  if (!refresh) {
    const cached = await cachedCopy(url, file);
    if (cached) return cached;
  }
  try { return await servedCopy(networkCopy(url, file, event)); }
  catch (error) {
    // A refresh that cannot reach the network (offline) still serves the stored copy;
    // the page verifies its hash again.
    const cached = refresh ? await cachedCopy(url, file) : null;
    if (cached) return cached;
    throw error;
  }
}

function virtualResponse(file) {
  let index = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        if (index === file.parts.length) { controller.close(); return; }
        const url = new URL(file.parts[index++], SCOPE).href;
        const response = await assetResponse(url, assets.get(url));
        controller.enqueue(new Uint8Array(await response.arrayBuffer()));
      } catch (error) {
        if(self.clients.matchAll) for(const client of await self.clients.matchAll())
          client.postMessage({type:'ASSET_ERROR',path:file.path,message:error.message});
        controller.error(error);
      }
    }
  }, {highWaterMark:0}), {headers:{'Content-Type':file.contentType,'Content-Length':String(file.responseBytes)}});
}

self.addEventListener('install', event => {
  // Precache only the small shell. The large game download is explicit.
  // No skipWaiting: the previous worker remains active while its clients are open.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      for (const file of required.filter(isShell)) {
        const url = urlOf(file);
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
    // Release <= 9 content caches are kept until their files have moved (see migrateFromLegacy);
    // every other cache of this deployment scope except this version's shell and the content store goes.
    const legacy = new Set((await legacyCaches()).map(({ name }) => name));
    for (const key of await caches.keys())
      if (key.startsWith(PREFIX) && key !== CACHE && key !== CONTENT && !legacy.has(key)) await caches.delete(key);
    // Drop content that this version no longer references (by URL plus integrity).
    const wanted = new Set(BUILD.files.filter(file => !isShell(file)).map(file => contentKey(urlOf(file), file)));
    const content = await caches.open(CONTENT);
    for (const request of await content.keys()) if (!wanted.has(request.url)) await content.delete(request);
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
  if (virtual.has(key)) event.respondWith(virtualResponse(virtual.get(key)));
  else if (file) event.respondWith(assetResponse(key, file, event.request.cache === 'reload', event).catch(async error => {
    // A rejected respondWith reaches the page only as a generic network error; send the real reason.
    try {
      const client = event.clientId && await self.clients.get(event.clientId);
      client?.postMessage({ type: 'ASSET_ERROR', path: file.path, message: error?.message || String(error) });
    } catch (_) { /* Best effort. */ }
    throw error;
  }));
});

self.addEventListener('message', event => {
  if (!event.ports?.[0]) return;
  const port = event.ports[0];
  if (event.data?.type === 'UNITY_DATA_MANIFEST') {
    port.postMessage({type:'UNITY_DATA_MANIFEST', version:BUILD.version,
      files:BUILD.files, virtualFiles:BUILD.virtualFiles || []});
  } else if (event.data?.type === 'OFFLINE_STATUS') {
    event.waitUntil(status().then(async result => {
      port.postMessage(result);
      // Legacy copies are released only once this version holds every required file itself.
      if (result.ready) await deleteLegacyCaches();
    }).catch(error => port.postMessage({ type: 'OFFLINE_ERROR', message: error.message })));
  } else if (event.data?.type === 'OFFLINE_DOWNLOAD') {
    if (download) { port.postMessage({ type: 'OFFLINE_ERROR', message: 'Một lượt tải khác đang chạy.' }); return; }
    download = (async () => {
      let complete = 0;
      let completedBytes = 0, downloadedBytes = 0;
      const started = Date.now();
      for (const file of required) {
        const url = urlOf(file);
        // Reuses the shared content store and moves verified release <= 9 copies without network.
        if (!(await cachedCopy(url, file)) || !(await stored(url, file))) {
          await networkCopy(url, file, event).kept; // Same deadline and dedupe as play-time transfers.
          downloadedBytes += file.transferBytes || 0;
        }
        if (!(await stored(url, file))) throw new Error('Không lưu được ' + file.path + ' vào bộ nhớ thiết bị.');
        completedBytes += file.transferBytes || 0;
        port.postMessage({ type: 'OFFLINE_PROGRESS', complete: ++complete, total: required.length,
          completedBytes, totalBytes:BUILD.requiredTransferBytes, downloadedBytes,
          bytesPerSecond:downloadedBytes/Math.max((Date.now()-started)/1000,0.001) });
      }
      const result = await status();
      if (result.ready) await deleteLegacyCaches();
      port.postMessage(result);
    })().catch(error => port.postMessage({ type: 'OFFLINE_ERROR', message: error.message }))
      .finally(() => { download = null; });
    event.waitUntil(download);
  }
});
