# Distributed ID Generator

Every row, message, order and event in a large system needs an identifier, and the identifier is usually needed before anything is written: it becomes the primary key, the foreign key in three other tables, the idempotency token, and the cursor a client pages with. Producing a number that has never been produced before is trivial on one machine. Doing it hundreds of thousands of times a second, on many machines that never talk to each other, without a single duplicate and with the numbers still roughly in time order, is the problem this case study solves.

<!-- tab:requirements:Requirements -->

## Requirements

This case study builds the ID generator itself, as a shared piece of infrastructure used by every service in a large product: orders, messages, posts, payments, events. Each service calls it on its write path, so whatever it costs in latency or availability, every write in the company pays.

### Functional requirements

- **Generate a unique ID** on request. Unique across every service, every machine and every data centre, forever.
- **IDs are 64-bit integers.** They fit in a database `BIGINT`, a single CPU register, and an 8-byte index entry.
- **IDs are roughly sortable by creation time.** An ID generated a second later should almost always be larger. Strict ordering between two IDs created in the same millisecond on different machines is not required.
- **Batch generation:** a caller can ask for many IDs in one call, for bulk imports and fan-out writes.
- **Decode an ID:** given an ID, recover when it was created and which generator made it. This is useful for debugging, and it lets a range of IDs stand in for a range of time.

### Non-functional requirements

- **Uniqueness is absolute.** A duplicate ID is not a degraded experience. It is two orders silently sharing a primary key, or one user's message overwriting another's. No failure, restart or clock problem may ever produce one. Every other requirement gives way to this one.
- **Highly available.** Target **99.99%**. If IDs can't be generated, nothing can be written.
- **Low latency.** Under **1ms at p99**, measured at the generator. Generation should be invisible next to the database write it precedes.
- **High throughput.** **400,000 IDs/sec** at peak across the company, with room to grow several times over.
- **No central bottleneck.** Adding capacity should mean adding generators, not making one generator bigger.

### In scope

The ID format and its bit layout, how generators are made independent of each other, how each one gets a distinct identity, and how the design survives restarts and misbehaving clocks.

### Out of scope

