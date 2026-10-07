# Distributed Job Scheduler

A job scheduler runs things at a time. Rebuild the search index every night at 2:00. Charge the subscriptions that renew today. Send each user their morning digest at 8:00 in their own time zone. Each one sounds simple, and a single machine running cron handles it for years. The hard part is that "at a time" carries a promise most people never say out loud: the job runs once at that time. Not zero times because the machine was rebooting at 2:00. Not twice because two machines both thought it was their turn. Not at 2:11 because thirty million other jobs were also due on the hour. This case study builds a scheduler that keeps the promise while machines fail, leaders change and clocks reach the top of the hour.

<!-- tab:requirements:Requirements -->

## Requirements

This case study builds a scheduler run as a shared platform inside a large company. Teams register schedules; the scheduler decides when each one is due and hands the work to the company's [Distributed Task Queue](#/systems-case-studies/distributed-task-queue), whose workers run it.

### Functional requirements

- **Create, edit, pause, resume and delete schedules.** A schedule has a cron expression (`0 2 * * *`) or a fixed interval, a named time zone, and a target: a queue, a task type and a payload.
- **One run per scheduled time.** Each time a schedule comes due, exactly one task is put on its target queue.
- **Misfire policy.** If runs were missed — the scheduler was down, or the schedule was paused — the owner chooses whether to run each missed time, run once to catch up, or skip them.
- **Overlap policy.** If the previous run hasn't finished when the next one is due, the owner chooses whether to start it anyway, skip it, or hold it until the previous one finishes.
- **Spread windows.** A schedule that doesn't need an exact moment ("hourly, any time in the hour") can let the scheduler pick a stable offset.
- **Run now.** An owner can trigger a run manually.
- **Run history**: for each run, its scheduled time, when it was fired, its task and how it ended.

### Non-functional requirements

- **Never miss a run.** Every scheduled time either produces a run or is recorded as skipped by the owner's own policy.
- **Never fire a run twice.** One scheduled time produces one task, through crashes and failovers. (The task queue then runs that task at least once; see its own case study.)
- **Accurate firing:** a run's task is ready within **2 seconds** of its scheduled time at p99, and within **15 seconds** while a scheduler machine is failing over.
- **Survives the loss of any machine or any one zone** without missing runs.
- **Schedule API availability: 99.9%.** Changing schedules can be briefly unavailable; firing them cannot.

### In scope

Storing schedules, computing fire times across time zones, firing exactly once, failover between scheduler machines, sharding, catching up missed runs, overlap handling, and the load spike at the top of every hour.

### Out of scope

**Running the jobs**, which is the task queue's and the owning teams' work. **Workflows** where one job starts only when others finish. **Sub-minute timers**: the shortest interval is one minute, and anything finer is a delayed task or a long-running process. **One-off tasks less than 30 days ahead**, which go straight onto the task queue as delayed tasks.

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

The average load is modest. What shapes the design is that people choose round numbers: most schedules fire on the hour, and a large share of them at midnight.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Schedules</div>
<div class="stat-tile-value">~50<span class="stat-tile-unit">M</span></div>
<div class="stat-tile-sub">active at once</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Runs fired</div>
<div class="stat-tile-value">~500<span class="stat-tile-unit">M/day</span></div>
<div class="stat-tile-sub">~5,800 a second on average</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Due in one second</div>
<div class="stat-tile-value">~12<span class="stat-tile-unit">M</span></div>
<div class="stat-tile-sub">at 00:00:00 UTC</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Peak to average</div>
<div class="stat-tile-value">~2,000<span class="stat-tile-unit">×</span></div>
<div class="stat-tile-sub">if fired exactly on time</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Run history</div>
<div class="stat-tile-value">~3<span class="stat-tile-unit">TB</span></div>
<div class="stat-tile-sub">30 days kept</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Fire accuracy</div>
<div class="stat-tile-value">2<span class="stat-tile-unit">s</span></div>
<div class="stat-tile-sub">p99, scheduled to ready</div>
</div>
</div>

### Assumptions

- **50 million schedules.** Most are created by products on behalf of their users — one daily digest per user, one renewal check per subscription — rather than by hand.
- **40 million** run daily, **7.5 million** hourly, **1 million** every 5 minutes. The remaining 1.5 million run weekly or monthly and barely register.
- About **3.5 million** of the daily schedules are set for midnight UTC.
- A schedule record is about **1KB**, including its payload. Payloads are capped at **64KB**.
- A run-history row is about **200 bytes**.

### Runs per day

- Daily: 40 million.
- Hourly: 7.5 million × 24 = 180 million.
- Every 5 minutes: 1 million × 288 = 288 million.

About **500 million runs a day**, or **~5,800 a second** on average.

### The top of the hour

The average hides the shape. Every hourly schedule set to `0 * * * *` fires at minute zero. Every five-minute schedule fires then too. At midnight UTC the 3.5 million daily schedules set for that time join them. That is **~12 million runs due in the same second**, about 2,000 times the average — and roughly 170 seconds of work for a task queue that peaks at 70,000 enqueues a second. Something in the design has to spread that out without breaking the 2-second accuracy target.

### Storage

- Schedules: 50 million × 1KB = **50GB**. Small enough for a few database clusters; the reason to split it is the write rate at peak, not the size.
- Run history: 500 million × 200 bytes = **100GB a day**, **~3TB** for 30 days.

### Holding the near future in memory

If each scheduler machine keeps the next 2 minutes of fires in memory, that is 5,800 × 120 ≈ **700,000 entries** across the fleet in a quiet minute, and up to 12 million just before midnight. At about 200 bytes each, that's at most **2.4GB**, spread across the machines.

<!-- tab:api-design:API Design -->

## API Design

Teams talk to the Schedule API. The scheduler talks to the task queue, using the queue's ordinary enqueue API.

### Schedules

```
POST /v1/schedules
Idempotency-Key: search-nightly-reindex-v1
{
  "name": "nightly-search-reindex",
  "cron": "0 2 * * *",
  "time_zone": "America/New_York",
  "target": {"queue": "search_reindex", "type": "reindex_all", "payload": {"index": "products"}},
  "misfire": "run_once",
  "overlap": "skip",
  "spread_s": 0
}
→ 201 {"schedule_id": "sch_4T9", "version": 1, "next_fire_at": "2026-10-07T06:00:00Z"}

PATCH  /v1/schedules/sch_4T9       If-Match: 12   {"cron": "0 3 * * *"}
                                   → 200 {"version": 13, "next_fire_at": "2026-10-07T07:00:00Z"}
POST   /v1/schedules/sch_4T9/pause
POST   /v1/schedules/sch_4T9/resume
DELETE /v1/schedules/sch_4T9
POST   /v1/schedules/sch_4T9/trigger → 202 {"run": {"scheduled_for": "2026-10-06T14:12:09Z", "task_id": "t_m02"}}
```

### Run history

```
GET /v1/schedules/sch_4T9/runs?limit=3
→ 200 {"runs": [
    {"scheduled_for": "2026-10-07T06:00:00Z", "fired_at": "…06:00:00.012Z", "task_id": "t_51", "outcome": "succeeded"},
    {"scheduled_for": "2026-10-06T06:00:00Z", "fired_at": "…06:00:09.870Z", "task_id": "t_44", "outcome": "succeeded"},
    {"scheduled_for": "2026-10-05T06:00:00Z", "fired_at": null,             "task_id": null,   "outcome": "skipped_overlap"}
  ]}
```

### What a worker receives

The task the scheduler enqueues is an ordinary task, with the schedule attached:

```
{"task_id": "t_51", "type": "reindex_all", "payload": {"index": "products"},
 "schedule": {"id": "sch_4T9", "scheduled_for": "2026-10-07T06:00:00Z"}}
```

| Code | Meaning |
|---|---|
| `201` | Schedule created; the response gives its first fire time |
| `200` | Schedule changed, or a create repeated with a known idempotency key |
| `202` | Manual run accepted and enqueued |
| `400` | Invalid cron expression, unknown time zone or unknown target |
| `403` | The caller may not enqueue to the target queue |
| `404` | No such schedule |
| `409` | `If-Match` version is out of date: someone else changed the schedule first |
| `422` | Fires more often than once a minute, or a payload over 64KB |
| `429` | Over the team's limit on schedules or on changes per second |

### Why the details matter

**A run is named by its scheduled time.** `sch_4T9` at `2026-10-07T06:00:00Z` is one run, whenever it is actually fired. The scheduler uses that pair as the task's idempotency key, so firing the same run twice enqueues one task.

**The time zone is a name, not an offset.** `America/New_York` is UTC−4 in summer and UTC−5 in winter. Storing `-04:00` would make a 2:00 job run at 1:00 every winter. The Deep Dives tab covers the two days a year when 2:00 happens zero times or twice.

**Workers are given `scheduled_for`.** A job that bills "yesterday" must work out which day that is from the scheduled time, not from the clock. After an outage, the run for 6 October may start on 7 October.

**Edits carry a version.** `If-Match: 12` means "change this only if nobody else has since". It also lets the scheduler notice, at fire time, that the schedule it was about to fire has changed.

**The target is a queue.** The scheduler never runs anyone's code. Retries, timeouts, leases and dead letters belong to the task queue, which already does them.

<!-- tab:data-model:Data Model -->

## Data Model

A scheduler's data is small and changes slowly, except for one column: when each schedule fires next. Everything is organized around finding the schedules due soonest.

### Schedules

```
schedules                                   -- split into 256 shards
  schedule_id         TEXT PRIMARY KEY
  shard               SMALLINT                -- hash(schedule_id) mod 256
  owner_team          TEXT
  tenant_id           TEXT
  name                TEXT
  cron                TEXT                    -- or interval_s
  time_zone           TEXT                    -- e.g. America/New_York
  target_queue        TEXT
  task_type           TEXT
  payload             BYTES                   -- up to 64KB
  misfire_policy      TEXT                    -- run_all | run_once | skip
  overlap_policy      TEXT                    -- allow | skip | queue
  spread_s            INT
  state               TEXT                    -- active | paused | deleted
  version             INT                     -- bumped by every edit
  next_scheduled_for  TIMESTAMP               -- the next run's name, in UTC
  next_fire_at        TIMESTAMP               -- when to fire it: scheduled time + spread offset
  last_task_id        TEXT                    -- for the overlap check
  pending_task_id     TEXT                    -- a run enqueued ahead of time, for cancelling
  INDEX due (shard, next_fire_at) WHERE state = 'active'
```

The `due` index is the heart of the scheduler: "which schedules in shard 3 fire before 06:01:30?" is one range scan.

### Runs

```
schedule_runs                               -- 30 days
  schedule_id      TEXT
  scheduled_for    TIMESTAMP
  fired_at         TIMESTAMP
  task_id          TEXT
  outcome          TEXT                       -- enqueued | succeeded | failed | dead
                                              -- | skipped_misfire | skipped_overlap
  PRIMARY KEY (schedule_id, scheduled_for)
```

