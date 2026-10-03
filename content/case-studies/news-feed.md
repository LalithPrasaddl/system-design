# Social Media News Feed

A home feed shows the newest posts from every account a person follows, merged into one list. The feature looks like a simple query. Two facts make it hard. Reads outnumber writes many times over, so the feed must be cheap to read. And every post has to reach every follower's feed, while follower counts range from a handful to a hundred million. This case study works out where to do the merging — when a post is written, when a feed is read, or a mix of both — and what each choice costs.

<!-- tab:requirements:Requirements -->

## Requirements

This case study builds the home feed of a large social product: the scrolling list a person sees when they open the app. The rest of the product — profiles, replies, search, messaging — exists around it, but the feed is the most-read page in the product, and most of the infrastructure behind it exists to make that one read fast.

### Functional requirements

- **Publish a post:** text, plus references to media stored elsewhere. A post can be deleted later.
- **Follow and unfollow** other accounts. Following is one-way: Maya can follow Ana without Ana following her back.
- **Read the home feed:** posts from followed accounts, newest first, 20 at a time. Scrolling loads older pages; pulling down loads newer posts.
- **Read a profile timeline:** one account's own posts, newest first.
- **Posts appear in followers' feeds quickly**, without anyone reloading the whole feed.

### Non-functional requirements

- **Fast reads.** A feed page in under **100ms at p99**, measured at the server. The feed is the first thing on screen when the app opens.
- **Highly available reads.** Target **99.95%**. A slightly stale feed is acceptable; no feed is not.
- **Fresh enough.** A new post reaches followers' feeds within **5 seconds at p99** for ordinary accounts. Strict real-time delivery is not required.
- **Read-your-own-writes for the author.** A person who has just posted must see that post in their own feed and profile immediately, even if their followers see it a few seconds later.
- **Durable posts.** A post that was acknowledged is never lost. The feed itself is derived data and can be rebuilt; posts can't.

### In scope

Storing posts and the follow graph, building each person's feed, handling accounts with very large followings, fetching the post contents for a page, deletes, and keeping the feed infrastructure affordable.

### Out of scope

