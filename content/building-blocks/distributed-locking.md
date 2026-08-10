# Distributed Locking & Leader Election

Consensus covers how a group of nodes agrees on a value even when some of them might fail — the theory underneath. This page is the practical tool system builders reach for constantly, built on that same idea: making sure only one process does a particular piece of work at a time, even though many processes could try at once.

## Why an in-process lock isn't enough

A normal mutex only protects against other threads in the *same* process. Once the same logical operation could be attempted from multiple machines — two instances of a cron job, two app servers racing to grab the same queued task — a lock has to live somewhere all of them can see and agree on, and it has to survive a machine crashing while holding it. That second requirement is the one that makes this genuinely hard.

## The basic mechanism: a lease, not a lock

The common pattern uses a shared, fast store (Redis is the typical choice): a command like "set this key, but only if it doesn't already exist, and expire it automatically after 30 seconds" — whoever's `SET` succeeds holds the lock; everyone else's fails. The expiry is the crucial detail, and it's why this is called a **lease** rather than a permanent lock: if the holder crashes before releasing it, the lease still expires on its own. A lock with no expiry means one crashed process can freeze the critical section forever.

## The hard part: the lock holder can be wrong about still holding it

This is the subtle failure worth understanding in full, because it's easy to assume the lease alone solves everything:

1. Worker A acquires the lock.
2. Worker A pauses unexpectedly — a long garbage-collection pause, a network partition — for longer than the lease's expiry.
3. The lease expires while A is paused. Worker B acquires the now-free lock and starts doing the protected work.
4. Worker A wakes up. It never released the lock and has no idea time passed — as far as it knows, it still holds it. It also does the protected work.

Now two workers are doing work the lock was specifically meant to make exclusive.

<div class="diagram-wrap">
<svg viewBox="0 0 640 200" width="640" height="200" role="img" aria-label="Worker A pauses long enough for its lease to expire, Worker B acquires the lock and writes successfully, then Worker A resumes and attempts a now-stale write">
  <text x="75" y="62" text-anchor="end" class="d-label" font-size="12">Worker A</text>
  <rect x="90" y="44" width="90" height="28" class="d-block d-block-request"></rect>
  <rect x="180" y="44" width="180" height="28" class="d-block d-block-blocked"></rect>
  <rect x="360" y="44" width="80" height="28" style="fill:var(--fail-soft);stroke:var(--fail);stroke-width:1.5;"></rect>
  <text x="75" y="128" text-anchor="end" class="d-label" font-size="12">Worker B</text>
  <rect x="260" y="110" width="110" height="28" class="d-block d-block-response"></rect>
  <line x1="360" y1="34" x2="360" y2="155" class="d-marker-line"></line>
  <text x="360" y="26" text-anchor="middle" class="d-label-muted" font-size="10">A resumes — lease already expired</text>
  <line x1="90" y1="165" x2="585" y2="165" class="d-axis"></line>
  <text x="592" y="169" class="d-label-muted" font-size="11">time →</text>
</svg>
<div class="diagram-caption">Worker A holds the lock, then pauses (orange) long enough for the lease to expire. Worker B acquires it and writes successfully (green). Worker A resumes, still believing it holds the lock, and attempts its own write (red) — exactly the double-write the lock existed to prevent.</div>
</div>

The fix is a **fencing token**: every time the lock is acquired, an incrementing number is issued along with it, and whatever the lock protects — a write to storage, in this example — must include that token. The protected resource itself rejects any write carrying a token lower than the highest one it's already seen. In the diagram above, Worker B's write carries a higher token than Worker A's stale one, so Worker A's late write is rejected outright, regardless of what either worker believes about holding the lock. The lock alone can't fully solve this; the resource being protected has to participate too.

## Leader election

Leader election is the same underlying need — exactly one of something — applied to an ongoing *role* instead of a one-off critical section. A group of replicas elects one leader to handle writes or coordination (the same role a primary plays in Replication, or a Raft leader plays in Consensus) until it fails, at which point the others detect that and elect a replacement. Mechanically, it's the same lease idea, just held continuously and renewed with a heartbeat rather than acquired once and released.

## Why this matters for system design

This page is less a new idea than a name for a mechanism that's already quietly underneath several other Building Blocks: a replication primary *is* a leader; Raft's leader election in Consensus *is* this pattern, formalized with a full correctness proof; a message queue consumer that should be the only one processing a given exclusive job needs exactly this kind of lock. Recognizing distributed locking as the shared, practical primitive underneath those other topics is often more useful than treating each one as unrelated.

## Real-world examples

- **Redis** — the most common practical lock store, via `SET ... NX EX`, or the stricter multi-node **Redlock** algorithm for higher-guarantee locks.
- **ZooKeeper, etcd** — purpose-built coordination services, built on consensus protocols, commonly used for leader election (Kafka historically used ZooKeeper for exactly this).
- **Kubernetes leader election** — controllers coordinate via a lease object stored in etcd, the same lease-based pattern described above.
