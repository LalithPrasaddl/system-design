# Distributed Lock Service

A lock service lets processes on different machines agree that exactly one of them is doing something: running tonight's billing job, acting as leader for a group of replicas, updating one account's balance. Taking a lock is one line of code. The difficulty is everything around that line. The service must not forget who holds what when one of its machines dies. Two halves of a split network must not each grant the same lock. And a lock holder can stop for fifteen seconds and wake up believing nothing has changed. This case study builds a lock and leader-election service for a whole company's backend: five machines, a hundred thousand clients, and no lock ever granted to two of them at once.

<!-- tab:requirements:Requirements -->

## Requirements

This case study builds a coordination service that a company's other services use for locks and leader election. It stores who holds what. It doesn't run anyone's work.

### Functional requirements

- **Acquire and release named locks.** Locks are exclusive. An acquire can wait for the lock, in order of arrival, up to a time limit.
- **Issue a fencing token with every grant**: a number larger than that of any earlier grant of the same lock.
- **Sessions.** A client keeps one session alive with regular keepalives. When a session ends, every lock it holds is released and it leaves every queue it was waiting in.
- **Leader election.** Clients campaign for a named role, offering a value — usually their address. Anyone can read or watch who currently holds the role.
- **Watch** a lock or role and receive every change to it, in order.
- **Inspect** a lock: who holds it, since when, and how many are waiting.
- **Force-release**, for operators, with a recorded reason.

### Non-functional requirements

- **Safety:** a lock is never granted to two sessions at once — across node crashes, restarts and network partitions. Tokens for a lock only ever increase.
- **Availability:** keeps working with any 2 of its 5 nodes lost, or a whole zone. A new leader within about 2 seconds of losing one.
- **Latency:** acquiring a free lock takes 5ms at the median and under 20ms at p99, within a region.
- **Crash release:** a crashed client's locks are released within 10 seconds.
- **Scale:** 100,000 sessions, 10,000 lock writes a second, 200,000 open watches.
- **Durability:** a granted lock is never forgotten, even if all five nodes restart at once.

### In scope

Replication through consensus, sessions and keepalives, fencing tokens, wait queues, leader election, watches, and spreading reads, watches and keepalives across the nodes.

### Out of scope

