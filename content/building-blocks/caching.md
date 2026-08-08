# Caching

Recall from Latency & Throughput: memory is fast, disk is slower, and the network is the slowest thing you can put on a critical path — often by several orders of magnitude. A **cache** is a copy of data kept somewhere faster to access than its original source, specifically to avoid paying that cost repeatedly for the same data.

Nearly every layer of a real system has a cache in front of the layer below it, precisely because that pattern — slow authoritative source, fast copy in front of it — is so broadly useful.

## The basic flow: hit and miss

<div class="diagram-wrap">
<svg viewBox="0 0 600 260" width="600" height="260" role="img" aria-label="Cache hit and cache miss flow diagram">
  <rect x="20" y="30" width="100" height="36" rx="6" class="d-actor-box"></rect>
  <text x="70" y="53" text-anchor="middle" class="d-actor-label">Client</text>
  <rect x="250" y="30" width="100" height="36" rx="6" class="d-actor-box"></rect>
  <text x="300" y="53" text-anchor="middle" class="d-actor-label">Cache</text>
  <rect x="480" y="30" width="100" height="36" rx="6" class="d-actor-box"></rect>
  <text x="530" y="53" text-anchor="middle" class="d-actor-label">Database</text>
  <line x1="120" y1="48" x2="246" y2="48" class="d-msg d-request" marker-end="url(#arrowC)"></line>
  <text x="185" y="40" text-anchor="middle" class="d-label-muted" font-size="11">get(key)</text>
  <rect x="60" y="95" width="480" height="34" rx="6" class="d-note"></rect>
  <text x="300" y="116" text-anchor="middle" class="d-note-text">Cache hit: key found, return it immediately — database is never touched</text>
  <line x1="300" y1="150" x2="300" y2="175" class="d-lifeline"></line>
  <text x="300" y="168" text-anchor="middle" class="d-label-muted" font-size="11">or, cache miss:</text>
  <line x1="300" y1="185" x2="476" y2="185" class="d-msg d-request" marker-end="url(#arrowC)"></line>
  <text x="390" y="178" text-anchor="middle" class="d-label-muted" font-size="11">fetch from source</text>
  <line x1="480" y1="205" x2="304" y2="205" class="d-msg d-response" marker-end="url(#arrowCr)"></line>
  <text x="390" y="220" text-anchor="middle" class="d-label-muted" font-size="11">store it in cache, then return it</text>
  <line x1="296" y1="205" x2="124" y2="215" class="d-msg d-response" marker-end="url(#arrowCr)"></line>
  <defs>
    <marker id="arrowC" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowCr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">A cache hit skips the slow source entirely. A cache miss pays the full cost once, then populates the cache so the next request for the same key becomes a hit.</div>
</div>

The entire value of a cache comes down to its **hit rate** — the fraction of requests it can answer without going to the source. A cache with a low hit rate isn't just useless, it's actively harmful: every miss now does the original work *plus* the overhead of checking the cache first.

## Where caches live

Caching isn't one component — it's a pattern applied at nearly every layer of a system, each catching a different kind of repeated cost:

- **Client-side cache** — a browser or mobile app storing responses locally, avoiding the network entirely for a repeat request.
- **CDN (Content Delivery Network)** — copies of static content (images, videos, JS/CSS bundles) held on servers physically distributed near users, avoiding a long-distance network round trip for content that rarely changes.
- **Application-level cache** — an in-memory store (Redis, Memcached) sitting between your application servers and the database, avoiding a database query for frequently-requested data.
- **Database-internal cache** — most databases keep frequently-accessed pages of data in memory (a "buffer pool"), avoiding a disk read even when the application does query the database directly.

Each layer is optional and independent — a request might hit a client cache and stop there, or miss every cache layer and hit the database's own disk. The general principle: put a cache as close to the requester as the data's freshness requirements allow.

## The hard part: invalidation

Caching a value is easy. Knowing when that cached value is no longer correct — **cache invalidation** — is one of the genuinely hard problems in this field, because the cache and the source of truth are now two separate copies of the same fact, and nothing forces them to change together automatically.

Common strategies:

- **TTL (time-to-live)** — each cached entry expires automatically after a set duration, whether or not the underlying data actually changed. Simple, and bounds how stale data can get, at the cost of occasionally serving stale data for up to the TTL window, and occasionally evicting-and-refetching data that never changed at all.
- **Write-through** — every write goes to the cache and the source at the same time, keeping them in sync immediately, at the cost of making every write slightly slower (it now has to update two places).
- **Write-behind (write-back)** — a write updates the cache immediately and is written to the source asynchronously afterward. Fast writes, but a real risk: if the system crashes before the write-behind completes, that write is lost.
- **Explicit invalidation** — when the source changes, the code that changed it also explicitly deletes or updates the corresponding cache entry. Precise, but only as reliable as remembering to do it everywhere a given piece of data can be modified — miss one code path and you have a stale cache with no expiry to eventually fix it.

There's no invalidation strategy that's simply "correct" — each is a different trade-off between staleness, write latency, and implementation complexity, chosen based on how bad it actually is for that specific data to be briefly wrong.

## Eviction: what happens when the cache is full

A cache is, deliberately, smaller than the source it's caching — that's what makes it fast. When it fills up, something has to be removed to make room for new entries. The most common policy is **LRU (Least Recently Used)** — evict whatever hasn't been accessed in the longest time, on the assumption that data used recently is likely to be used again soon (this assumption is called *temporal locality*, and it holds well for most real-world access patterns, which is why LRU is so widely used as a default).

## What happens if the cache disappears

It's worth explicitly tracing through what a cache actually is, and isn't, responsible for: if the cache goes down entirely, a well-designed system should still function — every request simply becomes a cache miss and falls through to the real source. The application gets *slower* (every request now pays the full cost the cache was hiding) and the source system gets hit with far more load than it saw before (a **thundering herd**, if the cache disappears suddenly while under heavy traffic), but correctness doesn't depend on the cache existing. If removing the cache would make your system produce *wrong* answers rather than merely slow ones, that's a sign the cache is secretly being used to hold data that has no other source — which means it isn't really a cache anymore, it's an under-specified primary datastore.

## Why this matters for system design

Caching is usually the single highest-leverage tool for handling read-heavy load, precisely because most real-world data access is skewed — a small number of items (a trending post, a popular product) account for a disproportionate share of requests, so caching even a small hot set can absorb most of the traffic. It's also the clearest illustration of a trade-off that recurs constantly in this course: caching buys speed by accepting the possibility of staleness, and how much staleness is tolerable is a decision about the data, not a property of caching itself.
