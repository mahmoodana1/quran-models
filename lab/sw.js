// GitHub Pages can't send headers, so this worker adds the two that make the
// page cross-origin isolated, which lets the model use several CPU cores.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  if (new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req).then(res => {
    if (res.status === 0) return res;
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Embedder-Policy', 'credentialless');
    h.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }));
});
