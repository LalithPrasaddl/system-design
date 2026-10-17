# Search Autocomplete

Search autocomplete shows a short list of likely searches under the search box as the user types, and updates it on every keystroke. Each list is tiny and cheap to show. The hard parts are speed and scale. A new list is needed for every letter, and it has to arrive before the next letter is typed, about a tenth of a second. Requests come in from hundreds of millions of people. And the list should reflect what people are searching for now, not only what they searched for last month. This case study builds autocomplete for a large search service: a billion searches a day across 30 markets, with suggestions on screen within 100 milliseconds of a keystroke.

<!-- tab:requirements:Requirements -->

## Requirements

This case study builds the suggestion service behind the search box of a large search service. The running example is the biggest market, US English (`en-US`), which has about a third of all traffic. Search itself, finding results for a query once it's submitted, is a separate system ([Search & Indexing](#/systems/search-indexing)). This design reads that system's log of searches but doesn't rebuild it.

### Functional requirements

- **Suggest completions for a prefix**: for the text typed so far, return up to 10 searches that start with it, best first.
- **Rank by popularity**: the best suggestions are the ones the most people have searched for recently.
- **Pick up new trends quickly**: a query that suddenly gets popular, after breaking news for example, appears within minutes.
- **Suggest per market**: `football` means different things in the US and the UK, so each market has its own suggestions.
- **Remove a suggestion on request**: an offensive, dangerous or defamatory suggestion can be taken down within a minute.

### Non-functional requirements

- **Latency:** suggestions on screen within **100ms** of a keystroke for most users, wherever they are. Server time under **10ms** at p99.
- **Availability:** 99.9%. If suggestions fail, the search box must still work: the user can type and submit a search.
- **Freshness:** a trending query appears within **5 minutes**. Everything else may be up to a day old.
- **Privacy:** a query typed by only a handful of people is never suggested to anyone else.
- **Scale:** about 1 billion searches a day, and up to 350,000 suggestion requests a second at peak if every keystroke were sent.

### In scope

Matching prefixes, ranking by recent popularity, building and serving the index, cutting the number of requests, caching close to users, trending queries, removing suggestions, and splitting the index across markets and servers.

### Out of scope

**Search results**: what happens after a search is submitted. **Spelling correction** beyond a short note in Deep Dives. **Suggestions personalized on the server**: a user's own past searches are mixed in on their device. **Matching words in the middle of a query**: typing `tie a tie` doesn't suggest `how to tie a tie`.

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

The data is small: the whole `en-US` index fits in one server's memory. What shapes the design is the number of requests, how fast each one must be answered, and how far users are from the servers.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Searches</div>
<div class="stat-tile-value">~1<span class="stat-tile-unit">B/day</span></div>
<div class="stat-tile-sub">~25K/s at peak</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">One request per keystroke</div>
<div class="stat-tile-value">~350<span class="stat-tile-unit">K/s</span></div>
<div class="stat-tile-sub">at peak, across all markets</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Reaching the servers</div>
<div class="stat-tile-value">~50<span class="stat-tile-unit">K/s</span></div>
<div class="stat-tile-sub">after waiting for pauses and caching</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Time per keystroke</div>
<div class="stat-tile-value">100<span class="stat-tile-unit">ms</span></div>
<div class="stat-tile-sub">keystroke to suggestions on screen</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">en-US index</div>
<div class="stat-tile-value">~9<span class="stat-tile-unit">GB</span></div>
<div class="stat-tile-sub">25M queries · in memory</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Search log</div>
<div class="stat-tile-value">~40<span class="stat-tile-unit">GB/day</span></div>
<div class="stat-tile-sub">~1.1TB for the last 28 days</div>
</div>
</div>

### Assumptions

- **150 million** people search each day, about **1 billion** searches in all. Peak traffic is about twice the average.
- A query is **22 characters** on average. A user types about **15** of them before submitting or picking a suggestion.
- Users are on every continent. Servers start in one region; a round trip from Sydney to it takes about **180ms**.
- A query has to have been searched by at least **50 different people** in the last 28 days to be suggested. In `en-US` that's about **25 million** queries.
- About a third of requests are for prefixes of 1 or 2 characters.
- Each search log line is about **40 bytes**: time, market, query and a hashed user ID.

### Requests

1 billion searches at 15 keystrokes each is 15 billion keystrokes a day, about 175,000 a second on average and **350,000 a second at peak**, if each keystroke sends a request. Most of those requests are for prefixes the user has already typed past by the time the answer comes back. Waiting for a short pause in typing before sending cuts it to about 6 requests per search. Caches in the browser and close to the user answer a little over half of the rest, leaving about **50,000 a second** for the servers.

### The index

25 million queries at about 24 bytes each is 600MB of text. All their prefixes, shared where queries start the same way, make about 150 million nodes in a tree. Storing each node's top 10 suggestions as 4-byte query numbers, plus the node itself, comes to about 60 bytes a node: **about 9GB**. That fits in the memory of one server, so every server can hold the whole `en-US` index, and adding servers adds capacity.

### The log

1 billion searches at 40 bytes is **40GB a day**, and 1.1TB for 28 days. Building the index means reading all of it, which takes a cluster of machines about half an hour. That's fine once a night, and far too slow to show a query that started trending ten minutes ago.

<!-- tab:api-design:API Design -->

## API Design

The search box in the browser and apps calls one read endpoint on every pause in typing. It's a `GET` with everything in the URL, so browsers and caches can store the answers.

### Suggestions

```
GET /v1/suggest?market=en-US&q=how%20t
→ 200 {"prefix": "how t",
       "suggestions": [{"text": "how to tie a tie"},
                       {"text": "how to screenshot on windows"},
                       {"text": "how to train your dragon"}, …],
       "index": "en-US.20261016"}
Cache-Control: public, max-age=60
```

### Feedback

```
POST /v1/suggest/feedback
{"market": "en-US", "prefix": "how t", "chosen": "how to tie a tie", "position": 1}
→ 204
```

### Removing a suggestion (internal)

```
POST /v1/suggest/blocks
{"market": "en-US", "query": "acme bank collapse", "match": "exact", "reason": "false rumour"}
→ 201 {"block_id": "blk_301", "live_by": "14:21:30"}
```

| Code | Meaning |
|---|---|
| `200` | Suggestions, possibly an empty list |
| `201` | Block created |
| `204` | Feedback recorded |
| `400` | Prefix longer than 60 characters, or unknown market |
| `429` | Over the caller's request rate |

### Why the details matter

**A `GET` with no user in it.** The answer for `how t` in `en-US` is the same for everyone, so the browser, and caches near the user, can keep it and give it to the next person who types `how t`. A user's own past searches are mixed in on their device rather than on the server, so they never make an answer unshareable.

**The prefix is normalized before it's sent.** Lower case, one space between words, no space at the start. `How  T` and `how t` are the same request, so they share a cache entry.

**The response repeats the prefix.** Answers can arrive out of order. The search box shows an answer only if its prefix is still what's in the box.

**`index` names the version.** When suggestions look wrong, this says which build they came from.

**Empty is a normal answer.** Typing `xqzv` returns `200` with no suggestions, which is cacheable. An error would make the search box retry.

**Prefixes stop at 60 characters.** Almost no suggestion is longer, and refusing them keeps long, random URLs from filling the caches.

<!-- tab:data-model:Data Model -->

## Data Model

Four kinds of data, each stored the way it's used: a log of searches that's only ever appended to and read in bulk, an index built from it that's only ever read, a small set of trending queries that changes every minute, and a block list that's small and must never be lost.

### The search log

```
search_log/en-US/2026-10-16/14.log      -- one file per market per hour, in object storage
  ts            14:05:11.204
  market        en-US
  query         earthquake today         -- normalized
  user_hash     9f2c…                    -- hashed user ID, for counting distinct people
  from_suggest  2                        -- position of the suggestion picked, or empty
```

### The index

```
query_scores                             -- built nightly, one row per query
  market        TEXT
  query         TEXT
  score         FLOAT                    -- searches over 28 days, each day worth 10% less than the next
  distinct_users INT                     -- must be ≥ 50 to be in the index

en-US.20261016.idx                       -- a snapshot file, ~9GB
  queries       [query_id → text]        -- 25M strings
  nodes         [node → children, top_10: query_id[10]]
```

### Trending and blocks

```
trend_counts      in memory per stream partition
  query → 10 one-minute buckets of searches and distinct users

trend_baseline    key-value store
  (market, query, hour of week) → usual searches per 10 minutes, from the last 7 days

trending          pushed to every server every 30 s
  market → [(query, score, since)]       -- a few hundred per market

blocks            relational DB
  block_id      TEXT PRIMARY KEY
  market        TEXT
  query         TEXT
  match         TEXT                     -- exact | contains
  reason        TEXT
  created_by    TEXT
  created_at    TIMESTAMP
```

### Shards (from Stage 5)

```
shard_map
  market        TEXT                     -- en-US
  range_start   TEXT                     -- sa
  range_end     TEXT                     -- sm, exclusive
  shard         TEXT                     -- en-US-4
  index         TEXT                     -- en-US-4.20261016
```

### Why this storage

The log is written a million times a minute and read only by the nightly build, so it's append-only files in object storage, split by market and hour ([Batch vs Stream Processing](#/systems/batch-vs-stream)). The index is read hundreds of thousands of times a second and never written, so it's a prebuilt file that every server loads into memory, and answering a request touches no disk and no other machine. Trending counts change every second and only matter for minutes, so they live in the memory of the stream workers that count them. Blocks are few, edited by people, and must never be lost: a small relational table, copied to every server.

