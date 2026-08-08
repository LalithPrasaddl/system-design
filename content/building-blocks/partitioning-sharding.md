# Partitioning & Sharding

Replication puts a full copy of the data on multiple machines — it doesn't help when the data itself is too big, or writes too frequent, for any single machine to hold or handle at all. **Partitioning** (commonly called **sharding** for databases specifically) solves that different problem: splitting the data itself into pieces, so each machine holds only a fraction of it.

Replication and partitioning are independent and usually combined — a large-scale database typically shards the data across many machines *and* replicates each shard, so it gets both horizontal write capacity and per-shard fault tolerance at once.

## The core question: which key goes on which shard?

Every partitioning scheme is really an answer to one question: given a piece of data's key, which shard does it belong on? The answer needs two properties: it has to be deterministic (the same key always maps to the same shard, or nothing can ever be found again), and it should spread data and load roughly evenly across shards.

### Range-based partitioning

Assign contiguous ranges of keys to each shard — e.g. users A–H on shard 1, I–P on shard 2, Q–Z on shard 3. This has a real advantage: range queries ("all users between M and P") can often be answered by a single shard, or a small contiguous set of them.

The weakness is uneven distribution: if your keys aren't uniformly spread over the range (surnames really aren't uniform across the alphabet; sequential IDs skew all *new* writes onto whichever shard holds the current high end of the range), some shards end up far hotter than others — a **hot spot** — while others sit idle.

### Hash-based partitioning

Run the key through a hash function and use the result to pick a shard — e.g. `hash(user_id) % number_of_shards`. Because a good hash function distributes its output uniformly regardless of patterns in the input, this spreads data and load evenly across shards even when the underlying keys are skewed.

<div class="diagram-wrap">
<svg viewBox="0 0 600 210" width="600" height="210" role="img" aria-label="Hash-based partitioning distributing keys evenly across three shards">
  <rect x="20" y="20" width="90" height="30" rx="5" class="d-actor-box"></rect>
  <text x="65" y="40" text-anchor="middle" class="d-label" font-size="12">key: 42</text>
  <rect x="20" y="60" width="90" height="30" rx="5" class="d-actor-box"></rect>
  <text x="65" y="80" text-anchor="middle" class="d-label" font-size="12">key: 91</text>
  <rect x="20" y="100" width="90" height="30" rx="5" class="d-actor-box"></rect>
  <text x="65" y="120" text-anchor="middle" class="d-label" font-size="12">key: 17</text>
  <rect x="200" y="55" width="110" height="40" rx="6" class="d-note"></rect>
  <text x="255" y="80" text-anchor="middle" class="d-note-text">hash(key) % 3</text>
  <line x1="112" y1="35" x2="196" y2="65" class="d-lifeline"></line>
  <line x1="112" y1="75" x2="196" y2="75" class="d-lifeline"></line>
  <line x1="112" y1="115" x2="196" y2="85" class="d-lifeline"></line>
  <rect x="420" y="20" width="100" height="34" rx="6" class="d-actor-box"></rect>
  <text x="470" y="42" text-anchor="middle" class="d-actor-label">Shard 0</text>
  <rect x="420" y="75" width="100" height="34" rx="6" class="d-actor-box"></rect>
  <text x="470" y="97" text-anchor="middle" class="d-actor-label">Shard 1</text>
  <rect x="420" y="130" width="100" height="34" rx="6" class="d-actor-box"></rect>
  <text x="470" y="152" text-anchor="middle" class="d-actor-label">Shard 2</text>
  <line x1="310" y1="72" x2="416" y2="92" class="d-msg d-request" marker-end="url(#arrowH)"></line>
  <line x1="310" y1="75" x2="416" y2="37" class="d-msg d-request" marker-end="url(#arrowH)"></line>
  <line x1="310" y1="80" x2="416" y2="147" class="d-msg d-request" marker-end="url(#arrowH)"></line>
  <defs>
    <marker id="arrowH" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">A good hash function scatters keys evenly across shards regardless of any pattern in the original keys — no more hot spots from sequential IDs or skewed alphabetic ranges.</div>
</div>

The cost mirrors the benefit: a hash destroys the key's original ordering, so a range query now has to fan out to every shard and merge the results, instead of hitting one.

## Rebalancing: the problem with `% number_of_shards`

The naive `hash(key) % N` scheme has a serious flaw hiding in plain sight: if you add or remove a shard, `N` changes, and `hash(key) % N` now returns a *different* shard for nearly every key — meaning nearly all your data has to move at once just because your cluster size changed. For any system that expects to grow, that's unacceptable.

**Consistent hashing** solves this. Instead of hashing keys into a fixed number of buckets, it maps both keys and shards onto the same fixed, circular hash space (imagine a clock face); each key belongs to the first shard found going clockwise from its position. Adding or removing a single shard now only reassigns the keys between it and its immediate neighbor on the ring — the rest of the data stays exactly where it was. This is the same technique mentioned in Load Balancing for routing with "stickiness," applied here to data placement instead of request routing — the underlying problem (map many keys to a smaller, changing set of destinations without reshuffling everything on every change) is identical.

## What partitioning costs you

Splitting data across shards means the database can no longer trivially answer questions that span shards. A join between two tables that live on different shards, or a transaction touching rows on two different shards, either becomes impossible, becomes the application's problem to stitch together, or requires distributed transaction machinery that is itself slow and complex. This is why sharding is usually introduced only once a single machine genuinely can't keep up — it solves a real scaling problem, but it removes some of the relational database's core conveniences (Databases I) in the process, which is exactly the trade-off that makes "which database, sharded or not" a real design decision rather than an obvious default.

## Choosing a shard key

Because cross-shard operations are expensive or impossible, the single most consequential decision in sharding is which column to shard on. A good shard key is one that most of your actual queries already filter by (so most queries hit one shard, not all of them) and that spreads data evenly (avoiding hot spots). Get it wrong — shard a multi-tenant application by a column other than tenant ID, for instance — and nearly every query ends up needing to fan out across every shard, which erases most of the benefit sharding was supposed to provide.

## Why this matters for system design

Partitioning is the answer to "the data (or the write load) is too big for one machine," which replication alone can never solve — replication only ever gives you more identical copies, not more capacity. Nearly every case study in this course that involves data at real scale eventually needs both: replication for availability and read scaling, partitioning for capacity and write throughput, layered together.