**Gapless sequences** such as invoice numbers that some jurisdictions require to have no holes. Those need one serialized counter per sequence and are a separate, much lower-volume design. **Strict global ordering** of every event in the company, which needs consensus on every ID ([Consensus](#/systems/consensus)) and is far slower. **Short human-facing codes**, which are covered in the [URL Shortener](#/systems-case-studies/url-shortener).

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

The interesting numbers here are not storage or bandwidth, which are tiny. They are bit counts. A 64-bit ID is a fixed budget, and every requirement — how long the scheme lasts, how many generators can exist, how fast each can go — is paid for out of it.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Peak demand</div>
<div class="stat-tile-value">~400<span class="stat-tile-unit">K/sec</span></div>
<div class="stat-tile-sub">IDs, across all services</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">ID size</div>
<div class="stat-tile-value">64<span class="stat-tile-unit">bits</span></div>
<div class="stat-tile-sub">one BIGINT, 8 bytes</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Lifespan</div>
<div class="stat-tile-value">~69<span class="stat-tile-unit">years</span></div>
<div class="stat-tile-sub">41 bits of milliseconds</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Generators</div>
<div class="stat-tile-value">1,024</div>
<div class="stat-tile-sub">10 bits of worker ID</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Per generator</div>
<div class="stat-tile-value">~4.1<span class="stat-tile-unit">M/sec</span></div>
<div class="stat-tile-sub">4,096 IDs per millisecond</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Coordination per ID</div>
<div class="stat-tile-value">0</div>
<div class="stat-tile-sub">the target the design reaches</div>
</div>
</div>

### Assumptions

- 100,000 IDs/sec on average, with peaks of 4× that: **400,000 IDs/sec**.
- About 3 trillion IDs a year (100,000 × 31.5 million seconds).
- The system should run for decades without changing ID format, because IDs are stored in every table and every client.
- Up to a few hundred machines will generate IDs at once, more during deploys when old and new instances overlap.

### Why one counter can't keep up

The simplest generator is one database row incremented on every request. Each increment must be durable before the ID is returned, or a crash could hand the same number out twice. Incrementing one row durably is serialized by that row's lock, and realistically manages on the order of **10,000 IDs/sec**. Peak demand is **40 times** that. And a single row is a single point of failure for every write in the company.

### The bit budget

A 64-bit ID has 63 usable bits, since the top bit is left at 0 so the number stays positive in languages and databases with signed 64-bit integers. Splitting those 63 bits three ways:

- **41 bits of time, in milliseconds.** 2<sup>41</sup> ms is about **69.7 years**. Counted from a custom epoch (here, 1 January 2024) rather than from 1970, the whole range is in the future.
- **10 bits of worker ID.** 2<sup>10</sup> = **1,024** distinct generators can run at the same time.
- **12 bits of sequence.** 2<sup>12</sup> = **4,096** IDs per millisecond per generator, about **4.1 million per second**.

Check it against demand: 400,000 IDs/sec spread over, say, 20 generators is 20,000/sec each — 20 per millisecond, against a ceiling of 4,096. One generator could carry the whole company's peak by itself. The bits are spent generously on lifespan and generator count because those are the hard limits; throughput has a 200× margin.

### Storage

The ID's size matters more than it looks, because it is copied into every index and every foreign key. Compare a 64-bit ID with a 128-bit UUID: 8 extra bytes per copy. At 3 trillion rows a year, with each ID stored about four times (primary key, one secondary index, two foreign keys), that is roughly **100TB a year** of extra index — on the most frequently read structures in every database, where it costs cache memory, not just disk.

<!-- tab:api-design:API Design -->

## API Design

The generator is offered two ways: as a small network service, and as a library linked into each application. Both produce the same IDs; Deep Dives covers when to use which.

### Service endpoints

```
POST /v1/ids
→ 200 {"id": "364018610995269632"}

POST /v1/ids:batch   {"count": 500}
→ 200 {"ids": ["364018610995269633", "364018610995269634", ...]}

GET /v1/ids/364018610995269632
→ 200 {"timestamp": "2026-10-01T12:00:00.000Z", "worker": 17, "sequence": 0}
```

| Status | Meaning |
|---|---|
| `200` | IDs issued |
| `400` | `count` above the per-call cap (1,000) |
| `429` | The caller exceeded its quota |
| `503` | This generator can't safely issue IDs right now — its clock went backwards, or it lost its worker ID. Retry on another generator |

A few details carry more weight than they look like they should:

**IDs travel as strings in JSON.** JavaScript numbers are 64-bit floats, which hold integers exactly only up to 2<sup>53</sup>. An ID like 364018610995269632 is larger than that, so a browser parsing it as a number silently rounds it to a neighbouring value — a different, wrong ID. The service returns strings, and every client treats IDs as opaque text outside the database.

**`503` means "ask someone else", never "try a different ID".** A generator that is unsure it can produce a unique ID refuses. Callers retry on another generator, which is safe because generators share nothing.

**Batches are capped.** A batch of 1,000 IDs takes a quarter of one millisecond's sequence space. An uncapped batch of a million would stall the generator for 250ms while it waited for enough milliseconds to pass.

### Library interface

```
gen = IdGenerator(worker_id=17, epoch="2024-01-01T00:00:00Z")
id  = gen.next()          # ~1µs, no network
ids = gen.next_batch(500)
gen.decode(id)            # (timestamp, worker, sequence)
```

The library has no network call on the hot path at all. What it does need is a worker ID that no other running generator has, and getting one safely is Stage 5 of the architecture.

<!-- tab:data-model:Data Model -->

## Data Model

There are two pieces of state: the format of the ID itself, and the small amount of bookkeeping that keeps generators from colliding.

### The ID layout

```
 0 | 00001010000110101000000111111111000000000 | 0000010001 | 000000000000
 ↑   └──── 41 bits: ms since 2024-01-01 ─────┘   └ worker ┘   └ sequence ┘
sign                                              10 bits       12 bits
bit
```

An ID is built by shifting each field into place:

```
id = (timestamp_ms - epoch_ms) << 22
   | worker_id               << 12
   | sequence
```

For 1 October 2026 at 12:00:00.000 UTC, worker 17, sequence 0, that is **364018610995269632**. Because time sits in the top bits, comparing two IDs as integers compares their timestamps first. That is the whole trick behind "sortable": no index on a separate `created_at` column is needed to sort by creation time, or to find everything created between two moments.

Decoding reverses it: `timestamp = (id >> 22) + epoch`, `worker = (id >> 12) & 1023`, `sequence = id & 4095`.

### Per-generator state, in memory

```
generator
  worker_id    10 bits   -- unique among running generators
  last_ts      int64     -- millisecond of the last ID issued
  sequence     12 bits   -- next sequence number within last_ts
```

Three numbers. On each request: read the clock; if it is the same millisecond as `last_ts`, increment `sequence`; if it is a later millisecond, reset `sequence` to 0. Everything about uniqueness follows from one rule: **a generator never issues two IDs with the same (timestamp, sequence)**, and no two running generators share a worker ID.

### Worker leases, in the coordinator

```
worker_lease
  worker_id         int        PRIMARY KEY   -- 0..1023
  holder            text                     -- "id-node-a:pid 4412"
  lease_expires_at  timestamp
  last_ts           int64                    -- highest timestamp the holder reported
```

At most 1,024 rows, in a small strongly consistent store ([Consensus](#/systems/consensus)). This is the only shared state in the design, and it is touched when a generator starts and every few seconds after, never per ID. `last_ts` is what lets a new holder of worker 17 know which timestamps the previous holder already used.

### What is deliberately missing

There is no table of issued IDs, and no check for duplicates. Uniqueness comes from the structure of the ID, not from looking anything up. A design that needs to check each ID against a list of used ones has a shared bottleneck on every request — the thing this design exists to remove.

<!-- tab:architecture:Architecture:default -->

This case study builds the ID generator up in five stages. Each stage fixes a specific failure of the one before. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one request at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. One Counter -->

## Stage 1 — One Counter

The smallest version that works: one database with one auto-incrementing counter. Every service asks it for the next number. The database guarantees each number is handed out once, because it serializes the increments and makes each one durable before answering ([Relational Databases](#/systems/databases-relational)).

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 520 250" width="520" height="250" role="img" aria-label="An order service and a message service both requesting IDs from one counter database">
  <rect x="30" y="44" width="142" height="36" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="101" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Order Service</text>
  <rect x="30" y="160" width="142" height="36" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="101" y="182" text-anchor="middle" class="d-actor-label" font-size="12">Message Service</text>
  <g data-fail-toggle="ctr1">
    <rect x="320" y="96" width="170" height="48" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="405" y="116" text-anchor="middle" class="d-actor-label" font-size="12">Counter DB</text>
    <text x="405" y="132" text-anchor="middle" class="d-label-muted" font-size="9">one row: next_id</text>
  </g>
  <line id="i1-ord-db" x1="174" y1="56" x2="316" y2="106" class="d-msg d-request" data-depends-on="ctr1" marker-end="url(#arrowI1)"></line>
  <line id="i1-db-ord" x1="316" y1="120" x2="174" y2="72" class="d-msg d-response" data-depends-on="ctr1" marker-end="url(#arrowI1r)"></line>
  <line id="i1-msg-db" x1="174" y1="170" x2="316" y2="132" class="d-msg d-request" data-depends-on="ctr1" marker-end="url(#arrowI1)"></line>
  <line id="i1-db-msg" x1="316" y1="140" x2="174" y2="186" class="d-msg d-response" data-depends-on="ctr1" marker-end="url(#arrowI1r)"></line>
  <text x="260" y="236" text-anchor="middle" class="d-label-muted" font-size="10">play one request, then two at once — then fail the counter and replay</text>
  <defs>
    <marker id="arrowI1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowI1r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "ctr", "title": "Counter DB", "rows": [["next_id", "1,000,042"], ["waiting on the row lock", "0"]]},
{"id": "load", "title": "Capacity", "rows": [["IDs/sec it can issue", "~10K"], ["IDs/sec needed at peak", "400K"]]}
],
"flows": [
{
"id": "one",
"label": "Order service gets an ID",
"nodes": ["ctr1"],
"steps": [
{"el": "i1-ord-db", "payload": "next id", "set": {"ctr.next_id": "1,000,043"}, "text": "A customer places an order. Before the order row can be written, the order service needs its ID, so it asks the counter. The database locks the row, increments it, and writes the change durably to disk."},
{"el": "i1-db-ord", "payload": "1,000,042", "ms": 2, "text": "The order gets ID 1,000,042, about 2ms later. It is unique, because the database never hands out the same value twice, and it is perfectly ordered: every later ID is bigger. Both properties are exactly what this design wants. The problem is what they cost."}
]
},
{
"id": "two",
"label": "Two services at the same moment",
"nodes": ["ctr1"],
"steps": [
{"el": "i1-msg-db", "payload": "next id", "set": {"ctr.next_id": "1,000,044", "ctr.waiting on the row lock": "1"}, "text": "A message is sent at the same moment. The message service asks the counter too. The increment takes the row lock."},
{"el": "i1-ord-db", "payload": "next id", "text": "The order service's next request arrives while that lock is held. It has to wait. Every ID in the company goes through this one row, one at a time."},
{"el": "i1-db-msg", "payload": "1,000,043", "ms": 2, "set": {"ctr.waiting on the row lock": "0", "ctr.next_id": "1,000,045"}, "text": "The message gets its ID and the lock is released."},
{"el": "i1-db-ord", "payload": "1,000,044", "ms": 2, "text": "Only now does the order service get its ID: 4ms instead of 2. With two callers the queue is short. At peak there are 400,000 requests a second against a row that can serve about 10,000, so the queue never drains — latency grows until requests time out."}
]
}
]
}
</script>
<div class="diagram-caption">One request costs a durable write on a shared row. Two concurrent requests queue behind each other. Fail the counter and replay: no service can get an ID, so no service can write anything.</div>
</div>

<div class="fail-hint">Click the counter database to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="ctr1">
<strong>If the counter database fails:</strong> every service that needs a new ID stops writing. Orders, messages, sign-ups and payments all fail together, even though their own databases are healthy. A database replica can be promoted, but promotion takes seconds to minutes, and if the replica was even slightly behind it may hand out numbers the old primary already issued. That is a duplicate ID, the one outcome the requirements forbid. So failover has to skip ahead — for example by adding a large safety gap to the counter — which is possible but must be designed and tested deliberately.
</div>
</div>

This design gets uniqueness and ordering exactly right, and both come from the same source: one place that sees every request in order. That one place is also the throughput ceiling, the latency floor, and a single point of failure for every write in the company. The rest of this case study is about keeping uniqueness while giving up the single place.

<!-- stage:2:2. Several Counters -->

## Stage 2 — Several Counters, Interleaved

Run several counter databases, and give each one a different set of numbers. With two of them, server A issues only odd numbers and server B only even numbers: each starts at a different offset and steps by 2. Their outputs can never collide, so they never need to talk to each other. Callers spread requests across them, and if one dies they use the other.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 560 280" width="560" height="280" role="img" aria-label="An app server requesting IDs from two ticket servers, one issuing odd numbers and one issuing even numbers">
  <rect x="20" y="122" width="122" height="38" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="81" y="145" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
  <g data-fail-toggle="tka2">
    <rect x="330" y="40" width="190" height="48" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="425" y="60" text-anchor="middle" class="d-actor-label" font-size="12">Counter A</text>
    <text x="425" y="76" text-anchor="middle" class="d-label-muted" font-size="9">odd only: start 1, step 2</text>
  </g>
  <g data-fail-toggle="tkb2">
    <rect x="330" y="190" width="190" height="48" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="425" y="210" text-anchor="middle" class="d-actor-label" font-size="12">Counter B</text>
    <text x="425" y="226" text-anchor="middle" class="d-label-muted" font-size="9">even only: start 2, step 2</text>
  </g>
  <line id="i2-app-a" x1="144" y1="128" x2="326" y2="60" class="d-msg d-request" data-depends-on="tka2" marker-end="url(#arrowI2)"></line>
  <line id="i2-a-app" x1="326" y1="76" x2="144" y2="140" class="d-msg d-response" data-depends-on="tka2" marker-end="url(#arrowI2r)"></line>
  <line id="i2-app-b" x1="144" y1="146" x2="326" y2="206" class="d-msg d-request" data-depends-on="tkb2" marker-end="url(#arrowI2)"></line>
  <line id="i2-b-app" x1="326" y1="222" x2="144" y2="156" class="d-msg d-response" data-depends-on="tkb2" marker-end="url(#arrowI2r)"></line>
  <text x="280" y="268" text-anchor="middle" class="d-label-muted" font-size="10">play the request, fail counter A and replay; then play the two orders</text>
  <defs>
    <marker id="arrowI2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowI2r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "ctrs", "title": "Counters", "rows": [["A next (odd)", "1,000,043"], ["B next (even)", "640,018"]]},
{"id": "issued", "title": "IDs issued", "rows": [["order placed 12:00:00", "—"], ["order placed 12:00:01", "—"]]}
],
"flows": [
{
"id": "get",
"label": "Get an ID",
"nodes": ["tka2", "tkb2"],
"steps": [
{"el": "i2-app-a", "payload": "next id", "altEl": "i2-app-b", "text": "The app server alternates between the counters. This request goes to A.", "altText": "Counter A is not answering, so the app server sends the request to B instead. No coordination is needed: B's numbers can't clash with anything A ever issued."},
{"el": "i2-a-app", "payload": "1,000,043", "ms": 2, "set": {"ctrs.A next (odd)": "1,000,045"}, "altEl": "i2-b-app", "altMs": 2, "altSet": {"ctrs.B next (even)": "640,020"}, "text": "An odd number from A. Two counters means roughly twice the capacity, and either one can fail without stopping ID generation.", "altText": "An even number from B. ID generation survived the failure, with half the capacity until A returns."}
]
},
{
"id": "order",
"label": "Two orders, one second apart",
"nodes": ["tka2", "tkb2"],
"steps": [
{"el": "i2-app-a", "payload": "next id", "altEl": "i2-app-b", "text": "At 12:00:00 a customer places an order. The request goes to counter A.", "altText": "Counter A is down, so the request goes to B."},
{"el": "i2-a-app", "payload": "1,000,043", "ms": 2, "set": {"issued.order placed 12:00:00": "1,000,043"}, "altEl": "i2-b-app", "altMs": 2, "altSet": {"issued.order placed 12:00:00": "640,018"}, "text": "The first order is 1,000,043.", "altText": "The first order is 640,018."},
{"el": "i2-app-b", "payload": "next id", "text": "One second later, another order. Round-robin sends it to counter B. B was out of rotation for most of last month while its disk was replaced, so it has issued far fewer numbers than A."},
{"el": "i2-b-app", "payload": "640,018", "ms": 2, "set": {"issued.order placed 12:00:01": "640,018"}, "text": "The second order is 640,018 — 360,000 lower than an order placed a second earlier. Uniqueness held, but ordering is gone. Sorting orders by ID no longer sorts them by time, and the two counters drift further apart whenever their load is uneven."}
]
}
]
}
</script>
<div class="diagram-caption">Fail counter A and replay the request: B carries on alone. The two-orders flow shows the cost — the later order gets the smaller ID.</div>
</div>

<div class="fail-hint">Click counter A or counter B to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="tka2">
<strong>If counter A fails:</strong> callers send every request to B, so ID generation continues at half capacity. The odd numbers simply stop appearing for a while, which is harmless — gaps in IDs carry no meaning. This is a real improvement over Stage 1: no single counter is a point of failure. When A recovers it continues from where it was, and as long as its last increment was durable it can never repeat a number.
</div>
<div class="failure-impact is-hidden" data-component="tkb2">
<strong>If counter B fails:</strong> the same as A, in reverse. With only two counters, one failure halves capacity, and at peak half is not enough. More counters means a smaller loss per failure, but the scheme makes adding counters awkward: the step is baked into every counter's arithmetic. Going from 2 counters to 3 means changing every counter's step and choosing new starting points above anything already issued, in a coordinated change across all of them.
</div>
</div>

This stage removed the single point of failure without any coordination between counters — the important idea, which every later stage keeps. What it kept from Stage 1 is a network round trip and a durable database write for every ID. What it lost is ordering. The next stage removes the round trip entirely.

<!-- stage:3:3. Random UUIDs -->

## Stage 3 — Random UUIDs

Give up on counters. Each application server generates a random 128-bit UUID (version 4) by itself: 122 random bits and 6 fixed format bits. No database, no network call, nothing shared. The chance of two random 122-bit values colliding is so small that a system generating a billion UUIDs a second would expect its first duplicate after about 85 years.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 580 290" width="580" height="290" role="img" aria-label="An app server generating a random UUID in-process and inserting it into an orders database whose index pages are scattered">
  <rect x="20" y="104" width="140" height="40" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="90" y="128" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
  <rect x="20" y="196" width="140" height="44" rx="6" class="d-note"></rect>
  <text x="90" y="215" text-anchor="middle" class="d-note-text" font-size="11">uuid4()</text>
  <text x="90" y="230" text-anchor="middle" class="d-note-text" font-size="9">in-process, random</text>
  <g data-fail-toggle="db3">
    <rect x="350" y="94" width="200" height="60" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="450" y="118" text-anchor="middle" class="d-actor-label" font-size="12">Orders DB</text>
    <text x="450" y="135" text-anchor="middle" class="d-label-muted" font-size="9">B-tree primary key on id</text>
  </g>
  <rect x="354" y="196" width="18" height="18" class="d-block d-block-request"></rect>
  <rect x="378" y="196" width="18" height="18" class="d-block d-block-request"></rect>
  <rect x="402" y="196" width="18" height="18" class="d-block d-block-response"></rect>
  <rect x="426" y="196" width="18" height="18" class="d-block d-block-request"></rect>
  <rect x="450" y="196" width="18" height="18" class="d-block d-block-request"></rect>
  <rect x="474" y="196" width="18" height="18" class="d-block d-block-response"></rect>
  <rect x="498" y="196" width="18" height="18" class="d-block d-block-request"></rect>
  <rect x="522" y="196" width="18" height="18" class="d-block d-block-response"></rect>
  <text x="450" y="232" text-anchor="middle" class="d-label-muted" font-size="9">index leaf pages — inserts land anywhere</text>
  <line id="i3-app-gen" x1="70" y1="146" x2="70" y2="192" class="d-msg d-request" marker-end="url(#arrowI3)"></line>
  <line id="i3-gen-app" x1="110" y1="192" x2="110" y2="146" class="d-msg d-response" marker-end="url(#arrowI3r)"></line>
  <line id="i3-app-db" x1="162" y1="114" x2="346" y2="114" class="d-msg d-request" data-depends-on="db3" marker-end="url(#arrowI3)"></line>
  <line id="i3-db-app" x1="346" y1="134" x2="162" y2="134" class="d-msg d-response" data-depends-on="db3" marker-end="url(#arrowI3r)"></line>
  <text x="290" y="276" text-anchor="middle" class="d-label-muted" font-size="10">play the insert, then the newest-first query</text>
  <defs>
    <marker id="arrowI3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowI3r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "id", "title": "The ID", "rows": [["value", "—"], ["size", "128 bits (16 bytes)"], ["network calls to make it", "—"]]},
{"id": "idx", "title": "Orders index", "rows": [["leaf page written", "—"], ["page already in memory?", "—"]]}
],
"flows": [
{
"id": "insert",
"label": "Insert an order with a random ID",
"nodes": ["db3"],
"steps": [
{"el": "i3-app-gen", "payload": "uuid4()", "text": "The app server needs an ID for a new order. It calls its own UUID function, reading 16 bytes from the operating system's random number generator."},
{"el": "i3-gen-app", "payload": "f47ac10b-58cc-…", "ms": 0, "set": {"id.value": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "id.network calls to make it": "0"}, "text": "It takes about a microsecond, with no network call and no shared state. The generator can't fail, can't be overloaded, and every app server has its own. Stages 1 and 2's problems are gone at once."},
{"el": "i3-app-db", "payload": "INSERT id=f47a…", "set": {"idx.leaf page written": "#28,113 of 40,000 — random", "idx.page already in memory?": "likely not → disk read"}, "text": "Now the order is written. The primary key index is a B-tree sorted by ID. A random ID belongs at a random position in that order, so each insert lands on a random leaf page among tens of thousands."},
{"el": "i3-db-app", "payload": "OK", "ms": 6, "text": "Once the table is bigger than memory, the page that insert needs is usually not cached, so it must be read from disk first. Pages also fill unevenly and split in random places, leaving the index fragmented and about a third larger. The insert took 6ms instead of about 1. Sequential IDs would all have landed on the same hot last page, which is always in memory."}
]
},
{
"id": "recent",
"label": "List the newest orders",
"nodes": ["db3"],
"steps": [
{"el": "i3-app-db", "payload": "ORDER BY id DESC LIMIT 20", "text": "The orders page shows the 20 most recent orders. With Stage 1's IDs this was a walk backwards from the end of the primary key index."},
{"el": "i3-db-app", "payload": "20 random orders", "ms": 1, "text": "With random IDs, the 'largest' IDs are not the newest — they are just random. Sorting by time now needs a separate created_at column with its own index: another write on every insert, more storage, and pagination cursors that need two columns to be unambiguous. The ID still identifies the order, but it no longer says anything about when."}
]
}
]
}
</script>
<div class="diagram-caption">Generation is free and local. The cost moves to the database: each random ID is inserted at a random place in the index, and the ID no longer sorts by time.</div>
</div>