The task carries its schedule ID and scheduled time, so when the queue reports that it finished, its outcome is written here.

### Shard ownership

```
shard_epochs                                -- one row per shard, in the shard's own database
  shard     SMALLINT PRIMARY KEY
  epoch     BIGINT                            -- raised by each new owner
```

Which machine owns which shard lives in the coordination service. The database keeps only the current epoch, so it can refuse writes from an owner that has been replaced.

### Why this storage

A sharded relational database: 16 clusters, each holding 16 of the 256 shards, each with a primary and a synchronous replica in another zone ([Partitioning & Sharding](#/systems/partitioning-sharding), [Replication](#/systems/replication)). The write rate is low — about two writes per fire, so ~12,000 a second on average — and the workload needs exactly what relational databases do well: conditional updates ("advance this schedule only if its version is still 12"), small transactions, and a sorted index scanned by range ([Relational Databases](#/systems/databases-relational)). The midnight spike would be a problem for any store; Stage 5 spreads it out before it reaches the database.

<!-- tab:architecture:Architecture:default -->

This case study builds the scheduler up in five stages. Each stage fixes a specific failure of the one before. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one run at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. A Crontab -->

## Stage 1 — A Crontab on One Server

The smallest version that works: one server, its cron daemon, and a crontab with a line per job. Cron wakes every minute, checks each line against the clock, and starts the scripts that match. The scripts run on the same machine.

```
CRON_TZ=America/New_York
# m  h  dom mon dow   command
  0  2  *   *   *     /opt/jobs/reindex.sh
  */5 * *   *   *     /opt/jobs/renew.sh
```

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 780 290" width="780" height="290" role="img" aria-label="A cron server runs a reindex script against a search cluster and a renewal script against a billing database and a payment provider">
  <g data-fail-toggle="cron1">
    <rect x="40" y="100" width="190" height="80" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="135" y="125" text-anchor="middle" class="d-actor-label" font-size="12">Cron Server</text>
    <text x="135" y="142" text-anchor="middle" class="d-label-muted" font-size="9">crontab · jobs run here</text>
    <text x="135" y="157" text-anchor="middle" class="d-label-muted" font-size="9">0 2 * * * reindex.sh</text>
    <text x="135" y="170" text-anchor="middle" class="d-label-muted" font-size="9">*/5 * * * * renew.sh</text>
  </g>
  <g data-fail-toggle="srch1">
    <rect x="520" y="20" width="200" height="50" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="620" y="50" text-anchor="middle" class="d-actor-label" font-size="12">Search Cluster</text>
  </g>
  <rect x="520" y="115" width="200" height="50" rx="6" class="d-actor-box" data-role="datastore"></rect>
  <text x="620" y="145" text-anchor="middle" class="d-actor-label" font-size="12">Billing Database</text>
  <rect x="520" y="210" width="200" height="50" rx="6" class="d-actor-box"></rect>
  <text x="620" y="240" text-anchor="middle" class="d-actor-label" font-size="12">Payment Provider</text>
  <line id="j1-cron-search" x1="232" y1="112" x2="516" y2="40" class="d-msg d-request" data-depends-on="cron1 srch1" marker-end="url(#arrowJ1)"></line>
  <line id="j1-search-cron" x1="516" y1="58" x2="232" y2="126" class="d-msg d-response" data-depends-on="cron1 srch1" marker-end="url(#arrowJ1r)"></line>
  <line id="j1-cron-bill" x1="232" y1="134" x2="516" y2="134" class="d-msg d-request" data-depends-on="cron1" marker-end="url(#arrowJ1)"></line>
  <line id="j1-bill-cron" x1="516" y1="150" x2="232" y2="150" class="d-msg d-response" data-depends-on="cron1" marker-end="url(#arrowJ1r)"></line>
  <line id="j1-cron-pay" x1="232" y1="162" x2="516" y2="228" class="d-msg d-request" data-depends-on="cron1" marker-end="url(#arrowJ1)"></line>
  <line id="j1-pay-cron" x1="516" y1="246" x2="232" y2="174" class="d-msg d-response" data-depends-on="cron1" marker-end="url(#arrowJ1r)"></line>
  <text x="390" y="282" text-anchor="middle" class="d-label-muted" font-size="10">play the nightly run, then the reboot, then the slow renewal run</text>
  <defs>
    <marker id="arrowJ1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowJ1r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "cron", "title": "Cron server", "rows": [["reindex last ran", "—"], ["renew.sh copies running", "—"]]},
{"id": "out", "title": "What users see", "rows": [["search index", "—"], ["charges for sub_77", "—"]]}
],
"flows": [
{
"id": "nightly",
"label": "The nightly reindex runs",
"nodes": ["cron1", "srch1"],
"steps": [
{"el": "j1-cron-search", "payload": "02:00 · reindex.sh starts", "set": {"cron.reindex last ran": "yesterday 02:00", "out.search index": "built yesterday"}, "text": "At 02:00 New York time the cron daemon finds that the line 0 2 * * * matches the clock, and starts reindex.sh on this same machine. The script tells the search cluster to rebuild the product index."},
{"el": "j1-search-cron", "payload": "rebuilt", "set": {"cron.reindex last ran": "today 02:00", "out.search index": "fresh as of 02:40"}, "text": "Forty minutes later the rebuild is done, and products added yesterday show up in search. This setup can run happily for years. The next two flows show the two ways it eventually fails."}
]
},
{
"id": "reboot",
"label": "The server is down at 02:00",
"nodes": ["cron1", "srch1"],
"steps": [
{"el": "j1-cron-search", "payload": "(rebooting for patches)", "set": {"cron.reindex last ran": "yesterday 02:00", "out.search index": "built yesterday"}, "text": "The server is rebooted for security patches at 01:58. It is back at 02:04."},
{"el": "j1-cron-search", "payload": "02:04 · cron starts", "text": "Cron starts up and reads its crontab. For each line it works out the next time it matches: for reindex.sh, tomorrow at 02:00. Cron keeps no record of what it ran or meant to run, so it has no way to know tonight's run never happened."},
{"el": "j1-search-cron", "payload": "(nothing)", "set": {"out.search index": "a day stale"}, "text": "The index isn't rebuilt. Yesterday's new products can't be found until tomorrow night. There is no error and no alert: a job that never starts can't fail. Fail the cron server and replay the first flow — and if the machine is lost for good, so is the list of jobs, because it only ever lived in this one crontab."}
]
},
{
"id": "overlap",
"label": "A run takes longer than its interval",
"nodes": ["cron1"],
"steps": [
{"el": "j1-cron-bill", "payload": "00:00 · run 1: due renewals?", "set": {"cron.renew.sh copies running": "1", "out.charges for sub_77": "0"}, "text": "renew.sh runs every five minutes. It finds subscriptions due for renewal, charges each one, then marks it renewed. On a normal day it takes a minute."},
{"el": "j1-bill-cron", "payload": "1,200 due", "text": "Today is the first of the month: 1,200 renewals are due at once. At this pace, run 1 will take about seven minutes. sub_77 is near the end of its list."},
{"el": "j1-cron-bill", "payload": "00:05 · run 2: due renewals?", "set": {"cron.renew.sh copies running": "2"}, "text": "At 00:05 cron starts renew.sh again. It neither knows nor cares that run 1 is still going."},
{"el": "j1-bill-cron", "payload": "~400 due, incl. sub_77", "text": "Run 1 has renewed about 800. The other 400, sub_77 among them, are still marked as due, so run 2 is given them too."},
{"el": "j1-cron-pay", "payload": "charge sub_77 (run 1)", "set": {"out.charges for sub_77": "1"}, "text": "Run 1 reaches sub_77 and charges it."},
{"el": "j1-cron-pay", "payload": "charge sub_77 (run 2)", "set": {"out.charges for sub_77": "2"}, "text": "A few seconds later, run 2 reaches it too, before run 1 has marked it renewed. The customer is charged twice. The usual fix is a lock file the script checks on start — which works until the job is moved to a second server for safety, and the two servers don't share a disk."}
]
}
]
}
</script>
<div class="diagram-caption">One machine holds the list of jobs, decides when each is due, and runs them. It keeps no record of runs, so a run missed while it was down is never noticed, and it starts a job on time even if the previous run hasn't finished.</div>
</div>

<div class="fail-hint">Click the cron server or the search cluster to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="cron1">
<strong>If the cron server fails:</strong> every job stops, and every run due while it is down is lost without a trace. If the disk is lost too, so is the crontab: nobody has a complete list of what was supposed to run. Running a second copy of the server for safety makes every job run twice.
</div>
<div class="failure-impact is-hidden" data-component="srch1">
<strong>If the search cluster fails:</strong> reindex.sh fails at 02:00. Cron doesn't retry it. Its output is mailed to a local account on the cron server that nobody reads, so the failure is found when someone notices search results are a day old.
</div>
</div>

A crontab mixes three jobs into one machine: remembering the schedules, deciding when each is due, and running the work. Losing the machine loses all three, and none of them is recorded anywhere. The next stage separates them.

<!-- stage:2:2. Schedules in a Database -->

## Stage 2 — Schedules in a Database, Fired into a Queue

Three changes.