<!-- tab:architecture:Architecture:default -->

This case study builds search autocomplete up in five stages. Each stage fixes a specific failure of the one before. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one request at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. A LIKE Query -->

## Stage 1 — Ask the Database on Every Keystroke

The simplest autocomplete keeps a count for every query that's ever been searched. On each keystroke, it asks the database for the ten most-searched queries that start with what's been typed. Every search adds one to its query's count.

```
-- on every keystroke
SELECT query FROM query_counts
WHERE market = 'en-US' AND query LIKE 'pyth%'
ORDER BY count DESC LIMIT 10

-- on every search
UPDATE query_counts SET count = count + 1 WHERE market = 'en-US' AND query = 'weather'
```

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 780 290" width="780" height="290" role="img" aria-label="A user's search box asks an app server for suggestions, and the app server queries the query counts table in a database; searches add one to a query's count in the same database">
  <rect x="20" y="115" width="140" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="141" text-anchor="middle" class="d-actor-label" font-size="12">Search Box</text>
  <text x="90" y="158" text-anchor="middle" class="d-label-muted" font-size="9">browser</text>
  <g data-fail-toggle="app1">
    <rect x="260" y="95" width="180" height="100" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="350" y="126" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
    <text x="350" y="144" text-anchor="middle" class="d-label-muted" font-size="9">suggestions: LIKE 'prefix%'</text>
    <text x="350" y="159" text-anchor="middle" class="d-label-muted" font-size="9">searches: count + 1</text>
  </g>
  <g data-fail-toggle="db1">
    <rect x="560" y="95" width="200" height="100" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="660" y="126" text-anchor="middle" class="d-actor-label" font-size="12">Database</text>
    <text x="660" y="144" text-anchor="middle" class="d-label-muted" font-size="9">query_counts</text>
    <text x="660" y="159" text-anchor="middle" class="d-label-muted" font-size="9">indexed by query text</text>
  </g>
  <line id="a1-u-app" x1="162" y1="133" x2="256" y2="133" class="d-msg d-request" data-depends-on="app1" marker-end="url(#arrowA1)"></line>
  <line id="a1-app-u" x1="256" y1="160" x2="162" y2="160" class="d-msg d-response" data-depends-on="app1" marker-end="url(#arrowA1r)"></line>
  <line id="a1-app-db" x1="442" y1="133" x2="556" y2="133" class="d-msg d-request" data-depends-on="app1 db1" marker-end="url(#arrowA1)"></line>
  <line id="a1-db-app" x1="556" y1="160" x2="442" y2="160" class="d-msg d-response" data-depends-on="app1 db1" marker-end="url(#arrowA1r)"></line>
  <text x="390" y="282" text-anchor="middle" class="d-label-muted" font-size="10">play a four-letter prefix, then a single letter, then counting a popular search</text>
  <defs>
    <marker id="arrowA1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowA1r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "req", "title": "This request", "rows": [["prefix", "—"], ["rows read", "—"], ["shown after", "—"]]},
{"id": "db", "title": "Database", "rows": [["'weather' row", "—"], ["load", "—"]]}
],
"flows": [
{
"id": "pyth",
"label": "Suggestions for 'pyth'",
"nodes": ["app1", "db1"],
"steps": [
{"el": "a1-u-app", "payload": "GET /suggest?q=pyth", "set": {"req.prefix": "pyth", "req.rows read": "—", "req.shown after": "—", "db.'weather' row": "—", "db.load": "light"}, "text": "A user has typed pyth. The search box asks for suggestions."},
{"el": "a1-app-db", "payload": "LIKE 'pyth%' ORDER BY count DESC LIMIT 10", "text": "The app server asks the database for the ten most-searched queries starting with pyth. The index on the query text lets the database jump straight to the first query that starts with pyth."},
{"el": "a1-db-app", "payload": "python · python tutorial · python download …", "ms": 6, "set": {"req.rows read": "3,140"}, "text": "But the index is sorted by text, not by count. To find the ten most searched, the database reads every one of the 3,140 queries starting with pyth and sorts them by count. That takes 6ms."},
{"el": "a1-app-u", "payload": "10 suggestions", "set": {"req.shown after": "~20ms"}, "text": "The suggestions appear. For a prefix of four letters, this is fast enough."}
]
},
{
"id": "s",
"label": "One letter: 's'",
"nodes": ["app1", "db1"],
"steps": [
{"el": "a1-u-app", "payload": "GET /suggest?q=s", "set": {"req.prefix": "s", "req.rows read": "—", "req.shown after": "—", "db.'weather' row": "—", "db.load": "busy"}, "text": "Another user has typed one letter, s. Every search starting with s begins with this request."},
{"el": "a1-app-db", "payload": "LIKE 's%' ORDER BY count DESC LIMIT 10", "text": "The same query, for a much shorter prefix."},
{"el": "a1-db-app", "payload": "search · spotify · speed test …", "ms": 1400, "set": {"req.rows read": "2,100,000"}, "text": "2.1 million queries start with s. The database reads all of them and sorts them by count to find ten. That takes 1.4 seconds."},
{"el": "a1-app-u", "payload": "10 suggestions for 's'", "set": {"req.shown after": "~1.4s"}, "text": "By the time they arrive, the user has typed seven more letters and the list is useless. The shorter the prefix, the more queries match it, and every search starts with a short prefix. The most common requests are the most expensive ones."}
]
},
{
"id": "count",
"label": "Counting a popular search",
"nodes": ["app1", "db1"],
"steps": [
{"el": "a1-u-app", "payload": "search: weather", "set": {"req.prefix": "—", "req.rows read": "—", "req.shown after": "—", "db.'weather' row": "count 48,210,334", "db.load": "busy"}, "text": "A user submits a search for weather."},
{"el": "a1-app-db", "payload": "UPDATE … count = count + 1 WHERE query = 'weather'", "text": "The app server adds one to that query's count."},
{"el": "a1-db-app", "payload": "1 row changed", "ms": 2, "set": {"db.'weather' row": "~300 updates a second · each waits its turn"}, "text": "Each update locks the row while it changes it. At the morning peak, weather is searched about 300 times a second, so 300 updates a second line up for the same row, each waiting for the one before."},
{"el": "a1-app-u", "payload": "results for weather", "set": {"db.load": "25K writes/s + every keystroke"}, "text": "Across all queries that's 25,000 writes a second, on the same database that is reading millions of rows for every short prefix. Both jobs are done at request time, for every request: finding the top ten, and counting. Neither needs to be. The top ten for s changes slowly, and nobody needs a count accurate to the last search."}
]
}
]
}
</script>
<div class="diagram-caption">The app server finds the ten most-searched queries for a prefix with a LIKE query, and adds one to a query's count on every search, both in one database.</div>
</div>

<div class="fail-hint">Click the app server or the database to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="app1">
<strong>If the app server fails:</strong> no suggestions appear. Searches still work if they go through another server.
</div>
<div class="failure-impact is-hidden" data-component="db1">
<strong>If the database fails:</strong> no suggestions appear, and searches can't be counted while it's down. Those counts are lost.
</div>
</div>

Stage 1 does all its work at the moment of the request: it sorts millions of queries to answer one letter, and it updates a row for every search. Both can be done ahead of time. The ten best completions of every prefix can be worked out once and stored, and searches can be written to a log and counted later, in bulk.

<!-- stage:2:2. A Prebuilt Trie -->

## Stage 2 — A Tree of Prefixes, Built Every Night

