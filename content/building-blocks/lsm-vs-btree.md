# Go Deeper: LSM-Trees vs. B-Trees

Both structures solve the same problem — store sorted data so it can be looked up and range-scanned efficiently — but they make opposite choices about the one thing that matters most for performance: whether a write updates data in place or appends somewhere new. Everything else about how each behaves follows from that single decision.

## B-trees: update in place

A B-tree organizes data into fixed-size **pages** (often 4KB, matching typical disk page sizes), arranged in a balanced tree with a high **fanout** — each page holds references to many child pages, which keeps the tree shallow (typically 3-4 levels deep even for very large tables) so a lookup only needs to read a handful of pages from root to leaf.

Writing a value means finding the exact leaf page it belongs on (via a normal tree traversal) and modifying that page directly, in place, on disk. If the page has room, this is a single, efficient update. If the page is full, it has to **split** into two pages, which means updating the parent page's references too — a cascading, sometimes expensive operation, though a well-tuned B-tree keeps this rare relative to normal updates.

<div class="diagram-wrap">
<svg viewBox="0 0 600 190" width="600" height="190" role="img" aria-label="B-tree in-place update: locate the exact page and modify it directly">
  <text x="150" y="25" text-anchor="middle" class="d-label">B-tree: write = find the page, modify in place</text>
  <rect x="130" y="45" width="100" height="30" rx="5" class="d-actor-box"></rect>
  <text x="180" y="65" text-anchor="middle" class="d-actor-label" font-size="12">root</text>
  <line x1="160" y1="75" x2="90" y2="105" class="d-lifeline"></line>
  <line x1="200" y1="75" x2="270" y2="105" class="d-lifeline"></line>
  <rect x="50" y="105" width="80" height="30" rx="5" class="d-actor-box"></rect>
  <text x="90" y="125" text-anchor="middle" class="d-label" font-size="11">page A</text>
  <rect x="230" y="105" width="80" height="30" rx="5" class="d-block d-block-request"></rect>
  <text x="270" y="125" text-anchor="middle" class="d-block-label">page B ✎</text>
  <text x="270" y="160" text-anchor="middle" class="d-label-muted" font-size="11">value written directly here, on disk, right now</text>
</svg>
<div class="diagram-caption">A single write touches one page, at its exact on-disk location. Reads and writes both go through the same, single, always-current structure.</div>
</div>

The clear strength: because there's always exactly one, current, in-place copy of the data, reads are simple and fast — a lookup walks the tree once and gets the current, final answer directly, with no reconciliation needed. The cost is on the write side: updates mean random disk I/O (the page being modified could be anywhere on disk, unrelated to pages modified just before or after it), which is significantly more expensive than sequential I/O — and this is true even on SSDs, where random access, while much better than spinning disks, is still slower than sequential access.

## LSM-trees: never update in place

A **log-structured merge-tree** takes the opposite approach. A write is first appended to the write-ahead log (for durability) and simultaneously inserted into an in-memory sorted structure called a **memtable**. Because this is purely an in-memory operation plus a sequential log append, writes are extremely fast — no seeking to a specific location on disk at all.

When the memtable reaches a size threshold, it's flushed to disk as a new, immutable, sorted file (an **SSTable** — Sorted String Table). "Immutable" is the key word: once written, an SSTable is never modified — updates and deletes to existing keys are handled by simply writing a newer entry (or a deletion marker, called a **tombstone**) to whatever the current memtable is, to be reconciled later.

<div class="diagram-wrap">
<svg viewBox="0 0 600 220" width="600" height="220" role="img" aria-label="LSM tree write path: memtable flushed to immutable SSTables, later merged by compaction">
  <text x="100" y="25" text-anchor="middle" class="d-label">write</text>
  <rect x="20" y="40" width="120" height="34" rx="6" class="d-block d-block-request"></rect>
  <text x="80" y="62" text-anchor="middle" class="d-block-label">Memtable (RAM)</text>
  <line x1="140" y1="57" x2="196" y2="57" class="d-msg d-request" marker-end="url(#arrowLsm)"></line>
  <text x="168" y="50" text-anchor="middle" class="d-label-muted" font-size="10">flush</text>
  <rect x="200" y="40" width="90" height="30" rx="5" fill="none" stroke="var(--border)"></rect>
  <text x="245" y="60" text-anchor="middle" class="d-label" font-size="11">SSTable 1</text>
  <rect x="200" y="90" width="90" height="30" rx="5" fill="none" stroke="var(--border)"></rect>
  <text x="245" y="110" text-anchor="middle" class="d-label" font-size="11">SSTable 2</text>
  <rect x="200" y="140" width="90" height="30" rx="5" fill="none" stroke="var(--border)"></rect>
  <text x="245" y="160" text-anchor="middle" class="d-label" font-size="11">SSTable 3</text>
  <text x="245" y="185" text-anchor="middle" class="d-label-muted" font-size="10">each immutable once written</text>
  <line x1="290" y1="55" x2="380" y2="100" class="d-lifeline"></line>
  <line x1="290" y1="105" x2="380" y2="105" class="d-lifeline"></line>
  <line x1="290" y1="155" x2="380" y2="110" class="d-lifeline"></line>
  <rect x="390" y="80" width="150" height="50" rx="6" class="d-note"></rect>
  <text x="465" y="100" text-anchor="middle" class="d-note-text">Compaction:</text>
  <text x="465" y="118" text-anchor="middle" class="d-note-text" font-size="11">merges + dedups in the background</text>
  <defs>
    <marker id="arrowLsm" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">Writes only ever touch the in-memory memtable and a sequential log — genuinely fast. The cost is deferred to compaction, a background process that later merges the growing pile of SSTables back down.</div>
</div>

The clear strength here is the mirror image of the B-tree's: writes are about as fast as they can possibly be, since they never require finding and modifying an existing on-disk location. The cost lands on reads and on ongoing background work: a key's current value might exist in the memtable, or in any of several SSTables (whichever was most recently written wins) — so a read may need to check multiple places, and a background process called **compaction** continuously merges older SSTables together, discarding overwritten and tombstoned entries, to keep the number of files a read has to check from growing without bound. Compaction itself consumes real disk I/O and CPU as an ongoing tax, separate from serving actual requests — a cost the B-tree design simply doesn't have.

A common optimization worth knowing by name: **Bloom filters** — a compact, probabilistic structure that can quickly tell you "this SSTable definitely does not contain this key" (with no false negatives, though occasional false positives), letting a read skip files it doesn't need to open at all. This is what keeps LSM-tree reads competitive in practice despite having to potentially check multiple files.

## Side by side

| | B-tree | LSM-tree |
|---|---|---|
| Writes | In place — random I/O | Append-only — sequential I/O |
| Write throughput | Good | Excellent |
| Read latency | Excellent — one current copy | Good — may check multiple files, mitigated by Bloom filters |
| Background cost | Occasional page splits | Continuous compaction |
| Best fit | Read-heavy or balanced workloads | Write-heavy workloads (logging, metrics, event ingestion) |

## Why this matters for system design

This is the same read/write asymmetry from Scaling Fundamentals, showing up again at the disk layer: optimizing for fast writes (LSM) costs something on the read side, and optimizing for fast, simple reads (B-tree) costs something on the write side — there is no structure that's simply better at both. When a workload is described as extremely write-heavy (metrics ingestion, logging, event streams — notice the overlap with what wide-column stores and Kafka were built for), that's usually a strong signal an LSM-based engine is the right underlying choice, independent of whatever data model or query language sits on top of it.