- **Schedules live in a database**, each with its next fire time stored in `next_fire_at` and indexed. They are created through an API, so the list of jobs no longer depends on any one machine.
- **A scheduler process only decides when.** Once a second it asks the database for schedules whose `next_fire_at` has passed. For each one it enqueues a task on the [Distributed Task Queue](#/systems-case-studies/distributed-task-queue), then moves `next_fire_at` to the next matching time. Workers run the task, with the queue's retries and leases.
- **Every run has a name**: the schedule and its scheduled time, like `sch_4T9@2026-10-07T06:00Z`. That name is the enqueue's idempotency key and the run-history row's key.

The order of the two writes matters, and the second flow shows why: **enqueue first, then advance.**

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 800 320" width="800" height="320" role="img" aria-label="An owning team creates schedules through a schedule API into a schedules database; a scheduler process reads due schedules and enqueues tasks into a task queue; workers claim tasks from the queue">
  <rect x="10" y="40" width="120" height="44" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="70" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Owning Team</text>
  <rect x="170" y="40" width="130" height="44" rx="6" class="d-actor-box" data-role="routing"></rect>
  <text x="235" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Schedule API</text>
  <g data-fail-toggle="db2">
    <rect x="340" y="30" width="180" height="64" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="430" y="54" text-anchor="middle" class="d-actor-label" font-size="12">Schedules DB</text>
    <text x="430" y="71" text-anchor="middle" class="d-label-muted" font-size="9">index on next_fire_at</text>
    <text x="430" y="84" text-anchor="middle" class="d-label-muted" font-size="9">run history</text>
  </g>
  <g data-fail-toggle="sch2">
    <rect x="340" y="210" width="180" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="430" y="236" text-anchor="middle" class="d-actor-label" font-size="12">Scheduler</text>
    <text x="430" y="253" text-anchor="middle" class="d-label-muted" font-size="9">one process · checks every 1s</text>
  </g>
  <g data-fail-toggle="tq2">
    <rect x="590" y="210" width="180" height="60" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="680" y="236" text-anchor="middle" class="d-actor-label" font-size="12">Task Queue</text>
    <text x="680" y="253" text-anchor="middle" class="d-label-muted" font-size="9">dedups by idempotency key</text>
  </g>
  <g data-fail-toggle="wk2">
    <rect x="605" y="40" width="150" height="44" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="680" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Workers</text>
  </g>
  <line id="j2-team-api" x1="132" y1="56" x2="166" y2="56" class="d-msg d-request" marker-end="url(#arrowJ2)"></line>
  <line id="j2-api-team" x1="166" y1="72" x2="132" y2="72" class="d-msg d-response" marker-end="url(#arrowJ2r)"></line>
  <line id="j2-api-db" x1="302" y1="56" x2="336" y2="56" class="d-msg d-request" data-depends-on="db2" marker-end="url(#arrowJ2)"></line>
  <line id="j2-db-api" x1="336" y1="72" x2="302" y2="72" class="d-msg d-response" data-depends-on="db2" marker-end="url(#arrowJ2r)"></line>
  <line id="j2-sch-db" x1="410" y1="206" x2="410" y2="98" class="d-msg d-request" data-depends-on="sch2 db2" marker-end="url(#arrowJ2)"></line>
  <line id="j2-db-sch" x1="450" y1="98" x2="450" y2="206" class="d-msg d-response" data-depends-on="sch2 db2" marker-end="url(#arrowJ2r)"></line>
  <line id="j2-sch-tq" x1="522" y1="232" x2="586" y2="232" class="d-msg d-request" data-depends-on="sch2 tq2" marker-end="url(#arrowJ2)"></line>
  <line id="j2-tq-sch" x1="586" y1="250" x2="522" y2="250" class="d-msg d-response" data-depends-on="sch2 tq2" marker-end="url(#arrowJ2r)"></line>
  <line id="j2-wk-tq" x1="665" y1="88" x2="665" y2="206" class="d-msg d-request" data-depends-on="wk2 tq2" marker-end="url(#arrowJ2)"></line>
  <line id="j2-tq-wk" x1="695" y1="206" x2="695" y2="88" class="d-msg d-response" data-depends-on="wk2 tq2" marker-end="url(#arrowJ2r)"></line>
  <text x="400" y="305" text-anchor="middle" class="d-label-muted" font-size="10">play the first fire, then the crash, then the outage, then the overlap</text>
  <defs>
    <marker id="arrowJ2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowJ2r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "sch", "title": "Schedules table", "rows": [["sch_4T9 next fire", "—"], ["sch_bil next fire", "—"]]},
{"id": "q", "title": "Task queue", "rows": [["tasks for this run", "—"]]},
{"id": "runs", "title": "Run history", "rows": [["latest", "—"]]}
],
"flows": [
{
"id": "fire",
"label": "Create a schedule; it fires",
"nodes": ["db2", "sch2", "tq2", "wk2"],
"steps": [
{"el": "j2-team-api", "payload": "POST · 0 2 * * * · America/New_York", "set": {"sch.sch_4T9 next fire": "—", "q.tasks for this run": "—", "runs.latest": "—"}, "text": "The search team registers the nightly reindex: cron 0 2 * * *, New York time, target queue search_reindex."},
{"el": "j2-api-db", "payload": "insert · next fire 06:00Z", "set": {"sch.sch_4T9 next fire": "Oct 7, 06:00Z"}, "text": "The API checks the cron expression and works out the next fire time. 02:00 in New York on 7 October is 06:00 UTC, since New York is on summer time. Everything stored is in UTC; the time zone is kept to compute the next one."},
{"el": "j2-db-api", "payload": "stored", "ms": 4, "text": "Stored, as sch_4T9."},
{"el": "j2-api-team", "payload": "201 sch_4T9", "text": "The team gets the schedule ID and its first fire time."},
{"el": "j2-sch-db", "payload": "due at or before now?", "text": "At 06:00:00 UTC the scheduler runs its once-a-second query: active schedules whose next_fire_at has passed, in order."},
{"el": "j2-db-sch", "payload": "sch_4T9 for 06:00Z", "ms": 2, "text": "sch_4T9 is due."},
{"el": "j2-sch-tq", "payload": "enqueue · key sch_4T9@06:00Z", "text": "The scheduler doesn't run the reindex. It enqueues a task on search_reindex, carrying the schedule ID and scheduled time, with an idempotency key built from the two."},
{"el": "j2-tq-sch", "payload": "201 t_51", "ms": 6, "set": {"q.tasks for this run": "1 (t_51)"}, "text": "The queue stores the task durably."},
{"el": "j2-sch-db", "payload": "advance → Oct 8 06:00Z", "ms": 2, "set": {"sch.sch_4T9 next fire": "Oct 8, 06:00Z", "runs.latest": "sch_4T9@06:00Z → t_51"}, "text": "Only now does the scheduler move next_fire_at to tomorrow and record the run. The next flow shows why it waits until the queue has the task."},
{"el": "j2-wk-tq", "payload": "claim", "text": "One of the search team's workers is long-polling the queue."},
{"el": "j2-tq-wk", "payload": "t_51 · scheduled_for 06:00Z", "ms": 3, "text": "It gets the task. If the search cluster is down, the queue retries with backoff, and a task that can never succeed ends up in its dead-letter queue — the scheduler doesn't have to know how. Stage 1's reindex.sh had none of this."}
]
},
{
"id": "crash",
"label": "The scheduler crashes between the two writes",
"nodes": ["db2", "sch2", "tq2"],
"steps": [
{"el": "j2-sch-db", "payload": "due at or before now?", "set": {"sch.sch_bil next fire": "00:05Z", "q.tasks for this run": "—", "runs.latest": "—"}, "text": "sch_bil is the subscription-renewal job from Stage 1, now a schedule: every five minutes, overlap policy skip. It's 00:05:00."},
{"el": "j2-db-sch", "payload": "sch_bil for 00:05Z", "ms": 2, "text": "It's due."},
{"el": "j2-sch-tq", "payload": "enqueue · key sch_bil@00:05Z", "text": "The scheduler enqueues the run."},
{"el": "j2-tq-sch", "payload": "201 t_60", "ms": 6, "set": {"q.tasks for this run": "1 (t_60)"}, "text": "The queue has it."},
{"el": "j2-sch-db", "payload": "(process killed)", "text": "Before the scheduler can advance next_fire_at, its process is killed. The task is in the queue, but the database still says sch_bil is due for 00:05."},
{"el": "j2-sch-db", "payload": "due? (restarted, 00:05:20)", "text": "The process is restarted twenty seconds later and runs its query."},
{"el": "j2-db-sch", "payload": "sch_bil for 00:05Z", "ms": 2, "text": "sch_bil is still due for 00:05, because that write never happened."},
{"el": "j2-sch-tq", "payload": "enqueue · key sch_bil@00:05Z", "text": "The scheduler fires it again, with the same name — the same idempotency key."},
{"el": "j2-tq-sch", "payload": "200 · existing t_60", "ms": 2, "set": {"q.tasks for this run": "still 1 (t_60)"}, "text": "The queue recognizes the key and returns the task it already has. One run, one task."},
{"el": "j2-sch-db", "payload": "advance → 00:10Z", "ms": 2, "set": {"sch.sch_bil next fire": "00:10Z", "runs.latest": "sch_bil@00:05Z → t_60"}, "text": "Now it advances. The other order would lose runs: advance first, crash before enqueueing, and nothing will ever fire 00:05 again, because the database says it's done. Enqueue first, and a crash leads to a repeat — which the key makes harmless. A lost run can't be detected; a repeated one can."}
]
},
{
"id": "outage",
"label": "Down for twelve minutes — catching up",
"nodes": ["db2", "sch2", "tq2"],
"steps": [
{"el": "j2-sch-db", "payload": "due? (back at 00:15:10)", "set": {"sch.sch_bil next fire": "00:05Z", "q.tasks for this run": "—", "runs.latest": "—"}, "text": "This time the scheduler was down from 00:03 to 00:15. Fail the scheduler and replay the first flow to see that nothing fires while it's down. Now it's back."},
{"el": "j2-db-sch", "payload": "sch_bil for 00:05Z · misfire: run once", "ms": 2, "text": "sch_bil's next_fire_at is still 00:05, because nobody advanced it. The scheduler works out what it missed: 00:05 and 00:10, and 00:15 is due now. Stage 1's cron would have quietly started at 00:20. A stored next_fire_at means missed runs are always found."},
{"el": "j2-sch-tq", "payload": "enqueue · key sch_bil@00:15Z", "text": "sch_bil's misfire policy is run once. The renewal job processes everything that is due, so a single run catches up all three. The scheduler fires the latest one."},
{"el": "j2-tq-sch", "payload": "201 t_71", "ms": 6, "set": {"q.tasks for this run": "1 (t_71)"}, "text": "Enqueued."},
{"el": "j2-sch-db", "payload": "advance → 00:20Z", "ms": 2, "set": {"sch.sch_bil next fire": "00:20Z", "runs.latest": "00:05, 00:10 skipped (misfire) · 00:15 → t_71"}, "text": "The two missed times are recorded as skipped, by policy. Other jobs need other policies. A daily invoice job where each run bills a different day uses run all: each missed day becomes its own task, each with its own key. A ‘good morning’ notification uses skip, because sending it at 14:00 is worse than not sending it. The owner chooses; nothing is lost without a record saying why."}
]
},
{
"id": "overlap",
"label": "The previous run is still going",
"nodes": ["db2", "sch2", "tq2"],
"steps": [
{"el": "j2-sch-db", "payload": "due? (00:20:00)", "set": {"sch.sch_bil next fire": "00:20Z", "q.tasks for this run": "—", "runs.latest": "00:15 → t_71"}, "text": "It's the first of the month, as in Stage 1. The 00:15 run, t_71, has 1,200 renewals to get through."},
{"el": "j2-db-sch", "payload": "sch_bil for 00:20Z · overlap: skip · last t_71", "ms": 2, "text": "sch_bil is due again. Its overlap policy is skip, and its last run was t_71."},
{"el": "j2-sch-tq", "payload": "status of t_71?", "text": "Before firing, the scheduler asks the queue about the previous run."},
{"el": "j2-tq-sch", "payload": "running · started 00:15:01", "ms": 1, "text": "Still running."},
{"el": "j2-sch-db", "payload": "record 00:20Z skipped · advance → 00:25Z", "ms": 2, "set": {"sch.sch_bil next fire": "00:25Z", "runs.latest": "00:20 skipped (00:15 still running)"}, "text": "The 00:20 run is skipped and recorded as such. Stage 1's double charge can't happen: the next run starts only once the last one is finished. A job that must not skip but must not overlap uses queue instead: the scheduler enqueues every run with the schedule ID as the task's ordering key, and the task queue runs one task per key at a time, so each run waits for the one before."}
]
}
]
}
</script>
<div class="diagram-caption">Schedules live in a database, each with a stored next fire time. One scheduler process finds due schedules, enqueues each run on the task queue under a name built from the schedule and its scheduled time, and only then advances the schedule. Workers run the tasks.</div>
</div>

