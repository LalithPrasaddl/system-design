# Load Balancing

Once you have more than one server capable of handling a request (the previous section's conclusion), something has to decide which server handles each one. That's a load balancer: a component that sits in front of a pool of servers, receives incoming traffic, and distributes it across the pool.

## Why not just pick randomly?

You could, and "random" is in fact a legitimate load-balancing strategy. But a load balancer earning its place in a real architecture usually does more than distribute — it also:

- **Health-checks** the servers behind it, so traffic stops going to one that's crashed or unresponsive, without anyone having to notice and intervene manually.
- **Absorbs failure** — if one server dies, the load balancer routes around it, and from the client's perspective nothing happened.
- **Enables horizontal scaling transparently** — adding or removing servers behind the load balancer doesn't require any change on the client side; the balancer's address is the only thing clients ever need to know.

## Where a load balancer sits: L4 vs. L7

Load balancers are commonly described by which layer of the network stack they operate at:

**Layer 4 (transport layer)** load balancers make routing decisions based on IP address and port alone, without looking at the actual content of the request. They operate on raw TCP/UDP connections, which makes them very fast and protocol-agnostic — they don't need to understand HTTP, or anything else, to do their job.

**Layer 7 (application layer)** load balancers understand the actual protocol being spoken — typically HTTP — and can make routing decisions based on its content: the URL path, headers, cookies, even the request body. This is what lets you do things like "send all `/api/video/*` traffic to the video-processing fleet and everything else to the general web fleet," which an L4 balancer has no way to express since it can't see the path at all.

The trade-off is the usual one: L4 is faster and simpler because it does less; L7 costs more (it has to actually parse the protocol) but can make far smarter decisions.

<div class="diagram-wrap">
<svg viewBox="0 0 600 220" width="600" height="220" role="img" aria-label="A load balancer distributing client requests across a pool of servers using round robin">
  <rect x="20" y="90" width="90" height="40" rx="6" class="d-actor-box"></rect>
  <text x="65" y="114" text-anchor="middle" class="d-actor-label">Clients</text>
  <rect x="200" y="90" width="110" height="40" rx="6" class="d-actor-box"></rect>
  <text x="255" y="114" text-anchor="middle" class="d-actor-label">Load Balancer</text>
  <line x1="110" y1="110" x2="196" y2="110" class="d-msg d-request" marker-end="url(#arrowLB)"></line>
  <rect x="440" y="20" width="120" height="34" rx="6" class="d-actor-box"></rect>
  <text x="500" y="42" text-anchor="middle" class="d-actor-label">Server A</text>
  <rect x="440" y="93" width="120" height="34" rx="6" class="d-actor-box"></rect>
  <text x="500" y="115" text-anchor="middle" class="d-actor-label">Server B</text>
  <rect x="440" y="166" width="120" height="34" rx="6" class="d-actor-box"></rect>
  <text x="500" y="188" text-anchor="middle" class="d-actor-label">Server C</text>
  <line x1="310" y1="105" x2="436" y2="37" class="d-msg d-request" marker-end="url(#arrowLB)"></line>
  <line x1="310" y1="110" x2="436" y2="110" class="d-msg d-request" marker-end="url(#arrowLB)"></line>
  <line x1="310" y1="115" x2="436" y2="183" class="d-msg d-request" marker-end="url(#arrowLB)"></line>
  <text x="230" y="150" class="d-label-muted">round robin, least connections, or by request content (L7)</text>
  <defs>
    <marker id="arrowLB" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">The load balancer is the only address clients ever see. Behind it, the pool of servers can grow, shrink, or have individual members fail without any client noticing — the balancer just stops sending traffic to whichever one is unhealthy.</div>
</div>

## Common routing algorithms

- **Round robin** — requests go to each server in turn, cycling back to the start. Simple, and works well when every server and every request is roughly equal in cost.
- **Least connections** — send the next request to whichever server currently has the fewest active connections. Better than round robin when requests vary a lot in how long they take, since it adapts to actual load rather than assuming every request is equal.
- **Weighted variants** of either — give more powerful servers a higher share of traffic, useful when the pool isn't made of identical machines (e.g. during a gradual hardware upgrade).
- **Consistent hashing / hash-based routing** — route based on some property of the request (e.g. a user ID) so the same client consistently lands on the same server. Useful when you need "stickiness" without a fully stateless design, or when routing to a cache/shard where landing on the same backend matters (this comes back in detail in Partitioning & Sharding).

## Health checks

A load balancer only routes around a failed server if it actually knows the server failed. **Health checks** — periodic requests to a known endpoint (often something like `/healthz`) — are how it finds out. A server that stops responding, or starts responding with errors, gets marked unhealthy and removed from rotation until it recovers. This is what turns "one server crashed" from an incident into a non-event: as long as enough healthy capacity remains, users never see it.

## Where load balancers themselves come from

It's worth noticing the load balancer is now a single thing every request passes through — which raises the same question that started this whole section: what happens if *it* fails? In practice this is solved one level up, using techniques outside individual load balancer instances: DNS can point to multiple load balancer IPs, cloud providers offer managed load balancers that are themselves distributed across multiple machines internally, and some architectures chain load balancers (a DNS-level or hardware layer in front of software load balancers). The pattern — put a resilient, replicated layer in front of anything that could become a single point of failure — is one you'll see again for almost every component in this course.

## Why this matters for system design

A load balancer is what actually makes horizontal scaling real, rather than theoretical: it's the piece that takes "we have five servers" and turns it into "clients experience one reliable service." Every case study later in this course that involves more than one server instance has a load balancer (explicit or implied) doing exactly this job.
