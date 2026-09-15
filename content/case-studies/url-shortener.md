# URL Shortener

A URL shortener does two things: given a long URL, generate a short code and remember the mapping (a **write**); given a short code, look up the original URL and redirect to it (a **read**). The tabs below walk through the full design process in the order a real design doc does — requirements first, then scale, API, and data model, then the architecture that satisfies them, then the parts that only come up once the diagram is drawn: deep dives, trade-offs, security, and operations.

<!-- tab:requirements:Requirements -->

## Requirements

Before drawing a single box, pin down what the system has to do, how well it has to do it, and — just as important — what it explicitly won't do. Every later decision in this case study traces back to something on this list.

### Functional requirements

- **Shorten:** given a long URL, return a short one that redirects to it.
- **Redirect:** given a short URL, send the client to the original long URL.
- **Custom aliases:** a user can optionally request a specific short code (`short.ly/my-brand`) instead of a generated one.
- **Expiration:** a link can optionally be created with an expiry date, after which it stops resolving.
- **Basic analytics:** track a click count per short link.

### Non-functional requirements

- **Availability over strict consistency.** A redirect that's a second stale (points at a destination that was just updated) is a shrug; a redirect that fails because the system is unavailable breaks every place that link was ever shared. This system favors staying up over being perfectly consistent.
- **Low latency.** A redirect sits on the critical path of someone else's click — it should resolve in well under 100ms, ideally closer to 10-20ms.
- **High read:write ratio.** People click links far more often than they create them — design for reads to dominate writes by one or two orders of magnitude.
- **Uniqueness.** No two long URLs should ever collide on the same short code.
- **Horizontal scalability.** Both traffic and stored link count should grow by adding machines, not by buying a bigger one.

### In scope

Shortening, redirecting, custom aliases, expiration, and click counts.

### Out of scope

User accounts and authentication (assume an opaque `user_id` is available to attach to a link if one exists), editing a link's destination after creation, and a full malware/phishing-detection pipeline (a lightweight blocklist check is covered in Security & Abuse Prevention, but real-time threat detection is its own system).

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

Every number below is a starting assumption, not a fact — the value of this exercise is the method: pick a plausible input, and see what it implies for throughput, storage, and cache size before writing a line of code. The headline numbers are below; the derivation for each follows underneath.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Peak writes</div>
<div class="stat-tile-value">~200<span class="stat-tile-unit">/sec</span></div>
<div class="stat-tile-sub">~40/sec average, 5x at peak</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Peak reads</div>
<div class="stat-tile-value">~20K<span class="stat-tile-unit">/sec</span></div>
<div class="stat-tile-sub">~3,900/sec average, 5x at peak</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Read : write ratio</div>
<div class="stat-tile-value">100<span class="stat-tile-unit"> : 1</span></div>
<div class="stat-tile-sub">the number that shapes every stage of the architecture</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Storage, 5 years</div>
<div class="stat-tile-value">~10<span class="stat-tile-unit">TB</span></div>
<div class="stat-tile-sub">6B records, replicated 3x</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Code space used</div>
<div class="stat-tile-value">&lt;0.2<span class="stat-tile-unit">%</span></div>
<div class="stat-tile-sub">of 3.5 trillion possible 7-char codes</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Cache working set</div>
<div class="stat-tile-value">few<span class="stat-tile-unit"> GB</span></div>
<div class="stat-tile-sub">today's hot links, not all 6B ever created</div>
</div>
</div>

### Assumptions

- 100 million new short links created per month.
- Reads outnumber writes 100:1 → 10 billion redirects per month.
- Average long URL: ~100 bytes. Metadata (timestamps, owner, click count): ~50 bytes.
- Links are kept for 5 years.

### Write throughput

100M ÷ (30 days × 86,400 sec) ≈ **40 writes/sec average**. Real traffic isn't flat — assuming a 3-5x peak-to-average ratio, design for roughly **150-200 writes/sec at peak**.

### Read throughput

10B ÷ (30 days × 86,400 sec) ≈ **3,900 reads/sec average**, and **15,000-20,000 reads/sec at peak** with the same multiplier. This gap — reads outrunning writes by two orders of magnitude — is the single number that most shapes the architecture: it's why a cache shows up before anything else in the Architecture tab.

### Storage