**Shared (read) locks.** **Locks spanning regions**: each region runs its own service, because a lock agreed across regions pays a cross-region round trip on every acquire. **General-purpose storage**: values are limited to 1KB. **The proofs behind the consensus protocol**, covered in [Consensus](#/systems/consensus).

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

A lock service stores very little. What shapes it is how often that little changes, and how many clients are checking in.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Client sessions</div>
<div class="stat-tile-value">~100<span class="stat-tile-unit">K</span></div>
<div class="stat-tile-sub">one per client process</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Keepalives</div>
<div class="stat-tile-value">~33<span class="stat-tile-unit">K/s</span></div>
<div class="stat-tile-sub">one every 3s per session</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Lock writes</div>
<div class="stat-tile-value">~10<span class="stat-tile-unit">K/s</span></div>
<div class="stat-tile-sub">acquires + releases</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Disk flushes</div>
<div class="stat-tile-value">~1,000<span class="stat-tile-unit">/s</span></div>
<div class="stat-tile-sub">~10 writes per flush</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">State</div>
<div class="stat-tile-value">~350<span class="stat-tile-unit">MB</span></div>
<div class="stat-tile-sub">in memory on every node</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Commit time</div>
<div class="stat-tile-value">~5<span class="stat-tile-unit">ms</span></div>
<div class="stat-tile-sub">one zone hop + one flush</div>
</div>
</div>

### Assumptions

- **100,000** client sessions across the company: one per process that uses locks or elections.
- Sessions have a **10-second** TTL and send a keepalive every **3 seconds**.
- At peak, **5,000** acquires and **5,000** releases a second.
- About **1 million** named locks and roles exist at any time, at about **300 bytes** each.
- **200,000** open watches.
- One log entry is about **200 bytes**.
- The five nodes are spread over three zones, two, two and one. A round trip between zones takes **1–2ms**; a disk flush on an SSD takes **0.5–1ms**.

### Writes and the disk

10,000 writes a second at 200 bytes is only **2MB a second** of log. Bytes aren't the problem; disk flushes are. A lock can't be granted until its log entry is safely on disk, and a flush takes up to a millisecond. Flushed one at a time, that's at most about 1,000–2,000 writes a second. So writes that arrive together are flushed together: around **10 per flush** at peak, **~1,000 flushes a second**.

### Keepalives

100,000 sessions every 3 seconds is **~33,000 keepalives a second** — more than three times the lock writes. Keepalives must not cost a disk flush each. Stage 3 and Stage 5 keep them out of the log.

### Memory

1 million locks × 300 bytes = 300MB, plus 100,000 sessions at about 200 bytes each, plus queues: **~350MB**. Every node holds the whole state in memory.

### Latency

A write commits once 3 of the 5 nodes have it on disk. The leader flushes its own copy while sending the entry out. The fastest two followers are its neighbour in the same zone and one node a zone away. The commit therefore waits for one cross-zone round trip plus one flush: **about 5ms**. The p99 is set by slow flushes and pauses on the leader.

<!-- tab:api-design:API Design -->

## API Design

Clients hold one long-lived connection to the service. The calls are shown as HTTP for readability.

### Sessions

```
POST /v1/sessions
{"ttl_ms": 10000}
→ 201 {"session_id": 17, "ttl_ms": 10000}

POST /v1/sessions/17:keepalive                every 3 seconds
→ 200 {"ttl_ms": 10000}

DELETE /v1/sessions/17                        on clean shutdown: releases everything at once
→ 200
```

### Locks

```
POST /v1/locks/billing-run:acquire
{"session_id": 17, "wait_ms": 30000}
→ 200 {"token": 9124}                         granted, now or after waiting
→ 408 {"position": 3}                         still waiting when wait_ms ran out; place given up

POST /v1/locks/billing-run:release
{"session_id": 17, "token": 9124}
→ 200

GET /v1/locks/billing-run
→ 200 {"holder": {"session_id": 17, "client": "billing-worker-a"},
       "token": 9124, "granted_at": "2026-10-08T02:00:00.004Z", "waiting": 2}
```

### Leader election and watches

```
POST /v1/elections/billing-leader:campaign
{"session_id": 17, "value": "10.0.3.7:9000"}
→ 200 {"token": 9500}                         returned when this client becomes leader

GET /v1/elections/billing-leader
→ 200 {"value": "10.0.3.7:9000", "token": 9500}

GET /v1/watch?key=elections/billing-leader&from_index=9500        a stream of events
← {"index": 9733, "key": "elections/billing-leader", "value": "10.0.3.9:9000", "token": 9733}
```

### For operators

```
POST /v1/locks/billing-run:force-release
{"reason": "worker hung, ticket 7731"}
→ 200
```

| Code | Meaning |
|---|---|
| `200` | Done |
| `201` | Session created |
| `403` | The client's identity may not use this name |
| `404` | Session not found or expired: every lock it held is already released |
| `408` | The wait ran out before the lock was granted |
| `409` | Release from a session that doesn't hold the lock, or with an old token |
| `429` | Over the client's quota of sessions, locks or requests |
| `503` | This node can't reach a majority, or an election is under way: retry, on another node if needed |

### Why the details matter

**Every grant returns a token, and the token has to be used.** It is the one guarantee that survives a holder that is wrong about still holding the lock (Stage 3).

**Locks belong to a session, not to a TTL of their own.** A client holding fifty locks sends one keepalive, and if it dies all fifty are released together.

**An acquire is safe to retry.** A request that times out may or may not have been committed. An acquire from a session that already holds the lock returns the same token, so retrying is harmless.

**A wait that runs out gives up its place.** Otherwise the lock could later be handed to a client that stopped listening, and sit unused until its session expired.

**Watches resume from an index.** Every change carries its position in the log. A client that reconnects asks for changes after the last index it saw, and misses nothing.

**`503` never means "maybe granted".** A node that can't reach a majority refuses to answer rather than answering from what it last knew.

<!-- tab:data-model:Data Model -->

## Data Model

The service has no database underneath it: it is the database. Its state is a small set of tables held in memory on every node, and a log of every change that produced them.

### The log

```
index   term   entry
9122    7      session_open    {session: 17, client: "billing-worker-a", ttl_ms: 10000}
9123    7      acquire_wait    {lock: "account-77", session: 31}
9124    7      acquire         {lock: "billing-run", session: 17}
9125    7      release         {lock: "account-77", session: 12, next: 31}
9126    7      session_expire  {session: 40, released: ["refresh-rates"]}
```

Every change is an entry in one ordered log, and every node applies the same entries in the same order. A node's tables are therefore exactly what the log says they are. The **index** is the entry's position. The **term** is the election period in which it was written.

### The tables the log builds

```
sessions
  session_id    BIGINT PRIMARY KEY
  client_id     TEXT          -- from the client's certificate
  ttl_ms        INT
  opened_index  BIGINT
  -- deadlines are kept in the leader's memory, not here (Stage 3)

locks                         -- elections are locks with a value
  name          TEXT PRIMARY KEY
  holder        BIGINT        -- session_id; null when free
  token         BIGINT        -- index of the entry that granted it
  value         TEXT          -- for elections: the leader's address
  granted_at    TIMESTAMP

waiters
  name          TEXT
  queued_index  BIGINT        -- index of the entry that queued it: the place in line
  session_id    BIGINT
  PRIMARY KEY (name, queued_index)
```

### Fencing tokens

A lock's token is the index of the log entry that granted it. Log indexes only increase, so each grant of a lock has a larger token than the one before, without a counter per lock.

### On disk

Each node appends the log to disk and flushes it before acknowledging an entry. Every 100,000 entries it writes a **snapshot** — its full tables, about 350MB — and deletes the log before that point. A restarting node loads its latest snapshot and replays the log after it.

### Why this storage

The state is small enough for memory, and every change has to be agreed by a majority of nodes before it counts. A replicated log is exactly that: a consensus protocol decides the order of entries, and each node's tables are built by applying them ([Consensus](#/systems/consensus), [Replication](#/systems/replication)). An external database would add a second system whose own failover would have to be at least as safe as the service it was supporting.

<!-- tab:architecture:Architecture:default -->

This case study builds the lock service up in five stages. Each stage fixes a specific failure of the one before. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one request at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. One Lock Server -->

## Stage 1 — One Lock Server, in Memory

The simplest lock service is one process with a map from lock names to holders. To acquire a lock, a client asks the server to set the name to its own ID, but only if no one holds it, and with an expiry: 30 seconds. While working, the holder extends the expiry every 10 seconds. When done, it deletes the entry, but only if the entry is still its own. Anyone who finds the lock held asks again a second later.

```
SET billing-run worker-a IF ABSENT EXPIRE 30s     → OK | HELD
EXTEND billing-run worker-a 30s                   every 10s while working
DELETE billing-run IF VALUE = worker-a
```

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 780 310" width="780" height="310" role="img" aria-label="Two billing workers ask a single lock server for the billing-run lock and write invoices to a billing database">
  <g data-fail-toggle="ls1">
    <rect x="300" y="20" width="200" height="74" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="400" y="45" text-anchor="middle" class="d-actor-label" font-size="12">Lock Server</text>
    <text x="400" y="62" text-anchor="middle" class="d-label-muted" font-size="9">one process · in memory</text>
    <text x="400" y="77" text-anchor="middle" class="d-label-muted" font-size="9">name → holder, expiry</text>
  </g>
  <g data-fail-toggle="wa1">
    <rect x="30" y="120" width="170" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="115" y="146" text-anchor="middle" class="d-actor-label" font-size="12">Worker A</text>
    <text x="115" y="163" text-anchor="middle" class="d-label-muted" font-size="9">nightly billing job</text>
  </g>
  <g data-fail-toggle="wb1">
    <rect x="30" y="220" width="170" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="115" y="246" text-anchor="middle" class="d-actor-label" font-size="12">Worker B</text>
    <text x="115" y="263" text-anchor="middle" class="d-label-muted" font-size="9">second copy of the job</text>
  </g>
  <g data-fail-toggle="bd1">
    <rect x="590" y="160" width="170" height="70" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="675" y="190" text-anchor="middle" class="d-actor-label" font-size="12">Billing DB</text>
    <text x="675" y="207" text-anchor="middle" class="d-label-muted" font-size="9">invoices</text>
  </g>
  <line id="k1-a-ls" x1="170" y1="118" x2="318" y2="97" class="d-msg d-request" data-depends-on="wa1 ls1" marker-end="url(#arrowK1)"></line>
  <line id="k1-ls-a" x1="345" y1="97" x2="203" y2="128" class="d-msg d-response" data-depends-on="wa1 ls1" marker-end="url(#arrowK1r)"></line>
  <line id="k1-b-ls" x1="202" y1="230" x2="395" y2="98" class="d-msg d-request" data-depends-on="wb1 ls1" marker-end="url(#arrowK1)"></line>
  <line id="k1-ls-b" x1="420" y1="98" x2="203" y2="248" class="d-msg d-response" data-depends-on="wb1 ls1" marker-end="url(#arrowK1r)"></line>
  <line id="k1-a-db" x1="202" y1="145" x2="586" y2="180" class="d-msg d-request" data-depends-on="wa1 bd1" marker-end="url(#arrowK1)"></line>
  <line id="k1-db-a" x1="586" y1="196" x2="203" y2="162" class="d-msg d-response" data-depends-on="wa1 bd1" marker-end="url(#arrowK1r)"></line>
  <line id="k1-b-db" x1="202" y1="262" x2="586" y2="212" class="d-msg d-request" data-depends-on="wb1 bd1" marker-end="url(#arrowK1)"></line>
  <line id="k1-db-b" x1="586" y1="224" x2="203" y2="276" class="d-msg d-response" data-depends-on="wb1 bd1" marker-end="url(#arrowK1r)"></line>
  <text x="390" y="302" text-anchor="middle" class="d-label-muted" font-size="10">play the normal run, then the crashed holder, then the lock server restarting</text>
  <defs>
    <marker id="arrowK1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowK1r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "lk", "title": "Lock server memory", "rows": [["billing-run", "—"]]},
{"id": "inv", "title": "Billing DB", "rows": [["invoices written by", "—"]]}
],
"flows": [
{
"id": "normal",
"label": "Take the lock, run, let go",
"nodes": ["ls1", "wa1", "wb1", "bd1"],
"steps": [
{"el": "k1-a-ls", "payload": "SET billing-run = A, if absent, 30s", "set": {"lk.billing-run": "free", "inv.invoices written by": "—"}, "text": "At 02:00 both copies of the nightly billing job start. Two copies exist so that one machine failing doesn't skip the run — but only one may run it, because running it twice bills every customer twice. Worker A asks the lock server to set billing-run to its own name, only if nobody holds it, expiring in 30 seconds."},
{"el": "k1-ls-a", "payload": "OK · yours", "ms": 1, "set": {"lk.billing-run": "A · expires 02:00:30"}, "text": "Nobody does, so now A holds it. The expiry makes it a lease rather than a lock: if A dies without letting go, the lock frees itself."},
{"el": "k1-b-ls", "payload": "SET billing-run = B, if absent", "text": "Worker B asks a moment later."},
{"el": "k1-ls-b", "payload": "HELD", "ms": 1, "text": "It's held. B will ask again in a second, and keep asking."},
{"el": "k1-a-db", "payload": "write invoices", "set": {"inv.invoices written by": "A"}, "text": "A runs the job. The run takes several minutes, so every 10 seconds A extends its lease back to 30 seconds."},
{"el": "k1-db-a", "payload": "done", "ms": 4, "text": "Four minutes later, the last invoice is written."},
{"el": "k1-a-ls", "payload": "DELETE billing-run, if still A", "text": "A releases the lock — but only if it still holds it, so it can never delete someone else's."},
{"el": "k1-ls-a", "payload": "released", "ms": 1, "set": {"lk.billing-run": "free"}, "text": "B's next attempt will succeed. It will find tonight's run marked complete in the billing DB and exit. The lock decides who goes first; whether the work still needs doing is the job's own business."}
]
},
{
"id": "crash",
"label": "The holder crashes",
"nodes": ["ls1", "wa1", "wb1"],
"steps": [
{"el": "k1-a-ls", "payload": "SET billing-run = A, if absent, 30s", "set": {"lk.billing-run": "free", "inv.invoices written by": "—"}, "text": "A asks for the lock at 02:00."},
{"el": "k1-ls-a", "payload": "OK · yours", "ms": 1, "set": {"lk.billing-run": "A · expires 02:00:30"}, "text": "A holds it and starts the run."},
{"el": "k1-a-db", "payload": "(machine loses power at 02:00:05)", "set": {"inv.invoices written by": "A, until 02:00:05"}, "text": "Five seconds later, A's machine loses power, part-way through the run. It never releases the lock."},
{"el": "k1-b-ls", "payload": "SET billing-run = B, if absent", "text": "B keeps asking, once a second."},
{"el": "k1-ls-b", "payload": "HELD", "ms": 1, "text": "The lock server can't tell a dead holder from a busy one. All it knows is that the lease hasn't expired."},
{"el": "k1-ls-b", "payload": "02:00:30 · OK · yours", "ms": 25000, "set": {"lk.billing-run": "B · expires 02:01:00"}, "text": "At 02:00:30 the lease expires, and B's next attempt succeeds. The expiry is what got the job moving again. It's also the delay: a 30-second lease means up to 30 seconds with nobody running the job. A shorter lease recovers sooner, but a holder that is merely slow loses it more easily."},
{"el": "k1-b-db", "payload": "resume the run", "set": {"inv.invoices written by": "A, then B"}, "text": "B takes over the run. Whether it can safely carry on from A's half-finished work depends on the job; the lock can't help with that."}
]
},
{
"id": "restart",
"label": "The lock server restarts",
"nodes": ["ls1", "wa1", "wb1", "bd1"],
"steps": [
{"el": "k1-a-ls", "payload": "SET billing-run = A, if absent, 30s", "set": {"lk.billing-run": "free", "inv.invoices written by": "—"}, "text": "A takes the lock at 02:00, as usual."},
{"el": "k1-ls-a", "payload": "OK · yours", "ms": 1, "set": {"lk.billing-run": "A · expires 02:00:30"}, "text": "Granted."},
{"el": "k1-a-db", "payload": "write invoices", "set": {"inv.invoices written by": "A"}, "text": "A is a minute into the run."},
{"el": "k1-ls-a", "payload": "(lock server restarted for a deploy)", "set": {"lk.billing-run": "(empty)"}, "text": "The lock server is restarted for a routine deploy. Its whole state was in memory, so it comes back empty. Neither worker is told."},
{"el": "k1-b-ls", "payload": "SET billing-run = B, if absent", "text": "B asks again, as it has every second."},
{"el": "k1-ls-b", "payload": "OK · yours", "ms": 1, "set": {"lk.billing-run": "B · expires 02:01:40"}, "text": "As far as the restarted server knows, the lock is free. B gets it."},
{"el": "k1-b-db", "payload": "write invoices", "set": {"inv.invoices written by": "A and B · customers billed twice"}, "text": "Both workers now run the job, and customers are billed twice. Writing the locks to disk would survive a restart, but not the machine dying — and while the one machine is down, nobody can take any lock. The lock table has to live on several machines that can't disagree about it."}
]
}
]
}
</script>
<div class="diagram-caption">One process keeps a map of lock names to holders and expiry times, in memory. Workers ask for a lock, extend it while working, and delete it when done; a worker that finds it held asks again later.</div>
</div>