<div class="fail-hint">Click the schedules database, the scheduler, the task queue or the workers to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="db2">
<strong>If the schedules database fails:</strong> nothing fires and nothing can be changed. Runs already in the task queue carry on. When the database returns, the scheduler finds every schedule that came due in the meantime and catches each up by its misfire policy.
</div>
<div class="failure-impact is-hidden" data-component="sch2">
<strong>If the scheduler fails:</strong> nothing fires until it restarts — then every missed run is found and handled by policy, as the third flow shows. Nothing is lost, but every run due during the outage is late, and with one process an outage lasts as long as it takes to notice and restart it.
</div>
<div class="failure-impact is-hidden" data-component="tq2">
<strong>If the task queue fails:</strong> enqueues fail, so the scheduler doesn't advance anything and tries again next second. When the queue returns, the same runs are fired with the same keys. An outage long enough to cover several fire times is a misfire like any other.
</div>
<div class="failure-impact is-hidden" data-component="wk2">
<strong>If the workers fail:</strong> runs pile up in the queue, and the scheduler keeps firing on time — it doesn't depend on workers. Schedules with overlap skip will skip their next runs, because the previous run is still waiting; that is usually what their owners want.
</div>
</div>

Runs are no longer lost: they are found and handled by policy, even after an outage. But there is one scheduler process. While it is down, nothing fires on time, and the accuracy target is gone. Starting a second copy alongside it would make both fire every schedule. The task queue's keys would catch the duplicate tasks, but two processes would still race to advance the same rows, make overlap and misfire decisions from different views, and halve nobody's work.

<!-- stage:3:3. One Leader -->

## Stage 3 — Several Schedulers, One Leader

