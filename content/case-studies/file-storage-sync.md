# File Storage & Sync

A file sync service keeps a folder the same on every device someone owns. Save a file on a laptop and it appears on the desktop at the studio, on the phone and in the browser, without anyone pressing upload. Share a folder and it stays the same for everyone in it. The hard parts are the files and the people. A 120 MB file changed in one corner shouldn't cost 120 MB to send. A laptop that was asleep for a week needs to find out what changed without re-reading everything. Two people edit the same file, one of them on a train with no signal, and neither should lose their work. And what's stored has to last for years, at a size measured in hundreds of petabytes. This case study builds the service for 100 million accounts, with 60 million devices online at peak and about a billion file changes a day.

<!-- tab:requirements:Requirements -->

## Requirements

This case study builds the service that stores people's files and keeps every device and every member of a shared folder up to date. The running example is Priya, a freelance designer with a laptop and a desktop at the studio, then a folder shared with Sam, a copywriter, and finally Northwind, a 2,000-person company that keeps its shared drive on the service.

### Functional requirements

- **Sync a folder**: files added, changed, moved or deleted on one device appear the same way on every other device linked to the account.
- **Send only what changed**: an edit to part of a large file uploads and downloads roughly that part, not the whole file.
- **Resume**: an upload or download that's cut off carries on from where it stopped.
- **Work offline**: changes made without a connection sync when the connection returns.
- **Share folders**: several people's accounts hold the same folder, and changes by any of them reach all of them.
- **Never lose work to a conflict**: when two people change the same file at once, both versions are kept.
- **History and restore**: earlier versions of a file, and deleted files, can be restored for 30 days.

### Non-functional requirements

- **Sync lag:** a small change on one device is on the account's other online devices within **2 seconds** at p50 and **10 seconds** at p99, plus the time to transfer the changed bytes.
- **Efficiency:** an edit uploads roughly the **bytes that changed**, in whole blocks of at most 4 MB.
- **Resumable:** a dropped connection loses at most **one block** of progress.
- **Durability:** a file whose upload was confirmed is **never lost**. Designed for eleven nines a year.
- **Availability:** 99.99% of commits and downloads succeed.
- **Scale:** **100 million** accounts, **60 million** devices online at peak, **35,000** file changes a second at peak, **600 PB** of unique data.

### In scope

Splitting files into blocks named by their content, uploading only missing blocks, committing file versions, change journals and cursors, notifying devices, shared folders, conflicts, renames, deletes and restores, sharding the metadata, very large shared folders, caching and local-network sync, and storage tiers.

### Out of scope