- **Searches go to a log.** The search service appends one line per search to a log file: time, market, query, hashed user. Nothing is counted when the search happens.
- **An index builder runs every night.** At 02:00 it reads the last 28 days of log, scores each query by how often it was searched, with each day counting 10% less than the day after it, and drops queries searched by fewer than 50 different people.
- **The index is a tree of prefixes, called a trie.** Each node is a prefix. Its children are that prefix plus one more character: `ho` has children `hoa`, `hob`, … `how`. Every query ends at a node.
- **Every node stores its top 10.** The builder works up from the deepest nodes. A node's top 10 is the best 10 among its own query and its children's top 10s. So the top 10 for `s` is computed once a night, not once per keystroke.
- **Suggestion servers hold the whole index in memory.** A request walks one node per character of the prefix and returns the stored list. Every server has a full copy, so adding servers adds capacity ([Search & Indexing](#/systems/search-indexing)).
- **A new index is swapped in whole.** Each server loads the new file into spare memory while the old one keeps answering, then switches to it in one step.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 300" width="860" height="300" role="img" aria-label="Searches are appended to a search log; an index builder reads the log every night and writes an index snapshot; suggestion servers load the snapshot into memory and answer the search box from it">
  <rect x="20" y="160" width="120" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="186" text-anchor="middle" class="d-actor-label" font-size="12">Search Box</text>
  <text x="80" y="203" text-anchor="middle" class="d-label-muted" font-size="9">browser</text>
  <g data-fail-toggle="srch2">
    <rect x="200" y="20" width="180" height="64" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="290" y="47" text-anchor="middle" class="d-actor-label" font-size="12">Search Service</text>
    <text x="290" y="64" text-anchor="middle" class="d-label-muted" font-size="9">logs every search</text>
  </g>
  <g data-fail-toggle="log2">
    <rect x="660" y="20" width="180" height="64" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="750" y="47" text-anchor="middle" class="d-actor-label" font-size="12">Search Log</text>
    <text x="750" y="64" text-anchor="middle" class="d-label-muted" font-size="9">append-only · one file an hour</text>
  </g>
  <g data-fail-toggle="sug2">
    <rect x="200" y="140" width="180" height="100" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="290" y="170" text-anchor="middle" class="d-actor-label" font-size="12">Suggestion Servers</text>
    <text x="290" y="188" text-anchor="middle" class="d-label-muted" font-size="9">whole trie in memory</text>
    <text x="290" y="203" text-anchor="middle" class="d-label-muted" font-size="9">top 10 stored at every prefix</text>
  </g>
  <g data-fail-toggle="snap2">
    <rect x="430" y="150" width="170" height="80" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="515" y="180" text-anchor="middle" class="d-actor-label" font-size="12">Snapshot Store</text>
    <text x="515" y="198" text-anchor="middle" class="d-label-muted" font-size="9">index files · by date</text>
  </g>
  <g data-fail-toggle="bld2">
    <rect x="660" y="150" width="180" height="80" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="750" y="180" text-anchor="middle" class="d-actor-label" font-size="12">Index Builder</text>
    <text x="750" y="198" text-anchor="middle" class="d-label-muted" font-size="9">nightly · 02:00</text>
  </g>
  <line id="a2-u-srch" x1="100" y1="158" x2="196" y2="72" class="d-msg d-request" data-depends-on="srch2" marker-end="url(#arrowA2)"></line>
  <line id="a2-srch-log" x1="382" y1="52" x2="656" y2="52" class="d-msg d-request" data-depends-on="srch2 log2" marker-end="url(#arrowA2)"></line>
  <line id="a2-bld-log" x1="730" y1="148" x2="730" y2="88" class="d-msg d-request" data-depends-on="bld2 log2" marker-end="url(#arrowA2)"></line>
  <line id="a2-log-bld" x1="770" y1="88" x2="770" y2="148" class="d-msg d-response" data-depends-on="bld2 log2" marker-end="url(#arrowA2r)"></line>
  <line id="a2-bld-snap" x1="656" y1="190" x2="604" y2="190" class="d-msg d-request" data-depends-on="bld2 snap2" marker-end="url(#arrowA2)"></line>
  <line id="a2-sug-snap" x1="382" y1="175" x2="426" y2="175" class="d-msg d-request" data-depends-on="sug2 snap2" marker-end="url(#arrowA2)"></line>
  <line id="a2-snap-sug" x1="426" y1="205" x2="382" y2="205" class="d-msg d-response" data-depends-on="sug2 snap2" marker-end="url(#arrowA2r)"></line>
  <line id="a2-u-sug" x1="142" y1="178" x2="196" y2="178" class="d-msg d-request" data-depends-on="sug2" marker-end="url(#arrowA2)"></line>
  <line id="a2-sug-u" x1="196" y1="206" x2="142" y2="206" class="d-msg d-response" data-depends-on="sug2" marker-end="url(#arrowA2r)"></line>
  <text x="430" y="292" text-anchor="middle" class="d-label-muted" font-size="10">play typing a prefix, then a single letter, then the nightly rebuild</text>
  <defs>
    <marker id="arrowA2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowA2r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "req", "title": "This request", "rows": [["prefix", "—"], ["nodes walked", "—"], ["top 3", "—"]]},
{"id": "idx", "title": "Index", "rows": [["serving", "—"], ["built from", "—"]]}
],
"flows": [
{
"id": "howt",
"label": "Type 'how t'",
"nodes": ["sug2"],
"steps": [
{"el": "a2-u-sug", "payload": "GET /suggest?q=how t", "set": {"req.prefix": "how t", "req.nodes walked": "—", "req.top 3": "—", "idx.serving": "en-US.20261016", "idx.built from": "Sep 18 – Oct 15"}, "text": "A user has typed how t. The search box asks a suggestion server."},
{"el": "a2-sug-u", "payload": "how to tie a tie · how to screenshot on windows · …", "ms": 1, "set": {"req.nodes walked": "5: h → o → w → ␣ → t", "req.top 3": "how to tie a tie · how to screenshot on windows · how to train your dragon"}, "text": "The server walks five nodes, one per character, from the root to the node for how t, and returns the list stored there. Nothing is searched or sorted: the list was worked out last night. The whole lookup takes a few microseconds; the millisecond is the network inside the data centre."}
]
},
{
"id": "s",
"label": "One letter: 's'",
"nodes": ["sug2"],
"steps": [
{"el": "a2-u-sug", "payload": "GET /suggest?q=s", "set": {"req.prefix": "s", "req.nodes walked": "—", "req.top 3": "—", "idx.serving": "en-US.20261016", "idx.built from": "Sep 18 – Oct 15"}, "text": "Another user types s."},
{"el": "a2-sug-u", "payload": "search · spotify · speed test · …", "ms": 1, "set": {"req.nodes walked": "1: s", "req.top 3": "search · spotify · speed test"}, "text": "One node, one stored list. In Stage 1 this read 2.1 million rows and took 1.4 seconds. Here the builder did that work once, overnight, for every prefix at the same time, working up from the longest queries so each node's list is made from its children's lists. Now the shortest prefix is the cheapest to answer."}
]
},
{
"id": "rebuild",
"label": "The nightly rebuild",
"nodes": ["srch2", "log2", "bld2", "snap2", "sug2"],
"steps": [
{"el": "a2-u-srch", "payload": "search: weather", "set": {"req.prefix": "—", "req.nodes walked": "—", "req.top 3": "—", "idx.serving": "en-US.20261015", "idx.built from": "Sep 17 – Oct 14"}, "text": "During the day, a user searches for weather."},
{"el": "a2-srch-log", "payload": "14:05:11 · en-US · weather · 9f2c…", "text": "The search service appends one line to the current hour's log file. No count is updated, so a query searched 300 times a second costs 300 appended lines, not 300 updates to one row."},
{"el": "a2-bld-log", "payload": "02:00 · read the last 28 days", "text": "At 02:00 the index builder starts. It reads the last 28 days of the en-US log, about 10 billion lines."},
{"el": "a2-log-bld", "payload": "~400GB", "ms": 1800000, "text": "Spread over a cluster of machines, the read and the counting take about half an hour. Each query gets a score: its searches each day, with older days counting less. Queries searched by fewer than 50 different people are dropped, which leaves about 25 million."},
{"el": "a2-bld-snap", "payload": "en-US.20261016.idx · 9GB", "set": {"idx.built from": "Sep 18 – Oct 15"}, "text": "It builds the trie, fills in every node's top 10 from the deepest nodes upwards, and writes the result as one file, named by date."},
{"el": "a2-sug-snap", "payload": "new version?", "text": "Each suggestion server checks for a new version every few minutes, and finds one."},
{"el": "a2-snap-sug", "payload": "9GB", "ms": 120000, "set": {"idx.serving": "en-US.20261016"}, "text": "It downloads the file and loads it into spare memory, while the old index keeps answering. When the new one is fully loaded, the server switches to it in one step and frees the old. No request ever sees half an index. The servers change over one at a time, so for a few minutes some answer from yesterday's index and some from today's."},
{"el": "a2-u-sug", "payload": "GET /suggest?q=weath", "text": "The next morning, a user types weath."},
{"el": "a2-sug-u", "payload": "weather · weather tomorrow · weather radar", "ms": 1, "set": {"req.prefix": "weath", "req.nodes walked": "5", "req.top 3": "weather · weather tomorrow · weather radar"}, "text": "Answered from the new index, with yesterday's searches counted."}
]
}
]
}
</script>
<div class="diagram-caption">Searches are appended to a log. Each night an index builder reads 28 days of it, builds a trie with the top 10 stored at every prefix, and writes it as a file. Suggestion servers load the whole file into memory, and answer every request by walking one node per character.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="srch2">
<strong>If the search service fails:</strong> searches fail, which is the search system's problem. Suggestions keep working from the index already loaded.
</div>
<div class="failure-impact is-hidden" data-component="log2">
<strong>If the search log fails:</strong> the search service buffers lines for a while, then drops them. Tomorrow's index is built from slightly fewer searches, which barely changes it.
</div>
<div class="failure-impact is-hidden" data-component="sug2">
<strong>If a suggestion server fails:</strong> the others answer its requests. A replacement needs a few minutes to load 9GB before it can serve.
</div>
<div class="failure-impact is-hidden" data-component="snap2">
<strong>If the snapshot store fails:</strong> servers keep the index they have. New servers can't start until it's back, which matters if many are lost at once.
</div>
<div class="failure-impact is-hidden" data-component="bld2">
<strong>If the index builder fails:</strong> no new index tonight. Servers keep yesterday's, a day staler. An alert fires if the newest index is more than 36 hours old.
</div>
</div>

Answering is now a few microseconds of work for any prefix. The server isn't the problem any more; everything around it is. Sending a request for every keystroke is up to 350,000 requests a second at peak, most for prefixes the user has typed past before the answer arrives. And the servers are in one region. A user in Sydney is 180ms away, so the list for `ho` arrives after they've typed `how t`, and sometimes after the list for a later prefix, which it then replaces.

<!-- stage:3:3. Fewer Requests, Closer -->

## Stage 3 — Fewer Requests, Answered Closer to the User