Run three schedulers, one per zone, and let only one of them fire at a time ([Distributed Locking & Leader Election](#/systems/distributed-locking)).

- **A coordination service grants a leader lease.** The leader renews it every 3 seconds. If it stops, the lease expires after 10 and a standby is granted it ([Consensus](#/systems/consensus)).
- **Every new leader gets a higher epoch number.** Its first act is to write that epoch into the schedules database.
- **Every write a scheduler makes checks the epoch.** A write from an older epoch is refused. A leader that has been replaced — even one that doesn't know it yet — can no longer change anything.

```
-- on taking over
UPDATE scheduler_leader SET epoch = 8 WHERE epoch < 8;

-- every write the leader makes
BEGIN;
SELECT epoch FROM scheduler_leader FOR SHARE;       -- still 7? otherwise roll back
UPDATE schedules SET next_fire_at = '2026-10-08 06:00Z' WHERE schedule_id = 'sch_4T9';
COMMIT;
```

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 800 340" width="800" height="340" role="img" aria-label="Scheduler A and scheduler B in different zones renew a leader lease with a coordination service; both can reach the schedules database, which checks the leader epoch, and the task queue">
  <g data-fail-toggle="co3">
    <rect x="310" y="16" width="180" height="56" rx="6" class="d-actor-box"></rect>
    <text x="400" y="40" text-anchor="middle" class="d-actor-label" font-size="12">Coordination Service</text>
    <text x="400" y="57" text-anchor="middle" class="d-label-muted" font-size="9">leader lease · 10s</text>
  </g>
  <g data-fail-toggle="sa3">
    <rect x="40" y="130" width="170" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="125" y="155" text-anchor="middle" class="d-actor-label" font-size="12">Scheduler A</text>
    <text x="125" y="172" text-anchor="middle" class="d-label-muted" font-size="9">zone a</text>
  </g>
  <g data-fail-toggle="sb3">
    <rect x="590" y="130" width="170" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="675" y="155" text-anchor="middle" class="d-actor-label" font-size="12">Scheduler B</text>
    <text x="675" y="172" text-anchor="middle" class="d-label-muted" font-size="9">zone b</text>
  </g>
  <g data-fail-toggle="db3">
    <rect x="310" y="130" width="180" height="60" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="400" y="154" text-anchor="middle" class="d-actor-label" font-size="12">Schedules DB</text>
    <text x="400" y="171" text-anchor="middle" class="d-label-muted" font-size="9">refuses old epochs</text>
  </g>
  <g data-fail-toggle="tq3">
    <rect x="310" y="250" width="180" height="56" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="400" y="274" text-anchor="middle" class="d-actor-label" font-size="12">Task Queue</text>
    <text x="400" y="290" text-anchor="middle" class="d-label-muted" font-size="9">dedups by key</text>
  </g>
  <line id="j3-a-co" x1="150" y1="126" x2="306" y2="40" class="d-msg d-request" data-depends-on="sa3 co3" marker-end="url(#arrowJ3)"></line>
  <line id="j3-co-a" x1="306" y1="58" x2="172" y2="126" class="d-msg d-response" data-depends-on="sa3 co3" marker-end="url(#arrowJ3r)"></line>
  <line id="j3-b-co" x1="650" y1="126" x2="494" y2="40" class="d-msg d-request" data-depends-on="sb3 co3" marker-end="url(#arrowJ3)"></line>
  <line id="j3-co-b" x1="494" y1="58" x2="628" y2="126" class="d-msg d-response" data-depends-on="sb3 co3" marker-end="url(#arrowJ3r)"></line>
  <line id="j3-a-db" x1="212" y1="152" x2="306" y2="152" class="d-msg d-request" data-depends-on="sa3 db3" marker-end="url(#arrowJ3)"></line>
  <line id="j3-db-a" x1="306" y1="170" x2="212" y2="170" class="d-msg d-response" data-depends-on="sa3 db3" marker-end="url(#arrowJ3r)"></line>
  <line id="j3-b-db" x1="588" y1="152" x2="494" y2="152" class="d-msg d-request" data-depends-on="sb3 db3" marker-end="url(#arrowJ3)"></line>
  <line id="j3-db-b" x1="494" y1="170" x2="588" y2="170" class="d-msg d-response" data-depends-on="sb3 db3" marker-end="url(#arrowJ3r)"></line>
  <line id="j3-a-tq" x1="160" y1="194" x2="306" y2="268" class="d-msg d-request" data-depends-on="sa3 tq3" marker-end="url(#arrowJ3)"></line>
  <line id="j3-tq-a" x1="306" y1="288" x2="140" y2="194" class="d-msg d-response" data-depends-on="sa3 tq3" marker-end="url(#arrowJ3r)"></line>
  <line id="j3-b-tq" x1="640" y1="194" x2="494" y2="268" class="d-msg d-request" data-depends-on="sb3 tq3" marker-end="url(#arrowJ3)"></line>
  <line id="j3-tq-b" x1="494" y1="288" x2="660" y2="194" class="d-msg d-response" data-depends-on="sb3 tq3" marker-end="url(#arrowJ3r)"></line>
  <text x="400" y="330" text-anchor="middle" class="d-label-muted" font-size="10">play the normal fire, then the failover, then the frozen leader waking up</text>
  <defs>
    <marker id="arrowJ3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowJ3r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "lead", "title": "Leadership", "rows": [["leader", "A (epoch 7)"], ["epoch the DB accepts", "7"]]},
{"id": "s", "title": "sch_4T9", "rows": [["next fire", "Oct 7, 06:00Z"], ["tasks for 06:00Z", "—"]]}
],
"flows": [
{
"id": "normal",
"label": "The leader fires; the standby waits",
"nodes": ["co3", "sa3", "sb3", "db3", "tq3"],
"steps": [
{"el": "j3-a-co", "payload": "renew lease · epoch 7", "set": {"lead.leader": "A (epoch 7)", "lead.epoch the DB accepts": "7", "s.next fire": "Oct 7, 06:00Z", "s.tasks for 06:00Z": "—"}, "text": "Scheduler A is the leader. Every 3 seconds it renews its lease."},
{"el": "j3-co-a", "payload": "ok · valid 10s", "ms": 2, "text": "Renewed for another 10 seconds."},
{"el": "j3-b-co", "payload": "watch the lease", "text": "Scheduler B is a standby. It does no scheduling work; it asks the coordination service to tell it when the lease changes hands. A third scheduler in zone c, not shown, does the same."},
{"el": "j3-co-b", "payload": "held by A", "ms": 1, "text": "A holds it."},
{"el": "j3-a-db", "payload": "due? (06:00:00)", "text": "A runs its usual query."},
{"el": "j3-db-a", "payload": "sch_4T9 for 06:00Z", "ms": 2, "text": "The nightly reindex is due."},
{"el": "j3-a-tq", "payload": "enqueue · key sch_4T9@06:00Z", "text": "Enqueue first, as in Stage 2."},
{"el": "j3-tq-a", "payload": "201 t_51", "ms": 6, "set": {"s.tasks for 06:00Z": "1 (t_51)"}, "text": "Stored."},
{"el": "j3-a-db", "payload": "advance · epoch 7", "text": "Then advance, in a transaction that first checks the stored epoch is still 7."},
{"el": "j3-db-a", "payload": "ok", "ms": 2, "set": {"s.next fire": "Oct 8, 06:00Z"}, "text": "It is. This looks exactly like Stage 2, plus one epoch check per write. The difference shows up when A disappears."}
]
},
{
"id": "failover",
"label": "The leader dies",
"nodes": ["co3", "sa3", "sb3", "db3", "tq3"],
"steps": [
{"el": "j3-a-co", "payload": "(power lost at 05:59:58)", "set": {"lead.leader": "A (epoch 7)", "lead.epoch the DB accepts": "7", "s.next fire": "Oct 7, 06:00Z", "s.tasks for 06:00Z": "—"}, "text": "Scheduler A's machine loses power two seconds before the nightly reindex is due. It stops renewing its lease."},
{"el": "j3-co-b", "payload": "you lead · epoch 8", "ms": 8000, "set": {"lead.leader": "B (epoch 8)"}, "text": "A's last renewal was at 05:59:57, so its lease expires at 06:00:07. The coordination service grants it to B, with epoch 8."},
{"el": "j3-b-db", "payload": "take over · epoch 8", "text": "B's first act is to write epoch 8 into the database. From this moment, any write made under epoch 7 will be refused."},
{"el": "j3-db-b", "payload": "ok", "ms": 2, "set": {"lead.epoch the DB accepts": "8"}, "text": "Done."},
{"el": "j3-b-db", "payload": "due?", "text": "B runs the due query."},
{"el": "j3-db-b", "payload": "sch_4T9 for 06:00Z · 7s overdue", "ms": 2, "text": "Everything that came due during the gap is still due, because A never advanced it. B doesn't need to know what A was doing: the database is the record."},
{"el": "j3-b-tq", "payload": "enqueue · key sch_4T9@06:00Z", "text": "B fires it, under the same name A would have used."},
{"el": "j3-tq-b", "payload": "201 t_51", "ms": 6, "set": {"s.tasks for 06:00Z": "1 (t_51)"}, "text": "Stored."},
{"el": "j3-b-db", "payload": "advance · epoch 8", "ms": 2, "set": {"s.next fire": "Oct 8, 06:00Z"}, "text": "The reindex started about 8 seconds late, within the 15-second failover target. Nothing was missed, and no person had to act. Had A died just after enqueueing but before advancing, B would have fired the run again, and the task queue would have returned the existing task."}
]
},
{
"id": "zombie",
"label": "The old leader wakes up",
"nodes": ["co3", "sa3", "sb3", "db3", "tq3"],
"steps": [
{"el": "j3-db-a", "payload": "sch_4T9 for 06:00Z", "set": {"lead.leader": "A (epoch 7)", "lead.epoch the DB accepts": "7", "s.next fire": "Oct 7, 06:00Z", "s.tasks for 06:00Z": "—"}, "text": "A different failure. At 06:00:00 A reads that sch_4T9 is due — and then its process freezes for 15 seconds: a long garbage-collection pause, or its virtual machine being moved to another host. It is not dead. It just isn't running."},
{"el": "j3-co-b", "payload": "you lead · epoch 8", "ms": 10000, "set": {"lead.leader": "B (epoch 8)", "lead.epoch the DB accepts": "8"}, "text": "A stops renewing, so its lease expires and B takes over with epoch 8, exactly as in the last flow."},
{"el": "j3-b-tq", "payload": "enqueue · key sch_4T9@06:00Z", "set": {"s.tasks for 06:00Z": "1 (t_51)", "s.next fire": "Oct 8, 06:00Z"}, "text": "B fires the overdue reindex and advances it."},
{"el": "j3-a-tq", "payload": "enqueue · key sch_4T9@06:00Z", "text": "At 06:00:15 A unfreezes. From the inside no time has passed: it still believes it is the leader, and it carries on from where it stopped — firing sch_4T9."},
{"el": "j3-tq-a", "payload": "200 · existing t_51", "ms": 2, "set": {"s.tasks for 06:00Z": "still 1 (t_51)"}, "text": "The task queue recognizes the run's name. No second reindex."},
{"el": "j3-a-db", "payload": "advance · epoch 7", "text": "A tries to advance the schedule. Its view of the world is 15 seconds old. In that time B may have advanced this schedule, and its owner may have edited or paused it; a write from A could undo either."},
{"el": "j3-db-a", "payload": "refused · epoch is 8", "ms": 2, "text": "The database refuses: the current epoch is 8. A can't change anything."},
{"el": "j3-a-co", "payload": "who leads?", "text": "A asks the coordination service what happened."},
{"el": "j3-co-a", "payload": "B, epoch 8", "ms": 1, "text": "A learns it was replaced, and becomes a standby. Two guards were needed. Checking its own lease before each write isn't enough, because a pause can fall between the check and the write. The epoch makes the database refuse a replaced leader's writes; the run's name makes the queue ignore its fires."}
]
}
]
}
</script>
<div class="diagram-caption">Three schedulers share one leader lease. Only the leader fires. A new leader raises the epoch in the database, so a replaced leader's writes are refused, and runs it fires late are recognized by the task queue as ones it already has.</div>
</div>

<div class="fail-hint">Click either scheduler, the coordination service, the database or the task queue to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="sa3">
<strong>If scheduler A (the leader) fails:</strong> nothing fires for up to 10 seconds, until its lease expires and a standby takes over. The new leader finds everything that came due in the gap and fires it. Replay the second flow.
</div>
<div class="failure-impact is-hidden" data-component="sb3">
<strong>If scheduler B (a standby) fails:</strong> nothing changes. The third scheduler is still a standby, so a further leader failure is still covered.
</div>
<div class="failure-impact is-hidden" data-component="co3">
<strong>If the coordination service fails:</strong> the leader can't renew its lease, so it must stop firing when the lease runs out — it can't prove it is still the only leader. Firing stops until coordination returns, and then catches up. The coordination service is a small replicated cluster across three zones, so this needs two of its members to fail at once.
</div>
<div class="failure-impact is-hidden" data-component="db3">
<strong>If the schedules database fails:</strong> its synchronous replica in another zone is promoted, which takes a few seconds. Fires due in those seconds are found and fired afterwards. The epoch row is replicated like everything else.
</div>
<div class="failure-impact is-hidden" data-component="tq3">
<strong>If the task queue fails:</strong> the leader can't enqueue, so it doesn't advance anything, and retries. As in Stage 2, runs are late but not lost.
</div>
</div>

The scheduler now survives losing a machine or a zone, and a frozen leader can't do damage. But leader election gives availability, not capacity: one leader still reads one database index and fires every run. At 5,800 runs a second that works. At the top of the hour, when millions of runs fall due, one machine and one database are the ceiling.

<!-- stage:4:4. Sharded Ownership -->

## Stage 4 — Shards, Each with Its Own Owner

The same leader election, done 256 times over.

- **Schedules are split into 256 shards** by a hash of their ID, held across 16 database clusters ([Partitioning & Sharding](#/systems/partitioning-sharding)). A busy tenant's schedules are spread across all of them.
- **Each shard has one owner**, a scheduler node holding a lease on it from the coordination service. 32 nodes hold about 8 shards each. Each shard has its own epoch, checked by its own database, exactly as in Stage 3.
- **When a node dies, its shards are spread across the survivors.** Each shard is taken over separately, so the work of a failed node doesn't land on any single machine.
- **Nodes fire from memory.** Every 30 seconds, each node loads the next two minutes of fires for its shards into an in-memory timer. The database is read in large ranges twice a minute, not polled every second, and runs fire at their exact time rather than at the next poll.
- **A recheck before every fire.** When a schedule is edited, the API tells the shard's owner, so it can update its timer. Those notices can be lost, so just before firing, the node reads the schedule once more by its key, and fires only if its version is the one it loaded.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 820 360" width="820" height="360" role="img" aria-label="A schedule API writes to a sharded schedules database and notifies shard owners; a coordination service assigns shards to scheduler node 1 and node 2; each node reads its shards from the database and enqueues runs into the task queue">
  <g data-fail-toggle="api4">
    <rect x="10" y="150" width="130" height="60" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="75" y="175" text-anchor="middle" class="d-actor-label" font-size="12">Schedule API</text>
    <text x="75" y="192" text-anchor="middle" class="d-label-muted" font-size="9">writes · notifies owner</text>
  </g>
  <g data-fail-toggle="co4">
    <rect x="200" y="16" width="190" height="52" rx="6" class="d-actor-box"></rect>
    <text x="295" y="38" text-anchor="middle" class="d-actor-label" font-size="12">Coordination Service</text>
    <text x="295" y="55" text-anchor="middle" class="d-label-muted" font-size="9">shard → node · leases</text>
  </g>
  <g data-fail-toggle="n14">
    <rect x="430" y="90" width="180" height="62" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="520" y="114" text-anchor="middle" class="d-actor-label" font-size="12">Scheduler Node 1</text>
    <text x="520" y="130" text-anchor="middle" class="d-label-muted" font-size="9">shards 0–7</text>
    <text x="520" y="143" text-anchor="middle" class="d-label-muted" font-size="9">next 2 min in memory</text>
  </g>
  <g data-fail-toggle="n24">
    <rect x="430" y="210" width="180" height="62" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="520" y="234" text-anchor="middle" class="d-actor-label" font-size="12">Scheduler Node 2</text>
    <text x="520" y="250" text-anchor="middle" class="d-label-muted" font-size="9">shards 8–15</text>
    <text x="520" y="263" text-anchor="middle" class="d-label-muted" font-size="9">next 2 min in memory</text>
  </g>
  <g data-fail-toggle="db4">
    <rect x="170" y="290" width="210" height="54" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="275" y="313" text-anchor="middle" class="d-actor-label" font-size="12">Schedules DB</text>
    <text x="275" y="330" text-anchor="middle" class="d-label-muted" font-size="9">256 shards · 16 clusters</text>
  </g>
  <g data-fail-toggle="tq4">
    <rect x="670" y="150" width="140" height="60" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="740" y="176" text-anchor="middle" class="d-actor-label" font-size="12">Task Queue</text>
    <text x="740" y="193" text-anchor="middle" class="d-label-muted" font-size="9">dedups by key</text>
  </g>
  <line id="j4-api-db" x1="100" y1="214" x2="220" y2="286" class="d-msg d-request" data-depends-on="api4 db4" marker-end="url(#arrowJ4)"></line>
  <line id="j4-db-api" x1="200" y1="286" x2="80" y2="214" class="d-msg d-response" data-depends-on="api4 db4" marker-end="url(#arrowJ4r)"></line>
  <line id="j4-api-n1" x1="142" y1="168" x2="426" y2="116" class="d-msg d-request" data-depends-on="api4 n14" marker-end="url(#arrowJ4)"></line>
  <line id="j4-n1-co" x1="450" y1="86" x2="394" y2="48" class="d-msg d-request" data-depends-on="n14 co4" marker-end="url(#arrowJ4)"></line>
  <line id="j4-co-n1" x1="394" y1="62" x2="466" y2="86" class="d-msg d-response" data-depends-on="n14 co4" marker-end="url(#arrowJ4r)"></line>
  <line id="j4-co-n2" x1="360" y1="72" x2="450" y2="206" class="d-msg d-response" data-depends-on="co4 n24" marker-end="url(#arrowJ4r)"></line>
  <line id="j4-n2-co" x1="462" y1="206" x2="366" y2="72" class="d-msg d-request" data-depends-on="co4 n24" marker-end="url(#arrowJ4)"></line>
  <line id="j4-n1-db" x1="440" y1="156" x2="340" y2="286" class="d-msg d-request" data-depends-on="n14 db4" marker-end="url(#arrowJ4)"></line>
  <line id="j4-db-n1" x1="360" y1="286" x2="456" y2="156" class="d-msg d-response" data-depends-on="n14 db4" marker-end="url(#arrowJ4r)"></line>
  <line id="j4-n2-db" x1="428" y1="250" x2="384" y2="296" class="d-msg d-request" data-depends-on="n24 db4" marker-end="url(#arrowJ4)"></line>
  <line id="j4-db-n2" x1="384" y1="316" x2="446" y2="276" class="d-msg d-response" data-depends-on="n24 db4" marker-end="url(#arrowJ4r)"></line>
  <line id="j4-n1-tq" x1="612" y1="112" x2="666" y2="160" class="d-msg d-request" data-depends-on="n14 tq4" marker-end="url(#arrowJ4)"></line>
  <line id="j4-tq-n1" x1="666" y1="174" x2="612" y2="132" class="d-msg d-response" data-depends-on="n14 tq4" marker-end="url(#arrowJ4r)"></line>
  <line id="j4-n2-tq" x1="612" y1="232" x2="666" y2="198" class="d-msg d-request" data-depends-on="n24 tq4" marker-end="url(#arrowJ4)"></line>
  <line id="j4-tq-n2" x1="666" y1="208" x2="612" y2="250" class="d-msg d-response" data-depends-on="n24 tq4" marker-end="url(#arrowJ4r)"></line>
  <text x="410" y="354" text-anchor="middle" class="d-label-muted" font-size="10">play the fire from memory, then the node failure, then the last-second edit</text>
  <defs>
    <marker id="arrowJ4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowJ4r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "own", "title": "Shard owners", "rows": [["node 1", "shards 0–7"], ["node 2", "shards 8–15"]]},
{"id": "s", "title": "sch_4T9 (shard 3)", "rows": [["version", "12"], ["next fire", "Oct 7, 06:00Z"], ["fired", "—"]]}
],
"flows": [
{
"id": "memory",
"label": "A fire from memory",
"nodes": ["n14", "db4", "tq4"],
"steps": [
{"el": "j4-n1-db", "payload": "shards 0–7 · due before 06:01:30", "set": {"own.node 1": "shards 0–7", "own.node 2": "shards 8–15", "s.version": "12", "s.next fire": "Oct 7, 06:00Z", "s.fired": "—"}, "text": "At 05:59:30, node 1 refreshes its timer: one range scan per shard on the due index, for everything firing in the next two minutes."},
{"el": "j4-db-n1", "payload": "~22,000 fires", "ms": 30, "text": "About 22,000 fires across its 8 shards — one thirty-second of the fleet's load — sorted by time. sch_4T9, version 12, is among them."},
{"el": "j4-n1-db", "payload": "06:00:00 · recheck sch_4T9", "text": "At 06:00:00.000 the timer reaches sch_4T9. The node reads its row once more, by key."},
{"el": "j4-db-n1", "payload": "active · v12", "ms": 1, "text": "Still active, still version 12."},
{"el": "j4-n1-tq", "payload": "enqueue · key sch_4T9@06:00Z", "text": "Fire."},
{"el": "j4-tq-n1", "payload": "201 t_51", "ms": 6, "set": {"s.fired": "06:00:00.009 (t_51)"}, "text": "Enqueued 9 milliseconds after its scheduled time. Stage 3's leader would have found it at its next once-a-second poll."},
{"el": "j4-n1-db", "payload": "advance · shard 3 epoch 34", "ms": 2, "set": {"s.next fire": "Oct 8, 06:00Z"}, "text": "The advance checks shard 3's epoch, not a single global one. Each shard is fenced on its own, so nodes never wait on each other."}
]
},
{
"id": "nodefail",
"label": "Node 1 dies — its shards move",
"nodes": ["co4", "n14", "n24", "db4", "tq4"],
"steps": [
{"el": "j4-n1-co", "payload": "(node lost at 05:59:55)", "set": {"own.node 1": "shards 0–7", "own.node 2": "shards 8–15", "s.version": "12", "s.next fire": "Oct 7, 06:00Z", "s.fired": "—"}, "text": "Node 1's machine fails five seconds before sch_4T9 is due. Its leases on shards 0–7 stop being renewed."},
{"el": "j4-co-n2", "payload": "you own shards 0–3 · new epochs", "ms": 10000, "set": {"own.node 1": "—", "own.node 2": "shards 0–3, 8–15"}, "text": "The leases expire. The coordination service hands shards 0–3 to node 2 and shards 4–7 to another node, so the extra load is shared."},
{"el": "j4-n2-db", "payload": "raise epochs · load shards 0–3", "text": "Node 2 raises each shard's epoch in its database, then loads those shards' next two minutes, including anything already overdue."},
{"el": "j4-db-n2", "payload": "~11,000 fires · ~900 overdue", "ms": 30, "text": "About 900 runs in shards 0–3 came due in the last 10 seconds. sch_4T9 is one of them."},
{"el": "j4-n2-tq", "payload": "enqueue ~900 overdue", "text": "Node 2 fires the overdue runs first, each under its usual name."},
{"el": "j4-tq-n2", "payload": "201 × ~900", "ms": 20, "set": {"s.fired": "06:00:05 (t_51)", "s.next fire": "Oct 8, 06:00Z"}, "text": "They're up to 10 seconds late, within the failover target. The other 248 shards never noticed. With one leader, as in Stage 3, every schedule in the company would have paused for those 10 seconds."}
]
},
{
"id": "edit",
"label": "Edited a second before it fires",
"nodes": ["api4", "n14", "db4", "tq4"],
"steps": [
{"el": "j4-api-db", "payload": "PATCH sch_4T9 · 0 3 * * * · If-Match 12", "set": {"own.node 1": "shards 0–7", "own.node 2": "shards 8–15", "s.version": "12", "s.next fire": "Oct 7, 06:00Z", "s.fired": "—"}, "text": "At 05:59:59 the search team moves the reindex an hour later, to 03:00 New York time."},
{"el": "j4-db-api", "payload": "v13 · next fire 07:00Z", "ms": 4, "set": {"s.version": "13", "s.next fire": "Oct 7, 07:00Z"}, "text": "The row is now version 13, next firing at 07:00 UTC."},
{"el": "j4-api-n1", "payload": "sch_4T9 changed (lost)", "text": "The API tells shard 3's owner, node 1. This notice is lost: node 1 was reconnecting at that instant. Node 1's timer still says sch_4T9, version 12, at 06:00."},
{"el": "j4-n1-db", "payload": "06:00:00 · recheck sch_4T9 v12", "text": "At 06:00:00 the timer reaches the stale entry. As always, node 1 rechecks the row before firing."},
{"el": "j4-db-n1", "payload": "v13 · next fire 07:00Z", "ms": 1, "text": "The row has moved on. Node 1 drops its stale entry and doesn't fire. The 07:00 fire will be loaded at the next refresh."},
{"el": "j4-n1-tq", "payload": "07:00:00 · enqueue · key sch_4T9@07:00Z", "set": {"s.fired": "07:00Z only"}, "text": "An hour later, the reindex fires at its new time — once. Notices make edits take effect quickly; the recheck makes them correct even when a notice is lost. If the edit lands between the recheck and the enqueue, a millisecond apart, the old run fires: an edit takes effect from the next run that hasn't started firing."}
]
}
]
}
</script>
<div class="diagram-caption">Schedules are split into 256 shards, each owned by one scheduler node under its own lease and epoch. Nodes keep the next two minutes of fires in memory, recheck each schedule just before firing, and take over a failed node's shards between them.</div>
</div>

<div class="fail-hint">Click the Schedule API, the coordination service, either node, the database or the task queue to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="api4">
<strong>If the Schedule API fails:</strong> teams can't create or change schedules until another instance answers. Firing carries on untouched: nodes read schedules straight from the database. This is why the API's availability target is lower than firing's.
</div>
<div class="failure-impact is-hidden" data-component="co4">
<strong>If the coordination service fails:</strong> nodes can't renew their shard leases. Each node stops firing a shard once its lease runs out, because it can no longer be sure nobody else owns it. Firing stops until coordination returns, then catches up. As in Stage 3, this takes two failures in a replicated cluster.
</div>
<div class="failure-impact is-hidden" data-component="n14">
<strong>If node 1 fails:</strong> its 8 shards are spread across other nodes within about 10 seconds, and their overdue runs fire then. Replay the second flow. Anything node 1 had fired but not advanced is fired again and recognized by the task queue.
</div>
<div class="failure-impact is-hidden" data-component="n24">
<strong>If node 2 fails:</strong> the same, for shards 8–15. Each node's failure affects only its own shards — about 3% of schedules.
</div>
<div class="failure-impact is-hidden" data-component="db4">
<strong>If one database cluster fails:</strong> its 16 shards pause for the few seconds it takes to promote the replica, then catch up. The other 15 clusters' shards keep firing.
</div>
<div class="failure-impact is-hidden" data-component="tq4">
<strong>If the task queue fails:</strong> every node's enqueues fail, so nothing advances, and they retry. Fires are late but not lost; long enough, and misfire policies apply.
</div>
</div>

Firing is now spread across 32 machines and 16 databases, and each failure touches a small slice of schedules. But the work is spread across machines, not across time. At 00:00:00 UTC, about 12 million runs are due in the same second, and every node has 375,000 of them to recheck and enqueue at once.

<!-- stage:5:5. The Top of the Hour -->

## Stage 5 — The Top of the Hour

Three changes take the spike apart.

- **Fire early, run on time.** Five minutes before a run is due, its node enqueues it as a delayed task with `run_at` set to the scheduled time. The task queue's delay index already holds hundreds of millions of tasks like it and makes each ready within 2 seconds of its time. 12 million enqueues spread over 5 minutes is about **40,000 a second** — well within what the queue handles every day. The rechecks are spread over the same 5 minutes.
- **Edits reach into the queue.** The pre-enqueued task's ID is stored on the schedule. Pausing, editing or deleting a schedule cancels that task as part of the same API call.
- **Spread windows.** A schedule that says `spread_s: 3600` fires at a fixed offset into the hour, computed from a hash of its ID. The offset never changes, so the job still runs exactly once an hour, an hour apart — but 7.5 million hourly jobs that didn't care about minute zero stop all landing on it.

Schedules with overlap policy skip are not enqueued early: the check on the previous run has to happen at the time. They are a small share, mostly operational jobs, and fire as in Stage 4.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 820 320" width="820" height="320" role="img" aria-label="Scheduler nodes read schedules from the database and enqueue runs ahead of time into the task queue's delay index; the schedule API writes the database and cancels pre-enqueued tasks; workers claim tasks when they become ready">
  <g data-fail-toggle="api5">
    <rect x="250" y="20" width="160" height="48" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="330" y="40" text-anchor="middle" class="d-actor-label" font-size="12">Schedule API</text>
    <text x="330" y="56" text-anchor="middle" class="d-label-muted" font-size="9">edits cancel early runs</text>
  </g>
  <g data-fail-toggle="db5">
    <rect x="10" y="150" width="160" height="56" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="90" y="174" text-anchor="middle" class="d-actor-label" font-size="12">Schedules DB</text>
    <text x="90" y="191" text-anchor="middle" class="d-label-muted" font-size="9">pending_task_id</text>
  </g>
  <g data-fail-toggle="n5">
    <rect x="230" y="150" width="180" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="320" y="174" text-anchor="middle" class="d-actor-label" font-size="12">Scheduler Nodes</text>
    <text x="320" y="191" text-anchor="middle" class="d-label-muted" font-size="9">fire 5 min early · spread</text>
  </g>
  <g data-fail-toggle="tq5">
    <rect x="480" y="120" width="180" height="120" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="570" y="150" text-anchor="middle" class="d-actor-label" font-size="12">Task Queue</text>
    <text x="570" y="176" text-anchor="middle" class="d-label-muted" font-size="9">delay index</text>
    <text x="570" y="192" text-anchor="middle" class="d-label-muted" font-size="9">ready at run_at</text>
    <text x="570" y="208" text-anchor="middle" class="d-label-muted" font-size="9">cancel while delayed</text>
  </g>
  <g data-fail-toggle="wk5">
    <rect x="710" y="155" width="100" height="50" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="760" y="184" text-anchor="middle" class="d-actor-label" font-size="12">Workers</text>
  </g>
  <line id="j5-n-db" x1="228" y1="168" x2="174" y2="168" class="d-msg d-request" data-depends-on="n5 db5" marker-end="url(#arrowJ5)"></line>
  <line id="j5-db-n" x1="174" y1="190" x2="228" y2="190" class="d-msg d-response" data-depends-on="n5 db5" marker-end="url(#arrowJ5r)"></line>
  <line id="j5-n-tq" x1="412" y1="168" x2="476" y2="168" class="d-msg d-request" data-depends-on="n5 tq5" marker-end="url(#arrowJ5)"></line>
  <line id="j5-tq-n" x1="476" y1="190" x2="412" y2="190" class="d-msg d-response" data-depends-on="n5 tq5" marker-end="url(#arrowJ5r)"></line>
  <line id="j5-wk-tq" x1="708" y1="170" x2="664" y2="170" class="d-msg d-request" data-depends-on="wk5 tq5" marker-end="url(#arrowJ5)"></line>
  <line id="j5-tq-wk" x1="664" y1="192" x2="708" y2="192" class="d-msg d-response" data-depends-on="wk5 tq5" marker-end="url(#arrowJ5r)"></line>
  <line id="j5-api-db" x1="258" y1="70" x2="130" y2="146" class="d-msg d-request" data-depends-on="api5 db5" marker-end="url(#arrowJ5)"></line>
  <line id="j5-db-api" x1="110" y1="146" x2="248" y2="62" class="d-msg d-response" data-depends-on="api5 db5" marker-end="url(#arrowJ5r)"></line>
  <line id="j5-api-tq" x1="412" y1="50" x2="540" y2="116" class="d-msg d-request" data-depends-on="api5 tq5" marker-end="url(#arrowJ5)"></line>
  <line id="j5-tq-api" x1="556" y1="116" x2="412" y2="64" class="d-msg d-response" data-depends-on="api5 tq5" marker-end="url(#arrowJ5r)"></line>
  <text x="410" y="300" text-anchor="middle" class="d-label-muted" font-size="10">play midnight on the dot, then firing early, then the late pause, then the spread hourly job</text>
  <defs>
    <marker id="arrowJ5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowJ5r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "m", "title": "Midnight UTC", "rows": [["runs due at 00:00:00", "~12,000,000"], ["last run enqueued", "—"], ["hourly jobs firing at :00", "7,500,000"]]},
{"id": "s", "title": "sch_dg8 (daily digest)", "rows": [["state", "active"], ["early task", "—"]]}
],
"flows": [
{
"id": "spike",
"label": "Midnight, fired on the dot",
"nodes": ["n5", "db5", "tq5"],
"steps": [
{"el": "j5-n-db", "payload": "recheck 375,000 schedules", "set": {"m.last run enqueued": "—", "s.state": "active", "s.early task": "—"}, "text": "First, Stage 4's behaviour. At 00:00:00 UTC each of the 32 nodes has about 375,000 runs to fire in the same instant. Each starts rechecking rows: 12 million key lookups across 16 database clusters in a second."},
{"el": "j5-db-n", "payload": "rows, slowly", "ms": 900, "text": "The databases answer, but not all at once. Rechecks queue up behind each other."},
{"el": "j5-n-tq", "payload": "375,000 enqueues per node", "text": "Nodes enqueue as fast as rechecks come back."},
{"el": "j5-tq-n", "payload": "429 · Retry-After", "ms": 1000, "text": "12 million enqueues in one second is about 170 times the queue's normal peak rate. Its per-tenant limits refuse most of them with 429, as they are meant to."},
{"el": "j5-n-tq", "payload": "retry at the accepted rate", "set": {"m.last run enqueued": "~00:03:00"}, "text": "The nodes back off and retry. The last of midnight's runs is enqueued around 00:03. Nothing is lost, but millions of schedules miss the 2-second target every night, and the same thing happens at a smaller scale every hour on the hour."}
]
},
{
"id": "early",
"label": "Fire early, run on time",
"nodes": ["n5", "db5", "tq5", "wk5"],
"steps": [
{"el": "j5-n-db", "payload": "23:55 · load the 00:00 runs", "set": {"m.last run enqueued": "—", "s.state": "active", "s.early task": "—"}, "text": "Now with Stage 5. At 23:55:00 each node starts on the runs due at midnight, five minutes ahead. sch_dg8, a user's daily digest, is one of them."},
{"el": "j5-db-n", "payload": "rechecked rows", "ms": 2, "text": "Rechecks are spread across the five minutes, along with everything else."},
{"el": "j5-n-tq", "payload": "enqueue · run_at 00:00:00 · key sch_dg8@00:00Z", "text": "Each run is enqueued as a delayed task: run at exactly 00:00:00. Its name and key are unchanged; only the moment of enqueueing has moved. Across the fleet, about 40,000 enqueues a second."},
{"el": "j5-tq-n", "payload": "201 t_d41 · delayed", "ms": 6, "set": {"s.early task": "t_d41, delayed until 00:00"}, "text": "The task sits in the task queue's delay index."},
{"el": "j5-n-db", "payload": "advance · pending t_d41", "ms": 2, "set": {"m.last run enqueued": "23:59:58"}, "text": "The node advances the schedule and records t_d41 as its pending task. The last of midnight's runs is enqueued two seconds before it's due."},
{"el": "j5-tq-wk", "payload": "00:00:00 · due → ready", "ms": 1500, "set": {"s.early task": "t_d41, ready at 00:00:01.5"}, "text": "At midnight the queue's delay timer moves them all to ready, within its 2-second accuracy. The spike hasn't vanished: 12 million tasks are ready at once. But it now lands in the queue, which is built to hold a backlog and share it fairly between tenants, not on the scheduler. For jobs that don't need the exact second, spread windows remove it entirely (last flow)."},
{"el": "j5-wk-tq", "payload": "claim", "text": "Workers start on them."}
]
},
{
"id": "pause",
"label": "Paused after its run was enqueued",
"nodes": ["api5", "db5", "tq5"],
"steps": [
{"el": "j5-api-db", "payload": "23:58 · pause sch_dg8", "set": {"s.state": "active", "s.early task": "t_d41, delayed until 00:00", "m.last run enqueued": "—"}, "text": "At 23:58 the digest team spots a broken email template and pauses sch_dg8. Its midnight run is already in the queue."},
{"el": "j5-db-api", "payload": "paused · pending t_d41", "ms": 3, "set": {"s.state": "paused"}, "text": "The API pauses the schedule and reads its pending task in the same transaction."},
{"el": "j5-api-tq", "payload": "DELETE t_d41", "text": "Then it cancels that task. It doesn't rely on telling the node: the task is in the queue, so the queue is where it's stopped."},
{"el": "j5-tq-api", "payload": "200 cancelled", "ms": 3, "set": {"s.early task": "cancelled"}, "text": "The task was still delayed, so it's deleted cleanly and the broken digest never goes out. Had the team paused at 00:00:05, the task would already be running, the cancel would return 409, and the API would tell them the pause starts from the next run. Firing early has a price: edits must reach into the queue, and the lookahead is a window in which an edit can come too late."}
]
},
{
"id": "spread",
"label": "An hourly job with a spread window",
"nodes": ["n5", "db5", "tq5"],
"steps": [
{"el": "j5-n-db", "payload": "sch_cw2 · hourly · spread 3600s", "set": {"m.hourly jobs firing at :00": "7,500,000", "s.state": "active", "s.early task": "—"}, "text": "sch_cw2 warms a cache every hour. It doesn't matter when in the hour, so its owner set a one-hour spread window."},
{"el": "j5-db-n", "payload": "offset = hash(sch_cw2) mod 3600 = 1,397s", "ms": 2, "text": "The offset comes from a hash of the schedule's ID: 1,397 seconds, or 23 minutes 17 seconds. It's computed the same way every time, so sch_cw2 runs at 23:17 past every hour — never twice in one hour, never two hours apart."},
{"el": "j5-n-tq", "payload": "run_at 01:23:17 · key sch_cw2@01:00Z", "text": "The run's name is still the 01:00 run; only its fire time moves. Retries, history and misfire handling don't change."},
{"el": "j5-tq-n", "payload": "201", "ms": 6, "set": {"m.hourly jobs firing at :00": "~2,100 a second, all hour"}, "text": "When hourly schedules use a spread window, the 7.5 million that piled onto minute zero become about 2,100 a second, all hour long. That is the cheapest fix for the top of the hour: most jobs never needed it. The API defaults new hourly and daily schedules to a spread window unless the owner turns it off."}
]
}
]
}
</script>
<div class="diagram-caption">Runs are enqueued five minutes ahead as delayed tasks, so the task queue makes them ready on time and the scheduler's work is spread across the minutes before. Edits cancel runs already enqueued, and spread windows move jobs that don't need an exact moment off the top of the hour.</div>
</div>

