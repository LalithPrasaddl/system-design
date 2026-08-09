# CDNs & Edge Delivery

Caching named the CDN as one of the layers a cache can live at, without dwelling on it. It's worth its own page for a reason that's easy to miss: a CDN isn't just "a cache," it's a cache specifically positioned to solve a problem no amount of server-side optimization can — the physical distance between a user and wherever a server happens to be running. Recall from Latency, Throughput: light itself takes time to cross a continent. A request from Sydney to a server in Virginia pays that cost no matter how fast the server responds.

## Where a CDN sits in the path

<div class="diagram-wrap">
<svg viewBox="0 0 600 260" width="600" height="260" role="img" aria-label="A user's request hitting a nearby edge location first, falling through to a distant origin server only on a miss">
  <rect x="20" y="30" width="100" height="36" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="70" y="53" text-anchor="middle" class="d-actor-label">User</text>
  <rect x="250" y="30" width="110" height="36" rx="6" class="d-actor-box" data-role="cache"></rect>
  <text x="305" y="53" text-anchor="middle" class="d-actor-label" font-size="12">Nearby Edge</text>
  <rect x="480" y="30" width="100" height="36" rx="6" class="d-actor-box"></rect>
  <text x="530" y="53" text-anchor="middle" class="d-actor-label">Origin</text>
  <line x1="120" y1="48" x2="246" y2="48" class="d-msg d-request" marker-end="url(#arrowCdn)"></line>
  <text x="185" y="40" text-anchor="middle" class="d-label-muted" font-size="11">request</text>
  <rect x="60" y="95" width="480" height="34" rx="6" class="d-note"></rect>
  <text x="300" y="116" text-anchor="middle" class="d-note-text">Cache hit at the edge: ~10-20ms round trip, origin never contacted</text>
  <line x1="300" y1="150" x2="300" y2="175" class="d-lifeline"></line>
  <text x="300" y="168" text-anchor="middle" class="d-label-muted" font-size="11">or, cache miss:</text>
  <line x1="300" y1="185" x2="476" y2="185" class="d-msg d-request" marker-end="url(#arrowCdn)"></line>
  <text x="390" y="178" text-anchor="middle" class="d-label-muted" font-size="11">fetch from origin, wherever it is</text>
  <line x1="480" y1="205" x2="304" y2="205" class="d-msg d-response" marker-end="url(#arrowCdnr)"></line>
  <text x="390" y="220" text-anchor="middle" class="d-label-muted" font-size="11">~100-300ms, then cached at the edge</text>
  <line x1="296" y1="205" x2="124" y2="215" class="d-msg d-response" marker-end="url(#arrowCdnr)"></line>
  <defs>
    <marker id="arrowCdn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowCdnr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">Same cache-aside mechanism as Caching, but the thing being minimized is physical distance rather than a database query. Once an edge location has a copy, every nearby user benefits — not just the one who caused the miss.</div>
</div>

A CDN is really a large, geographically distributed fleet of caching servers ("points of presence," or PoPs), each running the same hit/miss logic as any other cache — TTLs, `ETag`-based revalidation (Client-Side Data & Caching), the works — just physically close to groups of users instead of close to an application server.

## What a CDN can and can't accelerate

Anything that's the same response for everyone — images, videos, CSS, JS bundles, a fully static page from Rendering Strategies' SSG path — is a natural fit: cache it at every edge location, and it's served from nearby hardware forever after the first request from that region. A response that's different per user (an account dashboard, anything requiring authentication) doesn't fit the same model at all — caching one user's private data at an edge location and serving it to the next person who asks would be a serious bug, not an optimization. Traditionally, that kind of request had to skip the CDN and go all the way to the origin.

## Edge compute: beyond caching

Newer CDN platforms run actual application code at each edge location, not just cached files — commonly called **edge functions** or **edge rendering**. This closes part of the gap above: a request can be authenticated, personalized, or even server-rendered (Rendering Strategies) at the nearby edge location instead of a single, possibly distant, origin — trading the origin's centralization for the same latency win static content already got. The limits are real, though: edge runtimes are typically more restricted than a full server environment, and any edge location that needs shared state (a database, a session store) still has to reach back to it somewhere central, paying at least part of the distance cost anyway.

## Invalidation, at global scale

Purging a cached object from one server is instant. Purging it from thousands of edge locations spread across the planet is a distributed operation with its own propagation delay — most CDNs' "instant purge" is really "purge that completes in a few seconds, globally," which is fast, but isn't actually zero. This is the same invalidation problem from Caching, just harder to make instantaneous at this scale, and it's why short TTLs plus content-hashed, effectively-immutable filenames (Client-Side Data & Caching) are often preferred over relying on purge-on-deploy for anything urgent.

## Why this matters for system design

A CDN is frequently the single highest-leverage change available for a globally distributed audience, because it attacks a cost nothing else in this course can: the speed of light. Optimizing a server's response time from 50ms to 20ms matters far less to a user 200ms away by network distance than moving the response 200ms closer to them in the first place.

## Real-world examples

- **Cloudflare, Akamai, Amazon CloudFront** — CDNs operating large global PoP networks.
- **Cloudflare Workers, Vercel Edge Functions, AWS Lambda@Edge** — edge compute platforms that run application code at PoPs rather than only caching static files.
- **Fastly** — a CDN commonly used for its fast purge propagation, popular for content that changes frequently but still benefits from edge caching.