- **Wait for a pause.** The search box sends a request only when typing pauses for 80ms. A fast typist's `h`, `o`, `w` becomes one request for `how`. That cuts about 15 requests per search to about 6.
- **The browser keeps answers.** Responses say `Cache-Control: public, max-age=3600`. Pressing backspace, or typing the same prefix again, is answered from the browser at once.
- **Edges near the user keep them too.** Requests go to the nearest edge of a CDN, which caches answers by market and prefix. Short prefixes are a small set that everyone types, so nearly all of them are answered at the edge ([CDN & Edge Delivery](#/systems/cdn-edge-delivery)).
- **Servers in three regions.** Virginia, Frankfurt and Singapore. An edge that doesn't have an answer asks the nearest region.
- **Late answers are dropped.** Each answer names its prefix, and the search box shows it only if that's still what's in the box. A late answer is kept in the browser cache in case the user backspaces to it.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 280" width="860" height="280" role="img" aria-label="The search box sends a request after a pause in typing; the browser cache answers it if it can, then the nearest CDN edge, then suggestion servers in the nearest of three regions">
  <rect x="20" y="95" width="130" height="90" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="85" y="126" text-anchor="middle" class="d-actor-label" font-size="12">Search Box</text>
  <text x="85" y="144" text-anchor="middle" class="d-label-muted" font-size="9">sends after 80ms pause</text>
  <text x="85" y="159" text-anchor="middle" class="d-label-muted" font-size="9">shows matching prefix only</text>
  <rect x="210" y="95" width="140" height="90" rx="6" class="d-actor-box" data-role="cache"></rect>
  <text x="280" y="126" text-anchor="middle" class="d-actor-label" font-size="12">Browser Cache</text>
  <text x="280" y="144" text-anchor="middle" class="d-label-muted" font-size="9">answers kept 1 hour</text>
  <g data-fail-toggle="cdn3">
    <rect x="410" y="95" width="170" height="90" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="495" y="126" text-anchor="middle" class="d-actor-label" font-size="12">CDN Edge</text>
    <text x="495" y="144" text-anchor="middle" class="d-label-muted" font-size="9">near the user · Sydney</text>
    <text x="495" y="159" text-anchor="middle" class="d-label-muted" font-size="9">keyed by market + prefix</text>
  </g>
  <g data-fail-toggle="sug3">
    <rect x="640" y="95" width="200" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="740" y="126" text-anchor="middle" class="d-actor-label" font-size="12">Suggestion Servers</text>
    <text x="740" y="144" text-anchor="middle" class="d-label-muted" font-size="9">3 regions · nearest answers</text>
    <text x="740" y="159" text-anchor="middle" class="d-label-muted" font-size="9">trie in memory</text>
  </g>
  <line id="a3-box-bc" x1="152" y1="125" x2="206" y2="125" class="d-msg d-request" marker-end="url(#arrowA3)"></line>
  <line id="a3-bc-box" x1="206" y1="158" x2="152" y2="158" class="d-msg d-response" marker-end="url(#arrowA3r)"></line>
  <line id="a3-bc-cdn" x1="352" y1="125" x2="406" y2="125" class="d-msg d-request" data-depends-on="cdn3" marker-end="url(#arrowA3)"></line>
  <line id="a3-cdn-bc" x1="406" y1="158" x2="352" y2="158" class="d-msg d-response" data-depends-on="cdn3" marker-end="url(#arrowA3r)"></line>
  <line id="a3-cdn-sug" x1="582" y1="125" x2="636" y2="125" class="d-msg d-request" data-depends-on="cdn3 sug3" marker-end="url(#arrowA3)"></line>
  <line id="a3-sug-cdn" x1="636" y1="158" x2="582" y2="158" class="d-msg d-response" data-depends-on="cdn3 sug3" marker-end="url(#arrowA3r)"></line>
  <text x="430" y="230" text-anchor="middle" class="d-label-muted" font-size="10">latency figures in this stage include the trip from Sydney, since distance is what this stage removes</text>
  <text x="430" y="272" text-anchor="middle" class="d-label-muted" font-size="10">play typing in Sydney, then a late answer and a backspace, then the peak, layer by layer</text>
  <defs>
    <marker id="arrowA3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowA3r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "box", "title": "Search box", "rows": [["typed", "—"], ["showing", "—"]]},
{"id": "req", "title": "Requests", "rows": [["sent for this search", "—"], ["last answered by", "—"]]}
],
"flows": [
{
"id": "sydney",
"label": "Typing in Sydney",
"nodes": ["cdn3", "sug3"],
"steps": [
{"el": "a3-box-bc", "payload": "GET q=how", "set": {"box.typed": "how", "box.showing": "—", "req.sent for this search": "1 (not 3)", "req.last answered by": "—"}, "text": "A user in Sydney types h, o, w, about 70ms apart, then pauses. Only after 80ms of no typing does the search box send a request: one for how, instead of three."},
{"el": "a3-bc-cdn", "payload": "GET q=how · not in browser cache", "text": "The browser hasn't seen how before, so the request goes to the nearest CDN edge, in Sydney."},
{"el": "a3-cdn-bc", "payload": "how to tie a tie · how old is … · how many …", "ms": 20, "set": {"req.last answered by": "CDN edge · Sydney"}, "text": "Hundreds of people in Australia typed how in the last hour, so the edge has the answer. It comes back in 20ms, instead of 180ms from Virginia."},
{"el": "a3-bc-box", "payload": "prefix 'how' = what's typed → show", "set": {"box.showing": "suggestions for how"}, "text": "The answer's prefix is how, and so is the box. It's shown."},
{"el": "a3-box-bc", "payload": "GET q=how to tie a b", "set": {"box.typed": "how to tie a b", "req.sent for this search": "4"}, "text": "The user keeps typing. Three pauses later, the box has how to tie a b."},
{"el": "a3-bc-cdn", "payload": "GET q=how to tie a b", "text": "Not in the browser cache."},
{"el": "a3-cdn-sug", "payload": "edge miss → Singapore", "text": "Fewer people type this long a prefix, and the edge hasn't kept it. It asks the nearest region with suggestion servers, Singapore."},
{"el": "a3-sug-cdn", "payload": "how to tie a bow tie · how to tie a bowline", "ms": 95, "text": "The server answers in a millisecond. Most of the 95ms is the trip between Sydney and Singapore. The edge keeps the answer for the next person."},
{"el": "a3-cdn-bc", "payload": "suggestions for 'how to tie a b'", "ms": 20, "text": "Back to the browser, which keeps a copy as well."},
{"el": "a3-bc-box", "payload": "show", "set": {"box.showing": "suggestions for how to tie a b", "req.last answered by": "Singapore · via edge"}, "text": "The user picks how to tie a bow tie. Four requests for this search, not fourteen, and none of them crossed the Pacific to Virginia."}
]
},
{
"id": "late",
"label": "A late answer and a backspace",
"nodes": ["cdn3", "sug3"],
"steps": [
{"el": "a3-box-bc", "payload": "GET q=how to t", "set": {"box.typed": "how to t", "box.showing": "suggestions for how to", "req.sent for this search": "3", "req.last answered by": "—"}, "text": "The box has how to t. A request goes out."},
{"el": "a3-bc-cdn", "payload": "GET q=how to t", "text": "Not in the browser cache."},
{"el": "a3-cdn-sug", "payload": "edge miss → Singapore", "text": "Not at the edge either. It goes to Singapore."},
{"el": "a3-box-bc", "payload": "GET q=how to tie", "set": {"box.typed": "how to tie", "req.sent for this search": "4"}, "text": "While that's on its way, the user types i, e and pauses. A second request goes out, for how to tie."},
{"el": "a3-bc-cdn", "payload": "GET q=how to tie", "text": "Also not in the browser."},
{"el": "a3-cdn-bc", "payload": "suggestions for 'how to tie'", "ms": 20, "text": "But how to tie is popular, and the edge has it. The second request is answered first."},
{"el": "a3-bc-box", "payload": "prefix 'how to tie' = what's typed → show", "set": {"box.showing": "suggestions for how to tie", "req.last answered by": "CDN edge · Sydney"}, "text": "Shown."},
{"el": "a3-sug-cdn", "payload": "suggestions for 'how to t'", "ms": 75, "text": "Now the answer to the first request arrives from Singapore."},
{"el": "a3-cdn-bc", "payload": "suggestions for 'how to t'", "ms": 20, "text": "The browser caches it."},
{"el": "a3-bc-box", "payload": "prefix 'how to t' ≠ 'how to tie' → drop", "text": "The answer says its prefix is how to t, but the box says how to tie. The search box ignores it. Without the prefix in the answer, this late list would have replaced the right one."},
{"el": "a3-box-bc", "payload": "backspace × 2 → GET q=how to t", "set": {"box.typed": "how to t"}, "text": "The user changes their mind and deletes ie."},
{"el": "a3-bc-box", "payload": "from browser cache", "set": {"box.showing": "suggestions for how to t", "req.last answered by": "browser cache"}, "text": "The answer that was dropped a moment ago is in the browser cache. It's shown at once, with no request at all."}
]
},
{
"id": "peak",
"label": "The peak, layer by layer",
"nodes": ["cdn3", "sug3"],
"steps": [
{"el": "a3-box-bc", "payload": "~350K keystrokes/s", "set": {"box.typed": "—", "box.showing": "—", "req.sent for this search": "~6 a search", "req.last answered by": "—"}, "text": "At the evening peak, users across all markets press about 350,000 keys a second. Waiting for an 80ms pause turns those into about 140,000 requests a second."},
{"el": "a3-bc-box", "payload": "~30K/s answered by the browser", "text": "About 30,000 a second are prefixes this browser already has: backspaces, corrections, and searches the user repeats."},
{"el": "a3-bc-cdn", "payload": "~110K/s to the edges", "text": "About 110,000 a second reach CDN edges around the world."},
{"el": "a3-cdn-bc", "payload": "~60K/s answered at the edge", "text": "Prefixes of one or two characters are about 1,500 entries per market, typed by everyone, and almost always cached. Popular longer prefixes, like how to, are cached too. A little over half the requests stop here."},
{"el": "a3-cdn-sug", "payload": "~50K/s to the servers", "text": "About 50,000 a second reach the suggestion servers, split across three regions. Each server can answer tens of thousands a second from memory, so a handful per region are enough, with spares for failures."},
{"el": "a3-sug-cdn", "payload": "answers · max-age 3600", "ms": 1, "set": {"req.last answered by": "the nearest region"}, "text": "Every answer can be cached for an hour, because the index only changes once a night. That's what makes the caches work so well, and it's about to become the problem."}
]
}
]
}
</script>
<div class="diagram-caption">The search box waits for a pause before asking. The browser cache, then a CDN edge near the user, answer what they can. Suggestion servers in the nearest of three regions answer the rest. Answers name their prefix, so a late one is never shown over a newer one.</div>
</div>