**Ranking** — ordering posts by predicted interest rather than time. This design produces the reverse-chronological feed, which is also the candidate list a ranking system would start from; Deep Dives shows where ranking plugs in. **Media storage and delivery**, covered by object storage and [CDNs & Edge Delivery](#/systems/cdn-edge-delivery). **Like and reply counts**, which are a high-volume counting problem of their own. **Push notifications** about new posts.

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

The key number in this case study is not any single rate. It is the multiplier between them: every post is written once but must appear in many feeds, and every feed is read many times.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Feed reads</div>
<div class="stat-tile-value">~70<span class="stat-tile-unit">K/sec</span></div>
<div class="stat-tile-sub">at peak</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">New posts</div>
<div class="stat-tile-value">~3.5<span class="stat-tile-unit">K/sec</span></div>
<div class="stat-tile-sub">at peak</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Followers</div>
<div class="stat-tile-value">200</div>
<div class="stat-tile-sub">average per account</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Feed inserts</div>
<div class="stat-tile-value">~700<span class="stat-tile-unit">K/sec</span></div>
<div class="stat-tile-sub">if every post is pushed to every follower</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Largest account</div>
<div class="stat-tile-value">100<span class="stat-tile-unit">M</span></div>
<div class="stat-tile-sub">followers</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Feed cache</div>
<div class="stat-tile-value">~3.2<span class="stat-tile-unit">TB</span></div>
<div class="stat-tile-sub">post IDs for active users</div>
</div>
</div>

### Assumptions

- **500 million** registered accounts, **200 million** active each day.
- Each active user loads a feed page about **10 times a day** — opening the app, scrolling, refreshing.
- **100 million** new posts a day.
- An account follows **200** others on average. Since every follow is one follower for someone, the average follower count is also 200 — but the distribution is extremely uneven. Most accounts have a few dozen followers. A few thousand have millions. The largest have about **100 million**.
- Peak traffic is about **3×** the daily average.

### Requests

- Feed reads: 200M × 10 = 2 billion a day, about **23,000/sec**, peaking at **~70,000/sec**.
- Posts: 100 million a day, about **1,160/sec**, peaking at **~3,500/sec**.

Reads outnumber posts **20 to 1**. Every design decision that follows leans on that ratio.

### The fan-out multiplier

If each post were copied into each follower's feed, every post would cost 200 feed inserts on average: 100M × 200 = **20 billion inserts a day**, about 230,000/sec on average and **~700,000/sec at peak**. That is large but manageable, spread over many cache nodes.

The average hides the problem. One post from an account with 100 million followers is 100 million inserts — about **2.4 minutes** of the entire fleet's peak insert capacity, for a single post.

### What a feed read costs without precomputation

If the feed is assembled at read time, one page means finding the newest posts of all 200 followed accounts and merging them. That is about 200 index lookups per read. At 70,000 reads/sec, it is **14 million index lookups a second**, on a posts table far too large for memory.

### Storage

- **Posts:** about 1KB each with metadata (text, author, timestamps, media references; media bytes are stored separately). 100GB a day, about **36TB a year** before replication.
- **Feeds:** each feed holds the newest **800** post IDs. At 8 bytes per ID that is 6.4KB, about 13KB with the cache's data-structure overhead. Feeds are kept only for recently active users (about 250 million): **~3.2TB**, or ~6.4TB with a replica of each — about 100 cache nodes with 64GB each.
- **Post cache:** posts from the last two days cover nearly every feed read: 200M × 1KB = **~200GB**.

### Bandwidth

A page of 20 posts is about 20KB of JSON, with images and video loaded separately from a CDN. 70,000 pages/sec × 20KB is **~1.4GB/sec** of outgoing API traffic.

<!-- tab:api-design:API Design -->

## API Design

### Endpoints

```
POST /v1/posts
Idempotency-Key: 6f1c…
{"text": "Shipping the new release today", "media_ids": ["m_8812"]}
→ 201 {"post_id": "364018610995269632", "created_at": "2026-10-01T12:00:00Z"}

DELETE /v1/posts/364018610995269632
→ 204

PUT    /v1/me/following/{user_id}      → 204   follow
DELETE /v1/me/following/{user_id}      → 204   unfollow

GET /v1/feed?limit=20
GET /v1/feed?limit=20&max_id=364018584117841920     older page
GET /v1/feed?limit=20&since_id=364018610995269632   newer posts
→ 200 {
  "posts": [
    {"post_id": "364018610995269632",
     "author": {"id": "u_271", "handle": "ana", "name": "Ana", "avatar_url": "…"},
     "text": "Shipping the new release today",
     "media": [{"id": "m_8812", "url": "…"}],
     "created_at": "2026-10-01T12:00:00Z"}
  ],
  "next_max_id": "364018584117841919"
}

GET /v1/users/{user_id}/posts?limit=20&max_id=…     profile timeline
```

| Status | Meaning |
|---|---|
| `200` / `201` / `204` | Success |
| `400` | Text too long, too many media items, or a malformed cursor |
| `401` | Not signed in |
| `403` | The feed or profile belongs to a protected account the caller doesn't follow |
| `404` | The post or account does not exist, or was deleted |
| `429` | Posting or following too fast |

### Why the details matter

**Pages are addressed by post ID, not by offset.** An offset such as "skip 20, take 20" breaks on a feed that changes while it is read. If five new posts arrive between page one and page two, offset 20 now points five posts earlier, and the reader sees five posts twice. A cursor that says "posts older than ID X" is unaffected by anything added at the top. This works because post IDs are time-ordered: a larger ID is a newer post ([Distributed ID Generator](#/systems-case-studies/distributed-id-generator)). `max_id` pages backwards; `since_id` asks for anything newer than the top of the list the client already has.

**Posting is idempotent.** A phone on a poor connection often retries a post whose first attempt succeeded but whose response was lost. Without an idempotency key, the author ends up posting twice, and the duplicate is fanned out to every follower. The server stores the key with the result for 24 hours and returns the original response to a retry ([Idempotency & Exactly-Once Delivery](#/systems/idempotency)).

**The feed returns hydrated posts.** The client gets complete posts with author names and media URLs, in one response. Returning only IDs and letting the client fetch each post would cost 21 round trips per page on a mobile network.

**IDs are strings.** They are 64-bit integers, which JavaScript can't represent exactly as numbers.

<!-- tab:data-model:Data Model -->

## Data Model

There are two kinds of data here, and they are treated very differently. **Source data** — posts, accounts, follows — is durable and authoritative. **Derived data** — feeds, timelines, cached posts — lives in memory and can be thrown away and rebuilt from the source.

### Posts

```
posts                                  -- partitioned by hash(post_id)
  post_id      BIGINT   PRIMARY KEY    -- time-ordered, 64-bit
  author_id    BIGINT
  text         TEXT                    -- up to 500 characters
  media_ids    ARRAY<TEXT>
  visibility   TEXT                    -- public | followers
  deleted_at   TIMESTAMP NULL

author_posts                           -- partitioned by author_id
  author_id    BIGINT
  post_id      BIGINT                  -- clustered, descending
  PRIMARY KEY (author_id, post_id)
```

Two layouts of the same data, because there are two access patterns. Fetching 20 known posts for a feed page is a lookup by `post_id`, spread evenly by hashing. Listing one account's recent posts — for a profile, or to build a feed — is a range scan of `author_posts` within one partition. Both are written on every post. A wide-column store fits both patterns well: writes are cheap, and rows within a partition stay sorted by `post_id` ([Databases II — NoSQL Models](#/systems/databases-nosql)).

### Accounts and the follow graph

```
users
  user_id          BIGINT  PRIMARY KEY
  handle           TEXT    UNIQUE
  display_name     TEXT
  avatar_url       TEXT
  follower_count   INT
  is_big_account   BOOLEAN             -- follower_count above 100,000

followers                              -- partitioned by followee_id
  followee_id  BIGINT
  follower_id  BIGINT
  PRIMARY KEY (followee_id, follower_id)

following                              -- partitioned by follower_id
  follower_id  BIGINT
  followee_id  BIGINT
  PRIMARY KEY (follower_id, followee_id)
```

The follow graph is stored twice, once in each direction. Fan-out asks "who follows Ana?" and needs all of Ana's followers in one partition. Building a feed asks "who does Maya follow?" and needs all of Maya's follows in one partition. One table can serve only one of these well ([Partitioning & Sharding](#/systems/partitioning-sharding)). A follow writes both rows. If one write fails, a background job that compares the two tables repairs it.

### Derived data, in memory

```
feed:{user_id}        sorted set of post_id, newest 800       -- the home feed
bigfollows:{user_id}  set of big accounts this user follows
timeline:{author_id}  sorted set of post_id, newest 200       -- recent posts per author
post:{post_id}        the post, serialized
user:{user_id}        name, handle, avatar
```

A feed stores **post IDs only**, not post contents. A post appears in an average of 200 feeds; copying 1KB into each would multiply feed memory by more than 100, and editing or deleting the post would mean finding every copy. The feed says *which* posts; the post cache says *what they contain*.

The feed is a **sorted set scored by post ID** rather than a plain list. Because IDs are time-ordered, sorting by ID is sorting by time. Inserting the same post twice — which happens when a fan-out job is retried — leaves one entry, not two. And a page is a range query: the 20 highest IDs below `max_id`.

Author details live in `user:{id}`, not inside each cached post, so a person changing their display name updates one key rather than every post they ever wrote.

### What is deliberately missing

There is no durable feeds table. Every feed can be rebuilt from `following` and `author_posts`. Storing 500 million feeds durably would mean writing 20 billion rows a day to disk for data that is cheaper to recompute when it is lost.

<!-- tab:architecture:Architecture:default -->

This case study builds the feed up in five stages. Each stage fixes a specific failure of the one before. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one request at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. Query on Read -->

## Stage 1 — One Database, Query on Read

The smallest version that works: one app server and one relational database holding users, follows and posts. Publishing inserts a row. Reading a feed runs a query: find everyone this person follows, find their newest posts, merge, and return the top 20. Nothing is precomputed. This approach is called **fan-out on read**, or **pull**: the work of gathering a feed happens when someone reads it.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 560 260" width="560" height="260" role="img" aria-label="An author and a reader both talking to one app server, which queries one database holding users, follows and posts">
  <rect x="20" y="36" width="120" height="40" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="61" text-anchor="middle" class="d-actor-label" font-size="12">Author · Ana</text>
  <rect x="20" y="170" width="120" height="40" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="195" text-anchor="middle" class="d-actor-label" font-size="12">Reader · Maya</text>
  <g data-fail-toggle="app1">
    <rect x="210" y="100" width="130" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="275" y="129" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
  </g>
  <g data-fail-toggle="db1">
    <rect x="400" y="92" width="140" height="64" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="470" y="118" text-anchor="middle" class="d-actor-label" font-size="12">Database</text>
    <text x="470" y="135" text-anchor="middle" class="d-label-muted" font-size="9">users · follows · posts</text>
  </g>
  <line id="f1-auth-app" x1="142" y1="58" x2="206" y2="110" class="d-msg d-request" data-depends-on="app1" marker-end="url(#arrowF1)"></line>
  <line id="f1-app-auth" x1="206" y1="124" x2="142" y2="72" class="d-msg d-response" data-depends-on="app1" marker-end="url(#arrowF1r)"></line>
  <line id="f1-rd-app" x1="142" y1="184" x2="206" y2="132" class="d-msg d-request" data-depends-on="app1" marker-end="url(#arrowF1)"></line>
  <line id="f1-app-rd" x1="206" y1="144" x2="142" y2="198" class="d-msg d-response" data-depends-on="app1" marker-end="url(#arrowF1r)"></line>
  <line id="f1-app-db" x1="342" y1="114" x2="396" y2="114" class="d-msg d-request" data-depends-on="app1 db1" marker-end="url(#arrowF1)"></line>
  <line id="f1-db-app" x1="396" y1="134" x2="342" y2="134" class="d-msg d-response" data-depends-on="app1 db1" marker-end="url(#arrowF1r)"></line>
  <text x="280" y="244" text-anchor="middle" class="d-label-muted" font-size="10">play the post, then the two reads — compare their database time</text>
  <defs>
    <marker id="arrowF1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowF1r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "q", "title": "Feed query", "rows": [["accounts followed", "—"], ["index ranges read", "—"], ["candidate posts merged", "—"]]},
{"id": "load", "title": "At full scale", "rows": [["feed reads/sec", "70K"], ["index lookups/sec", "—"]]}
],
"flows": [
{
"id": "publish",
"label": "Ana publishes a post",
"nodes": ["app1", "db1"],
"steps": [
{"el": "f1-auth-app", "payload": "POST /v1/posts", "text": "Ana writes a post and publishes it. She has 200 followers."},
{"el": "f1-app-db", "payload": "INSERT post", "text": "The app server gives the post a time-ordered ID and inserts one row into the posts table. The index on (author_id, post_id) gets one new entry. None of Ana's followers is touched."},
{"el": "f1-db-app", "payload": "OK", "ms": 3, "text": "One indexed insert, about 3ms."},
{"el": "f1-app-auth", "payload": "201 · post_id", "text": "Publishing costs one insert whether Ana has 10 followers or 10 million. The write path of this design is as cheap as it can be. All the work is left for readers."}
]
},
{
"id": "read",
"label": "Maya opens her feed",
"nodes": ["app1", "db1"],
"steps": [
{"el": "f1-rd-app", "payload": "GET /v1/feed", "text": "Maya opens the app. She follows 200 accounts."},
{"el": "f1-app-db", "payload": "newest 20 from my follows", "set": {"q.accounts followed": "200"}, "text": "The app server runs one query: posts whose author is in Maya's follow list, newest first, limit 20. To answer it, the database finds the 200 accounts she follows, then jumps to the newest end of each one's range in the (author_id, post_id) index."},
{"el": "f1-db-app", "payload": "20 posts", "ms": 40, "set": {"q.index ranges read": "200", "q.candidate posts merged": "up to 4,000 → top 20"}, "text": "It reads up to 20 posts from each of the 200 ranges, merges them by time and keeps the top 20. Two hundred separate index lookups, most of them reading pages that aren't in memory: about 40ms."},
{"el": "f1-app-rd", "payload": "20 posts", "text": "Maya sees her feed. Scrolling to the next page runs the whole query again, with a cursor. The cost of every read is proportional to how many accounts the reader follows."}
]
},
{
"id": "heavy",
"label": "A reader who follows 2,000 accounts",
"nodes": ["app1", "db1"],
"steps": [
{"el": "f1-rd-app", "payload": "GET /v1/feed", "text": "Sam follows 2,000 accounts, which is common for active users."},
{"el": "f1-app-db", "payload": "newest 20 from my follows", "set": {"q.accounts followed": "2,000"}, "text": "The same query, with ten times as many authors to look up."},
{"el": "f1-db-app", "payload": "20 posts", "ms": 350, "set": {"q.index ranges read": "2,000", "q.candidate posts merged": "up to 40,000 → top 20", "load.index lookups/sec": "~14M (70K × 200)"}, "text": "350ms for one page — already over the latency target before any network time. Now scale it up: 70,000 reads a second, each needing about 200 index lookups, is 14 million random lookups a second. No single database does that, and the posts table can be split across machines only by scattering each feed query across all of them."},
{"el": "f1-app-rd", "payload": "20 posts", "text": "Reads are 20 times more common than posts, and this design puts all the work on the read. The next stage moves it to the write."}
]
}
]
}
</script>
<div class="diagram-caption">Publishing is one insert. Reading is a merge across every followed account, repeated on every page load. Compare the two reads: the cost grows with the number of accounts followed.</div>
</div>

<div class="fail-hint">Click the app server or the database to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="app1">
<strong>If the app server fails:</strong> nobody can post or read. This is the easy failure to fix: the app server keeps no state, so running several behind a load balancer removes it as a single point of failure ([Load Balancing](#/systems/load-balancing)). Later stages assume that has been done and draw one box for the whole group.
</div>
<div class="failure-impact is-hidden" data-component="db1">
<strong>If the database fails:</strong> the whole product stops. Posts, follows and feeds are all in one place, and the feed has no other source. A replica can take over ([Replication](#/systems/replication)), but a replica doesn't help with the real problem in this stage, which is not failure but load. Read replicas could each run feed queries, and would need to: at 14 million index lookups a second, the read load alone needs dozens of copies of the full posts table.
</div>
</div>

This design is correct and simple, and it is the right design for a small product: a feed of a few hundred accounts, read by a few thousand people, runs comfortably on one database. It fails at scale for one reason: the same expensive merge is recomputed every time anyone reads, although posts change much more rarely than feeds are read.

<!-- stage:2:2. Fan-out on Write -->

## Stage 2 — Precomputed Feeds: Fan-out on Write

Do the merge once per post instead of once per read. When Ana posts, add the post's ID to the feed of each of her followers. Each feed is a list of post IDs kept in memory in a cache cluster ([Caching](#/systems/caching)), so reading a feed is reading the first 20 entries of one list. This approach is called **fan-out on write**, or **push**.

The fan-out happens after the post is saved, in the background. The post request puts a job on a queue and returns; fan-out workers take jobs from the queue, look up the author's followers, and push the ID into each follower's feed ([Message Queues & Event-Driven Architecture](#/systems/message-queues)).

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 640 360" width="640" height="360" role="img" aria-label="An app server saving posts to a posts database and queuing fan-out jobs; fan-out workers read the follow graph and push post IDs into a feed cache, which the app server reads for feeds">
  <rect x="150" y="24" width="120" height="36" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="210" y="47" text-anchor="middle" class="d-actor-label" font-size="12">Author · Ana</text>
  <rect x="150" y="136" width="120" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="210" y="165" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
  <rect x="150" y="290" width="120" height="36" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="210" y="313" text-anchor="middle" class="d-actor-label" font-size="12">Reader · Maya</text>
  <g data-fail-toggle="posts2">
    <rect x="320" y="60" width="130" height="44" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="385" y="79" text-anchor="middle" class="d-actor-label" font-size="12">Posts DB</text>
    <text x="385" y="94" text-anchor="middle" class="d-label-muted" font-size="9">source of truth</text>
  </g>
  <g data-fail-toggle="q2">
    <rect x="320" y="176" width="130" height="44" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="385" y="202" text-anchor="middle" class="d-actor-label" font-size="12">Fan-out Queue</text>
  </g>
  <g data-fail-toggle="fc2">
    <rect x="320" y="286" width="130" height="48" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="385" y="306" text-anchor="middle" class="d-actor-label" font-size="12">Feed Cache</text>
    <text x="385" y="322" text-anchor="middle" class="d-label-muted" font-size="9">post IDs per follower</text>
  </g>
  <g data-fail-toggle="graph2">
    <rect x="490" y="60" width="134" height="44" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="557" y="79" text-anchor="middle" class="d-actor-label" font-size="12">Follow Graph</text>
    <text x="557" y="94" text-anchor="middle" class="d-label-muted" font-size="9">who follows whom</text>
  </g>
  <g data-fail-toggle="fw2">
    <rect x="490" y="176" width="134" height="44" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="557" y="202" text-anchor="middle" class="d-actor-label" font-size="12">Fan-out Workers</text>
  </g>
  <line id="s2-auth-app" x1="196" y1="62" x2="196" y2="132" class="d-msg d-request" marker-end="url(#arrowF2)"></line>
  <line id="s2-app-auth" x1="224" y1="132" x2="224" y2="62" class="d-msg d-response" marker-end="url(#arrowF2r)"></line>
  <line id="s2-rd-app" x1="196" y1="288" x2="196" y2="188" class="d-msg d-request" marker-end="url(#arrowF2)"></line>
  <line id="s2-app-rd" x1="224" y1="188" x2="224" y2="288" class="d-msg d-response" marker-end="url(#arrowF2r)"></line>
  <line id="s2-app-posts" x1="272" y1="142" x2="316" y2="98" class="d-msg d-request" data-depends-on="posts2" marker-end="url(#arrowF2)"></line>
  <line id="s2-posts-app" x1="316" y1="86" x2="272" y2="130" class="d-msg d-response" data-depends-on="posts2" marker-end="url(#arrowF2r)"></line>
  <line id="s2-app-q" x1="272" y1="170" x2="316" y2="192" class="d-msg d-request" data-depends-on="q2" marker-end="url(#arrowF2)"></line>
  <line id="s2-q-fw" x1="452" y1="198" x2="486" y2="198" class="d-msg d-request" data-depends-on="q2 fw2" marker-end="url(#arrowF2)"></line>
  <line id="s2-fw-graph" x1="545" y1="174" x2="545" y2="108" class="d-msg d-request" data-depends-on="fw2 graph2" marker-end="url(#arrowF2)"></line>
  <line id="s2-graph-fw" x1="569" y1="108" x2="569" y2="174" class="d-msg d-response" data-depends-on="fw2 graph2" marker-end="url(#arrowF2r)"></line>
  <line id="s2-fw-fc" x1="520" y1="222" x2="454" y2="296" class="d-msg d-request" data-depends-on="fw2 fc2" marker-end="url(#arrowF2)"></line>
  <line id="s2-app-fc" x1="252" y1="188" x2="322" y2="284" class="d-msg d-request" data-depends-on="fc2" marker-end="url(#arrowF2)"></line>
  <line id="s2-fc-app" x1="336" y1="284" x2="266" y2="188" class="d-msg d-response" data-depends-on="fc2" marker-end="url(#arrowF2r)"></line>
  <text x="320" y="352" text-anchor="middle" class="d-label-muted" font-size="10">play the post, then the read; fail the feed cache and replay the read</text>
  <defs>
    <marker id="arrowF2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowF2r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "fc", "title": "Feed cache", "rows": [["feed:maya", "[…8811, …7340, …6102, …]"], ["entries per feed", "≤ 800"]]},
{"id": "fo", "title": "Fan-out of Ana's post", "rows": [["queue depth", "0"], ["followers pushed", "0 / 200"]]}
],
"flows": [
{
"id": "publish",
"label": "Ana publishes a post",
"nodes": ["posts2", "q2", "fw2", "graph2", "fc2"],
"steps": [
{"el": "s2-auth-app", "payload": "POST /v1/posts", "text": "Ana publishes a post. She has 200 followers, one of them Maya."},
{"el": "s2-app-posts", "payload": "INSERT …9632", "text": "The app server assigns a time-ordered ID ending …9632 and saves the post. The posts database is the source of truth. Everything else in this diagram can be rebuilt from it."},
{"el": "s2-posts-app", "payload": "OK", "ms": 4, "text": "The post is durable."},
{"el": "s2-app-q", "payload": "fan-out: …9632, ana", "ms": 1, "set": {"fo.queue depth": "1"}, "text": "Instead of updating 200 feeds before answering Ana, the app server puts one small job on a durable queue."},
{"el": "s2-app-auth", "payload": "201", "text": "Ana's request is done after about 5ms. Everything from here happens in the background. The latency readout keeps counting it, but Ana isn't waiting for it."},
{"el": "s2-q-fw", "payload": "job", "set": {"fo.queue depth": "0"}, "text": "A fan-out worker takes the job from the queue."},
{"el": "s2-fw-graph", "payload": "followers of ana", "text": "It asks the follow graph for Ana's followers: one partition of the followers table, keyed by Ana's ID."},
{"el": "s2-graph-fw", "payload": "200 user IDs", "ms": 3, "text": "Two hundred follower IDs."},
{"el": "s2-fw-fc", "payload": "add …9632 × 200", "ms": 3, "set": {"fc.feed:maya": "[…9632, …8811, …7340, …]", "fo.followers pushed": "200 / 200"}, "text": "The worker adds the post ID to each follower's feed, grouping the writes by cache node so 200 inserts take a handful of round trips. Each feed is trimmed to its newest 800 entries. About 10ms after Ana published, her post is at the top of all 200 feeds."}
]
},
{
"id": "read",
"label": "Maya opens her feed",
"nodes": ["fc2", "posts2"],
"steps": [
{"el": "s2-rd-app", "payload": "GET /v1/feed", "text": "Maya opens the app."},
{"el": "s2-app-fc", "payload": "feed:maya, top 20", "altEl": "s2-app-posts", "text": "The app server reads the first 20 entries of one sorted set. No follow list, no merge.", "altText": "The feed cache is down. The only other place a feed can come from is Stage 1's query: the app server asks the database for the newest posts of all 200 accounts Maya follows."},
{"el": "s2-fc-app", "payload": "20 post IDs", "ms": 1, "altEl": "s2-posts-app", "altMs": 40, "text": "Twenty post IDs, in about a millisecond.", "altText": "40ms instead of 1. That is tolerable for one reader. With the whole feed cache down, all 70,000 reads a second take this path, and the posts database — sized for 3,500 posts a second and cheap lookups by ID — is overwhelmed within seconds."},
{"el": "s2-app-posts", "payload": "get 20 posts by ID", "text": "The feed holds only IDs. The app server fetches the 20 posts themselves by primary key, in one batched request."},
{"el": "s2-posts-app", "payload": "20 posts", "ms": 4, "text": "Twenty lookups by key, run in parallel across the database's partitions."},
{"el": "s2-app-rd", "payload": "20 posts", "text": "About 5ms of server time, and it no longer depends on how many accounts Maya follows. The merge was done, a little at a time, as each of those accounts posted."}
]
}
]
}
</script>
<div class="diagram-caption">Posting saves the post and queues one job; workers copy the post's ID into each follower's feed. Reading takes the top of one list. Fail the feed cache and replay the read to see the read fall back to Stage 1's query.</div>
</div>

<div class="fail-hint">Click the posts database, the queue, the workers, the follow graph or the feed cache to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="posts2">
<strong>If the posts database fails:</strong> nobody can post, and feeds can't be filled in: the feed cache holds IDs, but the posts behind them can't be fetched. This is the one component whose data can't be rebuilt from anything else, so it is replicated, and posts are acknowledged only once a replica has them ([Replication](#/systems/replication)). Stage 4 adds a post cache that keeps recent posts readable through a short outage.
</div>
<div class="failure-impact is-hidden" data-component="q2">
<strong>If the fan-out queue fails:</strong> posts are still saved, but the app server can't queue their fan-out, so new posts stop appearing in feeds. Feeds stay readable, showing what they held before. Because the post is already saved, the app server must not report failure to the author. It records the post as "fan-out pending" and a sweeper re-queues pending posts when the queue is back. Alternatively, the fan-out can be driven from the database's change log, which can't lose a post that was saved ([Batch vs. Stream Processing](#/systems/batch-vs-stream)).
</div>
<div class="failure-impact is-hidden" data-component="fw2">
<strong>If the fan-out workers fail:</strong> jobs pile up safely in the queue and feeds go stale. Nothing is lost. When workers return, they work through the backlog. A worker that crashes halfway through a job leaves some followers updated and some not. The job is retried from the start, which is safe because adding a post ID that is already in a sorted set changes nothing ([Idempotency & Exactly-Once Delivery](#/systems/idempotency)).
</div>
<div class="failure-impact is-hidden" data-component="graph2">
<strong>If the follow graph fails:</strong> workers can't find anyone's followers, so fan-out stops and the queue grows, as when the workers fail. Follows and unfollows fail too. Feed reads are unaffected — the read path no longer needs the graph at all, which is one of the quieter wins of this stage.
</div>
<div class="failure-impact is-hidden" data-component="fc2">
<strong>If the feed cache fails:</strong> every read falls back to building the feed from the database, as in Stage 1, at forty times the cost. Replay the read with the cache failed to see it. In practice the cache is many nodes, each with a replica, so a single node's failure affects a fraction of users, and their feeds are rebuilt one at a time as they are read. Stage 5 handles that rebuild carefully, because a mass rebuild is exactly the load that overwhelms the database.
</div>
</div>

Push moved the cost from reading to writing, which is the right direction when reads are 20 times more frequent. The write cost is now proportional to the author's follower count. At an average of 200 that is fine. The average is not the problem.

<!-- stage:3:3. Hybrid Fan-out -->

## Stage 3 — Hybrid Fan-out for Big Accounts

An account with 100 million followers can't be pushed. Its posts are pulled instead. Accounts above a threshold — here **100,000 followers** — are marked as big. A big account's posts are not fanned out. They go only into that account's own **author timeline**, a short list of its recent post IDs in a cache. When Maya reads her feed, the app server takes her pushed feed, plus the recent posts of the few big accounts she follows, and merges them.

Ordinary accounts are still pushed, so most of every feed is still precomputed. Only the small part that comes from big accounts is gathered at read time. This is Stage 1's pull, used only where push is impossible.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 660 380" width="660" height="380" role="img" aria-label="A big account's posts going into an author-timelines cache instead of fan-out, and a reader's feed read merging the pushed feed cache with the author timelines">
  <rect x="16" y="96" width="130" height="44" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="81" y="115" text-anchor="middle" class="d-actor-label" font-size="12">Big Account</text>
  <text x="81" y="130" text-anchor="middle" class="d-label-muted" font-size="9">100M followers</text>
  <rect x="16" y="296" width="130" height="44" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="81" y="322" text-anchor="middle" class="d-actor-label" font-size="12">Reader · Maya</text>
  <rect x="190" y="196" width="120" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="250" y="225" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
  <rect x="530" y="16" width="120" height="44" rx="6" class="d-actor-box" data-role="datastore"></rect>
  <text x="590" y="43" text-anchor="middle" class="d-actor-label" font-size="12">Follow Graph</text>
  <rect x="370" y="110" width="130" height="44" rx="6" class="d-actor-box" data-role="routing"></rect>
  <text x="435" y="136" text-anchor="middle" class="d-actor-label" font-size="12">Fan-out Queue</text>
  <g data-fail-toggle="fw3">
    <rect x="530" y="110" width="120" height="44" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="590" y="136" text-anchor="middle" class="d-actor-label" font-size="12">Fan-out Workers</text>
  </g>
  <g data-fail-toggle="tl3">
    <rect x="370" y="200" width="130" height="48" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="435" y="220" text-anchor="middle" class="d-actor-label" font-size="12">Author Timelines</text>
    <text x="435" y="236" text-anchor="middle" class="d-label-muted" font-size="9">recent posts of big accounts</text>
  </g>
  <g data-fail-toggle="fc3">
    <rect x="370" y="300" width="130" height="48" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="435" y="320" text-anchor="middle" class="d-actor-label" font-size="12">Feed Cache</text>
    <text x="435" y="336" text-anchor="middle" class="d-label-muted" font-size="9">pushed post IDs per user</text>
  </g>
  <line id="c3-celeb-app" x1="148" y1="112" x2="206" y2="192" class="d-msg d-request" marker-end="url(#arrowF3)"></line>
  <line id="c3-app-celeb" x1="218" y1="192" x2="160" y2="112" class="d-msg d-response" marker-end="url(#arrowF3r)"></line>
  <line id="c3-rd-app" x1="148" y1="312" x2="206" y2="248" class="d-msg d-request" marker-end="url(#arrowF3)"></line>
  <line id="c3-app-rd" x1="218" y1="248" x2="160" y2="312" class="d-msg d-response" marker-end="url(#arrowF3r)"></line>
  <line id="c3-app-q" x1="312" y1="206" x2="366" y2="148" class="d-msg d-request" marker-end="url(#arrowF3)"></line>
  <line id="c3-q-fw" x1="502" y1="132" x2="526" y2="132" class="d-msg d-request" data-depends-on="fw3" marker-end="url(#arrowF3)"></line>
  <line id="c3-fw-graph" x1="578" y1="108" x2="578" y2="64" class="d-msg d-request" data-depends-on="fw3" marker-end="url(#arrowF3)"></line>
  <line id="c3-graph-fw" x1="602" y1="64" x2="602" y2="108" class="d-msg d-response" data-depends-on="fw3" marker-end="url(#arrowF3r)"></line>
  <line id="c3-fw-fc" x1="560" y1="156" x2="504" y2="302" class="d-msg d-request" data-depends-on="fw3 fc3" marker-end="url(#arrowF3)"></line>
  <line id="c3-app-tl" x1="312" y1="214" x2="366" y2="214" class="d-msg d-request" data-depends-on="tl3" marker-end="url(#arrowF3)"></line>
  <line id="c3-tl-app" x1="366" y1="230" x2="312" y2="230" class="d-msg d-response" data-depends-on="tl3" marker-end="url(#arrowF3r)"></line>
  <line id="c3-app-fc" x1="296" y1="246" x2="366" y2="316" class="d-msg d-request" data-depends-on="fc3" marker-end="url(#arrowF3)"></line>
  <line id="c3-fc-app" x1="366" y1="330" x2="284" y2="248" class="d-msg d-response" data-depends-on="fc3" marker-end="url(#arrowF3r)"></line>
  <text x="330" y="370" text-anchor="middle" class="d-label-muted" font-size="10">play push-only first, then hybrid, then the read</text>
  <defs>
    <marker id="arrowF3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowF3r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "fo", "title": "Cost of one big-account post", "rows": [["feed inserts", "—"], ["time at full fleet rate", "—"], ["ordinary posts delayed", "—"]]},
{"id": "rd", "title": "Maya's read", "rows": [["from her pushed feed", "—"], ["big accounts she follows", "—"], ["merged page", "—"]]}
],
"flows": [
{
"id": "push-only",
"label": "Big account posts — push only",
"nodes": ["fw3", "fc3"],
"steps": [
{"el": "c3-celeb-app", "payload": "POST /v1/posts", "text": "An account with 100 million followers publishes. Under Stage 2, it is handled like anyone else's post."},
{"el": "c3-app-q", "payload": "fan-out to 100M", "text": "The post is saved and one fan-out job is queued."},
{"el": "c3-app-celeb", "payload": "201", "text": "The author's request is done. The cost is all in the background."},
{"el": "c3-q-fw", "payload": "job", "text": "Workers pick up the job and split it into thousands of smaller jobs."},
{"el": "c3-fw-graph", "payload": "followers, page 1 of 20,000", "text": "The follower list alone is 100 million IDs, about 800MB, read from the graph in 20,000 pages of 5,000."},
{"el": "c3-graph-fw", "payload": "5,000 IDs", "ms": 3, "text": "One page of followers. 19,999 to go."},
{"el": "c3-fw-fc", "payload": "100M inserts", "set": {"fo.feed inserts": "100,000,000", "fo.time at full fleet rate": "~2.4 minutes", "fo.ordinary posts delayed": "every post in that window"}, "text": "The fleet's entire peak capacity is about 700,000 feed inserts a second, so this one post occupies all of it for about 2.4 minutes. Every ordinary post published meanwhile waits behind it, breaking the 5-second freshness target for everyone. The big account's last followers see its post minutes late. If several big accounts post in the same hour, the pipeline never catches up."}
]
},
{
"id": "hybrid",
"label": "Big account posts — hybrid",
"nodes": ["tl3"],
"steps": [
{"el": "c3-celeb-app", "payload": "POST /v1/posts", "text": "The same post, with the hybrid design. The account is marked is_big_account, because it has more than 100,000 followers."},
{"el": "c3-app-tl", "payload": "add …9632", "set": {"fo.feed inserts": "1", "fo.time at full fleet rate": "~1ms", "fo.ordinary posts delayed": "none"}, "text": "The post is saved, but no fan-out job is queued. The app server adds the post's ID to the account's author timeline: one sorted-set insert."},
{"el": "c3-tl-app", "payload": "OK", "ms": 1, "text": "One write, about a millisecond. The post is immediately visible to all 100 million followers — not because it was copied to them, but because their reads will look here."},
{"el": "c3-app-celeb", "payload": "201", "text": "The fan-out pipeline never saw this post. Its cost per post is now capped at 100,000 inserts, the threshold, however popular the author is."}
]
},
{
"id": "read",
"label": "Maya reads her feed",
"nodes": ["fc3", "tl3"],
"steps": [
{"el": "c3-rd-app", "payload": "GET /v1/feed", "text": "Maya follows 200 accounts. Three of them are big accounts."},
{"el": "c3-app-fc", "payload": "feed:maya + bigfollows:maya", "text": "The app server reads two keys from the feed cache: Maya's pushed feed, and the small set of big accounts she follows. That set is updated whenever she follows or unfollows a big account."},
{"el": "c3-fc-app", "payload": "20 IDs · 3 accounts", "ms": 1, "set": {"rd.from her pushed feed": "top 20 IDs", "rd.big accounts she follows": "3"}, "text": "The newest 20 IDs pushed to her by ordinary accounts, and the IDs of the three big accounts."},
{"el": "c3-app-tl", "payload": "top 20 of 3 timelines", "text": "The app server reads the newest posts from each of the three big accounts' timelines, in one batched request."},
{"el": "c3-tl-app", "payload": "3 × recent IDs", "ms": 1, "set": {"rd.merged page": "top 20 of 80 IDs"}, "text": "Now it has four sorted lists of IDs. Because IDs are time-ordered, merging them is comparing integers. It keeps the 20 largest: the newest 20 posts across everyone Maya follows."},
{"el": "c3-app-rd", "payload": "20 posts", "text": "About 2ms to assemble, plus hydration as in Stage 2. A pull from 3 accounts instead of 200, and only for the accounts where pushing would cost the most."}
]
}
]
}
</script>
<div class="diagram-caption">Ordinary posts are still pushed into followers' feeds. Big accounts' posts stay in their own timelines, and readers merge them in when they read. Compare the two posting flows' costs in the state panel.</div>
</div>

<div class="fail-hint">Click the fan-out workers, the author timelines or the feed cache to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="fw3">
<strong>If the fan-out workers fail:</strong> ordinary accounts' new posts stop reaching feeds and the queue grows, exactly as in Stage 2. Big accounts' posts are unaffected, because they never used fan-out. Their visibility depends only on the author timelines being up.
</div>
<div class="failure-impact is-hidden" data-component="tl3">
<strong>If the author timelines fail:</strong> replay the read with them failed: the read stops at the timeline lookup. A better-behaved app server treats that lookup as optional — it returns the pushed part of the feed, missing only the big accounts' posts, rather than failing the whole page. Big-account posts can also be rebuilt from the author_posts table in the database, but that is many readers asking the same few partitions for the same data, so the timelines are replicated and their misses are rate-limited.
</div>
<div class="failure-impact is-hidden" data-component="fc3">
<strong>If the feed cache fails:</strong> the pushed part of each feed is gone and must be rebuilt, as in Stage 2. The big-account part is unaffected. A reader could still see a feed made only of big accounts' recent posts while their own feed is being rebuilt — a reduced but non-empty page.
</div>
</div>

### Choosing the threshold

The threshold trades write cost against read cost. Lowering it to 10,000 followers moves more accounts to pull: fan-out gets cheaper, and reads merge more timelines. Raising it does the opposite. The useful limit is the read side: as long as almost every reader follows only a handful of big accounts, merging their timelines costs little. An account crossing the threshold is switched over in the background: its future posts stop being fanned out, and a cleanup job removes its already-pushed posts from feeds, which the read-time merge would otherwise show twice. The dedupe in the merge, by post ID, covers the window in between.

<!-- stage:4:4. Hydration & Hot Posts -->

## Stage 4 — Hydration and Hot Posts

A feed is a list of IDs. Turning 20 IDs into 20 displayable posts — text, media, author name and avatar — is called **hydration**, and at 70,000 pages a second it is 1.4 million post lookups a second. Those lookups go to a **post cache**, split into shards by a hash of the post ID ([Distributed Cache](#/systems-case-studies/distributed-cache)). The database is asked only for posts the cache doesn't hold.

Hashing spreads ordinary posts evenly. It can't spread a single post. A big account's post lands near the top of tens of millions of feeds within minutes, and every one of those readers asks for the same key, on the same shard. This stage adds a small **in-process cache** on each app server for posts that are being read that often. It also uses hydration to drop deleted posts, rather than removing them from every feed.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 540 356" width="540" height="356" role="img" aria-label="An app server reading post IDs from the feed cache, fetching the posts from three post-cache shards and the posts database, with an in-process cache for hot posts">
  <rect x="16" y="160" width="110" height="40" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="71" y="185" text-anchor="middle" class="d-actor-label" font-size="12">Reader · Maya</text>
  <rect x="170" y="150" width="140" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="240" y="176" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
  <text x="240" y="193" text-anchor="middle" class="d-label-muted" font-size="9">hydrates IDs into posts</text>
  <rect x="170" y="270" width="140" height="44" rx="6" class="d-note"></rect>
  <text x="240" y="289" text-anchor="middle" class="d-note-text" font-size="11">hot-post cache</text>
  <text x="240" y="304" text-anchor="middle" class="d-note-text" font-size="9">in-process · 5s TTL</text>
  <g data-fail-toggle="fc4">
    <rect x="370" y="16" width="140" height="44" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="440" y="43" text-anchor="middle" class="d-actor-label" font-size="12">Feed Cache</text>
  </g>
  <rect x="370" y="96" width="140" height="40" rx="6" class="d-actor-box" data-role="cache"></rect>
  <text x="440" y="121" text-anchor="middle" class="d-actor-label" font-size="12">Post Cache · shard 1</text>
  <g data-fail-toggle="pc4">
    <rect x="370" y="160" width="140" height="40" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="440" y="185" text-anchor="middle" class="d-actor-label" font-size="12">Post Cache · shard 2</text>
  </g>
  <rect x="370" y="224" width="140" height="40" rx="6" class="d-actor-box" data-role="cache"></rect>
  <text x="440" y="249" text-anchor="middle" class="d-actor-label" font-size="12">Post Cache · shard 3</text>
  <g data-fail-toggle="db4">
    <rect x="370" y="290" width="140" height="44" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="440" y="317" text-anchor="middle" class="d-actor-label" font-size="12">Posts DB</text>
  </g>
  <line id="h4-rd-app" x1="128" y1="172" x2="166" y2="172" class="d-msg d-request" marker-end="url(#arrowF4)"></line>
  <line id="h4-app-rd" x1="166" y1="188" x2="128" y2="188" class="d-msg d-response" marker-end="url(#arrowF4r)"></line>
  <line id="h4-app-fc" x1="270" y1="148" x2="366" y2="52" class="d-msg d-request" data-depends-on="fc4" marker-end="url(#arrowF4)"></line>
  <line id="h4-fc-app" x1="366" y1="36" x2="256" y2="148" class="d-msg d-response" data-depends-on="fc4" marker-end="url(#arrowF4r)"></line>
  <line id="h4-app-s1" x1="312" y1="158" x2="366" y2="122" class="d-msg d-request" marker-end="url(#arrowF4)"></line>
  <line id="h4-s1-app" x1="366" y1="134" x2="312" y2="170" class="d-msg d-response" marker-end="url(#arrowF4r)"></line>
  <line id="h4-app-s2" x1="312" y1="176" x2="366" y2="176" class="d-msg d-request" data-depends-on="pc4" marker-end="url(#arrowF4)"></line>
  <line id="h4-s2-app" x1="366" y1="190" x2="312" y2="190" class="d-msg d-response" data-depends-on="pc4" marker-end="url(#arrowF4r)"></line>
  <line id="h4-app-s3" x1="312" y1="196" x2="366" y2="232" class="d-msg d-request" marker-end="url(#arrowF4)"></line>
  <line id="h4-s3-app" x1="366" y1="246" x2="312" y2="206" class="d-msg d-response" marker-end="url(#arrowF4r)"></line>
  <line id="h4-app-db" x1="290" y1="212" x2="366" y2="300" class="d-msg d-request" data-depends-on="db4" marker-end="url(#arrowF4)"></line>
  <line id="h4-db-app" x1="366" y1="316" x2="276" y2="212" class="d-msg d-response" data-depends-on="db4" marker-end="url(#arrowF4r)"></line>
  <line id="h4-app-lc" x1="220" y1="212" x2="220" y2="266" class="d-msg d-request" marker-end="url(#arrowF4)"></line>
  <line id="h4-lc-app" x1="250" y1="266" x2="250" y2="212" class="d-msg d-response" marker-end="url(#arrowF4r)"></line>
  <text x="270" y="346" text-anchor="middle" class="d-label-muted" font-size="10">play the page, then the viral post, then the deleted post</text>
  <defs>
    <marker id="arrowF4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowF4r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "pg", "title": "Maya's page", "rows": [["post IDs", "—"], ["posts fetched", "—"], ["dropped", "—"]]},
{"id": "hot", "title": "Viral post …9632 (shard 2)", "rows": [["reads/sec for this post", "—"], ["of those, reaching shard 2", "—"]]}
],
"flows": [
{
"id": "page",
"label": "Hydrate one page",
"nodes": ["fc4", "pc4", "db4"],
"steps": [
{"el": "h4-rd-app", "payload": "GET /v1/feed", "text": "Maya asks for her feed."},
{"el": "h4-app-fc", "payload": "top 20 IDs", "text": "The app server gets her 20 newest post IDs, merged with big accounts' timelines as in Stage 3."},
{"el": "h4-fc-app", "payload": "20 IDs", "ms": 1, "set": {"pg.post IDs": "20"}, "text": "Twenty IDs. Each one is hashed to find which post-cache shard holds it: 7 on shard 1, 7 on shard 2, 6 on shard 3."},
{"el": "h4-app-s1", "payload": "get 7 posts", "text": "The app server sends one batched request to each shard, all three at once."},
{"el": "h4-app-s2", "payload": "get 7 posts", "text": "Shard 2's batch."},
{"el": "h4-app-s3", "payload": "get 6 posts", "text": "Shard 3's batch."},
{"el": "h4-s1-app", "payload": "7 posts", "ms": 1, "text": "The three shards answer in parallel, so the page waits only for the slowest of them, about a millisecond."},
{"el": "h4-s2-app", "payload": "7 posts", "text": "Shard 2's posts."},
{"el": "h4-s3-app", "payload": "5 posts · 1 miss", "text": "One post is from three weeks ago and has been evicted from the cache."},
{"el": "h4-app-db", "payload": "get 1 post", "text": "The app server reads the missing post from the database and writes it back into shard 3, so the next reader finds it there."},
{"el": "h4-db-app", "payload": "1 post", "ms": 4, "set": {"pg.posts fetched": "20 (19 cache, 1 DB)"}, "text": "One lookup by primary key. With a two-day post cache, misses are rare: most feed reads are of recent posts."},
{"el": "h4-app-rd", "payload": "20 posts", "text": "Author names and avatars are fetched the same way, from user:{id} keys, in the same batched round. The page is ready in about 6ms of server time."}
]
},
{
"id": "viral",
"label": "A post goes viral",
"nodes": ["pc4"],
"steps": [
{"el": "h4-app-s2", "payload": "get …9632", "set": {"hot.reads/sec for this post": "~1.2M", "hot.of those, reaching shard 2": "all of them"}, "text": "A big account's post is at the top of 40 million feeds within minutes. Nearly every feed page loaded in those minutes includes it. Every one of those lookups asks for key post:…9632, and hashing sends every one to shard 2. A cache shard serves perhaps 100,000–200,000 reads a second."},
{"el": "h4-s2-app", "payload": "…9632 (slow)", "ms": 30, "text": "Shard 2 saturates. Every page that includes the viral post waits on it — and so does every page with any other post that happens to live on shard 2. Adding shards doesn't help, because one key can't be split. This is a hot key."},
{"el": "h4-app-lc", "payload": "get …9632", "text": "The fix: each app server keeps a small in-process cache of posts that are being read very often, for 5 seconds. A post qualifies when the app server sees it requested more than, say, 100 times a second, or when the post's author is a big account."},
{"el": "h4-lc-app", "payload": "…9632", "ms": 0, "set": {"hot.of those, reaching shard 2": "~400 (2,000 servers ÷ 5s)"}, "text": "Served from memory inside the app server, with no network call. Shard 2 now sees one request per app server every 5 seconds — about 400 a second across 2,000 servers — instead of 1.2 million. The cost: a post's edits or deletion can take up to 5 seconds to show."}
]
},
{
"id": "deleted",
"label": "A post was deleted",
"nodes": ["fc4", "pc4"],
"steps": [
{"el": "h4-app-fc", "payload": "top 20 IDs", "text": "An hour ago, one of the accounts Maya follows deleted a post, …8811. Its ID is still in Maya's feed — and in the feeds of everyone else who follows that account."},
{"el": "h4-fc-app", "payload": "20 IDs", "ms": 1, "set": {"pg.post IDs": "20"}, "text": "Removing a post ID from every feed it was pushed to would be a fan-out as big as the original. It can be done in the background, but it would take time, and a deleted post must disappear at once."},
{"el": "h4-app-s2", "payload": "get 7 posts", "text": "So deletion is enforced at hydration instead. Deleting a post replaces it with a tombstone — a marker saying it is gone — in the database and the post cache."},
{"el": "h4-s2-app", "payload": "6 posts · 1 tombstone", "ms": 1, "set": {"pg.dropped": "1 (deleted)"}, "text": "Hydration drops any post that is a tombstone. The same step drops posts by accounts Maya has blocked or unfollowed since they were pushed, and posts she may no longer see because their author made their account private."},
{"el": "h4-app-rd", "payload": "19 posts + cursor", "text": "Maya gets 19 posts, with a cursor for the next page. Returning a slightly short page is simpler than fetching more to fill it, and readers don't notice. A deleted post is gone everywhere as soon as its tombstone is written."}
]
}
]
}
</script>
<div class="diagram-caption">IDs from the feed cache are hydrated from post-cache shards in parallel, with the database behind them for misses. The hot-post cache inside each app server absorbs the reads one shard couldn't. Deleted posts are dropped here, not removed from feeds.</div>
</div>

<div class="fail-hint">Click the feed cache, post-cache shard 2, or the posts database to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="fc4">
<strong>If the feed cache fails:</strong> there are no IDs to hydrate, so this stage has nothing to do. Stage 5 covers rebuilding feeds when part of the feed cache is lost.
</div>
<div class="failure-impact is-hidden" data-component="pc4">
<strong>If post-cache shard 2 fails:</strong> about a third of the posts on every page are missing from the cache. Their lookups go to the database, which sees about 470,000 extra reads a second — far more than it was sized for. Three things contain it. The shard has a replica that takes over in seconds. The app server coalesces requests, so concurrent lookups for the same missing post become one database read. And the hot-post cache keeps the most popular posts available even while the shard is down.
</div>
<div class="failure-impact is-hidden" data-component="db4">
<strong>If the posts database fails:</strong> feeds still load, because almost every post on them is in the post cache. Only cache misses — old posts, deep scrolling — fail, and nobody can publish. The post cache was built for speed, and it also turns out to be the main reason reads survive a database outage.
</div>
</div>

Hydration is where a feed's IDs become posts, and it is also a convenient place to enforce rules that change after fan-out: deletions, blocks, unfollows, privacy. The feed is a list of candidates, and hydration has the final say over what is shown. That division keeps fan-out simple: it never needs to undo itself.

<!-- stage:5:5. Active Users & Rebuilds -->

## Stage 5 — Active Users and Feed Rebuilds

Of 500 million accounts, only about 200 million open the app on a given day. Pushing every post into every follower's feed means most pushes go to feeds that nobody reads before the entries fall out of the 800-entry window. It also means keeping feeds in memory for 500 million users instead of 250 million.

So **feeds are kept only for users seen in the last 3 days**. Fan-out pushes a post only into feeds that already exist; for anyone else, the insert does nothing. When an inactive user returns, their feed is missing. A **feed builder** builds it from scratch: it reads whom they follow, takes each account's recent post IDs from the author timelines, merges them, and writes the result to the feed cache. From then on, fan-out keeps it up to date.

The same builder handles the other way a feed can go missing: a feed-cache node is lost.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 670 330" width="670" height="330" role="img" aria-label="An app server reading the feed cache and asking a feed builder to rebuild missing feeds from the follow graph and author timelines; fan-out workers push only into feeds that exist">
  <rect x="16" y="140" width="110" height="40" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="71" y="165" text-anchor="middle" class="d-actor-label" font-size="12">Reader · Leo</text>
  <rect x="170" y="130" width="120" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="230" y="164" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
  <g data-fail-toggle="fc5">
    <rect x="350" y="36" width="150" height="52" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="425" y="58" text-anchor="middle" class="d-actor-label" font-size="12">Feed Cache</text>
    <text x="425" y="75" text-anchor="middle" class="d-label-muted" font-size="9">feeds of active users only</text>
  </g>
  <g data-fail-toggle="fb5">
    <rect x="350" y="226" width="150" height="52" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="425" y="248" text-anchor="middle" class="d-actor-label" font-size="12">Feed Builder</text>
    <text x="425" y="265" text-anchor="middle" class="d-label-muted" font-size="9">rebuilds missing feeds</text>
  </g>
  <rect x="540" y="36" width="120" height="52" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="600" y="58" text-anchor="middle" class="d-actor-label" font-size="12">Fan-out Workers</text>
  <text x="600" y="75" text-anchor="middle" class="d-label-muted" font-size="9">push only if feed exists</text>
  <rect x="540" y="160" width="120" height="44" rx="6" class="d-actor-box" data-role="datastore"></rect>
  <text x="600" y="186" text-anchor="middle" class="d-actor-label" font-size="12">Follow Graph</text>
  <g data-fail-toggle="tl5">
    <rect x="540" y="250" width="120" height="44" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="600" y="269" text-anchor="middle" class="d-actor-label" font-size="12">Author Timelines</text>
    <text x="600" y="284" text-anchor="middle" class="d-label-muted" font-size="9">recent post IDs by author</text>
  </g>
  <line id="r5-rd-app" x1="128" y1="152" x2="166" y2="152" class="d-msg d-request" marker-end="url(#arrowF5)"></line>
  <line id="r5-app-rd" x1="166" y1="168" x2="128" y2="168" class="d-msg d-response" marker-end="url(#arrowF5r)"></line>
  <line id="r5-app-fc" x1="292" y1="140" x2="346" y2="78" class="d-msg d-request" data-depends-on="fc5" marker-end="url(#arrowF5)"></line>
  <line id="r5-fc-app" x1="346" y1="64" x2="292" y2="126" class="d-msg d-response" data-depends-on="fc5" marker-end="url(#arrowF5r)"></line>
  <line id="r5-app-fb" x1="292" y1="180" x2="346" y2="240" class="d-msg d-request" data-depends-on="fb5" marker-end="url(#arrowF5)"></line>
  <line id="r5-fb-app" x1="346" y1="256" x2="286" y2="192" class="d-msg d-response" data-depends-on="fb5" marker-end="url(#arrowF5r)"></line>
  <line id="r5-fb-fc" x1="425" y1="224" x2="425" y2="92" class="d-msg d-request" data-depends-on="fb5 fc5" marker-end="url(#arrowF5)"></line>
  <line id="r5-fw-fc" x1="538" y1="62" x2="504" y2="62" class="d-msg d-request" data-depends-on="fc5" marker-end="url(#arrowF5)"></line>
  <line id="r5-fb-graph" x1="502" y1="236" x2="536" y2="196" class="d-msg d-request" data-depends-on="fb5" marker-end="url(#arrowF5)"></line>
  <line id="r5-graph-fb" x1="536" y1="184" x2="502" y2="224" class="d-msg d-response" data-depends-on="fb5" marker-end="url(#arrowF5r)"></line>
  <line id="r5-fb-tl" x1="502" y1="254" x2="536" y2="264" class="d-msg d-request" data-depends-on="fb5 tl5" marker-end="url(#arrowF5)"></line>
  <line id="r5-tl-fb" x1="536" y1="280" x2="502" y2="270" class="d-msg d-response" data-depends-on="fb5 tl5" marker-end="url(#arrowF5r)"></line>
  <text x="335" y="318" text-anchor="middle" class="d-label-muted" font-size="10">play the fan-out, then the returning user; fail the feed builder and replay</text>
  <defs>
    <marker id="arrowF5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowF5r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "fc", "title": "Feed cache", "rows": [["feeds held", "~250M (seen in last 3 days)"], ["feed:leo", "(none — last seen 12 days ago)"]]},
{"id": "fo", "title": "Fan-out of Ana's post", "rows": [["followers", "—"], ["pushed", "—"], ["skipped, no feed", "—"]]}
],
"flows": [
{
"id": "fanout",
"label": "Fan-out skips inactive followers",
"nodes": ["fc5"],
"steps": [
{"el": "r5-fw-fc", "payload": "add-if-exists × 200", "ms": 3, "set": {"fo.followers": "200", "fo.pushed": "90", "fo.skipped, no feed": "110 (including Leo)"}, "text": "A worker fans out Ana's post to her 200 followers, as in Stage 2, with one change: each insert applies only if that follower's feed already exists. It costs no extra lookup: the cache checks and inserts in one command. 110 of Ana's followers haven't opened the app in three days, so their feeds were evicted, and nothing is written for them. Across the whole system, this removes roughly half of all fan-out writes and half the feed memory."}
]
},
{
"id": "return",
"label": "A returning user opens the app",
"nodes": ["fc5", "fb5", "tl5"],
"steps": [
{"el": "r5-rd-app", "payload": "GET /v1/feed", "text": "Leo opens the app for the first time in 12 days. He follows 180 accounts."},
{"el": "r5-app-fc", "payload": "feed:leo", "text": "The app server reads his feed."},
{"el": "r5-fc-app", "payload": "(miss)", "ms": 1, "text": "There is no feed for Leo. It was evicted 9 days ago, and fan-out has skipped him since."},
{"el": "r5-app-fb", "payload": "build feed:leo", "text": "The app server asks the feed builder for his feed."},
{"el": "r5-fb-graph", "payload": "whom does leo follow?", "text": "The builder reads Leo's follow list: one partition of the following table."},
{"el": "r5-graph-fb", "payload": "180 accounts", "ms": 3, "text": "180 accounts. Big accounts are set aside: they are merged at read time, as in Stage 3, so they don't belong in the stored feed."},
{"el": "r5-fb-tl", "payload": "recent IDs × 172", "text": "For each of the other 172 accounts, it reads their newest post IDs from the author timelines. In this stage, every account has an author timeline, not only big ones: it is written on every post, and it is the raw material for rebuilds."},
{"el": "r5-tl-fb", "payload": "~6,000 IDs", "ms": 15, "text": "Several thousand IDs, in batched requests to the timeline shards. This is Stage 1's merge — but against an in-memory cache rather than a database index, and once per returning user rather than once per page view."},
{"el": "r5-fb-fc", "payload": "write top 800", "ms": 2, "set": {"fc.feed:leo": "800 IDs, built just now"}, "text": "The builder keeps the newest 800 and writes them as Leo's feed. From now on, fan-out finds the feed exists and pushes new posts into it."},
{"el": "r5-fb-app", "payload": "top 20 IDs", "text": "The first 20 go straight back to the app server."},
{"el": "r5-app-rd", "payload": "20 posts", "text": "After hydration, Leo sees his feed about 25ms after asking. That is slower than a normal read, once, and only for someone who hasn't opened the app in days."}
]
}
]
}
</script>
<div class="diagram-caption">Fan-out writes only to feeds that exist. A missing feed — a returning user, or a lost cache node — is rebuilt once by the feed builder from the follow graph and author timelines. Fail the builder and replay the return to see where a rebuild stops.</div>
</div>

<div class="fail-hint">Click the feed cache, the feed builder or the author timelines to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="fc5">
<strong>If a feed-cache node fails:</strong> if its replica takes over, nobody notices. If both are lost, every feed on that node — perhaps 2.5 million users, 1% of active users — is a miss at the same moment, and all of those users rebuild at once. That is a rebuild storm: thousands of builds a second, each reading hundreds of author timelines. The builder runs through a queue with a fixed rate limit. Users waiting in that queue get a degraded feed in the meantime: a quick merge of the newest posts from just the 20 accounts they interact with most, plus big accounts. Losing the feed cache entirely is survivable this way, but a full rebuild of 250 million feeds would take hours, which is why the cache is replicated ([Rate Limiting & Backpressure](#/systems/rate-limiting)).
</div>
<div class="failure-impact is-hidden" data-component="fb5">
<strong>If the feed builder fails:</strong> users with a cached feed are unaffected — the large majority. Users without one can't get it built. Replay the returning user with the builder failed: the read stops at the build request. The app server should not then attempt the build itself: that would spread the rebuild load across every app server with no rate limit. It serves the degraded feed described for the feed cache, and the user sees their full feed on the next refresh once the builder is back.
</div>
<div class="failure-impact is-hidden" data-component="tl5">
<strong>If the author timelines fail:</strong> rebuilds can't get posts, and Stage 3's read-time merge of big accounts fails too. Timelines can be rebuilt from the author_posts table, one account at a time, but rebuilding them during a burst of feed rebuilds multiplies the database load. Timelines are replicated, and their misses go through the same rate limit as feed rebuilds.
</div>
</div>

This is the full design. Posts are written once to a durable store and to their author's timeline. Ordinary authors' posts are pushed as IDs into the cached feeds of their active followers. Big authors' posts are pulled and merged at read time. Feeds are hydrated from a sharded post cache, with hot posts cached on each app server and deleted or hidden posts dropped there. Feeds that go missing are rebuilt once, at a controlled rate. All the in-memory pieces can be rebuilt from the durable store, so the posts database is the only thing that must never lose data.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### Push, pull and hybrid compared

| | Pull (fan-out on read) | Push (fan-out on write) | Hybrid |
|---|---|---|---|
| Cost to post | 1 write | 1 write per follower | 1 write per follower, capped at the threshold |
| Cost to read | 1 lookup per followed account | 1 lookup | 1 lookup + 1 per big account followed |
| Freshness | Immediate | Seconds, longer when the fan-out queue backs up | Immediate for big accounts, seconds for others |
| Feed storage | None | One list per user | One list per active user |
| Fails on | Readers who follow many accounts | Authors with many followers | Readers who follow many big accounts |

Each approach fails on the extreme of one distribution. Pull fails on readers who follow thousands of accounts; push fails on authors with millions of followers. The hybrid uses each where the other fails. Its own weak spot — a reader who follows hundreds of big accounts — is rare, and can be handled by capping how many big accounts' timelines are merged per read: the most-interacted-with first.

### The author sees their own post

Fan-out is asynchronous, so for a second or two the author's own post may not be in their feed yet. Readers don't notice a two-second delay. Authors always do: they post, return to their feed, and their post isn't there. Two fixes, often combined. The app inserts the post at the top of its local list as soon as the server accepts it. And the server merges the reader's own recent posts into their feed at read time, the same way it merges big accounts — the reader is always one of the accounts their own feed pulls from. This is read-your-own-writes consistency, enforced only for the one person who would notice ([Consistency Models & CAP/PACELC](#/systems/consistency-cap)).

### Fan-out workers in practice

A naive worker processes one job per post, reading all followers and writing one insert per follower. In practice:

- **Large follower lists are split.** A post from an account with 80,000 followers becomes 16 jobs of 5,000 followers each, processed in parallel, so one popular author can't hold up a worker for long.
- **Writes are grouped by cache node.** Followers are grouped by the node that holds their feed, and each group is sent as one pipelined batch. 5,000 inserts become a few dozen round trips.
- **Retries are safe.** Feeds are sorted sets keyed by post ID, so inserting an ID twice has no effect. A worker that dies mid-job can be retried from the start.
- **Fresh posts go first.** When the queue is backed up, workers take the newest jobs first. A post that is already ten minutes late is less urgent than one posted now.

### Unfollows, edits and deletes

Fan-out only adds. Everything that takes something away is handled another way:

- **Delete:** a tombstone, enforced at hydration (Stage 4). Instant everywhere.
- **Edit:** the post is stored once, so editing it updates one record and invalidates one cache key. Every feed shows the edit, because feeds hold IDs, not copies.
- **Unfollow:** the unfollowed account's posts remain in the feed until they age out. Hydration filters them by checking the reader's current follow list, which is cached alongside the feed. A background job also removes them from the stored feed, so the filter rarely has to drop anything.
- **Block:** the same as unfollow, but the filter is mandatory, not cosmetic. A blocked account's posts must never be shown, so the block check runs on every hydration, regardless of what the feed contains.

### Deep pagination

Feeds hold 800 IDs. A reader who scrolls past them falls back to a pull: the app server merges older posts from followed accounts' author_posts partitions, starting below the cursor. This is slow, but rare. Very few sessions scroll through 800 posts, and those that do have already spent long enough that a 200ms page is unnoticeable.

### Where ranking fits

A ranked feed doesn't replace this design. It adds a step after it. The pipeline built here becomes **candidate generation**: it produces the few hundred newest posts from accounts the reader follows. A ranking service then scores each candidate — by predicted likelihood of engagement — and the page shows the top-scoring ones. Ranking changes pagination: the order is no longer fixed by ID, so a cursor can't be "older than ID X". Instead, the ranked list for a session is stored briefly, and cursors are positions within it.

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### Fan-out is the system's largest workload

Even with the threshold and the active-user filter, fan-out writes outnumber everything else in the system. A surge of posting — a major news event, a sports final — produces a surge of fan-out exactly when everyone is also reading. The queue absorbs it, and the cost is freshness: feeds fall seconds or minutes behind. Workers prioritizing fresh jobs, and the capacity to add workers quickly, are what keep that delay short.

### Freshness is eventual

A post reaches followers' feeds after its fan-out completes: usually under a second, sometimes much longer. Two followers can see a post at different times, and a reply can briefly appear in someone's feed before the post it replies to. This is accepted. The alternative — making a post visible only once it is in every feed — would make posting wait on the slowest of 100,000 inserts.

### The threshold is a blunt boundary

An account with 99,000 followers is pushed; one with 101,000 is pulled. Accounts near the boundary switch back and forth as they gain and lose followers, and each switch costs a migration. A margin around the threshold — switch to pull at 100,000, back to push at 80,000 — prevents flapping. The threshold also ignores how often an account posts. A 50,000-follower account posting every minute costs more fan-out than a 500,000-follower account posting once a week, and some designs decide by followers × posting rate instead.

### Feed memory is the largest fixed cost

About 6TB of replicated memory for feeds, before any post caching. Two ways to reduce it: shorten the window (fewer than 800 IDs per feed), or shorten the activity cutoff (fewer than 3 days). Both increase rebuilds. Rebuilds are cheap in normal operation, so the right setting comes from measuring how often each kind of feed is actually read.

### One partition holds 100 million followers

The followers partition of the largest account is 100 million rows on one machine. It is read only during fan-out, and big accounts aren't fanned out, so it is rarely read in full. But it is written on every follow and unfollow of that account, and those arrive in bursts: a single viral moment can bring a million new follows in an hour. The partition can be split into sub-partitions by a hash of the follower ID, at the cost of reading several partitions to list all followers.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

The feed is the main way content reaches people, so most abuse of a social product passes through it. Its specific risks come from fan-out multiplying whatever goes into it, and from caches shared between readers ([Security & Authentication](#/systems/security-authentication)).

### Spam is multiplied by fan-out

One post from an account with 50,000 followers costs 50,000 feed inserts. A spam operation running thousands of accounts with purchased followers turns cheap posts into a large load, and puts the spam in front of real readers. Posting is rate-limited per account, with lower limits for new accounts ([Rate Limiting & Backpressure](#/systems/rate-limiting)). Posts flagged by spam detection are held from fan-out until classified. And because fan-out is asynchronous, a post found to be spam after fan-out is removed instantly everywhere, with a tombstone at hydration.

### Fake followers inflate fan-out

Purchased followers are usually inactive accounts. The active-user filter already prevents fan-out from writing to them, but they inflate follower counts, and so decide which accounts cross the big-account threshold. Follower counts used for system decisions should count only active, non-suspended accounts.

### Visibility must be enforced at read time

Fan-out decides what *might* appear in a feed. Hydration decides what *does*. Blocks, protected accounts, deleted posts, and content removed for legal reasons must all be checked at hydration, on every read. Each of these can change after fan-out happened, and stale feed entries must never show something the reader is no longer allowed to see. A filter applied only at fan-out time is a privacy bug that appears the moment an account goes private.

### Shared caches must not hold per-reader data

The post cache is shared by all readers, so it must only hold what every reader would see: the post itself. Anything specific to a reader — whether they liked it, whether they may see it — is computed per request and never stored in post:{id}. Mixing the two leads to one user's view being served to another.

### Scraping

A feed is a convenient way to collect everyone's posts. The feed endpoint requires authentication, is rate-limited per account and per IP, and caps how far back a client can page. Profile timelines of protected accounts check the follow relationship on every page, not just the first.

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **Feed read latency**, p50 and p99, split into feed-cache time, merge time, and hydration time.
- **Feed cache hit rate**, and the **rebuild rate** (builds per second, queue depth, time to build).
- **Fan-out lag:** the time from a post being saved to its last follower's feed being written. Measure p50 and p99, and the queue's oldest job age.
- **Fan-out volume:** inserts per second, and skipped inserts (inactive followers).
- **Post cache hit rate** per shard, and **reads per key** for the hottest keys — the earliest sign of a viral post.
- **Hydration drops** per page: tombstones, blocks, unfollows. A sudden rise usually means a mass deletion or a bug in a filter.
- **Empty or short feeds served**, and degraded feeds served during rebuilds.

### What to alert on

- Fan-out lag above **30 seconds** at p99, or the oldest job in the queue above a minute.
- Feed read p99 above **100ms**.
- Feed cache hit rate below about 95% for active users — usually a lost node, or an eviction setting that is too aggressive.
- Rebuild queue growing faster than it drains.
- Any post-cache shard above 70% CPU while the others are idle: a hot key that the in-process cache isn't catching.

### Fan-out is falling behind — what happens?

New posts reach feeds late. Nothing is lost, and reads are unaffected. Confirm it's real: compare fan-out lag with the queue's depth and the posting rate. If posting has spiked, add workers; they scale out with no coordination. If posting is normal but workers are slow, look at feed-cache latency: workers are usually waiting on a slow cache node. If one huge job is holding things up, check that the account is marked as a big account: a recently viral account may have crossed the threshold since the last background check. Workers prioritize fresh jobs, so the backlog consists mostly of old jobs, and some of those can be dropped once they are older than the feeds' window.

### A feed-cache node and its replica are lost — what happens?

What Stage 5's failure panel describes. About 1% of active users get a degraded feed for a few minutes, while the builder works through their rebuilds at a controlled rate. Watch the rebuild queue drain. Don't raise the builder's rate limit to clear it faster without checking author-timeline load first: the limit exists to keep the rebuild from overwhelming the timelines that every other read also depends on.

### A post goes viral — what happens?

One post-cache shard's CPU jumps while the others stay flat. The in-process hot-post cache should catch it within seconds. If it doesn't — the threshold is set too high, or the post's author isn't a big account — the post can be pushed into every app server's hot list by hand, and the threshold adjusted. Viral posts are routine in a product like this, so this should be automated, with the manual step as a fallback.
