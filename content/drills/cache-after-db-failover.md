# After the Database Failover

<div class="drill-meta"><span class="drill-level" data-level="hard">Hard</span><span>Distributed Cache</span><span>Timeouts, retries and queues</span></div>

This drill runs on the finished design from the [Distributed Cache](#/systems-case-studies/distributed-cache) case study. Two numbers from it matter here. The database can answer about **150,000 reads a second**. It normally receives about **90,000**, because 95% of reads are answered by the cache and never reach it.

<div class="incident-card">
<div class="incident-card-head"><span class="incident-sev">SEV-2</span><span>Tuesday · paged 14:06 · still open at 14:20</span></div>
<p><strong>About a third of requests are failing, and pages that do load take seconds.</strong> At 14:02 the database team ran a planned failover to patch the database. It was announced as "about 40 seconds with no database reads or writes", and it finished on time at 14:02:48. The database is healthy again. Eighteen minutes later, the site has not recovered.</p>
</div>

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Request errors</div>
<div class="stat-tile-value">31<span class="stat-tile-unit">%</span></div>
<div class="stat-tile-sub">normally 0.02%</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Page p99</div>
<div class="stat-tile-value">4.8<span class="stat-tile-unit">s</span></div>
<div class="stat-tile-sub">normally 180ms</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Database CPU</div>
<div class="stat-tile-value">100<span class="stat-tile-unit">%</span></div>
<div class="stat-tile-sub">since 14:02:48</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Cache nodes</div>
<div class="stat-tile-value">40<span class="stat-tile-unit">/ 40</span></div>
<div class="stat-tile-sub">healthy, no failovers</div>
</div>
</div>

<div class="diagram-wrap">
<svg viewBox="0 0 640 230" width="640" height="230" role="img" aria-label="Cache hit ratio from 13:56 to 14:20: steady at 95 percent, dropping to 83 percent during a 38-second database failover at 14:02, then continuing to fall to 67 percent by 14:20">
  <rect x="201.0" y="20" width="14.8" height="170" class="d-band"></rect>
  <text x="220.8" y="30" class="d-label-muted" font-size="9">DB failover 14:02:10–14:02:48</text>
  <line x1="56" y1="147.5" x2="620" y2="147.5" class="d-gridline"></line>
  <text x="48" y="151.5" text-anchor="end" class="d-label-muted" font-size="10">70%</text>
  <line x1="56" y1="105.0" x2="620" y2="105.0" class="d-gridline"></line>
  <text x="48" y="109.0" text-anchor="end" class="d-label-muted" font-size="10">80%</text>
  <line x1="56" y1="62.5" x2="620" y2="62.5" class="d-gridline"></line>
  <text x="48" y="66.5" text-anchor="end" class="d-label-muted" font-size="10">90%</text>
  <line x1="56" y1="20.0" x2="620" y2="20.0" class="d-gridline"></line>
  <text x="48" y="24.0" text-anchor="end" class="d-label-muted" font-size="10">100%</text>
  <line x1="56" y1="190" x2="620" y2="190" class="d-axis"></line>
  <text x="56.0" y="206" text-anchor="middle" class="d-label-muted" font-size="10">13:56</text>
  <text x="150.0" y="206" text-anchor="middle" class="d-label-muted" font-size="10">14:00</text>
  <text x="244.0" y="206" text-anchor="middle" class="d-label-muted" font-size="10">14:04</text>
  <text x="338.0" y="206" text-anchor="middle" class="d-label-muted" font-size="10">14:08</text>
  <text x="432.0" y="206" text-anchor="middle" class="d-label-muted" font-size="10">14:12</text>
  <text x="526.0" y="206" text-anchor="middle" class="d-label-muted" font-size="10">14:16</text>
  <text x="620.0" y="206" text-anchor="middle" class="d-label-muted" font-size="10">14:20</text>
  <polyline points="56.0,40.8 79.5,41.7 103.0,41.2 126.5,40.4 150.0,41.7 173.5,41.2 197.0,40.8 201.0,41.2 215.8,90.5 220.5,94.0 244.0,103.7 267.5,111.4 291.0,117.8 314.5,123.7 338.0,128.8 361.5,133.9 385.0,138.1 408.5,142.0 432.0,145.4 455.5,148.4 479.0,150.9 502.5,153.0 526.0,154.7 549.5,156.0 573.0,157.3 596.5,158.1 620.0,159.0" class="d-series d-series-a"></polyline>
  <text x="620" y="151.0" text-anchor="end" class="d-series-label-a" font-size="11">67.3%</text>
</svg>
<div class="diagram-caption">Cache hit ratio: the share of reads the cache answered. The shaded strip is the database failover.</div>
</div>

## Investigate

Each panel is one place an engineer on call could look. Some matter and some don't. Open them in the order you would check them.

<details class="evidence">
<summary>Incoming traffic</summary>

About 52,000 requests a second are arriving, the same as last Tuesday at this time. There is no spike, and no single client is sending more than usual.

</details>

<details class="evidence">
<summary>Recent changes</summary>

```
13:40  web-frontend  deploy  static assets only (CSS, images)
14:02  database      maint   planned failover to patch the database
                             no reads or writes 14:02:10 – 14:02:48
       (nothing since)
```

</details>

<details class="evidence">
<summary>Cache cluster</summary>

| | 13:55 | 14:20 |
|---|---|---|
| Nodes healthy | 40 / 40 | 40 / 40 |
| Failovers | 0 | 0 |
| Time to answer a GET (p99) | 0.4ms | 0.4ms |
| Busiest node CPU | 41% | 37% |
| Keys stored | 498M | 431M |

No node is overloaded, nothing restarted, and the cache answers as quickly as ever. It holds fewer keys than it did.

</details>

<details class="evidence">
<summary>Database</summary>

<div class="diagram-wrap">
<svg viewBox="0 0 640 250" width="640" height="250" role="img" aria-label="Database queries per second from 13:56 to 14:20: executed and answered-in-time both near 90 thousand until the failover; afterwards executed stays near 148 thousand while answered in time falls to about 11 thousand">
  <rect x="201.0" y="20" width="14.8" height="170" class="d-band"></rect>
  <text x="220.8" y="30" class="d-label-muted" font-size="9">DB failover 14:02:10–14:02:48</text>
  <line x1="56" y1="147.5" x2="620" y2="147.5" class="d-gridline"></line>
  <text x="48" y="151.5" text-anchor="end" class="d-label-muted" font-size="10">50K</text>
  <line x1="56" y1="105.0" x2="620" y2="105.0" class="d-gridline"></line>
  <text x="48" y="109.0" text-anchor="end" class="d-label-muted" font-size="10">100K</text>
  <line x1="56" y1="62.5" x2="620" y2="62.5" class="d-gridline"></line>
  <text x="48" y="66.5" text-anchor="end" class="d-label-muted" font-size="10">150K</text>
  <line x1="56" y1="20.0" x2="620" y2="20.0" class="d-gridline"></line>
  <text x="48" y="24.0" text-anchor="end" class="d-label-muted" font-size="10">200K</text>
  <line x1="56" y1="62.5" x2="620" y2="62.5" class="d-marker-line"></line>
  <text x="60" y="57.5" class="d-label-muted" font-size="9">capacity ~150K/s</text>
  <line x1="56" y1="190" x2="620" y2="190" class="d-axis"></line>
  <text x="56.0" y="206" text-anchor="middle" class="d-label-muted" font-size="10">13:56</text>
  <text x="150.0" y="206" text-anchor="middle" class="d-label-muted" font-size="10">14:00</text>
  <text x="244.0" y="206" text-anchor="middle" class="d-label-muted" font-size="10">14:04</text>
  <text x="338.0" y="206" text-anchor="middle" class="d-label-muted" font-size="10">14:08</text>
  <text x="432.0" y="206" text-anchor="middle" class="d-label-muted" font-size="10">14:12</text>
  <text x="526.0" y="206" text-anchor="middle" class="d-label-muted" font-size="10">14:16</text>
  <text x="620.0" y="206" text-anchor="middle" class="d-label-muted" font-size="10">14:20</text>
  <polyline points="56.0,114.3 79.5,112.6 103.0,113.5 126.5,111.8 150.0,113.5 173.5,114.3 197.0,113.5 201.0,113.5 201.7,190.0 215.3,190.0 215.8,65.9 220.5,64.2 244.0,65.0 267.5,64.2 291.0,63.3 314.5,65.0 338.0,64.2 361.5,64.2 385.0,65.0 408.5,64.2 432.0,63.3 455.5,64.2 479.0,65.0 502.5,64.2 526.0,64.2 549.5,65.0 573.0,64.2 596.5,64.2 620.0,64.2" class="d-series d-series-a"></polyline>
  <polyline points="56.0,114.3 79.5,112.6 103.0,113.5 126.5,111.8 150.0,113.5 173.5,114.3 197.0,113.5 201.0,113.5 201.7,190.0 215.3,190.0 215.8,108.4 220.5,138.2 244.0,163.7 267.5,174.7 291.0,178.9 314.5,179.8 338.0,180.7 361.5,180.7 385.0,180.7 408.5,179.8 432.0,180.7 455.5,180.7 479.0,181.5 502.5,180.7 526.0,180.7 549.5,180.7 573.0,181.5 596.5,180.7 620.0,180.7" class="d-series d-series-b"></polyline>
  <line x1="140" y1="236" x2="160" y2="236" class="d-series d-series-a"></line>
  <text x="166" y="240" class="d-label" font-size="11">queries executed by the database</text>
  <line x1="370" y1="236" x2="390" y2="236" class="d-series d-series-b"></line>
  <text x="396" y="240" class="d-label" font-size="11">answers that reached the app in time</text>
</svg>
<div class="diagram-caption">Blue: queries the database ran. Orange: answers that got back to the app before the app stopped waiting.</div>
</div>

- **The database itself** is healthy. Same hardware, no errors.
- **The queries** are the same simple lookups as before the failover. Each one takes about 5ms once it starts running.
- **The waiting line.** Queries from the app servers queue in a connection pooler in front of the database, and are run in the order they arrived. Right now about 410,000 queries are in that line, against fewer than 100 normally. A query waits about **2.7 seconds** before it starts running.

</details>

<details class="evidence">
<summary>App server logs</summary>

One request, followed from start to finish:

```
14:11:02.114  GET /product/88213   cache MISS product:88213
14:11:02.114  db read product:88213   attempt 1
14:11:03.115  db read product:88213   TIMEOUT after 1000ms, retrying
14:11:03.166  db read product:88213   attempt 2
14:11:04.167  db read product:88213   TIMEOUT after 1000ms, retrying
14:11:04.218  db read product:88213   attempt 3
14:11:05.219  db read product:88213   TIMEOUT after 1000ms, giving up
14:11:05.219  cache fill skipped for product:88213 (no value)
14:11:05.220  503 /product/88213   3106ms
```

Counters for the last minute on this server:

```
cache reads    hit 67.4%   miss 32.6%
coalescing     2.1K requests shared another request's fetch (out of 1.9M misses)
db calls       ok 7.9%   timed out 92.1%
```

</details>

## Your turn

Write your answers down before opening anything below.

1. **The failover ended at 14:02:48. Why is the site still broken at 14:20?** Look for what is *keeping* it broken, not just what started it.
2. **What would you do in the next five minutes?**
3. **What would you change so the next 40-second failover goes unnoticed?**

<div class="drill-notes">
<label for="drill-notes-input">Your notes</label>
<textarea id="drill-notes-input" rows="7" placeholder="What keeps it broken, what you'd do now, what you'd change…"></textarea>
<div class="drill-notes-hint">Saved in this browser only.</div>
</div>

### Stuck?

<details class="hint">
<summary><span class="reveal-step">1</span> Hint</summary>

The hit ratio is still falling at 14:20, long after the database came back. For a key to get back into the cache, a request has to miss, fetch the value from the database, and write it into the cache. Which part of that is failing?

</details>

<details class="hint">
<summary><span class="reveal-step">2</span> Hint</summary>

Open the database panel and compare the two lines. The database is busy. How many of its answers actually reach the app?

</details>

<details class="hint">
<summary><span class="reveal-step">3</span> Hint</summary>

Two numbers: how long the app waits for an answer (the log), and how long a query waits in line before it runs (the database panel).

</details>

## Reveal

Open these in order.

<details class="reveal">
<summary><span class="reveal-step">1</span> Root cause</summary>

**The failover started the problem. A loop keeps it going.**

*The picture first.* A kitchen can cook 150 orders a minute. It normally gets 90, because most customers take something ready-made from the counter. Ready-made items are thrown out after 5 minutes and remade on the next order. The kitchen closes for 40 seconds. Items go off and nobody can remake them, so when the kitchen reopens the counter is emptier, and 300 orders a minute arrive at a kitchen that can cook 150. A line forms. Each customer waits one second and leaves, but the kitchen still cooks their order, in the order it came in. Every dish goes to someone who has already gone, so nothing gets restocked on the counter. Meanwhile more items go off. Customers who left order again, twice, which makes the line longer. The kitchen is cooking at full speed and nobody gets fed.

*The same thing in this system.*

- **What the failover did.** Cached values expire all the time, and the next read normally refills them. For 38 seconds, nothing could be refilled. About 13% of the cache went cold, and the hit ratio fell from 95% to about 83%. That means about **300,000 reads a second reaching a database that can handle 150,000.**
- **Why it never recovered.** The database works at full speed, but twice as many queries arrive as it can run, so the line grows until a query waits 2.7 seconds to start. The app gives up after 1 second. Almost every answer arrives after the app has stopped waiting, so it is thrown away and never written into the cache. The cold keys stay cold, and more keys expire and join them, so the hit ratio keeps falling.
- **What makes it worse.** Each timed-out call is retried twice, and every retry joins the back of the same line.

<div class="diagram-wrap">
<svg viewBox="0 0 560 300" width="560" height="300" role="img" aria-label="A loop: the hit ratio falls, more reads reach the database, the line grows past the timeout, answers arrive too late to refill the cache, and the hit ratio falls further. A 38-second failover started it.">
  <rect x="185" y="20" width="190" height="50" rx="6" class="d-actor-box" data-role="cache"></rect>
  <text x="280" y="41" text-anchor="middle" class="d-actor-label" font-size="12">Hit ratio falls</text>
  <text x="280" y="57" text-anchor="middle" class="d-label-muted" font-size="9">keys expire and are not refilled</text>
  <rect x="360" y="125" width="190" height="50" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="455" y="146" text-anchor="middle" class="d-actor-label" font-size="12">More reads hit the DB</text>
  <text x="455" y="162" text-anchor="middle" class="d-label-muted" font-size="9">~300K/s arrive, ~150K/s possible</text>
  <rect x="185" y="230" width="190" height="50" rx="6" class="d-actor-box" data-role="datastore"></rect>
  <text x="280" y="251" text-anchor="middle" class="d-actor-label" font-size="12">The line grows</text>
  <text x="280" y="267" text-anchor="middle" class="d-label-muted" font-size="9">waiting time passes the 1s timeout</text>
  <rect x="10" y="125" width="190" height="50" rx="6" class="d-actor-box" data-role="routing"></rect>
  <text x="105" y="146" text-anchor="middle" class="d-actor-label" font-size="12">Answers arrive too late</text>
  <text x="105" y="162" text-anchor="middle" class="d-label-muted" font-size="9">no cache refill · retries join the line</text>
  <line x1="375" y1="55" x2="430" y2="121" class="d-msg d-request" marker-end="url(#arrowDr1)"></line>
  <line x1="430" y1="179" x2="375" y2="236" class="d-msg d-request" marker-end="url(#arrowDr1)"></line>
  <line x1="185" y1="236" x2="130" y2="179" class="d-msg d-request" marker-end="url(#arrowDr1)"></line>
  <line x1="130" y1="121" x2="185" y2="55" class="d-msg d-request" marker-end="url(#arrowDr1)"></line>
  <rect x="215" y="128" width="130" height="42" rx="6" class="d-note"></rect>
  <text x="280" y="146" text-anchor="middle" class="d-note-text" font-size="11">38s failover</text>
  <text x="280" y="161" text-anchor="middle" class="d-note-text" font-size="10">started it, then ended</text>
  <line x1="280" y1="126" x2="280" y2="76" class="d-marker-line" marker-end="url(#arrowDr1)"></line>
  <defs>
    <marker id="arrowDr1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">Each step makes the next one worse. Removing what started it does not stop the loop.</div>
</div>

The clue was in the database chart: it runs 148,000 queries a second, and only about 11,000 answers reach the app in time. A system that does full work with almost no useful result can stay broken without any new cause. This is called a **metastable failure**: the system can rest in a healthy state or a broken one, and a short shock pushed it from the first to the second.

**The red herrings.** The cache is fine: it lost no data and answers in 0.4ms. Its key count is falling because keys expire and are never refilled. Traffic is normal, and the 13:40 deploy only touched images and CSS. **Request coalescing doesn't help either.** It merges many requests for the *same* key into one fetch, which stops a crowd of requests for one popular key. This crowd is spread over millions of different keys, a few requests each, so there is almost nothing to merge.

</details>

<details class="reveal">
<summary><span class="reveal-step">2</span> The fixes most people try first</summary>

Each of these sounds reasonable. None of them stops the loop.

- **Restart the database.** The line empties for a moment, then fills again within seconds, because 300,000 reads a second still arrive at a database that can run 150,000. The restart is also another stretch with no refills.
- **Raise the app's timeout from 1s to 10s.** More answers arrive "in time", but pages now take many seconds, and the line keeps growing until it passes 10 seconds as well.
- **Restart the cache to reset it.** The hit ratio goes from 67% to 0%, and every read now goes to the database.
- **Add database capacity.** This is reasonable long term, but a new database replica needs a full copy of the data before it can help, which takes far longer than this incident should last.
- **Make cache TTLs much longer.** With a 30-minute TTL, the same 38 seconds would have cooled about 2% of the cache instead of 13%, and the loop might never have started. That helps next time, but it does nothing now, and every value becomes up to six times staler on an ordinary day.

All of these treat the failover as the problem. The failover is over. The loop is the problem.

</details>

<details class="reveal">
<summary><span class="reveal-step">3</span> Right now: stop the loop</summary>

The loop needs one condition: **more reads arrive than the database can answer before the app gives up.** Remove that, even briefly, and the loop runs backwards. Answers arrive in time and refill the cache. The most popular keys refill first, because they are requested most. Each refill means fewer misses, so the line gets shorter, so more answers arrive in time.

Start with the levers that hurt users least:

1. **Turn off retries.** On their own, they can triple what arrives at the database.
2. **Turn off non-essential page features**, such as recommendations or "recently viewed". Fewer reads per page means fewer misses.
3. **Empty the waiting line.** The 410,000 queued queries belong to requests that gave up long ago.
4. **If that isn't enough, turn some traffic away** at the load balancer with a fast error page, until database waits drop under about 100ms. Rejecting some users so the rest succeed feels backwards, but right now *every* user fails a third of the time with no end in sight. Once the hit ratio is back above about 93%, let traffic back in a step at a time.

Once the loop reverses, recovery usually takes a few minutes.

</details>

<details class="reveal">
<summary><span class="reveal-step">4</span> The right fix</summary>

There are two parts. The first stops the loop from forming. The second removes the reason the cache went cold at all.

**Part 1: never let the line get long.**

- **Cap database calls per app server**, for example 300 at a time. A miss that finds the cap full fails immediately instead of waiting in line. The line stays short, so every answer arrives in time and refills the cache. Under overload, a few page sections fail quickly while everything else works, instead of everything failing slowly.
- **Replace "retry twice" with a retry budget**: retries are allowed only while they stay under about 10% of calls. When everything is failing, retries switch off on their own.
- **Send the app's deadline with each query.** The pooler can then drop a query whose caller has already given up, instead of running it. That alone would have turned 148,000 wasted queries a second into 148,000 useful ones.

**Part 2: don't throw away values you can't replace.** The cached data was not wrong during the failover. It was only old. The design deleted it on a timer at the one moment nothing could replace it. Instead, give each value two times:

```
SET product:7 {value, fresh_until: now+300s} EX 3600
```

- Before `fresh_until`, serve it as normal.
- After `fresh_until`, **keep serving it**, and let *one* request fetch a fresh copy in the background. If the database is down, that fetch fails and the old value keeps being served.

With this in place, the 38-second failover changes nothing. The hit ratio stays at 95%, and some values are up to 38 seconds older than usual. This pattern is called **stale-while-revalidate**, and it is the same idea as the HTTP `Cache-Control` directive of that name.

What it costs:

- **More memory**, because values stay longer.
- **Older data during an outage.** That is fine for product pages, and not for an account balance, so keys like that opt out and keep a hard expiry.
- **Nothing for writes.** An update still deletes the key immediately. Only expiry on a timer changes.

**How to catch it next time:**

- Alert when the **hit ratio falls while every cache node is healthy**. That means the cache isn't being refilled, not that it broke.
- Alert when **answers that reach the app on time** drop well below **queries the database runs**.
- Rehearse: fail over the database under realistic load before a real failover, and check that the hit ratio comes back within two minutes.

</details>

## Concepts used

- [Caching](#/systems/caching): cache-aside, TTLs, and how the hit ratio protects a database
- [Rate Limiting](#/systems/rate-limiting): admitting only the work a system can finish
- [Observability](#/systems/observability): measuring useful work, not just total work
- [Distributed Cache](#/systems-case-studies/distributed-cache): the design this drill runs on