<div class="fail-hint">Click the CDN edge or the suggestion servers to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="cdn3">
<strong>If a CDN edge fails:</strong> its users are sent to the next nearest edge, a little slower. If the CDN fails everywhere, all requests reach the servers, about three times the usual load. The regions are sized to survive that for a while by shedding the slowest prefixes first.
</div>
<div class="failure-impact is-hidden" data-component="sug3">
<strong>If a region's suggestion servers fail:</strong> edges send their misses to the next nearest region, and those users wait longer. Cached prefixes are still answered at the edge as before.
</div>
</div>

Suggestions now arrive within 100ms almost everywhere, and the servers see a seventh of the keystrokes. But everything is built once a night, and cached for an hour on top of that. At 14:02 an earthquake shakes a large city. Within minutes, hundreds of thousands of people type `earthquake`. When they type `ear`, the list shows `earrings`, `ear infection` and `earbuds`, and it will until tomorrow's index is built at 02:00, twelve hours later. The suggestions only know what people searched for yesterday.

<!-- stage:4:4. Trending Queries -->

## Stage 4 — Trending Queries, Within Minutes

- **Searches also go onto a stream.** As well as the hourly files, every search goes onto a log stream, split into partitions by query, so all searches for one query reach the same worker ([Log-Based Systems](#/systems/log-based-systems)).
- **Trend counters compare now with usual.** For each query, a worker counts searches and distinct users in one-minute buckets over the last 10 minutes. It compares that with the query's usual rate at this hour of the week, from the last 7 days.
- **A query trends when it's far above usual.** At least 10 times its usual rate, and searched by at least 200 different people in 10 minutes. Each market's trending set is a few hundred queries.
- **The trending set is pushed to every server every 30 seconds.** Servers keep it in a small trie of its own.
- **Answers merge both at serve time.** The server takes the stored top 10 and any trending queries that match the prefix, scores them on one scale, and returns the best 10. A trending query can take at most 3 of the 10 places.
- **Edge caching drops to 60 seconds.** Popular prefixes are typed thousands of times a minute, so they still come from the edge, but no answer is more than a minute old.
- **A block list removes suggestions at once.** Blocks are pushed to every server with the trending set, filtered out of every answer, and purged from the edges.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 370" width="860" height="370" role="img" aria-label="Searches go from the search service onto a search stream read by trend counters, which push a trending set to the suggestion servers every 30 seconds; a block list is also pushed to the servers and purges the CDN edge; the search box asks the CDN edge, which asks the suggestion servers">
  <rect x="20" y="210" width="120" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="236" text-anchor="middle" class="d-actor-label" font-size="12">Search Box</text>
  <text x="80" y="253" text-anchor="middle" class="d-label-muted" font-size="9">browser</text>
  <g data-fail-toggle="srch4">
    <rect x="200" y="30" width="170" height="64" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="285" y="57" text-anchor="middle" class="d-actor-label" font-size="12">Search Service</text>
    <text x="285" y="74" text-anchor="middle" class="d-label-muted" font-size="9">files + stream</text>
  </g>
  <g data-fail-toggle="str4">
    <rect x="430" y="30" width="170" height="64" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="515" y="57" text-anchor="middle" class="d-actor-label" font-size="12">Search Stream</text>
    <text x="515" y="74" text-anchor="middle" class="d-label-muted" font-size="9">partitioned by query</text>
  </g>
  <g data-fail-toggle="trd4">
    <rect x="660" y="30" width="180" height="64" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="750" y="57" text-anchor="middle" class="d-actor-label" font-size="12">Trend Counters</text>
    <text x="750" y="74" text-anchor="middle" class="d-label-muted" font-size="9">last 10 min vs usual</text>
  </g>
  <g data-fail-toggle="cdn4">
    <rect x="200" y="200" width="170" height="80" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="285" y="230" text-anchor="middle" class="d-actor-label" font-size="12">CDN Edge</text>
    <text x="285" y="248" text-anchor="middle" class="d-label-muted" font-size="9">answers kept 60 s</text>
  </g>
  <g data-fail-toggle="sug4">
    <rect x="430" y="190" width="170" height="100" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="515" y="220" text-anchor="middle" class="d-actor-label" font-size="12">Suggestion Servers</text>
    <text x="515" y="238" text-anchor="middle" class="d-label-muted" font-size="9">nightly trie + trending</text>
    <text x="515" y="253" text-anchor="middle" class="d-label-muted" font-size="9">merged · blocks filtered</text>
  </g>
  <g data-fail-toggle="blk4">
    <rect x="660" y="215" width="180" height="64" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="750" y="242" text-anchor="middle" class="d-actor-label" font-size="12">Block List</text>
    <text x="750" y="259" text-anchor="middle" class="d-label-muted" font-size="9">edited by people</text>
  </g>
  <line id="a4-u-srch" x1="95" y1="208" x2="220" y2="98" class="d-msg d-request" data-depends-on="srch4" marker-end="url(#arrowA4)"></line>
  <line id="a4-srch-str" x1="372" y1="62" x2="426" y2="62" class="d-msg d-request" data-depends-on="srch4 str4" marker-end="url(#arrowA4)"></line>
  <line id="a4-str-trd" x1="602" y1="62" x2="656" y2="62" class="d-msg d-request" data-depends-on="str4 trd4" marker-end="url(#arrowA4)"></line>
  <path id="a4-trd-sug" d="M750,96 L750,150 L560,150 L560,186" class="d-msg d-request" data-depends-on="trd4 sug4" marker-end="url(#arrowA4)"></path>
  <line id="a4-blk-sug" x1="656" y1="247" x2="604" y2="247" class="d-msg d-request" data-depends-on="blk4 sug4" marker-end="url(#arrowA4)"></line>
  <path id="a4-blk-cdn" d="M750,281 L750,320 L285,320 L285,284" class="d-msg d-request" data-depends-on="blk4 cdn4" marker-end="url(#arrowA4)"></path>
  <line id="a4-u-cdn" x1="142" y1="228" x2="196" y2="228" class="d-msg d-request" data-depends-on="cdn4" marker-end="url(#arrowA4)"></line>
  <line id="a4-cdn-u" x1="196" y1="256" x2="142" y2="256" class="d-msg d-response" data-depends-on="cdn4" marker-end="url(#arrowA4r)"></line>
  <line id="a4-cdn-sug" x1="372" y1="228" x2="426" y2="228" class="d-msg d-request" data-depends-on="cdn4 sug4" marker-end="url(#arrowA4)"></line>
  <line id="a4-sug-cdn" x1="426" y1="256" x2="372" y2="256" class="d-msg d-response" data-depends-on="cdn4 sug4" marker-end="url(#arrowA4r)"></line>
  <text x="430" y="358" text-anchor="middle" class="d-label-muted" font-size="10">play breaking news, then a false rumour taken down, then a script that searches one phrase all day</text>
  <defs>
    <marker id="arrowA4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowA4r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "trd", "title": "Trend counters · en-US", "rows": [["query", "—"], ["last 10 min", "—"], ["trending?", "—"]]},
{"id": "list", "title": "Suggestions shown", "rows": [["#1", "—"], ["#2", "—"], ["#3", "—"]]}
],
"flows": [
{
"id": "news",
"label": "Breaking news",
"nodes": ["srch4", "str4", "trd4", "cdn4", "sug4"],
"steps": [
{"el": "a4-u-srch", "payload": "search: earthquake today", "set": {"trd.query": "earthquake today", "trd.last 10 min": "usually ~3", "trd.trending?": "no", "list.#1": "earrings", "list.#2": "ear infection", "list.#3": "earbuds"}, "text": "At 14:02 an earthquake shakes a large city. People start searching earthquake today."},
{"el": "a4-srch-str", "payload": "earthquake today · 9f2c…", "text": "The search service writes each search to the hourly file, as before, and onto the search stream. The stream is split by query, so every search for earthquake today goes to the same partition."},
{"el": "a4-str-trd", "payload": "+1 · earthquake today", "set": {"trd.last 10 min": "4,800 searches · 3,900 people"}, "text": "The trend counter reading that partition adds each one to the current minute's bucket. By 14:04, the last 10 minutes hold 4,800 searches from 3,900 different people. Usually this query gets about 3 in 10 minutes at this hour."},
{"el": "a4-trd-sug", "payload": "trending · earthquake today · ×1,600", "ms": 30000, "set": {"trd.trending?": "yes · since 14:04"}, "text": "That's far over 10 times its usual rate, and far over 200 people, so it trends. At the next push, within 30 seconds, every suggestion server gets the new trending set."},
{"el": "a4-u-cdn", "payload": "GET q=ear · 14:05", "text": "At 14:05 a user types ear."},
{"el": "a4-cdn-sug", "payload": "cached answer is 60 s old → ask", "text": "The edge's answer for ear was cached at 14:04, before the push, and has just expired. It asks a server."},
{"el": "a4-sug-cdn", "payload": "earthquake today · earrings · ear infection …", "ms": 1, "set": {"list.#1": "earthquake today · trending", "list.#2": "earrings", "list.#3": "ear infection"}, "text": "The server takes the stored top 10 for ear and the trending queries starting with ear, and scores them together. A trending query's score comes from its rate over the last 10 minutes, so earthquake today, at hundreds of searches a minute, beats earrings. It goes first."},
{"el": "a4-cdn-u", "payload": "earthquake today · earrings · …", "ms": 20, "text": "Three minutes after people started searching, the search box suggests it. It will leave the trending set when its rate falls back, and by then tomorrow's nightly index will have counted it like any other query."}
]
},
{
"id": "block",
"label": "A false rumour taken down",
"nodes": ["str4", "trd4", "sug4", "blk4", "cdn4"],
"steps": [
{"el": "a4-str-trd", "payload": "acme bank collapse · ×300", "set": {"trd.query": "acme bank collapse", "trd.last 10 min": "2,400 searches · 2,100 people", "trd.trending?": "yes", "list.#1": "—", "list.#2": "—", "list.#3": "—"}, "text": "A false rumour spreads that Acme Bank is collapsing. Thousands of real people search for it, so it trends like any other query."},
{"el": "a4-trd-sug", "payload": "trending · acme bank collapse", "text": "It's pushed to every server."},
{"el": "a4-u-cdn", "payload": "GET q=acme", "text": "Now everyone who types acme, looking for their bank's login page, is shown the rumour. A suggestion looks like an endorsement, and this one could start a run on the bank."},
{"el": "a4-cdn-u", "payload": "acme bank collapse · acme bank login · …", "ms": 20, "set": {"list.#1": "acme bank collapse", "list.#2": "acme bank login", "list.#3": "acme hardware"}, "text": "The bank reports it. A reviewer agrees it's a false rumour about a real company."},
{"el": "a4-blk-sug", "payload": "block · acme bank collapse · exact", "ms": 30000, "text": "They add a block. It's pushed to every server with the next trending set, within 30 seconds. Each server now drops that query from every answer, whether it came from the trending set or the nightly index."},
{"el": "a4-blk-cdn", "payload": "purge a · ac · acm · … · acme bank collapse", "ms": 2000, "text": "The edges still have answers that include it, for up to 60 seconds. The block service purges every prefix of the query from the CDN: 18 purges, done in a couple of seconds."},
{"el": "a4-u-cdn", "payload": "GET q=acme", "text": "The next user types acme."},
{"el": "a4-cdn-sug", "payload": "purged → ask", "text": "The edge no longer has it, and asks a server."},
{"el": "a4-sug-cdn", "payload": "acme bank login · acme hardware · …", "ms": 1, "set": {"list.#1": "acme bank login", "list.#2": "acme hardware", "list.#3": "acme tools"}, "text": "The rumour is filtered out, and everything below it moves up one place. Tonight's nightly build reads the block list too, so it's never written into an index at all."},
{"el": "a4-cdn-u", "payload": "acme bank login · …", "ms": 20, "text": "Gone, about a minute after the block was made."}
]
},
{
"id": "script",
"label": "A script that searches one phrase all day",
"nodes": ["srch4", "str4", "trd4"],
"steps": [
{"el": "a4-u-srch", "payload": "search: cheap watches xyz-shop × 50,000", "set": {"trd.query": "cheap watches xyz-shop", "trd.last 10 min": "—", "trd.trending?": "no", "list.#1": "—", "list.#2": "—", "list.#3": "—"}, "text": "A spammer wants their shop suggested to everyone who types cheap. A script on 12 accounts searches cheap watches xyz-shop 50,000 times in 10 minutes."},
{"el": "a4-srch-str", "payload": "50,000 lines · 12 user hashes", "text": "Every search goes onto the stream like any other."},
{"el": "a4-str-trd", "payload": "count people, not searches", "set": {"trd.last 10 min": "50,000 searches · 12 people"}, "text": "But the trend counter counts each person at most 3 times per query per hour. 50,000 searches from 12 accounts count as 36."},
{"el": "a4-str-trd", "payload": "12 people < 200", "set": {"trd.trending?": "no · 12 people, needs 200"}, "text": "And a query needs 200 different people in 10 minutes to trend at all. It doesn't. The nightly build uses the same rule over 28 days: fewer than 50 different people and a query is never suggested. Searches are cheap to fake. Thousands of different real accounts are not."}
]
}
]
}
</script>
<div class="diagram-caption">Searches also go onto a stream, where trend counters compare each query's last 10 minutes with its usual rate. Queries far above usual are pushed to every server every 30 seconds, along with a block list, and merged with the nightly index on every request. Edges keep answers for 60 seconds.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="srch4">
<strong>If the search service fails:</strong> searches fail, which is the search system's problem. Suggestions carry on, with no new trends until searches resume.
</div>
<div class="failure-impact is-hidden" data-component="str4">
<strong>If the search stream fails:</strong> trends stop updating, and servers keep the last trending set they received. Suggestions fall back to the nightly index, as in Stage 3.
</div>
<div class="failure-impact is-hidden" data-component="trd4">
<strong>If a trend counter fails:</strong> another worker takes its partitions and reads the last 10 minutes back from the stream, which keeps a day of searches. Trends for those queries pause for a minute or two.
</div>
<div class="failure-impact is-hidden" data-component="cdn4">
<strong>If a CDN edge fails:</strong> users are sent to the next nearest edge. With 60-second caching, the servers see a little more load than in Stage 3 either way.
</div>
<div class="failure-impact is-hidden" data-component="sug4">
<strong>If a region's suggestion servers fail:</strong> edges ask the next nearest region, as in Stage 3. A replacement server loads the nightly index, then asks for the current trending set and block list before it serves.
</div>
<div class="failure-impact is-hidden" data-component="blk4">
<strong>If the block list fails:</strong> no new blocks can be made, but every server keeps the list it has, so nothing already blocked comes back. A server never serves without a block list: one that starts with no copy refuses to answer until it gets one.
</div>
</div>

