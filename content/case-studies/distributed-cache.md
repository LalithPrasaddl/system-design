# Distributed Cache

A distributed cache is a key-value store that holds everything in memory, spread across many machines, so an application can read in well under a millisecond what would take a database several. Storing bytes in RAM is the easy part. The hard part is deciding which machine owns each key, keeping that answer stable while machines join and die, and noticing the moment the cache stops being optional — because once the database behind it is sized for a 95% hit ratio, losing the cache is an outage, not a slowdown.

<!-- tab:requirements:Requirements -->

## Requirements

This case study builds the cache itself — the servers, how keys are placed on them, and how the cluster survives failure — not just an application that uses one. It assumes the cache sits in front of a relational database for a large product, in the cache-aside pattern described in [Caching](#/systems/caching).

### Functional requirements

- **Basic operations:** `GET`, `SET`, and `DELETE` on string keys, with an optional time-to-live (TTL) per key.
- **Atomic operations:** increment a counter, and set a key only if it does not already exist. These are what let other systems — the counters in [Rate Limiter as a Service](#/systems-case-studies/rate-limiter), a lock, an idempotency record — be built on top of the cache safely.
- **Batch reads:** fetch many keys in one call, because a page render that needs 40 keys should not pay 40 round trips.
- **Bounded memory:** when a node is full, it evicts something rather than refusing writes or crashing.
- **Elastic capacity:** add or remove nodes while the cluster serves traffic.

### Non-functional requirements

- **Very low latency.** A cache that is not dramatically faster than the database is not worth running. Target **under 1ms at p99** for a `GET`, measured at the server.
- **High throughput.** 2 million operations per second at peak, scaling roughly linearly with the number of nodes.
- **Highly available.** A single node dying should lose a small fraction of the cache for a few seconds, not the whole cache.
- **Durability is not required.** Every value can be rebuilt from the database. That permission is what makes the design fast — and the next requirement is what keeps it honest.
- **Losing the cache must not become an outage.** Individual lost keys are fine. Losing most of the cache at once sends the full read load to a database that cannot carry it. The design has to protect the *hit ratio*, not just the data.
- **Bounded staleness.** A cached value may lag the database, but never indefinitely. Every entry has a TTL as a backstop.

### In scope

The per-node data structures, eviction and expiry, how keys are placed across nodes, adding and removing nodes, replication and failover, and the hot-key and stampede problems that appear at scale.

### Out of scope

Using the cache as the primary store for data that exists nowhere else (that is a database, and it needs a database's durability guarantees). Multi-key transactions spanning nodes. Cross-region replication — each region runs its own cluster, and the reasoning in [Multi-Region & Disaster Recovery](#/systems/multi-region-dr) applies unchanged. Rich data structures such as sorted sets and streams; they change what a value looks like, not how the cluster is built.

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

The inputs below are assumptions for a large consumer product. What matters is the method, and one result that tends to surprise people: this cluster is sized by throughput, not by memory.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Peak operations</div>
<div class="stat-tile-value">~2<span class="stat-tile-unit">M/sec</span></div>
<div class="stat-tile-sub">90% reads, 10% writes</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Data in memory</div>
<div class="stat-tile-value">~550<span class="stat-tile-unit">GB</span></div>
<div class="stat-tile-sub">500M keys at ~1.1KB each</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Primary nodes</div>
<div class="stat-tile-value">20</div>
<div class="stat-tile-sub">set by throughput, not memory</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Total nodes</div>
<div class="stat-tile-value">40</div>
<div class="stat-tile-sub">one replica per primary</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Target hit ratio</div>
<div class="stat-tile-value">95<span class="stat-tile-unit">%</span></div>
<div class="stat-tile-sub">the number the database is sized for</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Database reads</div>
<div class="stat-tile-value">~90<span class="stat-tile-unit">K/sec</span></div>
<div class="stat-tile-sub">at 95% — and ~360K/sec at 80%</div>
</div>
</div>

### Assumptions

- 2 million cache operations/sec at peak, 90% of them reads.
- 500 million keys are live at any moment.
- Keys average 40 bytes, values average 1KB.
- The database behind the cache is provisioned for about 150,000 reads/sec.

### Memory

Each entry costs more than its key and value. The hash table slot, pointers, the expiry timestamp, eviction metadata, and memory allocator rounding add roughly 60 bytes per key. So one entry is about 40 + 1,024 + 60 ≈ **1.1KB**, and 500 million of them come to about **550GB**.

A machine with 64GB of RAM should hold only about 40GB of data. The rest is headroom for allocator fragmentation, for the buffers used to feed replicas, and for the memory spike when a node writes a snapshot. By memory alone, 550GB ÷ 40GB ≈ **14 nodes**.

### Throughput

A single cache node, running one event loop on one core (see Deep Dives for why), can handle on the order of 100,000–200,000 simple operations/sec. Budget the lower number for headroom. Then 2 million ops/sec ÷ 100,000 = **20 nodes**.

Throughput wins: 20 nodes, each holding under 30GB. That is typical. Memory is cheap to add to a node, but a single node's request rate is capped by one core and one network card. It also means **spreading load evenly matters more than spreading data evenly**, which comes back hard in Stage 5.

Add one replica per primary for availability, and the cluster is **40 nodes**.

### Bandwidth

2 million ops/sec at about 1KB each is roughly 2GB/sec, or 16Gbps across the cluster. Per node that is about 100MB/sec, under 1Gbps — comfortable on a 10Gbps network card. Bandwidth only becomes the limit for one node carrying one very popular key, which is again Stage 5's problem.

### The number that matters most: what the database sees

1.8 million reads/sec reach the cache. At a 95% hit ratio, 5% miss and fall through: **90,000 reads/sec** on the database, inside its 150,000 capacity.

At 90% the database sees 180,000/sec — already over capacity. At 80% it sees 360,000/sec, four times normal load. A **five-point drop in hit ratio overloads the database**. So the architecture below is judged mainly by one question: when something changes — a node joins, a node dies, a key gets popular — how much of the hit ratio survives?

<!-- tab:api-design:API Design -->

## API Design

A cache is called from inside the data centre, by application servers, millions of times a second. Its API is a compact command protocol over long-lived TCP connections, not HTTP.

### Commands

| Command | Example | Returns |
|---|---|---|
| `GET key` | `GET user:42` | The value, or nil on a miss |
| `SET key value [EX s] [NX]` | `SET user:42 {...} EX 300` | OK, or nil if `NX` was given and the key already existed |
| `DEL key` | `DEL user:42` | Number of keys removed |
| `MGET key...` | `MGET user:42 user:77` | A list of values, nil for each miss |
| `INCR key` | `INCR views:post:9` | The new value, atomically |
| `EXPIRE key s` | `EXPIRE session:ab 1800` | 1 if the TTL was set |
| `TTL key` | `TTL user:42` | Seconds remaining, or -1 if none |

A few details carry more weight than they look like they should:

**A miss is not an error.** `GET` on a missing key returns nil, a normal answer. Callers must treat it as "go to the database", never as a failure.

**`SET ... NX` is the building block for coordination.** "Set this key only if nobody else has" is how a lock is taken, how a duplicate request is detected, and — in Stage 5 — how the cluster makes sure only one caller rebuilds an expired value.

**`EX` belongs on every write.** A key with no TTL lives until evicted. If invalidation ever fails to happen, a stale value with no TTL is served forever. The TTL is the guarantee that every mistake is temporary.

### Pipelining

The client can send many commands without waiting for each reply, then read the replies in order. For a batch of 40 lookups on one node, that is one network round trip instead of 40. At ~0.2ms per round trip, it is the difference between 0.2ms and 8ms for the same work. `MGET` does the same for reads specifically.

### Errors worth designing for

```
GET user:42
-MOVED 7438 10.0.3.17:6379
```

Once the cluster is sharded, a client may send a key to the wrong node — usually because its routing map is out of date after a node was added. The node does not forward the request. It answers with where the key now lives. The client retries there and refreshes its map. Deep Dives covers why the node redirects instead of forwarding.

```
SET big:blob ...
-OOM command not allowed when used memory > 'maxmemory'
```

This only appears when eviction is disabled. For a cache it almost never should be — see Data Model.

### Admin interface

| Operation | Purpose |
|---|---|
| `CLUSTER ADD-NODE addr` | Join a new, empty node |
| `CLUSTER REBALANCE` | Move ownership of keys onto the new node, gradually |
| `CLUSTER FAILOVER node` | Promote a replica deliberately, e.g. before maintenance |
| `INFO` | Memory, hit and miss counts, evictions, replication offset |

These run a few times a week, from operators and automation. They must be safe and observable, not fast.

<!-- tab:data-model:Data Model -->

## Data Model

There are two layers of state. On each node: the keys themselves. Across the cluster: the map of which node owns which keys.

### On each node: one big hash table

```
entry
  key          bytes          -- "user:42"
  value        bytes / ptr    -- the payload; small integers stored inline
  expires_at   int64 | none   -- absolute time, not a countdown
  access_info  24 bits        -- last-access clock or frequency, for eviction
```

Every key lives in one in-memory hash table: a lookup is a hash, an array index, and a short chain walk. Two details make it hold up at hundreds of millions of keys.

**Resizing is incremental.** When the table fills, it has to grow into a bigger array. Copying 25 million entries in one go would freeze the node for seconds. Instead the node allocates the new table and moves a few buckets on every operation, while lookups check both tables. The resize spreads over thousands of normal operations, and none of them notices.

**Expiry is stored as a point in time.** `expires_at` is absolute, so nothing has to count down. How expired keys are actually removed is in Deep Dives.

### When memory runs out: eviction

A node is configured with a memory limit, well below the machine's RAM. When a write would exceed it, the node evicts keys first. The policy decides which:

| Policy | Evicts | Good for |
|---|---|---|
| LRU (least recently used) | The key untouched for longest | The general-purpose default |
| LFU (least frequently used) | The key used least often | Workloads with scans that would flush a pure LRU |
| TTL-first | Keys with a TTL, soonest-expiring first | Mixing cache entries with keys that must not be evicted |
| No eviction | Nothing — writes fail | Only when the cache is secretly a primary store |

**The default here is approximated LRU.** A true LRU keeps every key on a doubly linked list and moves it to the front on each access. That costs 16 bytes of pointers per key — 8GB across 500 million keys — plus pointer rewrites on every read. The approximation samples a handful of random keys and evicts the least recently used of the sample. With a sample of 5–10, it is very close to true LRU and costs almost nothing. The details are in Deep Dives.

### Across the cluster: who owns each key

The cluster also needs a small, shared piece of state: a map from keys to nodes. Every client and every node must agree on it, and it changes whenever a node joins, leaves, or fails. It is tiny — a few kilobytes — but getting its shape right is what separates Stage 2 of the architecture from Stage 3.

### What is deliberately missing

There is no write-ahead log and no fsync on the write path. A cache node can restart empty and the system stays correct. Some deployments add periodic snapshots so a restarted node comes back warm (see Deep Dives), but that is an optimization for the hit ratio, never a durability promise. If losing a key would lose information, that key does not belong in this system.

<!-- tab:architecture:Architecture:default -->

This case study builds the cache up in five stages. Each stage fixes a specific failure of the one before. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one request at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. One Cache Node -->

## Stage 1 — One Cache Node

The smallest useful version: one cache process in front of the database. The application checks the cache first. On a miss it reads the database and writes the result back into the cache for next time. This is cache-aside, and it is how the cache is used in the [URL Shortener](#/systems-case-studies/url-shortener) too.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 520 260" width="520" height="260" role="img" aria-label="An app server reading from a single cache node, falling back to the database on a miss">
  <rect x="30" y="112" width="130" height="36" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="95" y="134" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
  <g data-fail-toggle="cache1">
    <rect x="300" y="36" width="160" height="44" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="380" y="55" text-anchor="middle" class="d-actor-label" font-size="12">Cache Node</text>
    <text x="380" y="70" text-anchor="middle" class="d-label-muted" font-size="9">all keys, one process, RAM</text>
  </g>
  <g data-fail-toggle="db1">
    <rect x="300" y="176" width="160" height="44" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="380" y="195" text-anchor="middle" class="d-actor-label" font-size="12">Database</text>
    <text x="380" y="210" text-anchor="middle" class="d-label-muted" font-size="9">source of truth</text>
  </g>
  <line id="c1-app-cache" x1="162" y1="118" x2="296" y2="54" class="d-msg d-request" data-depends-on="cache1" marker-end="url(#arrowC1)"></line>
  <line id="c1-cache-app" x1="296" y1="70" x2="162" y2="130" class="d-msg d-response" data-depends-on="cache1" marker-end="url(#arrowC1r)"></line>
  <line id="c1-app-db" x1="162" y1="136" x2="296" y2="190" class="d-msg d-request" data-depends-on="db1" marker-end="url(#arrowC1)"></line>
  <line id="c1-db-app" x1="296" y1="206" x2="162" y2="146" class="d-msg d-response" data-depends-on="db1" marker-end="url(#arrowC1r)"></line>
  <text x="260" y="250" text-anchor="middle" class="d-label-muted" font-size="10">play the hit, then the miss — then fail the cache node and replay the hit</text>
  <defs>
    <marker id="arrowC1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowC1r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "mem", "title": "Cache node memory", "rows": [["user:42", "{name: Ada, …}"], ["user:77", "(not cached)"]]},
{"id": "db", "title": "Database load", "rows": [["reads/sec", "~90K of 150K"]]}
],
"flows": [
{
"id": "hit",
"label": "Read — cache hit",
"nodes": ["cache1", "db1"],
"steps": [
{"el": "c1-app-cache", "payload": "GET user:42", "altEl": "c1-app-db", "altMs": 0, "text": "The app needs user 42's profile. It asks the cache first, over a connection it keeps open.", "altText": "The cache node is not answering. The app treats that exactly like a miss and goes straight to the database."},
{"el": "c1-cache-app", "payload": "{name: Ada}", "ms": 0.3, "altEl": "c1-db-app", "altMs": 5, "altSet": {"db.reads/sec": "~1.8M of 150K"}, "text": "A hit. The node found the key in its hash table and answered in about 0.3ms, most of it network. The database never heard about this request.", "altText": "The database answers correctly in about 5ms. So correctness survives a cache outage; capacity does not. Every read in the system now lands here — twelve times what the database was built for."}
]
},
{
"id": "miss",
"label": "Read — cache miss, then fill",
"nodes": ["cache1", "db1"],
"steps": [
{"el": "c1-app-cache", "payload": "GET user:77", "text": "Now a user who is not in the cache."},
{"el": "c1-cache-app", "payload": "nil", "ms": 0.3, "text": "A miss. Nil is a normal answer, not an error — it means go to the source."},
{"el": "c1-app-db", "payload": "SELECT … id=77", "text": "The app reads the database."},
{"el": "c1-db-app", "payload": "{name: Lin}", "ms": 5, "text": "About 5ms — more than fifteen times the cost of the hit."},
{"el": "c1-app-cache", "payload": "SET user:77 EX 300", "ms": 0.3, "set": {"mem.user:77": "{name: Lin, …}"}, "text": "The app writes the value into the cache with a five-minute TTL. The next read of user 77 is a hit. The TTL guarantees that if this value ever goes stale, it goes stale for five minutes at most."}
]
}
]
}
</script>
<div class="diagram-caption">A hit costs ~0.3ms, a miss ~5.6ms. Fail the cache node and replay the hit: the read still succeeds — but look at the database load panel.</div>
</div>

<div class="fail-hint">Click the cache node or the database to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="cache1">
<strong>If the cache node fails:</strong> every read becomes a miss. Answers are still correct, because the database has everything. But the database now receives about 1.8 million reads/sec against a capacity of 150,000. It slows, then times out, and the application fails with it. With one node, the cache is a single point of failure for the database's capacity, even though it holds no data that can't be rebuilt. When it comes back it is empty, and the database stays overloaded until the cache warms up.
</div>
<div class="failure-impact is-hidden" data-component="db1">
<strong>If the database fails:</strong> hits keep working, so about 95% of reads are served normally for as long as their TTLs last. Misses and writes fail. This buys time, not safety — as TTLs expire, more of the traffic fails. Serving stale values past their TTL during an outage is a real option some systems choose, but it has to be designed deliberately; it does not happen on its own.
</div>
</div>

Inside, a single node is simple: a hash table, a memory limit with approximated-LRU eviction, and one thread running an event loop that handles each command in a few microseconds. It is fast and correct. Against the numbers in Scale Estimates it fails three ways. 550GB does not fit in one machine. 2 million ops/sec is ten times what one core can serve. And the node itself is a single point of failure for the database's capacity.

<!-- stage:2:2. Shard with hash % N -->

## Stage 2 — Shard with hash % N

Split the keys across several nodes. The obvious rule: hash the key, take the result modulo the number of nodes, and send the request to that node. It runs in the client library, so there is no extra hop. Each node holds about 1/N of the keys and serves about 1/N of the traffic ([Partitioning & Sharding](#/systems/partitioning-sharding)).

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 500 310" width="500" height="310" role="img" aria-label="An app server hashing each key modulo the node count to pick one of four cache nodes, with the database below">
  <rect x="20" y="130" width="112" height="36" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="76" y="152" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
  <rect x="165" y="100" width="100" height="100" rx="6" class="d-note"></rect>
  <text x="215" y="144" text-anchor="middle" class="d-note-text" font-size="12">hash(key)</text>
  <text x="215" y="162" text-anchor="middle" class="d-note-text" font-size="12">% N</text>
  <rect x="320" y="24" width="140" height="34" rx="6" class="d-actor-box" data-role="cache"></rect>
  <text x="390" y="46" text-anchor="middle" class="d-actor-label" font-size="11">Node 0</text>
  <g data-fail-toggle="n1s2">
    <rect x="320" y="86" width="140" height="34" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="390" y="108" text-anchor="middle" class="d-actor-label" font-size="11">Node 1</text>
  </g>
  <rect x="320" y="148" width="140" height="34" rx="6" class="d-actor-box" data-role="cache"></rect>
  <text x="390" y="170" text-anchor="middle" class="d-actor-label" font-size="11">Node 2</text>
  <g data-fail-toggle="n3s2">
    <rect x="320" y="210" width="140" height="34" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="390" y="232" text-anchor="middle" class="d-actor-label" font-size="11">Node 3 (added)</text>
  </g>
  <rect x="20" y="232" width="112" height="38" rx="6" class="d-actor-box" data-role="datastore"></rect>
  <text x="76" y="255" text-anchor="middle" class="d-actor-label" font-size="12">Database</text>
  <line id="c2-app-hash" x1="134" y1="142" x2="161" y2="142" class="d-msg d-request" marker-end="url(#arrowC2)"></line>
  <line id="c2-hash-app" x1="161" y1="156" x2="134" y2="156" class="d-msg d-response" marker-end="url(#arrowC2r)"></line>
  <line id="c2-hash-n1" x1="267" y1="130" x2="316" y2="98" class="d-msg d-request" data-depends-on="n1s2" marker-end="url(#arrowC2)"></line>
  <line id="c2-n1-hash" x1="316" y1="110" x2="267" y2="140" class="d-msg d-response" data-depends-on="n1s2" marker-end="url(#arrowC2r)"></line>
  <line id="c2-hash-n2" x1="267" y1="156" x2="316" y2="160" class="d-msg d-request" marker-end="url(#arrowC2)"></line>
  <line id="c2-n2-hash" x1="316" y1="172" x2="267" y2="166" class="d-msg d-response" marker-end="url(#arrowC2r)"></line>
  <line id="c2-hash-n3" x1="267" y1="180" x2="316" y2="222" class="d-msg d-request" data-depends-on="n3s2" marker-end="url(#arrowC2)"></line>
  <line id="c2-n3-hash" x1="316" y1="234" x2="267" y2="190" class="d-msg d-response" data-depends-on="n3s2" marker-end="url(#arrowC2r)"></line>
  <line id="c2-app-db" x1="62" y1="168" x2="62" y2="228" class="d-msg d-request" marker-end="url(#arrowC2)"></line>
  <line id="c2-db-app" x1="92" y1="228" x2="92" y2="168" class="d-msg d-response" marker-end="url(#arrowC2r)"></line>
  <text x="250" y="298" text-anchor="middle" class="d-label-muted" font-size="10">play both flows in order — the same key, before and after one node is added</text>
  <defs>
    <marker id="arrowC2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowC2r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "route", "title": "Routing", "rows": [["nodes (N)", "3"], ["hash(user:42)", "7"], ["user:42 lives on", "7 % 3 = node 1"], ["keys on their usual node", "100%"]]},
{"id": "db", "title": "Database load", "rows": [["reads/sec", "~90K of 150K"]]}
],
"flows": [
{
"id": "three",
"label": "Read user:42 — three nodes",
"nodes": ["n1s2", "n3s2"],
"steps": [
{"el": "c2-app-hash", "payload": "GET user:42", "text": "The client library hashes the key. Say it comes out as 7. With three nodes, 7 % 3 = 1."},
{"el": "c2-hash-n1", "payload": "GET user:42", "altEl": "c2-hash-n2", "altSet": {"route.nodes (N)": "2", "route.user:42 lives on": "7 % 2 = 1 → node 2", "route.keys on their usual node": "~33%"}, "text": "So the request goes to node 1, directly — no proxy, no lookup service.", "altText": "Node 1 is dead, so the client removes it from its list. N is now 2, and 7 % 2 = 1 now means the second node in the list: node 2. Not just node 1's keys moved. The formula changed for every key, and about two thirds of all keys now map somewhere else."},
{"el": "c2-n1-hash", "payload": "{name: Ada}", "ms": 0.3, "altEl": "c2-n2-hash", "altMs": 0.3, "altSet": {"db.reads/sec": "~1.2M of 150K"}, "text": "A hit in 0.3ms. Three nodes now share the memory and the traffic.", "altText": "Node 2 has never stored user:42: a miss. That is true for almost every key in the cluster at once. The hit ratio collapses from 95% to about 30%, and one dead node has sent the database more than a million reads a second."}
]
},
{
"id": "four",
"label": "Add a fourth node — same read",
"nodes": ["n1s2", "n3s2"],
"steps": [
{"el": "c2-app-hash", "payload": "GET user:42", "set": {"route.nodes (N)": "4", "route.user:42 lives on": "7 % 4 = node 3", "route.keys on their usual node": "~25%"}, "text": "Traffic grew, so an operator adds node 3. N is now 4, and the same key computes 7 % 4 = 3."},
{"el": "c2-hash-n3", "payload": "GET user:42", "text": "The request goes to the new node. Node 1 still holds user:42, perfectly valid, but no request will ever reach it there again."},
{"el": "c2-n3-hash", "payload": "nil", "ms": 0.3, "set": {"db.reads/sec": "~1.4M of 150K"}, "text": "A miss, and not a rare one. With hash % N, a key keeps its node only if its hash gives the same remainder for N and N+1 — about 1 key in N+1. Going from 3 nodes to 4, three quarters of all keys moved at the same moment."},
{"el": "c2-hash-app", "payload": "nil", "text": "The client gets a miss back for most of what it asks for."},
{"el": "c2-app-db", "payload": "SELECT … id=42", "text": "All of those misses go to the database at once. The hit ratio drops from 95% to about 24%."},
{"el": "c2-db-app", "payload": "{name: Ada}", "ms": 5, "text": "The database is being asked for about nine times its capacity. It slows down or fails, just because someone added capacity."},
{"el": "c2-app-hash", "payload": "SET user:42", "text": "If the database survives, the app refills the cache."},
{"el": "c2-hash-n3", "payload": "SET user:42", "ms": 0.3, "text": "user:42 is now warm on node 3. Its old copy on node 1 is dead weight until it is evicted. Every scaling event costs almost the whole cache, and the bigger the cluster, the worse it gets: going from 20 nodes to 21 moves about 95% of keys."}
]
}
]
}
</script>
<div class="diagram-caption">Play the three-node read, then the four-node read. The key did not change and node 1 did not fail — only N changed, and that was enough to send most reads to the database.</div>
</div>

<div class="fail-hint">Click node 1 or node 3 to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="n1s2">
<strong>If node 1 fails:</strong> ideally only node 1's third of the keys would be lost. But with hash % N, removing a node changes N, and that remaps nearly every key. Replay the first flow with node 1 failed: the key goes to node 2, which has never seen it. Failing one node out of three costs about two thirds of the cache, not one third. The alternative — keep N at 3 and treat node 1's keys as misses until it returns — limits the damage, but now every client needs the same view of which nodes are "down but still counted", and that is the start of Stage 3.
</div>
<div class="failure-impact is-hidden" data-component="n3s2">
<strong>If the new node 3 fails:</strong> N goes back to 3 and keys map back to their old nodes. The keys still sitting unevicted on those old nodes become hits again. That is the one mercy in this design, and it lasts only as long as eviction hasn't cleared them. It shows the real problem: in this scheme, a key's location depends on how many nodes exist, not on which ones.
</div>
</div>

Stage 2 fixed capacity: memory and throughput now scale with nodes. But it turned every membership change — adding a node, a node crashing, replacing one — into a cluster-wide cache flush. With 40 nodes, machines are replaced every week. The placement scheme has to change.

<!-- stage:3:3. Consistent Hashing -->

## Stage 3 — Consistent Hashing

Hash keys and nodes onto the same circle. A key belongs to the first node found going clockwise from the key's position. Adding a node claims only the arc just before it. Removing a node hands its arc to the next node clockwise. Every other key stays exactly where it was ([Partitioning & Sharding](#/systems/partitioning-sharding) introduces the ring; this stage shows what it saves).

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 600 330" width="600" height="330" role="img" aria-label="An app server looking up keys on a hash ring of five cache nodes, with the database below">
  <rect x="20" y="140" width="112" height="36" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="76" y="162" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
  <circle cx="230" cy="158" r="62" fill="none" class="d-marker-line"></circle>
  <circle cx="251.2" cy="99.7" r="5" class="d-block d-block-request"></circle>
  <circle cx="288.3" cy="136.8" r="5" class="d-block d-block-request"></circle>
  <circle cx="283.7" cy="189" r="5" class="d-block d-block-request"></circle>
  <circle cx="208.8" cy="216.3" r="5" class="d-block d-block-request"></circle>
  <circle cx="171.7" cy="136.8" r="5" class="d-block d-block-request"></circle>
  <text x="246" y="117" text-anchor="middle" class="d-label-muted" font-size="10">A</text>
  <text x="274" y="145" text-anchor="middle" class="d-label-muted" font-size="10">E</text>
  <text x="270" y="185" text-anchor="middle" class="d-label-muted" font-size="10">B</text>
  <text x="213" y="206" text-anchor="middle" class="d-label-muted" font-size="10">C</text>
  <text x="186" y="145" text-anchor="middle" class="d-label-muted" font-size="10">D</text>
  <rect x="273.5" y="114.1" width="8" height="8" class="d-block d-block-response"></rect>
  <rect x="287.1" y="164.8" width="8" height="8" class="d-block d-block-response"></rect>
  <text x="287" y="108" class="d-note-text" font-size="10">product:7</text>
  <text x="300" y="176" class="d-note-text" font-size="10">user:42</text>
  <text x="230" y="244" text-anchor="middle" class="d-label-muted" font-size="9">● node   ■ key   clockwise →</text>
  <rect x="420" y="30" width="140" height="32" rx="6" class="d-actor-box" data-role="cache"></rect>
  <text x="490" y="51" text-anchor="middle" class="d-actor-label" font-size="11">Node A</text>
  <g data-fail-toggle="e3">
    <rect x="420" y="80" width="140" height="32" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="490" y="101" text-anchor="middle" class="d-actor-label" font-size="11">Node E (added)</text>
  </g>
  <g data-fail-toggle="b3">
    <rect x="420" y="130" width="140" height="32" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="490" y="151" text-anchor="middle" class="d-actor-label" font-size="11">Node B</text>
  </g>
  <rect x="420" y="180" width="140" height="32" rx="6" class="d-actor-box" data-role="cache"></rect>
  <text x="490" y="201" text-anchor="middle" class="d-actor-label" font-size="11">Node C</text>
  <rect x="420" y="230" width="140" height="32" rx="6" class="d-actor-box" data-role="cache"></rect>
  <text x="490" y="251" text-anchor="middle" class="d-actor-label" font-size="11">Node D</text>
  <rect x="20" y="262" width="112" height="36" rx="6" class="d-actor-box" data-role="datastore"></rect>
  <text x="76" y="284" text-anchor="middle" class="d-actor-label" font-size="12">Database</text>
  <line id="c3-app-ring" x1="134" y1="152" x2="164" y2="152" class="d-msg d-request" marker-end="url(#arrowC3)"></line>
  <line id="c3-ring-app" x1="164" y1="166" x2="134" y2="166" class="d-msg d-response" marker-end="url(#arrowC3r)"></line>
  <line id="c3-ring-e" x1="350" y1="140" x2="416" y2="92" class="d-msg d-request" data-depends-on="e3" marker-end="url(#arrowC3)"></line>
  <line id="c3-e-ring" x1="416" y1="104" x2="350" y2="148" class="d-msg d-response" data-depends-on="e3" marker-end="url(#arrowC3r)"></line>
  <line id="c3-ring-b" x1="350" y1="158" x2="416" y2="142" class="d-msg d-request" data-depends-on="b3" marker-end="url(#arrowC3)"></line>
  <line id="c3-b-ring" x1="416" y1="154" x2="350" y2="166" class="d-msg d-response" data-depends-on="b3" marker-end="url(#arrowC3r)"></line>
  <line id="c3-ring-c" x1="350" y1="176" x2="416" y2="192" class="d-msg d-request" marker-end="url(#arrowC3)"></line>
  <line id="c3-c-ring" x1="416" y1="204" x2="350" y2="184" class="d-msg d-response" marker-end="url(#arrowC3r)"></line>
  <line id="c3-app-db" x1="62" y1="178" x2="62" y2="258" class="d-msg d-request" marker-end="url(#arrowC3)"></line>
  <line id="c3-db-app" x1="92" y1="258" x2="92" y2="178" class="d-msg d-response" marker-end="url(#arrowC3r)"></line>
  <text x="300" y="320" text-anchor="middle" class="d-label-muted" font-size="10">play the read, then fail node B and play it again; then play the add-a-node flow</text>
  <defs>
    <marker id="arrowC3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowC3r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "ring", "title": "The ring", "rows": [["nodes on ring", "A · B · C · D"], ["user:42 →", "B"], ["product:7 →", "B"], ["keys that moved", "—"]]},
{"id": "db", "title": "Database load", "rows": [["reads/sec", "~90K of 150K"]]}
],
"flows": [
{
"id": "read",
"label": "Read user:42",
"nodes": ["b3", "e3"],
"steps": [
{"el": "c3-app-ring", "payload": "GET user:42", "text": "The client hashes user:42 to a point on the ring, then walks clockwise to the first node it meets: B. The ring is a sorted list of node positions in the client's memory, so this is a binary search, not a network call."},
{"el": "c3-ring-b", "payload": "GET user:42", "altEl": "c3-ring-c", "altSet": {"ring.nodes on ring": "A · C · D", "ring.user:42 →": "C (was B)", "ring.keys that moved": "only B's keys, ~¼"}, "text": "The request goes to node B.", "altText": "Node B is gone. The client removes B's point from the ring and walks clockwise again: past where B was, the next node is C. Only keys that belonged to B move. Keys on A, C and D keep their node, because nothing about their position or their node's position changed."},
{"el": "c3-b-ring", "payload": "{name: Ada}", "ms": 0.3, "altEl": "c3-c-ring", "altMs": 0.3, "altSet": {"db.reads/sec": "~520K of 150K, until C warms"}, "text": "A hit.", "altText": "C has never stored user:42: a miss, and the app will fill it from the database. That happens for about a quarter of keys — B's share — rather than two thirds with hash % N. It is still a large spike for a four-node cluster. With 20 nodes each node owns 5%, so the spike is far smaller, though Scale Estimates showed even five points of hit ratio strains this database. Stage 4 closes that gap. This is why a bigger cluster makes consistent hashing more forgiving, while it made hash % N worse."}
]
},
{
"id": "add",
"label": "Add node E, then read product:7",
"nodes": ["b3", "e3"],
"steps": [
{"el": "c3-app-ring", "payload": "GET product:7", "set": {"ring.nodes on ring": "A · E · B · C · D", "ring.product:7 →": "E (was B)", "ring.keys that moved": "only E's arc, ~⅕"}, "text": "Node E joins and lands on the ring between A and B. It takes over the arc from A up to itself — keys that used to walk clockwise to B. product:7 is on that arc. user:42, further round, still goes to B."},
{"el": "c3-ring-e", "payload": "GET product:7", "text": "The request goes to E."},
{"el": "c3-e-ring", "payload": "nil", "ms": 0.3, "set": {"db.reads/sec": "~430K of 150K, if moved at once"}, "text": "A miss: E is new and empty. Compare this with Stage 2. There, adding a node moved about 75% of keys. Here only E's arc — about a fifth — moved, and nothing else in the cluster was affected."},
{"el": "c3-ring-app", "payload": "nil", "text": "The miss goes back to the app."},
{"el": "c3-app-db", "payload": "SELECT … id=7", "text": "The app reads the database. A fifth of the cache going cold at once is still more than this database can take, so the move has to be gradual — see the last step."},
{"el": "c3-db-app", "payload": "{price: 19}", "ms": 5, "text": "The value comes back."},
{"el": "c3-app-ring", "payload": "SET product:7", "text": "The app writes it back."},
{"el": "c3-ring-e", "payload": "SET product:7", "ms": 0.3, "text": "Now E is warm for this key. In production the new node's arc is handed over in small steps, not all at once, so the extra database load is spread over minutes instead of arriving in one spike."}
]
}
]
}
</script>
<div class="diagram-caption">Fail node B and replay the read: the key walks on to C, and only B's share of keys moves. The add-a-node flow shows the same property in the other direction.</div>
</div>