<div class="fail-hint">Click the Schedule API, the database, the scheduler nodes, the task queue or the workers to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="api5">
<strong>If the Schedule API fails:</strong> edits can't be made, so a run already enqueued early can't be cancelled through it. An operator can cancel tasks directly on the task queue. Firing is unaffected.
</div>
<div class="failure-impact is-hidden" data-component="db5">
<strong>If a database cluster fails:</strong> its shards can't be loaded or advanced for a few seconds. Runs already enqueued early are unaffected — they are in the queue and will run on time. That makes the five-minute lookahead a buffer: a short database failure just before midnight costs nothing at midnight.
</div>
<div class="failure-impact is-hidden" data-component="n5">
<strong>If a scheduler node fails:</strong> its shards move, as in Stage 4. Runs it had already enqueued early still run on time. Its new owner re-enqueues anything in the next five minutes; the keys turn those into no-ops for runs that were already enqueued.
</div>
<div class="failure-impact is-hidden" data-component="tq5">
<strong>If the task queue fails:</strong> nothing can be enqueued or made ready. Runs enqueued early are stored in the queue's replicated delay index, so when a failed partition comes back on a new leader, they become ready a few seconds late. New enqueues wait and retry.
</div>
<div class="failure-impact is-hidden" data-component="wk5">
<strong>If the workers fail:</strong> runs become ready on time and wait in the queue. The scheduler has done its job; how quickly they run is up to the queue and its workers.
</div>
</div>