<div class="fail-hint">Click the orders database to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="db3">
<strong>If the orders database fails:</strong> orders can't be saved, but notice what is no longer involved: ID generation. In Stages 1 and 2, the ID service was a dependency of every write in the company, and its failure stopped them all. Here each app server makes its own IDs, so there is no ID component to fail. That property — generation with zero shared dependencies — is what the remaining stages keep, while recovering what UUIDs gave up.
</div>
</div>

Random UUIDs fixed everything about generation and broke two of the requirements. They are 128 bits, not 64, and they carry no time. The next stage takes the coordination-free part of this design and the ordering of Stage 1, and fits both into 64 bits.

<!-- stage:4:4. Time + Worker + Sequence -->

## Stage 4 — Time + Worker + Sequence

Build the ID from three parts, as laid out in the Data Model: a millisecond timestamp in the top 41 bits, a worker ID in the next 10, and a per-millisecond sequence number in the last 12. Each generator has its own worker ID, so two generators can't produce the same ID, whatever their clocks say. Within one generator, the sequence separates IDs issued in the same millisecond. And because time is in the top bits, IDs sort by creation time.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 600 330" width="600" height="330" role="img" aria-label="An app server requesting IDs from two independent generators, worker 17 and worker 18, with the 64-bit ID layout below">
  <rect x="20" y="124" width="122" height="40" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="81" y="148" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
  <g data-fail-toggle="w17">
    <rect x="260" y="36" width="190" height="56" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="355" y="58" text-anchor="middle" class="d-actor-label" font-size="12">Generator · worker 17</text>
    <text x="355" y="76" text-anchor="middle" class="d-label-muted" font-size="9">clock · last_ts · sequence</text>
  </g>
  <g data-fail-toggle="w18">
    <rect x="260" y="196" width="190" height="56" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="355" y="218" text-anchor="middle" class="d-actor-label" font-size="12">Generator · worker 18</text>
    <text x="355" y="236" text-anchor="middle" class="d-label-muted" font-size="9">clock · last_ts · sequence</text>
  </g>
  <text x="510" y="140" text-anchor="middle" class="d-label-muted" font-size="9">no link between</text>
  <text x="510" y="153" text-anchor="middle" class="d-label-muted" font-size="9">generators</text>
  <line id="i4-app-17" x1="144" y1="130" x2="256" y2="60" class="d-msg d-request" data-depends-on="w17" marker-end="url(#arrowI4)"></line>
  <line id="i4-17-app" x1="256" y1="78" x2="144" y2="142" class="d-msg d-response" data-depends-on="w17" marker-end="url(#arrowI4r)"></line>
  <line id="i4-app-18" x1="144" y1="148" x2="256" y2="212" class="d-msg d-request" data-depends-on="w18" marker-end="url(#arrowI4)"></line>
  <line id="i4-18-app" x1="256" y1="230" x2="144" y2="158" class="d-msg d-response" data-depends-on="w18" marker-end="url(#arrowI4r)"></line>
  <rect x="40" y="272" width="14" height="24" class="d-note"></rect>
  <rect x="54" y="272" width="302" height="24" class="d-note"></rect>
  <rect x="356" y="272" width="90" height="24" class="d-note"></rect>
  <rect x="446" y="272" width="114" height="24" class="d-note"></rect>
  <text x="47" y="288" text-anchor="middle" class="d-note-text" font-size="9">0</text>
  <text x="205" y="288" text-anchor="middle" class="d-note-text" font-size="10">41 bits · ms since 2024-01-01</text>
  <text x="401" y="288" text-anchor="middle" class="d-note-text" font-size="10">10 · worker</text>
  <text x="503" y="288" text-anchor="middle" class="d-note-text" font-size="10">12 · sequence</text>
  <text x="300" y="318" text-anchor="middle" class="d-label-muted" font-size="10">play each flow; fail worker 17 and replay the first</text>
  <defs>
    <marker id="arrowI4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowI4r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "w", "title": "Worker 17", "rows": [["clock (ms since epoch)", "86,788,800,000"], ["last_ts", "86,788,799,998"], ["sequence", "—"]]},
{"id": "out", "title": "Last ID issued", "rows": [["timestamp", "—"], ["worker", "—"], ["sequence", "—"], ["id", "—"]]}
],
"flows": [
{
"id": "gen",
"label": "Generate an ID",
"nodes": ["w17", "w18"],
"steps": [
{"el": "i4-app-17", "payload": "next id", "altEl": "i4-app-18", "text": "The app server asks a generator for an ID. The generator reads its clock: 86,788,800,000ms since the 2024 epoch — 1 October 2026, 12:00:00.000. That is later than last_ts, so this is a new millisecond and the sequence starts at 0.", "altText": "Worker 17 is down. The app server asks worker 18 instead. The two generators share nothing, so there is nothing to hand over."},
{"el": "i4-17-app", "payload": "364018610995269632", "ms": 0.2, "set": {"w.last_ts": "86,788,800,000", "w.sequence": "0", "out.timestamp": "12:00:00.000", "out.worker": "17", "out.sequence": "0", "out.id": "364018610995269632"}, "altEl": "i4-18-app", "altMs": 0.2, "altSet": {"out.timestamp": "12:00:00.000", "out.worker": "18", "out.sequence": "0", "out.id": "364018610995273728"}, "text": "The generator shifts the three fields into place and returns the ID. Nothing was written to disk and no other machine was involved. Almost all of the 0.2ms is the network round trip; making the ID took about a microsecond.", "altText": "Worker 18 returns an ID with 18 in the worker bits. Even if worker 17 were alive and issuing at the same millisecond, the worker bits would keep the two IDs apart."}
]
},
{
"id": "burst",
"label": "4,097 IDs in one millisecond",
"nodes": ["w17", "w18"],
"steps": [
{"el": "i4-app-17", "payload": "batch: 4,096", "text": "A bulk import asks worker 17 for 4,096 IDs, all within the same millisecond."},
{"el": "i4-17-app", "payload": "4,096 IDs", "ms": 0.2, "set": {"w.last_ts": "86,788,800,000", "w.sequence": "4,095 — full", "out.timestamp": "12:00:00.000", "out.worker": "17", "out.sequence": "4095", "out.id": "364018610995273727"}, "text": "Same timestamp, same worker, sequence 0 to 4,095. Each ID is one larger than the last. The 12-bit sequence is now used up for this millisecond."},
{"el": "i4-app-17", "payload": "next id (#4,097)", "text": "One more request arrives in the same millisecond. Sequence 4,096 does not fit in 12 bits. Wrapping round to 0 would repeat an ID already issued."},
{"el": "i4-17-app", "payload": "364018610999463936", "ms": 1, "set": {"w.clock (ms since epoch)": "86,788,800,001", "w.last_ts": "86,788,800,001", "w.sequence": "0", "out.timestamp": "12:00:00.001", "out.sequence": "0", "out.id": "364018610999463936"}, "text": "So the generator waits for its clock to reach the next millisecond, then issues sequence 0 there. The wait is at most 1ms. It only happens when one generator is asked for more than 4 million IDs a second, which is 200 times this system's normal per-generator rate."}
]
},
{
"id": "same-ms",
"label": "Two workers, same millisecond",
"nodes": ["w17", "w18"],
"steps": [
{"el": "i4-app-17", "payload": "next id", "text": "Two orders arrive in the same millisecond, 12:00:00.000. The first goes to worker 17, which has already issued 4,095 IDs this millisecond."},
{"el": "i4-17-app", "payload": "…273727", "ms": 0.2, "set": {"out.timestamp": "12:00:00.000", "out.worker": "17", "out.sequence": "4095", "out.id": "364018610995273727"}, "text": "Worker 17 issues sequence 4,095."},
{"el": "i4-app-18", "payload": "next id", "text": "The second order goes to worker 18. Its clock reads the same millisecond, and it has issued nothing yet this millisecond."},
{"el": "i4-18-app", "payload": "…273728", "ms": 0.2, "set": {"out.worker": "18", "out.sequence": "0", "out.id": "364018610995273728"}, "text": "Worker 18's ID is larger, because 18 is larger than 17 — not because its order came later. Between generators, IDs sort by time only to the millisecond, and only as far as their clocks agree. This is called k-sorted: nearly in order, with a small known window of disorder. For feeds, pagination and time-range queries that is enough. For deciding which of two writes in the same millisecond happened first, it is not."}
]
}
]
}
</script>
<div class="diagram-caption">Each generator works alone. The sequence handles bursts within one millisecond, and the worker bits keep different generators apart. Fail worker 17 and replay the first flow: worker 18 takes over with nothing to hand over.</div>
</div>