<div class="fail-hint">Click node B or node E to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="b3">
<strong>If node B fails:</strong> its keys become misses on the next node clockwise, and nothing else moves. Replay the read to watch user:42 walk on to C. There is a subtler problem, though: <em>all</em> of B's load lands on C, and only on C. C now serves its own traffic plus B's — double the load — while A and D see nothing extra. If C was near capacity, it falls over too, and its keys and load move on to D. That is a cascade, and virtual nodes (below) are what prevents it.
</div>
<div class="failure-impact is-hidden" data-component="e3">
<strong>If the new node E fails:</strong> its arc goes back to B. If B hasn't evicted them yet, product:7 and its neighbours are still sitting there, and they become hits again. Adding or removing a node is now a local event affecting one arc. The flow halts at E because E is gone; the client's next ring update sends the key back to B.
</div>
</div>

### Virtual nodes

With one point per node, the arcs between points come out uneven — one node can easily own twice the keys of another — and a failed node's whole load goes to a single neighbour. The fix is to give each physical node many points on the ring, typically 100–200, each at a different hash (`hash("B#0")`, `hash("B#1")`, …). Now each node owns many small arcs scattered around the circle. Load evens out statistically. When B dies, its small arcs are picked up by many different neighbours, so its load spreads across the whole cluster instead of doubling one node. Virtual nodes also let a bigger machine take more points, and so a bigger share.

