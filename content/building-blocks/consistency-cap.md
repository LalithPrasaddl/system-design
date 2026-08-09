# Consistency Models & CAP/PACELC

Replication and partitioning both create the same underlying situation: the same logical data now exists as multiple physical copies, possibly on machines that can't always talk to each other. This section is about the question that situation forces: when copies disagree, or can't currently reach each other, what does the system do?

## A different "consistency" than ACID's

Quick disambiguation, because the same word is doing different jobs: ACID's "Consistency" (Databases I) means a transaction can't violate the database's own declared rules — a single-machine, single-copy idea. The "consistency" in this section is about **agreement between multiple copies of the same data** — a genuinely distributed-systems concept. They share a name and nothing else; keep them separate.

**Strong consistency** (also called linearizability) means every read reflects the most recent write — the system behaves, from the outside, as if there were only ever one copy of the data, even though there are several. **Eventual consistency** means copies are allowed to temporarily disagree, with a guarantee that if writes stopped, every copy would eventually converge to the same value — but right now, at this moment, a read might return stale data.

## CAP theorem

Given a set of replicated nodes, CAP theorem says you can't simultaneously have all three of:

- **Consistency (C)** — every read gets the most recent write, no matter which node answers it.
- **Availability (A)** — every request to a healthy node gets a response, even if it can't currently be sure it's the latest value.
- **Partition tolerance (P)** — the system keeps working even when a network failure splits nodes into groups that can't reach each other.

The theorem is easy to misread as "pick any two of three," but in a real distributed system, network partitions **will** eventually happen — that's not a choice you get to opt out of. So the actual, useful version of CAP is: **when a partition happens, you must choose between consistency and availability.** The system was never going to get to be both at that moment; the only real decision is which one to give up.

<div class="diagram-wrap">
<svg viewBox="0 0 600 230" width="600" height="230" role="img" aria-label="A network partition splitting two data center regions, showing the CP and AP choices">
  <rect x="40" y="30" width="180" height="70" rx="6" class="d-actor-box"></rect>
  <text x="130" y="55" text-anchor="middle" class="d-actor-label">Region A (Leader)</text>
  <text x="130" y="75" text-anchor="middle" class="d-label-muted" font-size="11">has the latest write</text>
  <rect x="380" y="30" width="180" height="70" rx="6" class="d-actor-box"></rect>
  <text x="470" y="55" text-anchor="middle" class="d-actor-label">Region B</text>
  <text x="470" y="75" text-anchor="middle" class="d-label-muted" font-size="11">network link is down</text>
  <line x1="220" y1="65" x2="380" y2="65" class="d-marker-line"></line>
  <text x="300" y="55" text-anchor="middle" class="d-label" font-size="14">✕</text>
  <rect x="30" y="130" width="260" height="66" rx="6" class="d-note"></rect>
  <text x="160" y="150" text-anchor="middle" class="d-note-text">CP choice:</text>
  <text x="160" y="167" text-anchor="middle" class="d-note-text" font-size="11">Region B refuses writes/reads</text>
  <text x="160" y="181" text-anchor="middle" class="d-note-text" font-size="11">it can't verify are current</text>
  <rect x="310" y="130" width="260" height="66" rx="6" class="d-note"></rect>
  <text x="440" y="150" text-anchor="middle" class="d-note-text">AP choice:</text>
  <text x="440" y="167" text-anchor="middle" class="d-note-text" font-size="11">Region B keeps serving, possibly</text>
  <text x="440" y="181" text-anchor="middle" class="d-note-text" font-size="11">stale or diverging data</text>
</svg>
<div class="diagram-caption">Once Region B can't reach Region A, it has exactly two options: stop answering (protect consistency, sacrifice availability) or keep answering with what it locally has (protect availability, sacrifice consistency). There is no third option that gives it both.</div>
</div>

**CP systems** (e.g. a single-leader database configured to refuse reads/writes on a follower that's lost contact with the leader) choose correctness over uptime — during a partition, some requests get rejected or blocked rather than risk returning wrong data. **AP systems** (e.g. DynamoDB, Cassandra in typical configuration) choose uptime over correctness — every reachable node keeps serving, and any disagreement between copies gets reconciled after the partition heals.

Which is right depends entirely on what the data represents. An account balance being briefly wrong might mean money is lost — favor CP. A "like" count being briefly wrong for a few seconds is a non-event — favor AP, and enjoy the uptime.

## PACELC: the trade-off that exists even without a partition

CAP only describes what happens *during* a partition. **PACELC** extends the idea to cover normal operation too: **if Partitioned, choose Availability or Consistency; Else (no partition), choose Latency or Consistency.**

That second half matters just as much in practice: even when the network is perfectly healthy, a system that wants strong consistency (every replica agrees before confirming a write — recall synchronous replication) pays for it in latency, because it has to wait for that agreement. A system willing to accept eventual consistency can respond immediately, without waiting for anyone else to agree first. This is exactly the synchronous-vs-asynchronous replication trade-off from the previous section, restated as a general property of the system rather than a single configuration knob — most real systems are, in PACELC's terms, either "PC/EC" (consistent under all circumstances, at a latency cost always) or "PA/EL" (available and fast always, at a consistency cost always), with plenty of real systems landing somewhere in between via tunable per-operation settings.

## A quick taxonomy of consistency models

Strong consistency and eventual consistency are the two ends of a spectrum, not the only two points on it:

- **Strong consistency (linearizability)** — behaves as if there's only one copy. Most expensive to provide, easiest to reason about.
- **Causal consistency** — operations that are causally related (a reply to a comment) are seen by everyone in the same order; unrelated operations can be seen in different orders on different nodes. Cheaper than strong consistency, while still preventing the most confusing bugs (like seeing a reply before the comment it replies to).
- **Eventual consistency** — no ordering guarantee at all, only a promise of eventual convergence if writes stop. Cheapest, and the right choice when temporary disagreement is genuinely harmless.

Most managed databases let you choose a point on this spectrum per-operation rather than forcing one choice for the whole system — e.g. "read from the leader for this specific query, when I need the latest value" alongside "read from any replica for this other one, where slightly stale is fine."

## Why this matters for system design

This is the single most-tested judgment call in system design, precisely because it's a real trade-off, not a solved problem — there is no configuration that gives you strong consistency, full availability under partition, and no latency cost, all at once. Every case study later in this course that involves replicated or partitioned data will implicitly or explicitly answer this question, and the "right" answer is always about the data's actual requirements, never a default to reach for out of habit.

## Real-world examples

- **CP-leaning systems** — HBase, MongoDB (in its default configuration), etcd, ZooKeeper, and a single-leader relational database configured to refuse stale reads from a lagging replica.
- **AP-leaning systems** — Cassandra, Amazon DynamoDB, Riak, and CouchDB, all of which favor staying available and reconciling any divergence between copies after the fact.
- **Tunable per-operation consistency** — Amazon DynamoDB, Azure Cosmos DB, and Cassandra all let you choose a consistency level on individual reads/writes rather than locking the whole system to one end of the spectrum.
