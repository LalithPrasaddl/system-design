# Rate Limiter as a Service

A rate limiter answers one question — *has this caller used up their allowance?* — for every request in the system, and it has to answer faster than the work it is protecting. The hard part is not counting. It is counting consistently across a fleet of servers, in under a millisecond, without becoming the outage it was installed to prevent.

<!-- tab:requirements:Requirements -->

## Requirements

A rate limiter sits in front of everything else, which makes its non-functional requirements unusually load-bearing: a limiter that is slow makes every request slow, and a limiter that is down can take the entire API with it.

### Functional requirements

- **Decide:** given a caller and a resource, return allow or deny.
- **Multiple rules:** limits can be defined per API key, per IP, and per endpoint, with different tiers for different customers (free vs. paid).
- **Standard headers:** tell the caller where they stand — remaining allowance, when it resets, and how long to wait after a rejection.
- **Live configuration:** limits can be changed, added, or removed without redeploying the fleet.
- **Exemptions:** specific callers (internal services, health checks) can bypass limits entirely.

### Non-functional requirements

- **Very low latency.** The limiter runs before the work, on every request, so its cost is pure overhead. Budget **under 2ms at p99**, and treat anything above that as a bug rather than a tuning opportunity.
- **Fail open, deliberately.** If the limiter is unavailable, requests are allowed rather than rejected. A limiter outage should degrade protection, not availability — this is a real trade-off and it is revisited in Security & Abuse Prevention, because "fail open" is also an attack.
- **Approximately correct is correct enough.** Briefly allowing 105 requests against a limit of 100 is fine. Adding 20ms of coordination to make it exactly 100 is not. This single decision shapes every algorithm choice that follows.
- **Horizontally scalable.** Decisions and counters both grow by adding machines.
- **Cheap.** The limiter must cost meaningfully less than the work it protects, or it is not worth running.

### In scope

Counting, the allow/deny decision, rule configuration, and the distributed coordination that makes a fleet-wide limit mean something.

### Out of scope

