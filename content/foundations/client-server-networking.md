# Client-Server Model & Networking Basics

Every system design conversation eventually comes down to: *something* sends a request, and *something else* handles it. Before we can talk about caches, databases, or load balancers, we need a precise mental model of what actually happens when two machines "talk" to each other. That's what this section builds.

## The client-server model

A **client** initiates a request. A **server** listens for requests and responds. That's the entire model — nothing more is assumed about hardware, ownership, or scale. A phone app is a client to your API server. Your API server, in turn, is a *client* of the database server it queries. Roles are relative to a given exchange, not fixed properties of a machine.

This matters because "the client" and "the server" in a real system are rarely a single machine each. "The server" is usually a fleet of identical processes behind a load balancer; "the client" might be a browser, a mobile app, another backend service, or a script. Everything you'll learn about scaling later is really about scaling one side (usually the server side) of this basic relationship.

## Addressing: how one machine finds another

To send a request, a client needs an address. On the internet, that address is an **IP address** — a numeric identifier (like `93.184.216.34` for IPv4, or a longer hex form for IPv6) that routers use to move data from source to destination across networks.

Humans don't work well with numeric addresses, so we use **DNS (Domain Name System)** as a lookup layer: you type `example.com`, and before any request is sent, your machine asks a DNS resolver "what IP address is this name pointing to right now?" DNS is effectively a distributed, heavily-cached key-value store mapping names to IPs — and it's worth remembering that fact, because you'll see the same read-heavy, cache-friendly pattern again when we get to caching and CDNs.

