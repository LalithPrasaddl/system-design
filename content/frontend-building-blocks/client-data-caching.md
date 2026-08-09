# Client-Side Data & Caching

Caching covered the general shape of caching — a fast copy in front of a slower source, and the hard problem of knowing when that copy is no longer correct. Everything from that page still applies here; this page is about the specific caches that live in the browser itself: the HTTP cache that stores whole responses, and the application-level caches that keep a page's data in sync with the server as someone actually uses it.

## HTTP caching: the browser's own cache

Every response can carry headers that tell the browser how to treat it as a cache entry, without any application code involved at all.

<div class="diagram-wrap">
<svg viewBox="0 0 600 230" width="600" height="230" role="img" aria-label="A browser requesting a resource from a server, with three possible caching outcomes on a repeat request">
  <rect x="20" y="20" width="110" height="36" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="75" y="42" text-anchor="middle" class="d-actor-label">Browser</text>
  <rect x="460" y="20" width="110" height="36" rx="6" class="d-actor-box"></rect>
  <text x="515" y="42" text-anchor="middle" class="d-actor-label">Server</text>
  <line x1="130" y1="38" x2="456" y2="38" class="d-msg d-request" marker-end="url(#arrowHc)"></line>
  <text x="295" y="30" text-anchor="middle" class="d-label-muted" font-size="11">repeat request for the same URL</text>
  <rect x="60" y="90" width="480" height="32" rx="6" class="d-note"></rect>
  <text x="300" y="111" text-anchor="middle" class="d-note-text" font-size="12">Still fresh (within max-age): request never leaves the browser</text>
  <rect x="60" y="132" width="480" height="32" rx="6" class="d-note"></rect>
  <text x="300" y="153" text-anchor="middle" class="d-note-text" font-size="12">Stale, but ETag matches: 304 Not Modified — headers only, no body</text>
  <rect x="60" y="174" width="480" height="32" rx="6" class="d-note"></rect>
  <text x="300" y="195" text-anchor="middle" class="d-note-text" font-size="12">Stale, content changed: 200 OK — full response, new ETag stored</text>
  <defs>
    <marker id="arrowHc" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">`Cache-Control: max-age` sets a window where the browser doesn't even ask. Once that window passes, an `ETag` lets the server answer with a cheap 304 instead of re-sending a body that hasn't actually changed.</div>
</div>

Two headers do most of the work: `Cache-Control: max-age=N` tells the browser it can treat the response as fresh for N seconds with no request at all, and `ETag` (an opaque fingerprint of the content) lets a later request ask "has this changed since I last saw fingerprint X?" via `If-None-Match` — a `304 Not Modified` response means no, keep using what you have, without resending the body.

A trick worth knowing: build tools that put a content hash in a file's name (`app.a1b2c3.js`) can safely set `max-age` to a year and mark the response `immutable`, because that exact file will genuinely never change — a new version gets a new filename entirely, which is itself the invalidation mechanism (see also Bundling in Critical Rendering Path & Performance).

## Application data caching

HTTP caching handles whole responses. Most interactive pages also need to cache *data* — the result of "the current user's profile" or "this page of search results" — and keep it reasonably fresh as the user navigates around and other data changes underneath them. Libraries built for this (React Query, SWR, Apollo Client's cache) generally implement the same **stale-while-revalidate** pattern: show the cached value immediately, then refetch in the background and update the UI if the answer changed. It's the TTL strategy from Caching, applied at the granularity of individual pieces of application data instead of whole HTTP responses, with the refetch step layered on top so staleness self-corrects without the user having to do anything.

## Optimistic updates

For a mutation — liking a post, adding an item to a cart — waiting for the server's response before updating the UI makes every action feel as slow as a full round trip. An **optimistic update** applies the change to the local cache immediately, as if it had already succeeded, then reconciles with the real response when it arrives: if the server confirms, nothing visible happens; if it rejects, the UI has to roll the change back and usually surface that failure. This trades a small amount of implementation complexity (every optimistic mutation needs a defined rollback) for an interface that feels instant regardless of actual network latency.

## Why this matters for system design

Once a client holds its own cached copy of server state, that copy is a fourth thing to keep consistent, alongside whatever replication and caching your backend is already doing (Replication, Caching) — a user can now see stale data not because of database replication lag, but because their own browser hasn't refetched yet. The mitigations are the same shape as everywhere else in this course: bound the staleness explicitly (a TTL or a revalidation trigger) rather than leaving it undefined, and decide deliberately which parts of the UI need to react immediately to a change made elsewhere versus which can lag.

## Real-world examples

- **TanStack Query (React Query)** and **SWR** — client-side data-fetching libraries built around stale-while-revalidate caching.
- **Apollo Client** — a GraphQL client with its own normalized cache, commonly used with optimistic updates.
- **`Cache-Control` and `ETag`** — the browser's built-in HTTP cache, requiring no library at all.