Suggestions now catch up with the news in minutes. All of it still comes from one index, for one market, that every server holds in full. The service runs in 30 markets, though, and together their indexes are about 70GB. Holding every market on every server needs 150GB of memory, counting the second copy during each nightly swap. Meanwhile the `en-US` index is growing as it keeps more of the long tail of queries, and a single file that every server must download and load takes longer every night. The index needs to be split.

<!-- stage:5:5. Shards by Market and Prefix -->

## Stage 5 — Split by Market, Then by Prefix

- **Each market is its own index.** Small markets get one shard, with three copies, sized to their traffic. A surge in one country only needs more servers for that country.
- **Big markets are split by prefix range.** `en-US` is cut into 8 ranges of the alphabet, such as `sa` to `sm`, chosen so each has about the same traffic and size. Ranges are cut only between three-character prefixes, so every prefix of three or more characters belongs to exactly one shard ([Partitioning & Sharding](#/systems/partitioning-sharding)).
- **Short prefixes are on every shard.** The 1,500 prefixes of one or two characters span several ranges, so they get a small table of their own, copied to every shard. The builder fills it by merging each shard's top 10 for those prefixes.
- **A router sends each request to its shard.** It reads the market and prefix, looks the range up in the shard map, and picks a healthy copy. A short prefix can go to any shard.
- **The builder builds shards in parallel.** It counts once, splits queries by range, and builds each shard's file separately. A server loads only its shard, about 1.2GB.
- **A shard that's down returns an empty list.** The router answers at once rather than waiting, and the search box carries on without suggestions for those prefixes.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 370" width="860" height="370" role="img" aria-label="The search box asks the CDN edge, which asks a router; the router sends each request to the shard that owns its market and prefix range: two en-US shards split by prefix, and one shard for en-GB">
  <rect x="20" y="155" width="120" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="181" text-anchor="middle" class="d-actor-label" font-size="12">Search Box</text>
  <text x="80" y="198" text-anchor="middle" class="d-label-muted" font-size="9">browser</text>
  <g data-fail-toggle="cdn5">
    <rect x="190" y="145" width="140" height="80" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="260" y="175" text-anchor="middle" class="d-actor-label" font-size="12">CDN Edge</text>
    <text x="260" y="193" text-anchor="middle" class="d-label-muted" font-size="9">answers kept 60 s</text>
  </g>
  <g data-fail-toggle="rt5">
    <rect x="380" y="130" width="160" height="110" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="460" y="160" text-anchor="middle" class="d-actor-label" font-size="12">Router</text>
    <text x="460" y="178" text-anchor="middle" class="d-label-muted" font-size="9">market + prefix → shard</text>
    <text x="460" y="193" text-anchor="middle" class="d-label-muted" font-size="9">short prefix → any shard</text>
    <text x="460" y="208" text-anchor="middle" class="d-label-muted" font-size="9">down → empty list</text>
  </g>
  <g data-fail-toggle="s4">
    <rect x="620" y="20" width="220" height="80" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="730" y="48" text-anchor="middle" class="d-actor-label" font-size="12">en-US · shard 4</text>
    <text x="730" y="66" text-anchor="middle" class="d-label-muted" font-size="9">prefixes 'sa' to 'sm' · 3 copies</text>
    <text x="730" y="81" text-anchor="middle" class="d-label-muted" font-size="9">+ short-prefix table</text>
  </g>
  <g data-fail-toggle="s5">
    <rect x="620" y="145" width="220" height="80" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="730" y="173" text-anchor="middle" class="d-actor-label" font-size="12">en-US · shard 5</text>
    <text x="730" y="191" text-anchor="middle" class="d-label-muted" font-size="9">prefixes 'sn' to 'tg' · 3 copies</text>
    <text x="730" y="206" text-anchor="middle" class="d-label-muted" font-size="9">+ short-prefix table</text>
  </g>
  <g data-fail-toggle="gb5">
    <rect x="620" y="270" width="220" height="80" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="730" y="298" text-anchor="middle" class="d-actor-label" font-size="12">en-GB · one shard</text>
    <text x="730" y="316" text-anchor="middle" class="d-label-muted" font-size="9">whole market · 3 copies</text>
  </g>
  <line id="a5-u-cdn" x1="142" y1="173" x2="186" y2="173" class="d-msg d-request" data-depends-on="cdn5" marker-end="url(#arrowA5)"></line>
  <line id="a5-cdn-u" x1="186" y1="200" x2="142" y2="200" class="d-msg d-response" data-depends-on="cdn5" marker-end="url(#arrowA5r)"></line>
  <line id="a5-cdn-rt" x1="332" y1="173" x2="376" y2="173" class="d-msg d-request" data-depends-on="cdn5 rt5" marker-end="url(#arrowA5)"></line>
  <line id="a5-rt-cdn" x1="376" y1="200" x2="332" y2="200" class="d-msg d-response" data-depends-on="cdn5 rt5" marker-end="url(#arrowA5r)"></line>
  <line id="a5-rt-s4" x1="542" y1="145" x2="616" y2="60" class="d-msg d-request" data-depends-on="rt5 s4" marker-end="url(#arrowA5)"></line>
  <line id="a5-s4-rt" x1="616" y1="85" x2="542" y2="165" class="d-msg d-response" data-depends-on="rt5 s4" marker-end="url(#arrowA5r)"></line>
  <line id="a5-rt-s5" x1="542" y1="178" x2="616" y2="178" class="d-msg d-request" data-depends-on="rt5 s5" marker-end="url(#arrowA5)"></line>
  <line id="a5-s5-rt" x1="616" y1="200" x2="542" y2="200" class="d-msg d-response" data-depends-on="rt5 s5" marker-end="url(#arrowA5r)"></line>
  <line id="a5-rt-gb" x1="542" y1="215" x2="616" y2="295" class="d-msg d-request" data-depends-on="rt5 gb5" marker-end="url(#arrowA5)"></line>
  <line id="a5-gb-rt" x1="616" y1="320" x2="542" y2="235" class="d-msg d-response" data-depends-on="rt5 gb5" marker-end="url(#arrowA5r)"></line>
  <text x="430" y="362" text-anchor="middle" class="d-label-muted" font-size="10">play a three-letter prefix, then a single letter, then the same prefix in two markets</text>
  <defs>
    <marker id="arrowA5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowA5r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "rt", "title": "Router", "rows": [["request", "—"], ["rule", "—"], ["sent to", "—"]]},
{"id": "ans", "title": "Answer", "rows": [["top 3", "—"]]}
],
"flows": [
{
"id": "sea",
"label": "A three-letter prefix",
"nodes": ["cdn5", "rt5", "s4"],
"steps": [
{"el": "a5-u-cdn", "payload": "GET market=en-US&q=sea", "set": {"rt.request": "en-US · sea", "rt.rule": "—", "rt.sent to": "—", "ans.top 3": "—"}, "text": "A user in the US types sea."},
{"el": "a5-cdn-rt", "payload": "edge miss", "text": "The edge doesn't have it. It asks the router in the nearest region."},
{"el": "a5-rt-s4", "payload": "en-US · 'sea' is in 'sa' to 'sm'", "set": {"rt.rule": "3+ characters → its range", "rt.sent to": "en-US shard 4"}, "altEl": "a5-rt-cdn", "altText": "Shard 4 has no healthy copy. The router doesn't wait for a timeout: it answers at once with an empty list and a 5-second cache time. The user sees no suggestions for prefixes in 'sa' to 'sm' and can still search. Every other range is unaffected.", "altSet": {"rt.sent to": "none · shard 4 down", "ans.top 3": "(empty)"}, "text": "The router looks up en-US in the shard map. The prefix sea falls in the range sa to sm, which is shard 4. Every query starting with sea is in that shard, because ranges are only cut between three-character prefixes. It picks one of shard 4's three copies."},
{"el": "a5-s4-rt", "payload": "seahawks · sears · sea of thieves", "ms": 1, "set": {"ans.top 3": "seahawks · sears · sea of thieves"}, "text": "Shard 4 walks its trie, exactly as one big server did in Stage 2, and merges in any trending queries in its range."},
{"el": "a5-rt-cdn", "payload": "suggestions for 'sea'", "ms": 1, "text": "Back to the edge, which keeps it for 60 seconds."},
{"el": "a5-cdn-u", "payload": "seahawks · sears · …", "ms": 20, "text": "The user never knows the index is split. The router adds a millisecond."}
]
},
{
"id": "s",
"label": "A single letter",
"nodes": ["cdn5", "rt5", "s4", "s5"],
"steps": [
{"el": "a5-u-cdn", "payload": "GET market=en-US&q=s", "set": {"rt.request": "en-US · s", "rt.rule": "—", "rt.sent to": "—", "ans.top 3": "—"}, "text": "A user types s. This is nearly always answered at the edge. Suppose the edge's copy has just expired."},
{"el": "a5-cdn-rt", "payload": "edge miss", "text": "The edge asks the router."},
{"el": "a5-rt-s4", "payload": "short prefix → any en-US shard", "set": {"rt.rule": "1–2 characters → any shard", "rt.sent to": "en-US shard 4"}, "altEl": "a5-rt-s5", "altText": "Shard 4 is down, so the router sends it to shard 5 instead. Every shard holds the short-prefix table, so any of them can answer s.", "altSet": {"rt.sent to": "en-US shard 5"}, "text": "Queries starting with s are spread over shards 4 and 5, so neither shard's own trie knows the top 10 for s. But every shard holds a small table of all 1,500 one- and two-character prefixes, so the router sends it to any healthy shard."},
{"el": "a5-s4-rt", "payload": "search · spotify · speed test", "ms": 1, "altEl": "a5-s5-rt", "set": {"ans.top 3": "search · spotify · speed test"}, "text": "The builder made that table by taking each shard's top 10 for s and keeping the best 10 overall. The best 10 overall must be among them, since every query starting with s is in one of those shards."},
{"el": "a5-rt-cdn", "payload": "suggestions for 's'", "ms": 1, "text": "Back to the edge."},
{"el": "a5-cdn-u", "payload": "search · spotify · …", "ms": 20, "text": "The prefixes everyone types can be answered by any shard, and the rest each by exactly one."}
]
},
{
"id": "markets",
"label": "The same prefix in two markets",
"nodes": ["cdn5", "rt5", "s5", "gb5"],
"steps": [
{"el": "a5-u-cdn", "payload": "GET market=en-GB&q=sup", "set": {"rt.request": "en-GB · sup", "rt.rule": "—", "rt.sent to": "—", "ans.top 3": "—"}, "text": "A user in London types sup."},
{"el": "a5-cdn-rt", "payload": "edge miss", "text": "The edge in London asks the router. The market is part of the cache key, so a user in New York typing sup never gets London's answer."},
{"el": "a5-rt-gb", "payload": "en-GB → its one shard", "set": {"rt.rule": "small market → one shard", "rt.sent to": "en-GB"}, "text": "en-GB is small enough for one shard, with three copies."},
{"el": "a5-gb-rt", "payload": "superdrug · super league · supermarkets near me", "ms": 1, "set": {"ans.top 3": "superdrug · super league · supermarkets near me"}, "text": "The en-GB shard answers from searches made in the UK."},
{"el": "a5-rt-cdn", "payload": "suggestions for 'sup' · en-GB", "ms": 1, "text": "Back to the edge in London."},
{"el": "a5-u-cdn", "payload": "GET market=en-US&q=sup", "set": {"rt.request": "en-US · sup"}, "text": "A user in New York types the same four letters."},
{"el": "a5-cdn-rt", "payload": "edge miss · different key", "text": "A different market, so a different cache entry."},
{"el": "a5-rt-s5", "payload": "en-US · 'sup' is in 'sn' to 'tg'", "set": {"rt.rule": "3+ characters → its range", "rt.sent to": "en-US shard 5"}, "text": "In en-US, sup falls in the range sn to tg, which is shard 5. Each market has its own shards, built from its own searches, and is sized and scaled on its own: a World Cup final in London adds en-GB copies without touching en-US."},
{"el": "a5-s5-rt", "payload": "super bowl · supreme court · superman", "ms": 1, "set": {"ans.top 3": "super bowl · supreme court · superman"}, "text": "Different searches, different suggestions."},
{"el": "a5-rt-cdn", "payload": "suggestions for 'sup' · en-US", "ms": 1, "text": "Back to the edge."},
{"el": "a5-cdn-u", "payload": "super bowl · supreme court · …", "ms": 20, "text": "Each server holds about 1.2GB, the size of one shard, and loads it in seconds. Adding a market adds shards, not memory on every server."}
]
}
]
}
</script>
<div class="diagram-caption">Each market has its own shards. Big markets are split into prefix ranges, cut only between three-character prefixes, and every shard also holds the top 10 for all one- and two-character prefixes. A router sends each request to its shard, or answers at once with an empty list if that shard is down.</div>
</div>

