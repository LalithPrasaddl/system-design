# Go Deeper: Log-Based Systems (Kafka Internals)

The message queues section described queues and topics in terms of behavior — messages go in, get delivered, and (implicitly) disappear once consumed. Kafka, and systems built on the same idea, take a different underlying approach: instead of a queue that removes messages as they're consumed, the fundamental structure is an **append-only log** that consumers read through without ever deleting anything themselves. That single change in data structure has surprisingly large consequences.

## The log as the core abstraction

A log, here, means exactly what it sounds like: an ordered, append-only sequence of records, each identified by its position — its **offset** — in that sequence. Writing means appending to the end. Reading means asking for records starting at a given offset. Nothing is ever removed by the act of reading it.

This is a meaningfully different contract than a traditional queue. In a queue, once a consumer successfully processes a message, it's gone — a second consumer group wanting the same data would get nothing. In a log, consumption doesn't affect the data at all; the log doesn't know or care who's read what. Multiple independent consumer groups can read the same log at completely different paces, and a consumer can rewind and re-read history it's already seen, simply by asking for an earlier offset again.

## Partitions: how a log scales

A single append-only log, on a single machine, is still a single machine's worth of throughput. Kafka's answer is the same one from Partitioning & Sharding: split a **topic** into multiple **partitions**, each an independent ordered log, typically placed on different machines (**brokers**).

<div class="diagram-wrap">
<svg viewBox="0 0 600 260" width="600" height="260" role="img" aria-label="A Kafka topic split into partitions, each an ordered log, consumed by members of a consumer group">
  <text x="20" y="25" class="d-label">Topic: orders (3 partitions)</text>
  <text x="20" y="55" class="d-label-muted" font-size="11">Partition 0</text>
  <rect x="100" y="42" width="40" height="26" class="d-block d-block-request"></rect>
  <rect x="140" y="42" width="40" height="26" class="d-block d-block-request"></rect>
  <rect x="180" y="42" width="40" height="26" class="d-block d-block-request"></rect>
  <rect x="220" y="42" width="40" height="26" class="d-block d-block-blocked"></rect>
  <text x="20" y="95" class="d-label-muted" font-size="11">Partition 1</text>
  <rect x="100" y="82" width="40" height="26" class="d-block d-block-request"></rect>
  <rect x="140" y="82" width="40" height="26" class="d-block d-block-request"></rect>
  <rect x="180" y="82" width="40" height="26" class="d-block d-block-blocked"></rect>
  <text x="20" y="135" class="d-label-muted" font-size="11">Partition 2</text>
  <rect x="100" y="122" width="40" height="26" class="d-block d-block-request"></rect>
  <rect x="140" y="122" width="40" height="26" class="d-block d-block-blocked"></rect>
  <text x="290" y="60" text-anchor="middle" class="d-label-muted" font-size="10">offsets increase →</text>
  <text x="120" y="175" class="d-label">Consumer group: email-service</text>
  <rect x="60" y="190" width="110" height="34" rx="6" class="d-actor-box"></rect>
  <text x="115" y="212" text-anchor="middle" class="d-actor-label">Consumer 1</text>
  <rect x="200" y="190" width="110" height="34" rx="6" class="d-actor-box"></rect>
  <text x="255" y="212" text-anchor="middle" class="d-actor-label">Consumer 2</text>
  <line x1="120" y1="68" x2="115" y2="186" class="d-lifeline"></line>
  <line x1="120" y1="108" x2="255" y2="186" class="d-lifeline"></line>
  <line x1="120" y1="148" x2="255" y2="186" class="d-lifeline"></line>
  <text x="420" y="212" class="d-label-muted" font-size="11">Consumer 2 owns two partitions;</text>
  <text x="420" y="228" class="d-label-muted" font-size="11">each partition has exactly one owner</text>
</svg>
<div class="diagram-caption">Partitions spread a topic's throughput across machines. Within a consumer group, each partition is owned by exactly one consumer at a time — that's how the group parallelizes work without two consumers racing over the same records.</div>
</div>

Producers choose which partition a given record goes to — typically by hashing a key (an order ID, a user ID), exactly like the hash-based sharding from the Partitioning section. This has an important consequence: **ordering is only guaranteed within a single partition**, not across the whole topic. If two events need to be processed in the order they happened (e.g. "order created" then "order shipped" for the same order), they need to share a partition key — which is exactly why you'd key by order ID or user ID rather than something unrelated.

## Consumer groups: how reading scales

A **consumer group** is a set of consumers cooperatively reading a topic, with Kafka dividing the topic's partitions among the group's members — each partition assigned to exactly one consumer within the group at a time, so no two consumers in the same group process the same partition simultaneously. Add more consumers (up to the number of partitions) and you get more parallelism; add a consumer beyond the partition count and it simply sits idle, since there's nothing left to assign it.

Critically, each consumer group tracks its own position (offset) independently. This is what makes the earlier claim about multiple independent consumer groups concrete: an `email-service` group and an `analytics-service` group can both read the exact same topic, at completely different speeds, each with no effect on the other — something a traditional queue, where reading removes a message, cannot do.

## Retention, not deletion-on-read

Because reading doesn't remove data, something else has to eventually reclaim space: Kafka partitions are configured with a **retention policy** — keep records for N days, or up to N gigabytes, whichever comes first — after which the oldest records are deleted regardless of whether anyone's consumed them. This decouples "how long is this data available" from "has it been read," which is what enables replaying history: a new consumer group can start reading from the very beginning of a topic (within the retention window) and process everything that happened, useful for backfilling a new service or rebuilding derived state from scratch.

## Durability: replication, applied to each partition

Each partition is itself replicated across multiple brokers using essentially the leader-follower model from the Replication section: one broker is the partition's leader and handles all reads/writes for it, while others hold **in-sync replicas** — followers caught up closely enough to be safely promoted if the leader fails. A producer can choose to wait for just the leader to acknowledge a write (faster, some risk if the leader fails before replicating) or for a configurable number of in-sync replicas to acknowledge (slower, safer) — the same synchronous-vs-asynchronous replication trade-off from earlier in this module, exposed here as a per-write configuration choice.

## Why this matters for system design

The log-as-source-of-truth model underlies a broader pattern worth recognizing by name: **event sourcing** — storing every change as an immutable event in a log, and deriving current state by replaying it, rather than only storing current state and overwriting it on each update. Kafka's specific mechanics (partitions for scale, consumer groups for parallel independent consumption, retention instead of delete-on-read) are worth understanding not just because Kafka itself is common in real architectures, but because the underlying idea — an ordered, replayable, multi-consumer log — reappears as the backbone of write-ahead logs in databases (mentioned again in Storage Engines), audit trails, and any system that needs to let multiple independent parts of an architecture react to the same sequence of facts at their own pace.
