# Latency, Throughput, and the Numbers Everyone Should Know

"Fast" and "scalable" get used interchangeably in casual conversation, but they measure different things, and a system can be strong on one while weak on the other. Separating them precisely is one of the highest-leverage habits you can build.

## Latency vs. throughput

**Latency** is how long a single operation takes — the time from sending a request to receiving its response. Measured in time (milliseconds, microseconds).

**Throughput** is how many operations a system can complete per unit of time. Measured in a rate (requests/second, rows/second, bytes/second).

They're related but not interchangeable. A single checkout-lane grocery store has some fixed latency per customer (time to scan and pay) and a throughput determined by that latency and the number of lanes. Adding more lanes increases throughput without changing any individual customer's latency. Conversely, a faster cashier reduces latency, which also happens to increase throughput on a single lane — but the two levers are independent, and most of system design is about knowing which one you're actually pulling.

**Batching is the clearest place the two pull against each other.** If a service waits to accumulate 100 write requests before flushing them to disk together, throughput goes up (writes to disk are more efficient in bulk), but the first request in that batch now waits for 99 others to arrive — its latency got worse. This exact trade-off — batch for throughput, at the cost of the latency of whatever's waiting in the batch — reappears in message queues, database writes, and network protocols throughout this course.

## The latency numbers worth memorizing

Every layer you add between "the data" and "the request" costs time, and the costs at different layers differ by orders of magnitude — not by small percentages. Internalizing the *relative* size of these costs (exact numbers vary by hardware and shift over time) is what lets you reason about a design without benchmarking it first.

| Operation | Approximate latency |
|---|---|
| L1 cache reference | 1 ns |
| Main memory (RAM) reference | 100 ns |
| Send 1 KB over a 1 Gbps network | 10 µs |
| Random read, 4 KB, from SSD | ~16 µs |
| Round trip within the same data center | ~0.5 ms |
| Disk seek (spinning disk) | ~10 ms |
| Round trip across the continental US | ~40–60 ms |
| Round trip across the world (e.g. US ↔ Europe/Asia) | ~150 ms+ |

A trick for making these land: imagine an L1 cache reference (1 ns) stretched out to 1 second. On that scale, a main memory reference (100 ns) takes about 100 seconds — under two minutes. An SSD read (~16 µs) takes about 4.5 hours. A round trip within the same data center (~0.5 ms) takes about 6 days. A round trip to another continent (~150 ms) takes about **4.5 years**.

The pattern to take away: **memory is close and cheap, disk is farther and more expensive, and the network — especially across any real distance — is by far the most expensive thing you can put on a critical path.** This single fact is the reason caching exists, the reason CDNs place data physically closer to users, and the reason "just add a network call" is never a free decision in a design.

## Percentiles, not averages

If you measure the latency of every request a service handles over an hour and take the average, you'll get a number that hides the thing you most need to know: how bad is the *worst* common case?

Say 99% of requests finish in 20 ms, and 1% take 2 seconds (a cold cache, a garbage collection pause, a retry after a dropped connection — there's always a reason). The average will look reasonable — around 40 ms — but 1 in 100 users is having a genuinely bad experience, and the average told you nothing about it.

This is why latency is reported as **percentiles**: p50 (median — half of requests are faster than this), p95, p99, and sometimes p999. p50 tells you about the typical request. p99 and p999 tell you about the requests your most engaged or unluckiest users are actually experiencing, and they're what SLAs (service level agreements) are usually written against.

<div class="diagram-wrap">
<svg viewBox="0 0 600 230" width="600" height="230" role="img" aria-label="Distribution of request latencies showing a long tail, with p50 and p99 marked">
  <rect x="55" y="80" width="30" height="110" class="d-block d-block-request"></rect>
  <rect x="90" y="105" width="30" height="85" class="d-block d-block-request"></rect>
  <rect x="125" y="130" width="30" height="60" class="d-block d-block-request"></rect>
  <rect x="160" y="150" width="30" height="40" class="d-block d-block-request"></rect>
  <rect x="195" y="163" width="30" height="27" class="d-block d-block-request"></rect>
  <rect x="230" y="172" width="30" height="18" class="d-block d-block-request"></rect>
  <rect x="265" y="178" width="30" height="12" class="d-block d-block-request"></rect>
  <rect x="300" y="182" width="30" height="8" class="d-block d-block-request"></rect>
  <rect x="335" y="184" width="30" height="6" class="d-block d-block-request"></rect>
  <rect x="370" y="185" width="30" height="5" class="d-block d-block-request"></rect>
  <rect x="405" y="180" width="30" height="10" class="d-block d-block-blocked"></rect>
  <rect x="440" y="172" width="30" height="18" class="d-block d-block-blocked"></rect>
  <rect x="475" y="178" width="30" height="12" class="d-block d-block-blocked"></rect>
  <line x1="45" y1="190" x2="560" y2="190" class="d-axis"></line>
  <text x="565" y="194" class="d-label-muted">latency →</text>
  <line x1="140" y1="60" x2="140" y2="190" class="d-marker-line"></line>
  <text x="140" y="50" text-anchor="middle" class="d-label">p50</text>
  <line x1="450" y1="60" x2="450" y2="190" class="d-marker-line"></line>
  <text x="450" y="50" text-anchor="middle" class="d-label">p99</text>
</svg>
<div class="diagram-caption">Most requests cluster fast and close together (left). A small fraction — the tail — take far longer (highlighted bars, right). The average would land somewhere in the dense left cluster and completely miss that tail; p99 is what tells you it exists.</div>
</div>

Tail latency also compounds in a way that's easy to underestimate: if a single user-facing request internally fans out to, say, 50 backend calls in parallel, and each of those calls has a 1% chance of hitting the slow tail, the odds that *at least one* of the 50 hits it is much higher than 1% — the overall request is only as fast as its slowest dependency. This is one of the strongest arguments for caring about p99 (or worse) rather than the average, and it's a big part of why timeouts, retries with backoff, and redundant requests to multiple replicas ("hedged requests") show up so often in real systems.

## Why this matters for system design

- Every design decision that adds a network hop, a disk read, or a lock has a latency cost you can now roughly place on the table above — use it to reason about where time is actually going.
- Whether you're optimizing for latency or throughput changes the design: a system serving live user requests usually optimizes for low latency (especially at p99), while a batch analytics pipeline usually optimizes for throughput and can tolerate high latency per item.
- When you evaluate a design later in this course — a cache, a queue, a replicated database — ask "does this reduce latency, increase throughput, or trade one for the other?" That question alone will surface most of the interesting trade-offs.
