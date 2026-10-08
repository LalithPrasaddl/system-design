# Web Crawler

A web crawler starts from a handful of pages, follows their links, and keeps going until it has fetched a useful part of the web — then fetches it all again, because the web keeps changing. The basic loop fits in ten lines. Everything hard about it comes from the other end of the connection: millions of servers, most of them small, none of which asked to be crawled; sites that generate pages forever; the same page under a dozen different URLs; and far more pages due for a refresh each day than the crawler can afford to fetch. This case study builds a crawler that fetches a billion pages a day without ever being the reason a site slows down.

<!-- tab:requirements:Requirements -->

## Requirements

This case study builds the crawler behind a general web search engine. It fetches pages and hands them to the indexer; it doesn't rank or search them.

### Functional requirements

- **Discover pages** by following links from a set of seed URLs, from sitemaps that sites publish, and from URLs that site owners submit.
- **Fetch HTML pages** and hand each one to the indexer with its links, its metadata, and whether it changed since the last fetch.
- **Recrawl pages** that are already known — more often for pages that change often and pages that matter more.
- **Obey robots.txt**, the file in which each site says which paths crawlers may fetch.
- **Recognize duplicates**: the same URL spelled differently, the same page at different URLs, and pages that are identical apart from an ad or a timestamp.
- **Avoid crawler traps**: sites that generate an endless supply of URLs.
- **Per-host controls**: operators can lower a host's rate or pause it entirely.

### Non-functional requirements

- **Throughput: 1 billion pages a day**, about 11,600 a second.
- **Politeness:** by default one connection per host at a time and at least one second between requests, slower for slow servers. A `429` or `503` from a host slows the crawler down from the very next request.
- **Freshness:** the most important 1% of pages are fetched within an hour of changing, on average. Every other page is refetched at least every 60 days.
- **Durability:** losing a machine never loses a stored page or a known URL. It may lose links discovered in its last second, which will be found again.
- **Containment:** no single host or trap can use more than its own share of the fetch budget.
- **Scales out:** adding machines adds throughput, without lowering the rate any host sees.

### In scope

The frontier of URLs waiting to be fetched, politeness, robots.txt, DNS, splitting the crawl across machines, URL and content deduplication, trap defenses, recrawl scheduling and prioritization.

### Out of scope

**Indexing and ranking**, which consume the crawler's output. **Running JavaScript**: pages are processed as the HTML their server returns. **Images, video and other non-HTML files.** **Pages behind logins or forms.**

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

Unlike a user-facing system, a crawler chooses its own load: it fetches as fast as it decides to. The numbers that shape the design are the ones it doesn't choose — how many links each page carries, and how many different hosts it needs to keep busy without pressing any of them.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Pages fetched</div>
<div class="stat-tile-value">~1<span class="stat-tile-unit">B/day</span></div>
<div class="stat-tile-sub">~11,600 a second</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Links checked</div>
<div class="stat-tile-value">~580<span class="stat-tile-unit">K/s</span></div>
<div class="stat-tile-sub">~50 links per page</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Known URLs</div>
<div class="stat-tile-value">~50<span class="stat-tile-unit">B</span></div>
<div class="stat-tile-sub">~15TB of URL rows</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Hosts ready at once</div>
<div class="stat-tile-value">~46<span class="stat-tile-unit">K</span></div>
<div class="stat-tile-sub">to stay polite at full speed</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Inbound bandwidth</div>
<div class="stat-tile-value">~2.3<span class="stat-tile-unit">Gbps</span></div>
<div class="stat-tile-sub">25KB per page on the wire</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Page store</div>
<div class="stat-tile-value">~200<span class="stat-tile-unit">TB</span></div>
<div class="stat-tile-sub">latest copy, compressed</div>
</div>
</div>

### Assumptions

- The index aims to hold **10 billion** pages, refetched every **10 days** on average. That's 1 billion fetches a day.
- The crawler knows about **50 billion** URLs in all. Most will never be worth fetching, or not often.
- **200 million** hosts are known.
- An average page is **100KB** of HTML, **25KB** compressed on the wire and **20KB** compressed at rest.
- An average page has **50 links**. About **10%** of them are to URLs the crawler hasn't seen before.
- An average fetch takes **1.5 seconds** from start to finish, counting slow servers.
- A URL's row — the URL plus what the crawler knows about it — is about **300 bytes**.

### Fetches and links

1 billion pages a day is **~11,600 a second**. Each brings about 50 links, so the crawler must check **~580,000 links a second** against everything it has seen before. That check, not the fetching, is the busiest operation in the system. About 58,000 a second turn out to be new URLs.

### Breadth

A polite crawler fetches each host at most once every few seconds — about every 4 seconds on average, given the delays in Stage 2. To fetch 11,600 pages a second, it therefore needs at least 11,600 × 4 ≈ **46,000 different hosts** with a URL ready at every moment. Throughput comes from breadth, never from pressing harder on one site.

### Concurrency

At 1.5 seconds per fetch, 11,600 a second means about **17,400 fetches in flight** at once. A machine doing asynchronous network I/O handles around 450 comfortably, so the fleet is **~40 crawler machines**.

### Bandwidth and storage

- Inbound: 1 billion × 25KB = **25TB a day**, or about **2.3Gbps** on average.
- Page store: 10 billion pages × 20KB = **200TB** for the latest copy of each.
- URL store: 50 billion × 300 bytes = **15TB**.
- Fingerprints of every known URL, at 8 bytes each: 50 billion × 8 = **400GB** — about **10GB per machine** across 40 machines, small enough to keep in memory.

<!-- tab:api-design:API Design -->

## API Design

A crawler has three interfaces: the HTTP requests it sends to websites, the record it hands to the indexer, and a small API for people.

### What the crawler sends to a website

```
GET /p/9001 HTTP/1.1
Host: shop.example
User-Agent: ExampleBot/2.1 (+https://search.example/bot)
Accept: text/html
Accept-Encoding: gzip, br
If-None-Match: "a91f"
If-Modified-Since: Tue, 29 Sep 2026 08:00:00 GMT
```

### How it treats the response

| Response | What the crawler does |
|---|---|
| `200` | Store the page, extract links, record whether it changed |
| `304` | Unchanged since the last fetch; no body was sent |
| `301`, `308` | Permanent redirect: the target is a new URL, sent through the frontier like any link; this URL is recorded as moved |
| `302`, `307` | Temporary redirect: the target is fetched, but this URL stays the one to recrawl |
| `404`, `410` | Gone. Retried a few times over the following weeks, then dropped |
| `429`, `503` | The host is overloaded: pause it for `Retry-After` and double its delay |
| Other `5xx`, timeout | Count an error for the host; slow it down; retry the URL later |
| `robots.txt` → `404` | The site has no rules: everything is allowed |
| `robots.txt` → `5xx`, timeout | Treat the whole site as disallowed until robots.txt can be read |

### What the indexer receives

Each fetch produces a record on the `crawled_pages` stream. The body itself goes to the page store; the record points to it.

```
{"url": "https://shop.example/p/9001",
 "final_url": "https://shop.example/p/9001",
 "fetched_at": "2026-10-07T14:02:11Z",
 "status": 200,
 "content_type": "text/html",
 "body_ref": "pages/sha256/9f2c41…",
 "simhash": "0x8a31f0c27d19e644",
 "changed": true,
 "duplicate_of": null,
 "outlinks": ["https://shop.example/p/9002", "…"]}
```

### For people

```
POST /v1/submissions                         site owners and internal teams
{"urls": ["https://shop.example/p/9001"], "lastmod": "2026-10-07T13:55:00Z"}
→ 202 {"accepted": 1, "rejected": []}

GET /v1/urls?u=https://shop.example/p/9001?utm_source=mail
→ 200 {"normalized": "https://shop.example/p/9001", "state": "fetched",
       "last_fetched_at": "2026-10-07T14:02:11Z", "last_status": 200,
       "next_fetch_at": "2026-10-19T00:00:00Z", "duplicate_of": null}

PUT /v1/hosts/shop.example/policy            operators only
{"max_rps": 0.2, "paused": false, "reason": "owner request, ticket 4411"}
→ 200
```

| Code | Meaning |
|---|---|
| `202` | Submission accepted as a hint; the URLs will be scheduled by priority |
| `200` | Lookup or policy change done |
| `400` | Not a valid http(s) URL |
| `403` | Submitter doesn't control the host, or caller isn't an operator |
| `429` | Over the submitter's daily limit |

### Why the details matter

**The crawler says who it is.** The User-Agent names the crawler and links to a page explaining it and how to limit it. A site owner who sees it in their logs can find out what it is and slow it down without blocking it.

**Recrawls are conditional.** `If-None-Match` and `If-Modified-Since` carry what the server said last time. If nothing changed, the answer is `304` with no body.

**A submission is a hint.** `202` means the URLs will be considered, not fetched immediately. Otherwise the submission API would be a way to make the crawler hit any site at any rate.

**Redirect targets go through the frontier.** A redirect to another host is a request to that host, so it waits for that host's delay and its robots.txt like any other.

**The record points at the body.** At 100KB a page, putting bodies on the stream would make it 25 times larger than it needs to be.

<!-- tab:data-model:Data Model -->

## Data Model

The crawler's state is two big tables — every URL it knows and every host it knows — plus the pages themselves.

### URLs

```
urls                                       -- ~50 billion rows, wide-column store
  row_key          TEXT PRIMARY KEY        -- reversed host + path: example.shop/p/9001
  url              TEXT                    -- normalized
  url_fp           BIGINT                  -- 64-bit fingerprint of the normalized URL
  state            TEXT                    -- queued | fetched | failed | blocked | duplicate | trap
  priority         REAL
  discovered_at    TIMESTAMP
  last_fetched_at  TIMESTAMP
  next_fetch_at    TIMESTAMP
  interval_s       INT                     -- current recrawl interval
  last_status      SMALLINT
  etag             TEXT
  last_modified    TIMESTAMP
  content_hash     BYTES                   -- SHA-256 of the body
  simhash          BIGINT                  -- for near-duplicate checks
  changes          SMALLINT                -- of the last 10 fetches, how many found a change
  fail_count       SMALLINT
  duplicate_of     TEXT
  lease_until      TIMESTAMP               -- set while a node is fetching it
```

The row key starts with the host written backwards, so `shop.example`, `www.shop.example` and `blog.shop.example` all sort next to each other. Every URL of a site is one contiguous range, which is what a node reads when it takes over that site.

### Hosts

```
hosts                                      -- ~200 million rows
  host               TEXT PRIMARY KEY
  site               TEXT                  -- registrable domain: shop.example
  shard              SMALLINT              -- hash(site) mod 4096
  ip                 TEXT
  dns_expires_at     TIMESTAMP
  robots_txt         TEXT
  robots_fetched_at  TIMESTAMP
  delay_s            REAL                  -- current gap between requests
  importance         REAL                  -- from links pointing at the site
  budget_per_cycle   INT
  fetched_this_cycle INT
  error_streak       SMALLINT
  paused             BOOL
  max_rps            REAL                  -- set by operators; null if none
```