<div class="fail-hint">Click the CDN edge, the router or any shard to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="cdn5">
<strong>If a CDN edge fails:</strong> users are sent to the next nearest edge, as before.
</div>
<div class="failure-impact is-hidden" data-component="rt5">
<strong>If a router fails:</strong> the edge sends its requests to another router in the region. Routers hold only the shard map, a few kilobytes, so any of them can take over at once.
</div>
<div class="failure-impact is-hidden" data-component="s4">
<strong>If en-US shard 4 fails:</strong> with three copies, one failure goes unnoticed. If all three are down, prefixes from 'sa' to 'sm' get an empty list, short prefixes go to other shards, and the rest of en-US is unaffected. Replay the first two flows.
</div>
<div class="failure-impact is-hidden" data-component="s5">
<strong>If en-US shard 5 fails:</strong> the same for its range, 'sn' to 'tg'.
</div>
<div class="failure-impact is-hidden" data-component="gb5">
<strong>If the en-GB shard fails:</strong> users in the UK get no suggestions until a copy is back, about a minute to load 2GB. Other markets are unaffected. The search box still works.
</div>
</div>

This is the full design. Searches are written to a log, never counted at request time. Every night a builder reads 28 days of it, scores each query by recent popularity, keeps only queries searched by at least 50 different people, and builds a trie with the top 10 stored at every prefix, so any prefix is answered by walking one node per character. The search box asks only when typing pauses, and drops answers for a prefix it has moved past. Browsers and CDN edges near the user answer more than half the requests. Trend counters compare each query's last 10 minutes with its usual rate, and push the queries far above it to every server every 30 seconds, where they're merged with the nightly index. A block list removes a suggestion everywhere within a minute. Each market has its own shards, big markets are split by prefix range, and the short prefixes that everyone types can be answered by any shard.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### Ways to find the top 10 for a prefix

