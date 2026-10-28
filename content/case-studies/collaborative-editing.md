# Collaborative Document Editing

Collaborative editing lets several people type into the same document at the same moment. Each person sees the others' changes within a fraction of a second, and when everyone stops, every copy is identical. The hard part isn't sending the keystrokes. Two people's edits are each written against a version of the document the other has already changed, so each has to be adjusted before it can be applied. Someone's laptop drops off the network mid-sentence and comes back with edits written against a version that is now forty seconds old. And when one document is opened by a whole company at once, every keystroke has thousands of people to reach. This case study builds the editing service for a documents product used by 30 million people a day. At peak there are 3 million editing sessions open and about a million edits a second, and a few documents have 3,000 people in them at once.

<!-- tab:requirements:Requirements -->

## Requirements

This case study builds the service that keeps every open copy of a document in step while people edit it. That covers the text and its formatting, people's cursors, comments, and version history. The running example is a launch plan, `doc_4471`, edited by Ana and Ben, and later a company's all-hands notes, which 3,000 people open on a Monday morning. Who may open a document is decided by a permission service, which this design asks but doesn't build.

### Functional requirements

- **Open a document**: load the latest text and see everyone else who has it open.
- **Edit together**: several people type into the same document at the same time, and every copy ends up the same.
- **Typing never waits**: a person's own edits appear on their screen immediately, whatever the network is doing.
- **See others' edits live**: changes from other people appear within a fraction of a second.
- **Cursors and selections**: each person sees where the others are and what they've selected.
- **Comments**: attach a comment to a range of text, and keep it attached as the text around it changes.
- **Version history**: list earlier versions, see who changed what, and restore any of them.
- **Keep working through a dropped connection**: edits made offline for minutes or hours are merged when the connection returns.

### Non-functional requirements

- **Local echo:** a person's own keystrokes appear with **no network wait**.
- **Remote edits:** visible to others in the same region within **200ms** at p50 and **500ms** at p99.
- **Convergence:** once everyone stops typing, every copy of the document is **identical**.
- **Durability:** an edit that has been acknowledged is **never lost**, even if a zone fails.
- **Opening:** a document opens in under **1 second** at p99, however long its history.
- **Availability:** 99.99% of edits accepted. When one server fails, the documents it held pause for seconds, not minutes.
- **Scale:** **3 million** editing sessions at peak, **1 million** edits a second, and up to **100** people editing and **3,000** open in one document.

### In scope

Sending edits as operations, transforming concurrent edits, ordering each document's edits in one place, the operation log and snapshots, failover, reconnecting after time offline, cursors, comments anchored to text, version history and restore, very busy documents, and editors in other regions.

### Out of scope

**Spreadsheets and slides**, which use the same ideas on different structures. **Images and attachments**: they're stored in an object store and the document holds a reference. **Search across documents**. **Sharing and permissions**: a permission service is assumed. **Offline-first editing for days at a time**; the trade-offs are in Deep Dives.

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

Documents are small, and most have one person in them. What shapes the design is that every keystroke has to reach every other copy of its document, in order, and a few documents have thousands of copies.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Editing sessions</div>
<div class="stat-tile-value">~3<span class="stat-tile-unit">M</span></div>
<div class="stat-tile-sub">open at peak · in 2M documents</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Edits</div>
<div class="stat-tile-value">~1<span class="stat-tile-unit">M/s</span></div>
<div class="stat-tile-sub">at peak · ~400K/s on average</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Operation log</div>
<div class="stat-tile-value">~4<span class="stat-tile-unit">TB/day</span></div>
<div class="stat-tile-sub">~120 bytes per edit</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Documents</div>
<div class="stat-tile-value">~2<span class="stat-tile-unit">B</span></div>
<div class="stat-tile-sub">~25 KB each</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Latest snapshots</div>
<div class="stat-tile-value">~50<span class="stat-tile-unit">TB</span></div>
<div class="stat-tile-sub">one current copy of every document</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Busiest document</div>
<div class="stat-tile-value">~3,000<span class="stat-tile-unit">open</span></div>
<div class="stat-tile-sub">100 of them editing</div>
</div>
</div>

### Assumptions

- **30 million** people edit a document on a typical weekday. At peak, **3 million** editing sessions are open at once, in about 2 million documents. Most documents have one person in them.
- At any moment, about **1 in 6** open sessions is typing.
- While someone types, their editor sends about **2 operations a second**. Keystrokes made while one operation is on its way are combined into the next.
- **2 billion** documents are stored, about 25 KB of text and formatting each.
- Each person opens about **8 documents** a day.

### Edits

3 million sessions, 1 in 6 typing, 2 operations a second each: **1 million operations a second** at peak, about 400,000 on average. Each is acknowledged to its author and sent to everyone else with the document open. In 85% of documents being typed in, there's nobody else to send it to, so about 800,000 copies go out a second at peak.

### The operation log

Every operation is stored, with its author, revision number and time: about 120 bytes. 400,000 a second on average is 48 MB a second, about **4 TB a day**. Keystroke-level history is kept for 30 days, about 125 TB, and then merged into the versions people see in history.

### Documents and snapshots

2 billion documents at 25 KB is **50 TB** for one current copy of each. To open quickly, a document's full text is saved every 500 operations. At 1 million operations a second, that's 2,000 snapshot writes a second, about 50 MB a second.

### Opening

30 million people opening 8 documents a day is 240 million opens, 2,800 a second on average and about **8,000 a second** at peak. Each open reads one snapshot and up to 500 operations after it.

### Memory

An open document is held in memory by one server: its text plus its last 1,000 operations, about 150 KB. 2 million open documents is **300 GB** across the fleet. CPU and connections need more servers than memory does: about 100 at peak.

<!-- tab:api-design:API Design -->

## API Design

Opening a document is an ordinary request. Everything after that, edits in both directions, acknowledgements and cursors, moves as messages over a connection the editor keeps open while the document is on screen.

### Opening a document

```
GET /v1/docs/doc_4471
→ 200 {"doc_id": "doc_4471", "title": "Launch plan", "revision": 57,
       "content": { …the document at revision 57… },
       "people": [{"user": "u_ben", "name": "Ben", "color": "#2a7ab0"}],
       "session_url": "wss://collab.example.com/docs/doc_4471"}
```

### Sending an edit

```
editor → server
{"type": "op", "client_id": "c_ana_7f2", "client_seq": 12, "base_rev": 57,
 "ops": [{"retain": 9}, {"insert": "public "}, {"retain": 15}]}

server → the author
{"type": "ack", "client_seq": 12, "rev": 58}

server → everyone else
{"type": "op", "rev": 58, "author": "u_ana",
 "ops": [{"retain": 9}, {"insert": "public "}, {"retain": 15}]}
```

### Cursors

```
editor → server, at most 10 a second
{"type": "cursor", "base_rev": 58, "anchor": 24, "head": 30}

server → everyone else
{"type": "cursor", "user": "u_ben", "rev": 58, "anchor": 24, "head": 30}
```

### Reconnecting

```
editor → server
{"type": "hello", "client_id": "c_ana_7f2", "last_rev": 59,
 "pending": [{"client_seq": 14, "base_rev": 59, "ops": […]}]}

server → editor
{"type": "catch_up", "ops": [ …revisions 60 to 65… ]}
{"type": "ack", "client_seq": 14, "rev": 66}
```

### Comments and history

```
POST /v1/docs/doc_4471/comments
{"anchor": {"rev": 216, "from": 31, "to": 37}, "body": "Is Monday realistic?"}
→ 201 {"comment_id": "cm_301"}

GET /v1/docs/doc_4471/versions
→ 200 {"versions": [{"version_id": "v_88", "ended_at": "2026-10-20T16:20:00Z",
                     "end_rev": 640, "authors": ["u_ana", "u_ben"]}, …]}

POST /v1/docs/doc_4471/versions/v_88/restore
→ 200 {"rev": 913}
```

| Code | Meaning |
|---|---|
| `200` | Done |
| `201` | Comment created |
| `400` | The operation doesn't fit the revision it names: it reaches past the end of the text |
| `403` | The caller may only view or comment |
| `404` | No such document, comment or version |
| `409` | `base_rev` is older than the operations the server still holds; reload the document |
| `413` | The document would exceed its size limit |
| `429` | Over the editor's operation rate |

### Why the details matter

**Edits travel as operations, not documents.** An operation says what changed: keep 9 characters, insert "public ", keep the remaining 15. Two people's operations can be combined. Two whole documents can only be chosen between.

**Every operation names the revision it was written against.** A position means nothing on its own: position 17 is "Friday" at one revision and "eta by" at the next. `base_rev` is what lets the server work out what the author meant.

**`retain` counts, not bare positions.** An operation covers the whole document, so the server can check its length against the text at `base_rev` and refuse one that doesn't fit, rather than applying it in the wrong place.

