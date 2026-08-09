# Backend-for-Frontend & API Shape

Communication Styles covered REST, RPC, and GraphQL as protocol choices. This page is about a narrower and very practical question that sits on top of that choice: what shape should an API return for a *specific* screen, and why many real systems end up with an API layer that exists to serve exactly one frontend, rather than one generic API serving everyone.

## Overfetching and underfetching

A generic REST endpoint returns a fixed shape — every field a "user" object has, whether or not the screen calling it uses all of them (**overfetching**, wasted bandwidth, worse on mobile than on a desktop connection). The opposite problem shows up just as often: a single screen needs data from several endpoints — a profile, and separately, recent orders — so it has to make several round trips to assemble what's conceptually one view (**underfetching**). Neither is a bug in the API; it's a mismatch between one general-purpose shape and many different screens' actual needs.

## REST vs. GraphQL from the client's seat

A REST endpoint's shape is fixed and its URL doubles as a cache key, which is exactly what makes HTTP caching (Client-Side Data & Caching) work with zero extra effort. GraphQL flips this: the client specifies precisely the fields and shape it wants in a single request, which directly solves both overfetching and underfetching — but that same flexibility is what breaks simple URL-based caching (a query is usually a `POST` with a body, not a cacheable `GET`), and it moves a new kind of risk onto the server: a deeply nested, client-authored query can be expensive to resolve, so a GraphQL server has to guard against query cost and depth the way a REST endpoint never had to. This is a genuine trade-off, not a strict upgrade in either direction.

## The Backend-for-Frontend pattern

<div class="diagram-wrap">
<svg viewBox="0 0 620 240" width="620" height="240" role="img" aria-label="A web client and a mobile client, each with their own backend-for-frontend layer, both talking to the same shared backend services">
  <rect x="20" y="30" width="90" height="34" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="65" y="52" text-anchor="middle" class="d-actor-label" font-size="12">Web Client</text>
  <rect x="20" y="170" width="90" height="34" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="65" y="192" text-anchor="middle" class="d-actor-label" font-size="12">Mobile Client</text>
  <rect x="180" y="30" width="110" height="34" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="235" y="52" text-anchor="middle" class="d-actor-label" font-size="12">Web BFF</text>
  <rect x="180" y="170" width="110" height="34" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="235" y="192" text-anchor="middle" class="d-actor-label" font-size="12">Mobile BFF</text>
  <rect x="400" y="70" width="180" height="100" rx="8" class="d-actor-box"></rect>
  <text x="490" y="115" text-anchor="middle" class="d-actor-label" font-size="12">Backend Services</text>
  <text x="490" y="135" text-anchor="middle" class="d-label-muted" font-size="10">Users, Orders, Inventory...</text>
  <line x1="110" y1="47" x2="176" y2="47" class="d-msg d-request" marker-end="url(#arrowBff)"></line>
  <line x1="110" y1="187" x2="176" y2="187" class="d-msg d-request" marker-end="url(#arrowBff)"></line>
  <line x1="290" y1="55" x2="396" y2="95" class="d-msg d-request" marker-end="url(#arrowBff)"></line>
  <line x1="290" y1="179" x2="396" y2="150" class="d-msg d-request" marker-end="url(#arrowBff)"></line>
  <defs>
    <marker id="arrowBff" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">Each client gets an API shaped for exactly what it needs — the mobile BFF can trim fields aggressively for a constrained connection, the web BFF can afford to send more — without either client waiting on changes to a shared, one-size-fits-all contract, and without the backend services needing to know or care which frontend is asking.</div>
</div>

A **backend-for-frontend** is a thin API layer that exists for one specific client, aggregating and reshaping calls to the real backend services into exactly what that client's screens need. It directly answers the overfetching/underfetching problem — a mobile app's BFF can combine three backend calls into one trimmed-down response tailored to a phone screen and a slower connection, while a web BFF serving the same underlying data can shape it differently for a desktop view — without either client depending on one shared, general-purpose contract that has to compromise between them.

## Why this matters for system design

A BFF is another network hop and another service to run, load-balance, and keep available (Load Balancing) — it's not free, and a system with only one client type usually doesn't need one at all. It earns its cost specifically when multiple, meaningfully different clients exist, and it tends to track team boundaries as much as technical ones: the team that owns a mobile app often owns its BFF too, deploying it on their own schedule instead of waiting on a shared backend team — the same organizational logic that shows up again, at a larger scale, in Micro-Frontends & Multi-Team Scaling.

## Real-world examples

- **Netflix** — commonly cited for popularizing the BFF pattern to serve very different device types (TVs, phones, browsers) from one backend.
- **GitHub's GraphQL API (v4)** and **Shopify's Storefront API** — production GraphQL APIs built to let each client request exactly the shape it needs.
- **Apollo Server** and **Apollo Federation** — tooling for building a GraphQL layer that composes several backend services behind one client-facing graph, a GraphQL-flavored take on the same aggregation idea.