| Approach | Work per request | Trade-off |
|---|---|---|
| `LIKE 'prefix%'` on a sorted table | Every query with that prefix, then a sort | Fine for long prefixes. Millions of rows for a single letter |
| Trie, search below the node | Every node below the prefix | No extra memory. As slow as the table for short prefixes |
| Trie with the top 10 at every node (this design) | One node per character | About 40 bytes extra per node. The ranking is fixed when the index is built |
| Sorted list of queries with binary search | Find the range, then scan it | Compact, but the scan is as slow as the table for short prefixes |

Storing the answer at every node is what makes a one-letter prefix as cheap as a ten-letter one. The price is that the ranking has to be decided when the index is built. Anything that depends on the request, such as who is asking, has to be mixed in afterwards.

### Fitting the trie in memory

A plain trie with one node per character wastes most of its space on long chains with only one child: `how to tie a bowline knot` has nobody else sharing its last dozen characters. A compressed trie stores a chain like that as one node with a string label, which cuts the node count several times over. The top 10 lists are stored as 4-byte query numbers rather than strings, and nodes deep in a chain with only one query below them don't need a list at all, since the answer is that one query. Together these are what bring `en-US` down to about 9GB.

### Scoring

A query's score is its searches over 28 days, with each day counting 10% less than the day after it, so a query popular last week outranks one that was popular a month ago. Suggestions that people pick add to the score; suggestions that are shown often and rarely picked lose a little. Trending queries are scored by their rate over the last 10 minutes, converted to the same scale, so the server can compare them directly with the nightly scores. The rule that a trending query takes at most 3 of the 10 places keeps a busy news day from pushing out everything else.

### Normalizing what's typed

The search box and the builder both normalize text the same way: lower case, accents kept for display but removed for matching, runs of spaces turned into one, and punctuation at the start dropped. `Café` and `cafe` find the same suggestions. Done on the client, it also means `How T` and `how t` share one cache entry at the edge.

### The user's own searches

A user's recent searches are often what they want again. They're kept on the device, not sent to the server, and the search box mixes them in above the server's list when they match the prefix. The server's answer stays the same for everyone, so it can be cached, and the user's history never leaves their device for this feature.

### Typos

Prefix matching finds nothing for `pyhton`. When a prefix of five or more characters has no suggestions, the server tries the prefixes one edit away: one character added, removed, changed or swapped with its neighbour. It keeps the matches whose score is far above what was typed. That's dozens of lookups instead of one, so it's done only when the plain lookup comes back empty.

### Picking range boundaries

`en-US`'s 8 ranges are recalculated each night from the day's traffic and the index size for each three-character prefix, so each shard gets about an eighth of both. When a boundary moves, the new shard files are loaded alongside the old ones, and the router switches to the new shard map only when every copy is ready. Requests never see a range that nobody has loaded.

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### Freshness against caching

Everything that makes the design fast, the nightly index and the caches in the browser and at the edge, works against freshness. The trending layer and 60-second edge caching buy freshness back for the queries that need it. Shorter caching would show trends sooner and send more requests to the servers.

### Precomputed lists can't change per request

Storing the top 10 at every node makes every lookup tiny, but the list is the same for everyone. Ranking by who's asking, where they are, or what they searched a minute ago can only be done by mixing extra results in at serve time or on the device, never inside the stored lists.

### Only prefixes match

A trie finds queries that start with what was typed. `tie a tie` won't find `how to tie a tie`. Matching words anywhere in a query needs a second index of every word in every query, which is several times larger and slower to answer.

### Trends can amplify

Suggesting a trending query makes more people search it, which keeps it trending. That's useful for news and harmful for rumours. The block list and the minimum number of distinct people limit the damage, but some rumours will be shown for a few minutes before anyone reports them.

### The long tail is left out

Queries searched by fewer than 50 people in 28 days are never suggested. That protects privacy and keeps the index small, and means long, specific prefixes often get no suggestions at all.

### Sharding adds moving parts

Routers, shard maps, range boundaries that move every night, and a short-prefix table built by merging across shards. For a service with one market and a 9GB index, Stage 4 is enough. The split earns its place when the indexes no longer fit comfortably on one server.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

A suggestion is shown to millions of people as if it were what everyone is searching for. That makes it worth manipulating, and makes anything harmful in it highly visible ([Security & Authentication](#/systems/security-authentication)).

### Pushing a query into the suggestions

Searches are cheap to fake, so the design never counts searches alone. Each person counts at most 3 times per query per hour, a query needs 50 different people over 28 days to be in the nightly index and 200 in 10 minutes to trend, and searches from accounts flagged as automated aren't counted at all. Buying thousands of real-looking accounts is expensive, and a sudden rise from accounts that are new or that all search the same few phrases is flagged for review.

### Offensive, dangerous and defamatory suggestions

Every candidate query is checked by a classifier before it enters the index or the trending set, and categories such as hate, sexual content and instructions for violence are never suggested, whatever their popularity. Suggestions that link a real person's name to a crime or a rumour are held for review before they can trend. Anything that gets through is removed with a block, live everywhere within a minute.

### Privacy

A query searched by only a few people may contain something private: an address, a phone number, a name with an illness. The 50-person rule means such a query is never suggested to anyone else. The search log holds hashed user IDs, not accounts, and is deleted after 28 days. The user's own history stays on their device.

### Scraping

The suggestions for every prefix together reveal what a market searches for. Rate limits per IP address and per client, applied at the edge before a request reaches a server, stop a script from walking every prefix quickly ([Rate Limiting](#/systems/rate-limiting)).

### Filling the caches with junk

Random prefixes are never cached by anyone else and always go to the servers. Prefixes over 60 characters are refused, prefixes with no suggestions are cached at the edge like any other answer, and rate limits apply per client, so a flood of random prefixes costs the attacker more than it costs the servers.

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **Latency**: server time at p50 and p99, and keystroke-to-screen time reported by the search box, per market and country.
- **Load**: requests a second at the edge and at the servers, and the edge hit rate by prefix length.
- **The index**: the version each server is serving, its age, and how long the nightly build took.
- **Trends**: time from a search to the trending set, the size of each market's trending set, and how often a push fails.
- **Usefulness**: how often a suggestion is picked, by position, and the share of prefixes with no suggestions.
- **Blocks**: blocks made, and time from a block to the last edge purge.

([Observability](#/systems/observability))

### What to alert on

- Any server serving an index more than **36 hours** old: the nightly build or the load has failed.
- Server p99 above **10ms**, or keystroke-to-screen p75 above **100ms** in any large country.
- Edge hit rate falling by more than **10 points**: a cache key has changed, or someone is flooding random prefixes.
- No trending push for **2 minutes**.
- The share of suggestions picked falling by more than **20%** after a new index: the build is wrong, even if every system is healthy.
- A block taking more than **2 minutes** to reach every server and edge.

### "A harmful suggestion is showing" — what happens?

Block it first, by exact query or by phrase, and check that the block has reached every server and that the edges were purged. Then find out how it got in: if it trended, look at who was searching it, and whether those accounts were real people. If it came from the nightly index, check why the classifier passed it, and add the case to its test set. Look for variants, the same phrase with different spelling, and block those too.

### "Suggestions are stale" — what happens?

Check the index version each server is serving. If they're all on an old version, the build failed or didn't publish: look at the builder's last run and at the log files it reads. If some servers are on the new version and others aren't, the old ones failed to load it, usually for lack of memory. If the index is current but a news story isn't showing, check the trend counters: their lag behind the stream, and whether the query met the thresholds.

### "Suggestions are slow in one country" — what happens?

Compare edge hit rate and server time for that country with others. A fall in hit rate points at the CDN or a change in cache keys. Normal hit rate with slow misses means the edges are being sent to a distant region: check routing to the nearest region, and whether that region's servers are down or overloaded.