<div class="fail-hint">Click the lock server, either worker or the billing DB to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="ls1">
<strong>If the lock server fails:</strong> no one can take or release any lock. Holders can't extend their leases, so a careful holder stops working. When the server comes back it has forgotten every lock, so the next client to ask gets it — even if the old holder is still working. Replay the third flow.
</div>
<div class="failure-impact is-hidden" data-component="wa1">
<strong>If worker A fails while holding the lock:</strong> the lock stays held until its 30-second lease expires. Then B takes over. Replay the second flow.
</div>
<div class="failure-impact is-hidden" data-component="wb1">
<strong>If worker B fails:</strong> it held nothing, so nothing changes. There is just no standby if A fails too.
</div>
<div class="failure-impact is-hidden" data-component="bd1">
<strong>If the billing DB fails:</strong> whoever holds the lock can't do the work. The lock is unaffected: it records who may run the job, not whether the job is getting done.
</div>
</div>

Stage 1 works until its one machine has a problem. Then it fails in the worst way: it doesn't refuse to grant locks, it grants them again. The lock table needs to be on several machines. Copying it is easy. Keeping the copies from disagreeing when machines fail is the hard part.

<!-- stage:2:2. Five Nodes, One Log -->

## Stage 2 — Five Nodes Agreeing Through a Log

The lock table now lives on five nodes, spread across three zones: two, two and one. They run a consensus protocol, Raft ([Consensus](#/systems/consensus)).

- **One node is the leader.** Every change goes to it. Clients that contact another node are redirected.
- **Every change is a log entry.** The leader appends a client's request to its log, flushes it to disk, and sends it to the other four nodes. Each one stores it, flushes it, and replies.
- **An entry is committed once a majority has it**: 3 of 5. Only then does the leader apply it to the lock table and answer the client.
- **Elections.** If the followers stop hearing the leader's heartbeats for about a second, one of them asks the others to make it leader for a new term. It needs 3 votes, and a node only votes for a candidate whose log is at least as complete as its own.
- **A leader that can't reach a majority stops answering.** No majority, no commits, no grants.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 820 340" width="820" height="340" role="img" aria-label="Worker A and worker B talk to node 1, the leader, which replicates each log entry to nodes 2 to 5 across three zones; worker B can also reach node 4, and nodes 3, 4 and 5 can vote for each other">
  <rect x="20" y="60" width="160" height="56" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="100" y="85" text-anchor="middle" class="d-actor-label" font-size="12">Worker A</text>
  <text x="100" y="101" text-anchor="middle" class="d-label-muted" font-size="9">zone a</text>
  <rect x="20" y="240" width="160" height="56" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="100" y="265" text-anchor="middle" class="d-actor-label" font-size="12">Worker B</text>
  <text x="100" y="281" text-anchor="middle" class="d-label-muted" font-size="9">zone b</text>
  <g data-fail-toggle="n12">
    <rect x="270" y="120" width="180" height="100" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="360" y="148" text-anchor="middle" class="d-actor-label" font-size="12">Node 1 · leader</text>
    <text x="360" y="166" text-anchor="middle" class="d-label-muted" font-size="9">zone a</text>
    <text x="360" y="181" text-anchor="middle" class="d-label-muted" font-size="9">log on disk</text>
    <text x="360" y="196" text-anchor="middle" class="d-label-muted" font-size="9">lock table in memory</text>
  </g>
  <g data-fail-toggle="n22">
    <rect x="600" y="20" width="190" height="50" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="695" y="41" text-anchor="middle" class="d-actor-label" font-size="12">Node 2</text>
    <text x="695" y="57" text-anchor="middle" class="d-label-muted" font-size="9">zone a</text>
  </g>
  <g data-fail-toggle="n32">
    <rect x="600" y="100" width="190" height="50" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="695" y="121" text-anchor="middle" class="d-actor-label" font-size="12">Node 3</text>
    <text x="695" y="137" text-anchor="middle" class="d-label-muted" font-size="9">zone b</text>
  </g>
  <g data-fail-toggle="n42">
    <rect x="600" y="180" width="190" height="50" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="695" y="201" text-anchor="middle" class="d-actor-label" font-size="12">Node 4</text>
    <text x="695" y="217" text-anchor="middle" class="d-label-muted" font-size="9">zone b</text>
  </g>
  <g data-fail-toggle="n52">
    <rect x="600" y="260" width="190" height="50" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="695" y="281" text-anchor="middle" class="d-actor-label" font-size="12">Node 5</text>
    <text x="695" y="297" text-anchor="middle" class="d-label-muted" font-size="9">zone c</text>
  </g>
  <line id="k2-a-l" x1="182" y1="80" x2="266" y2="140" class="d-msg d-request" data-depends-on="n12" marker-end="url(#arrowK2)"></line>
  <line id="k2-l-a" x1="266" y1="156" x2="182" y2="98" class="d-msg d-response" data-depends-on="n12" marker-end="url(#arrowK2r)"></line>
  <line id="k2-b-l" x1="182" y1="256" x2="266" y2="206" class="d-msg d-request" data-depends-on="n12" marker-end="url(#arrowK2)"></line>
  <line id="k2-l-b" x1="266" y1="192" x2="182" y2="242" class="d-msg d-response" data-depends-on="n12" marker-end="url(#arrowK2r)"></line>
  <line id="k2-l-n2" x1="452" y1="130" x2="596" y2="36" class="d-msg d-request" data-depends-on="n12 n22" marker-end="url(#arrowK2)"></line>
  <line id="k2-n2-l" x1="596" y1="54" x2="452" y2="144" class="d-msg d-response" data-depends-on="n12 n22" marker-end="url(#arrowK2r)"></line>
  <line id="k2-l-n3" x1="452" y1="158" x2="596" y2="116" class="d-msg d-request" data-depends-on="n12 n32" marker-end="url(#arrowK2)"></line>
  <line id="k2-n3-l" x1="596" y1="134" x2="452" y2="170" class="d-msg d-response" data-depends-on="n12 n32" marker-end="url(#arrowK2r)"></line>
  <line id="k2-l-n4" x1="452" y1="182" x2="596" y2="196" class="d-msg d-request" data-depends-on="n12 n42" marker-end="url(#arrowK2)"></line>
  <line id="k2-n4-l" x1="596" y1="214" x2="452" y2="194" class="d-msg d-response" data-depends-on="n12 n42" marker-end="url(#arrowK2r)"></line>
  <line id="k2-l-n5" x1="452" y1="204" x2="596" y2="276" class="d-msg d-request" data-depends-on="n12 n52" marker-end="url(#arrowK2)"></line>
  <line id="k2-n5-l" x1="596" y1="294" x2="452" y2="216" class="d-msg d-response" data-depends-on="n12 n52" marker-end="url(#arrowK2r)"></line>
  <line id="k2-n4-n3" x1="640" y1="178" x2="640" y2="154" class="d-msg d-request" data-depends-on="n42 n32" marker-end="url(#arrowK2)"></line>
  <line id="k2-n3-n4" x1="680" y1="152" x2="680" y2="176" class="d-msg d-response" data-depends-on="n42 n32" marker-end="url(#arrowK2r)"></line>
  <line id="k2-n4-n5" x1="640" y1="232" x2="640" y2="256" class="d-msg d-request" data-depends-on="n42 n52" marker-end="url(#arrowK2)"></line>
  <line id="k2-n5-n4" x1="680" y1="258" x2="680" y2="234" class="d-msg d-response" data-depends-on="n42 n52" marker-end="url(#arrowK2r)"></line>
  <line id="k2-b-n4" x1="182" y1="272" x2="596" y2="216" class="d-msg d-request" data-depends-on="n42" marker-end="url(#arrowK2)"></line>
  <line id="k2-n4-b" x1="596" y1="228" x2="182" y2="288" class="d-msg d-response" data-depends-on="n42" marker-end="url(#arrowK2r)"></line>
  <text x="410" y="332" text-anchor="middle" class="d-label-muted" font-size="10">play a committed lock, then answering too early, then zone a cut off</text>
  <defs>
    <marker id="arrowK2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowK2r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "cl", "title": "Cluster", "rows": [["leader", "—"], ["billing-run", "—"]]},
{"id": "en", "title": "A's request (entry 9,124)", "rows": [["stored on", "—"], ["committed", "—"]]}
],
"flows": [
{
"id": "commit",
"label": "A lock committed by a majority",
"nodes": ["n12", "n22", "n32", "n42", "n52"],
"steps": [
{"el": "k2-a-l", "payload": "acquire billing-run", "set": {"cl.leader": "node 1 · term 7", "cl.billing-run": "free", "en.stored on": "—", "en.committed": "—"}, "text": "Five lock nodes: two in zone a, two in zone b, one in zone c. Node 1 is the leader, and every change goes through it. Worker A asks it for billing-run."},
{"el": "k2-l-n2", "payload": "append #9,124: billing-run → A", "set": {"en.stored on": "node 1"}, "text": "The leader doesn't change the lock table yet. It appends the request to its log as entry 9,124, flushes it to disk, and sends it to the other four nodes."},
{"el": "k2-l-n3", "payload": "append #9,124", "text": "Each follower appends the entry to its own log, flushes it, and replies."},
{"el": "k2-n2-l", "payload": "stored", "ms": 1, "set": {"en.stored on": "nodes 1, 2"}, "text": "Node 2, in the same zone, answers first."},
{"el": "k2-n3-l", "payload": "stored", "ms": 3, "set": {"en.stored on": "nodes 1, 2, 3 — a majority", "en.committed": "yes"}, "text": "Node 3 answers from zone b. Three copies of five is a majority, so the entry is committed. Whatever fails from now on, every future leader is guaranteed to have it (Deep Dives)."},
{"el": "k2-l-n4", "payload": "append #9,124", "text": "Nodes 4 and 5 get the same entry and store it a moment later. The leader doesn't wait for them."},
{"el": "k2-l-a", "payload": "granted · token 9,124", "ms": 1, "set": {"cl.billing-run": "A · token 9,124"}, "text": "Only now does the leader apply the entry to its lock table and answer A: about 5ms in all, nearly all of it the disk flush and the round trip to zone b. The entry's index, 9,124, is A's token for this lock. Stage 3 puts it to work."}
]
},
{
"id": "early",
"label": "If the leader answered before copying",
"nodes": ["n12", "n22", "n32", "n42", "n52"],
"steps": [
{"el": "k2-a-l", "payload": "acquire billing-run", "set": {"cl.leader": "node 1 · term 7", "cl.billing-run": "free", "en.stored on": "—", "en.committed": "—"}, "text": "Suppose the leader answered first and copied afterwards, the way many databases replicate to their replicas. It saves a round trip to another zone."},
{"el": "k2-l-a", "payload": "granted", "ms": 1, "set": {"cl.billing-run": "A (on node 1 only)", "en.stored on": "node 1", "en.committed": "no — but A was told yes"}, "text": "A is told it holds the lock. The entry exists only on node 1."},
{"el": "k2-l-n2", "payload": "(node 1 loses power before sending)", "text": "Node 1's machine loses power before the entry has left it."},
{"el": "k2-n4-n3", "payload": "vote for me · term 8", "ms": 1000, "text": "The followers stop hearing heartbeats. After about a second, node 4 asks the others to make it leader for term 8."},
{"el": "k2-n3-n4", "payload": "yes", "ms": 1, "text": "Node 3 votes yes."},
{"el": "k2-n5-n4", "payload": "yes", "ms": 1, "set": {"cl.leader": "node 4 · term 8"}, "text": "So does node 5. Three votes of five make node 4 the leader. None of these nodes has ever seen A's lock."},
{"el": "k2-b-n4", "payload": "acquire billing-run", "text": "Worker B, which has been asking every second, now reaches the new leader."},
{"el": "k2-n4-b", "payload": "granted", "ms": 5, "set": {"cl.billing-run": "B — and A believes it holds it too"}, "text": "billing-run is free in node 4's lock table, so B gets it. Two holders: Stage 1's failure again. A lock must never be acknowledged until a majority has stored it. Any majority that elects the next leader then includes at least one node with the entry, and that node won't vote for a candidate without it."}
]
},
{
"id": "partition",
"label": "Zone a cut off",
"nodes": ["n12", "n22", "n32", "n42", "n52"],
"steps": [
{"el": "k2-a-l", "payload": "acquire billing-run", "set": {"cl.leader": "node 1 · term 7", "cl.billing-run": "free", "en.stored on": "—", "en.committed": "—"}, "text": "A network fault cuts zone a off from zones b and c. Node 1 (the leader), node 2 and Worker A can still reach each other. Nodes 3, 4 and 5 can reach each other and Worker B. A asks node 1 for billing-run."},
{"el": "k2-l-n2", "payload": "append #9,124: billing-run → A", "set": {"en.stored on": "node 1"}, "text": "Node 1 appends the request and sends it out."},
{"el": "k2-n2-l", "payload": "stored", "ms": 1, "set": {"en.stored on": "nodes 1, 2"}, "text": "Node 2 stores it."},
{"el": "k2-l-n3", "payload": "append #9,124 (unreachable)", "ms": 2000, "set": {"en.committed": "no — 2 of 5"}, "text": "Nodes 3, 4 and 5 never receive it. Two copies aren't a majority, so the entry isn't committed, and A gets no answer. After two seconds without hearing from a majority, node 1 stops acting as leader."},
{"el": "k2-n4-n3", "payload": "vote for me · term 8", "text": "On the other side, nodes 3, 4 and 5 have stopped hearing node 1's heartbeats. Node 4 stands for election."},
{"el": "k2-n5-n4", "payload": "yes", "ms": 1000, "set": {"cl.leader": "node 4 · term 8 (zones b and c)"}, "text": "With votes from nodes 3 and 5 it has three of five. Two majorities of five always share at least one node, so only one side of any split can elect a leader."},
{"el": "k2-b-n4", "payload": "acquire billing-run", "text": "B asks node 4."},
{"el": "k2-n4-b", "payload": "granted · token 9,125", "ms": 5, "set": {"cl.billing-run": "B · token 9,125"}, "text": "Its request commits on nodes 3, 4 and 5, and B gets the lock."},
{"el": "k2-l-a", "payload": "503 · no majority", "set": {"en.committed": "never — replaced when the network heals"}, "text": "A's request fails. When the network heals, node 1 sees the higher term and becomes a follower, and its uncommitted entry is replaced by the new leader's. A asks again and finds B holding the lock. While the network was split, the smaller side refused every write. That is the price of never granting a lock twice. Placing two nodes in each of zones a and b and one in c means that losing any one zone still leaves a majority."}
]
}
]
}
</script>
<div class="diagram-caption">Five nodes in three zones. Every change is appended to the leader's log and committed once three of five nodes have stored it; only then is the client answered. If the leader goes quiet, the others elect a new one, which needs three votes.</div>
</div>

