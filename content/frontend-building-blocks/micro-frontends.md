# Micro-Frontends & Multi-Team Scaling

Partitioning & Sharding split data across machines because no single machine could hold or serve all of it. Micro-frontends split a frontend for a different reason entirely — not because no single browser tab could run it, but because no single team can keep changing it without constantly stepping on every other team also changing it. This is an organizational scaling problem, wearing an architectural costume.

## What actually gets split

A large frontend — an e-commerce site, say — is broken into pieces along team ownership lines: navigation and search, the product page, checkout, reviews, each built, tested, and deployed independently by the team that owns it end-to-end, then composed into one page a user experiences as a single, seamless site.

<div class="diagram-wrap">
<svg viewBox="0 0 620 240" width="620" height="240" role="img" aria-label="A shell application composing three independently owned micro-frontends at runtime">
  <rect x="220" y="30" width="180" height="40" rx="8" class="d-actor-box" data-role="compute"></rect>
  <text x="310" y="55" text-anchor="middle" class="d-actor-label" font-size="12">Shell App</text>
  <rect x="30" y="150" width="170" height="40" rx="6" class="d-actor-box"></rect>
  <text x="115" y="171" text-anchor="middle" class="d-actor-label" font-size="11">Nav & Search</text>
  <text x="115" y="185" text-anchor="middle" class="d-label-muted" font-size="9">Team A</text>
  <rect x="225" y="150" width="170" height="40" rx="6" class="d-actor-box"></rect>
  <text x="310" y="171" text-anchor="middle" class="d-actor-label" font-size="11">Product Page</text>
  <text x="310" y="185" text-anchor="middle" class="d-label-muted" font-size="9">Team B</text>
  <rect x="420" y="150" width="170" height="40" rx="6" class="d-actor-box"></rect>
  <text x="505" y="171" text-anchor="middle" class="d-actor-label" font-size="11">Checkout</text>
  <text x="505" y="185" text-anchor="middle" class="d-label-muted" font-size="9">Team C</text>
  <line x1="270" y1="70" x2="130" y2="146" class="d-msg d-request" marker-end="url(#arrowMf)"></line>
  <line x1="310" y1="70" x2="310" y2="146" class="d-msg d-request" marker-end="url(#arrowMf)"></line>
  <line x1="350" y1="70" x2="490" y2="146" class="d-msg d-request" marker-end="url(#arrowMf)"></line>
  <defs>
    <marker id="arrowMf" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">The shell app loads and mounts each piece at runtime. Each one is built, tested, and released on its owning team's own schedule — the whole point is that Team C can ship a checkout change without asking Team A to redeploy anything.</div>
</div>

## Composition approaches

- **Build-time integration** — each micro-frontend is published as a package and pulled into one application at build time. Simple, but it undercuts the main promise: shipping any single piece still means rebuilding and redeploying the whole composed app.
- **Runtime integration via iframes** — the strongest isolation available: each piece runs in its own JavaScript context and can't accidentally break another's CSS or global state. That same isolation makes shared layout, cross-piece communication, and consistent scrolling behavior genuinely awkward.
- **Runtime integration via JS composition** (module federation and similar) — a lightweight shell loads and mounts each piece into a shared page at runtime, as in the diagram above. This delivers real independent deploys without an iframe's overhead, but the pieces now share one JavaScript runtime and DOM — a global CSS class collision or a JS global leaking from one team's code can break another team's piece in a way an iframe boundary would have prevented.

## The cost side

None of this is free, and it's worth stating plainly rather than only celebrating the independence it buys: each piece may ship its own copy of a shared UI library or framework, inflating the total bytes a user downloads unless the shell deliberately shares those dependencies; keeping a consistent look and feel across pieces built by different teams takes active design-system discipline that a single codebase gets for free; and there are simply more moving parts to deploy, monitor, and debug across a failure. This is the same "more independent pieces, more coordination cost" trade every partitioning decision in this course makes — just paid in engineering process instead of infrastructure.

## When it's worth it

The trigger here is unusual for this course: it's team count, not traffic or data volume. A single team can maintain a frontend far larger than intuition suggests without needing to split anything. Splitting too early creates the coordination overhead above — duplicate deploy pipelines, cross-team negotiation over shared components — without the payoff it was meant to buy, since there's no team-boundary friction yet to relieve. It tends to earn its cost once multiple teams are genuinely blocked on each other's release cycles inside the same codebase, not before.

## Why this matters for system design

This page is really the same discipline as the rest of the course, aimed at a different kind of limit: don't add a boundary — a shard, a service, a micro-frontend — until a specific, named limit has actually been hit, and can name what it is. Here, that limit is measured in team friction rather than requests per second or bytes per shard, but the underlying judgment call is identical.

## Real-world examples

- **Module Federation** (Webpack 5, and now other bundlers) — a common mechanism for loading independently built JavaScript applications into one page at runtime.
- **single-spa** — a framework specifically built for composing multiple frontend frameworks or independently deployed micro-frontends into one application.
- Large organizations with many product teams contributing to one site (retail and media companies are commonly cited) are the typical adopters — the pattern earns its cost roughly in proportion to how many independent teams are shipping to the same frontend.
