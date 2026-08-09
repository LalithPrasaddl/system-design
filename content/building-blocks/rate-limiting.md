# Rate Limiting & Backpressure

Every building block so far has been about doing more work faster or more reliably. This one is about the opposite, equally necessary problem: deliberately refusing or slowing down work, on purpose, because accepting all of it would break something.

## Why limit requests at all

A few distinct reasons, worth separating because they call for different responses:

- **Abuse and bugs** — a malicious client hammering an endpoint, or a legitimate client with a retry loop bug, can generate far more load than any real user would.
- **Protecting shared, limited resources** — a downstream dependency (a database, a third-party API with its own limits) can only take so much load before it degrades for everyone, not just the client causing the surge.
- **Fairness** — in a multi-tenant system, one customer's traffic spike shouldn't be able to degrade service for every other customer sharing the same infrastructure.

In every case, the alternative to rate limiting isn't "the system handles it anyway" — it's the system degrading or falling over for everyone, including well-behaved clients, because nothing stopped the excess load from arriving in the first place.

## Token bucket: the standard algorithm

Picture a bucket that holds up to N tokens, refilled at a steady rate (say, 10 tokens per second), up to that maximum. Each incoming request consumes one token. If a token is available, the request proceeds. If the bucket is empty, the request is rejected (or delayed) until a new token arrives.

<div class="diagram-wrap">
<svg viewBox="0 0 600 200" width="600" height="200" role="img" aria-label="Token bucket rate limiting: tokens refill at a steady rate, each request consumes one, requests are rejected when the bucket is empty">
  <rect x="60" y="30" width="120" height="130" rx="10" fill="none" stroke="var(--border)" stroke-width="2"></rect>
  <circle cx="95" cy="130" r="9" class="d-block d-block-request"></circle>
  <circle cx="125" cy="130" r="9" class="d-block d-block-request"></circle>
  <circle cx="155" cy="130" r="9" class="d-block d-block-request"></circle>
  <circle cx="95" cy="105" r="9" class="d-block d-block-request"></circle>
  <circle cx="125" cy="105" r="9" class="d-block d-block-request"></circle>
  <text x="120" y="45" text-anchor="middle" class="d-label-muted" font-size="11">refills at fixed rate</text>
  <text x="120" y="185" text-anchor="middle" class="d-label">bucket (max N tokens)</text>
  <rect x="260" y="90" width="90" height="30" rx="5" class="d-note"></rect>
  <text x="305" y="110" text-anchor="middle" class="d-note-text">request</text>
  <line x1="180" y1="105" x2="256" y2="105" class="d-msg d-request" marker-end="url(#arrowTb)"></line>
  <text x="215" y="98" text-anchor="middle" class="d-label-muted" font-size="10">consumes 1 token</text>
  <rect x="420" y="60" width="130" height="30" rx="5" class="d-block d-block-response"></rect>
  <text x="485" y="80" text-anchor="middle" class="d-block-label">allowed (token spent)</text>
  <rect x="420" y="120" width="130" height="30" rx="5" class="d-block d-block-blocked"></rect>
  <text x="485" y="140" text-anchor="middle" class="d-label" font-size="11">rejected (bucket empty)</text>
  <line x1="350" y1="100" x2="416" y2="75" class="d-lifeline"></line>
  <line x1="350" y1="110" x2="416" y2="135" class="d-lifeline"></line>
  <defs>
    <marker id="arrowTb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">The bucket size controls how large a burst is tolerated at once; the refill rate controls the sustained long-run limit. A client that's been idle can burst up to a full bucket, then is throttled back to the refill rate.</div>
</div>

The bucket size and refill rate are two independent knobs: a large bucket with a slow refill rate tolerates occasional bursts while still capping sustained throughput; a small bucket enforces a much smoother, steadier rate with little tolerance for burstiness at all.

**Leaky bucket** is a close relative with an inverted framing: instead of tokens being consumed, requests themselves enter a queue (the bucket) and are processed ("leaked") at a constant fixed rate, regardless of how bursty their arrival was. Where token bucket allows bursts up to the bucket size to pass through immediately, leaky bucket smooths everything — including bursts — into a steady, constant output rate. The choice between them is really a choice about whether bursty-but-within-budget traffic should be let through immediately (token bucket) or evened out over time (leaky bucket).

Simpler alternatives — **fixed window counters** (allow N requests per calendar minute, reset the count at each minute boundary) — are easy to implement but have a real edge case: a client can send N requests in the last instant of one window and another N in the first instant of the next, achieving 2x the intended rate across that boundary. **Sliding window** variants fix this by considering a rolling time window rather than fixed calendar boundaries, at the cost of slightly more bookkeeping.

## Where rate limiting lives

Rate limiting can be enforced at multiple layers, and real systems often use several at once: at the API gateway or load balancer (before a request reaches any application server at all — the cheapest place to reject excess load), per-service (protecting one specific dependency), or per-user/per-API-key (enforcing fairness or a pricing tier).

A subtlety worth flagging: if a service is horizontally scaled (Scaling Fundamentals) across many instances, each instance can't just track its own local counter — a client hitting a limit of 100 requests/minute could send 100 requests to each of 10 instances and get 1,000 requests through. Enforcing a limit correctly across multiple instances means the counter has to live in a shared store all instances can check — typically a fast, shared cache (Redis is the common choice, precisely because it's fast enough to check on every request without becoming the new bottleneck).

## Backpressure: pushing the signal upstream

Rate limiting rejects excess requests at the edge. **Backpressure** is the related but distinct idea of a system communicating "I can't keep up" *inward*, to whatever's sending it work, rather than silently accepting everything and letting a queue grow without bound or a service fall over under load it never signaled it couldn't handle.

TCP's flow control (Client-Server Model & Networking Basics) is backpressure at the network layer: a receiver advertises how much more data it can currently accept, and a sender is expected to respect that rather than blasting data regardless. The same idea shows up at the application layer: a consumer reading from a message queue (Message Queues) that's falling behind can signal this — by simply not pulling more messages until it's caught up, which is what a **pull-based** consumer model naturally provides, as opposed to a **push-based** model where a producer keeps sending regardless of whether the consumer asked for more.

The alternative to backpressure isn't "no problem happens" — it's the problem happening somewhere less visible and more dangerous: an ever-growing queue that eventually exhausts memory, or a service accepting requests it has no real capacity to process and slowly grinding to a halt for everyone, instead of failing fast and predictably for just the excess load.

## Why this matters for system design

Rate limiting and backpressure are both instances of the same underlying principle: a system that can clearly say "no, not right now" to excess demand is more reliable than one that tries to accept everything and silently degrades. Every case study in this course that's exposed to unpredictable, potentially adversarial, or simply bursty real-world traffic needs some version of this — the specific algorithm matters less than recognizing where the limit needs to be enforced, and what should happen to a request that hits it.

## Real-world examples

- **Redis** — the common shared store for tracking rate-limit counters across multiple service instances (via `INCR` and TTLs, or purpose-built libraries).
- **NGINX** and **Envoy** — reverse proxies with built-in rate-limiting modules, often enforcing limits before a request reaches an application server.
- **Amazon API Gateway, Cloudflare, Kong** — API gateway/edge products with rate limiting as a built-in feature, commonly enforced per API key.
