# Scaling Fundamentals

Every building block in the rest of this module — caching, replication, sharding, queues — exists to answer one question: what do you do when a single machine can no longer keep up? This section covers the two fundamental ways to answer that, and the one property of your application that decides how easy the answer is.

## Vertical scaling: a bigger machine

**Vertical scaling** (scaling *up*) means giving a single machine more resources — more CPU, more RAM, faster disks. Your application code doesn't need to change at all; the same single process just has more to work with.

It's the simplest possible way to handle more load, which makes it the right first move for a huge number of real systems. But it has a hard ceiling: at some point you're renting the largest machine that exists, and you're still out of room. It also means a single point of failure — if that one machine goes down, everything relying on it goes down with it.

## Horizontal scaling: more machines

**Horizontal scaling** (scaling *out*) means running the same application across multiple machines and splitting the work between them, usually with a load balancer (next section) in front deciding which machine handles each request.

<div class="diagram-wrap">
<svg viewBox="0 0 600 260" width="600" height="260" role="img" aria-label="Vertical scaling shown as one larger box, horizontal scaling shown as multiple identical boxes behind a load balancer">
  <text x="150" y="30" text-anchor="middle" class="d-label">Vertical scaling</text>
  <rect x="80" y="50" width="140" height="60" rx="6" class="d-actor-box"></rect>
  <text x="150" y="76" text-anchor="middle" class="d-actor-label">Server</text>
  <text x="150" y="94" text-anchor="middle" class="d-label-muted">small</text>
  <text x="470" y="30" text-anchor="middle" class="d-label">Vertical scaling, after</text>
  <rect x="380" y="40" width="180" height="90" rx="6" class="d-actor-box"></rect>
  <text x="470" y="80" text-anchor="middle" class="d-actor-label">Server</text>
  <text x="470" y="100" text-anchor="middle" class="d-label-muted">much bigger</text>
  <text x="300" y="165" text-anchor="middle" class="d-label">Horizontal scaling</text>
  <rect x="270" y="180" width="60" height="34" rx="6" class="d-actor-box"></rect>
  <text x="300" y="201" text-anchor="middle" class="d-label-muted">LB</text>
  <rect x="80" y="230" width="80" height="30" rx="6" class="d-actor-box"></rect>
  <text x="120" y="250" text-anchor="middle" class="d-label-muted">Server</text>
  <rect x="260" y="230" width="80" height="30" rx="6" class="d-actor-box"></rect>
  <text x="300" y="250" text-anchor="middle" class="d-label-muted">Server</text>
  <rect x="440" y="230" width="80" height="30" rx="6" class="d-actor-box"></rect>
  <text x="480" y="250" text-anchor="middle" class="d-label-muted">Server</text>
  <line x1="290" y1="214" x2="120" y2="230" class="d-lifeline"></line>
  <line x1="300" y1="214" x2="300" y2="230" class="d-lifeline"></line>
  <line x1="310" y1="214" x2="480" y2="230" class="d-lifeline"></line>
</svg>
<div class="diagram-caption">Vertical scaling replaces one machine with a bigger one — the architecture doesn't change. Horizontal scaling adds more machines of roughly the same size and distributes work across them — the architecture now has to account for multiple servers.</div>
</div>

Horizontal scaling has no real ceiling — need more capacity, add more machines — and it removes the single point of failure, since one machine going down leaves the others still serving traffic. The cost is architectural complexity: now that a request could land on any of several machines, those machines can no longer casually rely on anything stored only in one place (in-memory session data, a local file written to disk) without that data becoming invisible to requests that land elsewhere.

## The property that makes horizontal scaling easy or hard: statelessness

A server is **stateless** if it doesn't retain any client-specific data between requests — everything it needs to handle a request either comes in with the request itself or lives in a shared store (a database, a cache) that every server instance can reach equally.

Stateless servers are trivial to scale horizontally: any of them can handle any request, so a load balancer can route traffic without any thought to history. This is precisely the property HTTP itself has by default, and it's why "just add more servers behind a load balancer" works as a strategy at all for typical web backends.

A **stateful** server keeps something request-specific in its own memory or local disk — a logged-in session, an in-progress file upload, a WebSocket connection. If a client's next request lands on a *different* server than the one holding that state, that server won't know about it. Common fixes: move the state out to a shared store (put sessions in a shared cache instead of server memory — turning a stateful problem back into a stateless one), or make the load balancer "sticky" (route the same client to the same server every time) — which works but reduces flexibility and puts you back at risk if that specific server fails.

The broader pattern to notice: **most of "how do I scale this" reduces to "how do I make this stateless, or contain the state somewhere both scalable and shared."** Caching, databases, and session stores in later sections are all, in one way or another, answers to where state should actually live once you can no longer keep it on a single application server.

## Scaling reads vs. scaling writes

One more distinction worth making now, because it resurfaces in almost every later topic: scaling *reads* and scaling *writes* are different problems.

Reads are usually easy to scale horizontally — you can serve the same data from as many replicas as you want (see Replication), and add a cache in front to avoid hitting the underlying store at all for popular data. Writes are harder: every write has to eventually be reflected consistently somewhere, and simply adding more machines doesn't automatically make "keep N copies of this data in agreement" easier — in some designs it makes it harder. This asymmetry is why so many scaling techniques (read replicas, caching, CDNs) target reads specifically, while writes usually need a different lever entirely (partitioning/sharding, or accepting weaker consistency guarantees).

## Why this matters for system design

Almost every remaining topic in this course is a specific technique for horizontal scaling done well: load balancers decide how to spread requests, caches reduce how often you need to touch the real data store, replication and partitioning scale a database past what one machine can hold, and queues let you scale write-side work by processing it asynchronously instead of immediately. Keep the vertical/horizontal distinction and the statelessness requirement in mind — they're the frame everything else fits into.
