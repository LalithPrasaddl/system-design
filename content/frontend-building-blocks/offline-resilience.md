# Offline & Resilience

Every page so far has assumed a network is available, even if it's slow. This page is about the case where it isn't there at all — a subway tunnel, a flaky connection, a phone switching between networks — and what it takes for a web app to stay usable, or at least fail gracefully, when that happens.

## The service worker: a proxy the page controls

A **service worker** is a script the browser runs separately from the page itself, capable of intercepting every network request the page makes before it hits the network at all. That interception point is what makes offline support possible: the service worker can check a local cache first, and only reach the network if it decides to.

<div class="diagram-wrap">
<svg viewBox="0 0 600 240" width="600" height="240" role="img" aria-label="A service worker intercepting a page's fetch request, checking cache storage first and falling through to the network on a miss">
  <rect x="10" y="100" width="90" height="36" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="55" y="122" text-anchor="middle" class="d-actor-label">Page</text>
  <rect x="170" y="100" width="130" height="36" rx="6" class="d-actor-box"></rect>
  <text x="235" y="122" text-anchor="middle" class="d-actor-label" font-size="12">Service Worker</text>
  <rect x="400" y="40" width="120" height="36" rx="6" class="d-actor-box" data-role="cache"></rect>
  <text x="460" y="62" text-anchor="middle" class="d-actor-label" font-size="12">Cache Storage</text>
  <rect x="400" y="164" width="120" height="36" rx="6" class="d-actor-box"></rect>
  <text x="460" y="186" text-anchor="middle" class="d-actor-label">Network</text>
  <line x1="100" y1="111" x2="166" y2="111" class="d-msg d-request" marker-end="url(#arrowSw)"></line>
  <text x="133" y="103" text-anchor="middle" class="d-label-muted" font-size="10">fetch(url)</text>
  <line x1="166" y1="126" x2="100" y2="126" class="d-msg d-response" marker-end="url(#arrowSwr)"></line>
  <line x1="300" y1="103" x2="396" y2="66" class="d-msg d-request" marker-end="url(#arrowSw)"></line>
  <text x="365" y="75" text-anchor="middle" class="d-label-muted" font-size="10">1. check cache</text>
  <line x1="396" y1="80" x2="300" y2="117" class="d-msg d-response" marker-end="url(#arrowSwr)"></line>
  <text x="365" y="105" text-anchor="middle" class="d-label-muted" font-size="10">hit → serve cached</text>
  <line x1="460" y1="76" x2="460" y2="160" class="d-lifeline"></line>
  <text x="530" y="120" text-anchor="middle" class="d-label-muted" font-size="10">on miss: fetch from</text>
  <text x="530" y="133" text-anchor="middle" class="d-label-muted" font-size="10">network, cache it</text>
  <line x1="300" y1="128" x2="396" y2="172" class="d-msg d-request" marker-end="url(#arrowSw)"></line>
  <defs>
    <marker id="arrowSw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowSwr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">The same cache-aside shape as Caching and Client-Side Data & Caching, but the "cache" here is Cache Storage, a persistent store the service worker fully controls — including what to do when the network isn't there to fall back to at all.</div>
</div>

Which strategy to use — always prefer the cache, always prefer the network and fall back to cache only on failure, or serve the cache immediately while refreshing it in the background — is a per-request decision the service worker's code makes explicitly, not a browser default. The right choice depends on the same freshness-versus-speed question every caching decision in this course comes down to: how bad is it, for this specific piece of content, to be briefly wrong.

## Offline-first: writes without a network

Reading cached content offline is the easier half. Letting someone take an action — send a message, save a draft — while offline requires queuing that write locally (Client-Side Storage) and replaying it once connectivity returns, typically via the browser's **Background Sync API**, which lets a service worker register a pending sync that fires as soon as the network is back, even if the page itself isn't open anymore.

This introduces the same problem Consistency Models & CAP covers for distributed databases, now happening on a single user's device: if the same piece of data changed both locally (while offline) and on the server (from another device) before the two reconnect, something has to reconcile the two versions. The available strategies are the same ones — last-write-wins, a merge function, or surfacing the conflict to the user — chosen for the same reason: how bad it is to silently pick one side depends entirely on what the data actually is.

## Progressive Web Apps

A **PWA** is the combination of a service worker, a small manifest file (declaring an icon, a name, and how the app should look if launched from a home screen), and being served over HTTPS — together, that combination lets a browser treat a web app enough like a native one to offer "install" and to keep working with no connection at all. There's no separate technology beyond what's already on this page; a PWA is this page's ideas, assembled and declared.

## Why this matters for system design

Once a client can hold writes locally and apply them later, it stops being a passive requester and becomes a genuine node in a distributed system, with its own local state that can diverge from the server's — the same category of problem as replica lag (Replication) or a network partition (Consistency Models & CAP), just with a browser tab standing in for a database replica. Deciding how much offline capability a feature actually needs is really deciding how much of that complexity is worth taking on: a read-mostly content app gets enormous value from simple caching; a collaborative editor with offline writes is signing up for real conflict-resolution work.

## Real-world examples

- **Workbox** — a library from the Chrome team for writing common service worker caching strategies without hand-rolling the fetch-interception logic.
- **The Background Sync API** — the browser mechanism for deferring a write until connectivity returns.
- **Gmail and Google Docs' offline modes** — well-known examples of offline-first writes with conflict resolution once a device reconnects.
