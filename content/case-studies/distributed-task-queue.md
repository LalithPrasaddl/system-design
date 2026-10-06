# Distributed Task Queue

A task queue lets one part of a system say "do this later" and trust that it will be done. A checkout service shouldn't make the customer wait while a receipt email is sent, a video is transcoded or a loyalty balance is recalculated. It hands each of those to the queue and returns. Workers elsewhere pick the tasks up and run them. That trust is the hard part. Every task must run even if the worker running it dies halfway through. A task must not be run twice by two workers at once, yet the only way to survive crashes is to be willing to run it again. A task that fails must be retried, but not so fast that it hammers a service that is already down, and not forever if it can never succeed. And one team's flood of tasks must not leave everyone else's waiting behind it. This case study builds a queue that handles all of it.

<!-- tab:requirements:Requirements -->

## Requirements

This case study builds a task queue run as a shared platform inside a large company. Hundreds of teams use it, each with their own queues, producers and workers.

### Functional requirements

- **Enqueue a task** onto a named queue, with a type, a payload, and optional settings: a priority, a maximum number of attempts and a time limit per attempt.
- **Delayed tasks.** A task can be scheduled to run at a given time, up to 30 days ahead.
- **Workers claim tasks**, run them, and report success or failure.
- **Automatic retries** for failed attempts, with a growing delay between them.
- **Dead-letter queue.** A task that keeps failing is set aside for a person to inspect, fix and re-run.
- **Task status**: a producer can ask whether a task is waiting, running, done or dead, and can cancel one that hasn't started.
- **Idempotent enqueue.** A producer that retries an enqueue with the same key gets the same task, not a second one.

### Non-functional requirements

- **Never lose an accepted task.** Once enqueue returns success, the task is stored durably and will run to success or land in the dead-letter queue.
- **At-least-once execution.** A task can run more than once — after a worker crash, for example. The queue keeps that rare, and gives every handler what it needs to make a repeat harmless.
- **Fast enqueue:** **50ms at p99**. Producers often enqueue in the middle of a user's request.
- **Fast pickup:** a ready task starts within **1 second at p99** when workers have free capacity.
- **Accurate delays:** a delayed task becomes ready within **2 seconds** of its scheduled time.
- **Highly available enqueue:** **99.99%**. Running tasks a little late is acceptable; refusing to accept them is not.
- **Isolation.** One tenant flooding a shared queue can delay others only by their fair share, never by the length of its backlog.

### In scope

Durable storage of tasks, claiming and leases, crash recovery, retries and backoff, delayed tasks, dead letters, partitioning and replication, priorities, fairness between tenants, and backpressure.

### Out of scope

**Recurring schedules** ("run this every night at 2am"), which are a scheduler that enqueues into this queue. **Workflows** of dependent steps with their own state. **Event streams** that many independent consumers each read in full — that is a log, not a queue, and the Deep Dives tab explains the difference. **Running the workers' code**: the queue hands out tasks; teams run their own workers.

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

The task rate is high but not extreme. What shapes the design is that every task changes state several times, that a backlog can grow very large very quickly when workers stop, and that hundreds of millions of tasks sit waiting for a future time.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Tasks enqueued</div>
<div class="stat-tile-value">~70<span class="stat-tile-unit">K/sec</span></div>
<div class="stat-tile-sub">at peak</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Durable writes</div>
<div class="stat-tile-value">~215<span class="stat-tile-unit">K/sec</span></div>
<div class="stat-tile-sub">enqueue, claim, complete</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Running at once</div>
<div class="stat-tile-value">~140<span class="stat-tile-unit">K</span></div>
<div class="stat-tile-sub">tasks in progress at peak</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Delayed tasks</div>
<div class="stat-tile-value">~300<span class="stat-tile-unit">M</span></div>
<div class="stat-tile-sub">waiting for their time</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Backlog per hour</div>
<div class="stat-tile-value">~250<span class="stat-tile-unit">M</span></div>
<div class="stat-tile-sub">if every worker stops at peak</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Pickup target</div>
<div class="stat-tile-value">1<span class="stat-tile-unit">s</span></div>
<div class="stat-tile-sub">p99, ready to running</div>
</div>
</div>

### Assumptions

- **400 teams** own about **3,000 queues** between them.
- **2 billion tasks** are enqueued a day. Peak traffic is about **3×** the average.
- A task runs for **2 seconds** on average. Some run for many minutes.
- A payload averages **2KB** and is capped at **256KB**. Larger data is stored elsewhere and passed by reference.
- **3%** of attempts fail and are retried. About **1 in 2,000** tasks ends in the dead-letter queue.
- **15%** of tasks are delayed, on average by about a day.

### Throughput

- 2 billion ÷ 86,400 seconds is about **23,000 tasks a second**, peaking at **~70,000/sec**.
- Each task is written at least three times: when it is enqueued, when a worker claims it, and when it completes. With retries adding a few percent, that is **~215,000 durable writes a second** at peak. Each one is replicated, so the storage layer handles three times that.

### Tasks in progress