### Pages

The page store is an object store. Each page body is stored compressed under its own SHA-256 hash, so identical pages at different URLs are stored once. A URL row points at the hash of its current version.

### In each node's memory

```
fingerprints       set of url_fp for every URL of the node's sites    ~10GB
host queues        per host: the next few hundred URLs to fetch
ready heap         hosts ordered by when each may next be fetched
priority bands     URLs due now, in four bands, waiting to move to their host queue
```

All of it can be rebuilt from the two tables, which is what a node does when it takes over a shard.

### Why this storage

A wide-column store, the kind built on log-structured merge trees ([NoSQL Databases](#/systems/databases-nosql), [Storage Engines](#/systems/storage-engines)). 50 billion rows and 15TB is far past one relational database, and the access patterns are simple: read or write one URL by key, or read one site's URLs as a range. No transaction ever spans two sites, because one node owns each site. The write load — ~58,000 new URLs and ~11,600 fetch results a second — suits an LSM store, which turns random writes into sequential ones. Rows are split across the store by key range ([Partitioning & Sharding](#/systems/partitioning-sharding)) and replicated three times ([Replication](#/systems/replication)).

<!-- tab:architecture:Architecture:default -->

This case study builds the crawler up in five stages. Each stage fixes a specific failure of the one before. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one URL at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. A Queue and a Set -->

## Stage 1 — One Process, a Queue and a Set

The smallest crawler is a loop. Take a URL from the front of a queue, fetch it, store the page, pull out its links, and add every link not seen before to the back of the queue. A set in memory remembers every URL ever queued. Fifty fetches run at once, so one slow server doesn't stall everything.

```
queue = deque(seeds); seen = set(seeds)
while queue:
    url = queue.popleft()
    page = fetch(url)
    store(url, page)
    for link in extract_links(page):
        if link not in seen:
            seen.add(link)
            queue.append(link)
```

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 780 300" width="780" height="300" role="img" aria-label="A single crawler process fetches pages from news-site.com and shop.example and saves them to a page store">
  <g data-fail-toggle="cr1">
    <rect x="40" y="95" width="200" height="95" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="140" y="122" text-anchor="middle" class="d-actor-label" font-size="12">Crawler Process</text>
    <text x="140" y="140" text-anchor="middle" class="d-label-muted" font-size="9">50 fetches at once</text>
    <text x="140" y="155" text-anchor="middle" class="d-label-muted" font-size="9">queue · seen set</text>
    <text x="140" y="170" text-anchor="middle" class="d-label-muted" font-size="9">all in memory</text>
  </g>
  <rect x="520" y="20" width="210" height="50" rx="6" class="d-actor-box"></rect>
  <text x="625" y="50" text-anchor="middle" class="d-actor-label" font-size="12">news-site.com</text>
  <rect x="520" y="115" width="210" height="50" rx="6" class="d-actor-box"></rect>
  <text x="625" y="139" text-anchor="middle" class="d-actor-label" font-size="12">shop.example</text>
  <text x="625" y="155" text-anchor="middle" class="d-label-muted" font-size="9">one small server</text>
  <g data-fail-toggle="ps1">
    <rect x="520" y="210" width="210" height="50" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="625" y="240" text-anchor="middle" class="d-actor-label" font-size="12">Page Store</text>
  </g>
  <line id="w1-cr-news" x1="242" y1="108" x2="516" y2="40" class="d-msg d-request" data-depends-on="cr1" marker-end="url(#arrowW1)"></line>
  <line id="w1-news-cr" x1="516" y1="58" x2="242" y2="122" class="d-msg d-response" data-depends-on="cr1" marker-end="url(#arrowW1r)"></line>
  <line id="w1-cr-shop" x1="242" y1="134" x2="516" y2="134" class="d-msg d-request" data-depends-on="cr1" marker-end="url(#arrowW1)"></line>
  <line id="w1-shop-cr" x1="516" y1="150" x2="242" y2="150" class="d-msg d-response" data-depends-on="cr1" marker-end="url(#arrowW1r)"></line>
  <line id="w1-cr-ps" x1="242" y1="162" x2="516" y2="228" class="d-msg d-request" data-depends-on="cr1 ps1" marker-end="url(#arrowW1)"></line>
  <line id="w1-ps-cr" x1="516" y1="246" x2="242" y2="176" class="d-msg d-response" data-depends-on="cr1 ps1" marker-end="url(#arrowW1r)"></line>
  <text x="390" y="290" text-anchor="middle" class="d-label-muted" font-size="10">play one page, then the small shop, then the queue outgrowing memory</text>
  <defs>
    <marker id="arrowW1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowW1r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "mem", "title": "Crawler memory", "rows": [["queue", "—"], ["seen set", "—"]]},
{"id": "sites", "title": "What the sites see", "rows": [["news-site.com", "—"], ["shop.example", "—"]]}
],
"flows": [
{
"id": "page",
"label": "Crawl one page",
"nodes": ["cr1", "ps1"],
"steps": [
{"el": "w1-cr-news", "payload": "GET news-site.com/", "set": {"mem.queue": "1 seed", "mem.seen set": "1 URL", "sites.news-site.com": "1 request", "sites.shop.example": "—"}, "text": "The crawler starts from a list of seed URLs: well-known sites from which most of the web can be reached by following links. It takes the first one off the queue and fetches it."},
{"el": "w1-news-cr", "payload": "200 · 80KB of HTML", "ms": 350, "text": "The page comes back. Almost all of the 350ms is the other server and the network, which is why 50 fetches run side by side."},
{"el": "w1-cr-ps", "payload": "store page", "text": "The crawler saves the page for the indexer."},
{"el": "w1-ps-cr", "payload": "ok", "ms": 8, "set": {"mem.queue": "95 URLs", "mem.seen set": "96 URLs"}, "text": "Then it parses the HTML and pulls out every link: 140 of them. 95 aren't in the seen set. They're added to it, and to the back of the queue."},
{"el": "w1-cr-shop", "payload": "GET shop.example/", "set": {"sites.shop.example": "1 request"}, "text": "A few minutes later, one of those links leads to shop.example, a small online shop."},
{"el": "w1-shop-cr", "payload": "200 · 5,000 product links", "ms": 400, "set": {"mem.queue": "… + 5,000 shop.example URLs in a row"}, "text": "Its home page links to all 5,000 of its product pages. Breadth-first order puts them next to each other on the queue. The next flow shows what that does to the shop."}
]
},
{
"id": "flood",
"label": "A small site, fetched flat out",
"nodes": ["cr1"],
"steps": [
{"el": "w1-cr-shop", "payload": "50 × GET shop.example/p/…", "set": {"mem.queue": "5,000 shop.example URLs at the front", "mem.seen set": "~5,100 URLs", "sites.news-site.com": "—", "sites.shop.example": "50 requests at once"}, "text": "The crawler reaches the shop's URLs. Its 50 fetch slots each take the next URL off the queue — and all 50 are on shop.example. The shop runs on one small server that usually sees a few visitors a minute."},
{"el": "w1-shop-cr", "payload": "slowing · 4s a page", "ms": 4000, "text": "The server slows to four seconds a page. The crawler has no idea anything is wrong: every slot that finishes simply takes the next shop URL, so the server never gets a break."},
{"el": "w1-cr-shop", "payload": "~12 requests a second, for 7 minutes", "set": {"sites.shop.example": "~12 requests a second"}, "text": "That's about 12 requests a second for the seven minutes the 5,000 pages take. Real customers start getting timeouts."},
{"el": "w1-shop-cr", "payload": "403 Forbidden, from now on", "set": {"sites.shop.example": "crawler blocked"}, "text": "The shop's owner looks at the logs, finds one IP address responsible, and blocks it. Every request from the crawler now gets 403. A crawler that overloads sites gets blocked by them, and a blocked site can't be indexed. The crawler never read the shop's robots.txt either, which asks bots to stay out of /cart/ and /search. The next stage fixes both."}
]
},
{
"id": "memory",
"label": "The queue outgrows memory",
"nodes": ["cr1", "ps1"],
"steps": [
{"el": "w1-cr-news", "payload": "hour 6 · GET …", "set": {"mem.queue": "40 million URLs", "mem.seen set": "45 million URLs", "sites.news-site.com": "—", "sites.shop.example": "—"}, "text": "Six hours in. Each page fetched adds about 50 links, and even after the seen set removes repeats, around 5 new URLs join the queue for each one that leaves it. The queue only grows."},
{"el": "w1-news-cr", "payload": "200", "ms": 300, "text": "With each URL taking a hundred bytes or more in both the queue and the set, the process passes 12GB of memory."},
{"el": "w1-cr-ps", "payload": "(out of memory · process killed)", "set": {"mem.queue": "lost", "mem.seen set": "lost"}, "text": "The operating system kills it. The queue and the seen set lived only in memory, so both are gone."},
{"el": "w1-cr-news", "payload": "restart · GET news-site.com/", "set": {"mem.queue": "1 seed", "mem.seen set": "1 URL", "sites.news-site.com": "fetched again"}, "text": "On restart the crawler begins at its seeds and refetches six hours of pages it has already stored. A crawl that takes weeks can never finish this way. Fail the crawler process and replay the first flow: nothing is fetched, and nothing about how far it got survives."}
]
}
]
}
</script>
<div class="diagram-caption">One process holds the queue of URLs to fetch and the set of URLs already seen, both in memory. It fetches whatever is next in the queue, with no idea which server each URL belongs to.</div>
</div>

<div class="fail-hint">Click the crawler process or the page store to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="cr1">
<strong>If the crawler process fails:</strong> everything it knew — the queue and the seen set — is lost. A restart begins at the seeds and refetches everything it already has. Nothing records which pages in the page store are current.
</div>
<div class="failure-impact is-hidden" data-component="ps1">
<strong>If the page store fails:</strong> fetched pages can't be saved. The loop either throws them away and carries on, or stops; either way, nothing records which URLs were fetched but never stored, so the gap can't be found later.
</div>
</div>

Stage 1 has two separate problems. It treats the web as a list of URLs, when what matters is the servers behind them: it has no idea it is sending one small shop 12 requests a second. And it keeps everything in memory, when the list of URLs to fetch grows faster than it shrinks from the very first hour.

<!-- stage:2:2. A Polite Frontier -->

## Stage 2 — A Polite, Durable Frontier

Still one machine, but the queue is replaced by a **frontier** organized around hosts.