**Editing a document together in real time**, which is [Collaborative Document Editing](#/systems-case-studies/collaborative-editing). **Previews, search inside files, and photo features**. **Billing**: each account has a storage quota and this design enforces it, but plans and payment are elsewhere. **End-to-end encryption**: the trade-off is in Deep Dives.

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

Most files are small and most edits are small. What shapes the design is the total stored, the number of devices waiting to hear about changes, and the few large files whose small edits must not cost a full transfer.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Accounts</div>
<div class="stat-tile-value">~100<span class="stat-tile-unit">M</span></div>
<div class="stat-tile-sub">~25M active on a typical day</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Devices online</div>
<div class="stat-tile-value">~60<span class="stat-tile-unit">M</span></div>
<div class="stat-tile-sub">at peak · 250M linked</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">File changes</div>
<div class="stat-tile-value">~35<span class="stat-tile-unit">K/s</span></div>
<div class="stat-tile-sub">at peak · 1B a day</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Unique data</div>
<div class="stat-tile-value">~600<span class="stat-tile-unit">PB</span></div>
<div class="stat-tile-sub">800 PB before deduplication</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">New data uploaded</div>
<div class="stat-tile-value">~1<span class="stat-tile-unit">PB/day</span></div>
<div class="stat-tile-sub">~93 Gbps on average</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Files tracked</div>
<div class="stat-tile-value">~500<span class="stat-tile-unit">B</span></div>
<div class="stat-tile-sub">~5,000 per account</div>
</div>
</div>

### Assumptions

- **100 million** accounts, with **2.5** linked devices each on average. At peak, **60 million** devices are online.
- The average account stores **8 GB** in about **5,000 files**: 1.6 MB a file on average, but most are a few KB and a few are gigabytes.
- **1 billion** file changes a day: adds, edits, moves and deletes.
- An edit to a large file usually changes a small part of it.
- Each change is downloaded by **1.5** other devices on average: the account's other devices, and other members of shared folders.

### Changes

1 billion changes a day is 11,600 a second on average, and about **35,000 a second** at peak. Each one is a commit to the metadata, and each tells 1.5 other devices on average that something changed: about 50,000 change lists read a second at peak.

### Bytes moving

After deduplication, a change uploads about 1 MB of new data on average: **1 PB a day**, 11.6 GB a second, about 93 Gbps. Downloads are 1.5 times that, 1.5 PB a day. Without blocks, every edit to a large file would resend the whole file, and uploads would be several times larger.

### Storage

100 million accounts at 8 GB is 800 PB. Much of it is the same bytes more than once: copies of a file in two folders, an old version that differs from the new one in a few blocks, the same installer or video in thousands of accounts. Storing each distinct block once saves about a quarter: **600 PB** of unique data. Kept in three copies, that's 1.8 EB of disk.

### Metadata

500 billion files, each with a current row and its list of block hashes, is about 300 bytes a file: 150 TB. With 30 days of old versions and the change journals, about 250 TB. That's far beyond one database, and spread over about **2,000 shards** of 125 GB each.

### Waiting devices

Each of the 60 million online devices keeps one request open to hear about changes. At 100,000 open connections per server, that's **600 notification servers**, doing very little work each, most of the time.

<!-- tab:api-design:API Design -->

## API Design

Bytes and metadata travel separately. Blocks are uploaded and downloaded by their content hash. A file version is committed as a list of those hashes. Devices find out about changes by holding a request open, and read the changes themselves with a cursor.

### Blocks

```
POST /v1/blocks/check
{"namespace_id": "ns_1182",
 "hashes": ["9f2c41e0…", "41ab07d3…", …30 hashes…]}
→ 200 {"needed": ["c7d1e98a…", "08be5f12…"]}

PUT /v1/blocks/c7d1e98a…          4 MB of bytes
→ 201

GET /v1/blocks/c7d1e98a…
→ 200 4 MB of bytes
```

### Committing a file version

```
POST /v1/files/commit
{"namespace_id": "ns_1182", "file_id": "f_88231", "parent_rev": 8,
 "size": 125829120, "blocks": ["9f2c41e0…", "41ab07d3…", …]}
→ 200 {"rev": 9, "journal_id": 4512}
→ 409 {"error": "conflict", "current_rev": 9}
→ 400 {"error": "missing_blocks", "hashes": ["c7d1e98a…"]}

POST /v1/files/commit                        -- a new file
{"namespace_id": "ns_1182", "parent_id": "fd_17", "name": "brochure.psd",
 "size": 125829120, "blocks": […]}
```

### Moves, deletes and restores

```
POST /v1/files/fd_310/move     {"parent_id": "fd_17", "name": "Drafts (old)"}
POST /v1/files/fd_412/delete
POST /v1/namespaces/ns_9001/restore   {"folder_id": "fd_412", "as_of": "2026-10-28T10:41:00Z"}
```

### Changes and notifications

```
GET /v1/changes?namespace_id=ns_1182&cursor=4511
→ 200 {"entries": [{"journal_id": 4512, "file_id": "f_88231", "op": "edit",
                    "rev": 9, "path": "/Client Work/brochure.psd",
                    "blocks": […]}],
       "cursor": 4512, "has_more": false}

GET /v1/notify?cursors=ns_1182:4512,ns_9001:771       -- held up to 90 seconds
→ 200 {"changed": ["ns_9001"]}
→ 200 {"changed": []}                                 -- timed out; ask again
```

| Code | Meaning |
|---|---|
| `200` | Done |
| `201` | Block stored |
| `400` | A block's bytes don't match its hash, or a commit names blocks that aren't stored |
| `403` | The device's account can't write to this namespace |
| `404` | No such file, folder or namespace |
| `409` | The file has changed since `parent_rev` |
| `410` | The cursor is older than the journal still holds; list the namespace in full |
| `413` | A block larger than 4 MB |
| `429` | Over the device's request rate |
| `507` | The account is over its storage quota |

### Why the details matter

**Blocks are named by their content.** A block's name is the SHA-256 hash of its bytes. The same bytes always get the same name, so a block already stored is never stored twice, and uploading the same block twice is harmless ([Idempotency](#/systems/idempotency)). The block servers hash every block on arrival and refuse one whose bytes don't match its name.

**Ask before sending.** `check` returns only the hashes this account doesn't already have. An edit that changes 2 blocks out of 30 uploads 2.

**Blocks first, commit last.** A file version exists only once it's committed, and a commit is refused if any of its blocks isn't stored. Nobody ever sees a file with missing parts.

**`parent_rev` makes a commit conditional.** It names the version the edit started from, and a commit succeeds only if the file is still at that version. That is how two edits to one file are both kept instead of one silently replacing the other.

**Files are named by ID, not by path.** An edit names `file_id`. A rename or a move changes the file's folder or name, and an edit made elsewhere at the same time still finds the file.

**The cursor is the source of truth.** A notification only says "look". The device reads the changes after its own cursor, so a notification that never arrives costs time, never a change.

<!-- tab:data-model:Data Model -->

## Data Model

Two kinds of data, stored differently. Metadata says what files exist, where they are and which blocks make them up. It is small, changes often and is read in order, so it goes in relational shards, each holding whole namespaces. Blocks are the bytes. They are large, never change once written, and are read by hash, so they go in a block store.

### Namespaces

```
namespaces                               -- one per account root and per shared folder
  ns_id          TEXT PRIMARY KEY        -- ns_1182 (Priya's files), ns_9001 (Acme Launch)
  kind           TEXT                    -- root | shared
  journal_head   BIGINT                  -- 4512
  shard          TEXT                    -- md-0417

mounts                                   -- where each shared folder appears (from Stage 4)
  account_id     TEXT                    -- a_1182
  ns_id          TEXT                    -- ns_9001
  mount_path     TEXT                    -- /Acme Launch
```

### Files, revisions and the journal

```
files                                    -- relational, sharded by ns_id
  ns_id          TEXT
  file_id        TEXT                    -- f_88231; PRIMARY KEY (ns_id, file_id)
  parent_id      TEXT                    -- the folder it's in, by ID (from Stage 4)
  name           TEXT                    -- brochure.psd
  is_folder      BOOL
  rev            INT                     -- 9
  deleted        BOOL                    -- a tombstone (from Stage 4)
  size           BIGINT

file_revisions
  ns_id, file_id, rev                    -- PRIMARY KEY
  blocks         BYTES                   -- 30 hashes of 32 bytes each
  size           BIGINT
  device_id      TEXT                    -- which device committed it
  created_at     TIMESTAMP               -- kept 30 days after being replaced

journal                                  -- the namespace's change log (from Stage 3)
  ns_id          TEXT
  journal_id     BIGINT                  -- PRIMARY KEY (ns_id, journal_id)
  file_id        TEXT
  op             TEXT                    -- add | edit | move | delete | restore
  rev            INT
```

### Blocks

```
block index                              -- key-value, partitioned by hash
  c7d1e98a… → size: 4194304, tier: hot, locations: [cell-12/vol-3381, …],
              last_read: 2026-10-28

account blocks                           -- which hashes each account may reference
  (a_1182, c7d1e98a…) → uploaded or in a file the account can read

block store                              -- the bytes, 3 copies; erasure coded when cold (Stage 5)
```

### Why this storage

A commit changes a file row, adds a revision and appends to the journal, and all three must happen together or not at all. Keeping a whole namespace on one shard makes every commit a transaction on one database ([Databases: Relational](#/systems/databases-relational), [Partitioning & Sharding](#/systems/partitioning-sharding)). The journal's key, `(ns_id, journal_id)`, is read in ranges: "everything in `ns_1182` after 4,511". Blocks are the opposite: written once, never changed, and read by a key with no order, which is what a block store with a hash index is built for ([Databases: NoSQL](#/systems/databases-nosql)). Because a block never changes, any copy of it anywhere, on a cache, in another region or on a device in the same office, is as good as the original, and its hash proves it.

<!-- tab:architecture:Architecture:default -->

This case study builds file storage and sync up in five stages. Each stage fixes a specific failure of the one before. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one request at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. Upload Whole Files -->

## Stage 1 — Upload Whole Files

The simplest sync service stores whole files. When a file in the synced folder changes, the device uploads all of it. Every 30 seconds, each device asks for a list of every file in the account and downloads any that are newer than its own copy.

```
PUT  /files/Client Work/brochure.psd       ← the whole file
GET  /files?all                            → [{"path": "…", "size": …, "modified": …}, …]
GET  /files/Client Work/brochure.psd       → the whole file
```

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 780 300" width="780" height="300" role="img" aria-label="Priya's laptop uploads whole files to an app server, and the studio desktop asks the app server for a full listing every 30 seconds and downloads whole files; the app server stores files on its disk with a row per file">
  <rect x="20" y="40" width="140" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Priya's Laptop</text>
  <text x="90" y="83" text-anchor="middle" class="d-label-muted" font-size="9">uploads whole files</text>
  <rect x="20" y="190" width="140" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="216" text-anchor="middle" class="d-actor-label" font-size="12">Studio Desktop</text>
  <text x="90" y="233" text-anchor="middle" class="d-label-muted" font-size="9">lists everything every 30 s</text>
  <g data-fail-toggle="app1">
    <rect x="260" y="95" width="180" height="110" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="350" y="130" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
    <text x="350" y="148" text-anchor="middle" class="d-label-muted" font-size="9">store whole files</text>
    <text x="350" y="163" text-anchor="middle" class="d-label-muted" font-size="9">list the whole account</text>
  </g>
  <g data-fail-toggle="disk1">
    <rect x="560" y="100" width="200" height="100" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="660" y="131" text-anchor="middle" class="d-actor-label" font-size="12">Disk + Database</text>
    <text x="660" y="149" text-anchor="middle" class="d-label-muted" font-size="9">files on disk</text>
    <text x="660" y="164" text-anchor="middle" class="d-label-muted" font-size="9">one row per file</text>
  </g>
  <line id="f1-l-app" x1="162" y1="62" x2="256" y2="118" class="d-msg d-request" data-depends-on="app1" marker-end="url(#arrowF1)"></line>
  <line id="f1-app-l" x1="256" y1="140" x2="162" y2="86" class="d-msg d-response" data-depends-on="app1" marker-end="url(#arrowF1r)"></line>
  <line id="f1-d-app" x1="162" y1="212" x2="256" y2="168" class="d-msg d-request" data-depends-on="app1" marker-end="url(#arrowF1)"></line>
  <line id="f1-app-d" x1="256" y1="190" x2="162" y2="236" class="d-msg d-response" data-depends-on="app1" marker-end="url(#arrowF1r)"></line>
  <line id="f1-app-disk" x1="442" y1="136" x2="556" y2="136" class="d-msg d-request" data-depends-on="app1 disk1" marker-end="url(#arrowF1)"></line>
  <line id="f1-disk-app" x1="556" y1="166" x2="442" y2="166" class="d-msg d-response" data-depends-on="app1 disk1" marker-end="url(#arrowF1r)"></line>
  <text x="390" y="290" text-anchor="middle" class="d-label-muted" font-size="10">play the first upload, then an edit to one layer, then the Wi-Fi dropping at 90%</text>
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
{"id": "dev", "title": "Devices", "rows": [["laptop", "—"], ["desktop", "—"]]},
{"id": "srv", "title": "Server", "rows": [["brochure.psd", "—"], ["received", "—"]]}
],
"flows": [
{
"id": "first",
"label": "The first upload",
"nodes": ["app1", "disk1"],
"steps": [
{"el": "f1-l-app", "payload": "PUT brochure.psd · 120 MB", "set": {"dev.laptop": "uploading brochure.psd", "dev.desktop": "—", "srv.brochure.psd": "—", "srv.received": "—"}, "text": "Priya saves brochure.psd, a 120 MB Photoshop file, into the synced folder. The laptop uploads the whole file. On a 20 Mbps home connection, that takes 48 seconds."},
{"el": "f1-app-disk", "payload": "write file · insert row", "set": {"srv.received": "120 MB"}, "text": "The app server writes the bytes to its disk, and records the file's path, size and modified time in a row."},
{"el": "f1-disk-app", "payload": "saved", "ms": 40, "set": {"srv.brochure.psd": "120 MB · 10:02"}, "text": "Stored."},
{"el": "f1-app-l", "payload": "200 · saved", "set": {"dev.laptop": "brochure.psd ✓"}, "text": "The laptop marks the file as synced."},
{"el": "f1-d-app", "payload": "list every file", "text": "Priya's desktop at the studio has the same folder. Every 30 seconds it asks the server for a list of every file in the account, with sizes and modified times."},
{"el": "f1-app-disk", "payload": "SELECT · 18,000 rows", "text": "Priya has 18,000 files."},
{"el": "f1-disk-app", "payload": "18,000 rows", "ms": 30, "text": "The server reads them all."},
{"el": "f1-app-d", "payload": "2.7 MB listing", "text": "The desktop compares the list with its own folder, file by file, and finds brochure.psd is new."},
{"el": "f1-d-app", "payload": "GET brochure.psd", "text": "It asks for the file."},
{"el": "f1-app-d", "payload": "120 MB", "set": {"dev.desktop": "brochure.psd ✓"}, "text": "And downloads all of it. Both computers now have the file, up to 30 seconds after Priya saved it, plus the download."}
]
},
{
"id": "edit",
"label": "An edit to one layer",
"nodes": ["app1", "disk1"],
"steps": [
{"el": "f1-l-app", "payload": "PUT brochure.psd · 120 MB again", "set": {"dev.laptop": "edited one layer", "dev.desktop": "brochure.psd · 10:02", "srv.brochure.psd": "120 MB · 10:02", "srv.received": "—"}, "text": "Priya changes the colour of one layer and saves. Photoshop rewrites about 8 MB in the middle of the file; the other 112 MB are exactly as they were. The laptop uploads all 120 MB again: another 48 seconds."},
{"el": "f1-app-disk", "payload": "overwrite file", "set": {"srv.received": "120 MB for an 8 MB change"}, "text": "The server overwrites its copy."},
{"el": "f1-disk-app", "payload": "saved", "ms": 40, "set": {"srv.brochure.psd": "120 MB · 10:15"}, "text": "Stored. The old version is gone."},
{"el": "f1-app-l", "payload": "200", "set": {"dev.laptop": "brochure.psd ✓"}, "text": "Synced."},
{"el": "f1-d-app", "payload": "list every file", "text": "On its next poll, the desktop asks for the full listing again, as it does every 30 seconds whether anything changed or not."},
{"el": "f1-app-d", "payload": "2.7 MB · brochure.psd newer", "text": "brochure.psd has a newer modified time."},
{"el": "f1-d-app", "payload": "GET brochure.psd", "text": "So the desktop downloads it."},
{"el": "f1-app-d", "payload": "120 MB", "set": {"dev.desktop": "brochure.psd · 10:15"}, "text": "All 120 MB, to pick up 8 MB of change. Priya saves this file about 40 times a day: almost 5 GB up and 5 GB down, for a few hundred MB of real change."}
]
},
{
"id": "drop",
"label": "The Wi-Fi drops at 90%",
"nodes": ["app1", "disk1"],
"steps": [
{"el": "f1-l-app", "payload": "PUT brochure.psd · 120 MB", "set": {"dev.laptop": "uploading", "dev.desktop": "brochure.psd · 10:15", "srv.brochure.psd": "120 MB · 10:15", "srv.received": "0 MB"}, "text": "Priya saves once more, then closes the laptop to leave."},
{"el": "f1-l-app", "payload": "… 108 MB of 120", "set": {"srv.received": "108 MB"}, "text": "43 seconds in, at 108 MB, Priya walks out of range of the Wi-Fi."},
{"el": "f1-app-disk", "payload": "discard partial file", "set": {"srv.received": "0 MB · discarded"}, "text": "The server has an incomplete file. A file that's 90% there is a broken file, so it throws the 108 MB away."},
{"el": "f1-l-app", "payload": "PUT brochure.psd · from byte 0", "set": {"srv.received": "120 MB"}, "text": "On the train's Wi-Fi, the laptop starts again from the beginning. On a connection that drops every few minutes, a large file may never finish."},
{"el": "f1-app-disk", "payload": "write file", "text": "This time it gets through."},
{"el": "f1-disk-app", "payload": "saved", "ms": 40, "set": {"srv.brochure.psd": "120 MB · 17:40"}, "text": "Stored."},
{"el": "f1-app-l", "payload": "200", "set": {"dev.laptop": "brochure.psd ✓ · 228 MB sent"}, "text": "228 MB sent to store 120 MB, of which 8 MB had changed."}
]
}
]
}
</script>
<div class="diagram-caption">Each device uploads whole files, and asks for a list of every file in the account every 30 seconds. The server keeps the files on its disk and a row per file.</div>
</div>

<div class="fail-hint">Click the app server or the disk to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="app1">
<strong>If the app server fails:</strong> nothing syncs. Each device keeps its own copy, and changes wait until the server is back.
</div>
<div class="failure-impact is-hidden" data-component="disk1">
<strong>If the disk fails:</strong> every file is unavailable. If it can't be recovered, every file that isn't still on some device is gone.
</div>
</div>

The whole file is the wrong unit. An edit that changes 8 MB sends 120, twice. A dropped connection throws away everything sent so far. Two copies of the same file are stored twice. And if the laptop and the desktop both change a file, whichever uploads last wins, silently. The file needs to be cut into pieces that can be sent, stored and checked one at a time, so that only the changed pieces move.

<!-- stage:2:2. Blocks Named by Content -->

## Stage 2 — Blocks Named by Their Content

- **Files are cut into blocks of 4 MB.** Each block is named by the SHA-256 hash of its bytes. The same bytes always get the same name, wherever they come from.
- **A file is a list of hashes.** A metadata service stores each file's revisions, and each revision's block list, in a metadata database. Block servers store and serve the bytes, in a block store that keeps three copies of each block ([Replication](#/systems/replication)).
- **Ask before sending.** Before uploading, the device sends the file's block list. The metadata service asks the block servers which of those hashes the account already has, and the device uploads only the rest.
- **Blocks first, then the commit.** A new revision is committed only after every one of its blocks is stored. A file never points at a block that isn't there.
- **Every block is its own upload.** A dropped connection loses at most the block in progress. On reconnecting, the device asks again and uploads only what's still missing.
- **Downloads work the same way.** A device compares the new block list with the blocks it already has on disk and fetches only the missing ones.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 400" width="860" height="400" role="img" aria-label="Priya's laptop and the studio desktop send block lists to a metadata service and blocks to block servers; the metadata service asks the block servers which blocks the account has and stores file revisions in a metadata database; the block servers keep blocks in a block store">
  <rect x="20" y="30" width="130" height="80" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="85" y="64" text-anchor="middle" class="d-actor-label" font-size="12">Priya's Laptop</text>
  <text x="85" y="81" text-anchor="middle" class="d-label-muted" font-size="9">cuts and hashes blocks</text>
  <rect x="20" y="290" width="130" height="80" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="85" y="324" text-anchor="middle" class="d-actor-label" font-size="12">Studio Desktop</text>
  <text x="85" y="341" text-anchor="middle" class="d-label-muted" font-size="9">still polls every 30 s</text>
  <g data-fail-toggle="blk2">
    <rect x="300" y="30" width="180" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="390" y="64" text-anchor="middle" class="d-actor-label" font-size="12">Block Servers</text>
    <text x="390" y="82" text-anchor="middle" class="d-label-muted" font-size="9">put / get 4 MB blocks</text>
    <text x="390" y="97" text-anchor="middle" class="d-label-muted" font-size="9">check hash on arrival</text>
  </g>
  <g data-fail-toggle="meta2">
    <rect x="300" y="155" width="180" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="390" y="189" text-anchor="middle" class="d-actor-label" font-size="12">Metadata Service</text>
    <text x="390" y="207" text-anchor="middle" class="d-label-muted" font-size="9">which blocks are needed?</text>
    <text x="390" y="222" text-anchor="middle" class="d-label-muted" font-size="9">commit block lists</text>
  </g>
  <g data-fail-toggle="bs2">
    <rect x="630" y="30" width="210" height="90" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="735" y="64" text-anchor="middle" class="d-actor-label" font-size="12">Block Store</text>
    <text x="735" y="82" text-anchor="middle" class="d-label-muted" font-size="9">blocks by SHA-256</text>
    <text x="735" y="97" text-anchor="middle" class="d-label-muted" font-size="9">3 copies · who has each</text>
  </g>
  <g data-fail-toggle="mdb2">
    <rect x="630" y="155" width="210" height="90" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="735" y="189" text-anchor="middle" class="d-actor-label" font-size="12">Metadata Database</text>
    <text x="735" y="207" text-anchor="middle" class="d-label-muted" font-size="9">files · revisions</text>
    <text x="735" y="222" text-anchor="middle" class="d-label-muted" font-size="9">block list of each revision</text>
  </g>
  <line id="f2-t-b" x1="152" y1="52" x2="296" y2="52" class="d-msg d-request" data-depends-on="blk2" marker-end="url(#arrowF2)"></line>
  <line id="f2-b-t" x1="296" y1="84" x2="152" y2="84" class="d-msg d-response" data-depends-on="blk2" marker-end="url(#arrowF2r)"></line>
  <line id="f2-t-m" x1="152" y1="96" x2="296" y2="170" class="d-msg d-request" data-depends-on="meta2" marker-end="url(#arrowF2)"></line>
  <line id="f2-m-t" x1="296" y1="188" x2="152" y2="108" class="d-msg d-response" data-depends-on="meta2" marker-end="url(#arrowF2r)"></line>
  <line id="f2-bot-m" x1="152" y1="304" x2="296" y2="236" class="d-msg d-request" data-depends-on="meta2" marker-end="url(#arrowF2)"></line>
  <line id="f2-m-bot" x1="296" y1="222" x2="152" y2="292" class="d-msg d-response" data-depends-on="meta2" marker-end="url(#arrowF2r)"></line>
  <line id="f2-bot-b" x1="126" y1="288" x2="296" y2="104" class="d-msg d-request" data-depends-on="blk2" marker-end="url(#arrowF2)"></line>
  <line id="f2-b-bot" x1="296" y1="116" x2="142" y2="288" class="d-msg d-response" data-depends-on="blk2" marker-end="url(#arrowF2r)"></line>
  <line id="f2-m-b" x1="370" y1="153" x2="370" y2="124" class="d-msg d-request" data-depends-on="meta2 blk2" marker-end="url(#arrowF2)"></line>
  <line id="f2-b-m" x1="410" y1="124" x2="410" y2="153" class="d-msg d-response" data-depends-on="meta2 blk2" marker-end="url(#arrowF2r)"></line>
  <line id="f2-b-bs" x1="482" y1="58" x2="626" y2="58" class="d-msg d-request" data-depends-on="blk2 bs2" marker-end="url(#arrowF2)"></line>
  <line id="f2-bs-b" x1="626" y1="92" x2="482" y2="92" class="d-msg d-response" data-depends-on="blk2 bs2" marker-end="url(#arrowF2r)"></line>
  <line id="f2-m-db" x1="482" y1="182" x2="626" y2="182" class="d-msg d-request" data-depends-on="meta2 mdb2" marker-end="url(#arrowF2)"></line>
  <line id="f2-db-m" x1="626" y1="218" x2="482" y2="218" class="d-msg d-response" data-depends-on="meta2 mdb2" marker-end="url(#arrowF2r)"></line>
  <text x="430" y="392" text-anchor="middle" class="d-label-muted" font-size="10">play the first upload in blocks, then an edit to one layer, then a dropped upload and a copy</text>
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
{"id": "fl", "title": "Files", "rows": [["laptop", "—"], ["desktop", "—"], ["server", "—"]]},
{"id": "tx", "title": "Transfer", "rows": [["needed", "—"], ["uploaded", "—"]]}
],
"flows": [
{
"id": "blocks",
"label": "The first upload, in blocks",
"nodes": ["blk2", "meta2", "bs2", "mdb2"],
"steps": [
{"el": "f2-t-m", "payload": "brochure.psd · 30 hashes · which needed?", "set": {"fl.laptop": "brochure.psd · 30 blocks", "fl.desktop": "—", "fl.server": "—", "tx.needed": "—", "tx.uploaded": "—"}, "text": "Priya saves brochure.psd, 120 MB. The laptop cuts it into 30 blocks of 4 MB and hashes each one: 9f2c41e0…, 41ab07d3…, and so on. It sends the list of hashes before sending any bytes."},
{"el": "f2-m-b", "payload": "which does a_1182 have?", "text": "The metadata service asks the block servers which of the 30 Priya's account already has."},
{"el": "f2-b-m", "payload": "none", "ms": 3, "text": "None. It's a new file."},
{"el": "f2-m-t", "payload": "need all 30", "set": {"tx.needed": "30 of 30"}, "text": "The laptop is told to upload all 30."},
{"el": "f2-t-b", "payload": "PUT 30 blocks · 4 at a time", "set": {"tx.uploaded": "120 MB"}, "text": "It uploads them to the block servers, four at a time. Each block is a separate request. The block servers hash the bytes as they arrive, and refuse a block whose hash doesn't match its name."},
{"el": "f2-b-bs", "payload": "store 30 blocks · 3 copies", "text": "Each block is written to three machines in different zones, and recorded as uploaded by Priya's account."},
{"el": "f2-bs-b", "payload": "stored", "ms": 30, "text": "Stored."},
{"el": "f2-b-t", "payload": "30 × 201", "text": "Every block is confirmed."},
{"el": "f2-t-m", "payload": "commit brochure.psd · 30 hashes", "text": "Now the laptop commits the file: its folder, name, size and block list."},
{"el": "f2-m-b", "payload": "all 30 stored for a_1182?", "text": "The metadata service checks that every block is stored and that this account uploaded it or already has it."},
{"el": "f2-b-m", "payload": "yes", "ms": 3, "text": "All 30 are there."},
{"el": "f2-m-db", "payload": "insert brochure.psd rev 1 · block list", "text": "The file and its first revision go into the metadata database."},
{"el": "f2-db-m", "payload": "rev 1", "ms": 5, "set": {"fl.server": "brochure.psd rev 1"}, "text": "Committed."},
{"el": "f2-m-t", "payload": "committed · rev 1", "set": {"fl.laptop": "brochure.psd rev 1 ✓"}, "text": "Only now does the file exist on the server. Had the laptop died halfway through, there would be some stored blocks and no file, never a file with missing parts."}
]
},
{
"id": "edit",
"label": "An edit to one layer",
"nodes": ["blk2", "meta2", "bs2", "mdb2"],
"steps": [
{"el": "f2-t-m", "payload": "brochure.psd · 30 hashes · which needed?", "set": {"fl.laptop": "edited · blocks 7 and 8 changed", "fl.desktop": "brochure.psd rev 1", "fl.server": "brochure.psd rev 1", "tx.needed": "—", "tx.uploaded": "—"}, "text": "Priya edits one layer and saves. The laptop hashes the file again. 28 blocks hash exactly as before. Blocks 7 and 8 are different."},
{"el": "f2-m-b", "payload": "which does a_1182 have?", "text": "The metadata service asks which hashes the account already has."},
{"el": "f2-b-m", "payload": "28 of 30", "ms": 3, "text": "28 of them."},
{"el": "f2-m-t", "payload": "need 2", "set": {"tx.needed": "2 of 30"}, "text": "The laptop needs to upload two."},
{"el": "f2-t-b", "payload": "PUT 2 blocks · 8 MB", "set": {"tx.uploaded": "8 MB"}, "text": "8 MB instead of 120: about 3 seconds instead of 48."},
{"el": "f2-b-bs", "payload": "store 2 blocks", "text": "Stored like any others."},
{"el": "f2-bs-b", "payload": "stored", "ms": 30, "text": "Done."},
{"el": "f2-b-t", "payload": "2 × 201", "text": "Both confirmed."},
{"el": "f2-t-m", "payload": "commit rev 2 · 30 hashes", "text": "The laptop commits the new block list."},
{"el": "f2-m-b", "payload": "all 30 stored for a_1182?", "text": "Checked as before."},
{"el": "f2-b-m", "payload": "yes", "ms": 3, "text": "All there."},
{"el": "f2-m-db", "payload": "insert rev 2", "text": "Revision 2 is stored beside revision 1."},
{"el": "f2-db-m", "payload": "rev 2", "ms": 5, "set": {"fl.server": "brochure.psd rev 2", "fl.laptop": "brochure.psd rev 2 ✓"}, "text": "Revision 2 shares 28 blocks with revision 1, so keeping the old version costs 8 MB, not 120."},
{"el": "f2-bot-m", "payload": "list every file", "text": "The studio desktop still polls for a full listing every 30 seconds. On its next poll it sees that brochure.psd is at revision 2."},
{"el": "f2-m-bot", "payload": "brochure.psd rev 2 · 30 hashes", "text": "The listing includes the new block list."},
{"el": "f2-bot-b", "payload": "GET 2 blocks", "text": "The desktop already has 28 of those blocks on disk, in its copy of revision 1. It fetches only the two it lacks."},
{"el": "f2-b-bot", "payload": "8 MB", "set": {"fl.desktop": "brochure.psd rev 2"}, "text": "And rebuilds the file from the blocks it kept and the two it fetched. 8 MB up, 8 MB down."}
]
},
{
"id": "drop",
"label": "A dropped upload, then a copy",
"nodes": ["blk2", "meta2", "bs2", "mdb2"],
"steps": [
{"el": "f2-t-m", "payload": "walkthrough.mp4 · 150 hashes · which needed?", "set": {"fl.laptop": "walkthrough.mp4 · 600 MB", "fl.desktop": "—", "fl.server": "—", "tx.needed": "—", "tx.uploaded": "—"}, "text": "Priya exports a 600 MB video for a client: 150 blocks."},
{"el": "f2-m-b", "payload": "which does a_1182 have?", "text": "Checked."},
{"el": "f2-b-m", "payload": "none", "ms": 3, "text": "None."},
{"el": "f2-m-t", "payload": "need 150", "set": {"tx.needed": "150 of 150"}, "text": "All 150 are needed."},
{"el": "f2-t-b", "payload": "blocks 1–110 · 440 MB", "set": {"tx.uploaded": "440 MB"}, "text": "110 blocks in, the Wi-Fi drops."},
{"el": "f2-b-bs", "payload": "110 blocks stored", "text": "Every block that arrived whole is stored. The one in flight is discarded. Nothing has been committed, so no device sees half a video."},
{"el": "f2-bs-b", "payload": "stored", "ms": 30, "text": "The 110 are recorded against Priya's account."},
{"el": "f2-t-m", "payload": "150 hashes · which needed?", "text": "When the laptop is back online, it doesn't need to remember where it got to. It simply asks again."},
{"el": "f2-m-b", "payload": "which does a_1182 have?", "text": "The same question."},
{"el": "f2-b-m", "payload": "110 of 150", "ms": 3, "text": "A different answer."},
{"el": "f2-m-t", "payload": "need 40", "set": {"tx.needed": "40 of 150"}, "text": "Only 40 are left."},
{"el": "f2-t-b", "payload": "blocks 111–150 · 160 MB", "set": {"tx.uploaded": "440 + 160 MB"}, "text": "The laptop uploads the rest. Nothing was sent twice."},
{"el": "f2-t-m", "payload": "commit walkthrough.mp4", "text": "And commits."},
{"el": "f2-m-db", "payload": "insert rev 1", "text": "Stored."},
{"el": "f2-db-m", "payload": "rev 1", "ms": 5, "set": {"fl.server": "walkthrough.mp4 rev 1", "fl.laptop": "walkthrough.mp4 ✓"}, "text": "The video is on the server."},
{"el": "f2-t-m", "payload": "Deliverables/walkthrough.mp4 · same 150 hashes", "set": {"tx.needed": "—", "tx.uploaded": "—"}, "text": "Priya copies the video into the client's delivery folder. To the sync client, that's a new file whose 150 hashes are the same as the original's."},
{"el": "f2-m-b", "payload": "which does a_1182 have?", "text": "Checked."},
{"el": "f2-b-m", "payload": "all 150", "ms": 3, "set": {"tx.needed": "0 of 150"}, "text": "The account has every one."},
{"el": "f2-m-db", "payload": "insert new file · same block list", "text": "The new file is committed straight away."},
{"el": "f2-db-m", "payload": "rev 1", "ms": 5, "set": {"fl.server": "2 files · 600 MB stored once"}, "text": "Both files point at the same blocks. The copy was committed in milliseconds, sent no bytes, and takes no extra storage."}
]
}
]
}
</script>
<div class="diagram-caption">Devices cut files into 4 MB blocks named by their SHA-256 hash, ask which ones the account lacks, upload only those, and then commit the file's block list. Downloads fetch only the blocks a device doesn't already have.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="blk2">
<strong>If the block servers fail:</strong> no bytes move. Commits that need no new blocks, such as copies, renames and deletes, still go through. Uploads resume from the first missing block when they're back.
</div>
<div class="failure-impact is-hidden" data-component="meta2">
<strong>If the metadata service fails:</strong> nothing can be committed or listed. Devices keep working on their own copies. Blocks already uploaded stay stored and won't be sent again.
</div>
<div class="failure-impact is-hidden" data-component="bs2">
<strong>If a block store machine fails:</strong> its blocks still have two other copies, and are copied again to bring them back to three. Only losing all three copies of a block loses data, and they're in different zones.
</div>
<div class="failure-impact is-hidden" data-component="mdb2">
<strong>If the metadata database fails:</strong> the whole service stops: no commits and no listings. The blocks are safe, but without the metadata nobody knows which blocks make up which file. It needs a standby replica, and it's also one database for 500 billion files.
</div>
</div>

Bytes are no longer the problem. Finding changes is. The desktop still asks for a list of all 18,000 files every 30 seconds, even when nothing has changed, and a change can wait 30 seconds to be noticed. With 60 million devices online, that's 2 million full listings a second. And the metadata itself, 500 billion files and their revisions, is far too much for one database.

<!-- stage:3:3. Journals, Cursors, Notifications -->

## Stage 3 — Journals, Cursors and Notifications

- **Files live in namespaces.** Each account's root folder is a namespace: Priya's is `ns_1182`. Shared folders will be namespaces too, in Stage 4.
- **Each namespace has a journal.** Every commit appends an entry to its namespace's journal with the next journal ID: "4,512: brochure.psd is now at revision 9". The file row, the revision and the journal entry are written in one transaction ([Log-Based Systems](#/systems/log-based-systems)).
- **Metadata is sharded by namespace.** Each namespace lives entirely on one of about 2,000 database shards, so every commit is a transaction on a single shard ([Partitioning & Sharding](#/systems/partitioning-sharding)). Each shard has a standby in another zone.
- **Devices keep a cursor.** Each device remembers, for each namespace, the last journal entry it has applied. It asks for changes after its cursor and gets only those, however many files the namespace holds.
- **Notification servers hold one request from each online device.** The request names the device's namespaces and cursors, and stays open for up to 90 seconds. When a commit lands, the metadata service tells the notification servers the namespace's new journal head, and any device whose cursor is behind is answered "changed" ([Real-time Delivery](#/systems/realtime-delivery)).
- **A notification is a hint, never the data.** It carries no file details. The device reads the changes itself, from its own cursor. If a notification is lost, the next request the device holds is answered at once, because it names a cursor that's behind.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 400" width="860" height="400" role="img" aria-label="Priya's laptop uploads blocks and commits to the metadata service, which writes each commit and a journal entry to the namespace's metadata shard and tells notification servers; the studio desktop holds a request open at a notification server, then reads changes after its cursor from the metadata service and fetches blocks">
  <rect x="20" y="30" width="130" height="80" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="85" y="64" text-anchor="middle" class="d-actor-label" font-size="12">Priya's Laptop</text>
  <text x="85" y="81" text-anchor="middle" class="d-label-muted" font-size="9">uploads and commits</text>
  <rect x="20" y="290" width="130" height="80" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="85" y="324" text-anchor="middle" class="d-actor-label" font-size="12">Studio Desktop</text>
  <text x="85" y="341" text-anchor="middle" class="d-label-muted" font-size="9">cursor per namespace</text>
  <g data-fail-toggle="blk3">
    <rect x="300" y="30" width="180" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="390" y="64" text-anchor="middle" class="d-actor-label" font-size="12">Block Servers</text>
    <text x="390" y="82" text-anchor="middle" class="d-label-muted" font-size="9">as in Stage 2</text>
  </g>
  <g data-fail-toggle="meta3">
    <rect x="300" y="155" width="180" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="390" y="189" text-anchor="middle" class="d-actor-label" font-size="12">Metadata Service</text>
    <text x="390" y="207" text-anchor="middle" class="d-label-muted" font-size="9">commit + journal entry</text>
    <text x="390" y="222" text-anchor="middle" class="d-label-muted" font-size="9">changes after a cursor</text>
  </g>
  <g data-fail-toggle="ntf3">
    <rect x="300" y="290" width="180" height="80" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="390" y="324" text-anchor="middle" class="d-actor-label" font-size="12">Notification Servers</text>
    <text x="390" y="342" text-anchor="middle" class="d-label-muted" font-size="9">one held request per device</text>
  </g>
  <g data-fail-toggle="bs3">
    <rect x="630" y="30" width="210" height="90" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="735" y="64" text-anchor="middle" class="d-actor-label" font-size="12">Block Store</text>
    <text x="735" y="82" text-anchor="middle" class="d-label-muted" font-size="9">blocks by SHA-256 · 3 copies</text>
  </g>
  <g data-fail-toggle="sh3">
    <rect x="630" y="155" width="210" height="90" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="735" y="189" text-anchor="middle" class="d-actor-label" font-size="12">Metadata Shards</text>
    <text x="735" y="207" text-anchor="middle" class="d-label-muted" font-size="9">~2,000 · by namespace</text>
    <text x="735" y="222" text-anchor="middle" class="d-label-muted" font-size="9">files · revisions · journal</text>
  </g>
  <line id="f3-t-b" x1="152" y1="52" x2="296" y2="52" class="d-msg d-request" data-depends-on="blk3" marker-end="url(#arrowF3)"></line>
  <line id="f3-b-t" x1="296" y1="84" x2="152" y2="84" class="d-msg d-response" data-depends-on="blk3" marker-end="url(#arrowF3r)"></line>
  <line id="f3-t-m" x1="152" y1="96" x2="296" y2="170" class="d-msg d-request" data-depends-on="meta3" marker-end="url(#arrowF3)"></line>
  <line id="f3-m-t" x1="296" y1="188" x2="152" y2="108" class="d-msg d-response" data-depends-on="meta3" marker-end="url(#arrowF3r)"></line>
  <line id="f3-bot-m" x1="152" y1="304" x2="296" y2="236" class="d-msg d-request" data-depends-on="meta3" marker-end="url(#arrowF3)"></line>
  <line id="f3-m-bot" x1="296" y1="222" x2="152" y2="292" class="d-msg d-response" data-depends-on="meta3" marker-end="url(#arrowF3r)"></line>
  <line id="f3-bot-b" x1="126" y1="288" x2="296" y2="104" class="d-msg d-request" data-depends-on="blk3" marker-end="url(#arrowF3)"></line>
  <line id="f3-b-bot" x1="296" y1="116" x2="142" y2="288" class="d-msg d-response" data-depends-on="blk3" marker-end="url(#arrowF3r)"></line>
  <line id="f3-bot-n" x1="152" y1="322" x2="296" y2="322" class="d-msg d-request" data-depends-on="ntf3" marker-end="url(#arrowF3)"></line>
  <line id="f3-n-bot" x1="296" y1="350" x2="152" y2="350" class="d-msg d-response" data-depends-on="ntf3" marker-end="url(#arrowF3r)"></line>
  <line id="f3-m-n" x1="370" y1="247" x2="370" y2="286" class="d-msg d-request" data-depends-on="meta3 ntf3" marker-end="url(#arrowF3)"></line>
  <line id="f3-n-m" x1="410" y1="286" x2="410" y2="247" class="d-msg d-request" data-depends-on="meta3 ntf3" marker-end="url(#arrowF3)"></line>
  <line id="f3-b-bs" x1="482" y1="58" x2="626" y2="58" class="d-msg d-request" data-depends-on="blk3 bs3" marker-end="url(#arrowF3)"></line>
  <line id="f3-bs-b" x1="626" y1="92" x2="482" y2="92" class="d-msg d-response" data-depends-on="blk3 bs3" marker-end="url(#arrowF3r)"></line>
  <line id="f3-m-sh" x1="482" y1="182" x2="626" y2="182" class="d-msg d-request" data-depends-on="meta3 sh3" marker-end="url(#arrowF3)"></line>
  <line id="f3-sh-m" x1="626" y1="218" x2="482" y2="218" class="d-msg d-response" data-depends-on="meta3 sh3" marker-end="url(#arrowF3r)"></line>
  <text x="430" y="392" text-anchor="middle" class="d-label-muted" font-size="10">play a save reaching the desktop, then the desktop back after a week, then a notification that never arrives</text>
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
{"id": "ns", "title": "ns_1182 · Priya's files", "rows": [["journal head", "—"], ["shard", "—"]]},
{"id": "dk", "title": "Studio desktop", "rows": [["cursor", "—"], ["brochure.psd", "—"]]}
],
"flows": [
{
"id": "save",
"label": "A save reaches the desktop",
"nodes": ["blk3", "meta3", "ntf3", "bs3", "sh3"],
"steps": [
{"el": "f3-bot-n", "payload": "wait · ns_1182 @ 4,511", "set": {"ns.journal head": "4,511", "ns.shard": "md-0417", "dk.cursor": "4,511", "dk.brochure.psd": "rev 8"}, "text": "The studio desktop holds one request open at a notification server. It names the namespace it follows, ns_1182, and its cursor there, 4,511: the last journal entry it has applied."},
{"el": "f3-t-m", "payload": "brochure.psd · which needed?", "text": "On the laptop, Priya saves brochure.psd again. The laptop asks which blocks are needed, as in Stage 2."},
{"el": "f3-t-b", "payload": "PUT 2 blocks · 8 MB", "text": "It uploads the two that changed."},
{"el": "f3-t-m", "payload": "commit brochure.psd rev 9", "text": "Then commits."},
{"el": "f3-m-sh", "payload": "file row + rev 9 + journal 4,512", "text": "The metadata service finds ns_1182's shard, md-0417. In one transaction, it updates the file row, stores revision 9's block list, and appends journal entry 4,512: brochure.psd is now at revision 9."},
{"el": "f3-sh-m", "payload": "journal 4,512", "ms": 6, "set": {"ns.journal head": "4,512"}, "text": "Committed."},
{"el": "f3-m-t", "payload": "rev 9 · journal 4,512", "text": "The laptop moves its own cursor to 4,512. It made the change, so it has it already."},
{"el": "f3-m-n", "payload": "ns_1182 → 4,512", "ms": 1, "text": "The metadata service tells the notification servers that ns_1182 has moved to 4,512."},
{"el": "f3-n-bot", "payload": "changed: ns_1182", "ms": 1, "text": "The desktop's cursor is 4,511, so its held request is answered: something changed. That's all the message says."},
{"el": "f3-bot-m", "payload": "changes in ns_1182 after 4,511", "text": "The desktop asks for the changes after its cursor."},
{"el": "f3-m-sh", "payload": "journal > 4,511", "text": "A range read on the journal."},
{"el": "f3-sh-m", "payload": "1 entry", "ms": 3, "text": "One entry."},
{"el": "f3-m-bot", "payload": "4,512 · brochure.psd rev 9 · 30 hashes", "text": "It comes back with the file's new block list."},
{"el": "f3-bot-b", "payload": "GET 2 blocks", "text": "The desktop fetches the two blocks it lacks."},
{"el": "f3-b-bot", "payload": "8 MB", "set": {"dk.cursor": "4,512", "dk.brochure.psd": "rev 9"}, "text": "The desktop has revision 9 about a second after Priya saved, plus the 8 MB download. It holds a new request, now naming 4,512, and waits again."}
]
},
{
"id": "week",
"label": "The desktop back after a week",
"nodes": ["blk3", "meta3", "ntf3", "bs3", "sh3"],
"steps": [
{"el": "f3-bot-n", "payload": "wait · ns_1182 @ 4,120", "set": {"ns.journal head": "4,512", "ns.shard": "md-0417", "dk.cursor": "4,120 · off for a week", "dk.brochure.psd": "rev 2"}, "text": "The desktop was switched off for a week's holiday, while Priya kept working on the laptop. When it starts up, it holds a request naming the cursor it saved: 4,120."},
{"el": "f3-n-m", "payload": "journal head of ns_1182?", "text": "The notification server checks the namespace's current journal head."},
{"el": "f3-m-n", "payload": "4,512", "ms": 1, "text": "4,512."},
{"el": "f3-n-bot", "payload": "changed: ns_1182", "text": "The desktop is behind, so it's answered at once."},
{"el": "f3-bot-m", "payload": "changes after 4,120", "text": "It asks for everything after 4,120."},
{"el": "f3-m-sh", "payload": "journal > 4,120 · up to 2,000", "text": "The journal is read in pages of up to 2,000 entries."},
{"el": "f3-sh-m", "payload": "392 entries", "ms": 8, "text": "392 entries: 61 files changed, some of them several times."},
{"el": "f3-m-bot", "payload": "392 entries · cursor 4,512", "text": "Only the latest state of each file matters, so the desktop reduces them to 61 files to bring up to date. It didn't compare 18,000 files. It read what happened."},
{"el": "f3-bot-b", "payload": "GET 212 missing blocks", "text": "For each of the 61, it compares the new block list with the blocks already on disk, and fetches only the missing ones."},
{"el": "f3-b-bot", "payload": "640 MB", "set": {"dk.cursor": "4,512", "dk.brochure.psd": "rev 9"}, "text": "Caught up."}
]
},
{
"id": "lost",
"label": "A notification that never arrives",
"nodes": ["meta3", "ntf3", "sh3"],
"steps": [
{"el": "f3-bot-n", "payload": "wait · ns_1182 @ 4,512", "set": {"ns.journal head": "4,512", "ns.shard": "md-0417", "dk.cursor": "4,512", "dk.brochure.psd": "rev 9"}, "text": "The desktop is up to date and waiting."},
{"el": "f3-t-m", "payload": "commit brochure.psd rev 10", "text": "Priya saves again. The changed blocks are uploaded as usual, and the laptop commits."},
{"el": "f3-m-sh", "payload": "rev 10 + journal 4,513", "text": "One transaction on md-0417."},
{"el": "f3-sh-m", "payload": "journal 4,513", "ms": 6, "set": {"ns.journal head": "4,513"}, "text": "Committed."},
{"el": "f3-m-n", "payload": "ns_1182 → 4,513", "ms": 1, "text": "The metadata service tells the notification servers. At that moment, the one holding the desktop's request is restarting for a release. The message reaches nobody."},
{"el": "f3-bot-n", "payload": "reconnect · ns_1182 @ 4,512", "text": "The desktop's request was cut off by the restart. It reconnects to a different notification server, naming its cursor again."},
{"el": "f3-n-m", "payload": "journal head of ns_1182?", "text": "The new server checks the journal head."},
{"el": "f3-m-n", "payload": "4,513", "ms": 1, "text": "4,513."},
{"el": "f3-n-bot", "payload": "changed: ns_1182", "text": "The desktop is behind, so it's answered at once."},
{"el": "f3-bot-m", "payload": "changes after 4,512", "text": "It reads the changes after its cursor."},
{"el": "f3-m-sh", "payload": "journal > 4,512", "text": "Read from the journal."},
{"el": "f3-sh-m", "payload": "1 entry", "ms": 3, "text": "One entry."},
{"el": "f3-m-bot", "payload": "4,513 · brochure.psd rev 10", "set": {"dk.cursor": "4,513", "dk.brochure.psd": "rev 10"}, "text": "The desktop catches up a few seconds later than usual. Because each device reads the journal from its own cursor, a lost notification costs time, never a change. Even with no notification at all, the next 90-second renewal would have found it."}
]
}
]
}
</script>
<div class="diagram-caption">Every commit appends to its namespace's journal on that namespace's shard. Devices hold a request open at a notification server, and when told something changed, read the journal after their own cursor and fetch only the blocks they lack.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="blk3">
<strong>If the block servers fail:</strong> devices learn about changes but can't fetch the new blocks, and can't upload. Commits that need no new blocks still go through.
</div>
<div class="failure-impact is-hidden" data-component="meta3">
<strong>If the metadata service fails:</strong> nothing is committed and no changes are read. Its servers hold no state of their own, so devices are moved to the remaining ones and carry on from their cursors.
</div>
<div class="failure-impact is-hidden" data-component="ntf3">
<strong>If a notification server fails:</strong> its devices reconnect to others, naming their cursors, and any that are behind are answered at once. If every notification server is down, devices fall back to asking for changes every few minutes.
</div>
<div class="failure-impact is-hidden" data-component="bs3">
<strong>If a block store machine fails:</strong> its blocks are served from their other two copies and copied again.
</div>
<div class="failure-impact is-hidden" data-component="sh3">
<strong>If a metadata shard fails:</strong> the namespaces on it, about 1 in 2,000, can't commit or be read until its standby in another zone takes over, within about 30 seconds. Every other shard carries on.
</div>
</div>

Sync is now fast, and a device that has been away catches up by reading what happened. But every flow so far has had one person editing, on one device at a time. Priya now shares the Acme Launch folder with Sam, a copywriter on the project. On the train, offline, Priya rewrites the introduction of proposal.docx while Sam edits its pricing in the office. Whichever commits last overwrites the other. Sam renames a folder while Priya's laptop is editing a file inside it. And when someone deletes a folder by mistake, the delete syncs to everyone as faithfully as any edit.

<!-- stage:4:4. Sharing and Conflicts -->

## Stage 4 — Sharing, Conflicts and Mistakes

- **A shared folder is its own namespace.** Acme Launch becomes `ns_9001`, with its own journal, mounted at `/Acme Launch` in both Priya's and Sam's accounts. Each device follows a cursor for every namespace it mounts, and its held request names them all.
- **Every commit names its parent revision.** The device says which revision its edit started from, and the metadata service updates the file only if it's still at that revision. If someone else's commit got there first, this one is refused with `409` ([Consistency Models](#/systems/consistency-cap)).
- **A conflict keeps both versions.** The device whose commit was refused downloads the version that won, puts it at the file's path, and commits its own as a new file beside it: `proposal (Priya's conflicted copy 2026-10-28).docx`. The service never decides whose work matters more. People do.
- **Files and folders have permanent IDs.** A file's row holds its folder's ID and its own name. The path is worked out from them, not stored. Renaming or moving a folder changes one row, however many files are inside, and an edit names the file by ID, so it lands wherever the file is now.
- **A delete is a tombstone.** The file's row is marked deleted, as a new revision, and every revision is kept for 30 days. Restoring commits a new revision whose block list is the one the file had before. The blocks were never removed, so nothing is uploaded.
- **The device remembers what it last synced.** For every file, it keeps the revision and hashes it last agreed with the server. That base is how it tells an edit made here from one made elsewhere, and both from a conflict ([Offline & Resilience](#/systems/offline-resilience)).

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 400" width="860" height="400" role="img" aria-label="Priya's laptop and Sam's laptop both mount the shared namespace ns_9001; commits name their parent revision and the metadata service writes them to the namespace's shard only if the file is still at that revision; Sam's laptop hears about changes through notification servers and fetches blocks from the block servers">
  <rect x="20" y="30" width="130" height="80" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="85" y="64" text-anchor="middle" class="d-actor-label" font-size="12">Priya's Laptop</text>
  <text x="85" y="81" text-anchor="middle" class="d-label-muted" font-size="9">commits name parent rev</text>
  <rect x="20" y="290" width="130" height="80" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="85" y="324" text-anchor="middle" class="d-actor-label" font-size="12">Sam's Laptop</text>
  <text x="85" y="341" text-anchor="middle" class="d-label-muted" font-size="9">mounts ns_9001 too</text>
  <g data-fail-toggle="blk4">
    <rect x="300" y="30" width="180" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="390" y="64" text-anchor="middle" class="d-actor-label" font-size="12">Block Servers</text>
    <text x="390" y="82" text-anchor="middle" class="d-label-muted" font-size="9">as in Stage 2</text>
  </g>
  <g data-fail-toggle="meta4">
    <rect x="300" y="155" width="180" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="390" y="189" text-anchor="middle" class="d-actor-label" font-size="12">Metadata Service</text>
    <text x="390" y="207" text-anchor="middle" class="d-label-muted" font-size="9">commit only if rev = parent</text>
    <text x="390" y="222" text-anchor="middle" class="d-label-muted" font-size="9">files named by ID</text>
  </g>
  <g data-fail-toggle="ntf4">
    <rect x="300" y="290" width="180" height="80" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="390" y="324" text-anchor="middle" class="d-actor-label" font-size="12">Notification Servers</text>
    <text x="390" y="342" text-anchor="middle" class="d-label-muted" font-size="9">ns_1182, ns_9001, …</text>
  </g>
  <g data-fail-toggle="bs4">
    <rect x="630" y="30" width="210" height="90" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="735" y="64" text-anchor="middle" class="d-actor-label" font-size="12">Block Store</text>
    <text x="735" y="82" text-anchor="middle" class="d-label-muted" font-size="9">old revisions' blocks kept</text>
  </g>
  <g data-fail-toggle="sh4">
    <rect x="630" y="155" width="210" height="90" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="735" y="189" text-anchor="middle" class="d-actor-label" font-size="12">Metadata Shards</text>
    <text x="735" y="207" text-anchor="middle" class="d-label-muted" font-size="9">files by ID · tombstones</text>
    <text x="735" y="222" text-anchor="middle" class="d-label-muted" font-size="9">revisions kept 30 days</text>
  </g>
  <line id="f4-t-b" x1="152" y1="52" x2="296" y2="52" class="d-msg d-request" data-depends-on="blk4" marker-end="url(#arrowF4)"></line>
  <line id="f4-b-t" x1="296" y1="84" x2="152" y2="84" class="d-msg d-response" data-depends-on="blk4" marker-end="url(#arrowF4r)"></line>
  <line id="f4-t-m" x1="152" y1="96" x2="296" y2="170" class="d-msg d-request" data-depends-on="meta4" marker-end="url(#arrowF4)"></line>
  <line id="f4-m-t" x1="296" y1="188" x2="152" y2="108" class="d-msg d-response" data-depends-on="meta4" marker-end="url(#arrowF4r)"></line>
  <line id="f4-bot-m" x1="152" y1="304" x2="296" y2="236" class="d-msg d-request" data-depends-on="meta4" marker-end="url(#arrowF4)"></line>
  <line id="f4-m-bot" x1="296" y1="222" x2="152" y2="292" class="d-msg d-response" data-depends-on="meta4" marker-end="url(#arrowF4r)"></line>
  <line id="f4-bot-b" x1="126" y1="288" x2="296" y2="104" class="d-msg d-request" data-depends-on="blk4" marker-end="url(#arrowF4)"></line>
  <line id="f4-b-bot" x1="296" y1="116" x2="142" y2="288" class="d-msg d-response" data-depends-on="blk4" marker-end="url(#arrowF4r)"></line>
  <line id="f4-bot-n" x1="152" y1="322" x2="296" y2="322" class="d-msg d-request" data-depends-on="ntf4" marker-end="url(#arrowF4)"></line>
  <line id="f4-n-bot" x1="296" y1="350" x2="152" y2="350" class="d-msg d-response" data-depends-on="ntf4" marker-end="url(#arrowF4r)"></line>
  <line id="f4-m-n" x1="370" y1="247" x2="370" y2="286" class="d-msg d-request" data-depends-on="meta4 ntf4" marker-end="url(#arrowF4)"></line>
  <line id="f4-b-bs" x1="482" y1="58" x2="626" y2="58" class="d-msg d-request" data-depends-on="blk4 bs4" marker-end="url(#arrowF4)"></line>
  <line id="f4-bs-b" x1="626" y1="92" x2="482" y2="92" class="d-msg d-response" data-depends-on="blk4 bs4" marker-end="url(#arrowF4r)"></line>
  <line id="f4-m-sh" x1="482" y1="182" x2="626" y2="182" class="d-msg d-request" data-depends-on="meta4 sh4" marker-end="url(#arrowF4)"></line>
  <line id="f4-sh-m" x1="626" y1="218" x2="482" y2="218" class="d-msg d-response" data-depends-on="meta4 sh4" marker-end="url(#arrowF4r)"></line>
  <text x="430" y="392" text-anchor="middle" class="d-label-muted" font-size="10">play two edits to one file, then a rename during an edit, then restoring a deleted folder</text>
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
{"id": "sv", "title": "ns_9001 · Acme Launch", "rows": [["file", "—"], ["note", "—"]]},
{"id": "lp", "title": "Laptops", "rows": [["Priya", "—"], ["Sam", "—"]]}
],
"flows": [
{
"id": "conflict",
"label": "Two edits to one file",
"nodes": ["blk4", "meta4", "ntf4", "sh4"],
"steps": [
{"el": "f4-bot-m", "payload": "commit proposal.docx · parent rev 4", "set": {"sv.file": "proposal.docx rev 4", "sv.note": "—", "lp.Priya": "offline · edited from rev 4", "lp.Sam": "edited from rev 4"}, "text": "Priya and Sam share Acme Launch, namespace ns_9001. On the train, with no signal, Priya rewrites the introduction of proposal.docx, which was at revision 4. In the office, Sam edits the pricing section of the same file and saves first. Sam's commit says the edit started from revision 4."},
{"el": "f4-m-sh", "payload": "UPDATE … WHERE rev = 4 · journal 771", "text": "The file is still at revision 4, so the update goes through."},
{"el": "f4-sh-m", "payload": "rev 5", "ms": 6, "set": {"sv.file": "proposal.docx rev 5 · Sam's"}, "text": "Revision 5 is Sam's."},
{"el": "f4-m-bot", "payload": "committed · rev 5", "set": {"lp.Sam": "rev 5 ✓"}, "text": "Sam's laptop is told."},
{"el": "f4-t-m", "payload": "commit proposal.docx · parent rev 4", "text": "An hour later Priya's laptop is back online. Its blocks are uploaded, and its commit also says the edit started from revision 4."},
{"el": "f4-m-sh", "payload": "UPDATE … WHERE rev = 4", "text": "The same condition."},
{"el": "f4-sh-m", "payload": "0 rows · file is at rev 5", "ms": 6, "text": "The file has moved on."},
{"el": "f4-m-t", "payload": "409 · conflict · current rev 5", "set": {"lp.Priya": "conflict"}, "text": "The commit is refused. Without the condition, Priya's version would have replaced Sam's, and Sam's pricing changes would have vanished without anyone being told."},
{"el": "f4-t-b", "payload": "GET rev 5's blocks", "text": "The laptop downloads Sam's revision and puts it at proposal.docx."},
{"el": "f4-b-t", "payload": "blocks", "text": "Sam's version is now at the file's path on Priya's laptop."},
{"el": "f4-t-m", "payload": "new file · proposal (Priya's conflicted copy 2026-10-28).docx", "text": "Priya's own version is renamed and committed as a new file beside it. Its blocks are already uploaded, so this is just a commit."},
{"el": "f4-m-sh", "payload": "insert file · journal 772", "text": "A new file in ns_9001."},
{"el": "f4-sh-m", "payload": "journal 772", "ms": 6, "set": {"sv.note": "2 files: Sam's rev 5 + Priya's copy"}, "text": "Committed."},
{"el": "f4-m-n", "payload": "ns_9001 → 772", "ms": 1, "text": "The notification servers are told."},
{"el": "f4-n-bot", "payload": "changed: ns_9001", "text": "Sam's laptop is behind."},
{"el": "f4-bot-m", "payload": "changes after 771", "text": "It reads the change."},
{"el": "f4-m-bot", "payload": "772 · conflicted copy", "set": {"lp.Priya": "both files", "lp.Sam": "both files"}, "text": "Both laptops show both files. The service doesn't guess whose edit matters more. It keeps both, and Priya and Sam merge them."}
]
},
{
"id": "rename",
"label": "A rename during an edit",
"nodes": ["meta4", "ntf4", "sh4"],
"steps": [
{"el": "f4-bot-m", "payload": "rename fd_310 · Drafts → Drafts (old)", "set": {"sv.file": "Drafts/notes.txt rev 2", "sv.note": "—", "lp.Priya": "offline · editing notes.txt", "lp.Sam": "renaming Drafts"}, "text": "Sam renames the Drafts folder, 340 files, to “Drafts (old)”. Priya's laptop, offline again, has notes.txt from that folder open and is editing it."},
{"el": "f4-m-sh", "payload": "1 row · fd_310's name · journal 780", "text": "Each file's row points at its folder by ID, not by path. Renaming the folder changes one row, and adds one journal entry, however many files are inside."},
{"el": "f4-sh-m", "payload": "journal 780", "ms": 6, "set": {"sv.file": "Drafts (old)/notes.txt rev 2"}, "text": "Committed."},
{"el": "f4-m-bot", "payload": "committed", "set": {"lp.Sam": "Drafts (old) ✓"}, "text": "Sam's laptop is told."},
{"el": "f4-t-m", "payload": "commit f_3301 · parent rev 2", "text": "Priya's laptop comes back online and commits the edit. It names the file by its ID, f_3301, not by its path."},
{"el": "f4-m-sh", "payload": "UPDATE f_3301 WHERE rev = 2", "text": "The file is still at revision 2. The rename changed its folder's name, not the file."},
{"el": "f4-sh-m", "payload": "rev 3 · journal 781", "ms": 6, "set": {"sv.file": "Drafts (old)/notes.txt rev 3", "sv.note": "the edit followed the file"}, "text": "Committed."},
{"el": "f4-m-t", "payload": "rev 3 · then entry 780", "set": {"lp.Priya": "Drafts (old)/notes.txt"}, "text": "When the laptop reads the journal, it applies Sam's rename to its own folder too."},
{"el": "f4-m-n", "payload": "ns_9001 → 781", "ms": 1, "text": "The notification servers are told."},
{"el": "f4-n-bot", "payload": "changed: ns_9001", "text": "Sam's laptop is behind."},
{"el": "f4-bot-m", "payload": "changes after 780", "text": "It reads the edit."},
{"el": "f4-m-bot", "payload": "781 · f_3301 rev 3", "set": {"lp.Sam": "Drafts (old)/notes.txt rev 3"}, "text": "The edit lands in “Drafts (old)”, where the file is now. Had files been named by path, the commit for Drafts/notes.txt would have made a new Drafts folder with one file in it, and the rename would have meant 340 separate moves."}
]
},
{
"id": "restore",
"label": "Restoring a deleted folder",
"nodes": ["blk4", "meta4", "ntf4", "bs4", "sh4"],
"steps": [
{"el": "f4-t-m", "payload": "delete fd_412 · Photos", "set": {"sv.file": "Photos · 2,300 files · 9 GB", "sv.note": "—", "lp.Priya": "deleting a folder", "lp.Sam": "Photos ✓"}, "text": "Tidying up, Priya deletes the Photos folder in Acme Launch, meaning to delete an older copy of it: 2,300 photos, 9 GB."},
{"el": "f4-m-sh", "payload": "2,300 tombstones · journal 790", "text": "Nothing is erased. Each file's row is marked deleted, as a new revision, and the journal records the delete."},
{"el": "f4-sh-m", "payload": "journal 790", "ms": 40, "set": {"sv.file": "Photos · deleted"}, "text": "Committed."},
{"el": "f4-m-n", "payload": "ns_9001 → 790", "ms": 1, "text": "The notification servers are told."},
{"el": "f4-n-bot", "payload": "changed: ns_9001", "text": "Sam's laptop is behind."},
{"el": "f4-bot-m", "payload": "changes after 789", "text": "It reads the delete."},
{"el": "f4-m-bot", "payload": "790 · Photos deleted", "set": {"lp.Sam": "Photos gone"}, "text": "Sam's laptop applies it, moving the files to the computer's own trash. The folder is gone from both laptops."},
{"el": "f4-t-m", "payload": "restore fd_412 as of 10:41", "text": "Ten minutes later Priya notices, and restores the folder from the web, as it was at 10:41."},
{"el": "f4-m-sh", "payload": "2,300 new revisions · old block lists · journal 791", "text": "Each file gets a new revision whose block list is the one it had before the delete. Revisions are kept for 30 days, and so are the blocks they use, so nothing has to be uploaded."},
{"el": "f4-sh-m", "payload": "journal 791", "ms": 60, "set": {"sv.file": "Photos · restored", "sv.note": "0 bytes uploaded"}, "text": "The folder is back on the server, in about a second."},
{"el": "f4-m-n", "payload": "ns_9001 → 791", "ms": 1, "text": "The notification servers are told."},
{"el": "f4-n-bot", "payload": "changed: ns_9001", "text": "Sam's laptop is behind again."},
{"el": "f4-bot-m", "payload": "changes after 790", "text": "It reads the restore."},
{"el": "f4-m-bot", "payload": "791 · 2,300 files", "text": "2,300 files, each with a block list."},
{"el": "f4-bot-b", "payload": "GET blocks not in local trash", "text": "Most of the blocks are still in the laptop's trash, and are taken from there. It downloads the rest."},
{"el": "f4-b-bot", "payload": "blocks", "set": {"lp.Priya": "Photos ✓", "lp.Sam": "Photos ✓"}, "text": "The folder is back everywhere. A delete is just another revision, and so is undoing it."}
]
}
]
}
</script>
<div class="diagram-caption">A shared folder is a namespace mounted in each member's account. Commits name their parent revision and succeed only if the file is still there, so a conflict keeps both versions. Files are named by ID, and deletes are revisions that can be restored for 30 days.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="blk4">
<strong>If the block servers fail:</strong> new versions can't be uploaded or fetched. Renames, deletes and restores still work, because they only commit block lists that already exist.
</div>
<div class="failure-impact is-hidden" data-component="meta4">
<strong>If the metadata service fails:</strong> nothing commits. Both laptops keep editing locally and keep their base. When it's back, every commit is checked against its parent revision as usual, so edits made during the outage are either applied or kept as conflicted copies, never overwritten.
</div>
<div class="failure-impact is-hidden" data-component="ntf4">
<strong>If the notification servers fail:</strong> Sam's laptop hears about Priya's changes late, at its next check. Nothing is lost, and a commit made from an out-of-date copy is refused and kept as a conflicted copy.
</div>
<div class="failure-impact is-hidden" data-component="bs4">
<strong>If a block store machine fails:</strong> blocks are served from their other copies, including the blocks of old revisions that restores depend on.
</div>
<div class="failure-impact is-hidden" data-component="sh4">
<strong>If ns_9001's shard fails:</strong> both Priya and Sam stop syncing Acme Launch until the standby takes over, while each of their own root namespaces, on other shards, keeps syncing.
</div>
</div>

For a team, this is a complete service. Then Northwind, a company of 2,000 people, moves its shared drive onto it. All Company is one namespace, `ns_20417`, mounted on 4,000 laptops and desktops. When someone in HR updates the holiday calendar, the metadata service sends 4,000 notifications, and 4,000 devices ask the same shard for the same journal entry within a second. When IT drops a 2 GB installer into the folder, 4,000 devices download it: 8 TB from the block store, 1.2 TB of it through the New York office's single internet connection. And underneath all of it, 600 PB kept in three copies is 1.8 EB of disk, most of it holding files nobody has opened in a year.

<!-- stage:5:5. A Company on One Folder -->

## Stage 5 — A Company on One Folder

- **Notification servers subscribe once per namespace.** Each notification server tells the metadata service which namespaces its devices follow. A commit sends one message to each subscribed server, and each server answers its own devices. 4,000 devices on 30 servers means 30 messages.
- **Busy namespaces' recent changes are kept in memory.** The metadata service holds the last 1,000 journal entries of any namespace followed by more than 500 devices. Their change-list reads are answered from memory, and devices are told to wait a random moment of up to 2 seconds before asking, so the reads arrive spread out ([Caching](#/systems/caching)).
- **Each region caches popular blocks.** Block servers keep recently read blocks on local SSDs. A block is read from the block store once per region, then served from the cache. A block never changes, so a cached copy is never stale ([CDNs & Edge Delivery](#/systems/cdn-edge-delivery)).
- **Devices on the same network share blocks.** Devices find each other on the local network and say which namespaces they mount. Before downloading a block, a device asks the others. It checks the hash of whatever it receives, so a peer can't hand over the wrong bytes, and a peer answers only for namespaces both devices mount.
- **Blocks nobody reads move to cold storage.** A nightly job moves blocks that haven't been read for 90 days to a cold store, about 80% of all bytes. There each block is split into 6 data fragments and 3 parity fragments, three in each of three zones. Any 6 rebuild it, so a whole zone can be lost. That costs 1.5 times the data instead of 3 ([Storage Engines](#/systems/storage-engines)).

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 880 420" width="880" height="420" role="img" aria-label="4,000 devices hold requests at notification servers, read changes from a metadata service that keeps busy namespaces' recent changes in memory, and fetch blocks from block servers with a regional cache; devices in an office share blocks with each other over the local network; blocks live in a hot store with three copies and move to an erasure-coded cold store when unread for 90 days">
  <rect x="20" y="40" width="140" height="80" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="74" text-anchor="middle" class="d-actor-label" font-size="12">Devices</text>
  <text x="90" y="91" text-anchor="middle" class="d-label-muted" font-size="9">4,000 mount All Company</text>
  <rect x="20" y="300" width="140" height="80" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="334" text-anchor="middle" class="d-actor-label" font-size="12">Office LAN Peers</text>
  <text x="90" y="351" text-anchor="middle" class="d-label-muted" font-size="9">600 devices · New York</text>
  <g data-fail-toggle="ntf5">
    <rect x="320" y="30" width="180" height="80" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="410" y="64" text-anchor="middle" class="d-actor-label" font-size="12">Notification Servers</text>
    <text x="410" y="82" text-anchor="middle" class="d-label-muted" font-size="9">subscribe once per namespace</text>
  </g>
  <g data-fail-toggle="meta5">
    <rect x="320" y="165" width="180" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="410" y="199" text-anchor="middle" class="d-actor-label" font-size="12">Metadata Service</text>
    <text x="410" y="217" text-anchor="middle" class="d-label-muted" font-size="9">busy namespaces' recent</text>
    <text x="410" y="232" text-anchor="middle" class="d-label-muted" font-size="9">changes in memory</text>
  </g>
  <g data-fail-toggle="blk5">
    <rect x="320" y="300" width="180" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="410" y="334" text-anchor="middle" class="d-actor-label" font-size="12">Block Servers</text>
    <text x="410" y="352" text-anchor="middle" class="d-label-muted" font-size="9">regional block cache</text>
  </g>
  <g data-fail-toggle="sh5">
    <rect x="660" y="30" width="200" height="80" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="760" y="64" text-anchor="middle" class="d-actor-label" font-size="12">Metadata Shards</text>
    <text x="760" y="82" text-anchor="middle" class="d-label-muted" font-size="9">by namespace</text>
  </g>
  <g data-fail-toggle="hot5">
    <rect x="660" y="165" width="200" height="90" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="760" y="199" text-anchor="middle" class="d-actor-label" font-size="12">Hot Block Store</text>
    <text x="760" y="217" text-anchor="middle" class="d-label-muted" font-size="9">3 copies</text>
    <text x="760" y="232" text-anchor="middle" class="d-label-muted" font-size="9">read in the last 90 days</text>
  </g>
  <g data-fail-toggle="cold5">
    <rect x="660" y="300" width="200" height="90" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="760" y="334" text-anchor="middle" class="d-actor-label" font-size="12">Cold Block Store</text>
    <text x="760" y="352" text-anchor="middle" class="d-label-muted" font-size="9">6 + 3 fragments · 1.5×</text>
  </g>
  <line id="f5-d-n" x1="162" y1="60" x2="316" y2="60" class="d-msg d-request" data-depends-on="ntf5" marker-end="url(#arrowF5)"></line>
  <line id="f5-n-d" x1="316" y1="90" x2="162" y2="90" class="d-msg d-response" data-depends-on="ntf5" marker-end="url(#arrowF5r)"></line>
  <line id="f5-d-m" x1="162" y1="108" x2="316" y2="190" class="d-msg d-request" data-depends-on="meta5" marker-end="url(#arrowF5)"></line>
  <line id="f5-m-d" x1="316" y1="210" x2="162" y2="118" class="d-msg d-response" data-depends-on="meta5" marker-end="url(#arrowF5r)"></line>
  <line id="f5-d-b" x1="130" y1="122" x2="316" y2="318" class="d-msg d-request" data-depends-on="blk5" marker-end="url(#arrowF5)"></line>
  <line id="f5-b-d" x1="316" y1="338" x2="146" y2="122" class="d-msg d-response" data-depends-on="blk5" marker-end="url(#arrowF5r)"></line>
  <line id="f5-d-p" x1="60" y1="122" x2="60" y2="296" class="d-msg d-request" marker-end="url(#arrowF5)"></line>
  <line id="f5-p-d" x1="100" y1="296" x2="100" y2="122" class="d-msg d-response" marker-end="url(#arrowF5r)"></line>
  <line id="f5-m-n" x1="410" y1="163" x2="410" y2="114" class="d-msg d-request" data-depends-on="meta5 ntf5" marker-end="url(#arrowF5)"></line>
  <line id="f5-m-sh" x1="502" y1="180" x2="656" y2="92" class="d-msg d-request" data-depends-on="meta5 sh5" marker-end="url(#arrowF5)"></line>
  <line id="f5-sh-m" x1="656" y1="106" x2="502" y2="196" class="d-msg d-response" data-depends-on="meta5 sh5" marker-end="url(#arrowF5r)"></line>
  <line id="f5-b-hot" x1="502" y1="310" x2="656" y2="238" class="d-msg d-request" data-depends-on="blk5 hot5" marker-end="url(#arrowF5)"></line>
  <line id="f5-hot-b" x1="656" y1="252" x2="502" y2="324" class="d-msg d-response" data-depends-on="blk5 hot5" marker-end="url(#arrowF5r)"></line>
  <line id="f5-b-cold" x1="502" y1="334" x2="656" y2="334" class="d-msg d-request" data-depends-on="blk5 cold5" marker-end="url(#arrowF5)"></line>
  <line id="f5-cold-b" x1="656" y1="364" x2="502" y2="364" class="d-msg d-response" data-depends-on="blk5 cold5" marker-end="url(#arrowF5r)"></line>
  <line id="f5-hot-cold" x1="760" y1="257" x2="760" y2="296" class="d-msg d-request" data-depends-on="hot5 cold5" marker-end="url(#arrowF5)"></line>
  <text x="440" y="410" text-anchor="middle" class="d-label-muted" font-size="10">play one change in the All Company folder, then 4,000 devices downloading one installer, then a photo from 2019</text>
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
{"id": "ns", "title": "ns_20417 · All Company", "rows": [["devices", "—"], ["journal head", "—"]]},
{"id": "ld", "title": "Load", "rows": [["shard reads", "—"], ["block store reads", "—"], ["office link", "—"]]}
],
"flows": [
{
"id": "change",
"label": "One change in All Company",
"nodes": ["ntf5", "meta5", "blk5", "sh5", "hot5"],
"steps": [
{"el": "f5-d-m", "payload": "commit holiday-calendar.pdf rev 12", "set": {"ns.devices": "4,000 · on 30 notification servers", "ns.journal head": "88,213", "ld.shard reads": "—", "ld.block store reads": "—", "ld.office link": "—"}, "text": "Northwind's shared drive, All Company, is one namespace, ns_20417, mounted on 4,000 devices. Someone in HR updates holiday-calendar.pdf, and the new block is uploaded as usual."},
{"el": "f5-m-sh", "payload": "file + journal 88,214", "text": "The commit is one transaction on the namespace's shard."},
{"el": "f5-sh-m", "payload": "journal 88,214", "ms": 6, "set": {"ns.journal head": "88,214"}, "text": "Committed. The metadata service keeps the entry in memory too, because more than 500 devices follow this namespace."},
{"el": "f5-m-n", "payload": "ns_20417 → 88,214 · 30 messages", "ms": 1, "text": "The 30 notification servers holding those 4,000 devices each subscribed to ns_20417 once. The metadata service sends 30 messages, not 4,000."},
{"el": "f5-n-d", "payload": "changed · wait up to 2 s", "text": "Each server answers its own devices. Because thousands follow this namespace, each device is told to wait a random moment of up to 2 seconds before asking for the change."},
{"el": "f5-d-m", "payload": "changes after 88,213 · 4,000 over 2 s", "text": "The requests arrive at about 2,000 a second instead of 4,000 at once."},
{"el": "f5-m-d", "payload": "entry 88,214 · from memory", "ms": 1, "set": {"ld.shard reads": "0 for 4,000 reads"}, "text": "All 4,000 are answered from memory. The shard was written once and isn't read at all."},
{"el": "f5-d-b", "payload": "GET 1 block · 4,000 times", "text": "Every device fetches the one changed block."},
{"el": "f5-b-hot", "payload": "first request in the region", "text": "The first request in each region misses the block servers' cache and reads the block store."},
{"el": "f5-hot-b", "payload": "1 block", "ms": 20, "set": {"ld.block store reads": "1 per region"}, "text": "The block goes into the regional cache."},
{"el": "f5-b-d", "payload": "from the regional cache", "text": "Every later request in that region is served from the cache. 4,000 devices have the new calendar within a few seconds, and the shard and the block store barely noticed."}
]
},
{
"id": "installer",
"label": "4,000 devices, one 2 GB installer",
"nodes": ["blk5", "hot5"],
"steps": [
{"el": "f5-d-b", "payload": "GET 512 blocks · first device in us-east", "set": {"ns.devices": "4,000", "ns.journal head": "88,301", "ld.shard reads": "—", "ld.block store reads": "—", "ld.office link": "—"}, "text": "IT puts a 2 GB installer into All Company: 512 blocks. Every one of the 4,000 devices will download it, 8 TB in all. The first device in the region asks for the blocks."},
{"el": "f5-b-hot", "payload": "read 512 blocks", "text": "They aren't cached yet, so the block servers read them from the block store."},
{"el": "f5-hot-b", "payload": "2 GB", "ms": 40, "set": {"ld.block store reads": "2 GB, once per region"}, "text": "The block store is read once."},
{"el": "f5-b-d", "payload": "2 GB · now cached", "text": "Every later download in the region is served from the cache."},
{"el": "f5-d-p", "payload": "who here has these blocks?", "text": "In the New York office, 600 devices share one 1 Gbps internet connection. 1.2 TB through it would take almost 3 hours at full speed, and nothing else would get through. So before downloading a block, each device asks the devices on its own network."},
{"el": "f5-p-d", "payload": "blocks from a peer · hashes checked", "set": {"ld.office link": "~2 GB, not 1.2 TB"}, "text": "The first devices in the office downloaded the blocks, and the rest get them from those, and then from each other, over the office network. Every block is hashed on arrival, so a peer can't hand over anything but the real block."},
{"el": "f5-d-b", "payload": "home workers and small offices", "text": "Devices with no peer nearby download from the block servers."},
{"el": "f5-b-d", "payload": "from the regional cache", "text": "From the regional cache. Of 8 TB downloaded, the block store served 2 GB per region."}
]
},
{
"id": "cold",
"label": "A photo from 2019",
"nodes": ["blk5", "hot5", "cold5"],
"steps": [
{"el": "f5-hot-cold", "payload": "blocks unread for 90 days", "set": {"ns.devices": "—", "ns.journal head": "—", "ld.shard reads": "—", "ld.block store reads": "—", "ld.office link": "—"}, "text": "Every night a tiering job moves blocks nobody has read for 90 days to the cold store. Each is split into 6 data fragments and 3 parity fragments, three in each of three zones, and its hot copies are deleted. About 80% of all bytes are cold."},
{"el": "f5-d-b", "payload": "GET 3 blocks · site-visit-041.jpg", "text": "Priya opens a photo from a 2019 project: three blocks, last read four years ago."},
{"el": "f5-b-cold", "payload": "read 6 of 9 fragments", "text": "The block index says the blocks are cold. The block servers read fragments from the cold store, and need any 6 of each block's 9."},
{"el": "f5-cold-b", "payload": "rebuild 3 blocks", "ms": 180, "text": "They rebuild the blocks from the fragments. It takes about 150 ms longer than a hot read."},
{"el": "f5-b-d", "payload": "3 blocks", "text": "The photo opens a moment later than a recent one would."},
{"el": "f5-b-hot", "payload": "read again · back to hot", "set": {"ld.block store reads": "hot again for 90 days"}, "text": "Now that they've been read, the blocks are copied back to the hot store. Storing 80% of bytes at 1.5 times instead of 3 takes the 600 PB from 1.8 EB of disk to about 1.1 EB."}
]
}
]
}
</script>
<div class="diagram-caption">Notification servers subscribe once per namespace, the metadata service serves busy namespaces' recent changes from memory, and block servers cache popular blocks in each region. Devices in an office share blocks with each other, and blocks nobody reads move to an erasure-coded cold store.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="ntf5">
<strong>If a notification server fails:</strong> its devices reconnect to others, which subscribe to the namespaces those devices follow. Devices that were behind are answered at once and spread their reads over the next 2 seconds.
</div>
<div class="failure-impact is-hidden" data-component="meta5">
<strong>If a metadata server fails:</strong> its share of requests move to the others. The in-memory recent changes are rebuilt from the shards as busy namespaces are read again.
</div>
<div class="failure-impact is-hidden" data-component="blk5">
<strong>If a block server fails:</strong> its part of the regional cache is gone, and those blocks are read from the block store again until another server has cached them.
</div>
<div class="failure-impact is-hidden" data-component="sh5">
<strong>If All Company's shard fails:</strong> 4,000 devices stop syncing that one folder for up to 30 seconds while the standby takes over. Their own root namespaces, on other shards, keep syncing.
</div>
<div class="failure-impact is-hidden" data-component="hot5">
<strong>If a zone of the hot store fails:</strong> every hot block still has copies in the other two zones. They're copied again to bring each back to three.
</div>
<div class="failure-impact is-hidden" data-component="cold5">
<strong>If a zone of the cold store fails:</strong> each block loses 3 of its 9 fragments and is rebuilt from the other 6, more slowly. Fragments are rebuilt in the remaining zones before a second failure could matter.
</div>
</div>

This is the full design. Devices cut files into 4 MB blocks named by their SHA-256 hash, upload only the blocks their account doesn't already have, and commit a file's block list only once every block is stored. Metadata lives in namespaces, one per account and one per shared folder, each on a single shard with its own journal. Devices keep a cursor per namespace, hold a request open at a notification server, and read the changes after their cursor when told something changed. Commits name their parent revision and succeed only if the file is still there, so a conflict keeps both versions. Files are named by ID, so renames are one row and edits follow the file, and deletes are revisions that can be restored for 30 days. For very busy folders, notification servers subscribe once per namespace and recent changes are served from memory. Popular blocks are cached in each region and shared between devices on the same network, and blocks nobody reads move to an erasure-coded cold store.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### Where to cut the blocks

Cutting every 4 MB works when an edit changes bytes in place, as Photoshop did with brochure.psd. It fails when an edit inserts bytes. Add one page at the start of a 120 MB PDF and every byte after it moves along. Every 4 MB boundary now falls in a different place, all 30 blocks hash differently, and the whole file is uploaded again.

Content-defined chunking cuts where the content says, not every 4 MB. A rolling hash is computed over a small window, say 48 bytes, that slides along the file, and a block ends wherever the hash's lowest 22 bits are all zero. That happens about once every 4 MB, at places decided by the bytes around them. Insert a page at the start and only the first block changes. After it, the same bytes produce the same cut points, and the remaining blocks hash as before.

| | Fixed 4 MB blocks | Content-defined blocks |
|---|---|---|
| An edit in place | Changes the blocks it touches | Changes the blocks it touches |
| An insert near the start | Changes every block after it | Changes one or two blocks |
| Block sizes | All 4 MB, except the last | Vary; a minimum and maximum keep them between 1 and 8 MB |
| Cost on the device | Hashing only | A rolling hash over every byte as well |

Large files that people insert into, such as documents, archives and disk images, gain the most. Media files are mostly rewritten whole, or changed in place, and gain little.

### The device's three views of a file

A device can't tell what happened from the file on disk and the file on the server alone. If the server has a file and the device doesn't, either it was added elsewhere or deleted here. So for every file the device keeps a third view: the base, the revision and hashes it last agreed with the server.

| On this device, compared with the base | On the server, compared with the base | What the device does |
|---|---|---|
| Unchanged | Changed | Downloads the new revision |
| Changed | Unchanged | Uploads and commits, with the base as parent |
| Changed | Changed | Conflict: keeps both, as in Stage 4 |
| Deleted | Unchanged | Commits the delete |
| Deleted | Changed | Keeps the server's version; someone edited what was deleted here |
| Absent, and not in the base | Present | A new file from elsewhere; downloads it |

The base is kept in a small database on the device, and is updated only after a commit succeeds or a download finishes. If the device crashes in between, it simply compares the three views again when it starts.

### Noticing what changed on the device

The operating system reports file changes as events, and the client watches the synced folder for them. Events can be dropped, merged or missed while the client wasn't running, so the client also rescans the folder now and then. A rescan compares each file's size and modified time with the base. Only files whose size or time changed are hashed again, because hashing 8 GB on every start would take minutes. A file still being written is left until it hasn't changed for a few seconds, so half-saved files aren't uploaded.

### Deleting blocks safely

A block can be deleted once no revision anywhere refers to it. Counting references sounds simple: add one when a revision uses the block, subtract one when that revision expires. But the counts are on the block index and the revisions are in 2,000 metadata shards, and a count that drifts by one deletes data. Instead, a collector periodically walks every revision on every shard, marks every block they refer to, and deletes the blocks nobody marked.

There's a race. A device uploads a block, and is about to commit the file that uses it, when the collector runs. The block isn't in any revision yet, so it isn't marked. So the collector deletes only unmarked blocks that were last uploaded more than 7 days ago. A commit that names a block uploaded longer ago than that is refused with `missing_blocks`, and the device uploads it again.

### Files on demand

A phone, or a laptop with a small disk, can't hold everything in an account. With files on demand, the device shows every file, but stores only the metadata until a file is opened. The operating system asks the client for the bytes on first read, and the client fetches the blocks then. Files the person marks as always needed are kept downloaded. Rarely opened files can be evicted from the disk again. Everything else in this design is unchanged: the journal, the cursor and the block lists are the same.

### What if two blocks have the same hash?

Then one would be stored in place of the other, and a file would silently contain someone else's bytes. With SHA-256, the chance that any two of the 400 billion blocks stored share a hash by accident is around 10⁻⁵⁴. Disks, memory and networks corrupt data far more often than that, which is why the block servers check each block's hash on arrival, and why stored blocks are scrubbed, read and re-hashed, every few months.

### Encryption the service can't read

If each device encrypts blocks with a key only the account holds, the service stores bytes it can't read. Two accounts storing the same installer then store different encrypted blocks, so cross-account deduplication is lost. Previews, search and the web view stop working, because the server can't read the files. And a lost key loses every file for good. Encrypting each block with a key derived from its own content keeps deduplication, but lets anyone holding a file check whether an account holds it too. Products that want the service unable to read files pay all of these costs. This design encrypts every block at rest with keys the service holds, and keeps deduplication.

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### One namespace on one shard

Every commit in a namespace is a transaction on its shard. That keeps commits simple, and it means one shard carries a namespace's entire write load. A company that puts 50 million files and hundreds of commits a second into one folder can outgrow a shard. Splitting large drives into one namespace per team or project spreads them out, at the cost that a move between two namespaces is no longer one transaction.

### Conflicted copies instead of merging

Keeping both versions never loses work, but it leaves people to merge them by hand. The service knows nothing about the inside of a .docx or a .psd. Merging automatically needs editing built for it, like [Collaborative Document Editing](#/systems-case-studies/collaborative-editing), which works for documents edited in the product, not arbitrary files.

### Deduplication saves storage, not bandwidth

Checking for existing blocks only within an account means a device uploads blocks the service already holds for someone else. The service stores them once, but the bytes still cross the network. Checking across all accounts would save that upload, and would tell anyone who asks whether some file exists in somebody's account. Security wins.

### Block size

Smaller blocks mean an edit sends fewer unchanged bytes, but every file has more hashes, so block lists, the block index and the requests per file all grow. 4 MB suits large media and documents. Content-defined blocks change the boundaries, not the average size.

### Hints, then reads

Notifications carry no data, so every change costs a device a second round trip to read the journal. Putting the change itself in the notification would save that, and make every lost or out-of-order notification a possible missed change. The extra round trip buys a design where the cursor alone decides what a device has.

### Cold storage

Erasure coding halves the disk for 80% of the data. Reading a cold block costs about 150 ms more, and rebuilding fragments after a machine fails moves far more data than copying a replica. Moving blocks back to hot when they're read again means a burst of old files being opened, during an audit or a migration, is briefly expensive.

### How long to keep old versions

30 days of revisions and deleted files costs the storage of every block they keep alive, about 15% on top of current data. Longer protects against ransomware noticed late and mistakes found later. Shorter saves storage and makes garbage collection reclaim space sooner.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

The service holds people's private files and shares them on their behalf. The risks are reading files you shouldn't, using the service's own mechanisms to learn about others' files, and losing files to someone with access to an account ([Security & Authentication](#/systems/security-authentication)).

### A hash is not a key

If knowing a block's hash were enough to download it, anyone who learned the hashes of a file could fetch it, or commit a file listing those hashes and own a copy. So a commit may name only blocks the account uploaded itself or can already read, and the block servers serve a block only with a short-lived download token, issued by the metadata service, listing the hashes of a revision the account can read.

### Deduplication as a leak

If a device could ask "is this block stored anywhere?", a person could find out whether a particular file, a leaked document say, exists in anyone's account. That is why the check before uploading only looks at the asking account. Cross-account deduplication still happens, on the server side, where nobody can see it.

### Encryption at rest

Every block is encrypted on disk with a key held in a key service, and metadata shards are encrypted too. A stolen disk is unreadable, and deleting a key makes everything encrypted with it unreadable at once.

### Shared links

A link to a file or folder carries a long random token. It can expire, need a password, be limited to people in the same organisation, or only allow viewing. Links that are downloaded thousands of times are rate limited, so the service can't be used as free hosting for others' downloads ([Rate Limiting](#/systems/rate-limiting)).

### Ransomware

Ransomware on one laptop encrypts every file it can reach, and the sync client faithfully uploads the encrypted versions to every device. The 30 days of revisions are the defence. The service watches for an account rewriting thousands of files within minutes, warns the person, and offers to restore the whole account as it was at a moment they choose. A restore is just new revisions pointing at the old block lists.

### A lost or stolen device

Each device has its own credentials. Unlinking a device from the website revokes them, so it stops syncing, and at its next connection the client deletes its local copy of the files.

### Peers on the network

A device on the office network asks for blocks only from peers that mount the same namespace, proven with a key the service issues per namespace. A malicious peer can refuse to answer, but can't send the wrong bytes, because every block is hashed on arrival.

### Abuse

Shared links are used to spread malware and illegal content. Files behind public links are scanned, and block lists are compared against lists of known-bad hashes. Matches are taken down, and links are blocked, without anyone reading private files that aren't shared.

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **Sync lag**: time from a commit to every other online device following that namespace having applied it, at p50 and p99.
- **Commits**: latency, refused commits with `409`, and conflicted copies created per million commits.
- **Transfer**: the share of blocks a check says aren't needed, bytes uploaded per commit, and resumed uploads.
- **Notifications**: open requests per server, devices answered "changed" at once on reconnect, and time from commit to notification.
- **Metadata shards**: commit latency, replication lag to each standby, and the busiest namespaces by commits a second.
- **Blocks**: cache hit rate per region, cold reads a second, scrub results, and blocks re-copied after failures.
- **Garbage collection**: bytes reclaimed per run, and commits refused with `missing_blocks`.

([Observability](#/systems/observability))

### What to alert on

- **Any block that a revision refers to and that can't be read.** It means data has been lost, or an index points at the wrong place. Page immediately.
- Sync lag p99 above **10 seconds** in any region.
- Conflicted copies per million commits doubling, especially within a day of a client release. A client bug that commits with the wrong parent revision looks exactly like this.
- An account rewriting or deleting more than **5,000** files in 10 minutes.
- A metadata shard's standby more than **5 seconds** behind.
- Scrubs finding more corrupted fragments than the usual background.

### "I saved it on my laptop, and it's not on my desktop" — what happens?

Find the file's journal entry. If there is none, the laptop never committed it: check the laptop's client for failed uploads, a full quota, or a file still open and being written. If the entry is there, compare the desktop's cursor for that namespace with the journal head. A cursor that's behind means the desktop isn't reading changes: check whether it holds a request at a notification server. A cursor that's past the entry means the desktop read it and didn't apply it: look at its client log for a failed block download or a conflict.

### "Conflicted copies everywhere since Tuesday" — what happens?

Look at which client versions committed the refused commits. If they're all one release, it's committing with a stale parent revision, usually because it updates its base before a download finishes, or doesn't update it after its own commit. Halt the rollout. Nothing has been lost, since conflicts keep both copies, but people need to be told which copy to keep.

### "Every file in our account changed at 3 a.m." — what happens?

Check which device made the commits. If it's one device rewriting thousands of files with new, random-looking contents, it's ransomware. Unlink that device first, so it can't upload more. Then restore the account to just before the first rewrite. The old revisions' blocks are still stored, so the restore is commits, not uploads, and every device downloads the old versions back.