<div class="fail-hint">Click any node to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="n12">
<strong>If node 1, the leader, fails:</strong> the others notice its heartbeats have stopped and elect a new leader in 1 to 2 seconds. Every committed lock survives, because it is stored on at least three nodes and only a node holding every committed entry can win the vote. Requests during the election get <code>503</code> and are retried.
</div>
<div class="failure-impact is-hidden" data-component="n22">
<strong>If node 2 fails:</strong> clients notice nothing. Writes still reach a majority — node 1 plus two of nodes 3, 4 and 5. The cluster can now survive one more failure instead of two, so node 2 is replaced promptly.
</div>
<div class="failure-impact is-hidden" data-component="n32">
<strong>If node 3 fails:</strong> the same: writes commit on the remaining four. Commits may take slightly longer if the fastest zone-b copy was node 3's.
</div>
<div class="failure-impact is-hidden" data-component="n42">
<strong>If node 4 fails:</strong> writes commit on the remaining four. In the second and third flows node 4 is the one elected, so if it has failed, node 3 or node 5 stands instead.
</div>
<div class="failure-impact is-hidden" data-component="n52">
<strong>If node 5 fails:</strong> writes commit on the remaining four. Node 5 is alone in zone c so that losing all of zone a or all of zone b still leaves three nodes. While it is down, losing a whole zone would stop the service.
</div>
</div>

The lock table is now as safe as the majority of the machines holding it. But all of this protects the service's own record of who holds a lock. The holders still have a 30-second lease per lock, and each lock is extended separately. And a holder that stops for longer than its lease still believes it holds the lock.

<!-- stage:3:3. Sessions and Fencing -->

## Stage 3 — Sessions and Fencing Tokens