- **One queue per host.** Alongside them, a heap of hosts ordered by the earliest time each may be fetched again. The fetcher only takes URLs from hosts whose time has come, and only one fetch per host runs at a time.
- **Each host's delay adapts.** After each fetch, the host waits ten times as long as the response took, and at least one second. A server that answers in 200ms gets a request every 2 seconds; one that takes 4 seconds gets one every 40. A `429` or `503` pauses the host for its `Retry-After` and doubles its delay.
- **robots.txt comes first.** Before the first URL on a host, the crawler fetches its robots.txt, caches it for 24 hours, and checks every URL against it.
- **DNS answers are cached** for as long as each record says, instead of being looked up for every fetch.
- **The frontier is on disk**, in an embedded key-value store. A URL being fetched is marked with a lease rather than removed, so a crash returns it to its queue.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 800 320" width="800" height="320" role="img" aria-label="A fetcher takes ready URLs from a frontier of per-host queues, checks a robots and DNS cache, fetches from shop.example and other hosts, and stores pages in a page store">
  <g data-fail-toggle="fr2">
    <rect x="20" y="125" width="180" height="80" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="110" y="150" text-anchor="middle" class="d-actor-label" font-size="12">Frontier</text>
    <text x="110" y="167" text-anchor="middle" class="d-label-muted" font-size="9">one queue per host</text>
    <text x="110" y="181" text-anchor="middle" class="d-label-muted" font-size="9">hosts by next allowed time</text>
    <text x="110" y="195" text-anchor="middle" class="d-label-muted" font-size="9">on disk</text>
  </g>
  <g data-fail-toggle="fe2">
    <rect x="270" y="125" width="170" height="80" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="355" y="155" text-anchor="middle" class="d-actor-label" font-size="12">Fetcher</text>
    <text x="355" y="172" text-anchor="middle" class="d-label-muted" font-size="9">500 fetches at once</text>
    <text x="355" y="186" text-anchor="middle" class="d-label-muted" font-size="9">one per host</text>
  </g>
  <g data-fail-toggle="rc2">
    <rect x="270" y="15" width="170" height="56" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="355" y="38" text-anchor="middle" class="d-actor-label" font-size="12">Robots &amp; DNS Cache</text>
    <text x="355" y="55" text-anchor="middle" class="d-label-muted" font-size="9">per host · 24h / record TTL</text>
  </g>
  <rect x="570" y="30" width="200" height="50" rx="6" class="d-actor-box"></rect>
  <text x="670" y="60" text-anchor="middle" class="d-actor-label" font-size="12">shop.example</text>
  <rect x="570" y="130" width="200" height="50" rx="6" class="d-actor-box"></rect>
  <text x="670" y="152" text-anchor="middle" class="d-actor-label" font-size="12">Other Hosts</text>
  <text x="670" y="168" text-anchor="middle" class="d-label-muted" font-size="9">~2,000 with ready URLs</text>
  <g data-fail-toggle="ps2">
    <rect x="570" y="235" width="200" height="50" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="670" y="265" text-anchor="middle" class="d-actor-label" font-size="12">Page Store</text>
  </g>
  <line id="w2-fe-fr" x1="268" y1="148" x2="204" y2="148" class="d-msg d-request" data-depends-on="fe2 fr2" marker-end="url(#arrowW2)"></line>
  <line id="w2-fr-fe" x1="204" y1="180" x2="268" y2="180" class="d-msg d-response" data-depends-on="fe2 fr2" marker-end="url(#arrowW2r)"></line>
  <line id="w2-fe-rc" x1="340" y1="121" x2="340" y2="75" class="d-msg d-request" data-depends-on="fe2 rc2" marker-end="url(#arrowW2)"></line>
  <line id="w2-rc-fe" x1="370" y1="75" x2="370" y2="121" class="d-msg d-response" data-depends-on="fe2 rc2" marker-end="url(#arrowW2r)"></line>
  <line id="w2-fe-shop" x1="442" y1="140" x2="566" y2="62" class="d-msg d-request" data-depends-on="fe2" marker-end="url(#arrowW2)"></line>
  <line id="w2-shop-fe" x1="566" y1="76" x2="442" y2="154" class="d-msg d-response" data-depends-on="fe2" marker-end="url(#arrowW2r)"></line>
  <line id="w2-fe-oth" x1="442" y1="165" x2="566" y2="150" class="d-msg d-request" data-depends-on="fe2" marker-end="url(#arrowW2)"></line>
  <line id="w2-oth-fe" x1="566" y1="168" x2="442" y2="180" class="d-msg d-response" data-depends-on="fe2" marker-end="url(#arrowW2r)"></line>
  <line id="w2-fe-ps" x1="442" y1="192" x2="566" y2="252" class="d-msg d-request" data-depends-on="fe2 ps2" marker-end="url(#arrowW2)"></line>
  <line id="w2-ps-fe" x1="566" y1="268" x2="432" y2="207" class="d-msg d-response" data-depends-on="fe2 ps2" marker-end="url(#arrowW2r)"></line>
  <text x="400" y="310" text-anchor="middle" class="d-label-muted" font-size="10">play two URLs on one host, then robots.txt, then the site asking for a break</text>
  <defs>
    <marker id="arrowW2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowW2r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "h", "title": "shop.example in the frontier", "rows": [["queued URLs", "—"], ["delay", "—"], ["next allowed", "—"], ["robots.txt", "—"]]},
{"id": "srv", "title": "shop.example's server", "rows": [["requests from the crawler", "—"]]}
],
"flows": [
{
"id": "polite",
"label": "Two URLs on the same host",
"nodes": ["fr2", "fe2", "rc2", "ps2"],
"steps": [
{"el": "w2-fe-fr", "payload": "next ready URL?", "set": {"h.queued URLs": "5,000", "h.delay": "1s (default)", "h.next allowed": "now", "h.robots.txt": "cached · /p/ allowed", "srv.requests from the crawler": "—"}, "text": "A fetch slot is free, so the fetcher asks the frontier for a URL. The frontier looks at the top of its heap of hosts, ordered by when each may next be fetched."},
{"el": "w2-fr-fe", "payload": "shop.example/p/1", "ms": 1, "text": "shop.example's time has come, so its next URL is handed out. The host is marked busy: no other fetch to it starts until this one ends."},
{"el": "w2-fe-rc", "payload": "robots + address for shop.example?", "text": "Before connecting, the fetcher checks the cache."},
{"el": "w2-rc-fe", "payload": "/p/ allowed · 203.0.113.7", "ms": 1, "text": "Both were fetched earlier and are still fresh. A DNS lookup would otherwise add 20 to 100ms to every fetch."},
{"el": "w2-fe-shop", "payload": "GET /p/1", "text": "The fetcher requests the page."},
{"el": "w2-shop-fe", "payload": "200 · in 400ms", "ms": 400, "set": {"h.delay": "4s (10 × 400ms)", "h.next allowed": "in 4s", "srv.requests from the crawler": "1 every 4s"}, "text": "The page arrives after 400ms. The frontier sets shop.example's delay to ten times that, 4 seconds. A slower server is left alone for longer; a fast one can be fetched more often."},
{"el": "w2-fe-ps", "payload": "store page", "text": "The page is stored."},
{"el": "w2-ps-fe", "payload": "ok", "ms": 6, "text": "Stored."},
{"el": "w2-fe-fr", "payload": "31 new links · next ready URL?", "set": {"h.queued URLs": "4,999 + 31 new"}, "text": "Its new links go into their hosts' queues in the frontier, on disk, and the fetcher asks for another URL."},
{"el": "w2-fr-fe", "payload": "blog.example/post/8", "ms": 1, "text": "shop.example won't be ready for 4 seconds, so the frontier hands out a URL from the next host that is. The fetcher never waits; it spreads its 500 slots across about 2,000 hosts."},
{"el": "w2-fe-oth", "payload": "GET blog.example/post/8", "text": "It fetches from another host."},
{"el": "w2-fr-fe", "payload": "4s later · shop.example/p/2", "ms": 1, "text": "Four seconds after the first fetch finished, shop.example is back at the top of the heap, and its next page is handed out. The shop sees one request every 4 seconds instead of 12 a second, and its customers notice nothing. Politeness costs no throughput, as long as the frontier has enough different hosts ready."}
]
},
{
"id": "robots",
"label": "robots.txt says no",
"nodes": ["fr2", "fe2", "rc2"],
"steps": [
{"el": "w2-fr-fe", "payload": "shop.example/search?q=red", "set": {"h.queued URLs": "3", "h.delay": "1s (default)", "h.next allowed": "now", "h.robots.txt": "—", "srv.requests from the crawler": "—"}, "text": "This time shop.example is new to the crawler. The first of its URLs to come up is shop.example/search?q=red, found as a link on another site."},
{"el": "w2-fe-rc", "payload": "robots for shop.example?", "text": "The fetcher checks the cache for the site's rules."},
{"el": "w2-rc-fe", "payload": "not cached", "ms": 1, "text": "There are none yet."},
{"el": "w2-fe-shop", "payload": "GET /robots.txt", "set": {"srv.requests from the crawler": "1"}, "text": "So the first request to any new host is always for /robots.txt: the file in which a site tells crawlers which paths to stay out of."},
{"el": "w2-shop-fe", "payload": "Disallow: /search · Disallow: /cart/", "ms": 120, "set": {"h.robots.txt": "/search, /cart/ disallowed"}, "text": "This one asks crawlers to stay out of search results and the shopping cart — pages that are endless in number and useless in an index."},
{"el": "w2-fe-rc", "payload": "cache for 24h", "text": "The rules are cached for 24 hours, so robots.txt is fetched about once a day per host, not once per page."},
{"el": "w2-fe-fr", "payload": "/search?q=red: blocked by robots", "set": {"h.queued URLs": "2", "h.next allowed": "in 1s"}, "text": "The URL is checked against the rules and isn't fetched. It's recorded as blocked rather than just dropped, so it isn't rediscovered and tried again every time another page links to it. The robots.txt request counted as a request, so the host's next URL waits its turn."},
{"el": "w2-fr-fe", "payload": "1s later · shop.example/p/1 (allowed)", "ms": 1, "text": "The next URL is allowed. If robots.txt couldn't be read at all — a server error or a timeout — the crawler would treat the whole site as disallowed until it could: the site might be saying no, and there's no way to tell. A 404 for robots.txt is different: the site has no rules."}
]
},
{
"id": "slowdown",
"label": "The site asks for a break",
"nodes": ["fr2", "fe2"],
"steps": [
{"el": "w2-fe-shop", "payload": "GET /p/212", "set": {"h.queued URLs": "4,780", "h.delay": "4s", "h.next allowed": "—", "h.robots.txt": "cached · /p/ allowed", "srv.requests from the crawler": "1 every 4s"}, "text": "shop.example is having a sale, and its server is busy with real customers."},
{"el": "w2-shop-fe", "payload": "503 · Retry-After: 120", "ms": 90, "text": "It answers 503 Service Unavailable, asking clients to come back in 120 seconds."},
{"el": "w2-fe-fr", "payload": "/p/212 back to the front · pause host", "set": {"h.next allowed": "in 120s", "h.delay": "8s (doubled)", "srv.requests from the crawler": "none for 2 minutes"}, "text": "The URL goes back to the front of the shop's queue; it isn't lost or counted as a failed page. The host is paused for the 120 seconds it asked for, and its delay is doubled."},
{"el": "w2-fr-fe", "payload": "URLs from other hosts", "ms": 1, "text": "Meanwhile the fetcher keeps busy with other hosts. Nothing waits on the shop."},
{"el": "w2-fe-shop", "payload": "2 minutes later · GET /p/212", "text": "When the pause ends, the URL is tried again."},
{"el": "w2-shop-fe", "payload": "200 · in 300ms", "ms": 300, "set": {"h.delay": "8s, easing back down", "srv.requests from the crawler": "1 every 8s"}, "text": "It succeeds. The delay comes back down gradually, a little after each healthy response, rather than snapping back: a site that has only just recovered isn't immediately pushed again. Repeated errors stretch the delay further, and a host that has failed for a day is only tried now and then."}
]
}
]
}
</script>
<div class="diagram-caption">The frontier keeps one queue per host and hands the fetcher URLs only from hosts whose delay has passed. Each host's delay follows its response times and its requests to slow down. robots.txt and DNS answers are cached per host, and the frontier is on disk.</div>
</div>