The ring is still a small data structure: 20 nodes × 150 points is 3,000 sorted entries, a few tens of kilobytes, held by every client. Keeping every client's copy the same is the next problem, and so is the fact that a key whose only copy was on B is gone the moment B dies.

<!-- stage:4:4. Replication & Failover -->

## Stage 4 — Replication & Failover

Consistent hashing limits how much of the cache a failure loses, but still loses it — at 20 nodes, one crash still sends a 5% slice of reads to the database, on top of normal misses. Give every primary a replica that holds a copy of the same keys. When a primary dies, promote its replica. The keys are still warm, and the ring doesn't have to change at all ([Replication](#/systems/replication)).

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 620 300" width="620" height="300" role="img" aria-label="An app server writing to a primary cache node that replicates asynchronously to a replica, with a coordinator monitoring both">
  <rect x="20" y="118" width="112" height="40" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="76" y="142" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
  <g data-fail-toggle="prim4">
    <rect x="260" y="36" width="150" height="44" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="335" y="55" text-anchor="middle" class="d-actor-label" font-size="12">Node B</text>
    <text x="335" y="70" text-anchor="middle" class="d-label-muted" font-size="9">primary</text>
  </g>
  <g data-fail-toggle="rep4">
    <rect x="260" y="186" width="150" height="44" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="335" y="205" text-anchor="middle" class="d-actor-label" font-size="12">Node B′</text>
    <text x="335" y="220" text-anchor="middle" class="d-label-muted" font-size="9">replica</text>
  </g>
  <g data-fail-toggle="coord4">
    <rect x="470" y="112" width="130" height="46" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="535" y="132" text-anchor="middle" class="d-actor-label" font-size="12">Coordinator</text>
    <text x="535" y="148" text-anchor="middle" class="d-label-muted" font-size="9">health + failover</text>
  </g>
  <line id="c4-app-prim" x1="134" y1="124" x2="256" y2="54" class="d-msg d-request" data-depends-on="prim4" marker-end="url(#arrowC4)"></line>
  <line id="c4-prim-app" x1="256" y1="68" x2="134" y2="136" class="d-msg d-response" data-depends-on="prim4" marker-end="url(#arrowC4r)"></line>
  <line id="c4-app-rep" x1="134" y1="142" x2="256" y2="202" class="d-msg d-request" data-depends-on="rep4" marker-end="url(#arrowC4)"></line>
  <line id="c4-rep-app" x1="256" y1="216" x2="134" y2="152" class="d-msg d-response" data-depends-on="rep4" marker-end="url(#arrowC4r)"></line>
  <line id="c4-prim-rep" x1="335" y1="82" x2="335" y2="182" class="d-msg d-request" data-depends-on="prim4 rep4" marker-end="url(#arrowC4)"></line>
  <text x="343" y="136" class="d-label-muted" font-size="9">async copy</text>
  <line id="c4-coord-prim" x1="466" y1="124" x2="414" y2="66" class="d-msg d-request" data-depends-on="coord4 prim4" marker-end="url(#arrowC4)"></line>
  <line id="c4-coord-rep" x1="466" y1="148" x2="414" y2="204" class="d-msg d-request" data-depends-on="coord4 rep4" marker-end="url(#arrowC4)"></line>
  <path id="c4-coord-app" d="M535,160 L535,262 L76,262 L76,162" class="d-msg d-response" data-depends-on="coord4" marker-end="url(#arrowC4r)"></path>
  <text x="310" y="290" text-anchor="middle" class="d-label-muted" font-size="10">play the write, then the read; fail node B and replay the read and the health check</text>
  <defs>
    <marker id="arrowC4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowC4r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "prim", "title": "Node B (primary)", "rows": [["cart:9", "v2"]]},
{"id": "rep", "title": "Node B′ (replica)", "rows": [["cart:9", "v2"]]},
{"id": "topo", "title": "Topology", "rows": [["primary for B's keys", "B"]]}
],
"flows": [
{
"id": "write",
"label": "Write, replicated asynchronously",
"nodes": ["prim4", "rep4", "coord4"],
"steps": [
{"el": "c4-app-prim", "payload": "SET cart:9 v3", "set": {"prim.cart:9": "v3"}, "text": "The app writes to the primary. Writes always go to the primary, so there is one order of writes for each key."},
{"el": "c4-prim-app", "payload": "OK", "ms": 0.3, "text": "The primary acknowledges right away, before the replica has the value. Waiting for the replica would add a round trip to every write — for data that can be rebuilt from the database anyway."},
{"el": "c4-prim-rep", "payload": "v3", "ms": 0.2, "set": {"rep.cart:9": "v3"}, "text": "A moment later the primary streams the write to its replica. Now both hold v3. The gap between the acknowledgement and this step is short, but it is not zero — and the next flow is about that gap."}
]
},
{
"id": "read",
"label": "Read cart:9 — right after v3 was acknowledged",
"nodes": ["prim4", "rep4", "coord4"],
"steps": [
{"el": "c4-app-prim", "payload": "GET cart:9", "set": {"prim.cart:9": "v3", "rep.cart:9": "v2 · v3 not yet copied"}, "altEl": "c4-app-rep", "altSet": {"prim.cart:9": "(node lost)", "rep.cart:9": "v2", "topo.primary for B's keys": "B′ (promoted)"}, "text": "The situation: v3 was just acknowledged by the primary, and the async copy has not reached the replica yet. The app reads the key.", "altText": "The primary crashed in exactly that gap. The replica has been promoted, and the read goes there instead. Nothing on the ring moved and no keys went cold."},
{"el": "c4-prim-app", "payload": "v3", "ms": 0.3, "altEl": "c4-rep-app", "altMs": 0.3, "text": "The primary returns v3, the value that was acknowledged.", "altText": "The new primary returns v2. A write that was acknowledged has been lost. This is what asynchronous replication costs. For a cache it is usually acceptable, because the database still has v3 and the TTL bounds how long v2 can be served. Deep Dives covers when it is not acceptable."}
]
},
{
"id": "health",
"label": "Coordinator health check",
"nodes": ["prim4", "rep4", "coord4"],
"steps": [
{"el": "c4-coord-prim", "payload": "PING", "altEl": "c4-coord-rep", "altSet": {"topo.primary for B's keys": "B′ (promoted)"}, "text": "The coordinator pings every primary about once a second. B answers, so there is nothing to do.", "altText": "B has missed its pings for several seconds. Several coordinator instances have to agree that it is down, so one lost ping can't trigger a failover. Then the coordinator promotes B′: it stops following B and starts accepting writes."},
{"el": "c4-coord-app", "payload": "topology", "ms": 0, "text": "The coordinator publishes the current topology: for each position on the ring, which node is primary. Clients cache it and refresh when told it has changed, or when a node answers MOVED. After a failover, this is how every client learns to send B's keys to B′."}
]
}
]
}
</script>
<div class="diagram-caption">Play the write, then the read. Then fail node B and replay the read: the replica answers, and the acknowledged v3 is gone. Replay the health check with B failed to see the promotion that makes that reroute legitimate.</div>
</div>

