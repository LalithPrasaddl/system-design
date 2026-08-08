# Communication Styles: REST, RPC, GraphQL, Sync vs Async

Once you accept that services talk to each other over a network with real cost (previous section), the next question is *how* they should talk. This section covers the two independent choices that shape almost every API decision: whether a call waits for its answer, and what shape that call takes.

## Synchronous vs. asynchronous communication

**Synchronous** communication means the caller blocks — it sends a request and waits, doing nothing else, until a response arrives. This is the default mental model most people start with: call a function, get a return value.

**Asynchronous** communication means the caller doesn't wait for the work to finish. It might get an immediate acknowledgment ("request received") and find out the actual result later — through a callback, a webhook, a message on a queue, or by polling for status.

<div class="diagram-wrap">
<svg viewBox="0 0 600 280" width="600" height="280" role="img" aria-label="Comparison of synchronous and asynchronous request handling">
  <text x="20" y="25" class="d-label">Synchronous</text>
  <rect x="30" y="40" width="120" height="34" rx="6" class="d-actor-box"></rect>
  <text x="90" y="62" text-anchor="middle" class="d-actor-label">Client</text>
  <line x1="90" y1="74" x2="90" y2="130" class="d-lifeline"></line>
  <rect x="430" y="40" width="120" height="34" rx="6" class="d-actor-box"></rect>
  <text x="490" y="62" text-anchor="middle" class="d-actor-label">Server</text>
  <line x1="490" y1="74" x2="490" y2="130" class="d-lifeline"></line>
  <line x1="90" y1="100" x2="484" y2="100" class="d-msg d-request" marker-end="url(#arrowRequestB)"></line>
  <text x="290" y="93" text-anchor="middle" class="d-label-muted">process payment</text>
  <rect x="80" y="108" width="20" height="18" class="d-note"></rect>
  <text x="90" y="121" text-anchor="middle" class="d-note-text" font-size="9">wait</text>
  <line x1="490" y1="130" x2="96" y2="130" class="d-msg d-response" marker-end="url(#arrowResponseB)"></line>
  <text x="290" y="123" text-anchor="middle" class="d-label-muted">result: success</text>
  <text x="20" y="175" class="d-label">Asynchronous</text>
  <rect x="30" y="190" width="120" height="34" rx="6" class="d-actor-box"></rect>
  <text x="90" y="212" text-anchor="middle" class="d-actor-label">Client</text>
  <line x1="90" y1="224" x2="90" y2="270" class="d-lifeline"></line>
  <rect x="430" y="190" width="120" height="34" rx="6" class="d-actor-box"></rect>
  <text x="490" y="212" text-anchor="middle" class="d-actor-label">Server</text>
  <line x1="490" y1="224" x2="490" y2="270" class="d-lifeline"></line>
  <line x1="90" y1="245" x2="484" y2="245" class="d-msg d-request" marker-end="url(#arrowRequestB)"></line>
  <text x="290" y="238" text-anchor="middle" class="d-label-muted">process payment</text>
  <line x1="490" y1="255" x2="96" y2="255" class="d-msg d-response" marker-end="url(#arrowResponseB)"></line>
  <text x="290" y="253" text-anchor="middle" class="d-label-muted">202 accepted (not done yet)</text>
  <text x="290" y="272" text-anchor="middle" class="d-label-muted">client is free — result arrives later via webhook, poll, or queue</text>
  <defs>
    <marker id="arrowRequestB" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowResponseB" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">Synchronous: the client is blocked and idle until the server finishes the work. Asynchronous: the server hands back an acknowledgment almost immediately and does the actual work afterward — the client is free to do other things and finds out the outcome later.</div>
</div>

Neither is strictly better. Synchronous calls are simpler to reason about (the response tells you the outcome, right now) but tie up the caller's resources for as long as the work takes, and a slow downstream server directly becomes a slow caller. Asynchronous calls decouple the caller from that latency and let the server smooth out bursts of demand, at the cost of real complexity: the caller now needs a way to find out the eventual result, and the system needs to handle "the request was accepted but the work later failed" as a distinct, real case. This trade-off is the entire reason message queues exist, and it will come back in detail in Building Blocks.

## REST: resources over HTTP

**REST (Representational State Transfer)** models an API as a set of **resources**, each identified by a URL, manipulated with standard HTTP methods:

```
GET    /orders/42        → fetch order 42
POST   /orders           → create a new order
PUT    /orders/42        → replace order 42
DELETE /orders/42        → delete order 42
```

REST's strength is that it leans entirely on HTTP's existing semantics — caching, status codes, and method meanings all just work the way the rest of the web already works, so a REST API is instantly familiar and plays well with browsers, CDNs, and generic HTTP tooling without any special-casing.

Its weakness shows up when the client's needs don't line up neatly with "resources": fetching a user's profile plus their last five orders plus their notification settings might mean three separate REST calls (**under-fetching** — each call returns too little, so you make more calls), or one call that returns a bloated object with fields the client doesn't need (**over-fetching** — each call returns too much). Neither is wrong, exactly, but at scale, both waste round trips or bandwidth.

## RPC: calling a remote function

**RPC (Remote Procedure Call)** models an API as function calls that happen to cross a network — `getUser(42)` rather than `GET /users/42`. Modern RPC frameworks (gRPC is the most common today) define the available calls and their exact data types up front in a schema, generate client and server code from it, and typically serialize data in a compact binary format (protocol buffers, for gRPC) instead of JSON.

This buys real performance (smaller payloads, less parsing overhead) and strong typing (the schema catches mismatches at compile time, not in production), which is why RPC is the default choice for internal service-to-service calls inside a company's own infrastructure, where you control both ends. It costs flexibility: a change to the schema has to be coordinated across every client, and the tight binary format and generated code make it a poor fit for public APIs consumed by anyone (a browser can't casually call a gRPC endpoint the way it calls a REST one, without extra tooling).

## GraphQL: the client asks for the shape it wants

**GraphQL** takes a different approach to the over/under-fetching problem: instead of the server deciding what each endpoint returns, the client sends a query describing exactly which fields it wants, potentially across multiple related resources, in a single request:

```graphql
{
  user(id: 42) {
    name
    recentOrders(limit: 5) { id, total }
    notificationSettings { emailEnabled }
  }
}
```

One request, no under-fetching (everything needed came back) and no over-fetching (nothing unneeded came back). This is genuinely valuable for clients with varied, evolving data needs — mobile apps in particular, where every unnecessary byte and round trip has a real cost.

The cost moves to the server: it now has to support arbitrary combinations of nested queries rather than a fixed set of endpoints, which makes caching much harder (there's no stable URL per "resource" to cache against the way REST has), and it makes it easier for a client to accidentally request something expensive (a deeply nested query touching many records) without the server having decided in advance that was a reasonable thing to ask for.

## Choosing between them

| | Best fit | Main cost |
|---|---|---|
| REST | Public APIs, anything that should benefit from HTTP caching | Over/under-fetching for complex clients |
| RPC (gRPC) | Internal service-to-service calls you control both ends of | Tight coupling to a schema; poor fit for public/browser clients |
| GraphQL | Clients with varied, evolving data needs (esp. mobile/frontend) | Harder server-side caching; risk of expensive, unbounded queries |

None of these replace the sync-vs-async decision — a REST, RPC, or GraphQL call can each be made either synchronously or asynchronously. The two choices (shape of the call, and whether it blocks) are independent, and a real system usually ends up using more than one combination for different parts of the same architecture: a public REST API in front, internal gRPC calls between backend services, and an asynchronous queue for anything that doesn't need to happen before the response is returned.
