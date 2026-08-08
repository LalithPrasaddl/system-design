# Message Queues & Event-Driven Architecture

Every interaction covered so far — REST, RPC, GraphQL — has been a direct conversation: a client sends a request straight to the service that will handle it, and (synchronously or asynchronously) waits for that same service to respond. A **message queue** removes the direct connection entirely: a **producer** sends a message to the queue and moves on, and one or more **consumers** read from the queue whenever they're ready, with no direct relationship between the two beyond the queue itself.

## Why decouple producer from consumer at all

<div class="diagram-wrap">
<svg viewBox="0 0 600 170" width="600" height="170" role="img" aria-label="A producer sending messages to a queue, consumed independently by one or more consumers">
  <rect x="20" y="65" width="110" height="40" rx="6" class="d-actor-box"></rect>
  <text x="75" y="90" text-anchor="middle" class="d-actor-label">Producer</text>
  <rect x="240" y="55" width="130" height="60" rx="6" class="d-actor-box"></rect>
  <text x="305" y="80" text-anchor="middle" class="d-actor-label">Queue</text>
  <text x="305" y="98" text-anchor="middle" class="d-label-muted" font-size="11">[ msg msg msg ]</text>
  <rect x="470" y="20" width="110" height="34" rx="6" class="d-actor-box"></rect>
  <text x="525" y="42" text-anchor="middle" class="d-actor-label">Consumer A</text>
  <rect x="470" y="110" width="110" height="34" rx="6" class="d-actor-box"></rect>
  <text x="525" y="132" text-anchor="middle" class="d-actor-label">Consumer B</text>
  <line x1="130" y1="85" x2="236" y2="85" class="d-msg d-request" marker-end="url(#arrowMq)"></line>
  <line x1="370" y1="75" x2="466" y2="40" class="d-msg d-request" marker-end="url(#arrowMq)"></line>
  <line x1="370" y1="90" x2="466" y2="122" class="d-msg d-request" marker-end="url(#arrowMq)"></line>
  <text x="75" y="120" text-anchor="middle" class="d-label-muted" font-size="11">fires and moves on</text>
  <defs>
    <marker id="arrowMq" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">The producer never learns which consumer, or how many, will process a given message — or when. That indirection is the entire point.</div>
</div>

This buys three things a direct call can't:

- **The producer stops waiting on the consumer's speed.** If sending a confirmation email takes 400ms, a user placing an order shouldn't have to wait 400ms for their checkout to complete — put "send confirmation email" on a queue and let the checkout request finish immediately.
- **Bursts get absorbed instead of causing failures.** If a direct call receives 10x its normal traffic, it either falls over or has to be scaled up instantly. A queue in front of the same work just grows temporarily — messages wait a little longer, but nothing is lost or rejected, and the consumer processes them at its own sustainable pace.
- **Producer and consumer can fail, deploy, and scale independently.** The consumer can be down for maintenance and messages simply wait in the queue for it to come back, rather than every producer request failing during that window.

The cost is the same one from the sync-vs-async section, generalized: the producer no longer gets an immediate, authoritative answer about whether the work actually succeeded. "The order was placed" and "the confirmation email was sent" are no longer guaranteed to happen at the same time, or even both happen at all without additional handling — and the system now has real, permanent complexity it didn't have before: what happens to a message if the consumer crashes while processing it? Where do messages go if they fail repeatedly?

## Delivery guarantees

Message queues typically offer one of three delivery guarantees, and picking between them is one of the first real decisions in using one:

- **At-most-once** — a message is delivered zero or one times. If something fails between the queue and successful processing, the message is simply lost. Fast and simple, appropriate only when losing an occasional message is truly acceptable (some kinds of metrics or logs).
- **At-least-once** — a message is guaranteed to be delivered, but might be delivered more than once (e.g. if a consumer crashes after processing a message but before telling the queue it succeeded, the queue will redeliver it to be safe). This is the most common default, and it pushes a real requirement onto the consumer: **processing a message must be idempotent** — applying it twice must produce the same result as applying it once (e.g. "set the balance to $50," not "add $10 to the balance," which would double-apply on a redelivery).
- **Exactly-once** — every message is processed once and only once, with no duplicates and no loss. This is genuinely difficult to guarantee end-to-end across a real network (it usually means "exactly-once processing," implemented via at-least-once delivery plus idempotency/deduplication on the consumer, rather than a magical network-level guarantee) and is worth being skeptical of whenever a system claims it outright.

## Queue vs. topic: two different fan-out models

A **queue** in the strict sense delivers each message to exactly one consumer, even if several are listening — this is how you scale a consumer horizontally: add more consumer instances, and the queue spreads messages across them, similar in spirit to a load balancer spreading requests.

A **topic** (publish/subscribe) delivers each message to *every* subscriber independently — useful when multiple, unrelated parts of a system all need to react to the same event (an "order placed" event might need to trigger inventory reduction, a confirmation email, and an analytics update, none of which should compete for the same message).

Most real systems need both patterns somewhere, which is why many message brokers (Kafka, RabbitMQ with the right configuration) support both: a topic that multiple independent consumer *groups* subscribe to, with load spread across the members within each group. The optional deep dive on this page covers exactly how Kafka structures this.

## Event-driven architecture

Message queues enable a broader architectural style: instead of services calling each other directly to request work, services publish **events** — facts about something that already happened ("order placed," "payment failed", "inventory reduced") — and other services subscribe to the events they care about and react independently. No service needs to know who's listening, or how many downstream services exist; new functionality can subscribe to existing events without ever touching the producer's code.

The trade-off is traceability: in a direct-call architecture, "what happens when a user places an order" is a call stack you can read top to bottom. In an event-driven one, it's scattered across every service that happens to subscribe to that event, which can make a system considerably harder to reason about and debug end-to-end, even though each individual piece is simpler and more decoupled.

## Why this matters for system design

Message queues are the standard tool for turning "this has to happen, but not necessarily right now, in this exact request" into a reliable, scalable part of a design — and event-driven architecture is what you get when that idea is applied broadly across a whole system rather than one workflow at a time. Nearly every non-trivial case study later in this course uses a queue somewhere: anywhere a slow, non-critical-path task shows up (sending notifications, processing uploads, updating a search index after a write), a queue is usually the right answer.