100M new links/month × 60 months (5 years) = 6 billion records. At ~500 bytes/record (code + URL + metadata + index overhead): 6B × 500B ≈ **3TB of raw data**. With a replication factor of 3 for durability, budget closer to **10TB** across the fleet — comfortably within reach of ordinary disks, which is why this system's bottleneck is never raw storage capacity.

### Short-code space

Base62 (`a-z`, `A-Z`, `0-9`) gives 62 possible characters per position. A 7-character code has 62⁷ ≈ **3.5 trillion** possible values. Even 6 billion codes used over 5 years consumes under 0.2% of that space — code length isn't worth optimizing early.

### Cache sizing

Traffic to short links is heavily skewed — a small fraction of links, the ones actively being shared right now, account for most clicks. The cache doesn't need to hold all 6 billion links ever created, only today's *hot set*. Even a generous estimate of a few million active keys, at a few hundred bytes each, fits in a few gigabytes — small enough to run on a handful of cache nodes.

<!-- tab:api-design:API Design -->

## API Design

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/urls` | Create a short link |
| GET | `/{short_code}` | Redirect to the long URL |
| GET | `/api/v1/urls/{short_code}` | Get metadata + click count for a link |
| DELETE | `/api/v1/urls/{short_code}` | Delete a link (owner only) |

### Create a short link

```
POST /api/v1/urls
{
  "long_url": "https://example.com/a/very/long/path?with=query&params=here",
  "custom_alias": "my-brand",            // optional
  "expires_at": "2027-01-01T00:00:00Z"   // optional
}
```

`201 Created`
```
{
  "short_code": "my-brand",
  "short_url": "https://short.ly/my-brand",
  "long_url": "https://example.com/a/very/long/path?with=query&params=here",
  "expires_at": "2027-01-01T00:00:00Z"
}
```

Errors: `400` malformed or missing `long_url`, `409` requested `custom_alias` already taken.

### Redirect

```
GET /{short_code}
```

`302 Found`, `Location: <long_url>` — or `404 Not Found` if the code doesn't exist, `410 Gone` if it's expired.

**Why 302 and not 301?** A 301 (permanent redirect) gets cached by the browser — the second time someone clicks the same link, their browser redirects them without ever hitting the server again. That's less load, but the server also stops seeing those clicks (no analytics) and can never change where the link points, even to fix a mistake. A 302 (temporary redirect) is never cached, so every click hits the server — more load, but full visibility and the ability to update or expire a link after the fact. Most production shorteners choose 302 for exactly that trade.

### Get link metadata

```
GET /api/v1/urls/{short_code}
```
```
{
  "short_code": "my-brand",
  "long_url": "https://example.com/...",
  "created_at": "2026-01-01T00:00:00Z",
  "expires_at": "2027-01-01T00:00:00Z",
  "click_count": 4213
}
```

### Delete a link

```
DELETE /api/v1/urls/{short_code}
```

`204 No Content` on success, `403 Forbidden` if the caller doesn't own the link, `404 Not Found` if it doesn't exist.

All write endpoints are rate-limited per caller — see Security & Abuse Prevention.

<!-- tab:data-model:Data Model -->

## Data Model

### Core table

```
urls
  short_code   VARCHAR(7)   PRIMARY KEY
  long_url     TEXT         NOT NULL
  user_id      BIGINT       NULL        -- null for anonymous links
  created_at   TIMESTAMP    NOT NULL
  expires_at   TIMESTAMP    NULL
```

Every access to this table — the redirect read, the create write, the delete — is a lookup by `short_code`. There's no join, no range scan, no secondary index needed for the core path. That fact is worth noticing: it means a relational database is not a requirement here, just a familiar default. A key-value or wide-column store (see [Databases II — NoSQL Models](#/systems/databases-nosql)) fits the access pattern at least as well, and scales writes and reads by key more naturally at very large volume. This case study's Architecture tab builds on a relational database because the replication and sharding mechanics transfer directly to either choice — but if the requirements stayed exactly this simple, a KV store would be a defensible, maybe even preferable, starting point.

### Which database, in practice

| Choice | Examples | Why it fits |
|---|---|---|
| Relational | PostgreSQL, MySQL | Single-row lookups by primary key, mature replication and sharding tooling — the safe default, especially if the team already operates one |
| Key-value / wide-column | DynamoDB, Cassandra | Access is 100% by partition key; these scale writes and reads horizontally with far less manual sharding work than a relational cluster |
| In-memory KV as system of record | Redis, with persistence enabled | Worth considering when redirect latency has to be sub-millisecond and the link set is small enough to fit in memory — trades away some durability guarantees for speed |

DynamoDB in particular shows up often in real-world shorteners for exactly the reason above: a partition-key-only access pattern is precisely what it's built for, and it removes the need to run and reshard a database cluster by hand.

### Click counts live separately

```
click_events
  id           BIGINT       PRIMARY KEY
  short_code   VARCHAR(7)   NOT NULL
  clicked_at   TIMESTAMP    NOT NULL
  referrer     TEXT         NULL