<div class="fail-hint">Click worker 17 or worker 18 to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="w17">
<strong>If worker 17 fails:</strong> callers retry on any other generator, and nothing else changes. Its in-memory state (last_ts and sequence) is lost, and that loss matters only when worker 17 comes back. A restarted generator starts from its clock. If the clock is ahead of the last ID it issued, everything is fine. If the clock was wrong — set backwards while it was down — the restarted generator would issue timestamps it already used, with the same worker ID and sequence 0: duplicates. A worker ID also must never be running on two machines at once. Both risks are what Stage 5 handles.
</div>
<div class="failure-impact is-hidden" data-component="w18">
<strong>If worker 18 fails:</strong> the same as worker 17. With N generators, losing one costs 1/N of total capacity, and each generator can carry the whole company's peak by itself, so losing even most of them is survivable. There is no rebalancing, no shared state to recover, and no data lost — the advantage of generators that share nothing.
</div>
</div>

### Service or library

The diagram draws the generators as separate services. The same code can run as a library inside each app server, which removes the network round trip: an ID costs about a microsecond. The trade-off is how many worker IDs are needed. With a service, 20 generators need 20 worker IDs. With a library, every app server process needs its own — hundreds of them, changing on every deploy and every autoscaling event. 10 bits gives 1,024, and handing them out safely as processes come and go is exactly the problem in the next stage.