<div class="fail-hint">Click the frontier, the fetcher, the robots and DNS cache or the page store to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="fr2">
<strong>If the frontier's disk fails:</strong> the crawl's whole state — every queued URL, every host's delay — is on that one disk. A process restart is harmless, since leased URLs return to their queues; losing the disk means starting again from the seeds.
</div>
<div class="failure-impact is-hidden" data-component="fe2">
<strong>If the fetcher crashes:</strong> it restarts and carries on from the frontier. The URLs it was fetching are still there, leased; when the leases expire they go back to their queues and are fetched again.
</div>
<div class="failure-impact is-hidden" data-component="rc2">
<strong>If the robots and DNS cache is lost:</strong> every host needs a fresh DNS lookup and a fresh robots.txt before its next page. Fetching slows for a while as they are refetched. URLs are never fetched without a robots check — a missing cache means waiting, never skipping it.
</div>
<div class="failure-impact is-hidden" data-component="ps2">
<strong>If the page store fails:</strong> the fetcher stops handing out URLs rather than fetching pages it can't keep. The frontier holds its place, and the crawl resumes where it was when the store comes back.
</div>
</div>

The crawler is now a good citizen and survives a restart. But it is one machine: 500 fetches at once comes to about 300 pages a second, against a target of 11,600. Its disk would also have to hold 50 billion URLs. The crawl has to be split across machines, and how it's split decides whether politeness survives.

<!-- stage:3:3. Split by Host -->

## Stage 3 — Many Machines, Split by Host

Forty crawler nodes, each running Stage 2's frontier and fetcher for its own part of the web.

- **Sites are split, not URLs.** Every host belongs to one of 4,096 shards, by a hash of its site name — `shop.example` for `www.shop.example` too. Each shard is owned by one node, under a lease from a coordination service ([Distributed Locking & Leader Election](#/systems/distributed-locking)). 40 nodes own about 100 shards each.
- **A site's whole state lives with its owner**: its queues, delay, robots.txt and DNS entry. Politeness is enforced in one place, so it needs no coordination.
- **Links go to their site's owner.** A node that finds a link to a site it doesn't own adds it to an outgoing batch for that site's owner, sent every second. ~580,000 links a second cross the network this way, in a few thousand batches.
- **Each node remembers its sites' URLs.** It keeps a 64-bit fingerprint of every URL its sites have ever had in memory, about 10GB, so checking a link is a memory lookup (Deep Dives).
- **The URL store is shared and durable.** Queues and fetch history are rows in the wide-column store from the Data Model tab, keyed so that each site's URLs are one range.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 820 360" width="820" height="360" role="img" aria-label="A coordination service assigns host shards to crawler node 1 and crawler node 2; each node fetches its own hosts from the web, sends links for other hosts to their owner, and records URLs in a shared URL store">
  <g data-fail-toggle="wco3">
    <rect x="320" y="10" width="180" height="48" rx="6" class="d-actor-box"></rect>
    <text x="410" y="31" text-anchor="middle" class="d-actor-label" font-size="12">Coordination Service</text>
    <text x="410" y="48" text-anchor="middle" class="d-label-muted" font-size="9">site shard → node · leases</text>
  </g>
  <g data-fail-toggle="n13">
    <rect x="40" y="80" width="190" height="66" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="135" y="104" text-anchor="middle" class="d-actor-label" font-size="12">Crawler Node 1</text>
    <text x="135" y="121" text-anchor="middle" class="d-label-muted" font-size="9">owns shop.example, …</text>
    <text x="135" y="135" text-anchor="middle" class="d-label-muted" font-size="9">~100 shards · fingerprints</text>
  </g>
  <g data-fail-toggle="n23">
    <rect x="40" y="220" width="190" height="66" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="135" y="244" text-anchor="middle" class="d-actor-label" font-size="12">Crawler Node 2</text>
    <text x="135" y="261" text-anchor="middle" class="d-label-muted" font-size="9">owns blog.example, …</text>
    <text x="135" y="275" text-anchor="middle" class="d-label-muted" font-size="9">~100 shards · fingerprints</text>
  </g>
  <rect x="610" y="105" width="180" height="80" rx="6" class="d-actor-box"></rect>
  <text x="700" y="140" text-anchor="middle" class="d-actor-label" font-size="12">The Web</text>
  <text x="700" y="158" text-anchor="middle" class="d-label-muted" font-size="9">shop.example · blog.example · …</text>
  <g data-fail-toggle="us3">
    <rect x="320" y="280" width="190" height="56" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="415" y="303" text-anchor="middle" class="d-actor-label" font-size="12">URL Store</text>
    <text x="415" y="320" text-anchor="middle" class="d-label-muted" font-size="9">queues + history · keyed by site</text>
  </g>
  <line id="w3-n1-web" x1="232" y1="98" x2="606" y2="122" class="d-msg d-request" data-depends-on="n13" marker-end="url(#arrowW3)"></line>
  <line id="w3-web-n1" x1="606" y1="138" x2="232" y2="114" class="d-msg d-response" data-depends-on="n13" marker-end="url(#arrowW3r)"></line>
  <line id="w3-n2-web" x1="232" y1="240" x2="606" y2="165" class="d-msg d-request" data-depends-on="n23" marker-end="url(#arrowW3)"></line>
  <line id="w3-web-n2" x1="606" y1="180" x2="232" y2="256" class="d-msg d-response" data-depends-on="n23" marker-end="url(#arrowW3r)"></line>
  <line id="w3-n1-n2" x1="110" y1="150" x2="110" y2="216" class="d-msg d-request" data-depends-on="n13 n23" marker-end="url(#arrowW3)"></line>
  <line id="w3-n2-n1" x1="150" y1="216" x2="150" y2="150" class="d-msg d-request" data-depends-on="n13 n23" marker-end="url(#arrowW3)"></line>
  <line id="w3-n1-co" x1="190" y1="78" x2="316" y2="30" class="d-msg d-request" data-depends-on="n13 wco3" marker-end="url(#arrowW3)"></line>
  <line id="w3-co-n1" x1="316" y1="46" x2="212" y2="78" class="d-msg d-response" data-depends-on="n13 wco3" marker-end="url(#arrowW3r)"></line>
  <line id="w3-co-n2" x1="360" y1="62" x2="222" y2="216" class="d-msg d-response" data-depends-on="wco3 n23" marker-end="url(#arrowW3r)"></line>
  <line id="w3-n2-co" x1="205" y1="216" x2="340" y2="62" class="d-msg d-request" data-depends-on="wco3 n23" marker-end="url(#arrowW3)"></line>
  <line id="w3-n1-us" x1="190" y1="150" x2="350" y2="276" class="d-msg d-request" data-depends-on="n13 us3" marker-end="url(#arrowW3)"></line>
  <line id="w3-us-n1" x1="372" y1="276" x2="214" y2="150" class="d-msg d-response" data-depends-on="n13 us3" marker-end="url(#arrowW3r)"></line>
  <line id="w3-n2-us" x1="232" y1="262" x2="316" y2="292" class="d-msg d-request" data-depends-on="n23 us3" marker-end="url(#arrowW3)"></line>
  <line id="w3-us-n2" x1="316" y1="308" x2="232" y2="278" class="d-msg d-response" data-depends-on="n23 us3" marker-end="url(#arrowW3r)"></line>
  <text x="410" y="354" text-anchor="middle" class="d-label-muted" font-size="10">play the link handoff, then the split-by-URL mistake, then the node failure</text>
  <defs>
    <marker id="arrowW3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowW3r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "own", "title": "Site owners", "rows": [["shop.example", "node 1"], ["blog.example", "node 2"]]},
{"id": "b", "title": "blog.example", "rows": [["new URLs queued", "—"], ["requests it receives", "—"]]}
],
"flows": [
{
"id": "handoff",
"label": "A link to another node's site",
"nodes": ["n13", "n23", "us3"],
"steps": [
{"el": "w3-n1-web", "payload": "GET shop.example/p/1", "set": {"own.shop.example": "node 1", "own.blog.example": "node 2", "b.new URLs queued": "—", "b.requests it receives": "—"}, "text": "Node 1 owns shop.example and fetches one of its pages, with Stage 2's per-host delay."},
{"el": "w3-web-n1", "payload": "200 · 48 links", "ms": 400, "text": "The page has 48 links: 45 to shop.example itself, and 3 to blog.example, which node 2 owns. Every node has the map of shards to owners from the coordination service."},
{"el": "w3-n1-us", "payload": "insert 42 new shop.example URLs", "text": "Node 1 handles its own site's links itself. It checks the 45 against its in-memory fingerprints: 45 memory lookups, no network. 42 are new. It writes them to the URL store, so a crash can't lose them, and adds them to shop.example's queue."},
{"el": "w3-us-n1", "payload": "ok", "ms": 4, "text": "Written."},
{"el": "w3-n1-n2", "payload": "batch · 3 for blog.example + 2,180 others", "text": "The 3 blog.example links go into node 1's outgoing batch for node 2, with every other link it found this second for node 2's sites."},
{"el": "w3-n2-us", "payload": "insert 1 new blog.example URL", "text": "Node 2 checks them against its own fingerprints. Two it has seen before; one is new, and is written to the URL store."},
{"el": "w3-us-n2", "payload": "ok", "ms": 4, "set": {"b.new URLs queued": "1"}, "text": "It joins blog.example's queue."},
{"el": "w3-n2-web", "payload": "GET blog.example/post/9", "set": {"b.requests it receives": "1 every few seconds, from node 2 only"}, "text": "When blog.example's next allowed time comes, node 2 fetches it. Node 1 never contacts blog.example, however many links to it it finds. Every request to a site comes from the one node that knows that site's delay."}
]
},
{
"id": "byurl",
"label": "If URLs were split instead of sites",
"nodes": ["n13", "n23"],
"steps": [
{"el": "w3-n1-web", "payload": "GET blog.example/post/1", "set": {"own.shop.example": "every node", "own.blog.example": "every node", "b.new URLs queued": "—", "b.requests it receives": "—"}, "text": "Suppose the crawl were split by a hash of each whole URL instead. blog.example's 10,000 posts would be spread across all 40 nodes, each keeping its own queue and delay for blog.example."},
{"el": "w3-n2-web", "payload": "GET blog.example/post/2", "text": "Node 2's delay for blog.example says 4 seconds have passed since its last request there, so it sends one. It has no idea node 1 sent one a moment ago."},
{"el": "w3-web-n1", "payload": "200", "ms": 400, "set": {"b.requests it receives": "~10 a second (40 nodes × 1 per 4s)"}, "text": "Each node is polite on its own. Together, 40 nodes sending one request every 4 seconds make 10 a second: Stage 1's flood again, from 40 addresses. All 40 also fetch blog.example's robots.txt and look up its address."},
{"el": "w3-n1-n2", "payload": "I just hit blog.example", "text": "Fixing that would mean every node telling every other node about every request, per site, in real time."},
{"el": "w3-web-n2", "payload": "200", "ms": 400, "set": {"own.shop.example": "node 1", "own.blog.example": "node 2", "b.requests it receives": "1 every 4s"}, "text": "Splitting by site removes the need: if only one node ever talks to a site, there is nothing to coordinate. That's why the hash is taken over the site name, and why links are sent to their site's owner rather than fetched by whichever node found them."}
]
},
{
"id": "nodedown",
"label": "Node 1 dies",
"nodes": ["wco3", "n13", "n23", "us3"],
"steps": [
{"el": "w3-n1-co", "payload": "(machine lost at 14:02:10)", "set": {"own.shop.example": "node 1", "own.blog.example": "node 2", "b.new URLs queued": "—", "b.requests it receives": "—"}, "text": "Node 1's machine fails in the middle of 450 fetches. Its outgoing batches for the current second are never sent, and it stops renewing its shard leases."},
{"el": "w3-co-n2", "payload": "you own shards 1,200–1,249", "ms": 10000, "set": {"own.shop.example": "node 2"}, "text": "After 10 seconds the leases expire. The coordination service spreads node 1's ~100 shards across the surviving nodes; node 2 gets 50 of them, shop.example's among them."},
{"el": "w3-n2-us", "payload": "read 50 shards' sites", "text": "Node 2 reads those sites' rows from the URL store. Because rows are keyed by site, each site is one contiguous range."},
{"el": "w3-us-n2", "payload": "queues · fingerprints · 450 leased", "ms": 40000, "text": "It rebuilds their queues and fingerprints, about 5GB, in under a minute. The 450 URLs node 1 was fetching are still marked as leased; the leases expire and they go back in their queues. A few may end up fetched twice, which costs one request each."},
{"el": "w3-n2-web", "payload": "GET shop.example/p/212", "text": "Fetching for those sites resumes, with each site's delay starting from a cautious default, since node 1 kept its timings in memory. The links in node 1's lost batches were never recorded — but links are found many times over, and each will turn up again the next time a page that carries it is fetched. A crawler can afford to lose a second of discoveries; it can't afford to lose its record of what it has fetched, which is in the URL store."}
]
}
]
}
</script>
<div class="diagram-caption">Every site belongs to one shard, and every shard to one node. A node fetches only its own sites, sends links for other sites to their owners, and records its URLs in a shared store keyed by site, so a failed node's shards can be taken over by others.</div>
</div>