The number of tasks running at any moment is the rate at which they start multiplied by how long each one takes (Little's law). 70,000 a second × 2 seconds = **~140,000 tasks running at once** at peak. That is also how many open leases the queue tracks, and roughly how many worker slots the company runs.

### Backlog

Normally a task waits well under a second, so the ready backlog is small: about 70,000 tasks, under 200MB. The queue exists for the abnormal case. If every worker stopped at peak, tasks would pile up at **250 million an hour**, about **630GB** at 2.5KB each with metadata. A queue that can't hold a long backlog isn't doing its job, so storage is sized for a day of one large queue's traffic, not for the normal backlog.

### Delayed tasks

15% of 2 billion is 300 million delayed tasks a day, about 3,500 a second. Each waits about a day, so at any moment **~300 million tasks** are waiting for their time: about **750GB**. Almost none of them need attention until they become due.

### Polling

If 140,000 worker slots each asked "anything for me?" every 100ms, the queue would answer **1.4 million requests a second**, nearly all of them "no". Workers must wait for tasks without asking repeatedly.

<!-- tab:api-design:API Design -->

## API Design

Producers and workers both talk to the queue over HTTP. Producers enqueue and check on tasks. Workers claim tasks, report progress and report results.

### Producers

```
POST /v1/queues/send_receipt/tasks
Idempotency-Key: order-81723-receipt
{
  "type": "send_receipt",
  "tenant": "shop_42",
  "payload": {"order_id": 81723, "email": "…"},
  "run_at": "2026-10-06T09:00:00Z",
  "priority": "high",
  "max_attempts": 8,
  "timeout_s": 60
}
→ 201 {"task_id": "t_8kQ2", "state": "queued"}

GET    /v1/tasks/t_8kQ2           → {"state": "running", "attempt": 2, "last_error": "smtp 503"}
DELETE /v1/tasks/t_8kQ2           → 200 cancelled, or 409 if already running
```

### Workers

```
POST /v1/queues/send_receipt/claim
{"worker_id": "w-17", "max_tasks": 10, "wait_s": 20}
→ 200 {"tasks": [{"task_id": "t_8kQ2", "lease_id": "l_9031", "lease_until": "…",
                  "attempt": 1, "type": "send_receipt", "payload": {…}}]}

POST /v1/tasks/t_8kQ2/heartbeat   {"lease_id": "l_9031", "extend_s": 30}
POST /v1/tasks/t_8kQ2/complete    {"lease_id": "l_9031"}
POST /v1/tasks/t_8kQ2/fail        {"lease_id": "l_9031", "error": "smtp 503", "retryable": true}
POST /v1/tasks/t_8kQ2/release     {"lease_id": "l_9031"}
```

### Dead letters

```
GET  /v1/queues/send_receipt/dead?limit=50
POST /v1/queues/send_receipt/dead/redrive   {"task_ids": ["t_x91", "t_x95"]}
```

| Code | Meaning |
|---|---|
| `201` | Task accepted and stored durably |
| `200` | Enqueue repeated with a known idempotency key: the existing task is returned. For a claim: tasks, or an empty list after waiting |
| `400` | Unknown task type for this queue, or invalid settings |
| `403` | The caller isn't allowed to enqueue to, or claim from, this queue |
| `409` | The lease has expired or been taken by another worker: stop work on this task |
| `413` | Payload over 256KB: store it elsewhere and pass a reference |
| `429` | Over this queue's or tenant's enqueue limit: retry after `Retry-After` seconds |

### Why the details matter

**The idempotency key belongs to the producer's own operation.** `order-81723-receipt` names the thing that should happen once — the receipt for order 81723 — so a producer that retries after a timeout, or a request handler that runs twice, enqueues one task ([Idempotency & Exactly-Once Delivery](#/systems/idempotency)).

**Claiming returns a lease, not a task.** The lease says "this worker may run this task until this time". Every later call carries the `lease_id`, and the queue rejects calls with a lease that is no longer current. That is how a worker learns it has been presumed dead.

**`wait_s` turns claiming into long polling.** If nothing is ready, the queue holds the request open for up to 20 seconds and answers the moment a task arrives. An idle worker costs one request every 20 seconds instead of ten a second.

**The attempt number is given to the worker.** Handlers can log it, alert on high attempts, and use the task ID as an idempotency key for whatever side effect they cause.

**`fail` says whether a retry could help.** A timeout from an email provider is worth retrying. An order that doesn't exist will not exist on attempt eight either, so the task goes straight to the dead-letter queue.

**`release` hands a task back without counting it as a failure.** A worker that is shutting down for a deploy releases its unfinished tasks so another worker can take them immediately, instead of after the lease runs out.

<!-- tab:data-model:Data Model -->

## Data Model

A task queue's data is unusual: almost every record is short-lived, changes state several times, and is then deleted. The store is optimized for that churn, not for keeping things.

### Tasks

```
tasks                                       -- partitioned by (queue_id, partition)
  queue_id         TEXT
  partition        INT
  task_id          BIGINT                   -- time-ordered, unique
  tenant_id        TEXT                     -- set from the producer's identity
  type             TEXT
  payload          BYTES                    -- up to 256KB
  priority         SMALLINT
  state            TEXT                     -- delayed | ready | leased | done | dead
  run_at           TIMESTAMP                -- when it may next run
  attempt          INT
  max_attempts     INT
  timeout_s        INT
  lease_id         BIGINT                   -- increases with every claim
  lease_until      TIMESTAMP
  worker_id        TEXT
  last_error       TEXT
  idempotency_key  TEXT
  created_at       TIMESTAMP
  PRIMARY KEY (queue_id, partition, task_id)
```

Each partition keeps three indexes over its tasks, and the state field decides which one a task is in:

| Index | Ordered by | Used for |
|---|---|---|
| Ready | priority, tenant, task_id | Handing out the next task |
| Delayed | run_at | Finding tasks that have just become due |
| Leased | lease_until | Finding leases that have run out |

A task moves between these indexes; it is never copied. A claim moves it from Ready to Leased. A failure moves it to Delayed with a later `run_at`. Completion removes it.

### Idempotency keys

```
idempotency_keys                            -- same partition as the task
  queue_id, idempotency_key  → task_id      -- kept 24 hours
```

### Queues

```
queues
  queue_id             TEXT PRIMARY KEY
  owner_team           TEXT
  partitions           INT
  allowed_types        TEXT[]
  default_max_attempts INT
  backoff              TEXT                 -- e.g. "10s x2, max 1h, jitter"
  enqueue_limit        INT                  -- tasks/sec, per queue and per tenant
  concurrency_limit    INT                  -- tasks running at once
  oldest_task_slo_s    INT                  -- alert threshold
```

### Finished tasks

```
task_history                                -- 7 days, then deleted
  task_id, queue_id, tenant_id, type, state, attempts, last_error, finished_at
```

When a task completes, its payload is dropped and a small record is kept for a week so producers can check its outcome. Dead tasks keep their payload until someone redrives or discards them.

### Why this storage

Each partition is stored in an embedded key-value store on its broker — a log-structured store that handles constant inserts and deletes well — and replicated to two other brokers in other zones. A write is acknowledged once two of the three copies have it ([Replication](#/systems/replication), [LSM-Trees vs. B-Trees](#/systems/lsm-vs-btree)).

A plain append-only log is not enough. A log remembers one position per consumer: everything before it is done, everything after it isn't. A task queue needs a state for every task, because tasks finish out of order. Task 1,001 can be done while task 1,000 is still running, waiting for a retry, or scheduled for tomorrow.

<!-- tab:architecture:Architecture:default -->

This case study builds the task queue up in five stages. Each stage fixes a specific failure of the one before. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one task at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. A Jobs Table -->

## Stage 1 — A Jobs Table in the App's Database

The smallest version that works: a `jobs` table in the database the application already has. The checkout service inserts a row with `status = 'pending'`. Workers poll the table every second, pick a pending row, set it to `running`, do the work, and set it to `done`.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 780 290" width="780" height="290" role="img" aria-label="The checkout service writes rows into a jobs table in the application's database; two workers poll that table and send emails through an email provider">
  <rect x="16" y="110" width="130" height="50" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="81" y="139" text-anchor="middle" class="d-actor-label" font-size="12">Checkout Service</text>
  <g data-fail-toggle="db1">
    <rect x="240" y="105" width="160" height="60" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="320" y="130" text-anchor="middle" class="d-actor-label" font-size="12">App Database</text>
    <text x="320" y="147" text-anchor="middle" class="d-label-muted" font-size="9">jobs table · status column</text>
  </g>
  <g data-fail-toggle="w1a">
    <rect x="470" y="30" width="130" height="44" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="535" y="56" text-anchor="middle" class="d-actor-label" font-size="12">Worker 1</text>
  </g>
  <g data-fail-toggle="w1b">
    <rect x="470" y="196" width="130" height="44" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="535" y="222" text-anchor="middle" class="d-actor-label" font-size="12">Worker 2</text>
  </g>
  <rect x="640" y="110" width="124" height="50" rx="6" class="d-actor-box"></rect>
  <text x="702" y="139" text-anchor="middle" class="d-actor-label" font-size="12">Email Provider</text>
  <line id="t1-prod-db" x1="148" y1="128" x2="236" y2="128" class="d-msg d-request" data-depends-on="db1" marker-end="url(#arrowT1)"></line>
  <line id="t1-db-prod" x1="236" y1="144" x2="148" y2="144" class="d-msg d-response" data-depends-on="db1" marker-end="url(#arrowT1r)"></line>
  <line id="t1-w1-db" x1="496" y1="78" x2="398" y2="101" class="d-msg d-request" data-depends-on="w1a db1" marker-end="url(#arrowT1)"></line>
  <line id="t1-db-w1" x1="380" y1="101" x2="480" y2="77" class="d-msg d-response" data-depends-on="w1a db1" marker-end="url(#arrowT1r)"></line>
  <line id="t1-w2-db" x1="496" y1="192" x2="398" y2="169" class="d-msg d-request" data-depends-on="w1b db1" marker-end="url(#arrowT1)"></line>
  <line id="t1-db-w2" x1="380" y1="169" x2="480" y2="193" class="d-msg d-response" data-depends-on="w1b db1" marker-end="url(#arrowT1r)"></line>
  <line id="t1-w1-ep" x1="602" y1="62" x2="664" y2="106" class="d-msg d-request" data-depends-on="w1a" marker-end="url(#arrowT1)"></line>
  <line id="t1-w2-ep" x1="602" y1="208" x2="664" y2="164" class="d-msg d-request" data-depends-on="w1b" marker-end="url(#arrowT1)"></line>
  <text x="390" y="280" text-anchor="middle" class="d-label-muted" font-size="10">play the first task, then the race, then the crash</text>
  <defs>
    <marker id="arrowT1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowT1r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "jobs", "title": "jobs table", "rows": [["t_101", "—"], ["t_102", "—"], ["t_103", "—"]]},
{"id": "cust", "title": "Customers' inboxes", "rows": [["receipts received", "—"]]}
],
"flows": [
{
"id": "basic",
"label": "Enqueue and run a receipt",
"nodes": ["db1", "w1a"],
"steps": [
{"el": "t1-prod-db", "payload": "insert t_101 pending", "text": "A customer places an order. In the same database transaction that saves the order, the checkout service inserts a job: send the receipt for this order."},
{"el": "t1-db-prod", "payload": "committed", "ms": 3, "set": {"jobs.t_101": "pending"}, "text": "The order and its job are committed together. There is no way to end up with an order and no receipt job, or a receipt job for an order that was rolled back. That is the one real strength of this design, and Stage 3 has to work to keep it."},
{"el": "t1-w1-db", "payload": "SELECT … pending LIMIT 1", "text": "Worker 1 polls once a second: is there a pending job?"},
{"el": "t1-db-w1", "payload": "t_101", "ms": 2, "text": "There is."},
{"el": "t1-w1-db", "payload": "UPDATE t_101 → running", "text": "The worker marks it as running, so other workers leave it alone."},
{"el": "t1-db-w1", "payload": "OK", "ms": 2, "set": {"jobs.t_101": "running (worker 1)"}, "text": "Done."},
{"el": "t1-w1-ep", "payload": "send receipt #81723", "ms": 180, "set": {"cust.receipts received": "1 for order 81723"}, "text": "The worker sends the email. The customer gets their receipt."},
{"el": "t1-w1-db", "payload": "UPDATE t_101 → done", "ms": 2, "set": {"jobs.t_101": "done"}, "text": "The job is marked done. This works well for a small app — and it keeps working until two workers look at the table at the same moment, which is the next flow."}
]
},
{
"id": "race",
"label": "Two workers take the same job",
"nodes": ["db1", "w1a", "w1b"],
"steps": [
{"el": "t1-prod-db", "payload": "insert t_102 pending", "set": {"jobs.t_102": "pending"}, "text": "Another order, another job: t_102."},
{"el": "t1-w1-db", "payload": "SELECT … pending LIMIT 1", "text": "Worker 1 polls."},
{"el": "t1-w2-db", "payload": "SELECT … pending LIMIT 1", "text": "A millisecond later, worker 2 polls too."},
{"el": "t1-db-w1", "payload": "t_102", "ms": 2, "text": "The database tells worker 1 about t_102."},
{"el": "t1-db-w2", "payload": "t_102", "text": "It tells worker 2 the same thing. Neither has updated the row yet, so for both of them, t_102 is pending."},
{"el": "t1-w1-db", "payload": "UPDATE t_102 → running", "text": "Worker 1 marks it running."},
{"el": "t1-w2-db", "payload": "UPDATE t_102 → running", "set": {"jobs.t_102": "running (both workers)"}, "text": "So does worker 2. The update doesn't check what the status was, so both succeed. Reading and then writing in two separate steps leaves a gap, and with dozens of workers polling every second, something lands in that gap every day."},
{"el": "t1-w1-ep", "payload": "send receipt #81724", "ms": 180, "text": "Worker 1 sends the receipt."},
{"el": "t1-w2-ep", "payload": "send receipt #81724", "set": {"cust.receipts received": "2 for order 81724"}, "text": "Worker 2 sends it too. The customer gets two receipts. For a receipt that is embarrassing; for a task that charges a card or ships a parcel it is a real loss. Stage 2 makes claiming a single step that only one worker can win."}
]
},
{
"id": "crash",
"label": "A worker dies mid-job",
"nodes": ["db1", "w1a"],
"steps": [
{"el": "t1-prod-db", "payload": "insert t_103 pending", "set": {"jobs.t_103": "pending", "cust.receipts received": "—"}, "text": "A third order: t_103."},
{"el": "t1-w1-db", "payload": "UPDATE t_103 → running", "set": {"jobs.t_103": "running (worker 1)"}, "text": "Worker 1 picks it up and marks it running."},
{"el": "t1-w1-ep", "payload": "(process killed)", "text": "Before it sends the email, worker 1 is killed: a deploy restarts it, or the machine runs out of memory. Fail Worker 1 and replay the first flow to see the same thing from the start."},
{"el": "t1-w2-db", "payload": "SELECT … pending", "text": "Worker 2 keeps polling for pending jobs."},
{"el": "t1-db-w2", "payload": "nothing", "ms": 2, "set": {"jobs.t_103": "running — forever"}, "text": "It never sees t_103, because t_103 says ‘running’. Nothing records who is running it or since when, so nothing can tell a job that is taking a while from a job whose worker died last Tuesday. The customer never gets a receipt, and nobody knows. Stage 2 gives every claim an expiry time."}
]
}
]
}
</script>
<div class="diagram-caption">Jobs live in a table next to the application's own data. Workers poll it, mark a row as running, and do the work. Claiming is two separate steps, and a running job has no owner and no deadline.</div>
</div>

<div class="fail-hint">Click the database or either worker to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="db1">
<strong>If the app database fails:</strong> the application is down anyway, so jobs stop being created at the same moment as the orders that create them. Nothing is lost, because a job only exists if its transaction committed. This is the single property of the jobs table worth keeping.
</div>
<div class="failure-impact is-hidden" data-component="w1a">
<strong>If worker 1 fails:</strong> worker 2 keeps processing pending jobs, so the queue keeps moving. But any job worker 1 had marked as running stays that way forever, as the third flow shows. Someone eventually finds these by hand.
</div>
<div class="failure-impact is-hidden" data-component="w1b">
<strong>If worker 2 fails:</strong> the same as worker 1: throughput halves, and the jobs it was running are stranded.
</div>
</div>

A jobs table is a fine queue for a small app. It fails in two ways that get more frequent with every worker added: two workers can claim the same job, and a job whose worker dies is never finished. The next stage fixes both, still in the same database.

<!-- stage:2:2. Leases -->

## Stage 2 — Claim in One Step, and Lease Instead of Lock

Two changes to how a worker takes a task.

- **Claiming is one atomic statement.** The worker finds a ready task and marks it as taken in a single update, so two workers can never both win the same task. In a relational database this is `SELECT … FOR UPDATE SKIP LOCKED`: each worker locks the row it picks, and other workers skip locked rows instead of waiting for them.
- **A claim is a lease.** It records which worker has the task and until when — 30 seconds from now. A worker that needs longer extends the lease with a heartbeat. A task whose lease has run out is treated as ready again, by the same claim statement.

```
UPDATE tasks
SET    state = 'leased', lease_id = lease_id + 1, attempt = attempt + 1,
       worker_id = 'w-17', lease_until = now() + interval '30 seconds'
WHERE  task_id = (
         SELECT task_id FROM tasks
         WHERE  queue_id = 'send_receipt'
           AND (state = 'ready' OR (state = 'leased' AND lease_until < now()))
         ORDER  BY task_id
         LIMIT  1
         FOR UPDATE SKIP LOCKED)
RETURNING task_id, lease_id, attempt, payload;
```

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 780 290" width="780" height="290" role="img" aria-label="The checkout service writes tasks into a tasks table with leases; worker A and worker B claim tasks atomically and send emails through an email provider">
  <rect x="16" y="110" width="130" height="50" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="81" y="139" text-anchor="middle" class="d-actor-label" font-size="12">Checkout Service</text>
  <g data-fail-toggle="db2">
    <rect x="240" y="100" width="160" height="70" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="320" y="124" text-anchor="middle" class="d-actor-label" font-size="12">App Database</text>
    <text x="320" y="141" text-anchor="middle" class="d-label-muted" font-size="9">tasks · lease_id · lease_until</text>
    <text x="320" y="155" text-anchor="middle" class="d-label-muted" font-size="9">claim = one atomic update</text>
  </g>
  <g data-fail-toggle="wa2">
    <rect x="470" y="30" width="130" height="44" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="535" y="56" text-anchor="middle" class="d-actor-label" font-size="12">Worker A</text>
  </g>
  <g data-fail-toggle="wb2">
    <rect x="470" y="196" width="130" height="44" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="535" y="222" text-anchor="middle" class="d-actor-label" font-size="12">Worker B</text>
  </g>
  <rect x="640" y="110" width="124" height="50" rx="6" class="d-actor-box"></rect>
  <text x="702" y="132" text-anchor="middle" class="d-actor-label" font-size="12">Email Provider</text>
  <text x="702" y="148" text-anchor="middle" class="d-label-muted" font-size="9">dedups by key</text>
  <line id="t2-prod-db" x1="148" y1="128" x2="236" y2="128" class="d-msg d-request" data-depends-on="db2" marker-end="url(#arrowT2)"></line>
  <line id="t2-db-prod" x1="236" y1="144" x2="148" y2="144" class="d-msg d-response" data-depends-on="db2" marker-end="url(#arrowT2r)"></line>
  <line id="t2-wa-db" x1="496" y1="78" x2="398" y2="96" class="d-msg d-request" data-depends-on="wa2 db2" marker-end="url(#arrowT2)"></line>
  <line id="t2-db-wa" x1="380" y1="96" x2="480" y2="77" class="d-msg d-response" data-depends-on="wa2 db2" marker-end="url(#arrowT2r)"></line>
  <line id="t2-wb-db" x1="496" y1="192" x2="398" y2="174" class="d-msg d-request" data-depends-on="wb2 db2" marker-end="url(#arrowT2)"></line>
  <line id="t2-db-wb" x1="380" y1="174" x2="480" y2="193" class="d-msg d-response" data-depends-on="wb2 db2" marker-end="url(#arrowT2r)"></line>
  <line id="t2-wa-ep" x1="602" y1="56" x2="672" y2="106" class="d-msg d-request" data-depends-on="wa2" marker-end="url(#arrowT2)"></line>
  <line id="t2-ep-wa" x1="656" y1="106" x2="602" y2="70" class="d-msg d-response" data-depends-on="wa2" marker-end="url(#arrowT2r)"></line>
  <line id="t2-wb-ep" x1="602" y1="214" x2="672" y2="164" class="d-msg d-request" data-depends-on="wb2" marker-end="url(#arrowT2)"></line>
  <line id="t2-ep-wb" x1="656" y1="164" x2="602" y2="200" class="d-msg d-response" data-depends-on="wb2" marker-end="url(#arrowT2r)"></line>
  <text x="390" y="280" text-anchor="middle" class="d-label-muted" font-size="10">play the claim, then the crash, then the slow worker</text>
  <defs>
    <marker id="arrowT2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowT2r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "task", "title": "The task", "rows": [["state", "—"], ["lease", "—"], ["attempt", "—"]]},
{"id": "cust", "title": "Customer's inbox", "rows": [["receipts received", "—"]]}
],
"flows": [
{
"id": "claim",
"label": "Two workers claim at once",
"nodes": ["db2", "wa2", "wb2"],
"steps": [
{"el": "t2-prod-db", "payload": "insert t_102 ready", "text": "The same situation as Stage 1's race: an order creates task t_102, and two workers are polling."},
{"el": "t2-db-prod", "payload": "committed", "ms": 3, "set": {"task.state": "ready", "task.lease": "—", "task.attempt": "0"}, "text": "Committed with the order, as before."},
{"el": "t2-wa-db", "payload": "claim (atomic)", "text": "Worker A runs the claim statement. It finds t_102 and locks the row in the same step."},
{"el": "t2-wb-db", "payload": "claim (atomic)", "text": "Worker B runs the same statement a millisecond later. t_102 is locked, so instead of waiting, it skips to the next ready task. There is none."},
{"el": "t2-db-wa", "payload": "t_102 · lease 1 · until :30", "ms": 2, "set": {"task.state": "leased by A", "task.lease": "1, until 12:00:30", "task.attempt": "1"}, "text": "Worker A gets t_102 with lease 1, valid for 30 seconds."},
{"el": "t2-db-wb", "payload": "nothing", "text": "Worker B gets nothing. Only one worker can win a claim."},
{"el": "t2-wa-ep", "payload": "send · key t_102", "text": "Worker A sends the receipt, passing the task ID as the email provider's idempotency key. That detail matters in the third flow."},
{"el": "t2-ep-wa", "payload": "sent", "ms": 180, "set": {"cust.receipts received": "1"}, "text": "The customer gets one receipt."},
{"el": "t2-wa-db", "payload": "complete t_102 · lease 1", "text": "Worker A completes the task, quoting its lease."},
{"el": "t2-db-wa", "payload": "OK", "ms": 2, "set": {"task.state": "done", "task.lease": "—"}, "text": "The database checks that lease 1 is still the current lease, then marks the task done."}
]
},
{
"id": "crash",
"label": "Worker A crashes — the lease runs out",
"nodes": ["db2", "wa2", "wb2"],
"steps": [
{"el": "t2-wa-db", "payload": "claim", "set": {"task.state": "ready", "task.lease": "—", "task.attempt": "0", "cust.receipts received": "—"}, "text": "A new task, t_103, is ready. Worker A claims it."},
{"el": "t2-db-wa", "payload": "t_103 · lease 1 · until :30", "ms": 2, "set": {"task.state": "leased by A", "task.lease": "1, until 12:00:30", "task.attempt": "1"}, "text": "Lease 1, until 12:00:30."},
{"el": "t2-wa-ep", "payload": "(process killed)", "text": "Worker A is killed before sending anything — Stage 1's crash again. This time the task records who had it and until when."},
{"el": "t2-wb-db", "payload": "claim", "text": "At 12:00:31, worker B runs its usual claim. The statement treats a leased task whose lease has run out exactly like a ready one."},
{"el": "t2-db-wb", "payload": "t_103 · lease 2 · attempt 2", "ms": 2, "set": {"task.state": "leased by B", "task.lease": "2, until 12:01:01", "task.attempt": "2"}, "text": "Worker B gets t_103 as attempt 2, with a new lease. No timer, no cleanup job and no failure detector were needed: an expired lease is simply claimable."},
{"el": "t2-wb-ep", "payload": "send · key t_103", "text": "Worker B sends the receipt."},
{"el": "t2-ep-wb", "payload": "sent", "ms": 180, "set": {"cust.receipts received": "1, ~31s late"}, "text": "The customer gets it about 31 seconds late. Shorter leases recover faster but give a busy worker less time before it is presumed dead — that's what heartbeats are for."},
{"el": "t2-wb-db", "payload": "complete t_103 · lease 2", "ms": 2, "set": {"task.state": "done", "task.lease": "—"}, "text": "Done. This is at-least-once execution: the task is guaranteed to finish, and the price is that a task can be started more than once. The next flow shows when ‘more than once’ means ‘twice’."}
]
},
{
"id": "slow",
"label": "Worker A is slow, not dead",
"nodes": ["db2", "wa2", "wb2"],
"steps": [
{"el": "t2-wa-db", "payload": "claim", "set": {"task.state": "ready", "task.lease": "—", "task.attempt": "0", "cust.receipts received": "—"}, "text": "Task t_104. Worker A claims it."},
{"el": "t2-db-wa", "payload": "t_104 · lease 1 · until :30", "ms": 2, "set": {"task.state": "leased by A", "task.lease": "1, until 12:00:30", "task.attempt": "1"}, "text": "Lease 1, for 30 seconds."},
{"el": "t2-wa-ep", "payload": "send · key t_104", "text": "Worker A calls the email provider, which is having a bad day. The call takes 40 seconds. Worker A is alive and working, but nothing outside it can tell that apart from a crash."},
{"el": "t2-wb-db", "payload": "claim", "text": "At 12:00:31 the lease has run out. Worker B's claim picks t_104 up."},
{"el": "t2-db-wb", "payload": "t_104 · lease 2", "ms": 2, "set": {"task.state": "leased by B", "task.lease": "2, until 12:01:01", "task.attempt": "2"}, "text": "Two workers are now running the same task. No queue can prevent this. The only way to avoid it would be to never re-run a task whose worker went quiet, and then a crashed worker would strand it forever, as in Stage 1."},
{"el": "t2-wb-ep", "payload": "send · key t_104", "text": "Worker B sends the receipt with the same idempotency key, t_104."},
{"el": "t2-ep-wb", "payload": "already sent", "ms": 30, "set": {"cust.receipts received": "1"}, "text": "The provider has already accepted a send with key t_104 from worker A, so it does nothing and reports success. The customer gets one receipt. The queue made sure the task finished; the task ID used as an idempotency key made sure it had its effect only once."},
{"el": "t2-wb-db", "payload": "complete t_104 · lease 2", "ms": 2, "set": {"task.state": "done", "task.lease": "—"}, "text": "Worker B completes it."},
{"el": "t2-wa-db", "payload": "complete t_104 · lease 1", "text": "Worker A finally finishes and tries to complete the task with lease 1."},
{"el": "t2-db-wa", "payload": "409 lease lost", "ms": 2, "text": "Rejected: lease 1 is no longer current. Worker A learns it was presumed dead and drops the task. With heartbeats every 10 seconds extending the lease, worker A would have kept the task in the first place. But heartbeats only reduce duplicates. A paused or partitioned worker still loses its lease, so every handler must be safe to run twice. That holds at every stage from here on. What breaks next is the database itself."}
]
}
]
}
</script>
<div class="diagram-caption">A claim is a single atomic update that gives one worker a lease with an expiry time. An expired lease makes the task claimable again, so a crashed worker's task is retried. A slow worker can lose its lease while still running, so handlers use the task ID to make their side effects safe to repeat.</div>
</div>

