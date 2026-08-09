# Real-Time Delivery

Communication Styles covered request/response as the default shape of a web interaction: the client always speaks first. That default has a real limit — it has no way for the server to say something the client didn't ask for. A chat message from someone else, a live score update, a collaborator's cursor moving — none of that fits "client asks, server answers." This page covers the four common ways around that limit, in increasing order of how far they bend the request/response model.

<div class="diagram-wrap">
<svg viewBox="0 0 640 280" width="640" height="280" role="img" aria-label="Comparing the connection pattern of polling, long polling, SSE, and WebSockets over the same timeline">
  <text x="75" y="57" text-anchor="end" class="d-label" font-size="12">Polling</text>
  <rect x="90" y="40" width="12" height="24" class="d-block d-block-request"></rect>
  <rect x="158" y="40" width="12" height="24" class="d-block d-block-request"></rect>
  <rect x="226" y="40" width="12" height="24" class="d-block d-block-request"></rect>
  <rect x="294" y="40" width="12" height="24" class="d-block d-block-request"></rect>
  <rect x="362" y="40" width="12" height="24" class="d-block d-block-request"></rect>
  <rect x="430" y="40" width="12" height="24" class="d-block d-block-request"></rect>
  <rect x="498" y="40" width="12" height="24" class="d-block d-block-request"></rect>
  <rect x="566" y="40" width="12" height="24" class="d-block d-block-request"></rect>
  <text x="75" y="111" text-anchor="end" class="d-label" font-size="12">Long polling</text>
  <rect x="90" y="94" width="140" height="24" class="d-block d-block-request"></rect>
  <rect x="236" y="94" width="90" height="24" class="d-block d-block-request"></rect>
  <rect x="332" y="94" width="180" height="24" class="d-block d-block-request"></rect>
  <rect x="518" y="94" width="67" height="24" class="d-block d-block-request"></rect>
  <text x="75" y="165" text-anchor="end" class="d-label" font-size="12">SSE</text>
  <rect x="90" y="148" width="495" height="24" class="d-block d-block-response"></rect>
  <text x="75" y="219" text-anchor="end" class="d-label" font-size="12">WebSocket</text>
  <rect x="90" y="202" width="495" height="24" class="d-block d-block-response"></rect>
  <line x1="90" y1="250" x2="585" y2="250" class="d-axis"></line>
  <text x="592" y="254" class="d-label-muted" font-size="11">time →</text>
</svg>
<div class="diagram-caption">Polling opens and closes a new connection on a fixed schedule, most of them finding nothing new. Long polling holds each connection open until there's actually something to say. SSE and WebSockets skip the repeated setup cost entirely with one connection held open for as long as updates matter — SSE pushes data one direction (server to client); WebSockets carry data both ways.</div>
</div>

## Polling

The client asks "anything new?" on a fixed interval, regardless of whether the answer is ever yes. Trivial to build on plain HTTP, works everywhere, and degrades gracefully — but every empty check is a wasted request, and genuinely new data still waits up to a full interval before the client learns about it. Shortening the interval trades that latency for proportionally more wasted requests.

## Long polling

The client still asks, but the server doesn't answer right away — it holds the request open until it actually has something to send, or a timeout is reached, at which point the client immediately opens another one. This removes most of polling's wasted round trips (a response usually means real news) while still working over plain HTTP with no special protocol. The cost: a new connection still has to be established each cycle, and holding a request open ties up a server-side resource (a thread or connection slot) for however long nothing happens to say.

## Server-Sent Events (SSE)

A single long-lived HTTP connection the server can push events down at any time, with no repeated setup cost at all. It's built directly on top of HTTP — the browser's native `EventSource` API handles reconnection automatically — which makes it simple to adopt, but it's one-directional: the server can push to the client, but the client still needs a normal request to send anything back. Browsers also cap the number of concurrent SSE connections per domain, which matters if a page happens to open several.

## WebSockets

A single long-lived connection, established via an HTTP "upgrade" handshake, that's genuinely bidirectional — either side can send a message at any time without the other having asked. This is the only one of the four that supports the client pushing data unprompted (a chat message, a multiplayer game move) over the same connection it receives updates on. It's also the most expensive to run at scale: a WebSocket connection is stateful and has to stay pinned to whatever server instance accepted it, unlike a stateless HTTP request that any instance behind a load balancer can handle (Load Balancing) — a detail that shapes how these systems are architected, not just how the client talks to them.

## Choosing among them

| Need | Reasonable choice |
|---|---|
| Occasional updates, simplicity is the priority | Polling |
| Updates arrive somewhat rarely, but should show up promptly | Long polling |
| Server broadcasts frequently; client never sends data back over the same channel | SSE |
| True two-way, low-latency exchange (chat, collaborative editing, multiplayer) | WebSockets |

## Why this matters for system design

Holding open a large number of long-lived connections (SSE or WebSockets) is a genuinely different scaling problem than handling stateless requests: the bottleneck shifts from CPU-per-request to memory-per-idle-connection, and a server holding a connection open can't just be swapped for another one the way Scaling Fundamentals assumes for stateless app servers. Fanning an update out to thousands of open connections at once — a live score update reaching every viewer — is usually solved by pairing a WebSocket/SSE-serving tier with a pub-sub layer behind it (Message Queues): the event is published once, and each server holding relevant connections picks it up and pushes it down the ones it owns.

## Real-world examples

- **`EventSource`** — the browser's built-in API for consuming SSE, with automatic reconnection.
- **The `WebSocket` API** — built into every modern browser, no library required for the basic protocol.
- **Socket.IO** — a WebSocket library that adds automatic fallback to long polling when a WebSocket connection isn't available.
- **Pusher, Ably** — managed real-time delivery services that handle the connection-fan-out infrastructure described above.