<div class="fail-hint">Click the coordination service, either node or the URL store to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="wco3">
<strong>If the coordination service fails:</strong> nodes can't renew their shard leases. Each stops fetching a shard when its lease runs out, because it can no longer be sure nobody else owns it — two owners would mean two delays for the same site. Crawling pauses until coordination returns. It is a small replicated cluster across three zones, so this takes two of its members failing at once.
</div>
<div class="failure-impact is-hidden" data-component="n13">
<strong>If node 1 fails:</strong> its shards move to other nodes after about 10 seconds, and their crawling resumes within a minute. Links it found in its last second are lost and will be found again. Replay the third flow.
</div>
<div class="failure-impact is-hidden" data-component="n23">
<strong>If node 2 fails:</strong> the same, for its shards. Each node's failure pauses about 2.5% of sites for a minute. Batches other nodes were sending to it are retried to the new owners.
</div>
<div class="failure-impact is-hidden" data-component="us3">
<strong>If part of the URL store fails:</strong> it is replicated three ways, so losing one machine moves its key ranges to replicas in seconds. While a range is unavailable, nodes owning those sites can't record new URLs or fetch results, so they stop fetching them rather than fetch pages they can't account for.
</div>
</div>

The crawl now grows with the number of machines, and every site still hears from one node at a polite pace. But the web is full of URLs that aren't worth fetching: the same page under ten different URLs, and sites that generate new URLs without end. At a billion fetches a day, a crawler that can't recognize them spends a large share of its budget on them.

<!-- stage:4:4. Duplicates and Traps -->

## Stage 4 — Duplicates and Traps

Four filters, two on the way in and two on the way out.