- **Clients have sessions.** A client opens one session with a 10-second TTL and sends a keepalive every 3 seconds. Locks belong to the session and have no expiry of their own.
- **Session deadlines live in the leader's memory.** Keepalives don't go through the log, because they don't change who holds anything. When a deadline passes, the leader writes one entry that ends the session, releasing every lock it held.
- **A new leader gives every session a full TTL.** It can't know when each session last checked in, so it gives each one 10 seconds from the moment it takes over.
- **Every grant carries a fencing token**: the log index of the entry that granted it.
- **The protected resource checks the token.** The billing DB keeps the highest token it has seen for billing-run and rejects any write with a lower one.
- **Clients stop themselves too.** A client that hasn't had a keepalive answered for 7 seconds assumes its locks are gone and stops working. That narrows the window in which a stale holder can do harm; only the token closes it.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 780 310" width="780" height="310" role="img" aria-label="Two billing workers hold sessions with the lock service and write invoices to a billing database that checks fencing tokens">
  <g data-fail-toggle="ls3">
    <rect x="300" y="20" width="200" height="74" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="400" y="45" text-anchor="middle" class="d-actor-label" font-size="12">Lock Service</text>
    <text x="400" y="62" text-anchor="middle" class="d-label-muted" font-size="9">5 nodes · one leader</text>
    <text x="400" y="77" text-anchor="middle" class="d-label-muted" font-size="9">sessions · locks · tokens</text>
  </g>
  <g data-fail-toggle="wa3">
    <rect x="30" y="120" width="170" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="115" y="146" text-anchor="middle" class="d-actor-label" font-size="12">Worker A</text>
    <text x="115" y="163" text-anchor="middle" class="d-label-muted" font-size="9">session 17</text>
  </g>
  <g data-fail-toggle="wb3">
    <rect x="30" y="220" width="170" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="115" y="246" text-anchor="middle" class="d-actor-label" font-size="12">Worker B</text>
    <text x="115" y="263" text-anchor="middle" class="d-label-muted" font-size="9">session 23</text>
  </g>
  <g data-fail-toggle="bd3">
    <rect x="590" y="160" width="170" height="70" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="675" y="186" text-anchor="middle" class="d-actor-label" font-size="12">Billing DB</text>
    <text x="675" y="203" text-anchor="middle" class="d-label-muted" font-size="9">invoices</text>
    <text x="675" y="217" text-anchor="middle" class="d-label-muted" font-size="9">fence: highest token</text>
  </g>
  <line id="k3-a-ls" x1="170" y1="118" x2="318" y2="97" class="d-msg d-request" data-depends-on="wa3 ls3" marker-end="url(#arrowK3)"></line>
  <line id="k3-ls-a" x1="345" y1="97" x2="203" y2="128" class="d-msg d-response" data-depends-on="wa3 ls3" marker-end="url(#arrowK3r)"></line>
  <line id="k3-b-ls" x1="202" y1="230" x2="395" y2="98" class="d-msg d-request" data-depends-on="wb3 ls3" marker-end="url(#arrowK3)"></line>
  <line id="k3-ls-b" x1="420" y1="98" x2="203" y2="248" class="d-msg d-response" data-depends-on="wb3 ls3" marker-end="url(#arrowK3r)"></line>
  <line id="k3-a-db" x1="202" y1="145" x2="586" y2="180" class="d-msg d-request" data-depends-on="wa3 bd3" marker-end="url(#arrowK3)"></line>
  <line id="k3-db-a" x1="586" y1="196" x2="203" y2="162" class="d-msg d-response" data-depends-on="wa3 bd3" marker-end="url(#arrowK3r)"></line>
  <line id="k3-b-db" x1="202" y1="262" x2="586" y2="212" class="d-msg d-request" data-depends-on="wb3 bd3" marker-end="url(#arrowK3)"></line>
  <line id="k3-db-b" x1="586" y1="224" x2="203" y2="276" class="d-msg d-response" data-depends-on="wb3 bd3" marker-end="url(#arrowK3r)"></line>
  <text x="390" y="302" text-anchor="middle" class="d-label-muted" font-size="10">play the long pause, then the crash, then the lock service changing leader</text>
  <defs>
    <marker id="arrowK3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowK3r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "svc", "title": "Lock service", "rows": [["session 17 (A)", "—"], ["billing-run", "—"]]},
{"id": "db", "title": "Billing DB", "rows": [["highest token seen", "—"], ["last write", "—"]]}
],
"flows": [
{
"id": "pause",
"label": "A worker pauses past its session",
"nodes": ["ls3", "wa3", "wb3", "bd3"],
"steps": [
{"el": "k3-a-ls", "payload": "acquire billing-run · session 17", "set": {"svc.session 17 (A)": "alive", "svc.billing-run": "free", "db.highest token seen": "8,870 (last night)", "db.last write": "—"}, "text": "Worker A has session 17 open, with a 10-second TTL, and asks for billing-run."},
{"el": "k3-ls-a", "payload": "granted · token 9,124", "ms": 5, "set": {"svc.billing-run": "A · token 9,124"}, "text": "It's granted, with token 9,124."},
{"el": "k3-a-db", "payload": "write invoices · token 9,124", "text": "A's writes to the billing DB carry the token."},
{"el": "k3-db-a", "payload": "ok", "ms": 4, "set": {"db.highest token seen": "9,124", "db.last write": "A · token 9,124"}, "text": "In the same transaction as each write, the database checks the token against the highest it has seen for billing-run. 9,124 is higher than last night's 8,870, so the write goes ahead and 9,124 becomes the highest."},
{"el": "k3-a-ls", "payload": "(A stops: 15-second pause)", "text": "Then A's process stops completely for 15 seconds: a long garbage-collection pause, or the virtual machine being suspended. No keepalives, no writes — and nothing inside A notices."},
{"el": "k3-b-ls", "payload": "acquire billing-run · session 23", "text": "B has been asking for the lock."},
{"el": "k3-ls-b", "payload": "granted · token 9,311", "ms": 10000, "set": {"svc.session 17 (A)": "expired", "svc.billing-run": "B · token 9,311"}, "text": "Ten seconds after A's last keepalive, the leader writes an entry ending session 17, which releases billing-run. B's next request is granted, with token 9,311."},
{"el": "k3-b-db", "payload": "write invoices · token 9,311", "text": "B takes over the run. Its writes carry 9,311."},
{"el": "k3-db-b", "payload": "ok", "ms": 4, "set": {"db.highest token seen": "9,311", "db.last write": "B · token 9,311"}, "text": "9,311 is now the highest token the database has seen."},
{"el": "k3-a-db", "payload": "write invoice #88,412 · token 9,124", "text": "A's pause ends. From inside A, nothing has happened: the next line of code runs and writes the next invoice, carrying A's token."},
{"el": "k3-db-a", "payload": "rejected · 9,124 < 9,311", "ms": 3, "set": {"db.last write": "A's write refused"}, "text": "The database refuses it. A higher token has been seen, so this lock was granted again after A's grant. A gets an error, finds its session gone, and stops. No lease is long enough to prevent this, because a pause can always last longer than the lease. The resource being protected has to be the one that says no."}
]
},
{
"id": "crash",
"label": "A worker crashes holding three locks",
"nodes": ["ls3", "wa3", "wb3"],
"steps": [
{"el": "k3-a-ls", "payload": "keepalive · session 17", "set": {"svc.session 17 (A)": "alive · holds 3 locks", "svc.billing-run": "A · token 9,124", "db.highest token seen": "—", "db.last write": "—"}, "text": "A holds three locks: billing-run, and one for each of two accounts it's reconciling. One session covers all three, so it sends one keepalive every 3 seconds, not three."},
{"el": "k3-ls-a", "payload": "ok · 10s", "ms": 1, "text": "Each keepalive resets the session's deadline to 10 seconds from now, on the leader's own clock."},
{"el": "k3-a-ls", "payload": "(A's machine dies)", "text": "A's machine dies."},
{"el": "k3-b-ls", "payload": "acquire billing-run", "text": "B is asking for billing-run."},
{"el": "k3-ls-b", "payload": "granted · token 9,311", "ms": 10000, "set": {"svc.session 17 (A)": "expired · 3 locks released", "svc.billing-run": "B · token 9,311"}, "text": "Within 10 seconds of A's last keepalive, the leader writes a single entry ending session 17. It releases all three locks at once, and B's next request is granted. A shorter TTL frees locks sooner, but also ends the sessions of clients that are only slow or briefly cut off. 10 seconds balances the two."}
]
},
{
"id": "failover",
"label": "The lock service changes leader",
"nodes": ["ls3", "wa3", "bd3"],
"steps": [
{"el": "k3-a-ls", "payload": "keepalive (02:01:00)", "set": {"svc.session 17 (A)": "alive · deadline 02:01:10", "svc.billing-run": "A · token 9,124", "db.highest token seen": "9,124", "db.last write": "A · token 9,124"}, "text": "A holds billing-run and sends a keepalive at 02:01:00."},
{"el": "k3-ls-a", "payload": "ok · 10s", "ms": 1, "text": "The leader sets session 17's deadline to 02:01:10, in its memory. Keepalives aren't log entries: there are tens of thousands a second, and none of them changes who holds anything."},
{"el": "k3-a-ls", "payload": "keepalive (02:01:03)", "text": "The leader's machine fails at 02:01:01. A's next keepalive gets no answer."},
{"el": "k3-ls-a", "payload": "new leader · ok · 10s", "ms": 2000, "set": {"svc.session 17 (A)": "alive · full TTL from the new leader"}, "text": "Two seconds later another node has been elected. It has every session and lock from the log, but not their deadlines, which were only in the old leader's memory. So it gives every session a full 10 seconds from the moment it took over. A's retried keepalive reaches it, and nothing is lost. The cost: a client that died just before the failover keeps its locks a few seconds longer than usual."},
{"el": "k3-a-db", "payload": "carry on · token 9,124", "text": "A also runs its own countdown, from the moment it sent its last answered keepalive. Had 7 seconds passed without an answer, it would have stopped working, assuming its locks were gone. It counts from the send, not the reply, so it always gives up before the service could have expired it. The failover took 2 seconds, so A carries on."}
]
}
]
}
</script>
<div class="diagram-caption">A client's locks belong to its session, kept alive by one keepalive every 3 seconds. Every grant carries a token, the index of the log entry that granted it, and the billing DB rejects any write whose token is lower than one it has already seen.</div>
</div>

<div class="fail-hint">Click the lock service, either worker or the billing DB to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="ls3">
<strong>If the lock service is unavailable:</strong> no lock can be taken or released, and keepalives go unanswered. Holders stop working after 7 seconds, by their own countdown. The service is only unavailable when 3 of its 5 nodes are lost; a single failure costs a 1–2 second election.
</div>
<div class="failure-impact is-hidden" data-component="wa3">
<strong>If worker A fails:</strong> its session expires within 10 seconds, and every lock it held is released in one entry. Replay the second flow.
</div>
<div class="failure-impact is-hidden" data-component="wb3">
<strong>If worker B fails:</strong> it held nothing, so its session simply expires.
</div>
<div class="failure-impact is-hidden" data-component="bd3">
<strong>If the billing DB fails:</strong> no one can do the work, whoever holds the lock. The highest token is stored in the database itself, so it survives with the data it protects.
</div>
</div>

Holders are now accounted for: a dead one is noticed within 10 seconds, and a paused one can't do damage when it wakes. Waiters are not. Every client that wants a lock keeps asking for it, and when a busy lock is released, every one of them asks at once.

<!-- stage:4:4. Queues and Elections -->

## Stage 4 — Waiting in Line, and Electing Leaders