<div class="fail-hint">Click node B, its replica, or the coordinator to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="prim4">
<strong>If the primary fails:</strong> the coordinator detects it after a few seconds and promotes B′. For those seconds, reads and writes to B's keys fail or time out. The app should treat that as a miss and read the database, so users see slower responses, not errors. After promotion, the cache is warm again, apart from any writes still in the replication gap. The replaced B later rejoins as a replica, copying B′'s data before it counts as a copy.
</div>
<div class="failure-impact is-hidden" data-component="rep4">
<strong>If the replica fails:</strong> nothing on the request path notices. Reads and writes keep going to the primary. But B's keys now have no copy, so if the primary dies before the replica is replaced, those keys go cold exactly as in Stage 3. Alert on it, and don't treat it as urgent unless the primary is also unhealthy.
</div>
<div class="failure-impact is-hidden" data-component="coord4">
<strong>If the coordinator fails:</strong> no request fails. The coordinator sits entirely off the request path, and clients keep using the topology they have. What is lost is the ability to fail over: if a primary dies while the coordinator is down, nobody promotes its replica. So the coordinator runs as three or five instances that agree by majority ([Distributed Locking & Leader Election](#/systems/distributed-locking)). That majority rule also prevents split brain — two nodes both believing they are B's primary and accepting different writes.
</div>
</div>

Replicas can also serve reads, which doubles read capacity per shard. But a read from a replica may be a few milliseconds behind the primary, so a user who just wrote a value may not see it ([Consistency Models & CAP/PACELC](#/systems/consistency-cap)). Most deployments keep reads on primaries and use replicas only for failover, unless a specific key is hot enough to need them — and that is exactly the situation the last stage handles.

<!-- stage:5:5. Hot Keys & the Herd -->

## Stage 5 — Hot Keys & the Herd

Everything so far spreads load by spreading keys. That only works if traffic is spread across keys, and it never is. A product on the homepage, a celebrity's profile, a feature flag read on every request: one key receives more traffic than one node can serve, and adding nodes does nothing, because a key lives on one node however many there are. The same key causes a second problem when it expires: thousands of requests miss at the same moment, and they all go to the database together.

Two changes, both in the application's client library. A tiny **near-cache** in each app server holds the hottest keys for about a second. And **request coalescing** ensures that when a key is missing, one request rebuilds it while the others wait for that result.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 520 290" width="520" height="290" role="img" aria-label="Requests for one hot key hitting an app server with a near-cache, a cache node, and the database">
  <rect x="10" y="104" width="110" height="52" rx="6" class="d-note"></rect>
  <text x="65" y="126" text-anchor="middle" class="d-note-text" font-size="11">10,000 req/s</text>
  <text x="65" y="142" text-anchor="middle" class="d-note-text" font-size="11">product:7</text>
  <rect x="160" y="112" width="120" height="36" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="220" y="134" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
  <g data-fail-toggle="near5">
    <rect x="160" y="196" width="120" height="40" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="220" y="214" text-anchor="middle" class="d-actor-label" font-size="11">Near-cache</text>
    <text x="220" y="228" text-anchor="middle" class="d-label-muted" font-size="9">in-process, 1s TTL</text>
  </g>
  <g data-fail-toggle="nodec5">
    <rect x="350" y="46" width="140" height="40" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="420" y="64" text-anchor="middle" class="d-actor-label" font-size="11">Cache Node C</text>
    <text x="420" y="78" text-anchor="middle" class="d-label-muted" font-size="9">owns product:7</text>
  </g>
  <rect x="350" y="176" width="140" height="38" rx="6" class="d-actor-box" data-role="datastore"></rect>
  <text x="420" y="199" text-anchor="middle" class="d-actor-label" font-size="12">Database</text>
  <line id="c5-req-app" x1="122" y1="124" x2="156" y2="124" class="d-msg d-request" marker-end="url(#arrowC5)"></line>
  <line id="c5-app-req" x1="156" y1="138" x2="122" y2="138" class="d-msg d-response" marker-end="url(#arrowC5r)"></line>
  <line id="c5-app-near" x1="205" y1="150" x2="205" y2="192" class="d-msg d-request" data-depends-on="near5" marker-end="url(#arrowC5)"></line>
  <line id="c5-near-app" x1="235" y1="192" x2="235" y2="150" class="d-msg d-response" data-depends-on="near5" marker-end="url(#arrowC5r)"></line>
  <line id="c5-app-node" x1="282" y1="118" x2="346" y2="64" class="d-msg d-request" data-depends-on="nodec5" marker-end="url(#arrowC5)"></line>
  <line id="c5-node-app" x1="346" y1="78" x2="282" y2="128" class="d-msg d-response" data-depends-on="nodec5" marker-end="url(#arrowC5r)"></line>
  <line id="c5-app-db" x1="282" y1="136" x2="346" y2="186" class="d-msg d-request" marker-end="url(#arrowC5)"></line>
  <line id="c5-db-app" x1="346" y1="200" x2="282" y2="144" class="d-msg d-response" marker-end="url(#arrowC5r)"></line>
  <text x="260" y="276" text-anchor="middle" class="d-label-muted" font-size="10">play the hot read, then fail the near-cache and replay it; then play the expiry</text>
  <defs>
    <marker id="arrowC5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowC5r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "load", "title": "Traffic for product:7", "rows": [["requests arriving", "10,000/s across 20 app servers"], ["reaching node C", "—"], ["reaching the database", "—"]]}
],
"flows": [
{
"id": "hot",
"label": "Hot key — near-cache on",
"nodes": ["near5", "nodec5"],
"steps": [
{"el": "c5-req-app", "payload": "GET product:7", "text": "The key is on the homepage, so every page view asks for it: ten thousand requests a second, spread over 20 app servers."},
{"el": "c5-app-near", "payload": "lookup", "altEl": "c5-app-node", "altSet": {"load.reaching node C": "10,000/s, on one core"}, "text": "The app checks its own in-process near-cache first. It holds only a few thousand of the hottest keys, each for about a second.", "altText": "With no near-cache, every request goes to the one node that owns product:7. Ring placement can't help: this is one key, and one key lives on one node."},
{"el": "c5-near-app", "payload": "hit", "set": {"load.reaching node C": "~20/s (one refresh per app server per second)", "load.reaching the database": "0"}, "altEl": "c5-node-app", "altMs": 0.3, "altSet": {"load.reaching the database": "0 — for now"}, "text": "A hit in local memory, taking microseconds, with no network call. Each app server asks node C for this key about once a second, when its near-cache entry expires. Node C sees 20 requests a second instead of 10,000.", "altText": "Node C answers — but this one key is now most of its load, and when a single key's traffic is more than one core can serve, its latency rises for every key it owns. Each app server repeats the same request thousands of times a second, and nothing in between absorbs it."},
{"el": "c5-app-req", "payload": "200 OK", "text": "Served. The price is staleness: after the key changes, each app server can serve the old value for up to one second. For a product listing that is fine. For an account balance it is not, and those keys must never be put in a near-cache."}
]
},
{
"id": "herd",
"label": "Hot key expires — coalesced rebuild",
"nodes": ["near5", "nodec5"],
"steps": [
{"el": "c5-req-app", "payload": "GET product:7 ×500", "set": {"load.reaching node C": "—", "load.reaching the database": "—"}, "text": "product:7's TTL just ran out on node C. In the next few milliseconds, 500 requests for it arrive at this app server alone."},
{"el": "c5-app-node", "payload": "GET (one)", "set": {"load.reaching node C": "1 request, 499 waiting"}, "text": "Coalescing: the first request for a key starts the fetch, and the other 499 attach to it and wait for its result. Across the cluster, the first app server to miss takes a short lock with SET … NX, so only one server rebuilds the value."},
{"el": "c5-node-app", "payload": "nil", "ms": 0.3, "text": "A miss, as expected."},
{"el": "c5-app-db", "payload": "SELECT (one)", "set": {"load.reaching the database": "1 query, not 10,000"}, "text": "One query goes to the database. Without coalescing this step would happen 500 times on this server and about 10,000 times across the fleet, all in the same few milliseconds, all for the same row. That is a cache stampede: the database is overwhelmed by thousands of copies of one query."},
{"el": "c5-db-app", "payload": "{price: 19}", "ms": 5, "text": "The value comes back once."},
{"el": "c5-app-node", "payload": "SET product:7 EX 300", "ms": 0.3, "text": "The rebuilt value goes back to node C with a fresh TTL — and that TTL has a little random jitter added, so a thousand keys cached in the same second don't all expire in the same second."},
{"el": "c5-app-req", "payload": "200 OK ×500", "text": "All 500 waiting requests get the same answer. They waited about 5ms for it."}
]
}
]
}
</script>
<div class="diagram-caption">The near-cache cuts node C's load for this key from 10,000 to about 20 requests a second; fail it and replay to see the load land on one core. The expiry flow shows coalescing turning a stampede into one database query.</div>
</div>

<div class="fail-hint">Click the near-cache or cache node C to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="near5">
<strong>Without the near-cache:</strong> nothing is wrong, but every request for a hot key goes to the one node that owns it. Replay the hot read to see node C take all 10,000 requests a second on one core. Its latency rises for every key it holds, not just this one. This is the typical hot-key incident: one node at 100% CPU while the rest of the cluster is quiet, and adding nodes changes nothing.
</div>
<div class="failure-impact is-hidden" data-component="nodec5">
<strong>If node C fails:</strong> the near-caches keep serving product:7 for up to a second, which covers some of the failover window, so the hottest keys are protected longest. Replay the hot read with node C failed: it still succeeds from the near-cache. Keys too cold to be in the near-cache miss until C's replica is promoted. If a hot key misses during failover, coalescing is what stops it becoming a stampede on the database, so the two defences in this stage also protect against the failure in Stage 4.
</div>
</div>

This is the full design: consistent hashing with virtual nodes for placement, a replica per primary with coordinator-driven failover, and a client library that coalesces misses and keeps hot keys for a second. Each piece protects the same thing: the hit ratio, and so the database behind it.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### Why one thread is enough

A cache node that handles each command on a single thread sounds like a bottleneck. It usually isn't. A `GET` on an in-memory hash table takes well under a microsecond. Almost all the cost of serving it is network work: reading bytes off the socket, parsing, writing the reply. One thread running an event loop over thousands of connections can serve 100,000–200,000 commands a second, and it gets one large benefit for free: **every command is atomic**. `INCR` needs no lock, because nothing else runs while it runs. That is why the counters in [Rate Limiter as a Service](#/systems-case-studies/rate-limiter) and `SET … NX` locks are safe on top of a node.

The cost is that one slow command blocks every other client. `KEYS *` over 25 million keys, deleting a single value holding a million elements, or a 50MB `GET` can stall a node for hundreds of milliseconds. Well-built nodes move network reads and writes onto helper threads, free large values in the background, and disable scan-everything commands in production. The command execution itself stays on one thread. To use more cores, run more nodes per machine.

### Approximated LRU and LFU

Exact LRU needs every key on a linked list ordered by last access, and every read moves a key to the front — two pointer writes on the hottest path, plus 16 bytes per key. The approximation stores just a 24-bit last-access clock in each entry. When memory is needed, the node samples 5–10 random keys and evicts the one accessed longest ago. It also keeps a small pool of good eviction candidates between rounds, which brings it very close to exact LRU.

LRU has one weakness: a one-off scan. A batch job that reads 10 million cold keys once makes every one of them "most recently used" and pushes out the genuinely hot set. LFU resists this by keeping a small frequency counter per key — a logarithmic counter that fits in 8 bits and slowly decays — so a key read once can't outrank one read a thousand times. If the cache is shared with batch or analytics access, LFU is usually the better default.

### How expired keys are actually removed

Two mechanisms work together:

- **Lazily, on access.** Every read checks `expires_at` first. An expired key is deleted and reported as a miss. That makes expiry correct, but it never removes a key nobody reads again.
- **Actively, by sampling.** About ten times a second, the node samples 20 keys that have a TTL and deletes the expired ones. If more than a quarter of the sample was expired, it immediately samples again. This keeps memory spent on dead keys at a small fraction without ever scanning the whole keyspace, and it adapts on its own: a burst of expiries gets cleaned up faster.

Replicas never expire keys on their own clock. The primary sends an explicit delete when a key expires, so a primary and replica with slightly different clocks can't disagree about whether a key exists.

### Hash slots: a ring with fixed buckets

The Architecture used a ring with virtual nodes. A common alternative uses a fixed number of **hash slots**, for example 16,384. Each key goes to slot `hash(key) % 16384` — the modulus never changes, because the slot count never changes — and a small table maps each slot to a node.

It gives the same property as the ring: adding a node means moving some slots to it, and only keys in those slots move. It also makes moves explicit and gradual. A slot can be migrated key by key while both nodes serve it. During the move, the old node answers `ASK` for keys it has already handed over, and once the slot is fully moved it answers `MOVED`. The slot table is 16,384 small entries, cheap to send around the cluster. Whether to use a ring or slots is mostly about operations. Slots are easier to reason about and move deliberately, while rings suit clients that compute placement entirely on their own.

### Where routing lives

| Approach | Extra hop | Who knows the topology | Trade-off |
|---|---|---|---|
| Smart client | None | Every client | Fastest; every language needs a correct client, and every client must stay in sync |
| Proxy tier | One | The proxies | Clients stay simple; adds latency and a tier to scale and keep alive |
| Server redirect | Only on a stale map | Nodes, and clients lazily | Clients cache the map and are corrected by `MOVED`; the usual middle ground |

A node answers `MOVED` instead of forwarding the request for the same reason the design avoids a proxy. Forwarding would make every node a proxy for every other node: two hops on every misrouted request, and cross-node traffic that grows with the cluster. A redirect costs one extra round trip, once, and then the client knows where the key lives.

### Keeping the cache consistent with the database

Cache-aside has a race that surprises almost everyone the first time. The safe-looking write path is "update the database, then delete the cache key". Now consider:

```
t1  reader: GET user:42          → miss
t2  reader: SELECT user 42       → gets OLD row
t3  writer: UPDATE user 42       → database has NEW row
t4  writer: DEL user:42          → nothing to delete
t5  reader: SET user:42 OLD      → stale value cached
```

The reader's fill arrives after the writer's delete, and the cache now holds the old value until its TTL expires. Deleting is still much better than updating the cache on write: two concurrent writers updating the cache can leave it permanently out of order, while a delete at worst causes one extra miss. The remaining race has several standard mitigations:

- **Short TTLs** limit how long the damage can last. This is the reason every write carries `EX`.
- **Leases:** on a miss, the cache hands the reader a token, and a later delete invalidates it. The reader's `SET` is accepted only if its token is still valid, so the fill at t5 is rejected.
- **Invalidate from the database's change stream:** a process reads the database's replication log and deletes keys after every committed change. Deletes arrive in commit order and can be retried, and no application code path can forget to invalidate.

Pick based on how much staleness each key can tolerate. Most keys are fine with the TTL alone, and the lease and change-stream approaches are for the few that aren't.

### Snapshots, and restarting warm

A cache doesn't need durability, but it does benefit from a fast warm restart. A node can fork and write a point-in-time snapshot of its memory to disk every few minutes. The fork is cheap because the child process shares memory pages with the parent, copying only the pages that change while the snapshot is written. That copying is why Scale Estimates left headroom: a write-heavy node can nearly double its memory use during a snapshot. On restart, the node loads the snapshot and comes back with most of its keys, instead of empty.

An append-only log of every write gives stronger durability, at the cost of disk writes on the hot path. That is the step where a cache starts turning into a database, and this design deliberately doesn't take it.

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### The cache becomes load-bearing

The biggest risk isn't in the cache itself. The database behind it was sized for a 95% hit ratio, and it can't survive the cache going away. Every event that loses the cache at once — a cluster-wide restart, a deploy that changes key names, a serialization format change that makes every cached value unreadable — is a database outage. Treat those as dangerous operations. Roll them one node at a time. Version key names (`v2:user:42`) so a format change fills gradually instead of flushing everything. And know the number: how much of the cache can be lost at once before the database falls over? In this case study it is about five percentage points of hit ratio.

### Hot keys, beyond the near-cache

The near-cache handles read-hot keys that can tolerate a second of staleness. Two cases remain:

- **Hot keys that can't be stale.** Keep several copies of the key under different names (`product:7#0` … `product:7#9`), placed on different nodes, and have each read pick one at random. Writes must update all the copies, so this only suits keys that are read far more than written.
- **Write-hot keys**, such as a global counter incremented on every request. Split it into sub-counters on different nodes and add them up when read, the same technique as the rate limiter's hot-key fix.

Both require knowing which keys are hot. The node has to sample and report hot keys (see Monitoring), because by the time a human finds one, the node is already overloaded.

### Big values

A value measured in megabytes is a problem out of proportion to its size. It blocks the node's single thread while being serialized, uses a node's whole network capacity while being sent, and makes the replication stream slow for everything behind it. Cap value size in the client library — a few hundred kilobytes — and split or compress anything bigger. Large collections are worse than large strings: deleting a set with ten million members is ten million frees, which is why deletes of big values should be done in the background.

### Memory is not what it says

`used_memory` counts what the data structures asked for. The operating system sees more, because the allocator keeps partly empty pages that can't be returned after many keys of varied sizes are written and deleted. A fragmentation ratio of 1.5 means a node "using" 30GB takes 45GB of RAM. Add replication buffers, client output buffers, and snapshot copy-on-write, and a node configured for 40GB can run out of physical memory. Size the memory limit against real process memory, not the limit alone, and prefer allocators and settings that defragment in the background.

### Consistency, as a set of dials

This design is eventually consistent in three separate places, and each has its own dial:

- **Cache vs. database:** bounded by the TTL, tightened by leases or change-stream invalidation.
- **Primary vs. replica:** the async replication gap, a few milliseconds normally, and the reason a failover can lose an acknowledged write. A command that waits for N replicas to acknowledge narrows the gap for specific writes without slowing all of them.
- **Near-cache vs. cache:** the near-cache TTL, usually one second.

Tightening each one costs latency or throughput. The design choice is which keys deserve it, and the answer is almost always "a few, not all".

### What this design is still bad at

**Data that exists nowhere else.** Sessions, carts, or rate counters stored only in the cache are one failover away from being lost. That can be an acceptable choice, but it must be made deliberately, key by key.

**Cross-shard atomicity.** `MGET` across nodes is several independent reads. Anything that needs several keys to change together must keep them on one node (some systems allow a `{tag}` in the key name to force keys onto the same slot) or use a database.

**Cold start.** A brand-new cluster, or one recovering from a total loss, starts at a 0% hit ratio. Ramp traffic onto it gradually, or pre-warm it from a snapshot or a replay of recent keys, rather than switching all traffic over at once.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

A cache is an internal system, and that is exactly why it tends to be the weakest point in the architecture. It holds copies of sensitive data, it trusts whatever connects to it, and it was optimized for speed rather than defence ([Security & Authentication](#/systems/security-authentication)).

### Never reachable from outside

Cache nodes historically shipped with no authentication, and scans regularly find thousands of them exposed to the internet, holding user sessions and personal data, open to anyone who connects. The baseline is network isolation: nodes listen only on a private network, and only the app tier's security group can reach them. On top of that, require authentication, with separate users and permissions per service (read-only for the reporting job, no admin commands for applications), and use TLS if the network between app and cache is not fully trusted.

### Dangerous commands

A handful of commands can wipe or take over a node: flushing all data, rewriting its configuration (which on some systems can write files anywhere on disk), or scanning the entire keyspace. Disable or rename them in production, and restrict the rest by role. An application needs `GET`, `SET` and `DEL` on its own key prefix, and nothing else.

### Cache keys are a security boundary

The cache returns whatever is stored under a key to anyone who asks for that key. If a key doesn't include everything the value depends on, users see each other's data. The typical bug is caching a response under `page:/account` without the user ID, or under `report:{id}` without the tenant ID. The first user to load it fills the cache, and everyone after them gets that user's data. Build keys from a fixed template that always includes tenant and user where the data depends on them. Never build keys by joining raw user input, where a crafted value containing the delimiter could collide with another key.

### Memory exhaustion and eviction attacks

If attackers can cause keys to be created — by caching responses for arbitrary URLs, search queries, or IDs that don't exist — they control how much memory the cache uses and, through eviction, what gets pushed out. A flood of unique junk keys evicts the real working set, the hit ratio falls, and the database takes the load: a denial of service through the cache. Cache only normalized, bounded key spaces. Cache "not found" results with a short TTL so lookups of nonexistent IDs don't go through to the database every time, but cap how many of those entries one caller can create.

### What is stored, and how it is read back

Anything in the cache is as sensitive as its source, without the source's access controls or audit logging. Keep tokens, secrets and payment data out of it, give personal data short TTLs, and make sure deleting a user also deletes their cache entries. Also be careful how values are decoded. If the application stores language-native serialized objects and decodes them on read, anyone who can write to the cache can make the app execute code. Store plain data formats such as JSON or a schema-defined binary format, never executable serialization.

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **Hit ratio, overall and per key prefix.** This is the most important number, since Scale Estimates showed the database's health depends on it. A per-prefix view catches one feature's keys going cold while the overall number looks fine.
- **Latency, p50 and p99, per node.** One slow node usually means a hot key, a big value, or a blocking command.
- **Operations/sec per node.** Uneven load across nodes is how hot keys show up first.
- **Memory: used, real process memory, and fragmentation ratio**, against the configured limit.
- **Evictions/sec.** Steady evictions mean the working set is bigger than the cache. A sudden jump means something new is filling it.
- **Replication lag per replica**, in bytes or operations behind the primary, which is the size of the write-loss window during a failover.
- **Hot-key and big-key samples**, reported by the nodes themselves.
- **Database read rate**, shown next to the hit ratio. They are two views of the same thing.

### What to alert on

- **Hit ratio down more than a couple of points from baseline.** Scale Estimates showed five points is a database outage, so page before it gets there.
- A single node's CPU or ops/sec far above the cluster median: a hot key in progress.
- Real process memory above about 85% of the machine's RAM, whatever the configured limit says.
- Replication lag growing without recovering, or any replica disconnected — the next failover would lose data or leave keys cold.
- Any failover. An automatic failover should still tell a human, because a primary that keeps failing needs a person to look at it.

### A primary just died — what happens?

What the Stage 4 toggles simulate. For a few seconds, reads and writes to that node's keys time out and fall through to the database. The coordinator agrees the node is down and promotes its replica, clients pick up the new topology, and the hit ratio recovers, minus any writes in the replication gap.

The runbook: confirm the promotion happened and clients follow the new topology (watch for `MOVED` errors dropping back to near zero). Check whether the cause was a hot key or a big value, because the same key will now overload the new primary. Then provision a replacement node, let it sync as the new replica, and only then consider the shard healthy again. Until that sync finishes, the shard has one copy.

### Adding capacity

Add nodes one at a time, and move ownership to each one gradually — a few slots or a slice of ring positions at a time — while watching the database read rate. Each step makes a small slice of keys cold. Step size is set by how much extra database load you can afford. This is the operational benefit of Stage 3: capacity changes are routine, not risky.

### Rolling restarts and upgrades

Never restart primaries at the same time. Per shard: restart or upgrade the replica, wait for it to fully sync, deliberately fail over so it becomes primary, then restart the old primary as the new replica. Every shard stays warm throughout, and the only visible effect is a brief latency blip at each planned failover. Changes that affect the whole keyspace — a key-format change, a serializer upgrade — ship behind a versioned key prefix, so the new version fills the cache while the old keys expire.