A DNS lookup involves multiple hops in the worst case (your resolver → root servers → TLD servers → the domain's authoritative name server), but in practice almost every lookup is served from a cache at your ISP or OS level, which is why it usually feels instant.

## Ports: which application on that machine

An IP address gets you to a *machine*. A **port** (a number from 0–65535) tells that machine which application should handle the request. A single server can run a web server on port 443, a database on port 5432, and an SSH daemon on port 22, all reachable at the same IP address but routed to different processes based on port number.

Convention assigns default ports to common protocols — 80 for HTTP, 443 for HTTPS, 22 for SSH — but these are conventions, not laws of physics; anything can listen on any port.

## TCP: reliable delivery over an unreliable network

The internet's underlying packet-delivery layer (IP) makes no promises: packets can arrive out of order, get duplicated, or simply vanish. Almost nothing you build could tolerate that directly, so most application traffic rides on **TCP (Transmission Control Protocol)**, which adds:

- **Ordering** — bytes arrive in the order they were sent, even if the underlying packets didn't.
- **Reliability** — lost packets are detected (via sequence numbers and acknowledgments) and retransmitted.
- **Flow control** — a fast sender won't overwhelm a slow receiver's buffer.
- **Congestion control** — senders back off when the network itself looks congested, so one connection doesn't starve others.

TCP is **connection-oriented**: before any data flows, client and server perform a **three-way handshake** (`SYN` → `SYN-ACK` → `ACK`) to agree on starting sequence numbers and confirm both sides are ready. This handshake costs at least one full network round-trip before a single byte of your actual request is sent — which is why connection reuse (see "keep-alive" below) matters so much for performance.

<div class="diagram-wrap">
<svg viewBox="0 0 600 400" width="600" height="400" role="img" aria-label="Sequence diagram of a TCP three-way handshake followed by an HTTP request and response">
  <defs>
    <marker id="arrowRequest" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowResponse" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
  <rect x="50" y="16" width="140" height="36" rx="6" class="d-actor-box"></rect>
  <text x="120" y="39" text-anchor="middle" class="d-actor-label">Client</text>
  <line x1="120" y1="52" x2="120" y2="380" class="d-lifeline"></line>
  <rect x="410" y="16" width="140" height="36" rx="6" class="d-actor-box"></rect>
  <text x="480" y="39" text-anchor="middle" class="d-actor-label">Server</text>
  <line x1="480" y1="52" x2="480" y2="380" class="d-lifeline"></line>
  <line x1="120" y1="90" x2="474" y2="90" class="d-msg d-request" marker-end="url(#arrowRequest)"></line>
  <text x="300" y="82" text-anchor="middle" class="d-label">SYN</text>
  <line x1="480" y1="140" x2="126" y2="140" class="d-msg d-response" marker-end="url(#arrowResponse)"></line>
  <text x="300" y="132" text-anchor="middle" class="d-label">SYN-ACK</text>
  <line x1="120" y1="190" x2="474" y2="190" class="d-msg d-request" marker-end="url(#arrowRequest)"></line>
  <text x="300" y="182" text-anchor="middle" class="d-label">ACK</text>
  <rect x="90" y="205" width="420" height="32" rx="6" class="d-note"></rect>
  <text x="300" y="226" text-anchor="middle" class="d-note-text">TCP connection established</text>
  <line x1="120" y1="285" x2="474" y2="285" class="d-msg d-request" marker-end="url(#arrowRequest)"></line>
  <text x="300" y="277" text-anchor="middle" class="d-label">GET /users/42</text>
  <line x1="480" y1="335" x2="126" y2="335" class="d-msg d-response" marker-end="url(#arrowResponse)"></line>
  <text x="300" y="327" text-anchor="middle" class="d-label">200 OK</text>
</svg>
<div class="diagram-caption">The connection has to be fully established — one round trip of SYN / SYN-ACK / ACK — before the client's actual request can be sent. Everything above the "connection established" line is pure overhead paid on every new connection.</div>
</div>

The alternative, **UDP (User Datagram Protocol)**, skips all of this: no handshake, no ordering guarantees, no retransmission. It's faster and lower-overhead, which is why it's used where occasional loss is tolerable and latency matters more than perfect delivery — video calls, DNS lookups, online gaming, and increasingly, HTTP/3 (which runs over a UDP-based protocol called QUIC specifically to avoid some of TCP's handshake and head-of-line-blocking costs).

> **The trade-off to internalize:** reliability isn't free — it costs round-trips and complexity. Every time you pick a transport or protocol in system design, you're implicitly deciding how much of that cost you're willing to pay for how much guarantee you need. This exact trade-off (consistency/guarantees vs. latency/throughput) will reappear constantly — in database replication, in message queues, in consensus protocols.

## HTTP: the protocol most systems are built on

**HTTP (HyperText Transfer Protocol)** is an application-layer protocol built on top of TCP. It defines a simple request-response format:

```
GET /users/42 HTTP/1.1
Host: api.example.com
Accept: application/json

→

HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: 57

{"id": 42, "name": "Ada Lovelace"}
```

A few properties worth internalizing:

- **HTTP is stateless.** Each request is handled independently — the server isn't required to remember anything about previous requests from the same client. Any "state" (like a logged-in session) has to be carried explicitly, usually via a cookie or token sent with every request. This statelessness is precisely what makes it possible to route different requests from the same client to *different* servers behind a load balancer — a foundational idea we'll return to in Scaling Fundamentals.
- **Methods express intent.** `GET` (read, should have no side effects), `POST` (create/submit), `PUT`/`PATCH` (update), `DELETE` (remove). This isn't just style — infrastructure (caches, browsers, proxies) relies on these conventions, e.g. only caching `GET` responses by default.
- **Status codes communicate outcome classes.** `2xx` success, `3xx` redirection, `4xx` client error (you did something wrong — bad input, no auth), `5xx` server error (the server failed, not your fault). Getting this distinction right matters for debugging and for correctly deciding whether a client should retry a request.

**HTTPS** is HTTP layered on top of **TLS (Transport Layer Security)**, which encrypts the connection and verifies the server's identity via certificates. This adds its own handshake on top of TCP's — one reason connection reuse and session resumption matter so much for latency-sensitive services.

## Connection reuse: keep-alive

Given that TCP (and TLS on top of it) requires a handshake before any data flows, opening a fresh connection for every single request would be wasteful — especially over high-latency links. HTTP/1.1 introduced **keep-alive**: the underlying TCP connection stays open and is reused for multiple requests, amortizing the handshake cost. HTTP/2 goes further, allowing multiple requests to be *multiplexed* over a single connection simultaneously rather than queued one after another.

This is a recurring theme you'll see again once you study load balancers and databases: **establishing a connection has a fixed cost, so systems are designed to reuse connections (via pooling) rather than pay that cost per request.**

<div class="diagram-wrap">
<svg viewBox="0 0 600 235" width="600" height="235" role="img" aria-label="Comparison of HTTP/1.1 sequential requests versus HTTP/2 multiplexed requests over a single connection">
  <text x="160" y="35" class="d-label">HTTP/1.1 — sequential requests, one connection</text>
  <rect x="160" y="48" width="80" height="28" rx="4" class="d-block d-block-request"></rect>
  <text x="200" y="66" text-anchor="middle" class="d-block-label">R1</text>
  <rect x="250" y="48" width="80" height="28" rx="4" class="d-block d-block-request"></rect>
  <text x="290" y="66" text-anchor="middle" class="d-block-label">R2</text>
  <rect x="340" y="48" width="80" height="28" rx="4" class="d-block d-block-request"></rect>
  <text x="380" y="66" text-anchor="middle" class="d-block-label">R3</text>
  <text x="160" y="115" class="d-label">HTTP/2 — multiplexed streams, one connection</text>
  <rect x="160" y="128" width="80" height="12" rx="3" class="d-block d-block-request"></rect>
  <rect x="175" y="143" width="80" height="12" rx="3" class="d-block d-block-request"></rect>
  <rect x="190" y="158" width="80" height="12" rx="3" class="d-block d-block-request"></rect>
  <line x1="140" y1="190" x2="480" y2="190" class="d-axis"></line>
  <text x="485" y="194" class="d-label-muted">time →</text>
  <line x1="420" y1="48" x2="420" y2="190" class="d-marker-line"></line>
  <text x="420" y="207" text-anchor="middle" class="d-label-muted">all 3 done</text>
  <line x1="270" y1="128" x2="270" y2="190" class="d-marker-line"></line>
  <text x="270" y="222" text-anchor="middle" class="d-label-muted">all 3 done</text>
</svg>
<div class="diagram-caption">Same three requests (R1, R2, R3), same connection. HTTP/1.1 sends them one at a time, so the third request waits behind the first two. HTTP/2 interleaves them as independent streams over one connection, so they complete in roughly the time of one, not three.</div>
</div>

## Why this matters for system design

Everything above might look like pure networking trivia, but it's the substrate every design decision sits on top of:

- Load balancers work because HTTP is stateless — any server can handle any request.
- Latency budgets (next section) are dominated by round-trips — DNS lookups, TCP handshakes, TLS handshakes — before your application even runs.
- "Use a cache" as advice only makes sense once you've internalized that a repeated lookup (like DNS) is expensive enough over the network that avoiding it is worth the complexity of a cache.
- Choosing between protocols later (REST vs. gRPC vs. message queues) is really choosing how much of TCP/HTTP's guarantees and overhead you want versus something more specialized.

Keep this model — client and server, addressed by IP and port, talking over a connection with a defined cost, exchanging stateless requests — in your head as we build the next layer on top of it.