This is the full design. Teams register schedules with a cron expression and a named time zone. The schedules live in 256 shards across 16 database clusters, each schedule carrying its next fire time and the name of its next run: the schedule and its scheduled time. Each shard is owned by one scheduler node under a lease and an epoch, so a replaced owner's writes are refused, and a failed node's shards are spread across the others within seconds. Nodes load the near future into memory and enqueue each run five minutes early as a delayed task, under its name as the idempotency key, so a run fired twice becomes one task and the task queue releases it on time. Only after the queue has it does the schedule advance, so a crash leads to a repeat, never a gap. Missed runs are found from the stored fire times and handled by the owner's misfire policy; overlapping runs are skipped or held by the overlap policy. Spread windows keep jobs that don't need the top of the hour off it.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### Time zones and daylight saving

A schedule's next fire time is computed in its own time zone, then converted to UTC. Never by adding 24 hours to the last one: a day in New York is 23 hours long once a year and 25 hours long once a year.

Two days need rules:

- **Spring forward.** On 8 March 2026, New York clocks jump from 01:59:59 to 03:00:00. A 02:30 schedule has no 02:30 that day. The scheduler fires it at the first moment that does exist, 03:00, so a daily job still runs that day.
- **Fall back.** On 1 November 2026, 01:00 to 01:59 happens twice. A 01:30 schedule fires at the first 01:30 only. An hourly schedule fires at both, because both are real hours that pass.