- **Waiting happens on the server.** An acquire can wait. The leader commits an entry adding the session to the lock's queue, and holds the request open.
- **A release hands the lock over.** The entry that releases a lock also grants it to the first session in its queue, and the leader answers that one waiting request. No other waiter hears anything.
- **The queue removes waiters that can't use the lock.** A waiter whose session ends, or whose wait runs out, is removed by an entry of its own.
- **Leader election is a lock with a value.** Campaigning for a role means waiting for the lock named after it, offering an address. The holder is the leader, and its token serves as its term.
- **Watches.** Anyone can watch a lock or role and receive every change to it, in log order, each marked with its index.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 820 340" width="820" height="340" role="img" aria-label="Workers A, B and C wait for locks and campaign for leadership through the lock service; a request router watches the elected leader and sends work to it">
  <g data-fail-toggle="wa4">
    <rect x="20" y="30" width="160" height="56" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="100" y="55" text-anchor="middle" class="d-actor-label" font-size="12">Worker A</text>
    <text x="100" y="71" text-anchor="middle" class="d-label-muted" font-size="9">10.0.3.7</text>
  </g>
  <g data-fail-toggle="wb4">
    <rect x="20" y="140" width="160" height="56" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="100" y="165" text-anchor="middle" class="d-actor-label" font-size="12">Worker B</text>
    <text x="100" y="181" text-anchor="middle" class="d-label-muted" font-size="9">10.0.3.8</text>
  </g>
  <g data-fail-toggle="wc4">
    <rect x="20" y="250" width="160" height="56" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="100" y="275" text-anchor="middle" class="d-actor-label" font-size="12">Worker C</text>
    <text x="100" y="291" text-anchor="middle" class="d-label-muted" font-size="9">10.0.3.9</text>
  </g>
  <g data-fail-toggle="ls4">
    <rect x="320" y="120" width="200" height="100" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="420" y="148" text-anchor="middle" class="d-actor-label" font-size="12">Lock Service</text>
    <text x="420" y="166" text-anchor="middle" class="d-label-muted" font-size="9">5 nodes · one leader</text>
    <text x="420" y="181" text-anchor="middle" class="d-label-muted" font-size="9">holder + queue per lock</text>
    <text x="420" y="196" text-anchor="middle" class="d-label-muted" font-size="9">watches</text>
  </g>
  <g data-fail-toggle="rt4">
    <rect x="640" y="140" width="160" height="60" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="720" y="166" text-anchor="middle" class="d-actor-label" font-size="12">Request Router</text>
    <text x="720" y="183" text-anchor="middle" class="d-label-muted" font-size="9">watches billing-leader</text>
  </g>
  <line id="k4-a-ls" x1="182" y1="62" x2="316" y2="140" class="d-msg d-request" data-depends-on="wa4 ls4" marker-end="url(#arrowK4)"></line>
  <line id="k4-ls-a" x1="316" y1="154" x2="182" y2="78" class="d-msg d-response" data-depends-on="wa4 ls4" marker-end="url(#arrowK4r)"></line>
  <line id="k4-b-ls" x1="182" y1="160" x2="316" y2="166" class="d-msg d-request" data-depends-on="wb4 ls4" marker-end="url(#arrowK4)"></line>
  <line id="k4-ls-b" x1="316" y1="180" x2="182" y2="176" class="d-msg d-response" data-depends-on="wb4 ls4" marker-end="url(#arrowK4r)"></line>
  <line id="k4-c-ls" x1="182" y1="270" x2="316" y2="208" class="d-msg d-request" data-depends-on="wc4 ls4" marker-end="url(#arrowK4)"></line>
  <line id="k4-ls-c" x1="316" y1="194" x2="182" y2="256" class="d-msg d-response" data-depends-on="wc4 ls4" marker-end="url(#arrowK4r)"></line>
  <line id="k4-rt-ls" x1="636" y1="184" x2="524" y2="184" class="d-msg d-request" data-depends-on="rt4 ls4" marker-end="url(#arrowK4)"></line>
  <line id="k4-ls-rt" x1="524" y1="158" x2="636" y2="158" class="d-msg d-response" data-depends-on="rt4 ls4" marker-end="url(#arrowK4r)"></line>
  <line id="k4-rt-a" x1="660" y1="138" x2="184" y2="46" class="d-msg d-request" data-depends-on="rt4 wa4" marker-end="url(#arrowK4)"></line>
  <line id="k4-rt-c" x1="700" y1="202" x2="184" y2="284" class="d-msg d-request" data-depends-on="rt4 wc4" marker-end="url(#arrowK4)"></line>
  <text x="410" y="332" text-anchor="middle" class="d-label-muted" font-size="10">play the crowd asking, then the queue, then an election</text>
  <defs>
    <marker id="arrowK4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowK4r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "q", "title": "account-77", "rows": [["holder", "—"], ["waiting", "—"]]},
{"id": "el", "title": "billing-leader", "rows": [["leader", "—"], ["router sends to", "—"]]}
],
"flows": [
{
"id": "herd",
"label": "Two hundred workers asking",
"nodes": ["wa4", "wb4", "wc4", "ls4"],
"steps": [
{"el": "k4-b-ls", "payload": "acquire account-77?", "set": {"q.holder": "A", "q.waiting": "—", "el.leader": "—", "el.router sends to": "—"}, "text": "A large merchant's account, account-77, has 200 settlement jobs to apply, one per worker. Each needs the account's lock to update its balance, and A holds it."},
{"el": "k4-ls-b", "payload": "held", "ms": 1, "text": "Without waiting on the server, the others ask, hear that the lock is held, and ask again 100ms later."},
{"el": "k4-c-ls", "payload": "acquire account-77?", "set": {"q.waiting": "none recorded · 199 workers asking"}, "text": "199 workers asking ten times a second is 2,000 requests a second for one lock. Every one reaches the leader and gets the same answer."},
{"el": "k4-a-ls", "payload": "release account-77", "set": {"q.holder": "free"}, "text": "A finishes and releases the lock."},
{"el": "k4-b-ls", "payload": "acquire!", "text": "Within 100ms, all 199 ask at once."},
{"el": "k4-ls-c", "payload": "granted", "ms": 5, "set": {"q.holder": "C"}, "text": "One wins: whichever request reached the leader first."},
{"el": "k4-ls-b", "payload": "held", "ms": 1, "set": {"q.waiting": "198 asking · B has lost 31 times"}, "text": "The other 198 are told the lock is held and go back to asking. Nothing records who has waited longest. B, a little further away on the network, has now lost 31 times in a row to workers that started asking after it. Every release sets off another burst of 199 requests, and the winner is decided by chance."}
]
},
{
"id": "queue",
"label": "Handing the lock to the next in line",
"nodes": ["wa4", "wb4", "wc4", "ls4"],
"steps": [
{"el": "k4-b-ls", "payload": "acquire account-77 · wait up to 60s", "set": {"q.holder": "A", "q.waiting": "B", "el.leader": "—", "el.router sends to": "—"}, "text": "This time B asks to wait. The leader commits an entry adding B's session to account-77's queue, and keeps B's request open."},
{"el": "k4-c-ls", "payload": "acquire account-77 · wait up to 60s", "set": {"q.waiting": "B, C, then 197 more"}, "text": "C and the rest queue behind B, in the order their entries were committed. Nobody asks twice."},
{"el": "k4-a-ls", "payload": "release · token 9,124", "text": "A finishes and releases."},
{"el": "k4-ls-b", "payload": "granted · token 9,402", "ms": 5, "set": {"q.holder": "B · token 9,402", "q.waiting": "C, then 197 more"}, "text": "The entry that releases the lock also grants it to the head of the queue. The leader answers B's open request, so B learns it holds the lock as A lets go. Nobody else hears anything."},
{"el": "k4-b-ls", "payload": "release · token 9,402", "text": "When B is done, it releases."},
{"el": "k4-ls-c", "payload": "granted · token 9,407", "ms": 5, "set": {"q.holder": "C · token 9,407", "q.waiting": "197 more"}, "text": "C is next. The leader now writes one entry for each worker joining the queue and one for each handover: about 400 entries for the 200 jobs, instead of 2,000 requests a second. Order is first come, first served. A queued worker that crashes leaves the queue when its session expires, and one whose wait runs out leaves when it does, so the head of the queue is always a worker that is still waiting."}
]
},
{
"id": "election",
"label": "Electing a leader, and telling everyone",
"nodes": ["wa4", "wb4", "wc4", "ls4", "rt4"],
"steps": [
{"el": "k4-a-ls", "payload": "campaign billing-leader · 10.0.3.7", "set": {"q.holder": "—", "q.waiting": "—", "el.leader": "—", "el.router sends to": "—"}, "text": "The billing service runs three copies, and exactly one must be the leader that accepts payment batches. Each campaigns for billing-leader, offering its own address. A's campaign is committed first."},
{"el": "k4-ls-a", "payload": "you lead · token 9,500", "ms": 5, "set": {"el.leader": "A · 10.0.3.7 · token 9,500"}, "text": "A holds the lock, so A is the leader. Its token serves as its term: everything A writes to the billing DB carries 9,500."},
{"el": "k4-c-ls", "payload": "campaign · 10.0.3.9", "text": "C campaigns next, then B. They queue behind A in that order, so the next leaders are already decided."},
{"el": "k4-rt-ls", "payload": "watch billing-leader", "text": "The request router sends payment batches to whichever copy leads. Instead of asking every second, it watches billing-leader."},
{"el": "k4-ls-rt", "payload": "now: A · 10.0.3.7 · index 9,500", "ms": 1, "set": {"el.router sends to": "A"}, "text": "A watch begins with the current value, then streams every change."},
{"el": "k4-rt-a", "payload": "payment batch", "text": "Batches go to A."},
{"el": "k4-ls-c", "payload": "A's session expired · you lead · token 9,733", "ms": 10000, "set": {"el.leader": "C · 10.0.3.9 · token 9,733"}, "text": "A crashes. Ten seconds later its session expires, and one entry releases billing-leader and grants it to C, the next in line. C learns it is the leader from the campaign request it has had open."},
{"el": "k4-ls-rt", "payload": "change at 9,733: C · 10.0.3.9", "ms": 1, "set": {"el.router sends to": "C"}, "text": "The same entry changes billing-leader, so the router's watch receives it straight away."},
{"el": "k4-rt-c", "payload": "payment batch", "text": "Batches now go to C. Had the router's connection dropped, it would reconnect asking for changes after index 9,500, and still receive this one. The gap with no leader was about 10 seconds, the session TTL: a role is only as quick to recover as its holder's session is to expire."}
]
}
]
}
</script>
<div class="diagram-caption">Waiting happens on the server: each lock has a queue, and a release grants the lock to the head of the queue in the same entry. Leader election is a lock carrying the leader's address, and anyone who needs to know the leader watches it.</div>
</div>

<div class="fail-hint">Click any worker, the lock service or the request router to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="wa4">
<strong>If worker A fails while holding a lock or a role:</strong> its session expires within 10 seconds, and the same entry that releases it grants it to the head of the queue. Replay the third flow.
</div>
<div class="failure-impact is-hidden" data-component="wb4">
<strong>If worker B fails while queued:</strong> when its session expires it leaves every queue it was in, and the workers behind it move up. A dead worker is never handed a lock.
</div>
<div class="failure-impact is-hidden" data-component="wc4">
<strong>If worker C fails while next in line:</strong> it leaves the queue when its session expires. If A fails after that, the role passes to B instead.
</div>
<div class="failure-impact is-hidden" data-component="ls4">
<strong>If the lock service is unavailable:</strong> nothing is granted or handed over, and open waits and watches are cut. Clients reconnect, re-sending their waits — which find their place in the queue unchanged, since it was committed — and resuming their watches from the last index they saw.
</div>
<div class="failure-impact is-hidden" data-component="rt4">
<strong>If the request router fails:</strong> the election is unaffected. A replacement router starts a watch and gets the current leader as its first event.
</div>
</div>

