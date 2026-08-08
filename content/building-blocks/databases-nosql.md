# Databases II — NoSQL Models

The relational model earns its guarantees — strict schemas, joins, ACID transactions — by doing real work to enforce them, and that work has a cost in flexibility and, in some designs, horizontal scalability. **NoSQL** is an umbrella term (loosely, "not only SQL") for a family of database models that each relax a different part of the relational model in exchange for something else: a more natural fit for certain data shapes, easier horizontal scaling, or higher write throughput. There's no single "NoSQL database" — the four models below solve genuinely different problems.

## Key-value stores

The simplest possible model: a giant dictionary. Every piece of data is stored and retrieved by a single key, and the database has no idea what's inside the value — it's an opaque blob as far as the store is concerned.

```
SET session:abc123 → { "userId": 42, "expiresAt": ... }
GET session:abc123 → { "userId": 42, "expiresAt": ... }
```

Because there's no schema to enforce and no relationships to maintain, key-value stores (Redis, DynamoDB, Memcached) can be extremely fast and trivially easy to shard — the key alone determines where the data lives, no coordination needed. This makes them the natural fit for caching (previous section), session storage, and any data that's always looked up by exactly one identifier and never queried by its contents.

The cost is exactly what you'd expect: you can't ask "give me all sessions belonging to users who signed up this week" — there's no way to query by anything other than the key.

## Document stores

A **document store** (MongoDB, Couchbase) keeps the key-value idea but makes the value a structured, typically JSON-like document that the database *can* look inside — so you can query and index on fields within it, not just the top-level key:

```json
{
  "_id": "user_42",
  "name": "Ada Lovelace",
  "orders": [
    { "id": 901, "total": 42.50 },
    { "id": 902, "total": 17.00 }
  ]
}
```

Notice the whole related "orders" list is nested directly inside the user document, rather than living in a separate table joined on demand. This is the central trade-off of the document model: data that's usually read together can be stored together, so a single lookup returns everything needed with no join — but the same order data can't as easily be queried on its own terms (e.g. "all orders over $100 across every user") the way a proper `orders` table could.

Document stores also don't enforce a schema the way relational tables do — two documents in the same collection can have different fields entirely. That's flexible during early development and for genuinely variable data, but it moves the responsibility for consistency (did every code path set the field the same way?) from the database into your application.

## Wide-column stores

A **wide-column store** (Cassandra, HBase, Bigtable) looks superficially table-like — rows and columns — but each row can have a different set of columns, and the columns are physically grouped and stored together rather than the whole row. It's built specifically for one shape of problem exceptionally well: very high write throughput, spread across a huge number of machines, for data typically accessed by a known key.

```
Row key: sensor_42
  2026-08-01T00:00 → 21.3°C
  2026-08-01T00:01 → 21.4°C
  2026-08-01T00:02 → 21.2°C
  ...
```

This is why wide-column stores show up so often for time-series data, IoT sensor readings, and logging/metrics pipelines: massive, constant write volume, almost always looked up by a known key (device ID, time range), rarely needing an ad-hoc query across unrelated rows. The cost is the mirror image of that strength — they're a poor fit when your actual access pattern is "query flexibly by many different attributes," since that's exactly what they're not optimized for.

## Graph databases

A **graph database** (Neo4j, Amazon Neptune) makes relationships themselves first-class, stored as direct pointers between nodes rather than reconstructed on demand via joins.

<div class="diagram-wrap">
<svg viewBox="0 0 600 200" width="600" height="200" role="img" aria-label="A small social graph of nodes connected by labeled relationship edges">
  <circle cx="120" cy="100" r="34" class="d-actor-box"></circle>
  <text x="120" y="105" text-anchor="middle" class="d-actor-label">Ada</text>
  <circle cx="320" cy="60" r="34" class="d-actor-box"></circle>
  <text x="320" y="65" text-anchor="middle" class="d-actor-label">Grace</text>
  <circle cx="320" cy="150" r="34" class="d-actor-box"></circle>
  <text x="320" y="155" text-anchor="middle" class="d-actor-label">Alan</text>
  <circle cx="500" cy="60" r="34" class="d-actor-box"></circle>
  <text x="500" y="65" text-anchor="middle" class="d-actor-label">Margaret</text>
  <line x1="152" y1="88" x2="288" y2="68" class="d-lifeline"></line>
  <text x="220" y="65" text-anchor="middle" class="d-label-muted" font-size="11">follows</text>
  <line x1="152" y1="112" x2="288" y2="142" class="d-lifeline"></line>
  <text x="220" y="145" text-anchor="middle" class="d-label-muted" font-size="11">follows</text>
  <line x1="354" y1="62" x2="466" y2="61" class="d-lifeline"></line>
  <text x="410" y="55" text-anchor="middle" class="d-label-muted" font-size="11">follows</text>
</svg>
<div class="diagram-caption">"Find everyone within two follows of Ada" is a direct traversal along stored edges here — the same query against a relational schema means repeated self-joins that get more expensive at every additional hop.</div>
</div>

Graph databases exist because relational joins, while perfectly capable of representing relationships, get expensive fast when a query needs to traverse several hops of relationship at once (friends-of-friends-of-friends), since each hop is another join. A graph database stores the relationship itself as a direct, traversable edge, so walking multiple hops stays close to constant work per hop instead of compounding. This makes them a strong fit for social networks, recommendation engines, and fraud detection (all fundamentally about relationships between entities) — and a poor fit for workloads that are mostly simple lookups or aggregations, where the specialization buys nothing.

## Choosing between them

| Model | Strongest for | Weak for |
|---|---|---|
| Relational | Structured data with real invariants, complex ad-hoc queries | Horizontal write scaling, deeply nested/variable data |
| Key-value | Simple lookups by a single key, caching, sessions | Any query that isn't "get by key" |
| Document | Data naturally read as one nested unit, flexible schema | Querying/joining across nested sub-objects at scale |
| Wide-column | Extremely high write throughput, time-series/logs | Ad-hoc queries by attributes other than the row key |
| Graph | Multi-hop relationship traversal | Simple lookups, bulk aggregation |

Real systems very often use more than one of these at once — a relational database for the core transactional data, a key-value store for caching and sessions, maybe a document store for a specific service with naturally nested data. This is normal, and is usually called **polyglot persistence**: picking the model that fits each piece of data, rather than forcing every kind of data through one database's model because it's already there.

## Why this matters for system design

The question "SQL or NoSQL" is really the wrong question — the real question is what shape your data takes, how it's actually queried, and which guarantees (strict schema and joins, or flexibility and horizontal write scale) matter more for that specific piece of data. Every model here is a genuine trade-off, not a strictly better or worse option than the relational model from the previous section — which is exactly why picking the right one for a given case study, later in this course, is a real design decision and not a formality.