```

Bolting a `click_count` column onto the `urls` row and incrementing it on every redirect would mean every read also takes a write lock on the exact row under the heaviest read load in the system — the worst possible place to add write contention. Appending to a separate, unindexed `click_events` table (or, at higher scale, a message queue — see [Message Queues & Event-Driven Architecture](#/systems/message-queues) — with counts aggregated asynchronously) keeps the hot read path a pure read.

### Indexing

`short_code` is the primary key and the only index the core path needs. `long_url` is intentionally not indexed or deduplicated — two different users shortening the same long URL is expected to produce two different short codes, since they may set different expiration or ownership on each.

<!-- tab:architecture:Architecture -->

This case study builds the system up in four stages, from the smallest version that works to one that survives real failures at real scale. Use the sub-tabs below to move between stages. In each stage's diagram, the components with a pointer cursor are clickable — click one to see exactly what breaks (and what doesn't) if it fails.

<!-- stage:1:1. Minimal System -->

## Stage 1 — The Minimal System

One app server, one database. Every write (generate a code, store the mapping) and every read (look up a code, redirect) goes through the same two hops.

<div class="diagram-wrap">
<svg viewBox="0 0 600 200" width="600" height="200" role="img" aria-label="A client talking to a single app server, which talks to a single database">
  <rect x="20" y="82" width="100" height="36" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="70" y="104" text-anchor="middle" class="d-actor-label">Client</text>
  <g data-fail-toggle="app1">
    <rect x="250" y="82" width="120" height="36" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="310" y="104" text-anchor="middle" class="d-actor-label">App Server</text>
  </g>
  <g data-fail-toggle="db1">
    <rect x="480" y="82" width="100" height="36" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="530" y="104" text-anchor="middle" class="d-actor-label">Database</text>
  </g>
  <line x1="120" y1="93" x2="246" y2="93" class="d-msg d-request" data-depends-on="app1" marker-end="url(#arrowS1)"></line>
  <text x="185" y="86" text-anchor="middle" class="d-label-muted" font-size="11">shorten / redirect</text>
  <line x1="246" y1="110" x2="120" y2="110" class="d-msg d-response" data-depends-on="app1" marker-end="url(#arrowS1r)"></line>
  <line x1="370" y1="93" x2="476" y2="93" class="d-msg d-request" data-depends-on="app1 db1" marker-end="url(#arrowS1)"></line>
  <text x="423" y="86" text-anchor="middle" class="d-label-muted" font-size="11">read / write mapping</text>
  <line x1="476" y1="110" x2="370" y2="110" class="d-msg d-response" data-depends-on="app1 db1" marker-end="url(#arrowS1r)"></line>
  <defs>
    <marker id="arrowS1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowS1r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">Nothing sits between the client and the app server, or between the app server and the database. Every request pays the full cost of both hops.</div>
</div>

<div class="fail-hint">Click the app server or the database to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="app1">
<strong>If the app server fails:</strong> there's only one instance, so the whole service goes down — no redirects, no new short links — until it's restarted. Nothing here is redundant yet.
</div>
<div class="failure-impact is-hidden" data-component="db1">
<strong>If the database fails:</strong> the app server has nowhere to read or write mappings, so both reads and writes fail. The database is the single source of truth, and right now it's also a single point of failure.
</div>
</div>

This works, correctly, for as long as one machine can hold the data and keep up with the traffic. It stays this simple until it can't.

<!-- stage:2:2. Add a Cache -->

## Stage 2 — Add a Cache

Reads (someone clicking a short link) vastly outnumber writes (someone creating one) in almost every real deployment, so the read path is the first thing worth speeding up. A cache in front of the database (see [Caching](#/systems/caching)) lets most reads skip the database entirely — this is the cache-aside pattern: check the cache first, and only fall through to the database on a miss.

<div class="diagram-wrap">
<svg viewBox="0 0 600 240" width="600" height="240" role="img" aria-label="An app server checking a cache first, falling through to the database on a miss, with writes going straight to the database">
  <rect x="10" y="100" width="90" height="36" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="55" y="122" text-anchor="middle" class="d-actor-label">Client</text>
  <g data-fail-toggle="app2">
    <rect x="170" y="100" width="110" height="36" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="225" y="122" text-anchor="middle" class="d-actor-label">App Server</text>
  </g>
  <g data-fail-toggle="cache2">
    <rect x="380" y="40" width="100" height="36" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="430" y="62" text-anchor="middle" class="d-actor-label">Cache</text>
  </g>
  <g data-fail-toggle="db2">
    <rect x="380" y="164" width="100" height="36" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="430" y="186" text-anchor="middle" class="d-actor-label">Database</text>
  </g>
  <line x1="100" y1="111" x2="166" y2="111" class="d-msg d-request" data-depends-on="app2" marker-end="url(#arrowS2)"></line>
  <line x1="166" y1="126" x2="100" y2="126" class="d-msg d-response" data-depends-on="app2" marker-end="url(#arrowS2r)"></line>
  <line x1="280" y1="103" x2="376" y2="66" class="d-msg d-request" data-depends-on="app2 cache2" marker-end="url(#arrowS2)"></line>
  <text x="345" y="75" text-anchor="middle" class="d-label-muted" font-size="10">1. check cache</text>
  <line x1="376" y1="80" x2="280" y2="117" class="d-msg d-response" data-depends-on="cache2" marker-end="url(#arrowS2r)"></line>
  <text x="345" y="105" text-anchor="middle" class="d-label-muted" font-size="10">hit → return URL</text>
  <line x1="430" y1="76" x2="430" y2="160" class="d-lifeline" data-depends-on="db2"></line>
  <text x="500" y="120" text-anchor="middle" class="d-label-muted" font-size="10">on miss: read DB,</text>
  <text x="500" y="133" text-anchor="middle" class="d-label-muted" font-size="10">then populate cache</text>
  <line x1="280" y1="128" x2="376" y2="172" class="d-msg d-request" data-depends-on="app2 db2" marker-end="url(#arrowS2)"></line>
  <text x="330" y="160" text-anchor="middle" class="d-label-muted" font-size="10">writes go straight to DB</text>
  <defs>
    <marker id="arrowS2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowS2r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">Reads check the cache first and only touch the database on a miss. Writes always go straight to the database — the cache is never the only copy of anything.</div>
</div>

<div class="fail-hint">Click the app server, cache, or database to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="app2">
<strong>If the app server fails:</strong> same as Stage 1 — there's still only one instance, so the whole service is down. The cache reduces load on a healthy app server; it doesn't provide redundancy for the app server itself.
</div>
<div class="failure-impact is-hidden" data-component="cache2">
<strong>If the cache fails:</strong> every read falls through to the database, exactly like Stage 1. Nothing is incorrect — the cache never held the only copy of anything — but the database now takes 100% of read traffic directly, and reads get slower.
</div>
<div class="failure-impact is-hidden" data-component="db2">
<strong>If the database fails:</strong> reads for anything not currently cached start failing, and every write fails outright, since the cache is only ever populated from data the database already committed. The cache buys headroom, not independence from the database.
</div>
</div>

Two single points of failure are still left: the one app server, and the one database.

<!-- stage:3:3. Scale Out -->

## Stage 3 — Scale Out

A load balancer in front of several stateless app servers ([Load Balancing](#/systems/load-balancing), [Scaling Fundamentals](#/systems/scaling-fundamentals)) fixes the app-server half — the app server holds no per-client state, so any instance can handle any request, and the load balancer stops routing to one that stops responding. Read replicas ([Replication](#/systems/replication)) fix the read half of the database problem: the cache absorbs the hottest keys, and replicas absorb the reads that still miss.

<div class="diagram-wrap">
<svg viewBox="0 0 660 260" width="660" height="260" role="img" aria-label="A load balancer fanning out to three app servers, which share a cache and a replicated database">
  <rect x="10" y="112" width="80" height="34" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="50" y="134" text-anchor="middle" class="d-actor-label" font-size="12">Client</text>
  <rect x="130" y="112" width="64" height="34" rx="6" class="d-actor-box" data-role="routing"></rect>
  <text x="162" y="134" text-anchor="middle" class="d-actor-label" font-size="12">LB</text>
  <rect x="240" y="40" width="110" height="30" rx="5" class="d-actor-box" data-role="compute"></rect>
  <text x="295" y="60" text-anchor="middle" class="d-actor-label" font-size="11">App Server A</text>
  <g data-fail-toggle="app3">
    <rect x="240" y="90" width="110" height="30" rx="5" class="d-actor-box" data-role="compute"></rect>
    <text x="295" y="110" text-anchor="middle" class="d-actor-label" font-size="11">App Server B</text>
  </g>
  <rect x="240" y="140" width="110" height="30" rx="5" class="d-actor-box" data-role="compute"></rect>
  <text x="295" y="160" text-anchor="middle" class="d-actor-label" font-size="11">App Server C</text>
  <rect x="430" y="60" width="90" height="32" rx="6" class="d-actor-box" data-role="cache"></rect>
  <text x="475" y="80" text-anchor="middle" class="d-actor-label" font-size="11">Cache</text>
  <g data-fail-toggle="primary3">
    <rect x="430" y="150" width="100" height="32" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="480" y="170" text-anchor="middle" class="d-actor-label" font-size="11">Primary DB</text>
  </g>
  <g data-fail-toggle="replica3">
    <rect x="430" y="210" width="100" height="32" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="480" y="230" text-anchor="middle" class="d-actor-label" font-size="11">Replica DB</text>
  </g>
  <line x1="90" y1="129" x2="126" y2="129" class="d-msg d-request" marker-end="url(#arrowS3)"></line>
  <line x1="194" y1="138" x2="236" y2="58" class="d-msg d-request" marker-end="url(#arrowS3)"></line>
  <line x1="194" y1="142" x2="236" y2="108" class="d-msg d-request" data-depends-on="app3" marker-end="url(#arrowS3)"></line>
  <line x1="194" y1="146" x2="236" y2="158" class="d-msg d-request" marker-end="url(#arrowS3)"></line>
  <line x1="350" y1="100" x2="426" y2="80" class="d-msg d-request" marker-end="url(#arrowS3)"></line>
  <text x="390" y="80" text-anchor="middle" class="d-label-muted" font-size="10">check cache</text>
  <line x1="475" y1="94" x2="475" y2="146" class="d-lifeline" data-depends-on="primary3 replica3"></line>
  <text x="558" y="118" text-anchor="middle" class="d-label-muted" font-size="10">reads,</text>
  <text x="558" y="131" text-anchor="middle" class="d-label-muted" font-size="10">on miss</text>
  <line x1="350" y1="110" x2="426" y2="163" class="d-msg d-request" data-depends-on="app3 primary3" marker-end="url(#arrowS3)"></line>
  <text x="390" y="145" text-anchor="middle" class="d-label-muted" font-size="10">writes</text>
  <line x1="480" y1="182" x2="480" y2="206" class="d-msg d-response" data-depends-on="primary3" marker-end="url(#arrowS3r)"></line>
  <text x="558" y="197" text-anchor="middle" class="d-label-muted" font-size="10">replicate</text>
  <defs>
    <marker id="arrowS3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowS3r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">Any app server can handle any request, so the load balancer just routes around a failed one. Writes still have exactly one destination — the primary — which replicates to the replica in the background.</div>
</div>

<div class="fail-hint">Click an app server or a database to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="app3">
<strong>If one app server fails:</strong> the load balancer's health checks stop seeing responses from it and route around it. The other instances keep serving all traffic — capacity drops slightly, but nothing is down.
</div>
<div class="failure-impact is-hidden" data-component="primary3">
<strong>If the primary database fails:</strong> every write fails immediately — there's still only one place writes can go. Reads can often keep working from the cache and the replica, which is the same synchronous-vs-asynchronous replication trade-off from <a href="#/systems/replication">Replication</a> showing up here: something has to detect the failure and promote the replica before writes work again.
</div>
<div class="failure-impact is-hidden" data-component="replica3">
<strong>If the replica fails:</strong> reads that would have gone to it are served from the cache or fall through to the primary instead. This is graceful degradation, not an outage — exactly the point of having more than one place to read from.
</div>
</div>

One thing is still shared by everyone: the primary database is the only place that accepts writes, and it's still one machine's worth of storage and write throughput. That's fine until the total number of short links, or the write rate, outgrows what one machine can hold.

<!-- stage:4:4. Shard the Database -->

## Stage 4 — Shard the Database

When the mapping table itself gets too big, or the write rate outgrows one primary, the fix is [Partitioning & Sharding](#/systems/partitioning-sharding): split the table across multiple shards, each one hashed by short code, each one still replicated exactly the way Stage 3 set up. The load balancer, app servers, and cache from the previous stages don't change — they're collapsed into one box below so the diagram can focus on what's new.

<div class="diagram-wrap">
<svg viewBox="0 0 660 260" width="660" height="260" role="img" aria-label="App tier routing through a hash function to one of three sharded, replicated databases">
  <rect x="10" y="100" width="150" height="50" rx="8" class="d-actor-box" data-role="compute"></rect>
  <text x="85" y="122" text-anchor="middle" class="d-actor-label" font-size="12">App Tier</text>
  <text x="85" y="138" text-anchor="middle" class="d-label-muted" font-size="10">(LB + servers + cache)</text>
  <rect x="210" y="105" width="110" height="40" rx="6" class="d-note"></rect>
  <text x="265" y="129" text-anchor="middle" class="d-note-text" font-size="12">hash(code) % 3</text>
  <g data-fail-toggle="shard0">
    <rect x="400" y="16" width="130" height="30" rx="5" class="d-actor-box" data-role="datastore"></rect>
    <text x="465" y="36" text-anchor="middle" class="d-actor-label" font-size="11">Shard 0 · Primary</text>
  </g>
  <rect x="400" y="50" width="130" height="22" rx="4" fill="none" stroke="var(--border)"></rect>
  <text x="465" y="65" text-anchor="middle" class="d-label-muted" font-size="10">Shard 0 · Replica</text>
  <g data-fail-toggle="shard1">
    <rect x="400" y="98" width="130" height="30" rx="5" class="d-actor-box" data-role="datastore"></rect>
    <text x="465" y="118" text-anchor="middle" class="d-actor-label" font-size="11">Shard 1 · Primary</text>
  </g>
  <rect x="400" y="132" width="130" height="22" rx="4" fill="none" stroke="var(--border)"></rect>
  <text x="465" y="147" text-anchor="middle" class="d-label-muted" font-size="10">Shard 1 · Replica</text>
  <g data-fail-toggle="shard2">
    <rect x="400" y="180" width="130" height="30" rx="5" class="d-actor-box" data-role="datastore"></rect>
    <text x="465" y="200" text-anchor="middle" class="d-actor-label" font-size="11">Shard 2 · Primary</text>
  </g>
  <rect x="400" y="214" width="130" height="22" rx="4" fill="none" stroke="var(--border)"></rect>
  <text x="465" y="229" text-anchor="middle" class="d-label-muted" font-size="10">Shard 2 · Replica</text>
  <line x1="160" y1="122" x2="206" y2="122" class="d-msg d-request" marker-end="url(#arrowS4)"></line>
  <line x1="320" y1="115" x2="396" y2="35" class="d-msg d-request" data-depends-on="shard0" marker-end="url(#arrowS4)"></line>
  <line x1="320" y1="125" x2="396" y2="115" class="d-msg d-request" data-depends-on="shard1" marker-end="url(#arrowS4)"></line>
  <line x1="320" y1="135" x2="396" y2="197" class="d-msg d-request" data-depends-on="shard2" marker-end="url(#arrowS4)"></line>
  <defs>
    <marker id="arrowS4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">Every short code hashes deterministically to exactly one shard. Each shard is replicated on its own, independently of the other shards — the mechanism from Stage 3, now applied per shard instead of once for the whole database.</div>
</div>

<div class="fail-hint">Click a shard's primary to see what happens if it fails — notice the blast radius this time.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="shard0">
<strong>If Shard 0's primary fails:</strong> only the short codes that hash onto Shard 0 are affected. Every other shard keeps reading and writing normally — Shard 0's own replica still needs to be promoted before its writes recover, but that's a fraction of the total data, not all of it.
</div>
<div class="failure-impact is-hidden" data-component="shard1">
<strong>If Shard 1's primary fails:</strong> only the short codes that hash onto Shard 1 are affected. Every other shard keeps reading and writing normally — Shard 1's own replica still needs to be promoted before its writes recover, but that's a fraction of the total data, not all of it.
</div>
<div class="failure-impact is-hidden" data-component="shard2">
<strong>If Shard 2's primary fails:</strong> only the short codes that hash onto Shard 2 are affected. Every other shard keeps reading and writing normally — Shard 2's own replica still needs to be promoted before its writes recover, but that's a fraction of the total data, not all of it.
</div>
</div>

Compare this to Stage 1: the same kind of failure — one database instance going down — used to mean a total outage. Here it means roughly a third of traffic sees a brief write disruption while the rest of the system keeps running. Nothing about that happened by accident; it's the direct, cumulative result of four separate, individually-motivated decisions, each one made because the previous stage hit a specific limit.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one specific hard sub-problem from the Architecture tab.

### Generating the short code

Three real strategies, each with a different trade-off:

1. **Random + collision check.** Generate a random base62 string, try to insert it, and on a rare collision retry with a new one. Simple, no shared state — but every write pays for at least one existence check, and the retry rate, however small, rises as the table fills.
2. **Counter + base62 encode.** Hand out a globally unique, monotonically increasing integer and encode it in base62 (`125` → `"2b"`). Guarantees a collision can never happen, by construction — no check needed. The catch is the counter itself: a single counter is a single coordination point every write has to go through. The usual fix is a range allocator — each app server checks out a block of, say, 10,000 IDs at a time and hands them out locally, only going back to the shared counter once the block is exhausted. (This is the same idea behind a Snowflake-style ID generator.)
3. **Pre-generated pool.** A background job generates codes in bulk ahead of time and stores them in a "ready" pool; the write path just claims one instead of generating it live. Moves all generation cost off the request path entirely, at the cost of running and monitoring a separate background system.

For a system whose non-functional requirements favor availability and a simple write path, the counter-based approach with block allocation is usually the best default — no collision handling on the hot path, no separate service to run.

### Handling a custom-alias race

Two people requesting the same custom alias at nearly the same moment is a race that "check, then insert" application logic can't fully close — between the check and the insert, another request can slip in. The reliable fix is to let the database do it: put a `UNIQUE` constraint on `short_code` and attempt the insert directly. If it fails with a uniqueness violation, that's the collision signal — return `409 Conflict`. This is cheaper and more correct than check-then-insert, and it's a pattern worth recognizing anywhere two writers can race on the same key.

### Cache eviction policy

Stage 2 introduces a cache without saying how it decides what to evict. For this access pattern — a large key space, a working set that's a small, shifting subset of it, and no benefit to keeping a key around after its link expires — an **LRU (least-recently-used)** eviction policy with a TTL capped by the link's own `expires_at` is the natural fit: it keeps whatever's actively being clicked, and never serves a cached redirect for a link that should already be gone.

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

No design in this case study is free of trade-offs — naming them explicitly is as much a part of the design process as the diagram.

### A single viral link is still a single key

Sharding by `hash(short_code)` spreads storage and average load evenly, but one link going viral still lands on exactly one shard — sharding doesn't parallelize a single key's traffic. In practice this is exactly what the cache in Stage 2 is for: the hottest keys are the ones most likely to be cache hits, so the shard behind a viral link rarely feels the full read volume directly. It's worth naming as a limit, not a flaw — no partitioning scheme fixes a single-key hotspot; only caching or replicating that specific key more aggressively does.

### Read-your-writes

Once Stage 3 adds a replica, there's a small window — the replication lag — where a link just created on the primary doesn't exist yet on the replica. Someone who creates a link and immediately shares it could, in that window, have the very first click 404. This is the availability-over-consistency choice from Requirements showing up as a concrete gap, not a bug: the fix, if it matters enough, is routing a user's own reads to the primary for a short window after their own write (read-your-writes consistency), not making every read wait for every replica to catch up.

### Counter-based generation is a coordination bottleneck

The block-allocation approach from Deep Dives avoids most of the cost, but the shared counter is still a single logical resource every app server eventually talks to. At extreme write volume, that allocator becomes the ceiling on write throughput — the fix is making blocks bigger (fewer round trips) at the cost of "wasting" unused IDs if a server crashes mid-block, or running multiple independent counters with an offset (server 1 issues odd IDs, server 2 issues even IDs) to remove the single resource entirely.

### 302 keeps every click on your servers

The 302-over-301 choice made in API Design buys analytics and the ability to fix a mistake, at the cost of every click — including repeat clicks from the same person — hitting the redirect service. That's the read volume Scale Estimates and Architecture are built to survive. A system that didn't need click analytics could serve 301s instead and let browser caching absorb a large fraction of repeat traffic for free.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

A URL shortener's job is, structurally, to take a URL from a stranger and send other strangers to it — that's also the definition of an open redirector, so the abuse surface is worth taking seriously.

### Malicious destinations

Anyone can submit a long URL that points at a phishing page or malware. A minimal defense is checking new URLs against a maintained blocklist at creation time, and re-checking periodically since a destination can turn malicious after the link was already created. A full detection pipeline is its own system and out of scope here, but the blocklist check is cheap and catches the obvious cases.

### Open redirect hygiene

Validate the URL scheme on creation — only allow `http`/`https`, and reject `javascript:` or `data:` URLs outright, since those can run code in the context of whoever clicks. Some shorteners add an interstitial "you're leaving this site, continuing to: `<url>`" page for links from unverified sources, trading one extra click for a chance to catch obviously suspicious destinations before the redirect fires.

### Abuse via volume

Nothing stops a script from calling the create endpoint in a tight loop to farm short links for spam. Rate limiting the create endpoint per API key or IP (see [Rate Limiting & Backpressure](#/systems/rate-limiting)) is the standard defense. The redirect endpoint is rate-limited too, but much more loosely, since legitimate viral traffic looks identical to a lot of redirect calls in a short window and shouldn't be penalized for it.

### Guessable codes

If short codes are generated from a simple, low-entropy counter without obfuscation, someone can enumerate `short.ly/1`, `short.ly/2`, ... and scrape every link (and its click count) ever created, or infer the exact creation rate of the service. Random codes avoid this by construction; counter-based generation (Deep Dives) needs the counter value obfuscated — e.g., encoding `counter XOR secret_key` in base62 instead of the raw counter — so consecutive codes aren't visibly sequential.

### Custom-alias squatting

Without any authentication, anyone can claim a valuable alias before its rightful owner does. Since authentication is out of scope for this case study, the practical mitigation is requiring some form of verified identity specifically for the custom-alias path, while anonymous users are still free to generate random codes.

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **Redirect latency, p50 and p99** — the redirect is the one path end users feel directly; p99 catches the slow tail a p50 average hides.
- **Cache hit ratio** — the single number that most explains database load. A sudden drop means the database is about to see a spike it wasn't sized for.
- **Write throughput and error rate** — creates failing or slowing down is usually the first sign of contention on the counter allocator or a saturated primary.
- **Replication lag** — directly bounds how stale a replica's reads can be, and how long a promoted replica would be missing data after a primary failure.
- **Per-shard QPS and storage** — sharding by hash should spread load evenly; a shard that's consistently hotter than its siblings usually means the key distribution isn't as uniform as assumed, or one shard is holding a viral link.

### What to alert on

- Redirect p99 latency crossing a fixed threshold (e.g., 200ms) for more than a couple of minutes.
- Cache hit ratio dropping below a set floor (e.g., 90%) — the database is about to take load it doesn't normally see.
- Replica lag exceeding a few seconds — the read-your-writes assumptions from Bottlenecks & Trade-offs start breaking down past this point.
- 5xx rate on either the create or redirect path rising above baseline.

### A shard's primary just died — what happens?

This is the scenario the Stage 4 failure toggles simulate directly. Only the fraction of short codes hashing to that shard are affected; every other shard keeps serving normally. The runbook: detect the failure (missed health checks), promote that shard's replica to primary, repoint the app tier's shard map at the new primary, and confirm replication lag was low enough at the time of failure that nothing recently written was lost. The blast radius — one shard's worth of writes, briefly — is the entire point of having sharded in Stage 4 instead of staying on one oversized primary.

### Capacity planning

Track daily write growth against two ceilings: remaining space in the short-code namespace (Scale Estimates shows this isn't a near-term concern) and per-shard storage growth (this is the one that actually matters — it's the signal for when to add a shard, ideally well before any single shard is close to full, since resharding under pressure is a much worse day than resharding on a calendar).