The service now behaves correctly for every client. But one node, the leader, does nearly all the work: it answers 33,000 keepalives a second, serves every read, and streams 200,000 watches, besides committing every write. Writes have to go through the leader. Most of the rest doesn't.

<!-- stage:5:5. Spreading the Load -->

## Stage 5 — Spreading the Load Off the Leader

- **Clients connect to any node.** Each client keeps one connection to a node in its own zone, and moves to another node if that one fails.
- **Followers forward writes** to the leader, the only node that can add to the log.
- **Followers collect keepalives.** Every 500ms each follower sends the leader one message listing the sessions it has heard from. It answers each client once the leader has acknowledged that message.
- **Followers serve watches** from their own copy of the log, sending each event as they apply the entry.
- **Followers serve reads, after checking with the leader.** A follower's copy may be a few milliseconds behind. Before answering, it asks the leader for the latest commit index and waits until it has applied that far.
- **The leader batches writes.** Requests that arrive while one disk flush is in progress go into the next append, with one flush and one message to each follower.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 820 330" width="820" height="330" role="img" aria-label="Clients connect to follower nodes 2 and 3, which forward writes and batched keepalives to node 1, the leader, and serve reads and watches themselves">
  <rect x="20" y="125" width="160" height="80" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="100" y="152" text-anchor="middle" class="d-actor-label" font-size="12">Clients</text>
  <text x="100" y="170" text-anchor="middle" class="d-label-muted" font-size="9">100,000 sessions</text>
  <text x="100" y="185" text-anchor="middle" class="d-label-muted" font-size="9">one connection each</text>
  <g data-fail-toggle="f25">
    <rect x="290" y="30" width="180" height="70" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="380" y="55" text-anchor="middle" class="d-actor-label" font-size="12">Node 2 · follower</text>
    <text x="380" y="72" text-anchor="middle" class="d-label-muted" font-size="9">zone a</text>
    <text x="380" y="86" text-anchor="middle" class="d-label-muted" font-size="9">reads · watches · keepalives</text>
  </g>
  <g data-fail-toggle="f35">
    <rect x="290" y="230" width="180" height="70" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="380" y="255" text-anchor="middle" class="d-actor-label" font-size="12">Node 3 · follower</text>
    <text x="380" y="272" text-anchor="middle" class="d-label-muted" font-size="9">zone b</text>
    <text x="380" y="286" text-anchor="middle" class="d-label-muted" font-size="9">reads · watches · keepalives</text>
  </g>
  <g data-fail-toggle="l5">
    <rect x="610" y="120" width="190" height="90" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="705" y="146" text-anchor="middle" class="d-actor-label" font-size="12">Node 1 · leader</text>
    <text x="705" y="164" text-anchor="middle" class="d-label-muted" font-size="9">every write · batched</text>
    <text x="705" y="179" text-anchor="middle" class="d-label-muted" font-size="9">session deadlines in memory</text>
    <text x="705" y="194" text-anchor="middle" class="d-label-muted" font-size="9">(nodes 4, 5 not shown)</text>
  </g>
  <line id="k5-c-f2" x1="182" y1="135" x2="286" y2="80" class="d-msg d-request" data-depends-on="f25" marker-end="url(#arrowK5)"></line>
  <line id="k5-f2-c" x1="286" y1="94" x2="182" y2="150" class="d-msg d-response" data-depends-on="f25" marker-end="url(#arrowK5r)"></line>
  <line id="k5-c-f3" x1="182" y1="190" x2="286" y2="250" class="d-msg d-request" data-depends-on="f35" marker-end="url(#arrowK5)"></line>
  <line id="k5-f3-c" x1="286" y1="264" x2="182" y2="202" class="d-msg d-response" data-depends-on="f35" marker-end="url(#arrowK5r)"></line>
  <line id="k5-f2-l" x1="472" y1="65" x2="606" y2="140" class="d-msg d-request" data-depends-on="f25 l5" marker-end="url(#arrowK5)"></line>
  <line id="k5-l-f2" x1="606" y1="155" x2="472" y2="85" class="d-msg d-response" data-depends-on="f25 l5" marker-end="url(#arrowK5r)"></line>
  <line id="k5-f3-l" x1="472" y1="265" x2="606" y2="198" class="d-msg d-request" data-depends-on="f35 l5" marker-end="url(#arrowK5)"></line>
  <line id="k5-l-f3" x1="606" y1="184" x2="472" y2="248" class="d-msg d-response" data-depends-on="f35 l5" marker-end="url(#arrowK5r)"></line>
  <text x="410" y="322" text-anchor="middle" class="d-label-muted" font-size="10">play the keepalives, then a read from a follower, then a burst of acquires</text>
  <defs>
    <marker id="arrowK5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowK5r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "ld", "title": "Leader", "rows": [["log writes", "—"], ["disk flushes", "—"], ["session deadlines", "—"]]},
{"id": "f3", "title": "Node 3", "rows": [["applied up to", "—"], ["answer", "—"]]}
],
"flows": [
{
"id": "keepalive",
"label": "33,000 keepalives a second",
"nodes": ["f25", "f35", "l5"],
"steps": [
{"el": "k5-c-f2", "payload": "keepalive · session 17", "altEl": "k5-c-f3", "altText": "Node 2 is down, so session 17's client has reconnected to node 3, in another zone, and sends its keepalive there.", "set": {"ld.log writes": "~10,000 a second", "ld.disk flushes": "~1,000 a second", "ld.session deadlines": "100,000, in memory", "f3.applied up to": "—", "f3.answer": "—"}, "text": "Session 17's client sends its keepalive to node 2, the node in its own zone that it is connected to."},
{"el": "k5-f2-l", "payload": "keepalives for 16,500 sessions", "altEl": "k5-f3-l", "text": "Node 2 doesn't pass each keepalive on separately. Every 500ms it sends the leader one message listing every session it has heard from since the last one: about 16,500."},
{"el": "k5-l-f2", "payload": "extended", "ms": 1, "altEl": "k5-l-f3", "set": {"ld.session deadlines": "16,500 extended"}, "text": "The leader extends those sessions' deadlines in its memory. No log entry, no disk flush. If every keepalive were a log entry, keepalives alone would be 33,000 writes a second, more than three times the real work. Only an expiry is written to the log."},
{"el": "k5-f2-c", "payload": "ok · 10s", "ms": 250, "altEl": "k5-f3-c", "text": "Node 2 answers its clients once the leader has acknowledged the batch, so an answered keepalive is always one the leader has seen. The answer can take up to half a second, which the client's 7-second countdown easily absorbs. Fail node 2 and replay: the client's keepalive takes the same path through node 3."}
]
},
{
"id": "read",
"label": "Reading from a follower that's behind",
"nodes": ["f35", "l5"],
"steps": [
{"el": "k5-c-f3", "payload": "who leads billing-leader?", "set": {"ld.log writes": "—", "ld.disk flushes": "—", "ld.session deadlines": "—", "f3.applied up to": "9,731", "f3.answer": "—"}, "text": "A client connected to node 3 asks who leads billing-leader. Node 3 has applied the log up to entry 9,731. The leader committed entry 9,733 — C taking over from A — a few milliseconds ago, and it hasn't reached node 3 yet."},
{"el": "k5-f3-l", "payload": "latest commit index?", "text": "Answering from its own copy, node 3 would say A, which is already wrong. So before answering, it asks the leader how far the log has been committed."},
{"el": "k5-l-f3", "payload": "9,733", "ms": 2, "text": "The leader first confirms it is still the leader, through a round of heartbeats to a majority, which it is sending anyway. Then it replies: 9,733. Without that check, an old leader that had been cut off and replaced could reply with an out-of-date index."},
{"el": "k5-f3-c", "payload": "C · 10.0.3.9 (as of 9,733)", "ms": 1, "set": {"f3.applied up to": "9,733", "f3.answer": "C"}, "text": "Node 3 waits until it has applied entry 9,733, a millisecond or two, and answers from its own tables: C. The leader handled one small message instead of the read, and the answer is as current as if the leader had given it. Reads that can tolerate being slightly stale, such as an operator's dashboard, skip the check. Watches never need it: a follower sends each event as it applies the entry, in log order."}
]
},
{
"id": "burst",
"label": "3,000 acquires in 50 milliseconds",
"nodes": ["f25", "f35", "l5"],
"steps": [
{"el": "k5-c-f2", "payload": "1,500 acquires", "set": {"ld.log writes": "3,000 in 50ms", "ld.disk flushes": "—", "ld.session deadlines": "—", "f3.applied up to": "—", "f3.answer": "—"}, "text": "On the hour, 3,000 scheduled jobs start at once and each takes a lock, through whichever node it is connected to."},
{"el": "k5-f2-l", "payload": "1,500 acquires, forwarded", "text": "Followers forward writes to the leader."},
{"el": "k5-f3-l", "payload": "1,500 acquires, forwarded", "text": "The other half arrive through node 3."},
{"el": "k5-l-f2", "payload": "append · ~60 entries, one flush", "ms": 1, "set": {"ld.disk flushes": "~50 for the burst"}, "text": "A disk flush takes about a millisecond. One flush per request would take 3 seconds for the burst, and the last acquire would wait 3 seconds. Instead the leader takes everything that arrived during the previous flush, about 60 requests, and appends it with one flush and one message to each follower. About 50 flushes cover the whole burst."},
{"el": "k5-l-f3", "payload": "same batch", "ms": 3, "text": "Each batch commits when a majority has stored it."},
{"el": "k5-f2-c", "payload": "granted · tokens 10,201, …", "ms": 1, "text": "Each acquire is answered as soon as its batch commits: within about 10ms of arriving, at the busiest moment of the hour."}
]
}
]
}
</script>
<div class="diagram-caption">Clients connect to any node. Followers forward writes to the leader, gather keepalives into one message every 500ms, serve watches from their own copy of the log, and answer reads after checking the latest commit index with the leader. The leader batches writes into as few disk flushes as it can.</div>
</div>

