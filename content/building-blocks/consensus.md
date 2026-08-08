# Go Deeper: Consensus (Raft/Paxos)

Replication's leader-follower model raised a problem it didn't solve: when the leader fails, "something has to detect that and promote a follower to be the new leader" — but if multiple nodes each try to decide this independently, on their own local, incomplete view of what's happening, you can easily end up with two nodes simultaneously convinced they're the leader (split brain), each accepting writes the other doesn't know about. **Consensus algorithms** are how a group of unreliable nodes, communicating over an unreliable network, agree on a single fact — like who the leader is — without that risk.

## Why this is a genuinely hard problem

It's tempting to think "just have everyone vote and go with the majority" solves this trivially. The difficulty is that in a real network, you cannot reliably tell the difference between a node that has crashed and a node that's just slow to respond — both look identical from the outside (silence). Any correct consensus algorithm has to produce the right answer even though messages can be delayed, reordered, or lost, and nodes can crash and later restart with stale information. Getting this right, provably, for every possible interleaving of failures is the actual difficulty — not the everyday case, but the adversarial edge cases.

## Quorums: the core trick

Nearly every practical consensus algorithm relies on the same underlying idea: instead of requiring *all* nodes to agree, require a **majority** (a quorum) — more than half. The reason this works is a simple pigeonhole argument: if you always need a majority to make a decision, then any two majorities, drawn from the same set of nodes, must overlap by at least one node. That overlapping node is what prevents two conflicting decisions from both being made — a new majority can't elect a new leader, or commit a conflicting write, without including at least one node that knows about whatever the previous majority already decided.

This is why consensus systems are typically deployed with an odd number of nodes (3, 5, 7) — it maximizes how many simultaneous failures can be tolerated while still being able to form a majority from the survivors. A 5-node cluster tolerates 2 failures and still has a working majority of 3; a 3-node cluster tolerates only 1.

## Paxos and Raft

**Paxos** (1989) was the original rigorous solution to this problem, and it's notoriously difficult to fully understand or implement correctly — enough so that "which parts of Paxos does this system actually implement" became a real, common source of production bugs across the industry for years.

**Raft** (2014) set out explicitly to solve the same problem while being understandable, and has since become the more common choice for new systems (etcd, Consul, CockroachDB all use it). It breaks the problem into two clearly separable parts:

### Leader election

Nodes start as followers. If a follower doesn't hear from a leader within a randomized timeout, it becomes a candidate, increments a counter called the **term**, and requests votes from the other nodes. A node votes for at most one candidate per term, on a first-come basis — whichever candidate reaches a majority of votes first becomes leader for that term. The randomized timeout is a deliberately simple trick to avoid every node becoming a candidate at exactly the same moment and splitting the vote repeatedly.

### Log replication

Once elected, the leader is the only node that accepts new writes, each of which becomes an entry appended to a replicated log. The leader sends each new entry to its followers; once a **majority** (not all — just a majority, per the quorum trick above) have stored it, the entry is **committed**, and only then is it considered durable and safe to act on.

<div class="diagram-wrap">
<svg viewBox="0 0 600 230" width="600" height="230" role="img" aria-label="Raft log replication reaching majority commit across a five node cluster">
  <rect x="20" y="20" width="120" height="34" rx="6" class="d-actor-box"></rect>
  <text x="80" y="42" text-anchor="middle" class="d-actor-label">Leader</text>
  <rect x="260" y="20" width="100" height="30" rx="5" class="d-block d-block-response"></rect>
  <text x="310" y="40" text-anchor="middle" class="d-block-label">Follower 1 ✓</text>
  <rect x="260" y="60" width="100" height="30" rx="5" class="d-block d-block-response"></rect>
  <text x="310" y="80" text-anchor="middle" class="d-block-label">Follower 2 ✓</text>
  <rect x="260" y="100" width="100" height="30" rx="5" class="d-block d-block-blocked"></rect>
  <text x="310" y="120" text-anchor="middle" class="d-label" font-size="11">Follower 3 (slow)</text>
  <rect x="260" y="140" width="100" height="30" rx="5" class="d-block d-block-blocked"></rect>
  <text x="310" y="160" text-anchor="middle" class="d-label" font-size="11">Follower 4 (unreachable)</text>
  <line x1="140" y1="37" x2="256" y2="35" class="d-msg d-request" marker-end="url(#arrowRf)"></line>
  <line x1="140" y1="38" x2="256" y2="75" class="d-msg d-request" marker-end="url(#arrowRf)"></line>
  <line x1="140" y1="40" x2="256" y2="115" class="d-msg d-request" marker-end="url(#arrowRf)"></line>
  <line x1="140" y1="42" x2="256" y2="155" class="d-msg d-request" marker-end="url(#arrowRf)"></line>
  <rect x="130" y="195" width="340" height="30" rx="6" class="d-note"></rect>
  <text x="300" y="215" text-anchor="middle" class="d-note-text">3 of 5 acknowledged — majority reached, entry committed</text>
  <defs>
    <marker id="arrowRf" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">The leader itself plus two responsive followers already form a majority of the five-node cluster. The entry commits without waiting for the slow or unreachable followers — they'll catch up later once they're able to.</div>
</div>

Notice this is exactly the synchronous-replication idea from the previous section, made precise: the leader waits for enough followers to acknowledge before treating a write as durable — but "enough" is a majority, not all of them, which is what lets the system keep making progress even while some nodes are down or slow.

## What consensus is actually used for

Consensus algorithms are rarely something you implement yourself — you reach for a system built on one. In practice, they show up as the foundation underneath:

- **Leader election for replicated databases** — solving exactly the split-brain problem raised at the top of this page.
- **Distributed coordination services** (ZooKeeper, etcd) — used by other distributed systems to reliably store small amounts of critical shared state, like "who currently holds this lock" or "what's the current cluster configuration."
- **Distributed locks** — ensuring only one process across a whole fleet is allowed to do something at a time (e.g. run a scheduled job exactly once).

## Why this matters for system design

You will very rarely implement Raft or Paxos yourself in practice — but recognizing when a design needs consensus (anywhere you need multiple nodes to agree on one fact, with no room for split-brain) versus when it doesn't (most ordinary replication, where eventual convergence is fine) is a genuinely important judgment call. Reaching for a battle-tested consensus-backed system (etcd, ZooKeeper, or a database with Raft built in) for that specific need, rather than hand-rolling leader election with ad hoc heartbeats and timeouts, is one of the more consequential "don't reinvent this" lessons in distributed systems.