- **Normalize every URL before the seen check.** Lowercase the scheme and host, drop the default port and the `#fragment`, resolve `./` and `../`, sort the query parameters, and remove parameters known to be for tracking only, such as `utm_source`. Ten spellings of one URL become one.
- **Hash every page's content.** If its SHA-256 matches a page already stored, it is the same page at another URL. It's stored once, its URL is marked as a duplicate, and its links aren't processed again.
- **SimHash every page.** A SimHash is a 64-bit fingerprint built so that similar pages get similar fingerprints. Two pages within 3 bits of each other are treated as the same page: that catches pages that differ only in an ad, a date or a session token (Deep Dives).
- **Give every site a budget.** Each site may have a set number of pages fetched per crawl cycle, scaled by how important it is. A run of near-identical pages reached through one URL pattern marks that pattern as a likely trap.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 820 330" width="820" height="330" role="img" aria-label="A fetcher gets pages from the web; a content filter compares each page's hash and SimHash before it reaches the page store; a link filter normalizes links and checks them against the URL store and the site's budget">
  <rect x="20" y="130" width="130" height="60" rx="6" class="d-actor-box"></rect>
  <text x="85" y="164" text-anchor="middle" class="d-actor-label" font-size="12">The Web</text>
  <g data-fail-toggle="fe4">
    <rect x="200" y="130" width="150" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="275" y="156" text-anchor="middle" class="d-actor-label" font-size="12">Fetcher</text>
    <text x="275" y="173" text-anchor="middle" class="d-label-muted" font-size="9">on each node</text>
  </g>
  <g data-fail-toggle="cf4">
    <rect x="400" y="25" width="190" height="66" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="495" y="48" text-anchor="middle" class="d-actor-label" font-size="12">Content Filter</text>
    <text x="495" y="65" text-anchor="middle" class="d-label-muted" font-size="9">exact hash · SimHash</text>
    <text x="495" y="79" text-anchor="middle" class="d-label-muted" font-size="9">near-duplicate runs</text>
  </g>
  <g data-fail-toggle="lf4">
    <rect x="400" y="230" width="190" height="66" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="495" y="253" text-anchor="middle" class="d-actor-label" font-size="12">Link Filter</text>
    <text x="495" y="270" text-anchor="middle" class="d-label-muted" font-size="9">normalize · seen? · budget</text>
    <text x="495" y="284" text-anchor="middle" class="d-label-muted" font-size="9">trap patterns</text>
  </g>
  <g data-fail-toggle="ps4">
    <rect x="650" y="30" width="150" height="56" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="725" y="54" text-anchor="middle" class="d-actor-label" font-size="12">Page Store</text>
    <text x="725" y="71" text-anchor="middle" class="d-label-muted" font-size="9">one copy per hash</text>
  </g>
  <g data-fail-toggle="us4">
    <rect x="650" y="130" width="150" height="60" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="725" y="154" text-anchor="middle" class="d-actor-label" font-size="12">URL Store</text>
    <text x="725" y="171" text-anchor="middle" class="d-label-muted" font-size="9">queues · history</text>
  </g>
  <line id="w4-fe-web" x1="198" y1="150" x2="154" y2="150" class="d-msg d-request" data-depends-on="fe4" marker-end="url(#arrowW4)"></line>
  <line id="w4-web-fe" x1="154" y1="172" x2="198" y2="172" class="d-msg d-response" data-depends-on="fe4" marker-end="url(#arrowW4r)"></line>
  <line id="w4-fe-cf" x1="310" y1="126" x2="420" y2="95" class="d-msg d-request" data-depends-on="fe4 cf4" marker-end="url(#arrowW4)"></line>
  <line id="w4-cf-fe" x1="440" y1="95" x2="330" y2="126" class="d-msg d-response" data-depends-on="fe4 cf4" marker-end="url(#arrowW4r)"></line>
  <line id="w4-cf-ps" x1="592" y1="58" x2="646" y2="58" class="d-msg d-request" data-depends-on="cf4 ps4" marker-end="url(#arrowW4)"></line>
  <line id="w4-fe-lf" x1="310" y1="194" x2="420" y2="226" class="d-msg d-request" data-depends-on="fe4 lf4" marker-end="url(#arrowW4)"></line>
  <line id="w4-lf-us" x1="592" y1="250" x2="690" y2="194" class="d-msg d-request" data-depends-on="lf4 us4" marker-end="url(#arrowW4)"></line>
  <line id="w4-us-lf" x1="710" y1="194" x2="596" y2="268" class="d-msg d-response" data-depends-on="lf4 us4" marker-end="url(#arrowW4r)"></line>
  <line id="w4-fe-us" x1="354" y1="145" x2="646" y2="145" class="d-msg d-request" data-depends-on="fe4 us4" marker-end="url(#arrowW4)"></line>
  <line id="w4-us-fe" x1="646" y1="168" x2="354" y2="168" class="d-msg d-response" data-depends-on="fe4 us4" marker-end="url(#arrowW4r)"></line>
  <text x="410" y="320" text-anchor="middle" class="d-label-muted" font-size="10">play the ten URLs, then the endless calendar, then the changed ad</text>
  <defs>
    <marker id="arrowW4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowW4r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "l", "title": "Link filter", "rows": [["links in", "—"], ["new URLs queued", "—"]]},
{"id": "c", "title": "Content filter", "rows": [["verdict", "—"]]},
{"id": "ev", "title": "events.example", "rows": [["pages this cycle", "—"], ["budget", "—"]]}
],
"flows": [
{
"id": "aliases",
"label": "One page, ten URLs",
"nodes": ["fe4", "lf4", "cf4", "us4"],
"steps": [
{"el": "w4-fe-web", "payload": "GET deals.example/today", "set": {"l.links in": "—", "l.new URLs queued": "—", "c.verdict": "—", "ev.pages this cycle": "—", "ev.budget": "—"}, "text": "A deals site has a page that links to the same shop product ten times, from different parts of the page and different campaigns."},
{"el": "w4-web-fe", "payload": "200 · 10 links to shop.example/p/9", "ms": 300, "set": {"l.links in": "10"}, "text": "Among them: https://Shop.Example/p/9, …/p/9#reviews, …/p/9?utm_source=deals, …/p/9?utm_source=deals&utm_medium=email, http://shop.example:80/p/9, …/p/9?color=red&size=m and …/p/9?size=m&color=red."},
{"el": "w4-fe-lf", "payload": "10 raw links", "text": "Every link goes through the link filter before anything else."},
{"el": "w4-lf-us", "payload": "2 normalized URLs · 1 new", "text": "Normalizing lowercases the host, drops the fragment, the default port and the utm_ parameters, and sorts what's left. Ten spellings become two URLs: /p/9, which was crawled last week, and /p/9?color=red&size=m, which is new and is queued."},
{"el": "w4-us-lf", "payload": "queued", "ms": 3, "set": {"l.new URLs queued": "1"}, "text": "Queued."},
{"el": "w4-us-fe", "payload": "later · /p/9?color=red&size=m", "ms": 1, "text": "When its turn comes, it's fetched."},
{"el": "w4-fe-web", "payload": "GET /p/9?color=red&size=m", "text": "One request to the shop."},
{"el": "w4-web-fe", "payload": "200", "ms": 350, "text": "The page comes back."},
{"el": "w4-fe-cf", "payload": "hash this page", "text": "Before it's stored, its content is hashed."},
{"el": "w4-cf-fe", "payload": "same hash as /p/9 · duplicate", "ms": 2, "set": {"c.verdict": "exact duplicate of /p/9"}, "text": "The shop shows the same page whatever the color and size parameters say. The hash matches /p/9's exactly, so nothing new is stored or sent to the indexer, the links — identical to /p/9's — aren't processed again, and the URL is recorded as a duplicate of /p/9. After a few matches like this on one site, the crawler learns that those parameters don't change shop.example's pages, and strips them from future links before the seen check. Many sites also say so themselves, with a rel=canonical link naming the preferred URL."}
]
},
{
"id": "trap",
"label": "A calendar with no last page",
"nodes": ["fe4", "lf4", "cf4", "us4"],
"steps": [
{"el": "w4-fe-web", "payload": "GET events.example/cal?m=2026-11", "set": {"l.links in": "—", "l.new URLs queued": "—", "c.verdict": "—", "ev.pages this cycle": "1,204", "ev.budget": "20,000"}, "text": "events.example has a calendar. Every month's page links to the next month's, and there is no last month: the server generates a page for any month it's asked for."},
{"el": "w4-web-fe", "payload": "200 · links to ?m=2026-12", "ms": 200, "text": "Every page is a new URL, and its content really is different — the dates differ — so neither the seen check nor the exact hash can stop it. A crawler with no other defense would follow it forever, one polite request at a time."},
{"el": "w4-fe-cf", "payload": "hash · month 2031-07", "set": {"ev.pages this cycle": "1,261"}, "text": "Five years ahead, the months are empty: no events are listed that far out. Empty months differ only in their dates."},
{"el": "w4-cf-fe", "payload": "2 bits from 2031-06 · 8th in a row", "ms": 2, "set": {"c.verdict": "near-duplicate run: 8 in a row"}, "text": "Their SimHashes are within 2 bits of each other. The content filter counts runs of near-duplicates reached through the same URL pattern on a site — here, /cal?m= followed by a date."},
{"el": "w4-fe-lf", "payload": "link ?m=2031-08", "text": "The page's link to the next month reaches the link filter."},
{"el": "w4-lf-us", "payload": "/cal?m= marked as a trap · drop", "set": {"l.new URLs queued": "0"}, "text": "After 8 in a row, the pattern is marked as a likely trap on events.example. Links matching it are dropped, and the decision appears in the crawl report for the site."},
{"el": "w4-us-lf", "payload": "budget: 1,262 of 20,000 used", "ms": 3, "text": "Not every trap produces lookalike pages; some generate endless unique junk. The backstop is the budget: events.example may have 20,000 pages fetched per crawl cycle, set by how important the site is. Once it's spent, the site's remaining URLs wait for the next cycle. A trap can waste one site's budget, never the crawl's."}
]
},
{
"id": "adchange",
"label": "Refetched, and only the ad changed",
"nodes": ["fe4", "cf4", "us4", "ps4"],
"steps": [
{"el": "w4-us-fe", "payload": "blog.example/post/42 · recrawl", "ms": 1, "set": {"l.links in": "—", "l.new URLs queued": "—", "c.verdict": "—", "ev.pages this cycle": "—", "ev.budget": "—"}, "text": "blog.example/post/42 was fetched a week ago and is due again."},
{"el": "w4-fe-web", "payload": "GET /post/42", "text": "It's fetched."},
{"el": "w4-web-fe", "payload": "200 · 61KB", "ms": 250, "text": "The bytes differ from last week's: a different ad, a different ‘trending now’ box, a different security token in the comment form."},
{"el": "w4-fe-cf", "payload": "compare with last version", "text": "The content filter compares it with the version on record."},
{"el": "w4-cf-fe", "payload": "hash differs · SimHash 1 bit apart", "ms": 2, "set": {"c.verdict": "unchanged in substance"}, "text": "The exact hash says it changed. SimHash says it is 1 bit away from last week's: the article is the same. The crawler records it as unchanged, so it isn't re-sent to the indexer, and — in the next stage — it counts as unchanged when deciding how soon to come back. Without this, every page with a rotating ad would look as if it changed on every visit."},
{"el": "w4-cf-ps", "payload": "nothing new to store", "text": "The stored copy stays as it is."}
]
}
]
}
</script>
<div class="diagram-caption">Links are normalized and checked against what the site has already seen, and against the site's budget and known trap patterns. Fetched pages are compared by exact hash and SimHash before anything is stored or sent on.</div>
</div>

<div class="fail-hint">Click the fetcher, the content filter, the link filter, the page store or the URL store to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="fe4">
<strong>If the fetcher fails:</strong> the node restarts it; leased URLs return to their queues, as in Stage 2.
</div>
<div class="failure-impact is-hidden" data-component="cf4">
<strong>If the content filter fails:</strong> pages can't be compared, so every page is treated as new: stored, sent to the indexer, its links processed. That costs storage and indexing work but loses nothing, and duplicates are marked once the filter is back. Losing an optimization briefly is cheaper than stopping the crawl.
</div>
<div class="failure-impact is-hidden" data-component="lf4">
<strong>If the link filter fails:</strong> new links can't be checked, so they wait in the node's memory, and fetching continues from the URLs already queued. If it stays down long enough for that buffer to fill, the oldest unfiltered links are dropped — they will be found again.
</div>
<div class="failure-impact is-hidden" data-component="ps4">
<strong>If the page store fails:</strong> new pages can't be saved, so the fetcher stops taking URLs, as in Stage 2. Refetches that turn out unchanged need nothing from it and could continue, but simplicity wins: the node pauses.
</div>
<div class="failure-impact is-hidden" data-component="us4">
<strong>If the URL store fails:</strong> nothing can be queued or recorded for the affected sites, so their crawling pauses until replicas take over the range.
</div>
</div>

Now each fetch is spent on a page that is really distinct. But there are 10 billion of them to keep fresh, and 1 billion fetches a day. Fetching everything in strict rotation — every page every 10 days — means news front pages are days out of date, while pages that haven't changed in years are fetched 36 times a year.

<!-- stage:5:5. Spending the Budget -->

## Stage 5 — Spending the Fetch Budget

The final stage decides which pages get the billion fetches.