<div class="fail-hint">Click either follower or the leader to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="f25">
<strong>If node 2 fails:</strong> its clients reconnect to another node, usually within a second. Their sessions survive: deadlines are kept by the leader, and a reconnected client's next keepalive arrives well inside its TTL. Watches resume from the last index each client received. Replay the first flow.
</div>
<div class="failure-impact is-hidden" data-component="f35">
<strong>If node 3 fails:</strong> the same, for its clients. Writes still commit on the remaining four nodes.
</div>
<div class="failure-impact is-hidden" data-component="l5">
<strong>If the leader fails:</strong> a follower is elected within 1 to 2 seconds and gives every session a full TTL, as in Stage 3. Writes and checked reads wait for the election. Watches already open keep receiving everything committed before it, and stale reads from followers continue.
</div>
</div>

This is the full design. Five nodes in three zones keep the lock table as a replicated log: every change is an entry, committed once three of the five have it on disk, so a granted lock survives any two failures, and a network split leaves at most one side able to grant anything. Clients hold sessions rather than per-lock leases. One keepalive every 3 seconds keeps all of a client's locks, and an expired session releases them all in one entry. Every grant carries a fencing token, the index of the entry that granted it, and the resources being protected reject writes with a token lower than one they have seen, so a holder that paused past its session can't do harm when it wakes. Waiters queue on the server and receive the lock in the same entry that releases it. Leader election is a lock with an address on it, and anyone who needs the leader watches it. Followers absorb the keepalives, watches and reads, and the leader batches writes, so a single group handles 100,000 clients.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### Why a committed entry is never lost

The guarantee rests on four rules ([Consensus](#/systems/consensus) has the full protocol):

1. **Terms.** Time is divided into numbered terms, each beginning with an election. A node votes at most once per term, and any message from a higher term makes a leader step down.
2. **Votes go to complete logs only.** A node votes for a candidate only if the candidate's log is at least as up to date as its own: a later last term, or the same last term and at least as long.
3. **Commit means a majority.** An entry from the leader's current term is committed once a majority has stored it.
4. **Followers copy the leader.** Where a follower's log disagrees with the leader's, the follower's is cut back and overwritten.

Any two majorities of five nodes share at least one node. A new leader needed a majority of votes, so one of its voters stored every committed entry, and that voter only voted for a log at least as complete as its own. So every leader has every committed entry, and nothing a client was told is lost.

**Why five nodes, in 2-2-1.** Three nodes survive one failure; five survive two; seven survive three, but every write then waits for four copies. Five is the usual balance. Placing them two, two and one across three zones means losing any single zone leaves at least three.

### Locks for efficiency and locks for correctness

Not every lock needs all of this. It depends on what happens if two holders overlap.

- **Efficiency locks** stop work being done twice when doing it twice is merely wasteful: two copies of a cache refresh, two copies of a report. An occasional overlap costs some computing. A single lock server, or a lock taken on a majority of several independent servers each with its own expiry, is good enough.
- **Correctness locks** protect things that break if two holders overlap: a double charge, a corrupted file, two primaries accepting writes. These need consensus-backed state *and* fencing at the resource.

Locks taken on a majority of independent servers deserve a note. They have no shared log, so they are fast. But their safety rests on timing: that clocks run at similar rates and that no holder pauses longer than its expiry. They also produce no token that increases with each grant, so a resource has nothing to check. They suit efficiency locks only.

### When the resource can't check a token

Fencing needs the protected resource to compare tokens.

- **A database** does it in the same transaction as the write: `UPDATE fences SET token = :t WHERE lock = 'billing-run' AND token <= :t`, and abort if no row changed.
- **An object store with conditional writes** can store the token with the object, writing only if the stored token isn't higher.
- **An external API** — a payment provider, an email service — can't. Then the effect itself has to be safe to repeat: every call carries an idempotency key derived from the work, such as the billing date and the customer, so a second holder's call is recognized as a repeat ([Idempotency](#/systems/idempotency)).
- **Where neither is possible**, the client's own countdown is the only protection, and the window it leaves open has to be accepted.

### Time without trusting clocks

Nothing in the design compares clock readings taken on different machines.

- The **leader** measures session deadlines on its own monotonic clock, which only moves forward and isn't adjusted by time synchronization.
- The **client** measures its countdown on its own monotonic clock, starting when it *sent* the last keepalive that was answered. The service can only have heard it after that, so the service's deadline is always later than the client's.
- The only assumption is that clocks run at about the same *rate*. A 3-second margin on a 10-second TTL leaves plenty of room for that.

What no clock can handle is a process that is paused between checking its countdown and acting on it. That is why the token, not the countdown, is the guarantee.

### Watches, indexes and history

Every change carries its log index, and a watch can start from any index. The service keeps the last 10 minutes of changes. A watcher that has been disconnected for longer is told its index is too old. It then reads the current value, which carries the index it reflects, and watches from there. It misses intermediate changes but never ends up with a wrong current value.

### Snapshots

The log can't grow forever. Every 100,000 entries, each node writes its tables to disk as a snapshot, about 350MB, and drops the log before it. A new node, or one that has been down so long that the leader no longer has the entries it is missing, receives the latest snapshot and then the log after it.

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### One leader for all writes

Every write goes through one node. With batching, that comfortably covers tens of thousands of writes a second, but not unlimited growth. Beyond that, lock names are split across several independent groups, each with its own five nodes and leader, by name prefix. The cost: nothing can be done atomically across groups, and a client using several groups needs a session in each.

### A single hot lock

Handing a lock to the next waiter takes one commit and a round trip to the new holder: about 10ms. One lock can therefore change hands about 100 times a second, however fast the service is. A lock that needs more than that is too coarse — one lock per merchant should become one per account.

### Commit time includes another zone

Every write waits for a copy in another zone. A cluster in a single zone would commit in a millisecond but die with its zone. Five nodes across three zones is the trade for surviving one.

### The session TTL

A short TTL frees a dead client's locks sooner, and for an election shortens the time with no leader. It also ends the sessions of clients that are only paused or briefly cut off, making them stop work they could have finished. 10 seconds suits background jobs. A role that needs to fail over faster needs a shorter TTL and clients that can be trusted to keep it alive.

### Fairness costs speed

First-come order means each handover waits for one particular client to respond. Letting whichever waiter asks next take the lock would be faster when the head of the queue is slow, but reintroduces starvation. The design chooses fairness.

### Every service depends on it

A lock service that many services share can stop all of them at once. Clients are written to keep doing any work that doesn't need a new lock while the service is unreachable. The most critical services can be given a cluster of their own, so that one service's misuse can't affect them.

### Tokens only help where they're checked

The service hands out tokens; it can't make anyone use them. A resource that ignores the token is protected only by the client's countdown, which a long enough pause defeats.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

A lock service decides who is allowed to act. Anyone who can take a lock or win an election can make other systems step aside, so access to it has to be controlled as carefully as access to the systems it guards ([Security & Authentication](#/systems/security-authentication)).

### Who is asking

Every client connects with a certificate identifying its service, through mutual TLS. Sessions record that identity, and so does every lock grant.

### Who may use which names

Names are grouped by prefix, and each prefix has an access list. Only the billing service may take locks under `billing/` or campaign for `billing-leader`. Read and watch access are granted separately, so that a router can watch the leader without being able to become it.

### Quotas

Each client identity has limits: at most 100 sessions, 1,000 locks per session, 10,000 waiters per lock, and a request rate. A buggy client that opens sessions in a loop, or queues a million waits, hits its own limit long before it affects anyone else.

### Forced releases

Operators can force a release, with a required reason, recorded in an audit log. The next grant then has a higher token, so if the stuck holder is in fact still running, its writes are rejected wherever tokens are checked.

### The nodes themselves

Nodes talk to each other over mutual TLS, and only machines with node certificates can join. Adding or removing a node is an operator action, one node at a time, and is itself committed through the log. A machine that isn't a member can't vote or receive entries.

### What's stored

Values are limited to 1KB and are readable by anyone with read access to their prefix, so they must never contain secrets. Snapshots and logs are encrypted on disk, since they list every service's names and addresses.

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **Commit latency**, from the leader receiving a write to its commit, at p50 and p99; and **disk flush latency** on every node.
- **Leader changes**, and how long each election took.
- **How far each follower is behind** the leader, in entries.
- **Proposals waiting** on the leader: writes received but not yet committed.
- **Sessions**: how many are open, and how many expire each minute. A sudden jump in expiries usually means a network problem on the clients' side, not dead clients.
- **Locks**: how long each is held, the longest-held locks, and the longest queues.
- **Watches**: open count, and how far behind the slowest watchers are.
- **Snapshot size and disk space** on every node.

([Observability](#/systems/observability))

### What to alert on

- No leader for more than **5 seconds**.
- More than **2 leader changes** in 10 minutes.
- Disk flush p99 above **20ms** on any node.
- Any node down for more than **10 minutes**: one more failure leaves no margin.
- Session expiries above **10×** their normal rate.
- Any lock held for more than **6 hours**, or with more than **1,000** waiters.

### "Two workers both ran tonight's billing" — what happens?

The log is the record of truth. Find every grant and release of `billing-run` for the night, with their indexes. If the grants didn't overlap — the second came after the first holder's session expired — then the service behaved correctly, and the question is why the first worker kept going. Check whether the billing DB checked tokens: a write carrying the older token should have been rejected. If it wasn't, the resource isn't fencing, and that is the bug. Overlapping grants in the log itself would be a defect in the service, and the most serious kind.

### "The leader keeps changing" — what happens?

Elections happen when followers miss heartbeats. The usual causes are a slow disk on the leader, holding heartbeats up behind flushes; long pauses in the leader's process; or a congested network between zones. Check flush latency and process pauses on the node that keeps losing leadership. Raising the election timeout hides the symptom and slows every real failover, so it comes last.

### "Thousands of sessions expired at once" — what happens?

Look at which node those sessions were connected to. If they were all on one follower, that follower failed or stalled and its clients didn't reconnect in time: check client reconnect settings. If they were all from one service, that service paused — a deploy, or a dependency it blocked on — and its clients stopped sending keepalives. If they were spread everywhere, look at the network between the clients and the service.
