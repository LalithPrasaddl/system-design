# Rendering Strategies

Recall Client-Server Model & Networking Basics: a browser sends a request, a server sends back a response. Rendering strategy is about what that response actually contains — a finished page, or the raw materials for one — and, as a direct consequence, how long a real person waits before they see anything, and how long after that before the page actually responds to a click. Those are two different moments, and the gap between them is most of what this topic is about.

## Client-Side Rendering (CSR)

The server sends a nearly empty HTML shell plus a JavaScript bundle. The browser downloads the bundle, executes it, fetches whatever data the page needs, and only then builds the actual page in the DOM. Nothing meaningful is visible until all of that has happened — the server did almost no work, and the browser did all of it.

## Server-Side Rendering (SSR)

The server runs the same rendering logic itself, once per request, and sends back complete, already-populated HTML. The browser can paint that immediately — no waiting on JavaScript to build anything. But the page isn't actually interactive yet: clicking a button does nothing until the browser also downloads and runs the JavaScript that attaches the event handlers to the HTML that's already on screen. That process is called **hydration**, and the gap between "visible" and "actually responds to input" is hydration lag.

<div class="diagram-wrap">
<svg viewBox="0 0 640 230" width="640" height="230" role="img" aria-label="Timeline comparing server-side rendering and client-side rendering from request to interactive">
  <text x="75" y="82" text-anchor="end" class="d-label" font-size="12">SSR</text>
  <rect x="90" y="64" width="60" height="28" class="d-block d-block-request"></rect>
  <rect x="150" y="64" width="110" height="28" class="d-block d-block-response"></rect>
  <rect x="260" y="64" width="70" height="28" class="d-block d-block-blocked"></rect>
  <text x="75" y="152" text-anchor="end" class="d-label" font-size="12">CSR</text>
  <rect x="90" y="134" width="120" height="28" class="d-block d-block-request"></rect>
  <rect x="210" y="134" width="170" height="28" class="d-block d-block-blocked"></rect>
  <rect x="380" y="134" width="50" height="28" class="d-block d-block-response"></rect>
  <line x1="90" y1="210" x2="585" y2="210" class="d-axis"></line>
  <text x="592" y="214" class="d-label-muted" font-size="11">time →</text>
  <line x1="150" y1="54" x2="150" y2="200" class="d-marker-line"></line>
  <text x="150" y="46" text-anchor="middle" class="d-label" font-size="11">First paint</text>
  <line x1="330" y1="54" x2="330" y2="200" class="d-marker-line"></line>
  <text x="330" y="46" text-anchor="middle" class="d-label" font-size="11">Interactive</text>
  <line x1="430" y1="54" x2="430" y2="200" class="d-marker-line"></line>
  <text x="430" y="118" text-anchor="middle" class="d-label" font-size="11">Paint + interactive</text>
</svg>
<div class="diagram-caption">Same wall-clock axis, both rows. SSR (top) paints early — the server already rendered the HTML — but there's a gap before it's actually interactive, since the browser still has to download and run the same JS to attach event handlers (hydration). CSR (bottom) shows nothing until its JS bundle downloads, runs, and fetches its own data, so paint and interactive land together — just much later than SSR's first paint.</div>
</div>

Notice the trade isn't "SSR is faster" — it's a different shape of slow. SSR gets something on screen sooner but can leave it inert for a visible stretch (a page that looks ready but doesn't respond to a click yet is its own kind of bad experience). CSR shows nothing at all for longer, but once it shows something, it works.

## Static Site Generation (SSG)

A more radical version of SSR: instead of rendering per request, the page is rendered once, at build time, and the result is saved as a plain HTML file. Serving it at request time is just serving a static file — no server-side rendering work happens per request at all, which means it can be served entirely from a CDN (see CDNs & Edge Delivery) with no origin server in the loop for that request. This is about as fast as a response can possibly be. The cost: the page is only as fresh as the last build. A price that changed five minutes ago won't show up until the site rebuilds.

## Incremental Static Regeneration (ISR) and hybrid rendering

A middle ground between SSG's speed and SSR's freshness: pages are served as static files like SSG, but a given page can be regenerated in the background — after a set time-to-live, or on demand when its underlying data changes — without rebuilding the entire site. Most visitors still get an instant static response; the content just doesn't go stale for as long as a full SSG build cycle would allow. Modern frameworks increasingly let this be a per-page decision rather than a whole-site one: a marketing page can be pure SSG, a product page can be ISR, and an account dashboard can be CSR, all in the same application.

## Choosing among them

The deciding question for any given page is really two questions: how personalized is the content, and how fresh does it need to be?

| Content is... | Reasonable choice |
|---|---|
| Same for everyone, rarely changes | SSG |
| Same for everyone, changes occasionally | ISR |
| Same for everyone, changes constantly (a live feed) | SSR, or CSR fetching fresh data |
| Different per logged-in user | SSR or CSR — SSG can't work here, since there's no single build-time answer |

## Why this matters for system design

SSR moves rendering work that used to happen on a user's own device onto your servers — it's now a capacity-planning dimension exactly like anything else in Building Blocks: enough render throughput has to exist behind a load balancer to keep up with traffic, the same way database or cache throughput does. CSR does the opposite: it keeps your servers cheap (they're serving nearly-static files) and pushes the compute cost onto whatever device the visitor happens to be holding, which is also why CSR's real-world performance varies so much more per user — a high-end laptop and a low-end phone run the same JavaScript at very different speeds, while an SSR response arrives pre-built regardless of the device reading it.

## Real-world examples

- **Next.js, Nuxt, SvelteKit** — frameworks that support SSR, SSG, and ISR, often chosen per page within the same app.
- **Gatsby** — built primarily around SSG.
- **A plain single-page app** built with React, Vue, or similar and served from a static host — the default CSR shape most sites started from before hybrid frameworks became common.