- **Every URL's next fetch time comes from its own history.** Each fetch records whether the page changed. If it did, the URL's interval is halved; if not, it grows by half. Intervals stay between 10 minutes and 60 days.
- **Refetches are conditional.** They send the `ETag` and `Last-Modified` from the last fetch, and an unchanged page answers `304` with no body.
- **Priority is importance times the chance of a change.** Importance comes from links: a page linked from many important pages is important. It's recomputed daily, offline, from the link graph the crawler has collected. New URLs take their priority from the page that linked to them, so a new article on a front page is fetched within minutes.
- **The frontier gets a second layer.** Due URLs wait in four **priority bands**. The fetcher draws from band 1 most often, and each URL it draws moves to its host's queue, which still decides *when* it can be fetched. Priority picks what is fetched next from a site; it never overrides the site's delay.
- **A recrawl scheduler** on each node reads its sites' URLs that are coming due and places them in the bands.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 820 320" width="820" height="320" role="img" aria-label="A recrawl scheduler reads due URLs from the URL store and places them in the frontier's priority bands; the fetcher takes URLs from the frontier, sends conditional requests to the web, writes results back to the URL store and sends changed pages to the output stream">
  <g data-fail-toggle="rs5">
    <rect x="20" y="25" width="190" height="66" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="115" y="50" text-anchor="middle" class="d-actor-label" font-size="12">Recrawl Scheduler</text>
    <text x="115" y="67" text-anchor="middle" class="d-label-muted" font-size="9">importance × chance of change</text>
    <text x="115" y="81" text-anchor="middle" class="d-label-muted" font-size="9">→ priority band</text>
  </g>
  <g data-fail-toggle="us5">
    <rect x="20" y="210" width="190" height="66" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="115" y="235" text-anchor="middle" class="d-actor-label" font-size="12">URL Store</text>
    <text x="115" y="252" text-anchor="middle" class="d-label-muted" font-size="9">next_fetch_at · change history</text>
  </g>
  <g data-fail-toggle="fr5">
    <rect x="290" y="105" width="200" height="100" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="390" y="130" text-anchor="middle" class="d-actor-label" font-size="12">Frontier</text>
    <text x="390" y="150" text-anchor="middle" class="d-label-muted" font-size="9">priority bands 1–4</text>
    <text x="390" y="166" text-anchor="middle" class="d-label-muted" font-size="9">then per-host queues</text>
    <text x="390" y="182" text-anchor="middle" class="d-label-muted" font-size="9">fetch only ready hosts</text>
  </g>
  <g data-fail-toggle="fe5">
    <rect x="560" y="115" width="110" height="70" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="615" y="146" text-anchor="middle" class="d-actor-label" font-size="12">Fetcher</text>
    <text x="615" y="163" text-anchor="middle" class="d-label-muted" font-size="9">conditional GET</text>
  </g>
  <rect x="710" y="115" width="95" height="70" rx="6" class="d-actor-box"></rect>
  <text x="757" y="154" text-anchor="middle" class="d-actor-label" font-size="12">The Web</text>
  <g data-fail-toggle="out5">
    <rect x="560" y="240" width="180" height="50" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="650" y="262" text-anchor="middle" class="d-actor-label" font-size="12">Output Stream</text>
    <text x="650" y="278" text-anchor="middle" class="d-label-muted" font-size="9">to the indexer</text>
  </g>
  <line id="w5-rs-us" x1="80" y1="95" x2="80" y2="206" class="d-msg d-request" data-depends-on="rs5 us5" marker-end="url(#arrowW5)"></line>
  <line id="w5-us-rs" x1="150" y1="206" x2="150" y2="95" class="d-msg d-response" data-depends-on="rs5 us5" marker-end="url(#arrowW5r)"></line>
  <line id="w5-rs-fr" x1="212" y1="70" x2="330" y2="101" class="d-msg d-request" data-depends-on="rs5 fr5" marker-end="url(#arrowW5)"></line>
  <line id="w5-fe-fr" x1="558" y1="140" x2="494" y2="140" class="d-msg d-request" data-depends-on="fe5 fr5" marker-end="url(#arrowW5)"></line>
  <line id="w5-fr-fe" x1="494" y1="170" x2="558" y2="170" class="d-msg d-response" data-depends-on="fe5 fr5" marker-end="url(#arrowW5r)"></line>
  <line id="w5-fe-web" x1="672" y1="140" x2="706" y2="140" class="d-msg d-request" data-depends-on="fe5" marker-end="url(#arrowW5)"></line>
  <line id="w5-web-fe" x1="706" y1="165" x2="672" y2="165" class="d-msg d-response" data-depends-on="fe5" marker-end="url(#arrowW5r)"></line>
  <line id="w5-fe-us" x1="585" y1="189" x2="214" y2="258" class="d-msg d-request" data-depends-on="fe5 us5" marker-end="url(#arrowW5)"></line>
  <line id="w5-fe-out" x1="630" y1="189" x2="640" y2="236" class="d-msg d-request" data-depends-on="fe5 out5" marker-end="url(#arrowW5)"></line>
  <text x="410" y="312" text-anchor="middle" class="d-label-muted" font-size="10">play the front page, then the page that never changes, then the day with too much due</text>
  <defs>
    <marker id="arrowW5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowW5r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "u", "title": "This URL", "rows": [["url", "—"], ["interval", "—"], ["priority", "—"], ["last result", "—"]]},
{"id": "d", "title": "Today, across the fleet", "rows": [["due", "—"], ["fetches available", "1.0 billion"]]}
],
"flows": [
{
"id": "news",
"label": "A front page that changes all day",
"nodes": ["rs5", "us5", "fr5", "fe5", "out5"],
"steps": [
{"el": "w5-rs-us", "payload": "due in the next minute?", "set": {"u.url": "news-site.com/", "u.interval": "30 min", "u.priority": "—", "u.last result": "—", "d.due": "—"}, "text": "Every few seconds, each node's recrawl scheduler reads which of its sites' URLs are coming due. news-site.com/ is one of them."},
{"el": "w5-us-rs", "payload": "news-site.com/ · changed 9 of last 10", "ms": 3, "set": {"u.interval": "15 min"}, "text": "Its history: changed on 9 of its last 10 fetches, which were 30 minutes apart. It was almost always out of date by the time it was refetched, so its interval is halved to 15 minutes."},
{"el": "w5-rs-fr", "payload": "band 1", "set": {"u.priority": "band 1 (top)"}, "text": "Its priority combines importance — thousands of sites link to it — with the chance it has changed since the last fetch, which is high. It goes in band 1."},
{"el": "w5-fe-fr", "payload": "next?", "text": "The fetcher asks for its next URL."},
{"el": "w5-fr-fe", "payload": "news-site.com/", "ms": 1, "text": "The frontier draws from band 1 most often. The URL moves to news-site.com's host queue and is handed out once the host's delay has passed, as always."},
{"el": "w5-fe-web", "payload": "GET / · If-None-Match: e71", "text": "The request carries the ETag from the last fetch."},
{"el": "w5-web-fe", "payload": "200 · changed · 6 new article links", "ms": 280, "set": {"u.last result": "changed"}, "text": "It has changed: six new articles have been published since the last fetch."},
{"el": "w5-fe-out", "payload": "page record · changed", "text": "The new version goes to the indexer."},
{"el": "w5-fe-us", "payload": "record change · 6 new URLs in band 1", "ms": 3, "text": "The six new articles take their priority from the page that links to them, so they go straight into band 1 and are fetched within minutes of being published — long before anything else links to them."}
]
},
{
"id": "static",
"label": "A page that never changes",
"nodes": ["rs5", "us5", "fr5", "fe5"],
"steps": [
{"el": "w5-rs-us", "payload": "due in the next minute?", "set": {"u.url": "shop.example/about", "u.interval": "8 days", "u.priority": "—", "u.last result": "—", "d.due": "—"}, "text": "shop.example/about comes due."},
{"el": "w5-us-rs", "payload": "unchanged in last 6 fetches", "ms": 3, "text": "It hasn't changed in its last six fetches."},
{"el": "w5-rs-fr", "payload": "band 4", "set": {"u.priority": "band 4 (lowest)"}, "text": "Few pages link to it and it rarely changes, so it goes in the lowest band. It will be fetched today, just after more urgent pages."},
{"el": "w5-fr-fe", "payload": "shop.example/about", "ms": 1, "text": "Its turn comes."},
{"el": "w5-fe-web", "payload": "GET /about · If-None-Match: a91f", "text": "The crawler sends the ETag the server gave it last time."},
{"el": "w5-web-fe", "payload": "304 Not Modified · no body", "ms": 90, "set": {"u.last result": "304 · unchanged"}, "text": "The server answers 304 Not Modified, with no body: a few hundred bytes instead of 60KB. Checking an unchanged page costs very little — though it still counts as a request against the site's delay."},
{"el": "w5-fe-us", "payload": "unchanged · interval × 1.5", "ms": 3, "set": {"u.interval": "12 days"}, "text": "Unchanged again, so its interval grows by half, to 12 days. It will stop growing at 60 days: a page that hasn't changed in a year still changes eventually. Nothing goes to the indexer."}
]
},
{
"id": "budget",
"label": "More is due than can be fetched",
"nodes": ["rs5", "us5", "fr5", "fe5"],
"steps": [
{"el": "w5-rs-us", "payload": "everything due today?", "set": {"u.url": "—", "u.interval": "—", "u.priority": "—", "u.last result": "—", "d.due": "—", "d.fetches available": "1.0 billion"}, "text": "Some days more is due than the crawler can fetch: several big sites published a lot at once, or a group of nodes was down yesterday."},
{"el": "w5-us-rs", "payload": "1.3 billion due", "ms": 3, "set": {"d.due": "1.3 billion"}, "text": "Today 1.3 billion URLs are due, against 1 billion fetches."},
{"el": "w5-rs-fr", "payload": "fill bands by priority", "text": "The schedulers don't fetch in order of due time. They fill the bands by priority: important pages that have probably changed first."},
{"el": "w5-fe-fr", "payload": "next?", "text": "The fetcher keeps drawing."},
{"el": "w5-fr-fe", "payload": "band 1: 60% · 2: 25% · 3: 10% · 4: 5%", "ms": 1, "text": "Every band moves, but the top bands move fastest. Low bands never stop entirely, so a little of everything is always being refreshed."},
{"el": "w5-rs-us", "payload": "push 300M to tomorrow · small boost", "ms": 3, "set": {"d.due": "1.0 billion today · 0.3 billion tomorrow"}, "text": "The 300 million that don't fit — low-priority refetches — are moved to tomorrow, each with a small priority boost for waiting, so nothing is put off forever. What ends up late is what matters least: an obscure page one day staler than planned, not a newspaper's front page. A crawler is always behind on something; this stage decides what."}
]
}
]
}
</script>
<div class="diagram-caption">Each URL's next fetch time follows its own change history. A recrawl scheduler places due URLs in priority bands by importance and chance of change; the frontier draws from the top bands most often, still subject to each host's delay. Refetches are conditional, and only changed pages go to the indexer.</div>
</div>

<div class="fail-hint">Click the recrawl scheduler, the URL store, the frontier, the fetcher or the output stream to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="rs5">
<strong>If a recrawl scheduler fails:</strong> its node gets no refetches. The bands drain on what's already in them and on newly discovered URLs, while known pages grow staler. When it's back, a backlog is due at once, and priority sorts it, as in the third flow.
</div>
<div class="failure-impact is-hidden" data-component="us5">
<strong>If part of the URL store fails:</strong> due URLs in that range can't be read and results can't be written, so those sites pause until a replica takes over.
</div>
<div class="failure-impact is-hidden" data-component="fr5">
<strong>If a node's frontier is lost:</strong> it lives in the node's memory and local disk, and is rebuilt from the URL store — the node, or whichever node takes over its shards, rereads what is due.
</div>
<div class="failure-impact is-hidden" data-component="fe5">
<strong>If the fetcher fails:</strong> leased URLs return to their queues once the leases expire, as in every stage since Stage 2.
</div>
<div class="failure-impact is-hidden" data-component="out5">
<strong>If the output stream fails:</strong> the indexer stops receiving new pages. The pages are already in the page store, so fetching can continue; records waiting to be published are marked in the URL store and sent when the stream is back. The index falls behind; the crawl doesn't.
</div>
</div>

This is the full design. Forty crawler nodes split the web by site: each site belongs to one of 4,096 shards, and each shard to one node under a lease, so only one machine ever talks to a site, at a delay set by that site's response times and its requests to slow down. Every new host's robots.txt is read before anything else, and cached. Links found on a page are normalized and sent to their site's owner, which checks them against in-memory fingerprints of every URL it has seen and records new ones in a wide-column URL store keyed by site. Fetched pages are compared by exact hash and SimHash, so a page under ten URLs or with a rotating ad is stored and indexed once. Per-site budgets and trap patterns keep any one site from swallowing the crawl. Each URL's refetch interval follows its own change history, and a recrawl scheduler sorts due URLs into priority bands by importance and chance of change, so the billion fetches a day go first to the pages that matter and have probably changed.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### Checking 580,000 links a second

Every link found must be checked against every URL ever seen. Three ways to do it:

- **Ask the URL store each time.** 580,000 random reads a second, almost all of them for URLs that already exist. It works, but the busiest part of the crawl becomes the store's read path.
- **A Bloom filter** in memory: about 10 bits per URL for a 1% false-positive rate, so 60GB for 50 billion URLs. It answers "definitely new" or "maybe seen". The trouble is that most links point at pages the crawler already knows — navigation, home pages, popular articles — and for those it says "maybe", which still needs a store lookup to be sure. It saves the lookup only for links that are new, which are the minority.
- **The exact fingerprints in memory.** A 64-bit hash of every normalized URL: 400GB for 50 billion, about 10GB per node, since each node holds only its own sites' URLs. Every check is a memory lookup, with no false "maybe".

