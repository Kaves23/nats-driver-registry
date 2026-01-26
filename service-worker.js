// ROK Cup South Africa PWA Service Worker
const CACHE_NAME = 'rok-cup-v8';
const OFFLINE_URL = '/offline.html';
const DRIVER_PORTAL_URL = '/driver_portal.html';

// Critical files to cache for offline use (only files that definitely exist)
const CRITICAL_ASSETS = [
  '/driver_portal.html',
  '/index.html',
  '/offline.html',
  '/manifest.json'
];

// Optional files to cache (won't fail install if missing)
const OPTIONAL_ASSETS = [
  '/',
  '/admin.html',
  '/officials.html',
  '/icons/icon-72.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/rok-logo-original.png',
  '/documents/raceday/mini-raceday-instructions.html',
  '/documents/season/DOC003-rok-2026-event-entry-pack.html',
  '/documents/season/DOC030-rok-2026-spectator-guide.html'
];

// Install event - cache static assets with error handling
self.addEventListener('install', (event) => {
  console.log('[ServiceWorker] Installing v7...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[ServiceWorker] Caching critical assets');
        // Cache critical assets - must succeed
        return cache.addAll(CRITICAL_ASSETS)
          .then(() => {
            console.log('[ServiceWorker] Critical assets cached, now caching optional assets');
            // Try to cache optional assets individually, don't fail on errors
            return Promise.allSettled(
              OPTIONAL_ASSETS.map(url => 
                cache.add(url)
                  .then(() => console.log(`[SW] ✓ Cached: ${url}`))
                  .catch(err => console.log(`[SW] ✗ Could not cache ${url}: ${err.message}`))
              )
            );
          });
      })
      .then(() => {
        console.log('[ServiceWorker] Install complete');
        return self.skipWaiting();
      })
      .catch((err) => {
        console.error('[ServiceWorker] Install failed:', err.message);
        // Still skip waiting even if some caches fail
        return self.skipWaiting();
      })
  );
});

// Activate event - clean up old caches and notify clients
self.addEventListener('activate', (event) => {
  console.log('[ServiceWorker] Activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[ServiceWorker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('[ServiceWorker] Activation complete');
      return self.clients.claim();
    }).then(() => {
      // Notify all clients about the update
      return self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'SW_UPDATED', version: CACHE_NAME });
        });
      });
    })
  );
});

// Listen for skip waiting message from client
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Fetch event - network-first for HTML, cache-first for assets
self.addEventListener('fetch', (event) => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') return;
  
  // Skip non-HTTP(S) requests (chrome-extension, data, blob, etc.)
  const url = new URL(event.request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return;
  }
  
  // Skip API requests - always go to network
  if (event.request.url.includes('/api/')) {
    return;
  }

  // For HTML pages (navigation requests), use network-first strategy
  if (event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          // Cache the fresh response
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // Network failed - try cache, then offline page
          return caches.match(event.request)
            .then((cachedResponse) => {
              if (cachedResponse) {
                return cachedResponse;
              }
              return caches.match(OFFLINE_URL);
            });
        })
    );
    return;
  }

  // For other assets (images, CSS, JS, documents), use cache-first strategy
  event.respondWith(
    caches.match(event.request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          // Return cached version and update in background
          fetch(event.request)
            .then((networkResponse) => {
              if (networkResponse && networkResponse.status === 200) {
                caches.open(CACHE_NAME).then((cache) => {
                  cache.put(event.request, networkResponse.clone());
                }).catch(err => {
                  // Silently fail cache update
                  console.log('[SW] Cache update failed:', err.message);
                });
              }
            })
            .catch(() => {
              // Network failed, but we have cache so it's fine
            });
          
          return cachedResponse;
        }

        // Not in cache, fetch from network
        return fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const responseClone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, responseClone);
              }).catch(err => {
                // Silently fail cache write
                console.log('[SW] Cache write failed:', err.message);
              });
            }
            return networkResponse;
          })
          .catch((err) => {
            // Don't throw errors for failed fetches
            console.log('[SW] Fetch failed for:', event.request.url);
            // Return a simple error response
            return new Response('Offline - Content Unavailable', { 
              status: 503, 
              statusText: 'Service Unavailable',
              headers: { 'Content-Type': 'text/plain' }
            });
          });
      })
      .catch((err) => {
        // Catch any cache.match errors
        console.log('[SW] Cache match failed:', err.message);
        return new Response('Cache Error', {
          status: 500,
          statusText: 'Internal Error',
          headers: { 'Content-Type': 'text/plain' }
        });
      })
  );
});

// Background sync for form submissions
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-registrations') {
    console.log('[ServiceWorker] Syncing queued registrations...');
    // Future: sync queued registrations when back online
    event.waitUntil(syncQueuedData());
  }
});

async function syncQueuedData() {
  // Placeholder for future sync functionality
  console.log('[ServiceWorker] Sync complete');
  return Promise.resolve();
}

// Push notifications
self.addEventListener('push', (event) => {
  if (event.data) {
    const data = event.data.json();
    const options = {
      body: data.body || 'New notification from ROK Cup South Africa',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
      vibrate: [100, 50, 100],
      data: {
        url: data.url || '/driver_portal.html',
        timestamp: Date.now()
      },
      actions: [
        { action: 'open', title: 'View', icon: '/icons/icon-72.png' },
        { action: 'close', title: 'Dismiss', icon: '/icons/icon-72.png' }
      ]
    };
    event.waitUntil(
      self.registration.showNotification(data.title || 'ROK Cup South Africa', options)
    );
  }
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url || '/driver_portal.html')
  );
});