<div class="fail-hint">Click the database or either worker to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="db2">
<strong>If the app database fails:</strong> nothing is enqueued and nothing is claimed, as in Stage 1. Workers in the middle of a task can't complete it; they keep retrying the call. If the outage outlasts their leases, the tasks will be run again when the database returns — another reason handlers must be safe to repeat.
</div>
<div class="failure-impact is-hidden" data-component="wa2">
<strong>If worker A fails:</strong> its tasks become claimable again when their leases run out, at most 30 seconds later. Replay the second flow. Nothing is stranded; the cost is a delay and one extra attempt per task.
</div>
<div class="failure-impact is-hidden" data-component="wb2">
<strong>If worker B fails:</strong> the same as worker A. Any worker can pick up any task whose lease has expired.
</div>
</div>

Tasks are now claimed by exactly one worker at a time and recovered when a worker dies. But they still live in the application's database. At 70,000 tasks a second, the three writes per task, the constant deletes, and thousands of workers polling the same index would overwhelm a database whose real job is orders. And every team running a queue would need its own. The next stage gives the queue a service of its own.

<!-- stage:3:3. A Queue Service -->

## Stage 3 — A Partitioned, Replicated Queue Service

The queue moves out of the application's database into a service of its own, shared by every team.

- **A stateless Queue API** receives every enqueue and claim, and routes it to the right partition.
- **Each queue is split into partitions**, spread across many brokers ([Partitioning & Sharding](#/systems/partitioning-sharding)). A busy queue gets more partitions; a quiet one needs one. Enqueues are spread across a queue's partitions by the hash of their idempotency key (or at random, for tasks without one), so a retried enqueue always reaches the partition that already has it.
- **Each partition has a leader and two followers** in other zones. The leader handles all reads and writes for its partition and replicates every change — new tasks, leases, completions — before answering ([Replication](#/systems/replication)).
- **A coordination service** records which broker leads which partition, and holds each leader's lease on its role ([Distributed Locking & Leader Election](#/systems/distributed-locking)).
- **Workers long-poll.** A claim with `wait_s: 20` is held open by the Queue API until a task is ready or 20 seconds pass.

Leaving the application's database costs one thing: an order and its task can no longer be committed in one transaction. Producers that need that guarantee write the task into an outbox table in their own database, in the same transaction as the order, and a relay enqueues it afterwards. The idempotency key makes the relay's retries harmless.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 800 380" width="800" height="380" role="img" aria-label="The checkout service and workers talk to a stateless queue API; the API routes to partition leaders on brokers; partition 1's leader replicates to followers in two other zones; a coordination service records partition leaders">
  <rect x="10" y="40" width="130" height="48" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="75" y="68" text-anchor="middle" class="d-actor-label" font-size="12">Checkout Service</text>
  <rect x="10" y="290" width="130" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="75" y="312" text-anchor="middle" class="d-actor-label" font-size="12">Workers</text>
  <text x="75" y="328" text-anchor="middle" class="d-label-muted" font-size="9">long-poll for tasks</text>
  <g data-fail-toggle="api3">
    <rect x="190" y="160" width="140" height="60" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="260" y="184" text-anchor="middle" class="d-actor-label" font-size="12">Queue API</text>
    <text x="260" y="200" text-anchor="middle" class="d-label-muted" font-size="9">stateless · routes to</text>
    <text x="260" y="212" text-anchor="middle" class="d-label-muted" font-size="9">partition leaders</text>
  </g>
  <g data-fail-toggle="p1l3">
    <rect x="400" y="40" width="170" height="56" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="485" y="63" text-anchor="middle" class="d-actor-label" font-size="12">Partition 1 · Leader</text>
    <text x="485" y="80" text-anchor="middle" class="d-label-muted" font-size="9">broker 4 · zone a</text>
  </g>
  <g data-fail-toggle="p1f3">
    <rect x="620" y="40" width="170" height="56" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="705" y="63" text-anchor="middle" class="d-actor-label" font-size="12">Partition 1 · Followers</text>
    <text x="705" y="80" text-anchor="middle" class="d-label-muted" font-size="9">brokers 9, 15 · zones b, c</text>
  </g>
  <g data-fail-toggle="coord3">
    <rect x="620" y="170" width="170" height="52" rx="6" class="d-actor-box"></rect>
    <text x="705" y="192" text-anchor="middle" class="d-actor-label" font-size="12">Coordination Service</text>
    <text x="705" y="208" text-anchor="middle" class="d-label-muted" font-size="9">partition map · leader leases</text>
  </g>
  <g data-fail-toggle="p2l3">
    <rect x="400" y="290" width="170" height="56" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="485" y="313" text-anchor="middle" class="d-actor-label" font-size="12">Partition 2 · Leader</text>
    <text x="485" y="330" text-anchor="middle" class="d-label-muted" font-size="9">broker 11 · zone b</text>
  </g>
  <line id="t3-prod-api" x1="110" y1="90" x2="214" y2="156" class="d-msg d-request" data-depends-on="api3" marker-end="url(#arrowT3)"></line>
  <line id="t3-api-prod" x1="230" y1="156" x2="128" y2="92" class="d-msg d-response" data-depends-on="api3" marker-end="url(#arrowT3r)"></line>
  <line id="t3-wk-api" x1="110" y1="288" x2="214" y2="224" class="d-msg d-request" data-depends-on="api3" marker-end="url(#arrowT3)"></line>
  <line id="t3-api-wk" x1="230" y1="224" x2="128" y2="288" class="d-msg d-response" data-depends-on="api3" marker-end="url(#arrowT3r)"></line>
  <line id="t3-api-p1" x1="306" y1="156" x2="418" y2="100" class="d-msg d-request" data-depends-on="api3 p1l3" marker-end="url(#arrowT3)"></line>
  <line id="t3-p1-api" x1="434" y1="100" x2="322" y2="162" class="d-msg d-response" data-depends-on="api3 p1l3" marker-end="url(#arrowT3r)"></line>
  <line id="t3-p1-rep" x1="572" y1="60" x2="616" y2="60" class="d-msg d-request" data-depends-on="p1l3 p1f3" marker-end="url(#arrowT3)"></line>
  <line id="t3-rep-p1" x1="616" y1="78" x2="572" y2="78" class="d-msg d-response" data-depends-on="p1l3 p1f3" marker-end="url(#arrowT3r)"></line>
  <line id="t3-api-p2" x1="306" y1="224" x2="418" y2="286" class="d-msg d-request" data-depends-on="api3 p2l3" marker-end="url(#arrowT3)"></line>
  <line id="t3-p2-api" x1="434" y1="286" x2="322" y2="218" class="d-msg d-response" data-depends-on="api3 p2l3" marker-end="url(#arrowT3r)"></line>
  <line id="t3-api-coord" x1="332" y1="186" x2="616" y2="186" class="d-msg d-request" data-depends-on="api3 coord3" marker-end="url(#arrowT3)"></line>
  <line id="t3-coord-api" x1="616" y1="204" x2="332" y2="204" class="d-msg d-response" data-depends-on="api3 coord3" marker-end="url(#arrowT3r)"></line>
  <line id="t3-coord-rep" x1="705" y1="166" x2="705" y2="100" class="d-msg d-request" data-depends-on="coord3 p1f3" marker-end="url(#arrowT3)"></line>
  <line id="t3-api-rep" x1="332" y1="170" x2="640" y2="100" class="d-msg d-request" data-depends-on="api3 p1f3" marker-end="url(#arrowT3)"></line>
  <line id="t3-rep-api" x1="656" y1="100" x2="334" y2="178" class="d-msg d-response" data-depends-on="api3 p1f3" marker-end="url(#arrowT3r)"></line>
  <text x="400" y="372" text-anchor="middle" class="d-label-muted" font-size="10">play the enqueue, then the long poll, then the retried enqueue, then the leader failure</text>
  <defs>
    <marker id="arrowT3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowT3r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "p1", "title": "Partition 1", "rows": [["leader", "broker 4"], ["copies of t_8kQ2", "—"], ["leases held", "—"]]},
{"id": "q", "title": "Queue send_receipt", "rows": [["tasks for order 81723", "—"], ["idle polls per second", "—"]]}
],
"flows": [
{
"id": "enqueue",
"label": "Enqueue — replicated before the 201",
"nodes": ["api3", "p1l3", "p1f3"],
"steps": [
{"el": "t3-prod-api", "payload": "POST send_receipt · key order-81723-receipt", "text": "The checkout service's outbox relay enqueues the receipt task for order 81723, with an idempotency key naming that receipt."},
{"el": "t3-api-p1", "payload": "append (hash of key → P1)", "ms": 1, "text": "The Queue API hashes the idempotency key to pick one of the queue's 16 partitions: partition 1. It has the partition map cached, so it knows broker 4 leads it."},
{"el": "t3-p1-rep", "payload": "replicate t_8kQ2", "text": "Broker 4 checks the key is new, writes the task and the key, and sends both to the partition's followers in two other zones."},
{"el": "t3-rep-p1", "payload": "ack (1 of 2)", "ms": 3, "set": {"p1.copies of t_8kQ2": "2 of 3 zones"}, "text": "One follower confirms. With the leader's own copy, the task is now in two zones out of three. That's a majority, so the leader doesn't wait for the third."},
{"el": "t3-p1-api", "payload": "t_8kQ2 stored", "text": "The leader reports success."},
{"el": "t3-api-prod", "payload": "201 t_8kQ2", "ms": 1, "set": {"q.tasks for order 81723": "1 (t_8kQ2)"}, "text": "The producer gets 201 about 6ms after sending. That 201 means the task survives the loss of any one zone, which is what ‘never lose an accepted task’ requires."}
]
},
{
"id": "poll",
"label": "A worker long-polls for work",
"nodes": ["api3", "p1l3", "p1f3", "p2l3"],
"steps": [
{"el": "t3-wk-api", "payload": "claim send_receipt · wait 20s", "text": "Worker w-17 has free slots. It asks for up to 10 tasks, and says it is willing to wait up to 20 seconds."},
{"el": "t3-api-p2", "payload": "ready tasks?", "text": "The Queue API asks the queue's partitions, starting from a random one so that workers spread evenly. Partition 2 first."},
{"el": "t3-p2-api", "payload": "none", "ms": 1, "text": "Partition 2 has nothing ready."},
{"el": "t3-api-p1", "payload": "claim up to 10", "text": "Partition 1."},
{"el": "t3-p1-rep", "payload": "lease t_8kQ2 → w-17", "text": "Partition 1 has t_8kQ2. It records the lease and replicates it before handing the task out. If this leader died a second later, the new leader must know the task is leased; otherwise it would hand it to another worker while w-17 is still running it."},
{"el": "t3-rep-p1", "payload": "ack", "ms": 3, "set": {"p1.leases held": "t_8kQ2 → w-17"}, "text": "Replicated."},
{"el": "t3-p1-api", "payload": "t_8kQ2 · lease 5501", "text": "The task and its lease go back to the Queue API."},
{"el": "t3-api-wk", "payload": "t_8kQ2", "ms": 1, "set": {"q.idle polls per second": "~7,000, not 1.4 million"}, "text": "The worker has its task. Had nothing been ready, the API would have kept the request open and answered as soon as a task arrived on any of the partitions. 140,000 idle worker slots waiting 20 seconds at a time cost about 7,000 requests a second, instead of 1.4 million for polling every 100ms."}
]
},
{
"id": "retry",
"label": "The producer retries an enqueue",
"nodes": ["api3", "p1l3", "p1f3"],
"steps": [
{"el": "t3-prod-api", "payload": "POST · key order-81723-receipt", "text": "The outbox relay sends the receipt task for order 81723 again. Its first request had succeeded, but the 201 was lost on the way back, so the relay can't know that."},
{"el": "t3-api-p1", "payload": "append (hash of key → P1)", "ms": 1, "text": "Same key, same hash, same partition. That's why enqueues are spread by key: a duplicate always reaches the one partition that can recognize it."},
{"el": "t3-p1-api", "payload": "key known → t_8kQ2", "ms": 1, "text": "Partition 1 finds the key in its idempotency table: this is t_8kQ2. Nothing is written."},
{"el": "t3-api-prod", "payload": "200 t_8kQ2", "set": {"q.tasks for order 81723": "still 1 (t_8kQ2)"}, "text": "The producer gets the original task ID back. One receipt task, no matter how many times the relay retries. Keys are kept for 24 hours, far longer than any producer keeps retrying."}
]
},
{
"id": "failover",
"label": "Partition 1's leader dies",
"nodes": ["api3", "p1l3", "p1f3", "coord3"],
"steps": [
{"el": "t3-prod-api", "payload": "POST · key order-81790-receipt", "text": "Broker 4, partition 1's leader, has just lost power. Another receipt task arrives."},
{"el": "t3-api-p1", "payload": "append", "text": "The Queue API sends it to broker 4, as its cached map says."},
{"el": "t3-p1-api", "payload": "(no answer)", "ms": 500, "set": {"p1.leader": "broker 4 — down"}, "text": "No answer. The API gives up after 500ms. It doesn't return an error yet; a new leader will exist shortly."},
{"el": "t3-coord-rep", "payload": "you lead P1 (epoch 8)", "ms": 2000, "text": "Broker 4 has stopped renewing its leader lease, which expires after 2 seconds. The coordination service makes the most up-to-date follower, broker 9, the leader, with a new epoch number. Broker 9 has every write that was acknowledged, because nothing was acknowledged until two of three copies had it."},
{"el": "t3-api-coord", "payload": "who leads P1?", "text": "The Queue API refreshes its partition map."},
{"el": "t3-coord-api", "payload": "broker 9, epoch 8", "ms": 1, "set": {"p1.leader": "broker 9 (epoch 8)"}, "text": "Broker 9."},
{"el": "t3-api-rep", "payload": "append t_8m71", "text": "The enqueue goes to the new leader."},
{"el": "t3-rep-api", "payload": "stored", "ms": 4, "text": "Stored and replicated to the remaining follower."},
{"el": "t3-api-prod", "payload": "201 t_8m71", "text": "The producer gets 201, about 2.5 seconds late. Workers holding leases on partition 1 complete them with the new leader, which has those leases too. Partition 1 was unavailable for about two seconds; the other 15 partitions never noticed. When broker 4 comes back, its epoch is older than 8, so its writes are refused and it rejoins as a follower."}
]
}
]
}
</script>
<div class="diagram-caption">A stateless API routes each enqueue and claim to a partition leader, which replicates every change to followers in other zones before answering. A coordination service names the leaders and replaces one that stops renewing its lease.</div>
</div>

<div class="fail-hint">Click the Queue API, either partition leader, the followers or the coordination service to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="api3">
<strong>If a Queue API instance fails:</strong> its open requests fail and are retried by producers and workers against another instance behind the load balancer. It holds no state; a long poll that was waiting on it simply starts again elsewhere.
</div>
<div class="failure-impact is-hidden" data-component="p1l3">
<strong>If partition 1's leader fails:</strong> partition 1 can't accept or hand out tasks for about two seconds, until a follower takes over. The fourth flow shows it. Nothing acknowledged is lost, and leases carry over. Producers whose enqueue landed on partition 1 see one slow request.
</div>
<div class="failure-impact is-hidden" data-component="p1f3">
<strong>If partition 1's followers fail:</strong> with one follower down, the leader still has a majority and carries on. With both down, it can't replicate, so it must stop acknowledging enqueues for this partition. The Queue API sends new tasks without an idempotency key to the queue's other partitions; tasks whose key hashes to partition 1 wait.
</div>
<div class="failure-impact is-hidden" data-component="coord3">
<strong>If the coordination service fails:</strong> existing leaders keep working, and the Queue API keeps using its cached partition map. Nothing changes until a leader also fails: then no follower can be promoted, and that partition stays down until coordination returns. The coordination service is itself a small replicated cluster, so this needs two failures at once ([Consensus](#/systems/consensus)).
</div>
<div class="failure-impact is-hidden" data-component="p2l3">
<strong>If partition 2's leader fails:</strong> the same two-second failover happens on partition 2, independently. Workers' long polls are answered from the other partitions in the meantime.
</div>
</div>

The queue now has room to grow, survives losing a broker or a zone, and doesn't make idle workers hammer it. But a task that fails is put straight back as ready, and retried at once, as fast as workers can take it — against a service that may be down. A task that can never succeed is retried forever. And there is no way to say "run this tomorrow at 9am".

<!-- stage:4:4. Retries & Delays -->

## Stage 4 — Delays, Retries with Backoff, and Dead Letters

Time becomes part of every task.

- **Each partition keeps a delay index**, ordered by `run_at`. A task scheduled for the future goes there instead of into the ready index. A timer on the partition leader checks the front of the delay index every 100ms and moves tasks that have become due into the ready index.
- **A failed attempt becomes a delayed task.** The worker reports the failure; the partition sets `run_at` to now plus a backoff that doubles with each attempt — 10 seconds, 20, 40, up to an hour — with a random spread so that tasks that failed together don't retry together.
- **A task that runs out of attempts goes to the dead-letter queue**, along with every error it hit. So does a task whose failure the worker marks as not worth retrying. Dead tasks wait there for a person.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 720 300" width="720" height="300" role="img" aria-label="A producer enqueues through the queue API into a partition's ready index or delay index; workers claim from the ready index and call an email provider; failed tasks move to the delay index and come back when due; tasks out of attempts move to the dead-letter queue">
  <rect x="10" y="40" width="120" height="44" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="70" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Producer</text>
  <rect x="170" y="40" width="130" height="44" rx="6" class="d-actor-box" data-role="routing"></rect>
  <text x="235" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Queue API</text>
  <rect x="350" y="40" width="150" height="48" rx="6" class="d-actor-box" data-role="datastore"></rect>
  <text x="425" y="60" text-anchor="middle" class="d-actor-label" font-size="12">Ready Index</text>
  <text x="425" y="76" text-anchor="middle" class="d-label-muted" font-size="9">partition · runnable now</text>
  <g data-fail-toggle="wk4">
    <rect x="560" y="40" width="140" height="44" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="630" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Workers</text>
  </g>
  <g data-fail-toggle="dl4">
    <rect x="170" y="190" width="150" height="52" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="245" y="211" text-anchor="middle" class="d-actor-label" font-size="12">Delay Index</text>
    <text x="245" y="228" text-anchor="middle" class="d-label-muted" font-size="9">by run_at · timer every 100ms</text>
  </g>
  <g data-fail-toggle="dlq4">
    <rect x="355" y="190" width="140" height="52" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="425" y="211" text-anchor="middle" class="d-actor-label" font-size="12">Dead-Letter Queue</text>
    <text x="425" y="228" text-anchor="middle" class="d-label-muted" font-size="9">kept for a person</text>
  </g>
  <g data-fail-toggle="ep4">
    <rect x="560" y="190" width="140" height="52" rx="6" class="d-actor-box"></rect>
    <text x="630" y="221" text-anchor="middle" class="d-actor-label" font-size="12">Email Provider</text>
  </g>
  <line id="t4-prod-api" x1="132" y1="56" x2="166" y2="56" class="d-msg d-request" marker-end="url(#arrowT4)"></line>
  <line id="t4-api-prod" x1="166" y1="72" x2="132" y2="72" class="d-msg d-response" marker-end="url(#arrowT4r)"></line>
  <line id="t4-api-ready" x1="302" y1="62" x2="346" y2="62" class="d-msg d-request" marker-end="url(#arrowT4)"></line>
  <line id="t4-api-delay" x1="235" y1="86" x2="235" y2="186" class="d-msg d-request" data-depends-on="dl4" marker-end="url(#arrowT4)"></line>
  <line id="t4-ready-delay" x1="372" y1="90" x2="312" y2="186" class="d-msg d-request" data-depends-on="dl4" marker-end="url(#arrowT4)"></line>
  <line id="t4-delay-ready" x1="294" y1="186" x2="356" y2="92" class="d-msg d-response" data-depends-on="dl4" marker-end="url(#arrowT4r)"></line>
  <line id="t4-ready-dlq" x1="425" y1="90" x2="425" y2="186" class="d-msg d-request" data-depends-on="dlq4" marker-end="url(#arrowT4)"></line>
  <line id="t4-wk-ready" x1="556" y1="56" x2="504" y2="56" class="d-msg d-request" data-depends-on="wk4" marker-end="url(#arrowT4)"></line>
  <line id="t4-ready-wk" x1="504" y1="72" x2="556" y2="72" class="d-msg d-response" data-depends-on="wk4" marker-end="url(#arrowT4r)"></line>
  <line id="t4-wk-ep" x1="620" y1="86" x2="620" y2="186" class="d-msg d-request" data-depends-on="wk4 ep4" marker-end="url(#arrowT4)"></line>
  <line id="t4-ep-wk" x1="640" y1="186" x2="640" y2="86" class="d-msg d-response" data-depends-on="wk4 ep4" marker-end="url(#arrowT4r)"></line>
  <text x="360" y="290" text-anchor="middle" class="d-label-muted" font-size="10">play the delayed task, then the retries, then the poison task; fail the email provider and replay the retries</text>
  <defs>
    <marker id="arrowT4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowT4r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "task", "title": "The task", "rows": [["state", "—"], ["attempt", "—"], ["runs at", "—"]]},
{"id": "log", "title": "History", "rows": [["errors", "—"]]}
],
"flows": [
{
"id": "delayed",
"label": "Send a reminder tomorrow at 9:00",
"nodes": ["dl4", "wk4", "ep4"],
"steps": [
{"el": "t4-prod-api", "payload": "enqueue · run_at tomorrow 09:00", "set": {"task.state": "—", "task.attempt": "—", "task.runs at": "—", "log.errors": "—"}, "text": "A customer left items in their cart. The shop wants to send a reminder tomorrow at 9:00."},
{"el": "t4-api-delay", "payload": "t_r55 · run_at 09:00", "ms": 6, "set": {"task.state": "delayed", "task.attempt": "0", "task.runs at": "tomorrow 09:00:00"}, "text": "The task's run_at is in the future, so the partition puts it in the delay index rather than the ready index. Replicated and acknowledged like any other task."},
{"el": "t4-api-prod", "payload": "201 t_r55", "text": "The producer has its answer. The task now sits in the delay index, sorted by time, among about 300 million others. Nothing reads or touches it until it is near the front."},
{"el": "t4-delay-ready", "payload": "due: t_r55", "set": {"task.state": "ready"}, "text": "Tomorrow at 09:00:00.08, the partition's timer, which checks the front of the delay index every 100ms, finds t_r55 is due and moves it to the ready index. The check is cheap however many tasks are waiting: it only looks at the earliest ones."},
{"el": "t4-wk-ready", "payload": "claim", "text": "A long-polling worker is waiting on this partition."},
{"el": "t4-ready-wk", "payload": "t_r55 · attempt 1", "ms": 3, "set": {"task.state": "leased", "task.attempt": "1"}, "text": "It gets the task the moment it becomes ready."},
{"el": "t4-wk-ep", "payload": "send reminder · key t_r55", "text": "The worker sends the reminder."},
{"el": "t4-ep-wk", "payload": "sent", "ms": 180, "text": "Sent."},
{"el": "t4-wk-ready", "payload": "complete", "ms": 3, "set": {"task.state": "done"}, "text": "The reminder went out within half a second of 9:00. Delays and retries use the same mechanism, as the next flow shows."}
]
},
{
"id": "retry",
"label": "Fails twice, then succeeds",
"nodes": ["dl4", "wk4", "ep4"],
"steps": [
{"el": "t4-wk-ready", "payload": "claim", "set": {"task.state": "ready", "task.attempt": "0", "task.runs at": "now", "log.errors": "—"}, "text": "Receipt task t_8kQ2 is ready. A worker claims it."},
{"el": "t4-ready-wk", "payload": "t_8kQ2 · attempt 1", "ms": 3, "set": {"task.state": "leased", "task.attempt": "1"}, "text": "Attempt 1."},
{"el": "t4-wk-ep", "payload": "send · key t_8kQ2", "text": "The worker calls the email provider."},
{"el": "t4-ep-wk", "payload": "503 unavailable", "ms": 40, "set": {"log.errors": "#1 503"}, "text": "The provider is overloaded and refuses."},
{"el": "t4-wk-ready", "payload": "fail · retryable · 503", "text": "The worker reports a failure that's worth retrying."},
{"el": "t4-ready-delay", "payload": "run_at now + 10s ± 5s", "set": {"task.state": "delayed (backoff)", "task.runs at": "in 13s"}, "text": "The partition doesn't make it ready again. It schedules it: 10 seconds for the first retry, with a random spread of up to half that either way — this time 13 seconds. Thousands of other receipts failed in the same second. Without the spread they would all come back in the same second too, and hit the provider the moment it started to recover."},
{"el": "t4-delay-ready", "payload": "due: t_8kQ2", "set": {"task.state": "ready"}, "text": "Due again."},
{"el": "t4-ready-wk", "payload": "t_8kQ2 · attempt 2", "ms": 3, "set": {"task.state": "leased", "task.attempt": "2"}, "text": "Attempt 2."},
{"el": "t4-wk-ep", "payload": "send · key t_8kQ2", "text": "Same call, same idempotency key."},
{"el": "t4-ep-wk", "payload": "503 unavailable", "ms": 40, "set": {"log.errors": "#1 503 · #2 503"}, "text": "Still overloaded."},
{"el": "t4-wk-ready", "payload": "fail · retryable · 503", "text": "Reported."},
{"el": "t4-ready-delay", "payload": "run_at now + 20s ± 10s", "set": {"task.state": "delayed (backoff)", "task.runs at": "in 26s"}, "text": "The backoff doubles: 20 seconds, spread, so 26. Each retry waits longer, which gives a struggling service room to recover instead of being hit harder."},
{"el": "t4-delay-ready", "payload": "due: t_8kQ2", "set": {"task.state": "ready"}, "text": "Due."},
{"el": "t4-ready-wk", "payload": "t_8kQ2 · attempt 3", "ms": 3, "set": {"task.state": "leased", "task.attempt": "3"}, "text": "Attempt 3."},
{"el": "t4-wk-ep", "payload": "send · key t_8kQ2", "text": "Third try."},
{"el": "t4-ep-wk", "payload": "sent", "ms": 180, "text": "The provider has recovered. Sent."},
{"el": "t4-wk-ready", "payload": "complete", "ms": 3, "set": {"task.state": "done"}, "text": "The receipt arrived about 40 seconds late, and nobody had to do anything. Fail the email provider and replay this flow: every attempt fails, and the task works its way toward the dead-letter queue, which is the next flow."}
]
},
{
"id": "poison",
"label": "A task that can never succeed",
"nodes": ["dlq4", "wk4"],
"steps": [
{"el": "t4-wk-ready", "payload": "claim", "set": {"task.state": "ready", "task.attempt": "0", "task.runs at": "now", "log.errors": "—"}, "text": "Task t_x91 is a receipt for an order that was deleted by a cleanup job before the task ran."},
{"el": "t4-ready-wk", "payload": "t_x91 · attempt 1", "ms": 3, "set": {"task.state": "leased", "task.attempt": "1"}, "text": "A worker claims it."},
{"el": "t4-wk-ready", "payload": "fail · not retryable · order missing", "set": {"log.errors": "#1 order 81802 not found"}, "text": "The handler can't find the order. Retrying won't create it, so the worker marks the failure as not worth retrying."},
{"el": "t4-ready-dlq", "payload": "t_x91 → dead", "ms": 3, "set": {"task.state": "dead", "task.runs at": "never — waiting for a person"}, "text": "The partition moves it straight to the dead-letter queue, keeping its payload and error history, and the queue's owners are alerted. Most dead tasks are bugs: in the producer, in the handler, or in the order of events between them. Once the cause is fixed, someone redrives the dead tasks, which puts them back in the ready index with a fresh set of attempts."},
{"el": "t4-ready-wk", "payload": "t_x92 · attempt 1", "set": {"task.state": "leased", "task.attempt": "1", "task.runs at": "now", "log.errors": "—"}, "text": "A worse case: task t_x92 has a payload that makes the handler crash the whole worker process — a huge attachment that runs it out of memory. The worker can't report anything."},
{"el": "t4-wk-ready", "payload": "(worker crashed)", "set": {"log.errors": "#1 lease expired"}, "text": "Its lease runs out. A worker that crashes never reports a failure, but the attempt counter went up when the task was claimed, not when it failed, so the crash still counts as an attempt."},
{"el": "t4-ready-wk", "payload": "t_x92 · attempt 8", "set": {"task.attempt": "8", "log.errors": "#1–#7 lease expired"}, "text": "Seven crashed workers later, the eighth attempt starts. This is the queue's limit."},
{"el": "t4-ready-dlq", "payload": "t_x92 → dead", "set": {"task.state": "dead", "task.runs at": "never — waiting for a person"}, "text": "After the eighth lease expires, the task goes to the dead-letter queue. If attempts were counted only when workers reported failures, this task would crash a worker every 30 seconds forever."}
]
}
]
}
</script>
<div class="diagram-caption">Every task carries a time when it may next run. Future and failed tasks wait in a delay index sorted by that time, and a timer moves them back when they are due. A task that runs out of attempts, or fails in a way retrying can't fix, is set aside in a dead-letter queue.</div>
</div>

<div class="fail-hint">Click the workers, the delay index, the dead-letter queue or the email provider to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="wk4">
<strong>If the workers fail:</strong> nothing is claimed, so ready tasks pile up, and due delayed tasks join them. Producers notice nothing: enqueue never depended on workers. When workers return, they work through the backlog oldest first. Tasks that were leased when the workers died come back as their leases expire, each with one attempt used.
</div>
<div class="failure-impact is-hidden" data-component="dl4">
<strong>If the delay index can't be written:</strong> the delay index is part of the partition, so in practice this is a partition failure, handled by the leader failover from Stage 3. A failed attempt that can't be scheduled for retry is left leased, so it comes back when its lease expires, a little earlier than its backoff would have allowed. On the new leader, the timer starts from the front of the delay index, so tasks that became due during the failover run a couple of seconds late, not never.
</div>
<div class="failure-impact is-hidden" data-component="dlq4">
<strong>If the dead-letter queue can't be written:</strong> a task that has run out of attempts stays leased with its lease expired, and is retried once more later. Nothing is dropped; the dead-letter queue is just another set of tasks in the partition, in a state that no claim will ever return.
</div>
<div class="failure-impact is-hidden" data-component="ep4">
<strong>If the email provider fails:</strong> every send fails and every task goes into backoff. Replay the second flow. Retries spread out over minutes, then hours, and the backlog grows. If the outage lasts longer than eight attempts' worth of backoff — about 20 minutes with these settings — tasks start reaching the dead-letter queue, and are redriven once the provider is back. The next stage keeps tasks from burning their attempts during an outage at all.
</div>
</div>

Tasks now survive failing dependencies and wait patiently for their scheduled time, and the ones that can never succeed are set aside instead of looping. What's left is sharing. Hundreds of teams use the same queue service, and many of them share queues across their own customers. One of them is about to enqueue five million tasks at once.

<!-- stage:5:5. Fairness & Backpressure -->

## Stage 5 — Fairness and Backpressure

The `send_email` queue is shared by thousands of shops on the company's platform. Each task carries the shop that caused it as its tenant. Four changes make the queue fair between tenants and safe for the services its workers call.

- **One lane per tenant.** Inside each partition, the ready index is ordered by priority and then tenant, so each tenant's tasks at each priority form their own lane. A **fair dispatcher** on each partition leader hands out tasks by taking turns across lanes that have work, rather than oldest first across the whole queue. A tenant can also have a weight and a cap on how many of its tasks run at once.
- **Priority lanes.** High-priority tasks — receipts, password resets — are taken before low-priority ones like newsletters. Low priority gets a small guaranteed share, so it's never stopped completely.
- **Enqueue limits.** Each queue and each tenant has a rate limit at the Queue API. A producer over its limit gets `429` with `Retry-After`, and its client library waits ([Rate Limiting & Backpressure](#/systems/rate-limiting)).
- **A concurrency limit that adapts.** Each queue can cap how many of its tasks run at once. The dispatcher lowers the cap when workers report the downstream service is slow or failing, and raises it slowly when it recovers. Tasks wait in the queue, which is cheap, instead of failing against a service that can't take them, which wastes their attempts.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 820 320" width="820" height="320" role="img" aria-label="Shop A and Shop B enqueue through a queue API that enforces limits into a partition with one lane per tenant; a fair dispatcher takes turns across lanes and hands tasks to workers, which call an email provider">
  <rect x="10" y="40" width="120" height="44" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="70" y="60" text-anchor="middle" class="d-actor-label" font-size="12">Shop A</text>
  <text x="70" y="75" text-anchor="middle" class="d-label-muted" font-size="9">newsletter · 5M emails</text>
  <rect x="10" y="200" width="120" height="44" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="70" y="220" text-anchor="middle" class="d-actor-label" font-size="12">Shop B</text>
  <text x="70" y="235" text-anchor="middle" class="d-label-muted" font-size="9">one order receipt</text>
  <g data-fail-toggle="api5">
    <rect x="170" y="112" width="135" height="56" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="237" y="135" text-anchor="middle" class="d-actor-label" font-size="12">Queue API</text>
    <text x="237" y="152" text-anchor="middle" class="d-label-muted" font-size="9">per-tenant limits · 429</text>
  </g>
  <g data-fail-toggle="part5">
    <rect x="345" y="50" width="180" height="180" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="435" y="74" text-anchor="middle" class="d-actor-label" font-size="12">Partition · send_email</text>
    <text x="435" y="94" text-anchor="middle" class="d-label-muted" font-size="9">one lane per tenant</text>
    <text x="435" y="124" text-anchor="middle" class="d-label-muted" font-size="10">shop A · low · 5,000,000</text>
    <text x="435" y="146" text-anchor="middle" class="d-label-muted" font-size="10">shop B · high · 1</text>
    <text x="435" y="168" text-anchor="middle" class="d-label-muted" font-size="10">2,400 other shops · ~3 each</text>
    <text x="435" y="200" text-anchor="middle" class="d-label-muted" font-size="9">ready · delayed · leased</text>
  </g>
  <g data-fail-toggle="disp5">
    <rect x="565" y="112" width="125" height="56" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="627" y="135" text-anchor="middle" class="d-actor-label" font-size="12">Fair Dispatcher</text>
    <text x="627" y="152" text-anchor="middle" class="d-label-muted" font-size="9">turns · concurrency cap</text>
  </g>
  <g data-fail-toggle="wk5">
    <rect x="720" y="112" width="90" height="56" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="765" y="144" text-anchor="middle" class="d-actor-label" font-size="12">Workers</text>
  </g>
  <rect x="700" y="240" width="110" height="44" rx="6" class="d-actor-box"></rect>
  <text x="755" y="266" text-anchor="middle" class="d-actor-label" font-size="12">Email Provider</text>
  <line id="t5-a-api" x1="110" y1="86" x2="196" y2="108" class="d-msg d-request" data-depends-on="api5" marker-end="url(#arrowT5)"></line>
  <line id="t5-api-a" x1="180" y1="112" x2="98" y2="88" class="d-msg d-response" data-depends-on="api5" marker-end="url(#arrowT5r)"></line>
  <line id="t5-b-api" x1="110" y1="198" x2="196" y2="172" class="d-msg d-request" data-depends-on="api5" marker-end="url(#arrowT5)"></line>
  <line id="t5-api-b" x1="180" y1="168" x2="98" y2="196" class="d-msg d-response" data-depends-on="api5" marker-end="url(#arrowT5r)"></line>
  <line id="t5-api-part" x1="307" y1="140" x2="341" y2="140" class="d-msg d-request" data-depends-on="api5 part5" marker-end="url(#arrowT5)"></line>
  <line id="t5-part-disp" x1="527" y1="132" x2="561" y2="132" class="d-msg d-request" data-depends-on="part5 disp5" marker-end="url(#arrowT5)"></line>
  <line id="t5-disp-wk" x1="692" y1="132" x2="716" y2="132" class="d-msg d-request" data-depends-on="disp5 wk5" marker-end="url(#arrowT5)"></line>
  <line id="t5-wk-disp" x1="716" y1="150" x2="692" y2="150" class="d-msg d-response" data-depends-on="disp5 wk5" marker-end="url(#arrowT5r)"></line>
  <line id="t5-wk-ep" x1="745" y1="170" x2="745" y2="236" class="d-msg d-request" data-depends-on="wk5" marker-end="url(#arrowT5)"></line>
  <line id="t5-ep-wk" x1="785" y1="236" x2="785" y2="170" class="d-msg d-response" data-depends-on="wk5" marker-end="url(#arrowT5r)"></line>
  <text x="410" y="308" text-anchor="middle" class="d-label-muted" font-size="10">play the newsletter, then the slow provider, then the over-limit producer</text>
  <defs>
    <marker id="arrowT5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowT5r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "q", "title": "Queue send_email", "rows": [["shop A waiting", "0"], ["concurrency cap", "4,000"], ["backlog", "~7,000"]]},
{"id": "b", "title": "Shop B's receipt", "rows": [["wait if oldest first", "—"], ["actual wait", "—"]]}
],
"flows": [
{
"id": "flood",
"label": "Shop A sends a 5-million-email newsletter",
"nodes": ["api5", "part5", "disp5", "wk5"],
"steps": [
{"el": "t5-a-api", "payload": "enqueue 1,000 × 5,000 batches", "text": "Shop A sends its newsletter to 5 million subscribers, enqueued in batches of 1,000 tasks at low priority."},
{"el": "t5-api-part", "payload": "5,000,000 tasks → shop A's lane", "ms": 6, "set": {"q.shop A waiting": "5,000,000", "q.backlog": "~5,007,000"}, "text": "Shop A's limit allows it, so over the next few minutes 5 million tasks land in shop A's lane. The workers can send about 4,000 emails a second."},
{"el": "t5-api-a", "payload": "201 × 5,000", "text": "Shop A's enqueues are accepted. Nobody is being refused anything: the queue's whole point is to hold work that can't be done right away."},
{"el": "t5-b-api", "payload": "enqueue receipt · high", "text": "A customer of shop B places an order. Shop B enqueues a receipt at high priority."},
{"el": "t5-api-part", "payload": "receipt → shop B's lane", "ms": 6, "set": {"b.wait if oldest first": "~21 minutes"}, "text": "It goes into shop B's own lane. If the queue simply handed out its oldest task first, this receipt would wait behind 5 million newsletter emails: at 4,000 a second, about 21 minutes. Every other shop's receipts and password resets would wait just as long."},
{"el": "t5-part-disp", "payload": "lanes with work: A, B, 2,400 others", "text": "The dispatcher doesn't look at the queue as one line. It sees lanes, and high-priority lanes are served before low. Shop B's high-priority receipt is next."},
{"el": "t5-disp-wk", "payload": "shop B's receipt", "ms": 2, "set": {"b.actual wait": "~10 ms"}, "text": "The receipt goes to the next free worker slot, about 10ms after it was enqueued. Other shops' tasks get the same treatment: each lane with work gets its turn."},
{"el": "t5-wk-disp", "payload": "slot free", "text": "When there's nothing else waiting, every free slot goes to shop A. Fairness costs shop A nothing when the queue is quiet; it only stops shop A from taking slots another tenant needs. A 5-million-email newsletter finishes in about 21 minutes either way."}
]
},
{
"id": "slow",
"label": "The email provider slows down",
"nodes": ["disp5", "wk5"],
"steps": [
{"el": "t5-disp-wk", "payload": "4,000 tasks running", "set": {"q.shop A waiting": "3,100,000", "q.concurrency cap": "4,000", "q.backlog": "~3,107,000"}, "text": "Halfway through the newsletter, 4,000 sends are running at once."},
{"el": "t5-wk-ep", "payload": "4,000 sends", "text": "Workers send to the email provider."},
{"el": "t5-ep-wk", "payload": "slow · timeouts", "ms": 8000, "text": "The provider is struggling: responses take 8 seconds instead of 200ms, and some time out after 10."},
{"el": "t5-wk-disp", "payload": "timeouts · latency 8s", "text": "Workers report every result to the dispatcher, with how long it took. Without a limit, a free slot would immediately take another task and send it into the same overloaded provider, which would make it slower still. Every timeout would also use up one of the task's eight attempts."},
{"el": "t5-disp-wk", "payload": "cap 4,000 → 2,000 → 1,000", "set": {"q.concurrency cap": "1,000"}, "text": "The dispatcher halves the queue's concurrency cap each time failures rise, and stops handing out tasks until fewer than 1,000 are running. The tasks don't fail. They wait in their lanes, with their attempts unused."},
{"el": "t5-ep-wk", "payload": "200 OK · 300ms", "ms": 300, "text": "With a quarter of the load, the provider recovers. Its responses are fast again."},
{"el": "t5-disp-wk", "payload": "cap +100 every 10s", "set": {"q.concurrency cap": "4,000 (over ~5 min)"}, "text": "The dispatcher raises the cap a little at a time — fast to back off, slow to return, the same way network congestion control behaves. The backlog drained more slowly for a few minutes, and no task was sent to the dead-letter queue."}
]
},
{
"id": "limit",
"label": "A producer is over its enqueue limit",
"nodes": ["api5", "part5"],
"steps": [
{"el": "t5-a-api", "payload": "enqueue at 60,000/sec", "set": {"q.shop A waiting": "5,000,000", "q.concurrency cap": "4,000"}, "text": "A bug in shop A's integration re-enqueues its whole subscriber list in a loop, at 60,000 tasks a second. Its limit is 10,000 a second."},
{"el": "t5-api-a", "payload": "429 · Retry-After: 2", "text": "The Queue API's per-tenant rate limit refuses the excess with 429. The client library waits two seconds before trying again, and the rest of the refused batch waits with it. The queue tells the producer to slow down rather than silently storing a backlog that would take days to work through."},
{"el": "t5-b-api", "payload": "enqueue receipt", "text": "Meanwhile shop B enqueues another receipt."},
{"el": "t5-api-part", "payload": "receipt → shop B's lane", "ms": 6, "text": "Accepted. Shop B has its own limit, untouched by shop A."},
{"el": "t5-api-b", "payload": "201", "text": "Shop B never sees an error. Shop A's looping tasks would have been mostly duplicates anyway — enqueued with their idempotency keys, they would have been recognized and not stored twice. Limits catch what keys can't: genuinely new tasks, created far faster than any worker pool will run them."}
]
}
]
}
</script>
<div class="diagram-caption">Each tenant's tasks wait in their own lane. The dispatcher takes turns across lanes, so a tenant with a huge backlog can't delay everyone else. Enqueue limits push back on producers that are too fast, and an adaptive concurrency cap keeps tasks waiting in the queue instead of failing against a struggling service.</div>
</div>

<div class="fail-hint">Click the Queue API, the partition, the dispatcher or the workers to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="api5">
<strong>If a Queue API instance fails:</strong> producers retry against another instance. Rate limits are counted locally by each API instance and synced every second, so a failed instance briefly lets a tenant go slightly over its limit. That's an acceptable error for a limit meant to stop runaways, not to bill by the task ([Rate Limiter as a Service](#/systems-case-studies/rate-limiter)).
</div>
<div class="failure-impact is-hidden" data-component="part5">
<strong>If the partition fails:</strong> leader failover, as in Stage 3. The lanes are part of the partition's stored data, so they survive intact on the new leader.
</div>
<div class="failure-impact is-hidden" data-component="disp5">
<strong>If the dispatcher fails:</strong> it runs on the partition leader, so it fails over with it. Its state — whose turn is next, how many tasks each tenant has running, the current concurrency cap — is in memory and rebuilt from the partition's leases. The cap restarts at a safe, low value and climbs again. For a few seconds the turns aren't perfectly fair; nobody can tell.
</div>
<div class="failure-impact is-hidden" data-component="wk5">
<strong>If the workers fail:</strong> every lane grows, but they grow side by side. When workers return, the dispatcher's turns mean each tenant's oldest work is served together, instead of one tenant's backlog going first. Autoscaling adds workers when the age of the oldest ready task rises — but only when the downstream service is healthy, since more workers against a struggling service makes it worse.
</div>
</div>

This is the full design. Producers enqueue through a stateless API that enforces per-tenant limits and recognizes retried enqueues by their idempotency keys. Each queue is split into partitions, each stored on a leader and two followers in other zones, and nothing is acknowledged before two zones have it. Inside a partition, every task is in one of three indexes: ready, waiting for a time, or leased to a worker until a deadline. Workers long-poll for tasks, run them, and report back with their lease. An expired lease puts the task back, failures are retried with growing, randomized delays, and tasks that can't succeed go to a dead-letter queue for a person. A dispatcher on each partition shares workers fairly between tenants and slows down when the services workers call are struggling. Every handler is written to be safe to run twice, because the queue guarantees that every task finishes — not that it starts only once.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### A queue is not a log

A log, such as Kafka, stores messages in order and lets each consumer group remember one position: everything before it has been processed ([Log-Based Systems](#/systems/log-based-systems)). That makes a log extremely cheap, because it only ever appends, and lets any number of consumers read the same data independently.

A task queue needs things a single position can't express:

- **Tasks finish out of order.** Task 1,000 may take a minute and task 1,001 a millisecond. With a log, the consumer can't move past 1,000 until it's done, so one slow task holds up everything behind it in its partition.
- **One task can be retried without the others.** A log retries by rewinding, which replays everything after the failure too.
- **Delays.** A log delivers in the order things were written, not in the order they are due.
- **Parallelism.** A log partition is read by one consumer at a time, so a queue with 16 partitions can keep 16 consumers busy. A task queue partition can hand tasks to as many workers as it has tasks.

The cost is that a task queue writes a task's state several times, where a log writes a message once. Use a log for streams of events that many systems read; use a task queue for units of work that one worker must complete.

### Making a task safe to run twice

The queue guarantees that each task completes. It can't guarantee it runs once: a worker can do the work and crash before reporting it, and from the outside that looks the same as crashing before doing it. So handlers make repeats harmless ([Idempotency & Exactly-Once Delivery](#/systems/idempotency)):

- **Pass the task ID to the service being called** as its idempotency key, as Stage 2's email send did. Most payment and messaging providers accept one.
- **Record the task ID in the same transaction as the effect.** A handler that updates a database inserts the task ID into a `processed_tasks` table in the same transaction. A repeat finds the row, and does nothing.
- **Make the operation naturally repeatable.** "Set the balance to 120" can run twice; "add 20 to the balance" can't.
- **Check the lease before committing.** A handler that has been running a long time asks, as part of its final write, whether its lease is still current — and passes the lease ID as a fencing token, so a store can reject a write from a worker that has been replaced ([Distributed Locking & Leader Election](#/systems/distributed-locking)).

### Lease length and heartbeats

A lease that is too short makes slow tasks run twice. One that is too long makes a crashed worker's tasks wait. The usual answer is a short lease — 30 seconds — extended by a heartbeat every 10 seconds while the worker is still working. A crashed worker stops heartbeating, and its tasks come back within 30 seconds. A worker running a ten-minute task keeps it for ten minutes.

The heartbeat runs on its own thread, separate from the work, so a task stuck in a tight loop still heartbeats. That is why every task also has a `timeout_s`: the queue refuses to extend a lease past it, so a hung task is eventually given to another worker.

### Ordering

The queue hands tasks out roughly in the order they were enqueued, but promises nothing: retries, delays, partitions and fair turns all reorder them. For most tasks that's correct — two receipts don't care about each other.

When order matters, a producer gives tasks an **ordering key**, such as an account ID. All tasks with the same key go to the same partition, and the partition leases at most one task per key at a time. That gives strict order per key, at two costs. Tasks for one key run one at a time, never in parallel. And a failing task blocks every task behind it on that key until it succeeds or is dead-lettered — usually the right behaviour, since the later tasks probably depend on it.

### Priorities that don't starve

Strict priority — always take high before low — means low-priority tasks never run while high-priority ones keep arriving. The dispatcher instead serves priorities by weight: out of every 100 tasks dispatched, up to 90 come from high priority and at least 10 from low, whenever both have work. If high priority has no work, low gets everything.

### Large payloads

Payloads are capped at 256KB because every byte is written three times per state change and replicated three times. A task that needs a 20MB video passes a reference to object storage. The producer writes the file first, then enqueues; the worker reads it, and the file is deleted by a lifecycle rule after a few days rather than by the task, so a retry still finds it.

### Cancelling a task

A ready or delayed task is cancelled by deleting it from its index. A leased task can't be stopped from outside — the worker is running it. The queue marks it as cancelled, and the worker learns this in the response to its next heartbeat and stops if it can. If the task finishes anyway, its completion is accepted: the queue can't undo an email that was already sent.

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### Duplicates are the user's problem

At-least-once execution moves the hard part to every handler. The queue makes duplicates rare — heartbeats prevent most of them — but a team that writes a handler that isn't safe to repeat will, eventually, charge a card twice. The alternative, at-most-once, loses tasks instead, which is rarely better.

### Every task is several writes

A task is written when it is enqueued, claimed, and completed, plus once per heartbeat and once per retry, each replicated three times. That is several times what a log pays per message. It buys per-task state — out-of-order completion, retries, leases — and is the reason the queue isn't used for high-volume event streams.

### Partitions limit a single queue

A queue's throughput is the sum of its partitions'. A queue with too few partitions is limited by its busiest leader; a queue with too many spreads a small backlog thinly, and long polls must check more partitions to find work. Adding partitions is cheap. Removing them means draining them first.

### The delay index costs storage, not work

300 million delayed tasks take about 750GB that nothing reads until they're due. This is cheap per task, but a producer that schedules millions of tasks a month ahead is storing them, replicated, for a month. Long-range schedules belong in a scheduler that enqueues them close to their time.

### Fairness costs simple ordering

Taking turns across lanes means no global "oldest first". A task from a tenant with a long lane waits longer than its age suggests, by design. Fairness also needs the dispatcher to track lanes and per-tenant counts in memory, which is complexity a single-tenant queue doesn't need.

### Backoff delays recovery

Retrying slowly protects a recovering service, but it also means that when the service comes back, tasks that were in long backoff still wait — about ten minutes before an eighth attempt, and up to an hour on queues that allow more attempts. Operators can redrive delayed tasks early once they know a dependency is healthy.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

A task queue sits between services, carries their data, and makes workers do things. Anyone who can put a task on a queue can make its workers act ([Security & Authentication](#/systems/security-authentication)).

### Who may enqueue, and who may claim

Every producer and worker authenticates as a service identity, with mutual TLS inside the company's network. Each queue lists which identities may enqueue to it and which may claim from it. A service that can enqueue to `charge_card` can charge cards, so that permission is granted as carefully as access to the payment service itself.

### The tenant comes from the caller, not the payload

The tenant on a task decides its fair share and its rate limit. It is set from the producer's authenticated identity, or checked against it, never taken from the request body. Otherwise a tenant could spread its tasks across other tenants' lanes and limits, or make its tasks look like someone else's.

### Payloads are data, never code

Workers decode payloads with a fixed schema per task type. Formats that can describe arbitrary objects — the kind some languages' serializers can turn into code execution on load — are never accepted. A queue only accepts the task types it lists, so a payload can't ask a worker to run a handler it was never meant to.

### Sensitive data in payloads

Payloads sit in the queue for seconds, but in the dead-letter queue, logs and debugging tools for days. Personal data is passed by reference — an order ID, not the customer's card details — and anything that must be in the payload is encrypted with a key only workers hold. The dead-letter view shows payloads only to the queue's owners.

### Tasks that create tasks

A handler that enqueues more tasks can create a loop, or an explosion: each task creating two more doubles the queue every few seconds. Each task carries a depth counter, incremented when a handler enqueues from inside another task, and the queue rejects tasks past a set depth. Per-tenant enqueue limits catch the rest.

### Redrive is a privileged action

Redriving the dead-letter queue re-runs tasks that failed — possibly payments, possibly days later. Redrive requires the queue owner's permission, is logged, and for sensitive queues requires a second person to approve.

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **Age of the oldest ready task** per queue. This is the single best measure of whether a queue is keeping up: a backlog of a million is fine if it's ten seconds old.
- **Enqueue rate and completion rate** per queue. A backlog grows when the first exceeds the second; which one moved tells you why.
- **Enqueue latency** at p99, and the rate of `429` responses per tenant.
- **Attempt failures** per queue and per error, and the **retry rate**.
- **Dead-letter arrivals** per queue.
- **Lease expiries** per queue: tasks whose worker went quiet. Each one is a likely duplicate run.
- **Delay accuracy**: how late due tasks become ready.
- **Concurrency cap** per queue, against its configured maximum. A cap held low means a downstream service is struggling.
- **Partition leader changes** and **replication lag**.

([Observability](#/systems/observability))

### What to alert on

- Oldest ready task older than the queue's own target — 60 seconds for receipts, an hour for reports — for 5 minutes.
- Any dead-letter arrival on a queue marked critical, or a jump in dead letters on any queue.
- Lease expiries above a small baseline.
- Enqueue p99 above **50ms**.
- Due delayed tasks becoming ready more than **5 seconds** late.
- A partition without a leader for more than **10 seconds**.

### A queue's backlog is growing — what happens?

First, compare the enqueue rate with the completion rate. If enqueues jumped — a bulk job, a looping producer — the workers are fine; check the tenant's lane and whether its limit is set sensibly. If completions fell, look at why. Many lease expiries mean workers are dying or tasks are hitting their timeouts. A low concurrency cap and slow attempts mean a downstream service is struggling: adding workers would make it worse, so wait for it, or talk to its owners. Few workers claiming means the worker fleet is short: scale it.

### Lease expiries spike after every deploy — what happens?

Workers are being stopped with tasks still leased. Each of those tasks waits up to 30 seconds and then runs again, as a duplicate if the worker had already done the work. Workers should shut down gracefully: stop claiming, finish what they can within a deadline, and release the rest so another worker takes them immediately.

### The dead-letter queue fills after a release — what happens?

A batch of tasks is failing in the same way, almost always because of the release. Roll back first. Then look at the dead tasks' errors to confirm the cause, and redrive them once the fix is deployed. Redrive in batches, at a limited rate, so a backlog of thousands doesn't hit the downstream service at once.