Authentication (assume the caller's identity has already been resolved into a stable `caller_id`), network-layer DDoS mitigation (volumetric floods are dropped upstream, before a request ever reaches something that can run application logic), and long-horizon quota metering for billing — monthly quotas are an accounting problem with completely different latency and durability requirements.

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

The numbers below assume the limiter fronts a large public API. As always the inputs are assumptions; the method is the point.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Peak decisions</div>
<div class="stat-tile-value">~1<span class="stat-tile-unit">M/sec</span></div>
<div class="stat-tile-sub">one per request, no exceptions</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Latency budget</div>
<div class="stat-tile-value">&lt;2<span class="stat-tile-unit">ms p99</span></div>
<div class="stat-tile-sub">pure overhead on every call</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Active counters</div>
<div class="stat-tile-value">~2<span class="stat-tile-unit">M</span></div>
<div class="stat-tile-sub">of 50M known callers, per minute</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Counter memory</div>
<div class="stat-tile-value">~200<span class="stat-tile-unit">MB</span></div>
<div class="stat-tile-sub">tiny — if the algorithm is chosen well</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Counter store nodes</div>
<div class="stat-tile-value">~20</div>
<div class="stat-tile-sub">1M ops/sec at ~100K/node, with headroom</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Overhead target</div>
<div class="stat-tile-value">&lt;1<span class="stat-tile-unit">%</span></div>
<div class="stat-tile-sub">of the cost of the protected request</div>
</div>
</div>

### Assumptions

- The API serves 1 million requests/sec at peak.
- 50 million distinct callers exist; roughly 2 million are active in any given minute.
- About 200 distinct rules are configured across all tiers and endpoints.

### Decision throughput

Every request needs a decision, so decision throughput *is* request throughput: **1 million decisions/sec at peak**. There is no cache-hit ratio to hide behind here and no read/write asymmetry to exploit — unlike the URL shortener, where a cache absorbed 95% of traffic, every single request reaches this system.

### Counter memory — and why the algorithm decides it

This is the number that eliminates an entire algorithm.

A **counter-based** approach stores one small record per active caller per window: roughly 100 bytes for a key, a count, and a timestamp. 2 million active counters × 100 bytes ≈ **200MB**. That fits in memory on a single machine, with room to spare.

A **sliding window log** stores the timestamp of every individual request instead, so it can compute an exact count over any trailing interval. At 1M requests/sec with a 60-second window, that is 60 million timestamps live at any moment, at ~16 bytes each ≈ **1GB** — five times the memory, plus a write on every request and a range-scan on every read, rather than a single increment.

Same requirement, same traffic, a 5x memory difference and a far worse access pattern. That gap is why production limiters are almost never built on logs.

### Counter store sizing

A single in-memory counter node handles on the order of 100,000 simple operations/sec. One million decisions/sec therefore needs **at least 10 nodes**, and closer to **20** once you leave headroom for peaks, node failure, and uneven key distribution. The counters must be partitioned ([Partitioning & Sharding](#/systems/partitioning-sharding)) by caller, which conveniently is also the key the decision is made on.

### Network cost

If every decision is a remote call, the fleet makes 1 million round trips/sec to the counter store. Each one is maybe 0.3-0.5ms on a local network — inside the latency budget, but it means the limiter's availability is now bounded by the counter store's availability, and its latency floor is a network hop. Stage 3 of the Architecture attacks exactly this.

### Overhead sanity check

If a typical protected request costs 50ms of real work, a 1ms limiter is 2% overhead. If the protected request costs 5ms, the same limiter is 20% overhead and the design needs to change. Always size the limiter against the thing it guards, not against an absolute target.

<!-- tab:api-design:API Design -->

## API Design

A rate limiter has two genuinely separate interfaces with opposite characteristics, and conflating them is a common design mistake.

- The **data plane** answers `check` — a million times a second, in under a millisecond.
- The **control plane** manages rules — a handful of times a day, where correctness and auditability matter and latency does not.

### Data plane: the check

```
CheckRequest {
  caller_id:  "acme-corp"
  resource:   "POST /v1/search"
  cost:       1            // some endpoints consume more than one unit
}
```

```
CheckResponse {
  allowed:    false
  limit:      100
  remaining:  0
  reset_at:   1789243260   // unix seconds
  retry_after: 23          // seconds
  rule_id:    "tier-free-search"
}
```

This is deliberately **not** JSON over HTTP. At a million calls per second inside a 2ms budget, the serialization and connection overhead of an HTTP/JSON round trip is a meaningful fraction of the budget. In practice the check is a binary RPC (gRPC or similar) over a pooled connection, or — as Stage 3 argues — not a network call at all most of the time.

Note `cost`: not every request is worth the same. A search that fans out to five backends can consume five units against the same allowance, which lets one rule express "20 cheap calls or 4 expensive ones" without a second rule.

### What the protected API returns

When the limiter denies, the API in front of the caller returns:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 23
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1789243260
```

The headers are worth sending on **successful** responses too, not just rejections. A well-behaved client that can see `X-RateLimit-Remaining: 3` can slow itself down before it gets rejected; a client that only learns its limit by hitting it has no choice but to hit it. This turns rate limiting from a purely adversarial control into a cooperative one for the majority of callers who are not attacking anything.

`Retry-After` matters more than it looks. Without it, every rejected client retries on its own schedule, and the natural schedule is "immediately" — see Bottlenecks & Trade-offs for what that does at a window boundary.

### Control plane: rules

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/rules` | List all configured rules |
| POST | `/v1/rules` | Create a rule |
| PUT | `/v1/rules/{rule_id}` | Update a rule |
| DELETE | `/v1/rules/{rule_id}` | Remove a rule |
| GET | `/v1/usage/{caller_id}` | Current consumption, for support and debugging |

```
POST /v1/rules
{
  "rule_id":   "tier-free-search",
  "match":     { "tier": "free", "resource": "POST /v1/search" },
  "limit":     100,
  "window":    "1m",
  "algorithm": "sliding_window_counter",
  "burst":     20
}
```

Rule changes propagate to the fleet within seconds and are versioned, because "who lowered the limit on our biggest customer at 3am" is a question that gets asked eventually.

<!-- tab:data-model:Data Model -->

## Data Model

The two interfaces above map onto two stores with almost nothing in common.

### Rules — small, cold, read-mostly

```
rules
  rule_id      VARCHAR      PRIMARY KEY
  match_tier   VARCHAR      NULL
  match_caller VARCHAR      NULL       -- a specific caller overrides their tier
  resource     VARCHAR      NOT NULL
  limit_count  INT          NOT NULL
  window_sec   INT          NOT NULL
  algorithm    VARCHAR      NOT NULL
  burst        INT          NULL
  updated_at   TIMESTAMP    NOT NULL
```

A few hundred rows, changed a few times a day, read on every single request. That last part sounds alarming until you notice the first two: this entire table is small enough to hold in each app server's memory and refresh every few seconds. The rule lookup should never be a network call.

### Counters — tiny, hot, disposable

```
key:   rl:{rule_id}:{caller_id}:{window_start}
value: count
ttl:   window_sec * 2
```

Three properties make this work:

**The key includes the window.** When the window rolls over, requests naturally start writing to a new key. Nothing has to reset anything.

**The TTL does the cleanup.** Old windows expire on their own, which is why 50 million known callers only cost memory for the 2 million currently active. There is no sweeper job to write, schedule, or debug — the single most underrated property of putting counters in a store with expiry.

**Nothing here is durable, on purpose.** If the counter store restarts and loses everything, the worst outcome is that every caller gets a fresh allowance for one window. That is a rounding error in enforcement, which means the counter store never needs replication for durability — only for availability.

### Choosing the algorithm

The algorithm is the core design decision, and it is entirely a trade between memory, accuracy, and burst behavior.

| Algorithm | Memory per caller | Accuracy | Notes |
|---|---|---|---|
| Fixed window | 1 counter | Poor at boundaries | Can allow 2x the limit across a window edge — see Deep Dives |
| Sliding window log | 1 timestamp per request | Exact | 5x the memory here, plus a range scan per decision |
| Sliding window counter | 2 counters | Very good | Weighted blend of the current and previous window |
| Token bucket | 2 values (tokens, timestamp) | Good | Allows controlled bursts, which is usually what you want |
| Leaky bucket | 2 values (level, timestamp) | Good | Enforces a smooth output rate; queues rather than bursts |

**The working default is a sliding window counter**, with **token bucket** where bursts should be allowed deliberately — an API that permits 100/minute usually *wants* a client to be able to fire 20 at once after being idle, rather than being forced into an artificially even trickle.

Both store a constant, tiny amount of state per caller, and both avoid the fixed window's boundary flaw. The architecture that follows works with either.

<!-- tab:architecture:Architecture:default -->

This case study builds the limiter up in four stages, each one triggered by a specific failure of the stage before it. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one decision at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. In-Process Counter -->

## Stage 1 — An In-Process Counter

The simplest limiter that works: a map in the application's own memory, keyed by caller. Increment, compare against the limit, allow or reject. No network, no dependencies, decisions in microseconds.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 600 250" width="600" height="250" role="img" aria-label="A limiter inside an app server checking an in-memory counter before passing a request to the handler">
  <rect x="20" y="100" width="90" height="36" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="65" y="122" text-anchor="middle" class="d-actor-label">Client</text>
  <g data-fail-toggle="lim1">
    <rect x="190" y="100" width="110" height="36" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="245" y="122" text-anchor="middle" class="d-actor-label">Limiter</text>
  </g>
  <rect x="190" y="180" width="110" height="32" rx="6" class="d-actor-box" data-role="cache"></rect>
  <text x="245" y="200" text-anchor="middle" class="d-actor-label" font-size="11">Counter (RAM)</text>
  <g data-fail-toggle="hand1">
    <rect x="400" y="100" width="110" height="36" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="455" y="122" text-anchor="middle" class="d-actor-label">Handler</text>
  </g>
  <line id="s1r-client-lim" x1="112" y1="110" x2="186" y2="110" class="d-msg d-request" data-depends-on="lim1" marker-end="url(#arrowR1)"></line>
  <line id="s1r-lim-client" x1="186" y1="126" x2="112" y2="126" class="d-msg d-response" data-depends-on="lim1" marker-end="url(#arrowR1r)"></line>
  <line id="s1r-lim-counter" x1="235" y1="138" x2="235" y2="176" class="d-msg d-request" data-depends-on="lim1" marker-end="url(#arrowR1)"></line>
  <line id="s1r-counter-lim" x1="255" y1="176" x2="255" y2="138" class="d-msg d-response" data-depends-on="lim1" marker-end="url(#arrowR1r)"></line>
  <line id="s1r-lim-handler" x1="302" y1="104" x2="396" y2="104" class="d-msg d-request" data-depends-on="lim1 hand1" marker-end="url(#arrowR1)"></line>
  <line id="s1r-handler-lim" x1="396" y1="120" x2="302" y2="120" class="d-msg d-response" data-depends-on="hand1" marker-end="url(#arrowR1r)"></line>
  <text x="300" y="238" text-anchor="middle" class="d-label-muted" font-size="10">follow an allowed request, then a denied one — watch which boxes each touches</text>
  <defs>
    <marker id="arrowR1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowR1r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "mem", "title": "Counter, in this process", "rows": [["acme-corp · used", "42 / 100"], ["decision", "—"]]}
],
"flows": [
{
"id": "allowed",
"label": "Request allowed",
"nodes": ["lim1", "hand1"],
"steps": [
{"el": "s1r-client-lim", "payload": "POST /v1/search", "text": "A request arrives from caller acme-corp."},
{"el": "s1r-lim-counter", "payload": "increment", "set": {"mem.acme-corp · used": "43 / 100"}, "text": "The limiter increments this caller's counter. It lives in this process's own memory, so the read and write cost microseconds — no network, no serialization, nothing to fail."},
{"el": "s1r-counter-lim", "payload": "43", "set": {"mem.decision": "allow"}, "text": "43 is under the limit of 100."},
{"el": "s1r-lim-handler", "payload": "POST /v1/search", "text": "Allowed, so the request is handed to the code that does the real work."},
{"el": "s1r-handler-lim", "payload": "200 OK", "ms": 45, "text": "The handler spends 45ms serving the request. That cost is exactly what the limiter exists to ration."},
{"el": "s1r-lim-client", "payload": "200 OK", "text": "Response goes back, carrying the caller's remaining allowance in its headers."}
]
},
{
"id": "denied",
"label": "Request denied",
"nodes": ["lim1", "hand1"],
"steps": [
{"el": "s1r-client-lim", "payload": "POST /v1/search", "set": {"mem.acme-corp · used": "100 / 100"}, "text": "The same caller again, now sitting exactly on their limit."},
{"el": "s1r-lim-counter", "payload": "increment", "text": "Increment and compare, exactly as before."},
{"el": "s1r-counter-lim", "payload": "101", "set": {"mem.decision": "deny"}, "text": "Over the limit."},
{"el": "s1r-lim-client", "payload": "429", "text": "Rejected. Note what did not happen: the handler was never called, so none of that 45ms was spent. Cheap rejection of expensive work is the entire economic argument for a rate limiter."}
]
}
]
}
</script>
<div class="diagram-caption">The allowed path costs 45ms of real work; the denied path costs almost nothing and never reaches the handler. Compare the two flows' elapsed readouts.</div>
</div>

<div class="fail-hint">Click the limiter or the handler to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="lim1">
<strong>If the limiter fails:</strong> it is in-process, so "the limiter failed" and "the app server failed" are the same event — there is no independent failure mode to reason about yet. That tight coupling is the one genuine advantage of this design: the limiter cannot be a separate thing that goes down.
</div>
<div class="failure-impact is-hidden" data-component="hand1">
<strong>If the handler fails:</strong> the limiter still decides correctly and still rejects over-limit callers, but allowed requests have nothing to serve them. Worth noticing that the counter keeps incrementing for requests that ultimately failed — whether a failed request should consume allowance is a real product question, and most systems say yes, because otherwise an attacker gets unlimited free retries against a broken endpoint.
</div>
</div>

This is genuinely correct — for exactly one server. The moment there are two, each keeps its own counter, and a caller limited to 100/minute gets 100 per server per minute. With twenty servers behind a load balancer, the effective limit is 2,000, and it silently changes every time the fleet autoscales.

<!-- stage:2:2. Shared Counter Store -->

## Stage 2 — A Shared Counter Store

Move the counters out of each process and into one store every app server talks to ([Caching](#/systems/caching) covers the same in-memory-store machinery from the caching angle). Now the fleet shares one view of each caller's usage, and the limit means what it says no matter which server answers.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 620 290" width="620" height="290" role="img" aria-label="Two app servers behind a load balancer, both incrementing counters in one shared counter store">
  <rect x="10" y="125" width="80" height="34" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="50" y="147" text-anchor="middle" class="d-actor-label" font-size="12">Client</text>
  <rect x="125" y="125" width="60" height="34" rx="6" class="d-actor-box" data-role="routing"></rect>
  <text x="155" y="147" text-anchor="middle" class="d-actor-label" font-size="12">LB</text>
  <rect x="230" y="60" width="120" height="36" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="290" y="82" text-anchor="middle" class="d-actor-label" font-size="11">App Server A</text>
  <g data-fail-toggle="appb2">
    <rect x="230" y="160" width="120" height="36" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="290" y="182" text-anchor="middle" class="d-actor-label" font-size="11">App Server B</text>
  </g>
  <g data-fail-toggle="redis2">
    <rect x="440" y="105" width="120" height="50" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="500" y="126" text-anchor="middle" class="d-actor-label" font-size="11">Counter Store</text>
    <text x="500" y="141" text-anchor="middle" class="d-label-muted" font-size="9">shared by the fleet</text>
  </g>
  <line id="s2r-client-lb" x1="92" y1="138" x2="121" y2="138" class="d-msg d-request" marker-end="url(#arrowR2)"></line>
  <line id="s2r-lb-client" x1="121" y1="150" x2="92" y2="150" class="d-msg d-response" marker-end="url(#arrowR2r)"></line>
  <line id="s2r-lb-appa" x1="187" y1="132" x2="226" y2="84" class="d-msg d-request" marker-end="url(#arrowR2)"></line>
  <line id="s2r-lb-appb" x1="187" y1="146" x2="226" y2="172" class="d-msg d-request" data-depends-on="appb2" marker-end="url(#arrowR2)"></line>
  <line id="s2r-appa-redis" x1="352" y1="82" x2="436" y2="118" class="d-msg d-request" data-depends-on="redis2" marker-end="url(#arrowR2)"></line>
  <line id="s2r-redis-appa" x1="436" y1="128" x2="352" y2="92" class="d-msg d-response" data-depends-on="redis2" marker-end="url(#arrowR2r)"></line>
  <line id="s2r-appb-redis" x1="352" y1="170" x2="436" y2="148" class="d-msg d-request" data-depends-on="appb2 redis2" marker-end="url(#arrowR2)"></line>
  <line id="s2r-redis-appb" x1="436" y1="138" x2="352" y2="180" class="d-msg d-response" data-depends-on="redis2" marker-end="url(#arrowR2r)"></line>
  <text x="310" y="275" text-anchor="middle" class="d-label-muted" font-size="10">follow both flows in order — the second picks up exactly where the first left off</text>
  <defs>
    <marker id="arrowR2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowR2r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "shared", "title": "Shared counter store", "rows": [["rl:search:acme-corp", "42 / 100"], ["decision", "—"]]}
],
"flows": [
{
"id": "via-a",
"label": "Request routed to server A",
"nodes": ["appb2", "redis2"],
"steps": [
{"el": "s2r-client-lb", "payload": "POST /v1/search", "text": "A request from acme-corp arrives at the load balancer."},
{"el": "s2r-lb-appa", "payload": "→ server A", "text": "The load balancer picks server A. Which one it picks should not matter — that is what this stage is here to guarantee."},
{"el": "s2r-appa-redis", "payload": "INCR acme", "ms": 1, "set": {"shared.rl:search:acme-corp": "43 / 100"}, "text": "Server A increments the shared counter. This is a network round trip that Stage 1 did not have to make — about 1ms, every request, forever."},
{"el": "s2r-redis-appa", "payload": "43", "set": {"shared.decision": "allow"}, "text": "Under the limit."},
{"el": "s2r-lb-client", "payload": "200 OK", "ms": 45, "text": "Served."}
]
},
{
"id": "via-b",
"label": "Next request routed to server B",
"nodes": ["appb2", "redis2"],
"steps": [
{"el": "s2r-client-lb", "payload": "POST /v1/search", "set": {"shared.rl:search:acme-corp": "43 / 100"}, "text": "The same caller, moments later. The load balancer has no reason to send them to the same server, and no memory of having sent them anywhere."},
{"el": "s2r-lb-appb", "payload": "→ server B", "text": "This time it picks server B."},
{"el": "s2r-appb-redis", "payload": "INCR acme", "ms": 1, "set": {"shared.rl:search:acme-corp": "44 / 100"}, "text": "Server B increments the same key and continues from 43. Under Stage 1's design this request would have started a fresh counter at 1 — the caller would have had two independent allowances instead of one."},
{"el": "s2r-redis-appb", "payload": "44", "set": {"shared.decision": "allow"}, "text": "Still under the limit, correctly, fleet-wide."},
{"el": "s2r-lb-client", "payload": "200 OK", "ms": 45, "text": "Served."}
]
}
]
}
</script>
<div class="diagram-caption">Play the first flow, then the second. The counter carries over between two different servers — that continuity is the whole reason for the extra network hop.</div>
</div>

<div class="fail-hint">Click app server B or the counter store to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="appb2">
<strong>If an app server fails:</strong> the load balancer routes around it exactly as it would for any stateless server ([Load Balancing](#/systems/load-balancing)). Nothing about rate limiting is affected, because no limiter state lives on the server any more. This is the good kind of failure and it is a direct consequence of moving the counters out.
</div>
<div class="failure-impact is-hidden" data-component="redis2">
<strong>If the counter store fails:</strong> every app server loses the ability to make a decision at once — the limiter has become a hard dependency of every single request in the system, and there is exactly one of it. The requirements said fail open, so requests would be allowed through unchecked, meaning a counter-store outage silently removes all protection from the entire API. This is the failure Stage 3 is built to survive.
</div>
</div>

Two problems now. Every request pays a network round trip it did not pay before, and the counter store is a single point of failure that happens to sit in front of everything. At a million decisions per second, it is also well past what one node can serve.

<!-- stage:3:3. Shard, Batch, and Fail Open -->

## Stage 3 — Shard, Batch, and Fail Open

Three changes, each aimed at one of Stage 2's problems. Partition the counter store so no single node carries the whole load. Have each app server check out a **block** of allowance at a time instead of one unit per request, so most decisions need no network call at all. And make the failure path explicit: if the store cannot answer, allow the request.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 660 290" width="660" height="290" role="img" aria-label="An app server with a local allowance budget, falling back to a sharded counter store when the budget runs out">
  <rect x="15" y="120" width="80" height="36" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="55" y="142" text-anchor="middle" class="d-actor-label" font-size="12">Client</text>
  <g data-fail-toggle="app3r">
    <rect x="170" y="120" width="130" height="36" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="235" y="142" text-anchor="middle" class="d-actor-label" font-size="11">App Server</text>
  </g>
  <rect x="170" y="185" width="130" height="34" rx="6" class="d-actor-box" data-role="cache"></rect>
  <text x="235" y="200" text-anchor="middle" class="d-actor-label" font-size="11">Local budget</text>
  <text x="235" y="213" text-anchor="middle" class="d-label-muted" font-size="9">a block of allowance</text>
  <rect x="360" y="110" width="90" height="56" rx="6" class="d-note"></rect>
  <text x="405" y="134" text-anchor="middle" class="d-note-text" font-size="11">hash(caller)</text>
  <text x="405" y="149" text-anchor="middle" class="d-note-text" font-size="11">% N</text>
  <g data-fail-toggle="shard0r">
    <rect x="480" y="55" width="140" height="36" rx="5" class="d-actor-box" data-role="cache"></rect>
    <text x="550" y="77" text-anchor="middle" class="d-actor-label" font-size="11">Counter shard 0</text>
  </g>
  <g data-fail-toggle="shard1r">
    <rect x="480" y="140" width="140" height="36" rx="5" class="d-actor-box" data-role="cache"></rect>
    <text x="550" y="162" text-anchor="middle" class="d-actor-label" font-size="11">Counter shard 1</text>
  </g>
  <line id="s3r-client-app" x1="97" y1="132" x2="166" y2="132" class="d-msg d-request" data-depends-on="app3r" marker-end="url(#arrowR3)"></line>
  <line id="s3r-app-client" x1="166" y1="146" x2="97" y2="146" class="d-msg d-response" data-depends-on="app3r" marker-end="url(#arrowR3r)"></line>
  <line id="s3r-app-local" x1="220" y1="158" x2="220" y2="181" class="d-msg d-request" data-depends-on="app3r" marker-end="url(#arrowR3)"></line>
  <line id="s3r-local-app" x1="250" y1="181" x2="250" y2="158" class="d-msg d-response" data-depends-on="app3r" marker-end="url(#arrowR3r)"></line>
  <line id="s3r-app-hash" x1="302" y1="126" x2="356" y2="122" class="d-msg d-request" data-depends-on="app3r" marker-end="url(#arrowR3)"></line>
  <line id="s3r-hash-app" x1="356" y1="154" x2="302" y2="150" class="d-msg d-response" marker-end="url(#arrowR3r)"></line>
  <line id="s3r-hash-shard0" x1="452" y1="120" x2="476" y2="78" class="d-msg d-request" data-depends-on="shard0r" marker-end="url(#arrowR3)"></line>
  <line id="s3r-hash-shard1" x1="452" y1="144" x2="476" y2="155" class="d-msg d-request" data-depends-on="shard1r" marker-end="url(#arrowR3)"></line>
  <text x="330" y="275" text-anchor="middle" class="d-label-muted" font-size="10">play the refill flow, then fail counter shard 1 and play it again</text>
  <defs>
    <marker id="arrowR3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowR3r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "local", "title": "This server's local budget", "rows": [["units held", "37"], ["decision", "—"]]},
{"id": "shard", "title": "Counter shard 1", "rows": [["acme-corp · remaining", "50 / 100"]]}
],
"flows": [
{
"id": "local-hit",
"label": "Served from local budget",
"nodes": ["app3r", "shard0r", "shard1r", "s3r-hash-shard0"],
"steps": [
{"el": "s3r-client-app", "payload": "POST /v1/search", "text": "A request arrives. This is the common case — roughly 49 out of every 50."},
{"el": "s3r-app-local", "payload": "take 1", "set": {"local.units held": "36", "local.decision": "allow"}, "text": "The server already holds a block of this caller's allowance. It decrements its own memory and decides immediately: no network call, no serialization, nothing that can time out."},
{"el": "s3r-local-app", "payload": "ok, 36 left", "text": "Decision made in microseconds. This is how a million decisions a second fit inside a 2ms budget — most of them never leave the process."},
{"el": "s3r-app-client", "payload": "200 OK", "ms": 45, "text": "Served. The limiter added essentially nothing to this request."}
]
},
{
"id": "refill",
"label": "Local budget exhausted — refill",
"nodes": ["app3r", "shard0r", "shard1r", "s3r-hash-shard0"],
"steps": [
{"el": "s3r-client-app", "payload": "POST /v1/search", "set": {"local.units held": "0", "local.decision": "—"}, "text": "A request arrives and this server's block is empty."},
{"el": "s3r-app-local", "payload": "take 1", "text": "Nothing left to take locally."},
{"el": "s3r-local-app", "payload": "empty", "text": "Only now does the server need the shared store."},
{"el": "s3r-app-hash", "payload": "need 50", "ms": 1, "text": "It asks for a block of 50, not a single unit. One round trip is amortized across the next fifty requests, which is what turns a per-request network cost into a per-fifty-request one."},
{"el": "s3r-hash-shard1", "payload": "DECRBY 50", "ms": 1, "altEl": "s3r-hash-app", "altMs": 0, "altSet": {"local.decision": "allow (unchecked)"}, "set": {"shard.acme-corp · remaining": "0 / 100"}, "text": "This caller's key hashes to shard 1. Sharding by caller is what lets the store absorb a million operations a second, and it costs nothing in correctness because a caller's counter is only ever read and written by that caller's requests.", "altText": "Shard 1 does not answer. The limiter now makes the decision the requirements demanded: allow the request rather than reject it. Protection is degraded — this caller is momentarily unlimited — but the API stays up."},
{"el": "s3r-hash-app", "payload": "granted 50", "set": {"local.units held": "50", "local.decision": "allow"}, "altSet": {"local.decision": "allow (unchecked)"}, "text": "Fifty units handed to this server, to spend without asking again.", "altText": "Nothing was granted and nothing was checked — the request simply proceeds. Every request will do this until the shard recovers, so this state needs to be alarmed on loudly."},
{"el": "s3r-app-client", "payload": "200 OK", "ms": 45, "text": "Served."}
]
}
]
}
</script>
<div class="diagram-caption">Play the refill flow with everything healthy, then fail counter shard 1 and play it again — the same flow takes the fail-open branch instead of stopping. Blocks of allowance are also why fleet-wide enforcement is now approximate: units held by a server that crashes are simply lost until the window rolls.</div>
</div>

<div class="fail-hint">Click the app server or either counter shard to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="app3r">
<strong>If an app server fails:</strong> requests route elsewhere, and whatever allowance that server had checked out but not yet spent is lost. The caller is under-served by up to one block until the window resets — which is the precise price of batching, and the reason block sizes are kept modest rather than as large as possible.
</div>
<div class="failure-impact is-hidden" data-component="shard0r">
<strong>If counter shard 0 fails:</strong> only callers whose keys hash onto shard 0 are affected, and for them the limiter fails open. Every other caller is still enforced normally. Compare this to Stage 2, where the equivalent failure removed protection from everyone at once — this is the same blast-radius argument that sharding makes everywhere else ([Partitioning & Sharding](#/systems/partitioning-sharding)).
</div>
<div class="failure-impact is-hidden" data-component="shard1r">
<strong>If counter shard 1 fails:</strong> the same as shard 0, for a different slice of callers. Replay the refill flow with this failed to watch a request take the fail-open path instead of halting. Note that servers holding unspent blocks keep enforcing correctly until those blocks run out, so protection degrades gradually rather than vanishing at the instant of failure.
</div>
</div>

Inside one region this design holds up: sub-millisecond for most decisions, a bounded blast radius per shard, and a defined answer when the store is unreachable. The remaining problem only appears when the API is served from more than one place.

<!-- stage:4:4. Multi-Region -->

## Stage 4 — Multi-Region

A caller in Singapore hits the Singapore region; a caller in Virginia hits the Virginia region. Each region has its own counter store, because a cross-region round trip is 100-200ms — fifty to a hundred times the entire latency budget. So a global limit of 100/minute has to be enforced by stores that cannot talk to each other synchronously ([Multi-Region & Disaster Recovery](#/systems/multi-region-dr), [Consistency & CAP](#/systems/consistency-cap)).

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 660 300" width="660" height="300" role="img" aria-label="Two regions each with their own app server and counter store, reconciled by an asynchronous aggregator">
  <text x="20" y="30" class="d-label-muted" font-size="10">REGION A</text>
  <rect x="15" y="45" width="80" height="34" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="55" y="67" text-anchor="middle" class="d-actor-label" font-size="11">Client</text>
  <rect x="140" y="45" width="110" height="34" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="195" y="67" text-anchor="middle" class="d-actor-label" font-size="11">App tier A</text>
  <g data-fail-toggle="storeA">
    <rect x="300" y="45" width="120" height="34" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="360" y="67" text-anchor="middle" class="d-actor-label" font-size="11">Counters A</text>
  </g>
  <text x="20" y="190" class="d-label-muted" font-size="10">REGION B</text>
  <rect x="15" y="200" width="80" height="34" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="55" y="222" text-anchor="middle" class="d-actor-label" font-size="11">Client</text>
  <rect x="140" y="200" width="110" height="34" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="195" y="222" text-anchor="middle" class="d-actor-label" font-size="11">App tier B</text>
  <g data-fail-toggle="storeB">
    <rect x="300" y="200" width="120" height="34" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="360" y="222" text-anchor="middle" class="d-actor-label" font-size="11">Counters B</text>
  </g>
  <g data-fail-toggle="agg4">
    <rect x="490" y="120" width="130" height="44" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="555" y="139" text-anchor="middle" class="d-actor-label" font-size="11">Aggregator</text>
    <text x="555" y="154" text-anchor="middle" class="d-label-muted" font-size="9">asynchronous</text>
  </g>
  <line id="s4r-clienta-appa" x1="97" y1="56" x2="136" y2="56" class="d-msg d-request" marker-end="url(#arrowR4)"></line>
  <line id="s4r-appa-clienta" x1="136" y1="70" x2="97" y2="70" class="d-msg d-response" marker-end="url(#arrowR4r)"></line>
  <line id="s4r-appa-storea" x1="252" y1="56" x2="296" y2="56" class="d-msg d-request" data-depends-on="storeA" marker-end="url(#arrowR4)"></line>
  <line id="s4r-storea-appa" x1="296" y1="70" x2="252" y2="70" class="d-msg d-response" data-depends-on="storeA" marker-end="url(#arrowR4r)"></line>
  <line id="s4r-clientb-appb" x1="97" y1="211" x2="136" y2="211" class="d-msg d-request" marker-end="url(#arrowR4)"></line>
  <line id="s4r-appb-clientb" x1="136" y1="225" x2="97" y2="225" class="d-msg d-response" marker-end="url(#arrowR4r)"></line>
  <line id="s4r-appb-storeb" x1="252" y1="211" x2="296" y2="211" class="d-msg d-request" data-depends-on="storeB" marker-end="url(#arrowR4)"></line>
  <line id="s4r-storeb-appb" x1="296" y1="225" x2="252" y2="225" class="d-msg d-response" data-depends-on="storeB" marker-end="url(#arrowR4r)"></line>
  <line id="s4r-storea-agg" x1="424" y1="68" x2="488" y2="128" class="d-msg d-response" data-depends-on="agg4" marker-end="url(#arrowR4r)"></line>
  <line id="s4r-agg-storea" x1="488" y1="138" x2="424" y2="78" class="d-msg d-response" data-depends-on="agg4" marker-end="url(#arrowR4r)"></line>
  <line id="s4r-storeb-agg" x1="424" y1="210" x2="488" y2="152" class="d-msg d-response" data-depends-on="agg4" marker-end="url(#arrowR4r)"></line>
  <line id="s4r-agg-storeb" x1="488" y1="142" x2="424" y2="220" class="d-msg d-response" data-depends-on="agg4" marker-end="url(#arrowR4r)"></line>
  <text x="330" y="288" text-anchor="middle" class="d-label-muted" font-size="10">play all three flows in order to watch a global limit be exceeded, then corrected</text>
  <defs>
    <marker id="arrowR4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowR4r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "ra", "title": "Region A's view", "rows": [["acme-corp · count", "0"]]},
{"id": "rb", "title": "Region B's view", "rows": [["acme-corp · count", "0"]]},
{"id": "g", "title": "Actual global total", "rows": [["acme-corp · count", "0"]]}
],
"flows": [
{
"id": "in-a",
"label": "21 requests in Region A",
"nodes": ["storeA", "storeB", "agg4"],
"steps": [
{"el": "s4r-clienta-appa", "payload": "POST /v1/search", "text": "A burst of requests from acme-corp lands in region A."},
{"el": "s4r-appa-storea", "payload": "INCR ×21", "ms": 1, "set": {"ra.acme-corp · count": "21", "g.acme-corp · count": "21"}, "text": "Region A counts them locally. It does not consult region B, and it must not — that round trip is 100ms+, fifty times the entire latency budget."},
{"el": "s4r-storea-appa", "payload": "21", "text": "21 against a global limit of 100. Comfortably allowed."},
{"el": "s4r-appa-clienta", "payload": "200 OK", "ms": 45, "text": "Served."}
]
},
{
"id": "in-b",
"label": "Same caller, now in Region B",
"nodes": ["storeA", "storeB", "agg4"],
"steps": [
{"el": "s4r-clientb-appb", "payload": "POST /v1/search", "set": {"ra.acme-corp · count": "21", "g.acme-corp · count": "21"}, "text": "The same caller now sends traffic that lands in region B — a different office, a failover, or simply a client with servers on two continents."},
{"el": "s4r-appb-storeb", "payload": "INCR ×85", "ms": 1, "set": {"rb.acme-corp · count": "85", "g.acme-corp · count": "106"}, "text": "Region B counts 85 requests. Its store has never heard of region A's 21."},
{"el": "s4r-storeb-appb", "payload": "85", "text": "85 is under 100, so region B allows every one of them."},
{"el": "s4r-appb-clientb", "payload": "200 OK", "ms": 45, "text": "Both regions behaved correctly by their own view, and the caller has now made 106 requests against a global limit of 100. Nothing is broken; this is the documented consequence of refusing to pay a cross-region round trip per request."}
]
},
{
"id": "reconcile",
"label": "Reconciliation",
"nodes": ["storeA", "storeB", "agg4"],
"steps": [
{"el": "s4r-storea-agg", "payload": "A: 21", "ms": 500, "set": {"ra.acme-corp · count": "21", "rb.acme-corp · count": "85", "g.acme-corp · count": "106"}, "text": "Every region publishes its local counts to an aggregator on a short interval — around once a second, asynchronously, off the request path."},
{"el": "s4r-storeb-agg", "payload": "B: 85", "ms": 500, "text": "The aggregator sums them: 21 + 85 = 106."},
{"el": "s4r-agg-storea", "payload": "global: 106", "set": {"ra.acme-corp · count": "106"}, "text": "The global total is pushed back to region A, which now knows this caller is over."},
{"el": "s4r-agg-storeb", "payload": "global: 106", "set": {"rb.acme-corp · count": "106"}, "text": "And to region B. From this moment both regions reject the caller. The overshoot lasted about one reconciliation interval, and was bounded by how much traffic the regions could absorb in that window — which is exactly the quantity you tune when you pick the interval."}
]
}
]
}
</script>
<div class="diagram-caption">Play the three flows in order. The gap between the regional views and the actual global total is the price of not coordinating per request, and the reconciliation interval is the dial that sets how large that gap can get.</div>
</div>

<div class="fail-hint">Click either region's counter store or the aggregator to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="storeA">
<strong>If region A's counter store fails:</strong> region A fails open and region B is unaffected — it still enforces its own local view, and still publishes it. Regional isolation means a limiter outage is a regional loss of protection rather than a global one.
</div>
<div class="failure-impact is-hidden" data-component="storeB">
<strong>If region B's counter store fails:</strong> the mirror image. Worth noting that traffic often shifts toward the healthy region during an incident, which means the surviving region sees more load than usual at exactly the moment its global picture is least complete.
</div>
<div class="failure-impact is-hidden" data-component="agg4">
<strong>If the aggregator fails:</strong> nothing stops. Every region keeps enforcing its own local limits, so protection continues at regional granularity; only the global correction stops arriving. A caller could then sustain up to the per-region limit in every region simultaneously. That is a real degradation, but it is a bounded one, and it is why the aggregator sits off the request path — it can be down for minutes without any request failing.
</div>
</div>

An alternative worth knowing: instead of reconciling after the fact, **split the quota up front** — give each region a fixed share of the global limit (100 across four regions becomes 25 each). It is simpler, needs no aggregator, and is exactly correct in the sense that the global limit is never exceeded. It is also wrong most of the time, because traffic is never evenly distributed: a caller sending everything to one region gets 25 instead of 100 while three regions sit on unused allowance. Reconciliation trades exactness for the ability to let allowance follow traffic, and for most APIs that is the better trade.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### Why the fixed window is not good enough

A fixed window counts requests inside clock-aligned buckets: everything between 12:00:00 and 12:00:59 increments one counter, then a new counter starts.

Consider a limit of 100/minute and a caller who sends 100 requests at 12:00:59, then 100 more at 12:01:00. Both bursts are allowed — each is exactly at the limit for its own window. But they are one second apart, so in any two-second interval spanning the boundary the caller achieved **200 requests**, double the limit they agreed to.

This is not a rare edge case. It is the obvious way to attack a fixed-window limiter, it requires no sophistication, and it is why the cheapest algorithm is usually the wrong one.

### The sliding window counter

The fix that keeps the memory profile: keep the current window's counter **and** the previous window's, then estimate the trailing-minute count by weighting the previous window by how much of it is still in view.

At 12:01:15, 25% of the trailing minute falls in the 12:00 window:

```
estimate = current_count + previous_count × 0.75
         = 20            + 100            × 0.75
         = 95
```

The caller is treated as having made 95 requests in the last minute, not 20, so the boundary burst above gets rejected. The estimate assumes requests were spread evenly through the previous window, which is not exactly true — but it is wrong by a small amount in a predictable direction, costs one extra counter, and closes the attack. Two counters and one multiplication is a very good price for that.

### Token bucket, and why bursts are a feature

A token bucket holds up to `burst` tokens and refills at `limit / window` tokens per second. Each request takes one token; empty bucket means rejection.

The behavior this produces is usually what an API actually wants. A client that has been idle for a minute has a full bucket and can fire a burst immediately; a client hammering continuously is smoothly throttled to the refill rate. A sliding window would force the idle client to trickle at the same rate as the aggressive one, which punishes exactly the callers who are behaving well.

It also stores only two values — token count and last-refill timestamp — and the refill is computed lazily at read time, so there is no background timer per caller. For a system with 2 million active callers, "no background job per caller" is not a small detail.

### Making the check atomic

The obvious implementation is broken:

```
count = store.get(key)        # 42
if count >= limit: reject
store.set(key, count + 1)     # 43
```

Two servers running this concurrently both read 42, both decide to allow, both write 43. One request was allowed that should not have been, and the counter is now wrong forever — it lost an increment.

The check must be a single atomic operation on the store:

```
count = store.incr(key)       # atomic, returns the new value
if count == 1: store.expire(key, window)
if count > limit: reject
```

`INCR` returns the post-increment value, so the read and the write are the same operation and no one can interleave. For anything more complex than a plain counter — a token bucket needs to read tokens, compute the refill, subtract, and write back — the operation goes into a server-side script so the whole sequence runs atomically on the store. This is the same class of problem as any other read-modify-write race ([Distributed Locking & Leader Election](#/systems/distributed-locking)), solved here by pushing the operation to where the data lives rather than by taking a lock.

Note the second line: setting the TTL only when the counter is created. Refreshing the TTL on every increment would mean a continuously active caller's window never expires, and their counter would never reset.

### Where the limiter runs

| Placement | Latency | Blast radius | Notes |
|---|---|---|---|
| API gateway | One extra hop | All services behind it | Central config, one place to operate; the gateway becomes a dependency of everything |
| In-process library | None | Per service | Fastest and simplest, but every service must adopt and upgrade it |
| Sidecar proxy | Local socket | Per pod | Language-agnostic without a network hop; more infrastructure to run |
| Dedicated service | Full round trip | Everyone | Independently scalable, but adds the hop Stage 3 spent its effort removing |

Stage 3's local-budget design works in any of these, and is what makes the gateway and library options converge in practice — once most decisions are answered from local memory, the placement question is mostly about who owns configuration rather than about latency.

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### The hot key

Sharding by caller spreads load evenly only if traffic is spread evenly across callers. It never is. One customer running a migration, or one attacker, sends orders of magnitude more traffic than everyone else, and every one of those requests hashes to the same counter key on the same shard.

That shard becomes the bottleneck while its siblings idle. Stage 3's batching is the main defense — a caller sending 100,000 requests/sec against a block size of 50 produces only 2,000 operations/sec on the shard, not 100,000. Where that is not enough, the counter for a known-hot caller can be split into `N` sub-counters (`acme:0` … `acme:9`), each holding a tenth of the allowance, with requests hashed across them. The limit becomes slightly less precise in exchange for spreading a single key's load across ten shards.

### The retry storm at the window boundary

Reject a thousand callers at 12:00:30 and tell them all that their window resets at 12:01:00, and a thousand clients will retry at 12:01:00.000. The limiter converted a smooth overload into a synchronized spike, and the spike lands on the exact instant its counters roll over.

Two fixes, both cheap. Add jitter to `Retry-After` so each client gets a slightly different number. And prefer algorithms without a shared reset instant — a token bucket refills continuously, so there is no single moment when everyone's allowance returns at once. This is the same thundering-herd shape that shows up in cache expiry and in retry backoff generally; the answer is always to desynchronize.

### Accuracy against latency, as a dial

Stage 3's block size is a tunable trade, not a constant:

- **Block size 1** is Stage 2: exact fleet-wide enforcement, one network call per request.
- **Block size 50** is 50x fewer calls, at the cost of up to `50 × (number of servers)` units of over-admission in the worst case, plus whatever is lost when a server dies holding an unspent block.
- **Block size 500** is nearly free per request and enforces almost nothing.

The right size follows from the limit itself. A 100/minute limit cannot use blocks of 50 without effectively doubling the limit across two servers; a 1,000,000/minute limit barely notices. Scale the block to a small fraction of the limit — a few percent — rather than picking one number for every rule.

### Fail open against fail closed

This case study fails open, because it fronts a public API where availability is the priority. That is not universal. A limiter guarding an expensive third-party API you are billed for, or protecting a fragile legacy backend that falls over under load, should fail **closed** — rejecting traffic is cheaper than an unbounded bill or a cascading outage.

The decision belongs per rule, not per system. A well-built limiter lets a rule declare its own failure behavior, because "protect availability" and "protect the thing behind me" are both legitimate and they point in opposite directions.

### What this design is still bad at

**Long-horizon quotas.** Counters with a two-window TTL are the wrong tool for "1 million requests per month". That is durable accounting, and it belongs in a real database with a real audit trail.

**Fair sharing.** Rate limiting caps each caller independently; it does not allocate a contended resource fairly among them. Ten thousand callers each under their individual limit can still collectively saturate a backend. Fair queueing and load shedding are different mechanisms, and a limiter is not a substitute for either.

**Cost-based limiting.** The `cost` field weights requests by expected expense, but it is a guess made before the work happens. A query that turns out to be a thousand times more expensive than predicted already ran.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

A rate limiter is itself a security control, so this section is about attacks on the limiter rather than attacks it defends against ([Security & Authentication](#/systems/security-authentication)).

### Choosing what to key on

The key determines what the limit actually constrains, and every choice is attackable in a different way.

| Key | Weakness |
|---|---|
| IP address | Shared by everyone behind a corporate NAT or a mobile carrier gateway — limiting the IP limits thousands of unrelated users. Cheap to rotate through with a proxy pool. On IPv6, a single subscriber may hold an entire /64, so limit the /64, not the address |
| API key | Strong and stable, but only available after authentication — which means unauthenticated endpoints, including login itself, cannot use it |
| User account | Right for abuse of a specific account; useless against someone creating fresh accounts |
| Device / client fingerprint | Harder to rotate than an IP, but probabilistic and privacy-sensitive |

Real systems layer several: a coarse per-IP limit on unauthenticated endpoints to bound damage before identity is known, then a precise per-key limit once it is. The login endpoint needs both, plus a per-account failure limit, because per-IP alone does not stop a distributed credential-stuffing attack and per-account alone lets one IP walk through a list of usernames.

### Key cardinality is an attack surface

If the key includes anything attacker-controlled and unbounded, the counter store's memory is attacker-controlled and unbounded. Keying on a raw `X-Forwarded-For` value, or on a URL path with an arbitrary suffix, lets an attacker create millions of distinct counters and exhaust the store — using the limiter to take down the thing the limiter protects.

Defenses: hash keys to a fixed-width value, derive the client IP from a trusted proxy header rather than an arbitrary one, normalize paths to their route template (`/v1/users/{id}`, never `/v1/users/8391`), and cap the number of distinct keys any single source can create.

### Fail open is an attack chain

Stage 3 allows requests when the counter store cannot answer. An attacker who can make the counter store unavailable — by overwhelming one shard, or by exploiting the cardinality attack above — has therefore turned off rate limiting entirely, and can then flood freely.

This is a real cost of the availability choice, and it is why the mitigations are structural rather than optional. Shard the store so one hot key cannot take it all down. Bound key cardinality. Alert on fail-open events **immediately and loudly**, because "the limiter is currently allowing everything" is a security incident, not a performance metric. And consider a coarse local fallback — a crude per-process limit, far above normal traffic, applied only while failing open — so that unchecked never quite means unlimited.

### 429 and what not to leak

Return `429 Too Many Requests` for limit rejections, not `503`. A 503 says "this service is broken", which tells well-behaved clients to retry aggressively and back off entirely the wrong way.

The `X-RateLimit-*` headers help legitimate clients self-regulate, but they also tell an attacker exactly how much room they have and when it refills. For most APIs that is an acceptable trade — the same information is trivially discoverable by probing. For sensitive endpoints such as login, send `Retry-After` and nothing else: there is no cooperative client to help, and remaining-attempt counts are genuinely useful to an attacker.

Finally, rejections must be cheap. If a 429 costs a database lookup, an attacker can exhaust the system with requests that are all being rejected — turning the limiter into the amplifier.

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **Decision latency, p50 and p99** — the overhead every request pays. The p99 is the number that matters, because the limiter's whole justification is that its cost is negligible.
- **Local hit ratio** — the fraction of decisions answered from a server's local block without touching the store. If Stage 3 is working this is above 95%; when it drops, store load rises proportionally and latency follows.
- **Allow/deny ratio per rule** — a rule denying almost nothing is probably set too high to matter; a rule denying a large share of traffic is either catching an attack or strangling a legitimate customer, and telling those apart is a daily operational question.
- **Fail-open events** — count and duration, per shard. This is the single most important signal in the system.
- **Per-shard operations/sec and key count** — uneven distribution means a hot key (see Bottlenecks & Trade-offs) or a cardinality problem.
- **Cross-region reconciliation lag** — bounds how far a global limit can be exceeded before correction arrives.

### What to alert on

- **Any sustained fail-open, immediately.** Protection is off. This is the page-someone alert, not a dashboard tile.
- Decision p99 above the budget (say 5ms) for more than a minute — the limiter is now a meaningful part of every request's latency.
- Local hit ratio dropping below its floor, which predicts store overload before the store itself reports trouble.
- A sudden change in deny rate for a single large caller — usually either an incident on their side or a limit change on yours, and both are worth knowing about within minutes.
- Counter-store key count growing without a matching growth in traffic — the signature of a cardinality attack.

### A counter shard just died — what happens?

Exactly what the Stage 3 failure toggles simulate. Callers hashing to that shard fail open; everyone else is unaffected; servers still holding unspent blocks for affected callers keep enforcing until those blocks drain, so protection fades over seconds rather than vanishing.

The runbook: confirm the blast radius is one shard rather than the whole store, check whether the cause was a hot key (if so, split it — see Bottlenecks & Trade-offs), replace the node, and let traffic re-warm. Because counters are disposable, a replacement node needs no restore and no catch-up — it starts empty, and every affected caller gets one fresh window's allowance. That is the operational payoff of deciding in the Data Model that none of this data needs to be durable.

### Rolling out a limit change

Lowering a limit is a breaking change for every caller currently above the new value, and it takes effect for all of them simultaneously. Ship limit reductions the way you would ship any other breaking change: run the new limit in **shadow mode** first, recording what it *would* have rejected without rejecting anything; review which callers that hits; then notify them; then enforce. The shadow-mode counter costs one extra increment per request and prevents the entire category of incident where a config change intended to stop one abusive caller quietly breaks a customer's production integration.

### Capacity planning

Track store operations/sec against per-node capacity, and key count against per-node memory. Because Stage 3 batches, operations grow much more slowly than request volume — which is a benefit and a trap, since it means store load can look comfortable right up until a change in block size or traffic shape moves it sharply. Re-derive the numbers whenever block sizes change, not only when traffic does.
