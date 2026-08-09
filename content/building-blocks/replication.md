# Replication

**Replication** means keeping the same data on more than one machine. It sounds like a simple idea — just copy the data — but nearly every hard problem in distributed databases comes from answering one question honestly: when the same fact lives in multiple places, and one of those places changes, how and when does everywhere else find out?

## Why replicate at all

Two independent reasons, and it's worth keeping them separate because they push designs in different directions:

- **Availability** — if data lives on only one machine and that machine fails, the data is unreachable until it's fixed. Multiple copies mean the system can keep serving from a surviving copy.
- **Read scalability** — a single machine can only serve so many reads per second. Multiple copies mean reads can be spread across all of them, which is a large part of how Scaling Fundamentals' "scaling reads is usually easy" claim gets realized in practice.

Note what's *not* on this list: replication doesn't directly help you scale writes — every copy still eventually needs every write, which is a cost, not a benefit. Scaling write throughput past what one machine can handle is what Partitioning & Sharding is for, not replication.

## Leader-follower (primary-replica) replication

The most common approach: one replica is the **leader** (or primary), and all writes go through it. The leader then forwards each write to the other replicas, the **followers** (or replicas), which apply it and stay in sync.

<div class="diagram-wrap">
<svg viewBox="0 0 600 200" width="600" height="200" role="img" aria-label="Leader-follower replication topology with writes flowing through the leader and out to followers">
  <rect x="20" y="20" width="100" height="34" rx="6" class="d-actor-box"></rect>
  <text x="70" y="42" text-anchor="middle" class="d-actor-label">Client</text>
  <rect x="250" y="20" width="100" height="34" rx="6" class="d-actor-box"></rect>
  <text x="300" y="42" text-anchor="middle" class="d-actor-label">Leader</text>
  <line x1="120" y1="37" x2="246" y2="37" class="d-msg d-request" marker-end="url(#arrowR)"></line>
  <text x="185" y="30" text-anchor="middle" class="d-label-muted" font-size="11">write</text>
  <rect x="470" y="20" width="110" height="34" rx="6" class="d-actor-box"></rect>
  <text x="525" y="42" text-anchor="middle" class="d-actor-label">Follower A</text>
  <rect x="470" y="80" width="110" height="34" rx="6" class="d-actor-box"></rect>
  <text x="525" y="102" text-anchor="middle" class="d-actor-label">Follower B</text>
  <rect x="470" y="140" width="110" height="34" rx="6" class="d-actor-box"></rect>
  <text x="525" y="162" text-anchor="middle" class="d-actor-label">Follower C</text>
  <line x1="350" y1="35" x2="466" y2="35" class="d-msg d-response" marker-end="url(#arrowRr)"></line>
  <line x1="350" y1="38" x2="466" y2="95" class="d-msg d-response" marker-end="url(#arrowRr)"></line>
  <line x1="350" y1="40" x2="466" y2="155" class="d-msg d-response" marker-end="url(#arrowRr)"></line>
  <text x="410" y="70" text-anchor="middle" class="d-label-muted" font-size="11">replicate</text>
  <defs>
    <marker id="arrowR" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowRr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">All writes go through a single leader. Reads can be served from any follower, spreading read load — but a follower that hasn't yet received the latest write will answer with stale data.</div>
</div>

This gives you a single, unambiguous order for writes (they all pass through one place), which makes reasoning about correctness far simpler than the alternatives below. The leader is also, by construction, a single point of failure for writes — if it goes down, something has to detect that and promote a follower to be the new leader (**failover**), which is more operationally delicate than it sounds: promote too eagerly and you might end up with two leaders during a network hiccup (**split brain**); promote too slowly and writes are unavailable the whole time.

## Synchronous vs. asynchronous replication

When the leader forwards a write to its followers, does it wait for them to confirm before telling the client the write succeeded?

**Synchronous replication** waits for at least one follower to confirm before acknowledging the write. This guarantees that confirmed write exists in more than one place — useful, because it means promoting that follower after a leader failure loses nothing. The cost is latency: every write is now only as fast as the slowest follower it waits for, and if that follower is unreachable, writes can stall entirely.

**Asynchronous replication** acknowledges the write as soon as the leader has it, without waiting for followers. Writes are fast and don't depend on follower health, but there's a real risk: if the leader fails before a follower catches up, whatever it hasn't yet replicated is gone, and the newly promoted leader (a former follower) is missing writes clients were already told succeeded.

This is the same latency-vs-guarantee trade-off from the "TCP vs UDP" and "sync vs async communication" sections, one level up the stack — the exact same shape of decision, now applied to how confident you need to be that a write actually survived before telling anyone it succeeded.

## Replication lag

Even healthy asynchronous replication has **replication lag** — a real, nonzero delay between a write landing on the leader and reaching a follower. This produces a genuinely confusing bug class: a user submits a change, immediately reloads, and it looks like their change didn't happen — because their read got routed to a follower that hasn't caught up yet. A common fix is **read-your-writes consistency**: routing a user's own reads to the leader (or a follower known to be caught up) for some window right after they write, while other users' reads can still go anywhere.

## Beyond one leader: multi-leader and leaderless

**Multi-leader replication** allows writes to more than one node, each of which replicates to the others. This helps when write latency to a single leader would be unacceptable (e.g. users in multiple geographic regions, each writing to a nearby leader instead of one far away) — at the cost of a new, hard problem: two leaders can accept conflicting writes to the same data at nearly the same time, and something has to decide how to reconcile them (last-write-wins by timestamp, application-specific merge logic, or surfacing the conflict entirely).

**Leaderless replication** (used by Cassandra and DynamoDB, among others) removes the concept of a leader entirely: a client can write to several replicas directly, and reads similarly query several replicas and reconcile any differences found. This trades away a single, simple write order (there is no single order anymore) for very high availability — there's no leader whose failure can block writes at all.

Both approaches solve the single-leader failover problem by removing single points of failure for writes, at the direct cost of the strong, easy-to-reason-about consistency that having one leader provided. This is the practical shape of the CAP/PACELC trade-off — covered in detail two sections from now — showing up concretely for the first time.

## Why this matters for system design

Replication is the mechanism behind almost every "highly available" claim you'll see in a system design: it's what allows a system to survive a machine (or even a whole data center) failing without losing data or going down. But it's never free — every replication strategy here trades some combination of write latency, operational complexity, or consistency guarantees to get that availability, and picking the right one means being honest about which of those costs your specific system can actually afford.

## Real-world examples

- **PostgreSQL and MySQL** — support leader-follower replication natively, in both synchronous and asynchronous modes.
- **MongoDB** — uses a leader-follower model internally, called replica sets.
- **Cassandra and Amazon DynamoDB** — leaderless replication, using quorum reads/writes to reconcile any differences between replicas.
- **CockroachDB and Google Spanner** — Raft/Paxos-backed distributed databases that replicate across multiple regions.