Time-zone rules are data, not physics. Governments change them, sometimes with weeks of notice. When the scheduler's time-zone database is updated, it recomputes `next_fire_at` for every schedule in the affected zones.

### Computing the next fire time

The next fire time is computed from the **scheduled time** of the run just fired, never from the time it actually fired. If the 06:00 run fires at 06:00:08 after a failover, the next is still 06:00 tomorrow, not 06:00:08. Computing from "now" makes schedules drift a little later every time anything is slow.

The same rule finds missed runs: walk forward from the stored `next_fire_at`, one cron match at a time, until reaching the present. Each step is a missed run, handed to the misfire policy.

### Exactly-once firing, layer by layer

"One task per scheduled time" isn't one mechanism. It's three, each covering a gap in the one before:

1. **One owner per shard.** The lease means that normally only one node fires a schedule.
2. **The epoch.** Leases can't stop a frozen owner that doesn't know it's been replaced. The epoch makes its writes fail.
3. **The run's name as idempotency key.** The epoch can't stop an enqueue to a different system, and enqueue-before-advance deliberately allows repeats after a crash. The key makes those repeats harmless.

This is effectively-once, not exactly-once: the work may be attempted more than once, and the effect happens once ([Idempotency & Exactly-Once Delivery](#/systems/idempotency)). And it covers the scheduler's half only. The task queue still runs each task at least once, so the job itself must be safe to repeat — ideally by using its schedule ID and scheduled time as its own idempotency key.

### Jobs should read the scheduled time, not the clock

A daily billing job that runs `bill(today - 1 day)` bills the wrong day whenever it runs late past midnight, runs twice on a misfire with run all, or is redriven from the dead-letter queue a week later. A job that runs `bill(scheduled_for - 1 day)` is correct in every one of those cases. That's why the scheduled time travels with every task.

### Clock skew between nodes

Each node fires by its own clock. A node whose clock is 3 seconds fast fires its shards 3 seconds early. Nodes synchronize with the company's time servers and refuse to take shard leases if their measured offset exceeds 500ms, and the offset is a monitored metric. Firing early by a few hundred milliseconds is harmless only because jobs use `scheduled_for`, not the clock — the same rule as above.

### Why the scheduler doesn't run jobs

A scheduler that ran jobs itself would need leases on running jobs, retries, timeouts, crash recovery, worker pools sized for every team's workload, and isolation between them. That is a task queue. Splitting the two keeps the scheduler small: its whole job is to turn "it is now 06:00" into one durable task, which takes milliseconds. It also means a slow job can never delay the firing of anyone else's.

### How far ahead to enqueue

Five minutes is a trade. A longer lookahead spreads the midnight spike further and makes the scheduler more tolerant of short database outages, since runs already in the queue are safe. But it widens the window in which an edit or pause has to reach into the queue, and holds more tasks in the queue's delay index. A shorter one does the reverse. Five minutes brings the spike under the queue's normal peak with room to spare.

### Very long and very short intervals

A schedule that fires once a year is stored like any other: one row, one index entry, and nothing happens until its time. Schedules shorter than a minute are refused. At that frequency, the per-run overhead — a recheck, an enqueue, two writes, a history row — exceeds the work, and the job is better as a long-running worker with its own loop.

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### Exact time against smooth load

Every schedule that insists on minute zero adds to the spike. Spread windows fix it only for owners who opt in, which is why they are the default for new schedules. Jobs that really need minute zero — market open, end-of-day settlement — keep it, and their burst lands on the task queue and their own workers.

### Failover means late runs

A node failure delays its shards' runs by up to the lease expiry, about 10 seconds. Shorter leases mean faster failover but more false failovers, when a node that is merely slow loses its shards and they bounce between machines. Runs enqueued early are immune, which is another reason for the lookahead.

### Firing early makes edits harder

Enqueuing five minutes ahead means an edit must cancel a task in another system, and an edit in the last seconds may be too late. Schedules with overlap skip can't be enqueued early at all, since whether to run depends on the previous run at the time. Both are complexity a fire-on-time scheduler doesn't have.

### No misfire policy fits everyone

Run all can flood a team's workers with a day's backlog after an outage. Run once loses the distinction between missed periods. Skip drops work silently unless someone reads the history. The scheduler can't know which is right, so the owner has to choose — and owners often choose without thinking until the first outage.

### The scheduler is only as available as its dependencies

Firing depends on the coordination service, the schedules database and the task queue. Any one being down stops firing. None of them loses runs, because everything is caught up from the stored fire times, but the accuracy target only holds while all three are up.

### Fairness is the task queue's job

Sharding by schedule ID spreads one tenant's 5 million digests evenly across scheduler nodes, but they still all become ready at 08:00 in that tenant's time zone and land on one queue. The scheduler fires them on time; the queue's per-tenant lanes stop them crowding out everyone else's work.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

A schedule is a standing instruction to make some service act, repeatedly, long after the person who created it has moved on ([Security & Authentication](#/systems/security-authentication)).

### A schedule can't reach further than its owner

The scheduler's own service identity could enqueue to any queue. If it enqueued with that identity, anyone able to create a schedule could reach any queue through it. Instead, each schedule records its owner, and the scheduler enqueues on the owner's behalf: the task queue checks that the owner, not the scheduler, may enqueue to the target. Permission is checked when the schedule is created and again at every fire, so revoking a team's access to `charge_card` stops its schedules too.

### Owners leave

Schedules outlive the people and services that created them. A schedule whose owning team or service account is deleted is paused, not left running under nobody's name, and its runs fail the permission check above until someone takes it over.

### Changes are audited

Moving a payout job from monthly to every minute, or pointing it at a different account, is an attack that looks like an edit. Every create, edit, pause, resume and trigger is logged with who made it and the before and after. Schedules on sensitive queues require a second person to approve changes.

### Limits on schedules

Each team has a limit on how many schedules it can own and how often they can fire in total. Without one, a bug that creates a schedule per request instead of per user could create millions of every-minute schedules — a self-inflicted spike at every minute boundary. The one-minute minimum interval is enforced at the API.

### Payloads are stored for a long time

A schedule's payload sits in the database for as long as the schedule exists, and is copied into a task at every fire. Secrets don't go in payloads: a payload names what to act on, and the worker fetches credentials itself.

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **Fire lag**: the time from a run's scheduled time to its task becoming ready, at p50 and p99, per shard. This is the scheduler's main measure of health.
- **Overdue schedules**: active schedules whose `next_fire_at` is more than 30 seconds in the past. Normally zero.
- **Shard ownership**: shards without an owner, lease handovers per hour, and writes refused for an old epoch.
- **Enqueue errors** to the task queue, by reason.
- **Misfires and skips** per schedule, by policy.
- **Early-task cancellations**, and cancellations that came too late.
- **Clock offset** of every node from the time servers.
- **Runs due per second**, looking ahead an hour, so spikes are visible before they happen.

([Observability](#/systems/observability))

### Watching the watcher

If the scheduler stops, the jobs that would have alerted on their own failure don't run, so nothing alerts. Two checks run outside the scheduler. An independent auditor queries every shard every minute for overdue schedules. And a heartbeat schedule fires every minute into a queue whose only job is to record that it ran; if a minute passes without one, the scheduler is paged.

### What to alert on

- Fire lag p99 above **2 seconds** for 5 minutes, or above **15 seconds** at all.
- Any overdue schedule for more than **1 minute**.
- Any shard without an owner for more than **30 seconds**.
- The heartbeat schedule missing a minute.
- A node's clock more than **500ms** off.
- For schedules their owners mark critical: no successful run within a deadline the owner sets — "the 02:00 reindex has succeeded by 04:00".

### "The nightly job didn't run" — what happens?

Start with the run history for that schedule, which records every scheduled time. A row marked skipped_overlap means the previous run was still going. skipped_misfire means the scheduler was down and the policy chose to skip. A row with a task ID means the scheduler fired it, and the question moves to the task queue: was it retried, dead-lettered, or never claimed? No row at all for a past scheduled time means the scheduler never reached it — check the overdue metric and that shard's ownership.

### Fire lag rising on one shard — what happens?

Check who owns it. If ownership is changing every few minutes, a node is losing its lease without dying: usually long pauses or a network problem between it and the coordination service. Remove that node so its shards settle elsewhere. If ownership is stable, check the shard's database cluster for slow queries on the due index, and the node's enqueue errors to the task queue.

### A node's clock jumped — what happens?

A node whose clock jumps forward fires its shards' runs early, up to its whole five-minute window; one that jumps backward fires them late. The time-offset check makes it give up its leases, and other nodes take its shards. Runs it fired early carry their correct scheduled time and are enqueued with their correct `run_at`, so they still become ready at the right moment; the keys stop the new owner firing them again.