The design uses the third. 64-bit fingerprints can collide: among 50 billion URLs, a few dozen pairs will share one, and the second URL of each pair will never be crawled. That is a cost the design accepts.

### Normalizing URLs

Normalization is safe only when it can't merge two genuinely different pages:

- **Always safe:** lowercase the scheme and host; remove the default port (`:80`, `:443`); remove the `#fragment`, which the server never sees; resolve `.` and `..` in the path; decode percent-escapes that don't need escaping (`%7E` to `~`).
- **Usually safe:** sort query parameters, and drop parameters that are almost always for tracking (`utm_*`, `fbclid`, `gclid`).
- **Never assumed:** that paths are case-insensitive, that `www.` and the bare domain serve the same site, or that `/index.html` equals `/`. These are learned per site, by finding that the variants have the same content hash, or from a `rel=canonical` link in the page.

### SimHash and finding near-duplicates

An ordinary hash changes completely when one byte of the input changes. SimHash is built to do the opposite.

1. Split the page's visible text into overlapping runs of words — "the quick brown", "quick brown fox", and so on.
2. Hash each run to 64 bits.
3. For each of the 64 bit positions, add 1 for every run whose hash has a 1 there and subtract 1 for every run with a 0.
4. The SimHash has a 1 wherever the total is positive.

Two pages that share most of their word runs get mostly the same totals, so mostly the same bits. A changed ad alters a few runs out of thousands and flips perhaps one bit.

Finding every stored page within 3 bits of a new one, among billions, uses the pigeonhole principle. Split the 64 bits into 4 blocks of 16. If two fingerprints differ in at most 3 bits, at least one of the 4 blocks must be identical. So the crawler keeps 4 indexes, one per block; a new page is looked up in each, and only the few candidates that match a block are compared in full.

The 3-bit threshold is a trade. Too loose, and product pages that differ only in their price and part number are merged. Too tight, and pages with rotating content look new every time.

### robots.txt in detail

- A file has groups of rules, each for one or more user agents. The crawler obeys the group that names it most specifically, or the `*` group if none does.
- Within a group, the longest matching rule wins, and `Allow` beats `Disallow` when they are equally long. `Disallow: /shop/` with `Allow: /shop/products/` allows products and nothing else under /shop/.
- `Crawl-delay` isn't part of the standard, but the crawler honours it as a minimum delay.
- A `404` means no rules. A `5xx` or a timeout means "fetch nothing yet". A `401` or `403` is treated as no rules, as the standard says, though in practice a site returning one is often watched closely.
- Files over 500KB are read only up to 500KB.
- robots.txt often lists the site's sitemaps, which the crawler reads to discover URLs and their `lastmod` dates.

### What counts as one host

Politeness is about not overloading a server, and the URL's hostname is only an approximation of one.

- **Subdomains.** `a.shop.example` and `b.shop.example` are usually the same servers. That's why shards are assigned by **site** — the registrable domain, found with the public list of domain suffixes, so that `shop.co.uk` is a site but `co.uk` isn't.
- **Shared hosting.** Ten thousand small sites may share one server and one IP address. Each site's delay alone would let them add up to a flood. So each IP address also has a limit, and when its sites are owned by several nodes, each node gets a share of the limit, reassessed every minute.
- **Big platforms.** Hosting platforms that give each user a subdomain on one registrable domain would collapse millions of independent sites into one. These are listed explicitly and treated as separate sites.

### Estimating how often a page changes

The crawler never sees a page change; it sees only whether it changed at least once between two fetches. If a page changes often relative to the interval, almost every fetch finds a change, and the crawler can't tell "every 20 minutes" from "every 2 minutes". The halve-or-grow rule in Stage 5 handles this by moving the interval until fetches find a change about half the time, which puts the interval near the page's real rate. A sudden change in behaviour — a forum thread that goes quiet — is followed within a few fetches.

Sitemaps help: a sitemap's `lastmod` for each URL says when it changed, and a URL with a newer `lastmod` than the last fetch is treated as due.

### DNS at crawl scale

11,600 fetches a second would be 11,600 DNS lookups without a cache. Each node runs its own caching resolver, and since a site's URLs are all fetched by the same node, its cache is almost always warm. Lookups fall to roughly the rate at which records expire. Addresses are looked up when a site's first URL enters its queue, not at fetch time, so DNS is off the fetch path. A site whose DNS fails is treated like a site returning errors: it is slowed down and retried later.

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### Politeness caps the biggest sites

A site with 100 million pages, fetched once a second, takes three years to crawl once. Large sites can easily take far more, and the adaptive delay lets a fast server be fetched more often, but one connection at a time is still slow. Sites that show they can handle more — fast responses, no errors under load — are allowed several connections; operators can raise limits further for sites that ask. Each increase is a judgment that the site can take it.

### Freshness against coverage

Every fetch spent refreshing a known page is one not spent discovering a new one. The split between the two — roughly 80% refetching and 20% new URLs here — is a policy decision, and either extreme is bad: an index of stale pages, or one that misses everything published recently.

### Loose duplicate thresholds merge different pages

Near-duplicate detection saves storage and indexing, but a threshold loose enough to ignore rotating ads can also merge two product pages that differ only in price. Getting it wrong hides real pages from the index. The threshold is set conservatively, and sites with many near-identical pages can be given stricter per-site settings.

### Traps can still waste a site's budget

Pattern detection catches the common traps; the budget catches the rest, but only after a site's budget has been spent on junk. On a site that is both important and full of traps, that's real pages not crawled this cycle.

### The URL space has no end

The crawler knows 50 billion URLs and keeps finding more. Most are low-value and will never reach the top of a band. URLs that have waited too long without being fetched, or have failed repeatedly, are expired from the store, which keeps the fingerprints and the store from growing forever — at the cost of rediscovering some of them later.

### Pages built by JavaScript

Pages whose content is assembled by JavaScript in the browser arrive as nearly empty HTML. Rendering them takes a headless browser and costs ten to a hundred times as much as a fetch. This design doesn't do it; one that did would send only pages that look empty to a separate, much smaller rendering fleet.

### Losing a second of links

Links found by a node in the last second before it fails are lost. This is fine for a crawler, because the same links will be found again the next time their page is fetched, and the alternative — writing every link durably before acknowledging it — would double the write load on the busiest path.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

A crawler fetches whatever the web points it at, from servers it doesn't control, at enormous volume. That makes it a target, and potentially a weapon ([Security & Authentication](#/systems/security-authentication)).

### Not fetching the inside of your own network

A public page can link to `http://10.0.4.12/admin` or `http://169.254.169.254/`, the address where cloud machines read their own credentials. A hostname can also resolve to a private address, or resolve to a public one when checked and a private one a second later. The crawler resolves each host itself, refuses any private, loopback or link-local address, and connects to the exact address it checked. Its machines also run in a network segment with no route to internal services, so a mistake in the check can't reach anything.

### Not becoming someone's attack tool

The submission API could be used to point the crawler at a victim's site. Submissions are hints, not commands; they are rate-limited per submitter; and nothing — submissions, links or redirects — can make the crawler exceed a site's delay or its IP limit. The worst anyone can do is make the crawler fetch a site at the rate it would have anyway.

### Hostile responses

- **Slow servers** that send one byte every few seconds: every fetch has a total time limit of 30 seconds, not just a connection timeout.
- **Huge pages:** bodies are cut off at 10MB.
- **Compression bombs:** a 10MB gzip body can expand to 10GB. Decompression stops at the 10MB limit.
- **Redirect loops** stop after 5 hops.
- **Parser bugs:** HTML parsing runs in sandboxed processes with memory and time limits, so a page that crashes the parser crashes only that process.

### Being honest about who it is

The crawler identifies itself in its User-Agent, publishes the IP ranges it fetches from, and has reverse DNS on those addresses. A site can then check that a request claiming to be the crawler really is — and block impostors using its name without blocking it.

### Respecting opt-outs

robots.txt is obeyed even when it's inconvenient, along with `noindex` and `nofollow` instructions in pages. Site owners can ask for a lower rate or no crawling at all, and operator overrides take effect within a minute on the owning node.

### Gaming the priority

Because importance comes from links, link farms — many sites linking to each other to look important — can push their pages up the bands. The importance computation discounts links from sites that are new, from sites that link to each other heavily, and from sites the index has flagged as spam.

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **Pages fetched per second**, by status class (2xx, 304, 3xx, 4xx, 5xx, timeout), and bytes per second.
- **Ready hosts** per node: hosts with a URL ready to fetch now. Too few, and the crawler can't stay fast and polite at once.
- **Due backlog** per priority band, and the age of the oldest due URL in band 1.
- **Politeness**: requests per site and per IP in every minute, computed from the fetch logs by a job independent of the crawler. The expected number of sites over their limit is zero.
- **robots.txt failures** and the number of sites treated as disallowed because of them.
- **Signs of being blocked**: a site whose responses switch to 403 or 429 for everything.
- **Duplicate rate** and **trap patterns flagged** per day.
- **Freshness**: a separate checker refetches a random sample of important pages and measures how often the crawler's copy is out of date.
- **Shard ownership**, link batch delays between nodes, and fingerprint memory per node.

([Observability](#/systems/observability))

### What to alert on

- Any site or IP over its rate limit in any minute.
- Fetch rate below **80%** of target for 15 minutes.
- Oldest due URL in band 1 more than **1 hour** overdue.
- Any shard without an owner for more than **1 minute**.
- More than **1,000** sites in a day switching to blocking the crawler.
- New URLs per day for one site more than **10×** its usual rate — a trap the patterns missed.

### "Your crawler is overloading my site" — what happens?

First, check that it is the crawler: does the requesting IP fall within the published ranges, and does reverse DNS confirm it? If not, it's an impostor, and the site owner can block it safely. If it is, compare the politeness logs for the site with its limit. If the logs say the crawler stayed within the limit, the "site" is probably one of many sharing a server — check the IP limit for its address. If they show it went over, that's a bug; lower the site's limit through the policy API while finding it.

### Fetch rate dropped by half — what happens?

Look at ready hosts per node. If they've fallen, the frontier lacks breadth: perhaps the recrawl schedulers are failing, or a large share of sites is paused because their robots.txt can't be read — often a DNS or network problem on the crawler's side, not the sites'. If ready hosts are normal, look at the output stream and page store; nodes stop fetching when they can't store or publish. If only some nodes are slow, check their shard ownership for churn.

### One site's URL count is exploding — what happens?

A site that suddenly yields millions of new URLs a day is almost always a trap the patterns haven't caught: a calendar, faceted search with every combination of filters, or session IDs in every link. Look at the most common URL patterns among its new URLs, add the offending one as a trap pattern for that site, and expire the URLs it produced. Its budget has already limited the damage to one site's share of the crawl.