**A client ID and sequence number make resending safe.** After a reconnect, an editor resends anything not yet acknowledged. The server recognises an operation it already applied and returns the original revision instead of applying it twice ([Idempotency](#/systems/idempotency)).

**Cursors carry a revision too.** A cursor at 24 at revision 58 is somewhere else at revision 60, and the receiver moves it there.

<!-- tab:data-model:Data Model -->

## Data Model

Every accepted operation goes into an append-only log, keyed by document and revision. The current text is never written edit by edit. It's rebuilt from the latest snapshot and the operations after it. Document details, comments and versions are ordinary rows.

### Documents

```
documents                                -- relational DB
  doc_id          TEXT PRIMARY KEY       -- doc_4471
  title           TEXT                   -- Launch plan
  owner_user_id   TEXT
  created_at      TIMESTAMP
  latest_rev      BIGINT                 -- updated with each snapshot
  size_bytes      INT
```

### The operation log and snapshots

```
op_log                                   -- wide-column store, partitioned by doc_id
  doc_id        TEXT
  rev           BIGINT                   -- PRIMARY KEY (doc_id, rev)
  author_id     TEXT
  client_id     TEXT                     -- c_ana_7f2
  client_seq    INT                      -- 12
  ops           BYTES                    -- [{"retain":9},{"insert":"public "},…]
  created_at    TIMESTAMP

op_log_epoch                             -- same partition as the document's ops (from Stage 3)
  doc_id        TEXT PRIMARY KEY
  epoch         INT                      -- 3; appends must carry it

snapshots                                -- object store, one every 500 ops (from Stage 3)
  doc_4471/rev-000000500  → full document at revision 500
```

### Ownership (from Stage 3)

```
owner registry                           -- replicated lease store
  doc_4471 → owner: collab-17, epoch: 3, lease_expires: 09:00:05
```

### Comments and versions (from Stage 4)

```
comments
  comment_id    TEXT PRIMARY KEY         -- cm_301
  doc_id        TEXT
  thread_id     TEXT
  author_id     TEXT
  body          TEXT
  anchor_from, anchor_to   INT           -- 43, 49
  anchor_rev    BIGINT                   -- the revision those positions are correct at
  quoted_text   TEXT                     -- "Monday", kept if the text is deleted
  status        TEXT                     -- open | resolved

versions
  doc_id, version_id                     -- v_88
  start_rev, end_rev   BIGINT            -- 501, 640
  authors       TEXT[]
  ended_at      TIMESTAMP
  snapshot      TEXT                     -- object store key of the text at end_rev
```

### Why this storage

The log is written once per operation and read in ranges: "everything for `doc_4471` after revision 500". A store partitioned by document keeps each document's operations together, spreads documents across machines, and replicates every write to three zones before acknowledging it ([Databases: NoSQL](#/systems/databases-nosql), [Replication](#/systems/replication)). The key `(doc_id, rev)` is also the last line of defence: two servers can never both write revision 214 of the same document. Snapshots are large, written rarely and read whole, which is what an object store is for. Comments and versions change a handful of times and are listed and joined, so they're relational rows ([Databases: Relational](#/systems/databases-relational)).

<!-- tab:architecture:Architecture:default -->

This case study builds collaborative editing up in five stages. Each stage fixes a specific failure of the one before. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one request at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. Save the Whole Document -->

## Stage 1 — Save the Whole Document

The simplest editor treats the document as one piece of text. The browser loads it, the person edits their own copy, and every 3 seconds while there are changes, the app sends the whole document back to be saved.

```
GET /docs/doc_4471          → {"content": "Ship the beta by Friday. …", "version": 57}
PUT /docs/doc_4471          {"content": "…the whole document…"}

UPDATE documents SET content = $1, version = version + 1 WHERE doc_id = 'doc_4471'
```

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 780 300" width="780" height="300" role="img" aria-label="Ana's and Ben's editors load the whole document from an app server and save the whole document back to it every few seconds; the app server stores it in one database row">
  <rect x="20" y="40" width="140" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Ana's Editor</text>
  <text x="90" y="83" text-anchor="middle" class="d-label-muted" font-size="9">edits a local copy</text>
  <rect x="20" y="190" width="140" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="216" text-anchor="middle" class="d-actor-label" font-size="12">Ben's Editor</text>
  <text x="90" y="233" text-anchor="middle" class="d-label-muted" font-size="9">edits a local copy</text>
  <g data-fail-toggle="app1">
    <rect x="260" y="95" width="180" height="110" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="350" y="130" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
    <text x="350" y="148" text-anchor="middle" class="d-label-muted" font-size="9">load whole document</text>
    <text x="350" y="163" text-anchor="middle" class="d-label-muted" font-size="9">save whole document</text>
  </g>
  <g data-fail-toggle="db1">
    <rect x="560" y="100" width="200" height="100" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="660" y="131" text-anchor="middle" class="d-actor-label" font-size="12">Database</text>
    <text x="660" y="149" text-anchor="middle" class="d-label-muted" font-size="9">one row per document</text>
    <text x="660" y="164" text-anchor="middle" class="d-label-muted" font-size="9">content + version</text>
  </g>
  <line id="d1-a-app" x1="162" y1="62" x2="256" y2="118" class="d-msg d-request" data-depends-on="app1" marker-end="url(#arrowC1)"></line>
  <line id="d1-app-a" x1="256" y1="140" x2="162" y2="86" class="d-msg d-response" data-depends-on="app1" marker-end="url(#arrowC1r)"></line>
  <line id="d1-b-app" x1="162" y1="212" x2="256" y2="168" class="d-msg d-request" data-depends-on="app1" marker-end="url(#arrowC1)"></line>
  <line id="d1-app-b" x1="256" y1="190" x2="162" y2="236" class="d-msg d-response" data-depends-on="app1" marker-end="url(#arrowC1r)"></line>
  <line id="d1-app-db" x1="442" y1="136" x2="556" y2="136" class="d-msg d-request" data-depends-on="app1 db1" marker-end="url(#arrowC1)"></line>
  <line id="d1-db-app" x1="556" y1="166" x2="442" y2="166" class="d-msg d-response" data-depends-on="app1 db1" marker-end="url(#arrowC1r)"></line>
  <text x="390" y="290" text-anchor="middle" class="d-label-muted" font-size="10">play Ana editing alone, then Ana and Ben editing at once, then a save that checks the version</text>
  <defs>
    <marker id="arrowC1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowC1r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "scr", "title": "Screens", "rows": [["Ana", "—"], ["Ben", "—"]]},
{"id": "db", "title": "Database", "rows": [["version", "—"], ["first line", "—"]]}
],
"flows": [
{
"id": "alone",
"label": "Ana edits alone",
"nodes": ["app1", "db1"],
"steps": [
{"el": "d1-a-app", "payload": "GET /docs/doc_4471", "set": {"scr.Ana": "—", "scr.Ben": "—", "db.version": "57", "db.first line": "Ship the beta by Friday."}, "text": "Ana opens the launch plan, doc_4471, a 24 KB document. Its first line reads “Ship the beta by Friday.”"},
{"el": "d1-app-db", "payload": "SELECT content, version", "text": "The app server reads the document's row."},
{"el": "d1-db-app", "payload": "version 57 · 24 KB", "ms": 5, "text": "The whole document comes back, with its version number."},
{"el": "d1-app-a", "payload": "content · version 57", "set": {"scr.Ana": "Ship the beta by Friday."}, "text": "The editor shows it. From here on, Ana edits a copy in the browser."},
{"el": "d1-a-app", "payload": "PUT whole document · 24 KB", "set": {"scr.Ana": "Ship the public beta by Friday."}, "text": "Ana types “public ” before “beta”. Three seconds later, the editor sends the whole document back."},
{"el": "d1-app-db", "payload": "UPDATE … version = 58", "text": "The app server overwrites the row."},
{"el": "d1-db-app", "payload": "saved", "ms": 5, "set": {"db.version": "58", "db.first line": "Ship the public beta by Friday."}, "text": "Saved."},
{"el": "d1-app-a", "payload": "saved · version 58", "text": "With one person editing, this is all a document editor needs."}
]
},
{
"id": "together",
"label": "Ana and Ben edit at once",
"nodes": ["app1", "db1"],
"steps": [
{"el": "d1-b-app", "payload": "GET /docs/doc_4471", "set": {"scr.Ana": "Ship the beta by Friday.", "scr.Ben": "—", "db.version": "57", "db.first line": "Ship the beta by Friday."}, "text": "Ana has the document open at version 57. Ben opens it too."},
{"el": "d1-app-b", "payload": "content · version 57", "set": {"scr.Ben": "Ship the beta by Friday."}, "text": "Both now have the same copy."},
{"el": "d1-a-app", "payload": "PUT · Ship the public beta by Friday. …", "set": {"scr.Ana": "Ship the public beta by Friday."}, "text": "Ana adds “public ”, and the editor saves the whole document."},
{"el": "d1-app-db", "payload": "UPDATE · version 58", "ms": 5, "set": {"db.version": "58", "db.first line": "Ship the public beta by Friday."}, "text": "Saved as version 58."},
{"el": "d1-b-app", "payload": "PUT · Ship the beta by Monday. …", "set": {"scr.Ben": "Ship the beta by Monday."}, "text": "Two seconds later, Ben's editor saves. Ben changed “Friday” to “Monday”, in a copy loaded before Ana's change, which has never seen it."},
{"el": "d1-app-db", "payload": "UPDATE · version 59", "ms": 5, "set": {"db.version": "59", "db.first line": "Ship the beta by Monday."}, "text": "The database stores the whole document, as it was told. Ana's word is gone."},
{"el": "d1-app-b", "payload": "saved · version 59", "text": "Both saves succeeded. Ana's screen still shows “public”, and will until a reload shows it missing. Nobody was told anything was lost, and neither of them saw the other typing."}
]
},
{
"id": "check",
"label": "Save only if unchanged",
"nodes": ["app1", "db1"],
"steps": [
{"el": "d1-a-app", "payload": "PUT · If-Match: 57", "set": {"scr.Ana": "Ship the public beta by Friday.", "scr.Ben": "Ship the beta by Monday.", "db.version": "57", "db.first line": "Ship the beta by Friday."}, "text": "Add a check: each save names the version it started from, and succeeds only if the document is still at that version."},
{"el": "d1-app-db", "payload": "UPDATE … WHERE version = 57", "text": "Ana's save goes first."},
{"el": "d1-db-app", "payload": "1 row · version 58", "ms": 5, "set": {"db.version": "58", "db.first line": "Ship the public beta by Friday."}, "text": "It succeeds."},
{"el": "d1-b-app", "payload": "PUT · If-Match: 57", "text": "Ben's save also started from 57."},
{"el": "d1-app-db", "payload": "UPDATE … WHERE version = 57", "text": "The same condition."},
{"el": "d1-db-app", "payload": "0 rows", "ms": 5, "text": "The document is at 58, so nothing is written."},
{"el": "d1-app-b", "payload": "409 · changed by someone else", "set": {"scr.Ben": "reload · “Monday” must be redone"}, "text": "Ben's save is refused. The editor has to reload the document, and Ben has to make the change again. Nothing is lost silently any more."},
{"el": "d1-app-a", "payload": "5 people · most saves refused", "text": "But with five people in a document, each saving every 3 seconds, almost every save finds the document has moved on. And still nobody sees anyone else's changes until they reload."}
]
}
]
}
</script>
<div class="diagram-caption">Each editor loads the whole document and saves the whole document back every 3 seconds. The database keeps one row per document, so the last save wins.</div>
</div>

<div class="fail-hint">Click the app server or the database to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="app1">
<strong>If the app server fails:</strong> nobody can open or save. Editors keep their unsaved changes in the browser, and lose them if the tab is closed.
</div>
<div class="failure-impact is-hidden" data-component="db1">
<strong>If the database fails:</strong> every document is unavailable.
</div>
</div>

The unit of work is wrong. A save carries the whole document, so the server can only keep one person's version or the other's. It needs each change on its own, such as "insert 'public ' at 9", so that changes from different people can be combined. And changes need to reach the other people in the document as they're made, not when someone reloads.

<!-- stage:2:2. Operations, Transformed -->

## Stage 2 — Send Operations, and Transform Them

- **Each edit travels as an operation.** "Insert 'public ' at 9." "Delete 6 characters at 17 and insert 'Monday'." The document itself is never sent back.
- **The editor applies its own edits at once.** Typing never waits for the network. The operation is sent in the background over a connection the editor keeps open ([Real-time Delivery](#/systems/realtime-delivery)).
- **One server holds each open document.** A collaboration server keeps the document's text in memory, with a revision number that goes up by one for every operation it accepts.
- **Every operation names the revision it was written against.** If others have been accepted since, the server **transforms** it: it adjusts the operation's positions to allow for those changes, so it does what its author meant on the current text. Then it applies it and gives it the next revision.
- **The log comes before the acknowledgement.** An operation is appended to the operation log in the database, then acknowledged to its author, then sent to everyone else in the document. The full text is saved every 100 operations, so opening reads it and the operations after it.
- **Each editor has one operation in flight.** Edits made while it waits for the acknowledgement are combined into one pending operation. When another person's operation arrives, the editor transforms it against its own unacknowledged ones before applying it, so what this person typed stays where they typed it.
- **Reconnecting catches up.** An editor that was cut off sends the last revision it has and its unacknowledged operations. The server sends what it missed and transforms what it sent ([Offline & Resilience](#/systems/offline-resilience)).

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 780 300" width="780" height="300" role="img" aria-label="Ana's and Ben's editors keep a connection to a collaboration server and send operations over it; the server transforms each operation, appends it to the operation log in the database, acknowledges it and sends it to the other editor">
  <rect x="20" y="40" width="140" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Ana's Editor</text>
  <text x="90" y="83" text-anchor="middle" class="d-label-muted" font-size="9">applies own edits at once</text>
  <rect x="20" y="190" width="140" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="216" text-anchor="middle" class="d-actor-label" font-size="12">Ben's Editor</text>
  <text x="90" y="233" text-anchor="middle" class="d-label-muted" font-size="9">one operation in flight</text>
  <g data-fail-toggle="srv2">
    <rect x="260" y="95" width="180" height="110" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="350" y="128" text-anchor="middle" class="d-actor-label" font-size="12">Collaboration Server</text>
    <text x="350" y="146" text-anchor="middle" class="d-label-muted" font-size="9">document in memory</text>
    <text x="350" y="161" text-anchor="middle" class="d-label-muted" font-size="9">transform → revision → log</text>
  </g>
  <g data-fail-toggle="db2">
    <rect x="560" y="100" width="200" height="100" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="660" y="131" text-anchor="middle" class="d-actor-label" font-size="12">Database</text>
    <text x="660" y="149" text-anchor="middle" class="d-label-muted" font-size="9">operation log</text>
    <text x="660" y="164" text-anchor="middle" class="d-label-muted" font-size="9">text every 100 operations</text>
  </g>
  <line id="d2-a-srv" x1="162" y1="62" x2="256" y2="118" class="d-msg d-request" data-depends-on="srv2" marker-end="url(#arrowC2)"></line>
  <line id="d2-srv-a" x1="256" y1="140" x2="162" y2="86" class="d-msg d-response" data-depends-on="srv2" marker-end="url(#arrowC2r)"></line>
  <line id="d2-b-srv" x1="162" y1="212" x2="256" y2="168" class="d-msg d-request" data-depends-on="srv2" marker-end="url(#arrowC2)"></line>
  <line id="d2-srv-b" x1="256" y1="190" x2="162" y2="236" class="d-msg d-response" data-depends-on="srv2" marker-end="url(#arrowC2r)"></line>
  <line id="d2-srv-db" x1="442" y1="136" x2="556" y2="136" class="d-msg d-request" data-depends-on="srv2 db2" marker-end="url(#arrowC2)"></line>
  <line id="d2-db-srv" x1="556" y1="166" x2="442" y2="166" class="d-msg d-response" data-depends-on="srv2 db2" marker-end="url(#arrowC2r)"></line>
  <text x="390" y="290" text-anchor="middle" class="d-label-muted" font-size="10">play Ana typing a word, then Ana and Ben changing one sentence, then Ben's Wi-Fi dropping</text>
  <defs>
    <marker id="arrowC2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowC2r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "scr", "title": "Screens", "rows": [["Ana", "—"], ["Ben", "—"]]},
{"id": "srv", "title": "Server", "rows": [["revision", "—"], ["first line", "—"]]}
],
"flows": [
{
"id": "word",
"label": "Ana types a word",
"nodes": ["srv2", "db2"],
"steps": [
{"el": "d2-a-srv", "payload": "open doc_4471", "set": {"scr.Ana": "—", "scr.Ben": "Ship the beta by Friday.", "srv.revision": "—", "srv.first line": "—"}, "text": "Ben has the launch plan open. Ana opens it, and the editor opens a connection to the collaboration server."},
{"el": "d2-srv-db", "payload": "text + operations after it", "text": "The server reads the last saved text and the operations logged after it."},
{"el": "d2-db-srv", "payload": "text at revision 57", "ms": 8, "set": {"srv.revision": "57", "srv.first line": "Ship the beta by Friday."}, "text": "It now holds the document in memory at revision 57. Ben's editor is connected to the same copy."},
{"el": "d2-srv-a", "payload": "text · revision 57", "set": {"scr.Ana": "Ship the beta by Friday."}, "text": "Ana's editor shows it."},
{"el": "d2-a-srv", "payload": "insert “public ” at 9 · base 57 · seq 12", "set": {"scr.Ana": "Ship the public beta by Friday."}, "text": "Ana types “public ” before “beta”. Each keystroke shows at once. While one operation is on its way, further keystrokes are combined into the next one, so a fast typist sends a few operations a second, not one per key."},
{"el": "d2-srv-db", "payload": "append revision 58", "ms": 3, "set": {"srv.revision": "58", "srv.first line": "Ship the public beta by Friday."}, "text": "Nothing has changed since 57, so the server applies the operation as it is, gives it revision 58, and appends it to the log."},
{"el": "d2-srv-a", "payload": "ack seq 12 → revision 58", "text": "Only once it's in the log is it acknowledged."},
{"el": "d2-srv-b", "payload": "revision 58 · insert “public ” at 9", "set": {"scr.Ben": "Ship the public beta by Friday."}, "text": "Ben's editor applies it. Ben sees Ana's word appear about 3 ms of server time after it arrived, plus the network."}
]
},
{
"id": "same",
"label": "Ana and Ben change one sentence",
"nodes": ["srv2", "db2"],
"steps": [
{"el": "d2-a-srv", "payload": "insert “public ” at 9 · base 57", "set": {"scr.Ana": "Ship the public beta by Friday.", "scr.Ben": "Ship the beta by Friday.", "srv.revision": "57", "srv.first line": "Ship the beta by Friday."}, "text": "Both have the document at revision 57. Ana types “public ” before “beta”. It appears on Ana's screen at once, and the operation goes out marked as written against 57."},
{"el": "d2-b-srv", "payload": "delete 6 at 17 · insert “Monday” · base 57", "set": {"scr.Ben": "Ship the beta by Monday."}, "text": "In the same second, Ben replaces “Friday” with “Monday”. At revision 57, “Friday” starts at position 17."},
{"el": "d2-srv-db", "payload": "append revision 58 · Ana's", "ms": 3, "set": {"srv.revision": "58", "srv.first line": "Ship the public beta by Friday."}, "text": "Ana's arrives first. Nothing has happened since 57, so it's applied as it is, as revision 58."},
{"el": "d2-srv-a", "payload": "ack → revision 58", "text": "Ana's editor is told."},
{"el": "d2-srv-b", "payload": "revision 58 · insert “public ” at 9", "set": {"scr.Ben": "Ship the public beta by Monday."}, "text": "Ben's editor receives Ana's operation while its own is still unacknowledged. It transforms Ana's against its own: Ana's insert at 9 is before Ben's change at 17, so it stays at 9. Ben's screen now has both changes."},
{"el": "d2-srv-db", "payload": "Ben's moved 17 → 24 · append revision 59", "ms": 3, "set": {"srv.revision": "59", "srv.first line": "Ship the public beta by Monday."}, "text": "Now Ben's operation, written against 57. Since then, revision 58 inserted 7 characters at 9, before Ben's position, so the server moves Ben's change from 17 to 24, where “Friday” now starts. Applied unchanged at 17, it would have produced “Ship the public bMonday Friday.”"},
{"el": "d2-srv-b", "payload": "ack → revision 59", "text": "Ben's editor is told its operation is revision 59."},
{"el": "d2-srv-a", "payload": "revision 59 · delete 6 at 24 · insert “Monday”", "set": {"scr.Ana": "Ship the public beta by Monday."}, "text": "Ana's editor gets Ben's operation as the server transformed it. Both screens read “Ship the public beta by Monday.”, and so does the server. Neither edit was thrown away; both were combined."}
]
},
{
"id": "offline",
"label": "Ben's Wi-Fi drops",
"nodes": ["srv2", "db2"],
"steps": [
{"el": "d2-srv-b", "payload": "connection lost at revision 59", "set": {"scr.Ana": "Ship the public beta by Monday.", "scr.Ben": "Ship the public beta by Monday.", "srv.revision": "59", "srv.first line": "Ship the public beta by Monday."}, "text": "Ben's laptop loses its Wi-Fi for 40 seconds. The editor keeps working, against its own copy at revision 59."},
{"el": "d2-a-srv", "payload": "6 edits to the timeline · revisions 60–65", "text": "Ana keeps editing the timeline further down the document."},
{"el": "d2-srv-db", "payload": "append revisions 60–65", "ms": 3, "set": {"srv.revision": "65"}, "text": "Each is logged and acknowledged as usual. Ben's editor gets none of them."},
{"el": "d2-b-srv", "payload": "hello · last rev 59 · pending: insert “ Owner: Ben.” at 31", "set": {"scr.Ben": "Ship the public beta by Monday. Owner: Ben."}, "text": "Ben typed too while offline: “ Owner: Ben.” at the end of the first line, one pending operation written against 59. When the connection returns, the editor says which revision it has and resends the pending operation."},
{"el": "d2-srv-b", "payload": "revisions 60–65", "text": "The server sends the six operations Ben missed. Ben's editor transforms them against the pending operation and applies them."},
{"el": "d2-srv-db", "payload": "Ben's against 60–65 · append revision 66", "ms": 3, "set": {"srv.revision": "66", "srv.first line": "Ship the public beta by Monday. Owner: Ben."}, "text": "The server transforms Ben's operation against 60 to 65. They were all later in the document, after position 31, so it stays at 31. Had Ana typed in the first line, it would have moved."},
{"el": "d2-srv-b", "payload": "ack → revision 66", "text": "Ben's editor is caught up."},
{"el": "d2-srv-a", "payload": "revision 66 · insert “ Owner: Ben.” at 31", "set": {"scr.Ana": "Ship the public beta by Monday. Owner: Ben."}, "text": "Ana sees Ben's words appear. Forty seconds offline cost Ben nothing but forty seconds of not seeing Ana's changes."}
]
}
]
}
</script>
<div class="diagram-caption">Editors send each edit as an operation naming the revision it was written against. The collaboration server transforms it past anything accepted since, gives it the next revision, logs it, then acknowledges it and sends it to everyone else.</div>
</div>

<div class="fail-hint">Click the collaboration server or the database to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="srv2">
<strong>If the collaboration server fails:</strong> every open document stops syncing. Editors keep typing into their own copies and hold their operations until it's back. Nothing in the log is lost, but an operation that was logged just before the crash, and never acknowledged, is resent and may be applied twice.
</div>
<div class="failure-impact is-hidden" data-component="db2">
<strong>If the database fails:</strong> no operation can be logged, so none is acknowledged or sent to anyone else. Editors keep typing locally and resend when it returns.
</div>
</div>

Edits from several people now combine correctly. But it all runs on one server. At peak there are 3 million sessions and a million operations a second, which needs about a hundred servers. Revisions, though, must come from one place for each document. Behind an ordinary load balancer, Ana's connection could land on server A and Ben's on server B. Each would load its own copy of `doc_4471`, and each would give revision 60 to a different operation: two histories that never meet again. And when a server dies, its documents need a new home, and the operations that editors resend must not be applied twice.

<!-- stage:3:3. One Owner per Document -->

## Stage 3 — One Owner for Each Document

- **Gateways hold the connections.** Editors connect to any gateway. The gateway forwards each document's messages to that document's owner ([Load Balancing](#/systems/load-balancing)).
- **Each open document has exactly one owner.** An owner registry maps each document to the collaboration server that owns it, with an epoch number that rises at every change of owner. Ownership is a lease, renewed every 2 seconds, which lapses 5 seconds after the last renewal ([Distributed Locking](#/systems/distributed-locking), [Distributed Lock Service](#/systems-case-studies/distributed-lock-service)).
- **The first gateway to need a document places it.** If the registry has no owner, the gateway asks the least-loaded server to take it. That server claims the lease and loads the document. A document is unloaded 10 minutes after the last person leaves. It's the same pattern as the owner of each conversation in [Chat / Messaging App](#/systems-case-studies/chat-messaging).
- **Appends are conditional.** The log is partitioned by document. An append succeeds only if nothing is stored at that revision yet, and the document's epoch in the log is still the writer's. A new owner raises the epoch before it does anything else, so an old owner that wakes from a long pause can't write ([Partitioning & Sharding](#/systems/partitioning-sharding)).
- **Snapshots make opening fast.** The owner writes the full document to an object store every 500 operations, in the background. Opening reads the latest snapshot and at most 500 operations after it.
- **Resends are recognised.** Every operation is logged with its editor's client ID and sequence number. When a new owner loads a document, it reads them too. A resent operation that's already in the log gets its original revision back instead of being applied again.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 400" width="860" height="400" role="img" aria-label="Editors connect to gateways, which look up each document's owner in an owner registry and forward operations to that collaboration server; owners hold leases in the registry and append to a document store holding the operation log and snapshots">
  <rect x="20" y="40" width="120" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Ana's Editor</text>
  <text x="80" y="83" text-anchor="middle" class="d-label-muted" font-size="9">on gateway 3</text>
  <rect x="20" y="290" width="120" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="316" text-anchor="middle" class="d-actor-label" font-size="12">Ben's Editor</text>
  <text x="80" y="333" text-anchor="middle" class="d-label-muted" font-size="9">on gateway 41</text>
  <g data-fail-toggle="gw3">
    <rect x="180" y="150" width="130" height="100" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="245" y="192" text-anchor="middle" class="d-actor-label" font-size="12">Gateways</text>
    <text x="245" y="210" text-anchor="middle" class="d-label-muted" font-size="9">find each doc's owner</text>
  </g>
  <g data-fail-toggle="c17">
    <rect x="380" y="30" width="190" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="475" y="62" text-anchor="middle" class="d-actor-label" font-size="12">Collab Server 17</text>
    <text x="475" y="80" text-anchor="middle" class="d-label-muted" font-size="9">owner of doc_4471</text>
    <text x="475" y="95" text-anchor="middle" class="d-label-muted" font-size="9">epoch 3</text>
  </g>
  <g data-fail-toggle="reg3">
    <rect x="380" y="165" width="190" height="60" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="475" y="191" text-anchor="middle" class="d-actor-label" font-size="12">Owner Registry</text>
    <text x="475" y="208" text-anchor="middle" class="d-label-muted" font-size="9">doc → owner, epoch · 5 s lease</text>
  </g>
  <g data-fail-toggle="c09">
    <rect x="380" y="270" width="190" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="475" y="302" text-anchor="middle" class="d-actor-label" font-size="12">Collab Server 09</text>
    <text x="475" y="320" text-anchor="middle" class="d-label-muted" font-size="9">owns other documents</text>
  </g>
  <g data-fail-toggle="st3">
    <rect x="650" y="30" width="190" height="330" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="745" y="172" text-anchor="middle" class="d-actor-label" font-size="12">Document Store</text>
    <text x="745" y="190" text-anchor="middle" class="d-label-muted" font-size="9">op log by doc + revision</text>
    <text x="745" y="205" text-anchor="middle" class="d-label-muted" font-size="9">append only if revision free</text>
    <text x="745" y="220" text-anchor="middle" class="d-label-muted" font-size="9">and epoch current</text>
    <text x="745" y="235" text-anchor="middle" class="d-label-muted" font-size="9">snapshot every 500 ops</text>
  </g>
  <line id="d3-a-gw" x1="142" y1="62" x2="216" y2="146" class="d-msg d-request" data-depends-on="gw3" marker-end="url(#arrowC3)"></line>
  <line id="d3-gw-a" x1="236" y1="146" x2="142" y2="90" class="d-msg d-response" data-depends-on="gw3" marker-end="url(#arrowC3r)"></line>
  <line id="d3-b-gw" x1="142" y1="310" x2="216" y2="254" class="d-msg d-request" data-depends-on="gw3" marker-end="url(#arrowC3)"></line>
  <line id="d3-gw-b" x1="236" y1="254" x2="142" y2="336" class="d-msg d-response" data-depends-on="gw3" marker-end="url(#arrowC3r)"></line>
  <line id="d3-gw-c17" x1="312" y1="160" x2="376" y2="96" class="d-msg d-request" data-depends-on="gw3 c17" marker-end="url(#arrowC3)"></line>
  <line id="d3-c17-gw" x1="376" y1="112" x2="314" y2="174" class="d-msg d-response" data-depends-on="gw3 c17" marker-end="url(#arrowC3r)"></line>
  <line id="d3-gw-reg" x1="312" y1="186" x2="376" y2="186" class="d-msg d-request" data-depends-on="gw3 reg3" marker-end="url(#arrowC3)"></line>
  <line id="d3-reg-gw" x1="376" y1="208" x2="312" y2="208" class="d-msg d-response" data-depends-on="gw3 reg3" marker-end="url(#arrowC3r)"></line>
  <line id="d3-gw-c09" x1="312" y1="228" x2="376" y2="290" class="d-msg d-request" data-depends-on="gw3 c09" marker-end="url(#arrowC3)"></line>
  <line id="d3-c09-gw" x1="376" y1="306" x2="314" y2="242" class="d-msg d-response" data-depends-on="gw3 c09" marker-end="url(#arrowC3r)"></line>
  <line id="d3-c17-reg" x1="440" y1="122" x2="440" y2="161" class="d-msg d-request" data-depends-on="c17 reg3" marker-end="url(#arrowC3)"></line>
  <line id="d3-c09-reg" x1="520" y1="268" x2="520" y2="229" class="d-msg d-request" data-depends-on="c09 reg3" marker-end="url(#arrowC3)"></line>
  <line id="d3-c17-st" x1="572" y1="62" x2="646" y2="62" class="d-msg d-request" data-depends-on="c17 st3" marker-end="url(#arrowC3)"></line>
  <line id="d3-st-c17" x1="646" y1="92" x2="572" y2="92" class="d-msg d-response" data-depends-on="c17 st3" marker-end="url(#arrowC3r)"></line>
  <line id="d3-c09-st" x1="572" y1="300" x2="646" y2="300" class="d-msg d-request" data-depends-on="c09 st3" marker-end="url(#arrowC3)"></line>
  <line id="d3-st-c09" x1="646" y1="330" x2="572" y2="330" class="d-msg d-response" data-depends-on="c09 st3" marker-end="url(#arrowC3r)"></line>
  <text x="430" y="390" text-anchor="middle" class="d-label-muted" font-size="10">play Ana and Ben on different gateways, then the owner crashing mid-sentence, then a three-year-old document</text>
  <defs>
    <marker id="arrowC3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowC3r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "doc", "title": "Document", "rows": [["owner", "—"], ["epoch", "—"], ["revision", "—"]]},
{"id": "ed", "title": "Editors", "rows": [["Ana", "—"], ["Ben", "—"]]}
],
"flows": [
{
"id": "gateways",
"label": "Ana and Ben on different gateways",
"nodes": ["gw3", "reg3", "c17", "st3"],
"steps": [
{"el": "d3-a-gw", "payload": "open doc_4471", "set": {"doc.owner": "—", "doc.epoch": "—", "doc.revision": "—", "ed.Ana": "—", "ed.Ben": "—"}, "text": "Monday, 9:00. Ana opens the launch plan. The connection lands on gateway 3, one of 60."},
{"el": "d3-gw-reg", "payload": "owner of doc_4471?", "text": "The gateway asks the registry which server owns the document."},
{"el": "d3-reg-gw", "payload": "none", "ms": 2, "text": "Nobody has had it open since Friday, so nobody does."},
{"el": "d3-gw-c17", "payload": "load doc_4471", "text": "The gateway asks the least-loaded collaboration server, collab-17, to take it."},
{"el": "d3-c17-reg", "payload": "claim doc_4471 → epoch 3", "ms": 2, "set": {"doc.owner": "collab-17", "doc.epoch": "3"}, "text": "collab-17 claims the lease. The document has changed owner twice before, so this is epoch 3."},
{"el": "d3-c17-st", "payload": "epoch 3 · latest snapshot + ops after it", "text": "It sets the document's epoch in the log to 3, then reads the latest snapshot and the operations after it."},
{"el": "d3-st-c17", "payload": "snapshot rev 200 + ops 201–212", "ms": 12, "set": {"doc.revision": "212"}, "text": "The document is in memory at revision 212."},
{"el": "d3-c17-gw", "payload": "text · revision 212", "text": "The text goes back through the gateway."},
{"el": "d3-gw-a", "payload": "revision 212", "set": {"ed.Ana": "rev 212 · via gateway 3"}, "text": "Ana is editing."},
{"el": "d3-b-gw", "payload": "open doc_4471", "text": "A minute later Ben opens the same document. The connection lands on gateway 41."},
{"el": "d3-gw-reg", "payload": "owner of doc_4471?", "text": "Gateway 41 asks the registry."},
{"el": "d3-reg-gw", "payload": "collab-17 · epoch 3", "ms": 2, "set": {"ed.Ben": "rev 212 · via gateway 41"}, "text": "It gets the same answer every gateway gets. Whichever gateway an editor lands on, their messages for doc_4471 reach collab-17."},
{"el": "d3-gw-c17", "payload": "Ben: insert at 31 · base 212", "text": "Ben types, and the operation goes to collab-17, like Ana's."},
{"el": "d3-c17-st", "payload": "append rev 213 if free · epoch 3", "ms": 3, "set": {"doc.revision": "213"}, "text": "The owner transforms it, applies it and appends it as revision 213. The append succeeds because 213 is free and the epoch is still 3."},
{"el": "d3-c17-gw", "payload": "ack Ben → 213 · revision 213 → Ana", "text": "One server orders every operation for this document, whichever gateway each came through."},
{"el": "d3-gw-a", "payload": "revision 213", "set": {"ed.Ana": "rev 213"}, "text": "Ana sees Ben's change."}
]
},
{
"id": "crash",
"label": "The owner crashes mid-sentence",
"nodes": ["gw3", "reg3", "c17", "c09", "st3"],
"steps": [
{"el": "d3-a-gw", "payload": "insert “by end of day ” · seq 31 · base 213", "set": {"doc.owner": "collab-17", "doc.epoch": "3", "doc.revision": "213", "ed.Ana": "seq 31 waiting", "ed.Ben": "rev 213"}, "text": "Ana is typing."},
{"el": "d3-gw-c17", "payload": "Ana seq 31 · base 213", "text": "The gateway forwards it to collab-17."},
{"el": "d3-c17-st", "payload": "append rev 214 · c_ana_7f2 seq 31 · epoch 3", "ms": 3, "set": {"doc.revision": "214"}, "text": "The owner appends it as revision 214, with Ana's client ID and sequence number."},
{"el": "d3-c17-reg", "payload": "lease renewals stop", "text": "Then collab-17 crashes, before sending the acknowledgement. The operation is in the log, but Ana's editor doesn't know that. Lease renewals stop."},
{"el": "d3-gw-reg", "payload": "owner of doc_4471?", "ms": 5000, "set": {"doc.owner": "none · lease lapsed"}, "text": "The gateways lose their connections to collab-17. The lease lapses 5 seconds after the last renewal. Until then, edits wait in the editors, which keep showing them on screen."},
{"el": "d3-reg-gw", "payload": "none", "ms": 2, "text": "No owner."},
{"el": "d3-gw-c09", "payload": "load doc_4471", "text": "The gateway asks collab-09 to take the document."},
{"el": "d3-c09-reg", "payload": "claim doc_4471 → epoch 4", "ms": 2, "set": {"doc.owner": "collab-09", "doc.epoch": "4"}, "text": "collab-09 claims the lease, with epoch 4."},
{"el": "d3-c09-st", "payload": "raise epoch to 4 · then snapshot + ops", "text": "Before reading anything, it raises the document's epoch in the log to 4. From now on, any append carrying epoch 3 is refused. If collab-17 was only frozen and wakes up, it can't write."},
{"el": "d3-st-c09", "payload": "snapshot rev 200 + ops 201–214", "ms": 12, "text": "It loads the snapshot and the operations after it, including 214, with the client ID and sequence number of each."},
{"el": "d3-a-gw", "payload": "hello · last rev 213 · pending seq 31", "text": "Ana's editor reconnects and resends its unacknowledged operation."},
{"el": "d3-gw-c09", "payload": "Ana seq 31 · base 213", "text": "The gateway now sends doc_4471's messages to collab-09."},
{"el": "d3-c09-gw", "payload": "seq 31 is already rev 214 → ack", "text": "collab-09 finds c_ana_7f2's operation 31 already logged as revision 214. It acknowledges it with that revision instead of applying it again."},
{"el": "d3-gw-a", "payload": "ack seq 31 → rev 214", "set": {"ed.Ana": "rev 214 · caught up", "ed.Ben": "rev 214"}, "text": "“by end of day ” appears once. The document paused for about 5 seconds. Nobody lost an edit, and nothing was applied twice."}
]
},
{
"id": "old",
"label": "A three-year-old document",
"nodes": ["gw3", "reg3", "c09", "st3"],
"steps": [
{"el": "d3-b-gw", "payload": "open doc_1020 · Engineering handbook", "set": {"doc.owner": "—", "doc.epoch": "—", "doc.revision": "2.4M ops of history", "ed.Ana": "—", "ed.Ben": "opening"}, "text": "Ben opens the engineering handbook, doc_1020. It has been edited almost every day for three years: 2.4 million operations."},
{"el": "d3-gw-reg", "payload": "owner of doc_1020?", "text": "The gateway asks the registry."},
{"el": "d3-reg-gw", "payload": "none", "ms": 2, "text": "Nobody has it open."},
{"el": "d3-gw-c09", "payload": "load doc_1020", "text": "collab-09 is asked to take it."},
{"el": "d3-c09-reg", "payload": "claim doc_1020 → epoch 12", "ms": 2, "set": {"doc.owner": "collab-09", "doc.epoch": "12"}, "text": "It claims the lease."},
{"el": "d3-c09-st", "payload": "latest snapshot + ops after it", "text": "Replaying 2.4 million operations from an empty document would take about 40 seconds. Instead it asks for the latest snapshot."},
{"el": "d3-st-c09", "payload": "snapshot rev 2,401,000 · 380 KB + 312 ops", "ms": 30, "set": {"doc.revision": "2,401,312"}, "text": "Each owner writes a snapshot every 500 operations, so there are never more than 500 to replay. Here there are 312."},
{"el": "d3-c09-gw", "payload": "text · revision 2,401,312", "text": "The document is ready."},
{"el": "d3-gw-b", "payload": "open in ~50 ms", "set": {"ed.Ben": "rev 2,401,312"}, "text": "The handbook opens as fast as yesterday's notes. How long a document's history is no longer matters."}
]
}
]
}
</script>
<div class="diagram-caption">Editors connect to any gateway. Each open document has one owner, found through a registry of leases with epochs, and every edit to it goes through that owner. Appends to the log succeed only at a free revision and the current epoch, and snapshots every 500 operations keep opening fast.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="gw3">
<strong>If a gateway fails:</strong> its editors reconnect to another within a second or two and resend anything unacknowledged. Owners and documents are unaffected.
</div>
<div class="failure-impact is-hidden" data-component="c17">
<strong>If the owner fails:</strong> its documents pause until their leases lapse, 5 seconds, and new owners load them from the log. Resent operations that were already logged are recognised and not applied twice.
</div>
<div class="failure-impact is-hidden" data-component="reg3">
<strong>If the registry loses its majority:</strong> owners can't renew their leases. Rather than risk two owners, each stops accepting edits when its lease runs out, and every document pauses until the registry is back. Its nodes are spread across three zones, so it takes losing two to get here.
</div>
<div class="failure-impact is-hidden" data-component="c09">
<strong>If collab-09 fails:</strong> the documents it owns move to other servers the same way, each paused for about 5 seconds.
</div>
<div class="failure-impact is-hidden" data-component="st3">
<strong>If the document store fails:</strong> no operation can be appended, so none is acknowledged. Editors keep typing locally and wait. It replicates every write to three zones, so one zone failing changes nothing.
</div>
</div>

Every copy of a document now converges, at any scale, through any failure. But editing together still feels blind. Nobody can see where anyone else is working, so two people start rewriting the same paragraph. A comment stored as "positions 31 to 37" points at the wrong words as soon as anyone types above it. And the history is millions of single keystrokes, which nobody can read, and there's no way to undo a bad hour of edits except by hand.

<!-- stage:4:4. Cursors, Comments, History -->

## Stage 4 — Cursors, Comments and History

- **Cursors are relayed, not logged.** An editor sends its cursor and selection when they move, at most 10 times a second, with the revision it's at. The owner relays them to everyone else in the document. The receiver moves each cursor through any operations it has applied since that revision, exactly as an operation would be transformed. Cursors aren't stored. If one is lost, the next replaces it.
- **Comments are anchored to a range at a revision.** The owner keeps the range of every open comment in memory and moves it with every operation, as it would a cursor. Editors do the same on their own copies. The anchors are saved with each snapshot, along with the revision they're correct at. The comment's text and replies live in a comments database.
- **A comment outlives its text.** When the text a comment is anchored to is deleted, its range shrinks to nothing. The comment stays, and shows the words it was written on, which were stored with it.
- **History groups operations into versions.** A history builder reads the log and closes a version when nobody has edited for 5 minutes, or after 30 minutes of continuous editing. Each version records its last revision, its authors and a snapshot.
- **Restoring is a new edit.** The owner works out the difference between the current text and the version being restored, and applies it as one operation. Nothing in the log is rewritten, everyone receives it like any other edit, and a restore can itself be undone by restoring the version before it.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 880 400" width="880" height="400" role="img" aria-label="Editors connect through gateways to the document owner, which orders operations, relays cursors and moves comment anchors; it appends to the operation log, stores comments in a comments database, and reads versions from a history builder that reads the log">
  <rect x="20" y="40" width="120" height="216" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Ana's Editor</text>
  <text x="80" y="83" text-anchor="middle" class="d-label-muted" font-size="9">sees Ben's cursor</text>
  <rect x="20" y="290" width="120" height="216" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="316" text-anchor="middle" class="d-actor-label" font-size="12">Ben's Editor</text>
  <text x="80" y="333" text-anchor="middle" class="d-label-muted" font-size="9">sees Ana's cursor</text>
  <g data-fail-toggle="gw4">
    <rect x="180" y="150" width="130" height="100" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="245" y="192" text-anchor="middle" class="d-actor-label" font-size="12">Gateways</text>
    <text x="245" y="210" text-anchor="middle" class="d-label-muted" font-size="9">to each doc's owner</text>
  </g>
  <g data-fail-toggle="own4">
    <rect x="380" y="130" width="200" height="140" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="480" y="172" text-anchor="middle" class="d-actor-label" font-size="12">Document Owner</text>
    <text x="480" y="190" text-anchor="middle" class="d-label-muted" font-size="9">orders operations</text>
    <text x="480" y="205" text-anchor="middle" class="d-label-muted" font-size="9">relays cursors, unlogged</text>
    <text x="480" y="220" text-anchor="middle" class="d-label-muted" font-size="9">moves comment anchors</text>
  </g>
  <g data-fail-toggle="log4">
    <rect x="660" y="30" width="190" height="80" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="755" y="64" text-anchor="middle" class="d-actor-label" font-size="12">Op Log + Snapshots</text>
    <text x="755" y="82" text-anchor="middle" class="d-label-muted" font-size="9">as in Stage 3</text>
  </g>
  <g data-fail-toggle="cm4">
    <rect x="660" y="160" width="190" height="80" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="755" y="194" text-anchor="middle" class="d-actor-label" font-size="12">Comments DB</text>
    <text x="755" y="212" text-anchor="middle" class="d-label-muted" font-size="9">threads · anchors · quoted text</text>
  </g>
  <g data-fail-toggle="hist4">
    <rect x="660" y="290" width="190" height="80" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="755" y="324" text-anchor="middle" class="d-actor-label" font-size="12">History Builder</text>
    <text x="755" y="342" text-anchor="middle" class="d-label-muted" font-size="9">operations → versions</text>
  </g>
  <line id="d4-a-gw" x1="142" y1="218" x2="216" y2="146" class="d-msg d-request" data-depends-on="gw4" marker-end="url(#arrowC4)"></line>
  <line id="d4-gw-a" x1="236" y1="146" x2="142" y2="90" class="d-msg d-response" data-depends-on="gw4" marker-end="url(#arrowC4r)"></line>
  <line id="d4-b-gw" x1="142" y1="310" x2="216" y2="254" class="d-msg d-request" data-depends-on="gw4" marker-end="url(#arrowC4)"></line>
  <line id="d4-gw-b" x1="236" y1="254" x2="142" y2="336" class="d-msg d-response" data-depends-on="gw4" marker-end="url(#arrowC4r)"></line>
  <line id="d4-gw-own" x1="312" y1="180" x2="376" y2="180" class="d-msg d-request" data-depends-on="gw4 own4" marker-end="url(#arrowC4)"></line>
  <line id="d4-own-gw" x1="376" y1="220" x2="312" y2="220" class="d-msg d-response" data-depends-on="gw4 own4" marker-end="url(#arrowC4r)"></line>
  <line id="d4-own-log" x1="582" y1="150" x2="656" y2="84" class="d-msg d-request" data-depends-on="own4 log4" marker-end="url(#arrowC4)"></line>
  <line id="d4-log-own" x1="656" y1="102" x2="586" y2="164" class="d-msg d-response" data-depends-on="own4 log4" marker-end="url(#arrowC4r)"></line>
  <line id="d4-own-cm" x1="582" y1="190" x2="656" y2="190" class="d-msg d-request" data-depends-on="own4 cm4" marker-end="url(#arrowC4)"></line>
  <line id="d4-cm-own" x1="656" y1="214" x2="582" y2="214" class="d-msg d-response" data-depends-on="own4 cm4" marker-end="url(#arrowC4r)"></line>
  <line id="d4-own-hist" x1="582" y1="244" x2="656" y2="316" class="d-msg d-request" data-depends-on="own4 hist4" marker-end="url(#arrowC4)"></line>
  <line id="d4-hist-own" x1="656" y1="334" x2="586" y2="258" class="d-msg d-response" data-depends-on="own4 hist4" marker-end="url(#arrowC4r)"></line>
  <path id="d4-log-hist" d="M852,70 L868,70 L868,330 L854,330" class="d-msg d-request" data-depends-on="log4 hist4" marker-end="url(#arrowC4)"></path>
  <text x="440" y="392" text-anchor="middle" class="d-label-muted" font-size="10">play Ben's cursor while Ana types, then a comment on words that move, then restoring yesterday's version</text>
  <defs>
    <marker id="arrowC4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowC4r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "see", "title": "On screen", "rows": [["first line", "—"], ["Ben's cursor", "—"], ["comment", "—"]]},
{"id": "own", "title": "Owner", "rows": [["revision", "—"], ["note", "—"]]}
],
"flows": [
{
"id": "cursor",
"label": "Ben's cursor while Ana types",
"nodes": ["gw4", "own4", "log4"],
"steps": [
{"el": "d4-b-gw", "payload": "cursor · rev 215 · at 24", "set": {"see.first line": "Ship the public beta by Monday.", "see.Ben's cursor": "—", "see.comment": "—", "own.revision": "215", "own.note": "—"}, "text": "Ben clicks just before “Monday”, position 24, to change it again. The editor sends the cursor position and the revision it's at, 59."},
{"el": "d4-gw-own", "payload": "cursor u_ben · rev 215 · 24", "text": "The gateway passes it to the document's owner."},
{"el": "d4-own-gw", "payload": "→ everyone else in doc_4471", "set": {"own.note": "cursors relayed, not logged"}, "text": "The owner relays it to everyone else. Cursor messages aren't logged: there can be 10 a second per person, and a lost one is replaced by the next."},
{"el": "d4-gw-a", "payload": "Ben · rev 215 · 24", "set": {"see.Ben's cursor": "before “Monday”"}, "text": "Ana sees Ben's coloured cursor before “Monday”."},
{"el": "d4-a-gw", "payload": "insert “Draft: ” at 0 · base 215", "set": {"see.first line": "Draft: Ship the public beta by Monday.", "see.Ben's cursor": "before “Monday” · now 31"}, "text": "Ana types “Draft: ” at the start of the line. On Ana's screen, the editor moves Ben's cursor along with the text: it was at 24, and 7 characters went in before it, so it's now at 31."},
{"el": "d4-gw-own", "payload": "Ana's operation", "text": "The operation goes to the owner."},
{"el": "d4-own-log", "payload": "append revision 216", "ms": 3, "set": {"own.revision": "216"}, "text": "It's logged as revision 216."},
{"el": "d4-own-gw", "payload": "revision 216 → Ben", "text": "And sent to Ben."},
{"el": "d4-b-gw", "payload": "selection · rev 215 · 24–30", "text": "Just before revision 216 reached Ben's editor, Ben selected “Monday”: 24 to 30, in the copy at revision 215."},
{"el": "d4-gw-own", "payload": "selection u_ben · rev 215 · 24–30", "text": "Relayed as before."},
{"el": "d4-own-gw", "payload": "→ Ana", "text": "On to Ana."},
{"el": "d4-gw-a", "payload": "Ben · rev 215 · 24–30", "set": {"see.Ben's cursor": "selecting “Monday” · 31–37"}, "text": "Ana's editor is at revision 216. It moves the selection through revision 216, 7 characters inserted before it, to 31–37, and highlights “Monday”. Drawn at the positions it arrived with, it would have highlighted “eta by”."}
]
},
{
"id": "comment",
"label": "A comment on words that move",
"nodes": ["gw4", "own4", "log4", "cm4"],
"steps": [
{"el": "d4-a-gw", "payload": "comment on 31–37 @ rev 216 · “Is Monday realistic?”", "set": {"see.first line": "Draft: Ship the public beta by Monday.", "see.Ben's cursor": "—", "see.comment": "on “Monday” · 31–37", "own.revision": "216", "own.note": "—"}, "text": "Ana selects “Monday” and comments: “Is Monday realistic?” The anchor is positions 31 to 37, at revision 216."},
{"el": "d4-gw-own", "payload": "new comment", "text": "The comment goes to the owner, which starts tracking its anchor in memory."},
{"el": "d4-own-cm", "payload": "cm_301 · 31–37 @ rev 216 · quoted “Monday”", "text": "It's stored with its anchor, the revision the anchor is correct at, and the words it was written on."},
{"el": "d4-cm-own", "payload": "stored", "ms": 5, "text": "Stored."},
{"el": "d4-own-gw", "payload": "cm_301 → everyone", "text": "Everyone in the document sees it in the margin, beside “Monday”."},
{"el": "d4-b-gw", "payload": "insert “Launch plan⏎” at 0 · base 216", "text": "Ben adds a title line above everything: 12 characters, including the line break."},
{"el": "d4-gw-own", "payload": "Ben's operation", "text": "To the owner."},
{"el": "d4-own-log", "payload": "append revision 217", "ms": 3, "set": {"own.revision": "217", "see.comment": "on “Monday” · 43–49", "own.note": "anchor moved with the text"}, "text": "The owner logs it, and moves every comment anchor past it. cm_301 is now 43 to 49. Every editor does the same to its own copy, so the comment stays beside “Monday” on every screen. The anchors are saved with each snapshot, so whoever loads the document later starts from anchors that match its text."},
{"el": "d4-b-gw", "payload": "delete 38 at 12 · base 217", "text": "Then Ben deletes the whole line: “Draft: Ship the public beta by Monday.”"},
{"el": "d4-gw-own", "payload": "Ben's operation", "text": "To the owner."},
{"el": "d4-own-log", "payload": "append revision 218", "ms": 3, "set": {"own.revision": "218", "see.first line": "Launch plan", "see.comment": "on deleted text: “Monday”", "own.note": "anchor 12–12, empty"}, "text": "The anchor's range shrinks to nothing, at position 12."},
{"el": "d4-own-gw", "payload": "cm_301 · on deleted text", "text": "The comment isn't deleted with the text. It stays in the comments list, marked as on deleted text, and shows the word it was written on. Ana's question is still there for Ben to answer."}
]
},
{
"id": "restore",
"label": "Restoring yesterday's version",
"nodes": ["gw4", "own4", "log4", "hist4"],
"steps": [
{"el": "d4-a-gw", "payload": "list versions", "set": {"see.first line": "Launch plan", "see.Ben's cursor": "typing in the timeline", "see.comment": "—", "own.revision": "912", "own.note": "—"}, "text": "On Wednesday morning the timeline has been rewritten in a way the team regrets. The document is at revision 912. Ana opens its history."},
{"el": "d4-gw-own", "payload": "versions of doc_4471", "text": "The request goes to the owner."},
{"el": "d4-log-hist", "payload": "ops → versions, as they're logged", "text": "The history builder has been reading the log all along. It closes a version after 5 minutes without edits, or 30 minutes of continuous editing, and saves a snapshot of each."},
{"el": "d4-own-hist", "payload": "list versions", "text": "The owner asks for the list."},
{"el": "d4-hist-own", "payload": "… Tue 16:20 · Ana, Ben · rev 640 …", "ms": 10, "text": "Eight versions since Monday. Tuesday's 16:20 version ends at revision 640."},
{"el": "d4-own-gw", "payload": "8 versions", "text": "The list goes back to Ana."},
{"el": "d4-gw-a", "payload": "Tue 16:20 · 640", "text": "Ana picks Tuesday 16:20 and restores it."},
{"el": "d4-a-gw", "payload": "restore v_88 (rev 640)", "text": "The restore request goes to the owner like an edit."},
{"el": "d4-gw-own", "payload": "restore to rev 640", "text": "The owner needs the text as it was at 640."},
{"el": "d4-own-hist", "payload": "snapshot at rev 640", "text": "It asks the history builder for that version's snapshot."},
{"el": "d4-hist-own", "payload": "text at rev 640", "ms": 20, "text": "The text as it was at 16:20 on Tuesday."},
{"el": "d4-own-log", "payload": "append rev 913 · Ana · diff 912 → 640", "ms": 3, "set": {"own.revision": "913", "own.note": "641–912 still in the log"}, "text": "The owner works out the difference between the current text and that one, a few deletions and inserts in the timeline, and applies it as one operation, revision 913, by Ana. Revisions 641 to 912 stay in the log."},
{"el": "d4-b-gw", "payload": "insert “ (owner: Ben)” · base 912", "text": "Ben was typing in the timeline at that moment. Ben's operation is based on 912."},
{"el": "d4-gw-own", "payload": "Ben's operation", "text": "It reaches the owner after the restore."},
{"el": "d4-own-log", "payload": "transformed past 913 · append rev 914", "ms": 3, "set": {"own.revision": "914", "see.Ben's cursor": "words kept after the restore"}, "text": "It's transformed against the restore like any other operation. Ben's words survive, in the place the restore left that paragraph."},
{"el": "d4-own-gw", "payload": "913, 914 → everyone", "set": {"see.first line": "Tuesday 16:20's text + Ben's words"}, "text": "Everyone receives the restore as an ordinary edit. If it was a mistake, restoring the version that ended at 912 puts everything back."}
]
}
]
}
</script>
<div class="diagram-caption">The owner relays cursors without logging them, and moves comment anchors with every operation, saving them with each snapshot. A history builder turns the log into versions, and restoring one is applied as a new edit.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="gw4">
<strong>If a gateway fails:</strong> its editors reconnect elsewhere. Their cursors disappear from others' screens for a moment and come back with their next move.
</div>
<div class="failure-impact is-hidden" data-component="own4">
<strong>If the owner fails:</strong> another server takes the document over, as in Stage 3. It rebuilds comment anchors from the last snapshot's anchors and the operations after it. Cursors reappear as people move them.
</div>
<div class="failure-impact is-hidden" data-component="log4">
<strong>If the operation log fails:</strong> no edits are acknowledged. Cursors keep moving, because they don't need the log, so people can still see each other while they wait.
</div>
<div class="failure-impact is-hidden" data-component="cm4">
<strong>If the comments database fails:</strong> comments can't be added or opened. Editing carries on, and the owner keeps moving anchors in memory and saves them when it's back.
</div>
<div class="failure-impact is-hidden" data-component="hist4">
<strong>If the history builder fails:</strong> the version list stops growing and recent versions can't be restored. Editing is unaffected, and the builder catches up from the log.
</div>
</div>

For a team, this is a complete editor. Then on Monday at 9:00 the all-hands notes, `doc_7700`, are sent to the whole company, and 3,000 people open them within two minutes. Their owner now sends every keystroke 3,000 times, and with 100 people editing, it relays 1,000 cursor moves a second to each of 3,000 screens: 3 million messages a second, for one document. Meanwhile Mei, who is in Sydney, is also editing the notes. Every operation from Mei crosses the Pacific to the owner in Virginia and back.

<!-- stage:5:5. A Document Everyone Opens -->

## Stage 5 — A Document Everyone Opens

- **Gateways subscribe, and the owner sends once per gateway.** A gateway with any client in a document subscribes to it. The owner sends each operation once to each subscribed gateway, and the gateway delivers it to its own clients. The gateway also keeps a current copy of the document, so its clients open from that instead of from the owner.
- **The owner commits in batches.** It orders operations as they arrive, but appends them to the log in one write every 10 ms, acknowledging each once its batch is stored ([Storage Engines](#/systems/storage-engines)).
- **Cursors are merged.** The owner keeps only each editor's latest cursor, and every 200 ms sends the ones that changed, in one message per gateway.
- **At most 100 editors at once.** Beyond that, people with edit rights open the document to view and comment, and can edit when someone leaves. Viewers get operations in batches every 500 ms, which they can't tell apart from live.
- **Gateways are in every region, owners in one.** A document's owner sits in one region. Editors elsewhere connect to their nearest gateway, which forwards to the owner. An editor's own typing is applied locally, so distance never slows it. Only others see it a round trip later.
- **The owner moves to where the editors are.** When everyone editing a document has been connected through another region for 10 minutes, the registry moves the document there at the next pause in typing. A server in that region loads it and takes the next epoch, exactly as in a failover ([Multi-Region & Disaster Recovery](#/systems/multi-region-dr)).

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 880 420" width="880" height="420" role="img" aria-label="An editor in Sydney connects to a Sydney gateway and 3,000 people in Virginia connect to 40 Virginia gateways; each gateway subscribes once to the document owner in us-east, which commits operations to the log in batches and is placed by an owner registry that can move it between regions">
  <rect x="20" y="40" width="140" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Mei's Editor</text>
  <text x="90" y="83" text-anchor="middle" class="d-label-muted" font-size="9">Sydney</text>
  <rect x="20" y="290" width="140" height="70" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="318" text-anchor="middle" class="d-actor-label" font-size="12">3,000 People</text>
  <text x="90" y="336" text-anchor="middle" class="d-label-muted" font-size="9">100 edit · 2,900 view</text>
  <g data-fail-toggle="gs5">
    <rect x="200" y="35" width="150" height="70" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="275" y="64" text-anchor="middle" class="d-actor-label" font-size="12">Gateway · Sydney</text>
    <text x="275" y="82" text-anchor="middle" class="d-label-muted" font-size="9">ap-southeast</text>
  </g>
  <g data-fail-toggle="gv5">
    <rect x="200" y="285" width="150" height="80" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="275" y="316" text-anchor="middle" class="d-actor-label" font-size="12">Gateways · Virginia</text>
    <text x="275" y="334" text-anchor="middle" class="d-label-muted" font-size="9">40 hold doc_7700</text>
  </g>
  <g data-fail-toggle="own5">
    <rect x="430" y="135" width="190" height="120" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="525" y="175" text-anchor="middle" class="d-actor-label" font-size="12">Document Owner</text>
    <text x="525" y="193" text-anchor="middle" class="d-label-muted" font-size="9">us-east · epoch 7</text>
    <text x="525" y="208" text-anchor="middle" class="d-label-muted" font-size="9">commits every 10 ms</text>
    <text x="525" y="223" text-anchor="middle" class="d-label-muted" font-size="9">cursors every 200 ms</text>
  </g>
  <g data-fail-toggle="log5">
    <rect x="700" y="40" width="160" height="80" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="780" y="74" text-anchor="middle" class="d-actor-label" font-size="12">Op Log</text>
    <text x="780" y="92" text-anchor="middle" class="d-label-muted" font-size="9">3 zones in us-east</text>
  </g>
  <g data-fail-toggle="reg5">
    <rect x="700" y="290" width="160" height="80" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="780" y="324" text-anchor="middle" class="d-actor-label" font-size="12">Owner Registry</text>
    <text x="780" y="342" text-anchor="middle" class="d-label-muted" font-size="9">moves owners</text>
  </g>
  <line id="d5-m-gs" x1="162" y1="60" x2="196" y2="60" class="d-msg d-request" data-depends-on="gs5" marker-end="url(#arrowC5)"></line>
  <line id="d5-gs-m" x1="196" y1="84" x2="162" y2="84" class="d-msg d-response" data-depends-on="gs5" marker-end="url(#arrowC5r)"></line>
  <line id="d5-c-gv" x1="162" y1="315" x2="196" y2="315" class="d-msg d-request" data-depends-on="gv5" marker-end="url(#arrowC5)"></line>
  <line id="d5-gv-c" x1="196" y1="340" x2="162" y2="340" class="d-msg d-response" data-depends-on="gv5" marker-end="url(#arrowC5r)"></line>
  <line id="d5-gs-own" x1="352" y1="80" x2="426" y2="158" class="d-msg d-request" data-depends-on="gs5 own5" marker-end="url(#arrowC5)"></line>
  <line id="d5-own-gs" x1="426" y1="176" x2="352" y2="100" class="d-msg d-response" data-depends-on="gs5 own5" marker-end="url(#arrowC5r)"></line>
  <line id="d5-gv-own" x1="352" y1="300" x2="426" y2="232" class="d-msg d-request" data-depends-on="gv5 own5" marker-end="url(#arrowC5)"></line>
  <line id="d5-own-gv" x1="426" y1="248" x2="352" y2="318" class="d-msg d-response" data-depends-on="gv5 own5" marker-end="url(#arrowC5r)"></line>
  <line id="d5-own-log" x1="622" y1="160" x2="696" y2="90" class="d-msg d-request" data-depends-on="own5 log5" marker-end="url(#arrowC5)"></line>
  <line id="d5-log-own" x1="696" y1="108" x2="626" y2="176" class="d-msg d-response" data-depends-on="own5 log5" marker-end="url(#arrowC5r)"></line>
  <line id="d5-own-reg" x1="622" y1="222" x2="696" y2="308" class="d-msg d-request" data-depends-on="own5 reg5" marker-end="url(#arrowC5)"></line>
  <line id="d5-reg-own" x1="696" y1="328" x2="622" y2="240" class="d-msg d-response" data-depends-on="own5 reg5" marker-end="url(#arrowC5r)"></line>
  <text x="440" y="410" text-anchor="middle" class="d-label-muted" font-size="10">play the all-hands notes opening, then 100 people typing at once, then an editor in Sydney</text>
  <defs>
    <marker id="arrowC5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowC5r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "doc", "title": "doc_7700 · all-hands notes", "rows": [["open", "—"], ["editing", "—"], ["owner", "—"]]},
{"id": "load", "title": "Owner sends", "rows": [["per edit", "—"], ["cursors", "—"], ["Mei's round trip", "—"]]}
],
"flows": [
{
"id": "opens",
"label": "The all-hands notes open",
"nodes": ["gv5", "own5", "log5"],
"steps": [
{"el": "d5-c-gv", "payload": "3,000 opens in 2 minutes", "set": {"doc.open": "3,000", "doc.editing": "—", "doc.owner": "us-east · epoch 7", "load.per edit": "—", "load.cursors": "—", "load.Mei's round trip": "—"}, "text": "Monday, 9:00. The link to the all-hands notes, doc_7700, goes to the whole company. 3,000 people open it within two minutes, through 40 gateways in Virginia."},
{"el": "d5-gv-own", "payload": "subscribe doc_7700 · ×40", "text": "Each gateway subscribes to the document once, however many of its clients have it open."},
{"el": "d5-own-gv", "payload": "text at rev 1,204 · once per gateway", "ms": 15, "text": "The owner sends each gateway the current text once: 40 copies, not 3,000. The gateway keeps it current from the operations that follow."},
{"el": "d5-gv-c", "payload": "open from the gateway's copy", "text": "Every client opens from its gateway's copy, without touching the owner."},
{"el": "d5-c-gv", "payload": "an editor types · base 1,204", "text": "Someone fixes a typo in the agenda."},
{"el": "d5-gv-own", "payload": "operation", "text": "Their gateway forwards it to the owner."},
{"el": "d5-own-log", "payload": "append rev 1,205", "ms": 3, "text": "Logged as usual."},
{"el": "d5-own-gv", "payload": "rev 1,205 → 40 gateways", "set": {"load.per edit": "40 messages, not 3,000"}, "text": "The owner sends it once to each of the 40 gateways."},
{"el": "d5-gv-c", "payload": "→ 3,000 screens", "text": "Each gateway delivers it to its own clients. The owner's work for each edit no longer depends on how many people are reading."}
]
},
{
"id": "typing",
"label": "100 people typing at once",
"nodes": ["gv5", "own5", "log5"],
"steps": [
{"el": "d5-c-gv", "payload": "100 editors · 200 ops/s · 1,000 cursor moves/s", "set": {"doc.open": "3,000", "doc.editing": "100", "doc.owner": "us-east · epoch 7", "load.per edit": "40 messages", "load.cursors": "—", "load.Mei's round trip": "—"}, "text": "During the meeting, 100 people add notes under their team's heading. Together they send about 200 operations a second, and move their cursors about 1,000 times a second."},
{"el": "d5-gv-own", "payload": "operations + cursors", "text": "All of it goes to the owner."},
{"el": "d5-own-log", "payload": "one append every 10 ms · ~2 operations each", "ms": 3, "text": "The owner orders each operation as it arrives, but writes them to the log together every 10 ms. One write carries a couple of operations here, and dozens in a burst, and each is acknowledged once its batch is stored."},
{"el": "d5-own-gv", "payload": "ops every 10 ms · changed cursors every 200 ms", "set": {"load.cursors": "5 messages/s per gateway"}, "text": "Relaying every cursor move to every screen would be 1,000 moves a second times 3,000 people: 3 million messages a second. The owner keeps only each editor's latest cursor, and every 200 ms sends the ones that changed, together, to each gateway: 5 messages a second each."},
{"el": "d5-gv-c", "payload": "editors live · viewers every 500 ms", "text": "Editors get operations as they come. The 2,900 viewers get them in batches every half second."},
{"el": "d5-c-gv", "payload": "editor 101 opens", "text": "Another person with edit rights opens the document."},
{"el": "d5-gv-own", "payload": "join as editor?", "text": "Their gateway asks the owner for an editing slot."},
{"el": "d5-own-gv", "payload": "view and comment · next free slot", "set": {"doc.editing": "100 · 1 waiting"}, "text": "All 100 are taken. Every editor's app transforms its own pending edits against everyone else's, and with more than 100 people typing, slower laptops and phones fall behind. So the 101st person views and comments, and becomes an editor when someone leaves."}
]
},
{
"id": "sydney",
"label": "An editor in Sydney",
"nodes": ["gs5", "own5", "log5", "gv5", "reg5"],
"steps": [
{"el": "d5-m-gs", "payload": "insert “APAC: ” · base 1,530", "set": {"doc.open": "3,000", "doc.editing": "100", "doc.owner": "us-east · epoch 7", "load.per edit": "40 messages", "load.cursors": "batched", "load.Mei's round trip": "—"}, "text": "Mei, in Sydney, types under the APAC heading. The editor applies it at once, so Mei's typing never waits."},
{"el": "d5-gs-own", "payload": "→ owner in us-east", "ms": 100, "text": "The Sydney gateway forwards the operation to the owner in Virginia, about 100 ms away."},
{"el": "d5-own-log", "payload": "append rev 1,531", "ms": 3, "text": "It's logged with everyone else's."},
{"el": "d5-own-gs", "payload": "ack → 1,531", "ms": 100, "set": {"load.Mei's round trip": "~200 ms"}, "text": "The acknowledgement takes another 100 ms to come back. Mei doesn't notice: the words were on screen before the operation left."},
{"el": "d5-own-gv", "payload": "rev 1,531 → Virginia", "text": "People in Virginia see Mei's words about 100 ms after Mei typed them, plus their own network."},
{"el": "d5-m-gs", "payload": "17:00 in Virginia · only Sydney editing", "text": "At 17:00 in Virginia, the US team closes the notes. It's morning in Sydney, and the APAC team keeps working on their section. For the next 10 minutes, everyone editing doc_7700 is connected through Sydney."},
{"el": "d5-own-reg", "payload": "all editors in ap-southeast for 10 min", "text": "The owner reports where its editors are connected."},
{"el": "d5-reg-own", "payload": "move to ap-southeast · epoch 8", "ms": 50, "set": {"doc.owner": "ap-southeast · epoch 8"}, "text": "At the next pause in typing, the registry moves the document. A server in ap-southeast loads it from the log, takes epoch 8, and gateways are told the new owner. Operations in flight are resent and recognised, as in any failover."},
{"el": "d5-own-gs", "payload": "acks in ~5 ms", "set": {"load.Mei's round trip": "~5 ms"}, "text": "Now the owner is a few milliseconds from Mei. Tomorrow morning, when the US team is back and in the majority, it moves back."}
]
}
]
}
</script>
<div class="diagram-caption">Gateways in each region subscribe to a document once and fan its operations out to their own clients. The owner commits in 10 ms batches and sends cursors every 200 ms, and the registry moves each document's owner to the region its editors are in.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="gs5">
<strong>If the Sydney gateway fails:</strong> editors there reconnect to another Sydney gateway, which subscribes to their documents and resends anything unacknowledged.
</div>
<div class="failure-impact is-hidden" data-component="gv5">
<strong>If a Virginia gateway fails:</strong> its share of the 3,000 reconnect to the other 39, which already hold copies of the document, so the owner sees no rush of opens.
</div>
<div class="failure-impact is-hidden" data-component="own5">
<strong>If the owner fails:</strong> a server in the same region takes the document over after the lease lapses, about 5 seconds, and the gateways resubscribe to it. 3,000 people see a short pause, not a reload.
</div>
<div class="failure-impact is-hidden" data-component="log5">
<strong>If one zone of the log fails:</strong> the other two carry on. If the whole region is lost, its documents move to a paired region, which holds a copy of the log about a second behind. Edits from that last second may be lost.
</div>
<div class="failure-impact is-hidden" data-component="reg5">
<strong>If the registry fails:</strong> documents stay where they are and keep working while their leases can be renewed. No document can move, and none that nobody has open can be opened.
</div>
</div>

This is the full design. Editors apply their own edits immediately and send each one as an operation naming the revision it was written against. Each open document has one owner, found through a registry of leases. The owner transforms each operation past anything accepted since, gives it the next revision, and logs it with a conditional append before acknowledging it. Snapshots every 500 operations keep opening fast, and resent operations are recognised by client ID and sequence number. Cursors are relayed without being stored, comments are anchored to ranges that move with the text, and history is built from the log, with restores applied as new edits. Gateways in every region subscribe to documents once and fan their operations out, owners commit in batches and merge cursors, and each document's owner moves to the region where its editors are.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### Transforming one operation against another

Transforming takes two operations written against the same revision, A and B, where A has already been applied. It produces B′, which has the same effect as B, but on the text after A. The rule that makes the copies agree is that applying A then B′ gives the same text as applying B then A′. Every pair of operation types needs a transform that keeps that rule.

| A, already applied | B, incoming | B′ |
|---|---|---|
| Insert *n* characters at *p* | Insert at *q* | *q* < *p*: unchanged. *q* > *p*: moves to *q* + *n*. *q* = *p*: placed after A's text, on every copy alike |
| Insert *n* characters at *p* | Delete a range | Before *p*: unchanged. After *p*: shifts by *n*. Spanning *p*: split in two, so A's new text survives |
| Delete *n* characters from *p* | Insert at *q* | *q* ≤ *p*: unchanged. *q* ≥ *p* + *n*: moves to *q* − *n*. Inside the deleted range: moves to *p* |
| Delete a range | Delete a range | The part A already deleted is dropped from B; what's left shifts by what A deleted before it |

With a central owner, that one rule is enough. Every operation is transformed only against the owner's own sequence, in one order. Systems where peers exchange operations directly, with no owner, need a second, much harder rule: transforming against several concurrent operations must give the same result in any order. Several published algorithms that claimed it were later shown to break it. Ordering at one owner is what keeps operational transformation tractable.

### The editor's three states

An editor is always in one of three states:

- **In sync**: nothing unacknowledged. A local edit is sent at once, and the editor becomes:
- **Waiting**: one operation in flight. Further local edits are combined into one buffer, and the editor becomes:
- **Waiting with a buffer**: one operation in flight and one buffered. More edits are combined into the buffer.

When an acknowledgement arrives, the buffer is sent and becomes the operation in flight. When another person's operation arrives, it's transformed against the operation in flight and then against the buffer, before it's applied, and both of those are transformed against it in turn. With at most two pending operations, every incoming operation needs at most two transforms. That's what keeps a slow connection from piling up work on the client.

### Operations or CRDTs

A conflict-free replicated data type, or CRDT, takes the other approach: give every character a unique, permanent ID, and position each insert relative to the IDs of its neighbours, not to a number. Operations then merge correctly in any order, with no transforms and no server needed to order them.

| | Operations, one owner per document (this design) | CRDT |
|---|---|---|
| Ordering | The owner gives every operation a revision | None needed; any order converges |
| Server | Required for every edit to be shared | Optional; peers can sync directly |
| Size | An operation is positions and text | Every character carries an ID, and deleted characters stay as markers |
| Offline for days | Works, as one large transform on reconnect | Natural |
| Hardest part | A correct transform for every pair of operation types | Memory, load time and cleaning up deleted markers |

This design has a server in the path anyway, for permissions, history and comments, so it gets ordering at no extra cost and keeps documents small. Products built to work offline first, or without a server at all, choose CRDTs and pay in metadata. Recent CRDT implementations have cut that cost a long way.

### Rich text and structure

Plain text is a string. A document has bold words, headings, lists, tables and images. Formatting is carried as attributes on the operations: "keep 6 characters and make them bold" is a `retain` with an attribute. A paragraph's style, such as heading or bullet, is an attribute on the line break that ends it. An image or a table is one embedded object with a length of 1. Each new kind of structure needs transforms against every other kind: what happens when one person bolds a word while another deletes half of it, or one person adds a table row while another deletes the table. This is where most of the work in a real editor goes.

### Undo

Undo reverses your own last edit, not the document's last edit. Pressing undo after Ben has typed should remove Ana's words, not Ben's. Each editor keeps the inverse of its own recent operations. To undo one, it transforms the inverse through every operation applied after the original, so that it removes the right characters from today's text, then sends it as a new operation. To everyone else, an undo is just another edit.

### Checking that copies agree

A bug in a transform function doesn't crash anything. It leaves two copies that differ, quietly. So every 100 revisions, each editor sends a short hash of its text at that revision, and the owner compares it with its own. A mismatch makes that editor reload from the owner, any unacknowledged edits are re-applied on top, and the operations involved are logged for investigation. The owner's copy, rebuilt from the log, is always the one that counts.

### Keeping the log small

Every keystroke is useful for a while: for transforming late operations, for recovering after a failover, for showing who typed what. After 30 days, nobody needs single keystrokes. The operations within each version are merged into one operation per version, and the version snapshots are kept. History still shows every version and its authors. A month-old document that was 4 million operations becomes a few hundred.

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### One owner per document

Every edit to a document goes through one server. One server can order tens of thousands of operations a second, far more than 100 people can type, so throughput isn't the limit. The cost is availability: when an owner fails, its documents pause for the 5 seconds it takes the lease to lapse. Shorter leases mean shorter pauses, but more false takeovers when an owner is only slow.

### Transform functions are the riskiest code

Every new kind of content needs transforms against every existing kind, and a mistake doesn't fail loudly. It makes copies drift apart. Exhaustive tests that apply random pairs of operations in both orders and compare the results, and the hash checks in production, are what keep this safe.

### Distance to the owner

An editor far from the owner sees others' edits later and has a slower acknowledgement, though never slower typing. Moving the owner helps when one region dominates. A document edited all day by equal teams in Sydney and Virginia is always slow for one of them.

### Long offline sessions

An editor that comes back after a day with a hundred operations is merged correctly. The result can still surprise people. A sentence rewritten offline lands in the middle of a paragraph that someone else has restructured. Text converges, but intent doesn't always survive. Editors that have been offline for a long time show what changed when they reconnect.

### The editor limit

Capping a document at 100 editors keeps every client able to keep up. In a meeting where everyone is meant to write, the 101st person has to wait. Raising the limit costs CPU in every editor's browser, not on the server.

### Detailed history against storage

Keystroke-level history for 30 days costs about 125 TB, and after that, history is version by version. Keeping it longer helps with disputes and audits. Keeping it shorter saves storage but makes recovery after a bad edit coarser.

### Durability across regions

The log is written to three zones before an edit is acknowledged, but copied to another region asynchronously. Waiting for a second region on every keystroke would add 50 to 100 ms to every acknowledgement. The cost is that losing a whole region can lose the last second of edits.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

The document is someone's work, often confidential. The editor runs content written by other people in every viewer's browser. The risks are reading or changing what you shouldn't, and turning a document into an attack on the people who open it ([Security & Authentication](#/systems/security-authentication)).

### Checking permission on every operation

Permission is checked when a document opens, and the owner checks the editor's role on every operation it accepts. Viewers and commenters can't send edits. When someone's access is removed, the permission service tells the owner, which closes that person's session at once, rather than waiting for them to reload.

### Hostile operations

An editor is a program the user controls, and anyone can send hand-made messages. The owner checks every operation against the revision it names: lengths must add up, positions must be inside the text, and attributes must be ones the product knows. Documents have a size limit, and each editor has an operation rate limit, so nobody can grow a document without bound or flood its owner ([Rate Limiting](#/systems/rate-limiting)).

### Content that runs code

A link, an embedded image or a pasted block of HTML can try to run script in the browsers of everyone who opens the document. Content is stored as operations and attributes, never as raw HTML. Links are allowed only with safe schemes, so not `javascript:`, and embeds only from approved sources, rendered in a sandbox ([Frontend Security](#/systems/frontend-security)).

### Deleted text lives on in history

Someone pastes a password, notices, and deletes it. It's still in the log and in history. Version history is shown only to people who can edit the document. Owners of a document can permanently remove a range from its history, which rewrites the affected snapshots and deletes the operations that contain it.

### Shared links

Document IDs are long and random, so they can't be guessed. "Anyone with the link" access is off by default for companies, can be limited to people in the same organisation, and can be set to view-only.

### Who's reading

Showing everyone in a document is useful in a team, and revealing in a company-wide document. Viewers from outside the organisation are shown without their names, and organisations can turn off showing viewers at all, leaving only editors visible.

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **Edits**: time from an operation reaching the owner to its acknowledgement, and from the owner to other editors' screens, at p50 and p99, per region.
- **Agreement**: hash mismatches per million operations.
- **Ownership**: lease changes per hour, documents paused right now, and how long takeovers take.
- **The log**: append latency, failed conditional appends, and replication lag to the paired region.
- **Opening**: open time at p99, and the number of operations replayed after the snapshot.
- **Snapshots**: operations since the last snapshot for each open document, and snapshot write failures.
- **Busy documents**: the documents with the most people in them, and the number at their editor limit.

([Observability](#/systems/observability))

### What to alert on

- **Any hash mismatch rate above the usual background.** It means a transform is wrong for some pair of operations, usually after a release. Page, and be ready to roll the release back.
- Edits from the owner to other editors above **500ms** at p99 in any region.
- More than **1%** of documents changing owner in an hour.
- Failed conditional appends from an owner that holds a current lease, which means two servers believe they own one document.
- Any document more than **2,000** operations past its last snapshot.
- Open time p99 above **1 second**.

### "Two people in the same document see different text" — what happens?

The hash checks should already have caught it and reloaded one of them. Find the mismatches for the document, and the operations either side of the revision where the hashes first differ. Replay those operations in both orders through the current transform functions. A pair that gives different results is the bug. Check whether a release of the editor or the owner went out shortly before the mismatches started.

### "A document keeps showing 'Reconnecting'" — what happens?

Look at the document's lease history. Frequent owner changes mean the owner is losing its lease, usually because it's overloaded or paused, and the document keeps moving. Check the owner's CPU and pauses, and whether the document is unusually busy or large. If the owner is stable, look at the gateways the affected editors are on, and at failed appends: an old owner still trying to write is a sign the epoch check is doing its job, and something kept that server running.

### "Opening documents has become slow" — what happens?

Check how many operations are replayed after the snapshot on each open. If it's high, snapshots aren't being written: look for snapshot write failures and for owners that have fallen behind on them. If replay is short but opens are still slow, the time is in reading the snapshot from the object store, or in claiming the lease at the registry, so look at those latencies next.
