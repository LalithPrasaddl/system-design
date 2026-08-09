# Critical Rendering Path & Performance

Rendering Strategies covered *where* a page gets built — server or browser. This page is about what the browser itself has to do, step by step, to turn HTML, CSS, and JavaScript into pixels on a screen — the **critical rendering path** — and where that process can be blocked, delayed, or trimmed down.

## The critical rendering path

<div class="diagram-wrap">
<svg viewBox="0 0 620 200" width="620" height="200" role="img" aria-label="Critical rendering path: HTML becomes the DOM and CSS becomes the CSSOM, which combine into a render tree, then layout, then paint">
  <rect x="30" y="25" width="150" height="40" rx="8" class="d-actor-box"></rect>
  <text x="105" y="49" text-anchor="middle" class="d-actor-label" font-size="12">HTML → DOM</text>
  <rect x="210" y="25" width="150" height="40" rx="8" class="d-actor-box"></rect>
  <text x="285" y="49" text-anchor="middle" class="d-actor-label" font-size="12">CSS → CSSOM</text>
  <text x="285" y="82" text-anchor="middle" class="d-label-muted" font-size="10">blocks the render tree until parsed</text>
  <rect x="110" y="110" width="170" height="40" rx="8" class="d-actor-box"></rect>
  <text x="195" y="134" text-anchor="middle" class="d-actor-label" font-size="12">Render Tree</text>
  <rect x="330" y="110" width="120" height="40" rx="8" class="d-actor-box"></rect>
  <text x="390" y="134" text-anchor="middle" class="d-actor-label" font-size="12">Layout</text>
  <rect x="490" y="110" width="110" height="40" rx="8" class="d-actor-box"></rect>
  <text x="545" y="134" text-anchor="middle" class="d-actor-label" font-size="12">Paint</text>
  <line x1="105" y1="65" x2="150" y2="108" class="d-msg d-request" marker-end="url(#arrowCrp)"></line>
  <line x1="285" y1="65" x2="240" y2="108" class="d-msg d-request" marker-end="url(#arrowCrp)"></line>
  <line x1="280" y1="130" x2="326" y2="130" class="d-msg d-request" marker-end="url(#arrowCrp)"></line>
  <line x1="450" y1="130" x2="486" y2="130" class="d-msg d-request" marker-end="url(#arrowCrp)"></line>
  <defs>
    <marker id="arrowCrp" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">The DOM and CSSOM are built independently, then combined into a render tree — which is why CSS is render-blocking by default: the browser can't safely paint anything until it knows how it's supposed to look, so it waits for the CSSOM before building the render tree at all.</div>
</div>

A `<script>` tag has a similar but distinct effect: by default, the HTML parser stops entirely when it hits one, downloads and executes the script, and only then resumes parsing the rest of the page — because that script might use `document.write` or otherwise change the DOM the parser hasn't built yet. The `async` attribute lets the script download in parallel without blocking parsing, then runs as soon as it's ready (in whatever order downloads finish); `defer` also downloads in parallel but waits to run until parsing is fully done, in the original script order. Neither one is universally "correct" — `defer` is normally the safer default for scripts that touch the DOM, since the DOM is guaranteed complete by the time they run.

## Code splitting and lazy loading

A single JavaScript bundle containing an entire application's code has to be downloaded and parsed before any of it can run — including the code for parts of the app the current user may never visit. **Code splitting** breaks that bundle into smaller pieces, typically one per route or feature, so a request only pays for the JavaScript the current page actually needs. **Lazy loading** takes this further: a piece of code (a modal, a rarely-used settings panel) is only fetched when it's actually about to be used, not on initial load at all.

This is a direct trade-off with request overhead (Latency, Throughput): one large bundle means one request but more bytes than necessary up front; many small bundles mean less wasted download but more round trips, each with its own latency floor. In practice, a moderate amount of splitting — by route, and by clearly optional features — captures most of the benefit without multiplying requests excessively.

## Bundling, briefly

Before any of this ships, a **bundler** (Webpack, Vite, esbuild, and Rollup are the common ones) combines a project's many source files into the smaller number of files a browser actually fetches, and **tree-shakes** out code that's imported but never used along the way. This is what makes code splitting practical in the first place — the bundler is the tool deciding where the split points actually land, based on route boundaries and `import()` calls in the source.

## Measuring what actually matters

"Fast" isn't one number. The vocabulary that's converged on for talking about this maps closely to the two moments from Rendering Strategies: **Largest Contentful Paint (LCP)** measures when the main content becomes visible, and **Interaction to Next Paint (INP)** measures how responsive the page is to actual input after that. A page can score well on one and poorly on the other — exactly the SSR-paints-early-but-isn't-interactive-yet gap from the previous page shows up here as a real, measured split between these two numbers, not just a conceptual one.

## Why this matters for system design

Every millisecond spent here is a millisecond a real person is looking at a blank or unresponsive screen, and unlike most of backend Building Blocks, this cost is paid on every single page load, on hardware you don't control and traffic you can't smooth with a queue. The fixes are consistently about doing and shipping less on the critical path — less blocking CSS, less JavaScript that has to run before the page responds — rather than doing the same work faster, which is why "what can we defer or not send at all" is usually a higher-leverage question here than "how do we speed this up."

## Real-world examples

- **Webpack, Vite, esbuild, Rollup** — the common bundlers, each making different trade-offs between build speed and output optimization.
- **Lighthouse** and **WebPageTest** — tools that measure and report LCP, INP, and related metrics against a real or simulated page load.
- **`React.lazy`, dynamic `import()`** — the standard mechanisms for triggering code splitting at specific points in an application.