<!-- stage:5:5. Worker IDs & Clocks -->

## Stage 5 — Worker IDs & Clocks

Stage 4 is unique as long as two assumptions hold. **No two running generators share a worker ID**, and **no generator's clock goes backwards** past an ID it already issued. In a real fleet both assumptions break routinely. Machines are replaced, containers restart under new names, a configuration mistake gives two hosts the same number. And clocks are adjusted by time synchronization, sometimes backwards. This stage turns both assumptions into things the system enforces.

Two additions. A small **coordinator** hands out worker IDs as time-limited **leases** ([Distributed Locking & Leader Election](#/systems/distributed-locking)). And each generator **refuses to issue** an ID whose timestamp is not later than the last one it, or the previous holder of its worker ID, issued.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 620 320" width="620" height="320" role="img" aria-label="A generator holding a worker-ID lease from a coordinator and synchronizing its clock with a time source, serving an app server">
  <rect x="20" y="130" width="122" height="40" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="81" y="154" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
  <g data-fail-toggle="gen5">
    <rect x="240" y="122" width="180" height="56" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="330" y="144" text-anchor="middle" class="d-actor-label" font-size="12">Generator</text>
    <text x="330" y="162" text-anchor="middle" class="d-label-muted" font-size="9">holds lease on worker 17</text>
  </g>
  <g data-fail-toggle="coord5">
    <rect x="460" y="30" width="146" height="52" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="533" y="52" text-anchor="middle" class="d-actor-label" font-size="12">Coordinator</text>
    <text x="533" y="68" text-anchor="middle" class="d-label-muted" font-size="9">worker-ID leases · 3 replicas</text>
  </g>
  <g data-fail-toggle="ntp5">
    <rect x="460" y="222" width="146" height="52" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="533" y="244" text-anchor="middle" class="d-actor-label" font-size="12">Time Source</text>
    <text x="533" y="260" text-anchor="middle" class="d-label-muted" font-size="9">clock synchronization</text>
  </g>
  <line id="i5-app-gen" x1="144" y1="140" x2="236" y2="140" class="d-msg d-request" data-depends-on="gen5" marker-end="url(#arrowI5)"></line>
  <line id="i5-gen-app" x1="236" y1="160" x2="144" y2="160" class="d-msg d-response" data-depends-on="gen5" marker-end="url(#arrowI5r)"></line>
  <line id="i5-gen-coord" x1="400" y1="120" x2="456" y2="62" class="d-msg d-request" data-depends-on="gen5 coord5" marker-end="url(#arrowI5)"></line>
  <line id="i5-coord-gen" x1="456" y1="78" x2="416" y2="120" class="d-msg d-response" data-depends-on="gen5 coord5" marker-end="url(#arrowI5r)"></line>
  <line id="i5-ntp-gen" x1="456" y1="240" x2="400" y2="182" class="d-msg d-response" data-depends-on="ntp5 gen5" marker-end="url(#arrowI5r)"></line>
  <text x="310" y="308" text-anchor="middle" class="d-label-muted" font-size="10">play the startup, then the clock step; fail the coordinator and replay the renewal</text>
  <defs>
    <marker id="arrowI5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowI5r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "lease", "title": "Coordinator: worker 17", "rows": [["holder", "(free — old holder's lease expired)"], ["lease expires", "—"], ["last_ts reported", "86,788,800,000"]]},
{"id": "gen", "title": "Generator", "rows": [["clock", "86,788,799,990"], ["last_ts", "—"], ["issuing IDs?", "no — no worker ID yet"]]}
],
"flows": [
{
"id": "start",
"label": "A generator starts and leases a worker ID",
"nodes": ["gen5", "coord5", "ntp5"],
"steps": [
{"el": "i5-gen-coord", "payload": "claim a free worker ID", "text": "A new generator process starts on a replacement machine. Before it can issue anything, it needs a worker ID that no running generator holds. It asks the coordinator, which stores leases in a small replicated store and agrees on every change by majority."},
{"el": "i5-coord-gen", "payload": "worker 17 · 30s · last_ts", "ms": 3, "set": {"lease.holder": "id-node-c", "lease.lease expires": "in 30s", "gen.last_ts": "86,788,800,000"}, "text": "Worker 17 is free: its previous holder crashed, and its lease ran out. The coordinator grants it for 30 seconds and passes along the last timestamp the previous holder reported: 86,788,800,000. That holder may have issued IDs up to that millisecond."},
{"el": "i5-ntp-gen", "payload": "synced · wait 10ms", "ms": 10, "set": {"gen.clock": "86,788,800,001", "gen.issuing IDs?": "yes"}, "text": "The new machine's clock reads 10ms earlier than that timestamp. Issuing now could repeat IDs that worker 17 already issued on the old machine. So the generator waits until its clock passes last_ts — here, 10ms — and only then starts serving. The previous holder's IDs and this one's can't overlap."},
{"el": "i5-gen-coord", "payload": "renew · last_ts", "set": {"lease.lease expires": "in 30s"}, "text": "From now on, every 10 seconds the generator renews its lease and reports its latest last_ts. A renewal is cheap and is never on the path of an ID request."}
]
},
{
"id": "step",
"label": "The clock steps backwards",
"nodes": ["gen5", "coord5", "ntp5"],
"steps": [
{"el": "i5-ntp-gen", "payload": "correct: −8ms", "set": {"gen.clock": "86,788,799,992", "gen.last_ts": "86,788,800,000"}, "text": "Clock synchronization decides this machine's clock is 8ms fast and corrects it by setting it back. The generator's last ID used millisecond 86,788,800,000. Its clock now reads 86,788,799,992."},
{"el": "i5-app-gen", "payload": "next id", "text": "An ID request arrives. If the generator trusted its clock, it would build an ID from millisecond …992, which it already used 8ms ago, with sequence numbers it already issued. That is a duplicate."},
{"el": "i5-gen-app", "payload": "364018610995269633", "ms": 8, "set": {"gen.clock": "86,788,800,000"}, "text": "Instead, it compares its clock with last_ts and sees time has gone backwards. A small regression like 8ms is waited out: the request is held until the clock catches up to last_ts, then served. A large one — say over 100ms — is not waited out: the generator returns 503, marks itself unhealthy, and callers go to another generator. Either way, no timestamp is ever reused."}
]
},
{
"id": "renew",
"label": "Lease renewal",
"nodes": ["gen5", "coord5", "ntp5"],
"steps": [
{"el": "i5-gen-coord", "payload": "renew 17 · last_ts", "set": {"lease.last_ts reported": "86,788,800,000"}, "text": "Ten seconds have passed. The generator renews its lease on worker 17 and reports the highest timestamp it has used."},
{"el": "i5-coord-gen", "payload": "OK · +30s", "ms": 3, "set": {"lease.lease expires": "in 30s"}, "text": "The coordinator extends the lease. As long as renewals succeed, the generator keeps worker 17 and keeps issuing IDs."}
]
}
]
}
</script>
<div class="diagram-caption">The coordinator decides who owns each worker ID, and passes on the last timestamp used. The generator never lets its own timestamps go backwards. Fail the coordinator and replay the renewal to see where the design stops issuing rather than risk a duplicate.</div>
</div>

<div class="fail-hint">Click the generator, the coordinator, or the time source to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="gen5">
<strong>If the generator fails:</strong> callers move to another generator immediately. Worker 17's lease stops being renewed and expires 30 seconds later. Only then can the coordinator give worker 17 to anyone else. That wait is deliberate: a generator that only <em>looked</em> dead — paused for garbage collection, or cut off by a network partition — must not still be issuing IDs as worker 17 while a new holder does the same.
</div>
<div class="failure-impact is-hidden" data-component="coord5">
<strong>If the coordinator fails:</strong> no ID request fails, because the coordinator is never on the request path. Running generators keep issuing. What stops is change: new generators can't get a worker ID, and existing ones can't renew. A generator that can't renew must <strong>stop issuing before its lease expires</strong> — at 20 of its 30 seconds, leaving a margin for clock drift between it and the coordinator — because after expiry the coordinator could hand worker 17 to someone else. So a coordinator outage longer than about 20 seconds gradually stops generators. That is why the coordinator runs as three or five replicas agreeing by majority, and why generators renew long before expiry ([Consensus](#/systems/consensus)).
</div>
<div class="failure-impact is-hidden" data-component="ntp5">
<strong>If the time source fails:</strong> uniqueness is unaffected. Uniqueness depends only on each generator never reusing its own timestamps, which it enforces itself, whatever the clock says. What degrades is ordering between generators. A typical server clock drifts by up to a second or two a day without correction, so after a day, two generators' IDs may disagree about which came first by that much. Alert on clock offset; it is an ordering problem, not a correctness emergency.
</div>
</div>

This is the full design: 64-bit IDs made of a timestamp, a worker ID and a sequence; generators that share nothing on the request path; a coordinator that hands out worker IDs as leases and remembers the last timestamp each one used; and generators that would rather wait or refuse than let time run backwards. Each piece protects the same thing: the guarantee that no ID is ever issued twice.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### Choosing the bit layout

41/10/12 is one point in a trade-off, not a law. The three fields compete for 63 bits:

| Change | Gains | Costs |
|---|---|---|
| 10ms ticks instead of 1ms (39 bits of time) | ~174 years of lifespan in fewer bits | Ordering only to 10ms; sequence must cover 10ms of IDs |
| 14-bit worker ID, 8-bit sequence | 16,384 generators — every process can have one | 256 IDs per ms per generator, ~256K/sec |
| Datacenter bits inside the worker ID (5 + 5) | Each datacenter assigns its own IDs with no cross-region coordination | 32 datacenters × 32 workers, a tighter limit on each |
| 42 bits of time | ~139 years | One fewer bit for workers or sequence |

Choose by asking which limit is hardest to change later. Lifespan can't be extended without a format change in every stored ID. Worker count is the next most painful. Sequence width only limits one generator's burst rate, and more generators fix that. That ordering is why most layouts give time the most bits and sequence the fewest.

The custom epoch matters too. Counting from 1970 would waste 54 of the 69 years before the system existed. Counting from the system's launch gives it the whole range.

### Clocks: wall time and monotonic time

A computer has two kinds of clock. **Wall-clock time** is the date and time; synchronization adjusts it, and it can jump backwards. **Monotonic time** counts elapsed time since boot; it never goes backwards, but it means nothing across machines or restarts.

Synchronization usually corrects a clock by **slewing** — running it slightly faster or slower until the error is gone — which never goes backwards. It **steps** the clock (sets it directly, possibly backwards) when the error is large, typically at boot or after a long disconnection. Leap seconds were historically applied as a step too; most large fleets now **smear** them over many hours instead, so the clock never repeats a second.

A robust generator reads the wall clock once at startup, checks it against the lease's last_ts, then measures time with the monotonic clock added to that starting point. A wall-clock step while it runs can then never move its timestamps backwards. It drifts slowly from true time instead, and periodic checks against the wall clock limit how far.

### Waiting, refusing, or borrowing from the future

When the clock goes backwards, there are three choices:

- **Wait** until the clock passes last_ts. Simple and safe; costs latency equal to the regression. The right answer for regressions of a few milliseconds.
- **Refuse** with an error and let callers go elsewhere. Right for large regressions, where waiting would stall requests for seconds.
- **Keep issuing from last_ts**, ignoring the clock and incrementing the sequence, rolling into last_ts + 1 when it fills. This never stalls, but the generator's timestamps now run ahead of real time. If it keeps going faster than real time, they drift further ahead, and the timestamp inside the ID becomes misleading. Some designs allow this for a bounded amount, then fall back to refusing.

All three are safe. The one unsafe option — trusting the clock — is the one a naive implementation takes.

### Range allocation: counters without the round trip

There is a different family of designs that keeps Stage 1's counter but takes it off the request path. Each generator fetches a **block** of numbers — say 1,000 at a time — with one database update (`next_id = next_id + 1000`), then hands them out from memory. The database sees one request per thousand IDs, so 400,000 IDs/sec is 400 updates/sec. Fetching the next block in the background when the current one is 10% used left means no request ever waits for the database.

This gives compact, purely numeric IDs with no clock dependence at all. It loses ordering between generators: generator A may be handing out numbers from block 5,000 while B is still in block 3,000. A generator that crashes throws away the rest of its block, leaving a gap, which is harmless. The [URL Shortener](#/systems-case-studies/url-shortener) uses this approach, because it needs short codes, not time order.

### 128-bit time-ordered IDs

If 128 bits is acceptable, there is a standard for exactly this design: UUID version 7. It puts a 48-bit millisecond timestamp in the top bits and fills the remaining 74 non-format bits with randomness (some implementations use part of them as a counter). Version 7 IDs sort by time like Stage 4's, fit anywhere a UUID column already exists, and need **no worker IDs at all**: with 74 random bits, two generators picking the same value in the same millisecond is vanishingly unlikely.

That last point is the real trade-off. 64 bits is too small for randomness to guarantee uniqueness — there aren't enough bits left after the timestamp — so a 64-bit design must coordinate worker IDs. 128 bits is big enough that randomness replaces coordination. Choose 64 bits when the ID is stored in many large indexes, or must be a plain integer. Choose a 128-bit time-ordered UUID when it is enough to remove the coordinator and its leases from the system entirely.

### Turning IDs into time ranges

Because an ID contains its timestamp, the lowest possible ID for a moment is `(t - epoch) << 22`. To find everything created on 1 October, query `id >= low(Oct 1) AND id < low(Oct 2)`, using the primary key index alone. No `created_at` index is needed. Partitioning a table by month becomes partitioning by ID range. The same arithmetic makes pagination cursors trivial: "everything older than this ID" is "everything created before this moment", give or take the k-sorted window.

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### Ordering is approximate

IDs from one generator are strictly increasing. IDs from different generators are ordered only to within the millisecond, plus however much their clocks disagree — usually a few milliseconds, possibly seconds if synchronization has broken. That is fine for sorting a feed or paginating a list. It is not fine for deciding which of two conflicting writes won. If a system needs to know that, it needs a single sequencer per conflicting key, or a logical clock, not timestamps from different machines ([Consistency Models & CAP/PACELC](#/systems/consistency-cap)).

### Time-ordered keys create a hot spot

Every new ID is larger than every older one, so every insert goes to the right-hand end of the index. In a single-node B-tree that is good: one hot page, always in memory. In a database that is **range-partitioned** by primary key, it is a problem: all new rows land in the last partition, and one machine takes all the writes while the rest take none ([Partitioning & Sharding](#/systems/partitioning-sharding)). Partition by a hash of the ID instead, or by another key such as user ID, and keep the time ordering for use within each partition.

### The clock is a dependency

Stage 3 had no dependencies at all. Stage 4 depends on a reasonably accurate clock, and Stage 5 adds a coordinator. Both are kept off the request path, and both fail safe — wait, refuse, or stop — rather than produce a duplicate. But a fleet-wide clock problem, such as a bad time source stepping every machine back by a minute, would make every generator refuse at once. Synchronization from several independent sources, with a limit on how far a single correction may move the clock, limits that risk.

### Worker IDs are a finite pool

1,024 is plenty for a generator service and tight for a library embedded in every process. Leases help, because worker IDs are recycled after their holders die. But a deploy that starts all-new instances before stopping old ones briefly needs twice as many, and a crash loop can hold IDs for a lease period each. Watch pool usage (see Monitoring), and if a design trends towards the limit, move to a service, widen the worker field, or move to 128-bit IDs.

### The format is forever

An ID stored in a database, a log, a URL, or a partner's system can't be changed later. The epoch, the bit layout, and the decision to use 64 bits are effectively permanent. The 69-year lifespan sounds long, but the cost of getting the layout wrong appears much sooner: running out of worker bits, or discovering that a 10-bit worker field can't encode the datacenter the business just opened. Decide the layout as if it can't be revisited, because in practice it can't be.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

An ID generator has a small attack surface of its own. Its bigger security effect is on every system that exposes its IDs ([Security & Authentication](#/systems/security-authentication)).

### IDs reveal information

A time-ordered ID contains its creation time, to the millisecond, and the worker that made it. Anyone holding two order IDs a day apart can decode both and, if the sequence and worker spread are known, estimate how many orders were placed in between — a competitor's business volume, from two receipts. If that matters, don't show internal IDs to the public. Show a separate random public ID, or encrypt the internal ID with a block cipher under a secret key before showing it, which produces an unpredictable value that can be decrypted back.

### IDs are not secrets

Time-ordered IDs are easy to guess. Given one, the next ones are nearby. Any API that returns a resource to whoever presents its ID — `GET /invoices/364018610995269632` — with no ownership check lets an attacker enumerate other people's invoices. This kind of flaw is called an insecure direct object reference. An ID identifies a resource. Every request must still check that the caller may access it. Random 128-bit IDs make guessing impractical, but they are a second line of defence, never the first.

### Protecting the worker ID

A rogue or misconfigured process claiming a worker ID that's already in use produces duplicates silently. The coordinator must authenticate generators, grant worker IDs only through leases, and reject renewals from anyone other than the current holder. Never let a generator take its worker ID from a configuration file or environment variable without also holding the lease. A static setting copied to two hosts is the most common way duplicates happen in practice.

### Attacks on time

If an attacker can move a generator's clock, they can force it into the wait-or-refuse path on every request: a denial of service. Moving it forward is quieter: IDs get future timestamps, and after the clock is corrected the generator must wait out the whole jump before issuing again. Use authenticated time synchronization, take time from several sources, and refuse corrections larger than a set limit without a human in the loop.

### Exhausting the generator

Batch requests are the cheapest way to overload a generator: a request for a million IDs takes 250ms of one generator's entire sequence space. Cap the batch size, apply per-caller quotas ([Rate Limiting](#/systems/rate-limiting)), and only accept requests from authenticated internal services.

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **IDs issued per second, per generator.** Uneven numbers suggest a caller library not spreading load.
- **Sequence exhaustion waits per second** — how often a generator filled a millisecond and waited for the next. Near zero normally; rising means one generator is carrying too much.
- **Clock offset** of every generator against the time source, and **clock regressions** detected (count and size).
- **Requests refused** with 503, by reason: clock regression, lease lost, not yet started.
- **Lease renewal latency and failures**, and the time remaining on each generator's lease.
- **Worker ID pool usage**: leases held out of 1,024.
- **Duplicate key errors in downstream databases.** This should always be zero. It is the only direct signal that uniqueness failed.

### What to alert on

- **Any duplicate key error on an ID-generated primary key.** Page immediately. Something has broken uniqueness, and every hour adds more silently corrupted data.
- Clock offset above about 50ms on any generator, or any regression above the wait threshold.
- Lease renewal failures on more than one generator — the coordinator may be unhealthy, and generators will start stopping in about 20 seconds.
- Worker ID pool above 80% used.
- Refusal rate above a small baseline.

### A generator's clock jumped backwards — what happens?

What the Stage 5 clock flow simulates. If the jump was a few milliseconds, requests were briefly delayed, and nothing else happened. If it was large, that generator returned 503 and callers moved to other generators.

The runbook: confirm the generator is refusing rather than issuing (check refusals and its last_ts against its clock). Find why the clock stepped — a time source sending bad time is a fleet-wide risk, not a single-machine one. Let the generator recover by itself once its clock passes last_ts. Or, if the jump was huge, take it out of rotation, fix the clock, and restart it. On restart it claims a lease, receives last_ts from the coordinator, and waits until its clock passes it. Never "fix" it by manually resetting last_ts to the current clock. That is the one action that turns a clock problem into duplicate IDs.

### The coordinator is down — what happens?

Nothing visible for about 20 seconds. Then generators whose leases they couldn't renew start refusing, one by one, in the order their leases were last renewed. Restoring a majority of coordinator replicas is the whole fix; generators renew on their next attempt and resume. If the outage will be long, the safe choice is to accept the reduced capacity — not to give generators their worker IDs by configuration to keep them running.

### Deploys and scaling

Generators can be added at any time: each claims a free worker ID and starts. Removing one is safest if it releases its lease explicitly on shutdown, after it stops issuing, so the worker ID is free immediately rather than after expiry. Roll deploys gradually enough that old and new instances together stay well under the worker ID limit.
