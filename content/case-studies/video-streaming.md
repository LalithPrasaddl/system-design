# Video Streaming Platform

A video platform takes a file from someone's phone and plays it, without stopping, on any screen in the world. Two very different systems sit behind that sentence. The first takes one upload and turns it into many versions: slow, expensive work that can be done in pieces and repeated if a piece fails. The second delivers those versions to millions of people at once: simple work, but so many bytes that one region's network could never carry them. And the viewer's connection keeps changing the whole time, on a train, in a lift, on a busy evening. This case study builds the platform for 300 million viewers a day, 25 million watching at the peak, and half a million new videos a day.

<!-- tab:requirements:Requirements -->

## Requirements

This case study builds the service that accepts videos, prepares them, and streams them on demand. The running example is Maya, a cook in Lisbon who films a 10-minute video called "Knife Skills" on a phone, and Theo, who watches it on a commuter train outside Manchester.

### Functional requirements

- **Upload**: creators upload videos of up to several hours from a phone or a browser, and a dropped connection doesn't lose what was already sent.
- **Prepare**: each upload is checked and converted into versions that play on every device and connection speed.
- **Play**: a viewer presses play, and the video starts quickly and keeps playing as their connection changes.
- **Seek**: a viewer can jump to any point in the video.
- **Control access**: videos can be public, unlisted or private, can be limited by country, and can be taken down.
- **Count views**: creators see view counts and watch time within minutes.

### Non-functional requirements

- **Start time:** playback starts within **1 second** at p50 and **4 seconds** at p99.
- **Smoothness:** viewers spend under **0.5%** of watch time waiting for the video to buffer.
- **Time to ready:** a 10-minute video is playable within **5 minutes** of its upload finishing at p50, and within **30 minutes** at p99.
- **Durability:** a source file whose upload was confirmed is **never lost**.
- **Availability:** 99.99% of playback starts and segment requests succeed.
- **Scale:** **25 million** concurrent viewers and **75 Tbps** delivered at peak, and **500,000** uploads a day.

### In scope

Resumable uploads, the encoding pipeline, adaptive bitrate playback, segments and manifests, the edge cache and the tiers behind it, signed playback, popularity-driven encoding and storage, view events, and steering viewers away from a struggling network path.

### Out of scope

**Recommendations and home feeds**: this design serves whichever video was picked. **Comments and channels**, which look like the [News Feed](#/systems-case-studies/news-feed). **Search**, covered in [Search Indexing](#/systems/search-indexing). **Ads and payments**. **Live streaming**: the differences are in Deep Dives.

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

Writes here are heavy but few. Reads are simple but enormous. What shapes the design is one number: the bytes leaving the system at the evening peak.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Viewers</div>
<div class="stat-tile-value">~300<span class="stat-tile-unit">M/day</span></div>
<div class="stat-tile-sub">~40 minutes each</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Watching at once</div>
<div class="stat-tile-value">~25<span class="stat-tile-unit">M</span></div>
<div class="stat-tile-sub">at peak · 8M on average</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Delivered at peak</div>
<div class="stat-tile-value">~75<span class="stat-tile-unit">Tbps</span></div>
<div class="stat-tile-sub">~270 PB a day</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Segment requests</div>
<div class="stat-tile-value">~6<span class="stat-tile-unit">M/s</span></div>
<div class="stat-tile-sub">at peak · one per 4 s per viewer</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Uploads</div>
<div class="stat-tile-value">~500<span class="stat-tile-unit">K/day</span></div>
<div class="stat-tile-sub">~35 Gbps coming in</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">New storage</div>
<div class="stat-tile-value">~750<span class="stat-tile-unit">TB/day</span></div>
<div class="stat-tile-sub">half sources, half encoded</div>
</div>
</div>

### Assumptions

- **300 million** viewers a day, watching **40 minutes** each on average, at an average delivered bitrate of **3 Mbps**.
- The busiest hour carries **3 times** the average load.
- A viewer watches about **6 minutes** of a video, so 2 billion plays a day.
- **500,000** uploads a day, **10 minutes** long on average, at about **10 Mbps**.
- Each video is encoded at **5 qualities**, from 240p to 1080p, totalling about 10 Mbps.
- Encoding all 5 costs about **20 CPU-minutes** per minute of video.

### Delivery

300 million viewers × 40 minutes is 200 million hours of video a day. Spread over 24 hours, that's 8.3 million people watching at any moment, and about **25 million at peak**. At 3 Mbps each, peak delivery is **75 Tbps**, and the daily total is about **270 PB**.

A single server can push about 40 Gbps of video. 75 Tbps needs about **1,900 servers** doing nothing else, with no headroom, and they can't all sit in one place: no single location has 75 Tbps of connections to the rest of the internet.

### Requests

Each viewer fetches one 4-second segment every 4 seconds: 25 million ÷ 4 is about **6 million requests a second** at peak. Plays are far fewer. 2 billion a day is 23,000 a second on average, and about **70,000 a second** at peak.

### Uploads

500,000 videos × 750 MB is **375 TB** of source files a day, about **35 Gbps** coming in. The encoded versions add up to about the same again, because the 5 qualities total about 10 Mbps. So storage grows by about **750 TB a day**, or 270 PB a year. Five years of uploads is about 900 million videos and **1.4 EB** of data.

### Encoding

500,000 videos × 10 minutes is 5 million minutes of video a day. At 20 CPU-minutes each, that's 100 million CPU-minutes a day, a steady **70,000 CPU cores**, and about twice that when uploads peak.

### Metadata

900 million videos at about 2 KB a row is about 2 TB. It's tiny next to the video, and read 70,000 times a second at peak.

<!-- tab:api-design:API Design -->

## API Design

The API handles metadata and permissions. Bytes go around it: uploads go straight to storage using signed URLs, and playback fetches plain files from the nearest cache.

### Upload

```
POST /v1/uploads
{"title": "Knife Skills", "size": 943718400, "sha256": "5e1c70ab…"}
→ 201 {"video_id": "v_48213", "upload_id": "up_9921",
       "part_size": 8388608, "parts": 113}

POST /v1/uploads/up_9921/urls  {"parts": [1, 2, 3, 4]}
→ 200 {"urls": {"1": "https://store…/up_9921/1?sig=…", …}}     -- signed, for 1 hour

PUT https://store…/up_9921/1      8 MB of bytes
→ 200 {"etag": "a7c3…"}

GET /v1/uploads/up_9921
→ 200 {"stored_parts": [1, 2, …, 101]}

POST /v1/uploads/up_9921/complete
→ 202 {"video_id": "v_48213", "status": "processing"}
```

### Video status

```
GET /v1/videos/v_48213
→ 200 {"status": "ready", "duration_s": 600, "title": "Knife Skills",
       "visibility": "public", "views": 1204}
```

### Starting playback

```
POST /v1/videos/v_48213/play
→ 200 {"manifest": "/v/v_48213/2/master.m3u8",
       "hosts": ["man-2.edge.example", "lon-5.edge.example"],
       "token": "exp=1793400000~v=v_48213~sig=9bd2…",
       "session_id": "s_771c"}
→ 403 {"error": "not_available_in_country"}
→ 404 {"error": "not_found"}
→ 409 {"error": "not_ready", "status": "processing"}
```

### Manifests and segments

```
GET /v/v_48213/2/master.m3u8?token=…
#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360,CODECS="avc1.4d401e"
h264_360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f"
h264_720p/index.m3u8
…

GET /v/v_48213/2/h264_720p/index.m3u8?token=…
#EXT-X-TARGETDURATION:4
#EXTINF:4.000,
seg_000.m4s
#EXTINF:4.000,
seg_001.m4s
…

GET /v/v_48213/2/h264_720p/seg_041.m4s?token=…
→ 200 1.25 MB, Cache-Control: public, max-age=31536000, immutable
```

### Events

```
POST /v1/events                                   -- every 30 seconds while playing
{"session_id": "s_771c", "video_id": "v_48213", "position_s": 184,
 "watched_s": 30, "rendition": "h264_720p", "stall_ms": 0,
 "host": "man-2.edge.example", "measured_kbps": 8200}
→ 204
```

| Code | Meaning |
|---|---|
| `200` | Done |
| `201` | Upload session created |
| `202` | Accepted; encoding has started |
| `204` | Events received |
| `400` | The upload is incomplete, or its hash doesn't match |
| `403` | The token is missing, expired or for another video, or the video isn't available here |
| `404` | No such video, or it's private |
| `409` | The video isn't ready to play |
| `410` | The video was removed |
| `413` | Over the size limit |
| `429` | Over the upload or event rate |

### Why the details matter

**Bytes skip the API.** Signed URLs let the phone write parts directly to the object store. An app server handling 35 Gbps of uploads would only be copying bytes from one socket to another.

**Each part is its own upload.** A dropped connection loses at most one 8 MB part. The phone asks which parts are stored and sends the rest. Sending a part twice just replaces it ([Idempotency](#/systems/idempotency)).

**A manifest is a list of files.** Video playback is ordinary HTTP. There's no streaming protocol on the server, so anything that can cache a file can serve video.

**Segment URLs never change their contents.** The path holds the video, the manifest version and the rendition. Re-encoding a video writes a new version under a new path, so a cached segment can never be out of date, and it can be cached for a year.

**The play call is the only per-viewer request.** It checks permissions and hands out a token and a list of hosts. Everything after that is the same files for everyone.

<!-- tab:data-model:Data Model -->

## Data Model

Metadata and video are stored apart. Metadata is small and changes. Video is huge and never changes after it's written.

### Videos

```
videos                                   -- sharded by video_id
  video_id          TEXT PRIMARY KEY     -- v_48213
  owner_id          TEXT                 -- c_2207
  title             TEXT                 -- Knife Skills
  status            TEXT                 -- uploading | processing | ready | failed | removed
  visibility        TEXT                 -- public | unlisted | private
  blocked_countries TEXT[]               -- []
  duration_s        INT                  -- 600
  source_key        TEXT                 -- src/v_48213/original.mov
  manifest_version  INT                  -- 2 (raised when new encodings are added)
  created_at        TIMESTAMP

renditions
  video_id          TEXT
  version           INT                  -- PRIMARY KEY (video_id, version, name)
  name              TEXT                 -- h264_720p
  codec             TEXT                 -- h264 | av1
  height            INT                  -- 720
  bitrate_kbps      INT                  -- 2500
  segments          INT                  -- 150
```

### Encoding work

```
encode_workflows
  workflow_id       TEXT PRIMARY KEY     -- wf_60214
  video_id          TEXT
  kind              TEXT                 -- first_encode | av1
  lane              TEXT                 -- upload | background
  state             TEXT                 -- probe | split | encode | package | done | failed

encode_tasks
  workflow_id       TEXT
  part              INT                  -- 7
  rendition         TEXT                 -- h264_720p; PRIMARY KEY (workflow_id, part, rendition)
  state             TEXT                 -- queued | leased | done | failed
  attempts          INT                  -- 1
  lease_until       TIMESTAMP            -- a dead worker's task goes back on the queue
```

### The object store

```
src/v_48213/original.mov                  the source, kept forever
work/wf_60214/part_07/h264_720p.mp4       encoded parts, deleted after packaging
v/v_48213/1/master.m3u8                   manifest version 1
v/v_48213/1/h264_720p/index.m3u8          list of segments in this rendition
v/v_48213/1/h264_720p/seg_041.m4s         1.25 MB, 4 seconds of video
```

### Views and popularity

```
view_counts                              -- key-value, updated from the event stream
  (v_48213, 2026-10-30T18)               → {views: 41260, watched_s: 14853600}

popularity                               -- in memory, rebuilt from the stream
  v_48213 → {last_10_min: 40000, usual_10_min: 1, tier: hot, av1: true}

steering                                 -- preferred sites by network
  (isp: northway, area: manchester)      → [lon-5, man-2]
```

### Why this storage

Video rows are read far more than they're changed, and each is looked up by ID, so a sharded relational store with replicas and an in-memory cache in front handles them easily ([Partitioning & Sharding](#/systems/partitioning-sharding), [Caching](#/systems/caching)). Encoded video is written once and read by key, which is what an object store does: cheap, replicated, and with no need for an index on anything but the name ([Replication](#/systems/replication)). View events are too many and too unimportant to write one at a time, so they flow through a stream and arrive as counts ([Batch vs Stream](#/systems/batch-vs-stream)).

<!-- tab:architecture:Architecture:default -->

This case study builds the video platform up in five stages. Each stage fixes a specific failure of the one before. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one request at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. One File on One Server -->

## Stage 1 — One File on One Server

The simplest video site stores the file exactly as it was uploaded and links to it. The browser's `<video>` tag does the rest. It fetches the file with HTTP range requests, starts playing once enough has arrived, and asks for a later byte range when the viewer seeks.

```
POST /videos                      ← the whole file
GET  /files/knife-skills.mov      Range: bytes=0-
→ 206 Partial Content
```

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 780 300" width="780" height="300" role="img" aria-label="Maya's phone uploads a whole file to an app server, which stores it on its disk and adds a database row; Theo's phone fetches the file from the same server with range requests">
  <rect x="20" y="40" width="140" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Maya's Phone</text>
  <text x="90" y="83" text-anchor="middle" class="d-label-muted" font-size="9">uploads the whole file</text>
  <rect x="20" y="190" width="140" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="216" text-anchor="middle" class="d-actor-label" font-size="12">Theo's Phone</text>
  <text x="90" y="233" text-anchor="middle" class="d-label-muted" font-size="9">video tag · range requests</text>
  <g data-fail-toggle="app1">
    <rect x="260" y="95" width="180" height="110" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="350" y="130" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
    <text x="350" y="148" text-anchor="middle" class="d-label-muted" font-size="9">takes uploads</text>
    <text x="350" y="163" text-anchor="middle" class="d-label-muted" font-size="9">serves files · 10 Gbps</text>
  </g>
  <g data-fail-toggle="disk1">
    <rect x="560" y="100" width="200" height="100" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="660" y="131" text-anchor="middle" class="d-actor-label" font-size="12">Disk + Database</text>
    <text x="660" y="149" text-anchor="middle" class="d-label-muted" font-size="9">files as uploaded</text>
    <text x="660" y="164" text-anchor="middle" class="d-label-muted" font-size="9">one row per video</text>
  </g>
  <line id="v1-m-app" x1="162" y1="62" x2="256" y2="118" class="d-msg d-request" data-depends-on="app1" marker-end="url(#arrowV1)"></line>
  <line id="v1-app-m" x1="256" y1="140" x2="162" y2="86" class="d-msg d-response" data-depends-on="app1" marker-end="url(#arrowV1r)"></line>
  <line id="v1-t-app" x1="162" y1="212" x2="256" y2="168" class="d-msg d-request" data-depends-on="app1" marker-end="url(#arrowV1)"></line>
  <line id="v1-app-t" x1="256" y1="190" x2="162" y2="236" class="d-msg d-response" data-depends-on="app1" marker-end="url(#arrowV1r)"></line>
  <line id="v1-app-disk" x1="442" y1="136" x2="556" y2="136" class="d-msg d-request" data-depends-on="app1 disk1" marker-end="url(#arrowV1)"></line>
  <line id="v1-disk-app" x1="556" y1="166" x2="442" y2="166" class="d-msg d-response" data-depends-on="app1 disk1" marker-end="url(#arrowV1r)"></line>
  <text x="390" y="290" text-anchor="middle" class="d-label-muted" font-size="10">play the upload and first watch, then Theo on the train, then the video getting popular</text>
  <defs>
    <marker id="arrowV1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowV1r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "vid", "title": "knife-skills.mov", "rows": [["stored", "—"], ["bitrate", "—"]]},
{"id": "pl", "title": "Playback", "rows": [["viewer's speed", "—"], ["status", "—"], ["server's 10 Gbps", "—"]]}
],
"flows": [
{
"id": "first",
"label": "Upload, then a first watch",
"nodes": ["app1", "disk1"],
"steps": [
{"el": "v1-m-app", "payload": "POST knife-skills.mov · 900 MB", "set": {"vid.stored": "uploading", "vid.bitrate": "12 Mbps", "pl.viewer's speed": "—", "pl.status": "—", "pl.server's 10 Gbps": "—"}, "text": "Maya films a 10-minute video at 12 Mbps: 900 MB. On a 30 Mbps home connection, the upload takes 4 minutes."},
{"el": "v1-app-disk", "payload": "write file · insert row", "text": "The app server writes the file to its disk exactly as it arrived, and adds a row."},
{"el": "v1-disk-app", "payload": "saved", "ms": 40, "set": {"vid.stored": "900 MB · as uploaded"}, "text": "Stored."},
{"el": "v1-app-m", "payload": "201 · /files/knife-skills.mov", "text": "Maya gets a link."},
{"el": "v1-t-app", "payload": "GET · Range: bytes=0-", "set": {"pl.viewer's speed": "50 Mbps · home Wi-Fi", "pl.status": "starting"}, "text": "That evening, Theo opens the link at home. The video tag asks for the file from the first byte."},
{"el": "v1-app-disk", "payload": "read file", "text": "The server reads from the disk."},
{"el": "v1-disk-app", "payload": "bytes", "ms": 10, "text": "The bytes come back."},
{"el": "v1-app-t", "payload": "206 · bytes as fast as they'll go", "set": {"pl.status": "playing", "pl.server's 10 Gbps": "12 Mbps in use"}, "text": "Theo's connection is four times faster than the video needs, so it plays smoothly. Dragging the slider to 7:20 makes the browser request a byte range about 73% into the file, and it works. For one viewer on a good connection, this is a complete video site."}
]
},
{
"id": "train",
"label": "Theo on the train",
"nodes": ["app1", "disk1"],
"steps": [
{"el": "v1-t-app", "payload": "GET · Range: bytes=0-", "set": {"vid.stored": "900 MB · as uploaded", "vid.bitrate": "12 Mbps", "pl.viewer's speed": "3 Mbps · train", "pl.status": "starting", "pl.server's 10 Gbps": "—"}, "text": "The next morning, Theo tries again on the train, on a 3 Mbps mobile connection."},
{"el": "v1-app-disk", "payload": "read file", "text": "The server reads the same file. There is only one."},
{"el": "v1-disk-app", "payload": "bytes", "ms": 10, "text": "12 Mbps of video, whoever is asking."},
{"el": "v1-app-t", "payload": "10 s of video in 40 s", "set": {"pl.status": "10 s playing · 30 s frozen"}, "text": "Theo's connection delivers 3 Mbps, so 10 seconds of video takes 40 seconds to arrive. It plays for 10 seconds and freezes for 30. A smaller version would play perfectly on this connection, but no such version exists."},
{"el": "v1-t-app", "payload": "same file · a 2016 tablet", "set": {"pl.viewer's speed": "20 Mbps · tablet"}, "text": "At home, the same link is opened on an old tablet."},
{"el": "v1-app-t", "payload": "206 · HEVC video", "set": {"pl.status": "sound, black screen"}, "text": "Maya's phone recorded in HEVC, and the tablet can't decode it. The site serves whatever the camera produced, and many screens can't play that."}
]
},
{
"id": "popular",
"label": "The video gets popular",
"nodes": ["app1", "disk1"],
"steps": [
{"el": "v1-t-app", "payload": "100 viewers", "set": {"vid.stored": "900 MB · as uploaded", "vid.bitrate": "12 Mbps", "pl.viewer's speed": "plenty", "pl.status": "playing", "pl.server's 10 Gbps": "1.2 Gbps · 12%"}, "text": "A food blog links to the video. 100 people watch at once, each pulling 12 Mbps."},
{"el": "v1-app-disk", "payload": "read 100 places in one file", "text": "They're all at different points in the video, so the disk seeks constantly."},
{"el": "v1-disk-app", "payload": "bytes", "ms": 15, "text": "It keeps up."},
{"el": "v1-app-t", "payload": "12 Mbps × 100", "text": "The app server is busy, but fine."},
{"el": "v1-t-app", "payload": "833 viewers", "set": {"pl.server's 10 Gbps": "10 Gbps · full"}, "text": "At 833 viewers, the server's 10 Gbps connection is full."},
{"el": "v1-app-t", "payload": "everyone gets less", "set": {"pl.status": "everyone stalling"}, "text": "The 834th viewer doesn't simply get turned away. Every viewer now gets slightly less than the video needs, so everyone starts to stall."},
{"el": "v1-m-app", "payload": "POST new-video.mov", "text": "Maya tries to upload another video over the same full connection, to the same server."},
{"el": "v1-app-m", "payload": "timeout at 90%", "set": {"vid.stored": "new video lost at 810 MB"}, "text": "At 90%, the upload times out, and the server discards the partial file. Maya has to start again from the first byte."}
]
}
]
}
</script>
<div class="diagram-caption">One server takes uploads and serves files. The file is stored as uploaded, and viewers fetch it with range requests.</div>
</div>

<div class="fail-hint">Click the app server or the disk to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="app1">
<strong>If the app server fails:</strong> no one can upload or watch anything until it's back.
</div>
<div class="failure-impact is-hidden" data-component="disk1">
<strong>If the disk fails:</strong> every video is unavailable. If it can't be recovered, every video is gone, because this disk held the only copy.
</div>
</div>

Everything depends on the camera's file. Its format decides who can play it. Its bitrate decides who can keep up. Uploading it is all or nothing. Before anyone can watch, each upload needs to be turned into versions that suit every screen and connection, and that takes far more computing than receiving a file does.

<!-- stage:2:2. The Encoding Pipeline -->

## Stage 2 — The Encoding Pipeline

- **Uploads go straight to an object store, in parts.** The phone asks the upload service for signed URLs and writes 8 MB parts directly. If the connection drops, it asks which parts are stored and sends the rest. The object store keeps three copies ([Replication](#/systems/replication)).
- **The source is never changed.** It's kept for good, so every future format can be made from the original.
- **Encoding becomes a workflow of small tasks.** Check the file, split it into one-minute parts, encode each part at each of 5 qualities, then join each quality back into one file. Workflow state is saved after each step ([Message Queues](#/systems/message-queues), [Distributed Task Queue](#/systems-case-studies/distributed-task-queue)).
- **Workers lease tasks from a queue.** A worker that dies loses its lease, and only its task runs again. Output goes to a path named after the part and quality, so a repeated task simply overwrites the same file ([Idempotency](#/systems/idempotency)).
- **Every quality uses one widely supported format.** H.264 video in MP4 plays on nearly every device made in the last 15 years.
- **Playback waits for the status to change.** The row stays `processing` until every version exists, so nobody can open a half-prepared video.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 900 430" width="900" height="430" role="img" aria-label="Maya's phone creates an upload at the upload service and writes parts to the object store; the upload service records the video in the database and starts a workflow, which sends tasks to encode workers that read and write the object store and reports status to the database; viewers ask a video service that reads the database and the object store">
  <rect x="20" y="60" width="130" height="85" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="85" y="97" text-anchor="middle" class="d-actor-label" font-size="12">Maya's Phone</text>
  <text x="85" y="114" text-anchor="middle" class="d-label-muted" font-size="9">sends 8 MB parts</text>
  <rect x="20" y="320" width="130" height="80" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="85" y="355" text-anchor="middle" class="d-actor-label" font-size="12">Theo's Phone</text>
  <text x="85" y="372" text-anchor="middle" class="d-label-muted" font-size="9">picks one quality</text>
  <g data-fail-toggle="up2">
    <rect x="250" y="30" width="170" height="75" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="335" y="62" text-anchor="middle" class="d-actor-label" font-size="12">Upload Service</text>
    <text x="335" y="80" text-anchor="middle" class="d-label-muted" font-size="9">signed URLs · part list</text>
  </g>
  <g data-fail-toggle="os2">
    <rect x="250" y="170" width="170" height="100" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="335" y="208" text-anchor="middle" class="d-actor-label" font-size="12">Object Store</text>
    <text x="335" y="226" text-anchor="middle" class="d-label-muted" font-size="9">source · 5 quality files</text>
    <text x="335" y="241" text-anchor="middle" class="d-label-muted" font-size="9">3 copies</text>
  </g>
  <g data-fail-toggle="vs2">
    <rect x="250" y="320" width="170" height="80" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="335" y="355" text-anchor="middle" class="d-actor-label" font-size="12">Video Service</text>
    <text x="335" y="372" text-anchor="middle" class="d-label-muted" font-size="9">status · serves files</text>
  </g>
  <g data-fail-toggle="wf2">
    <rect x="530" y="30" width="170" height="75" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="615" y="62" text-anchor="middle" class="d-actor-label" font-size="12">Workflow + Queue</text>
    <text x="615" y="80" text-anchor="middle" class="d-label-muted" font-size="9">steps · tasks · leases</text>
  </g>
  <g data-fail-toggle="enc2">
    <rect x="720" y="165" width="160" height="110" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="800" y="208" text-anchor="middle" class="d-actor-label" font-size="12">Encode Workers</text>
    <text x="800" y="226" text-anchor="middle" class="d-label-muted" font-size="9">one part, one quality</text>
    <text x="800" y="241" text-anchor="middle" class="d-label-muted" font-size="9">at a time</text>
  </g>
  <g data-fail-toggle="db2">
    <rect x="530" y="320" width="170" height="80" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="615" y="355" text-anchor="middle" class="d-actor-label" font-size="12">Video Database</text>
    <text x="615" y="372" text-anchor="middle" class="d-label-muted" font-size="9">status · qualities</text>
  </g>
  <line id="v2-m-u" x1="152" y1="85" x2="246" y2="60" class="d-msg d-request" data-depends-on="up2" marker-end="url(#arrowV2)"></line>
  <line id="v2-u-m" x1="246" y1="82" x2="152" y2="105" class="d-msg d-response" data-depends-on="up2" marker-end="url(#arrowV2r)"></line>
  <line id="v2-m-s" x1="152" y1="125" x2="246" y2="195" class="d-msg d-request" data-depends-on="os2" marker-end="url(#arrowV2)"></line>
  <line id="v2-u-w" x1="422" y1="66" x2="526" y2="66" class="d-msg d-request" data-depends-on="up2 wf2" marker-end="url(#arrowV2)"></line>
  <line id="v2-u-d" x1="380" y1="107" x2="538" y2="316" class="d-msg d-request" data-depends-on="up2 db2" marker-end="url(#arrowV2)"></line>
  <line id="v2-w-e" x1="702" y1="72" x2="770" y2="161" class="d-msg d-request" data-depends-on="wf2 enc2" marker-end="url(#arrowV2)"></line>
  <line id="v2-e-w" x1="800" y1="161" x2="702" y2="92" class="d-msg d-response" data-depends-on="wf2 enc2" marker-end="url(#arrowV2r)"></line>
  <line id="v2-e-s" x1="716" y1="195" x2="424" y2="195" class="d-msg d-request" data-depends-on="enc2 os2" marker-end="url(#arrowV2)"></line>
  <line id="v2-s-e" x1="424" y1="240" x2="716" y2="240" class="d-msg d-response" data-depends-on="enc2 os2" marker-end="url(#arrowV2r)"></line>
  <line id="v2-w-d" x1="640" y1="107" x2="640" y2="316" class="d-msg d-request" data-depends-on="wf2 db2" marker-end="url(#arrowV2)"></line>
  <line id="v2-t-v" x1="152" y1="345" x2="246" y2="345" class="d-msg d-request" data-depends-on="vs2" marker-end="url(#arrowV2)"></line>
  <line id="v2-v-t" x1="246" y1="375" x2="152" y2="375" class="d-msg d-response" data-depends-on="vs2" marker-end="url(#arrowV2r)"></line>
  <line id="v2-v-d" x1="422" y1="345" x2="526" y2="345" class="d-msg d-request" data-depends-on="vs2 db2" marker-end="url(#arrowV2)"></line>
  <line id="v2-d-v" x1="526" y1="375" x2="422" y2="375" class="d-msg d-response" data-depends-on="vs2 db2" marker-end="url(#arrowV2r)"></line>
  <line id="v2-v-s" x1="320" y1="318" x2="320" y2="274" class="d-msg d-request" data-depends-on="vs2 os2" marker-end="url(#arrowV2)"></line>
  <line id="v2-s-v" x1="350" y1="274" x2="350" y2="318" class="d-msg d-response" data-depends-on="vs2 os2" marker-end="url(#arrowV2r)"></line>
  <text x="450" y="422" text-anchor="middle" class="d-label-muted" font-size="10">play a dropped upload, then 50 encoding tasks with a worker dying, then Theo choosing a quality</text>
  <defs>
    <marker id="arrowV2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowV2r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "v", "title": "v_48213", "rows": [["status", "—"], ["parts stored", "—"]]},
{"id": "e", "title": "Encoding", "rows": [["tasks done", "—"], ["versions", "—"]]},
{"id": "w", "title": "Theo", "rows": [["quality", "—"], ["playing", "—"]]}
],
"flows": [
{
"id": "upload",
"label": "An upload drops at 90%",
"nodes": ["up2", "os2", "wf2", "db2"],
"steps": [
{"el": "v2-m-u", "payload": "POST /uploads · 900 MB", "set": {"v.status": "—", "v.parts stored": "—", "e.tasks done": "—", "e.versions": "—", "w.quality": "—", "w.playing": "—"}, "text": "Maya starts the upload. The phone tells the upload service the file's size and hash."},
{"el": "v2-u-d", "payload": "insert v_48213 · uploading", "ms": 5, "set": {"v.status": "uploading"}, "text": "The video gets a row and an ID. Nobody can watch it yet."},
{"el": "v2-u-m", "payload": "up_9921 · 113 parts · signed URLs", "set": {"v.parts stored": "0 of 113"}, "text": "900 MB is 113 parts of 8 MB. The phone gets signed URLs, which let it write those parts and nothing else, for one hour."},
{"el": "v2-m-s", "payload": "PUT parts 1–101", "set": {"v.parts stored": "101 of 113"}, "text": "The phone writes directly to the object store, without passing through any app server. At part 102, about 90% of the way through, Maya walks out of range of the Wi-Fi."},
{"el": "v2-m-u", "payload": "which parts do you have?", "text": "Back online an hour later, the phone asks where it got to. Its signed URLs have expired, so it needs new ones as well."},
{"el": "v2-u-m", "payload": "101 stored · 12 new URLs", "text": "Exactly 101 parts are stored. The part that was cut off was never stored, so it's sent again. No other part is."},
{"el": "v2-m-s", "payload": "PUT parts 102–113", "set": {"v.parts stored": "113 of 113"}, "text": "The last 96 MB takes about 26 seconds. Under Stage 1, Maya would have sent all 900 MB again."},
{"el": "v2-m-u", "payload": "complete", "text": "The phone reports that it has finished."},
{"el": "v2-u-d", "payload": "status: processing", "ms": 5, "set": {"v.status": "processing"}, "text": "The upload service checks the parts against the file's hash and marks the video as processing. If the hash didn't match, the phone would be told which parts to send again."},
{"el": "v2-u-w", "payload": "start first_encode", "text": "Then it starts the encoding workflow. Maya sees \"processing\" and can put the phone away."}
]
},
{
"id": "encode",
"label": "50 tasks, and a worker dies",
"nodes": ["wf2", "enc2", "os2", "db2"],
"steps": [
{"el": "v2-w-e", "payload": "probe · split", "set": {"v.status": "processing", "v.parts stored": "source · 900 MB", "e.tasks done": "—", "e.versions": "—", "w.quality": "—", "w.playing": "—"}, "text": "First, one worker checks that the file is a real, playable video, and how long and how big it is. Encoding all 5 qualities takes 200 CPU-minutes for this video, over 3 hours on one core."},
{"el": "v2-s-e", "payload": "read source", "ms": 400, "text": "The worker reads the source, in a sandbox, because an uploaded file is untrusted input."},
{"el": "v2-e-s", "payload": "10 parts of ~1 minute", "text": "It cuts the source at the keyframes nearest each minute. That needs no decoding, so it takes seconds. The parts go back into the object store."},
{"el": "v2-e-w", "payload": "10 parts ready", "text": "10 parts × 5 qualities makes 50 tasks. The largest, one minute at 1080p, takes about 90 seconds on 8 cores."},
{"el": "v2-w-e", "payload": "50 tasks · 50 workers", "set": {"e.tasks done": "0 of 50"}, "text": "The queue hands the tasks to whichever workers are free. Each worker holds a 5-minute lease on its task, which it renews as it works."},
{"el": "v2-s-e", "payload": "workers read their parts", "ms": 50, "text": "Each worker reads just its own part."},
{"el": "v2-e-s", "payload": "work/part_07/h264_720p.mp4 …", "set": {"e.tasks done": "37 of 50"}, "text": "Encoded parts are written as workers finish. One machine dies, halfway through part 7 at 720p, and writes nothing."},
{"el": "v2-w-e", "payload": "lease expired · part 7, 720p again", "text": "Five minutes later, that worker's lease has run out. The task goes back on the queue. Only this one task repeats, so the failure costs a few CPU-minutes, not 200."},
{"el": "v2-e-s", "payload": "work/part_07/h264_720p.mp4", "set": {"e.tasks done": "50 of 50"}, "text": "Had the first worker been merely slow rather than dead, both would have written to the same path. They'd produce the same result, so it wouldn't matter which finished last."},
{"el": "v2-e-w", "payload": "50 of 50 done", "text": "All the tasks have finished."},
{"el": "v2-w-e", "payload": "join parts, one file per quality", "text": "One last task joins the parts of each quality into a single file."},
{"el": "v2-e-s", "payload": "5 files · 730 MB", "set": {"e.versions": "240p · 360p · 480p · 720p · 1080p"}, "text": "240p at 0.3 Mbps, 360p at 0.7, 480p at 1.2, 720p at 2.5 and 1080p at 5."},
{"el": "v2-w-d", "payload": "status: ready", "ms": 5, "set": {"v.status": "ready"}, "text": "Only now does the status change. It took about 4 minutes, because 50 workers shared the work."}
]
},
{
"id": "watch",
"label": "Theo chooses a quality",
"nodes": ["vs2", "db2", "os2"],
"steps": [
{"el": "v2-t-v", "payload": "GET v_48213", "set": {"v.status": "ready", "v.parts stored": "—", "e.tasks done": "—", "e.versions": "5 qualities", "w.quality": "—", "w.playing": "—"}, "text": "Theo opens the video on the train."},
{"el": "v2-v-d", "payload": "SELECT video, qualities", "text": "The video service looks up the versions."},
{"el": "v2-d-v", "payload": "5 qualities", "ms": 3, "text": "Five, all in H.264."},
{"el": "v2-v-t", "payload": "choose: 240p…1080p", "set": {"w.quality": "480p · 90 MB"}, "text": "The player tests the connection once as it starts, measures 3 Mbps, and picks 480p at 1.2 Mbps. The old tablet can now play the video too."},
{"el": "v2-t-v", "payload": "GET 480p.mp4", "text": "It asks for the whole 480p file with a range request."},
{"el": "v2-v-s", "payload": "read 480p.mp4", "text": "The video service reads from the object store."},
{"el": "v2-s-v", "payload": "bytes", "ms": 20, "text": "The bytes come back."},
{"el": "v2-v-t", "payload": "1.2 Mbps", "set": {"w.playing": "smooth at 480p"}, "text": "It plays smoothly. Theo's on a 3 Mbps connection and would have stalled at Stage 1."},
{"el": "v2-v-t", "payload": "connection falls to 0.5 Mbps", "set": {"w.playing": "frozen in a cutting"}, "text": "Then the train enters a deep cutting and the connection falls to 0.5 Mbps. The player chose one file at the start and has no way to switch mid-file without a pause and a guess at the matching byte. The video freezes."},
{"el": "v2-v-t", "payload": "connection recovers to 20 Mbps", "set": {"w.playing": "still 480p · on 20 Mbps"}, "text": "At the next station there's 20 Mbps to spare, and Theo is still watching a blurry 480p on a sharp screen. A single choice made at the start can't track a connection that keeps changing."}
]
}
]
}
</script>
<div class="diagram-caption">Uploads go to the object store in parts. A workflow splits each source into parts and encodes each part at five qualities on a fleet of workers. Viewers pick one finished file.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="up2">
<strong>If the upload service fails:</strong> no new uploads can start, and running ones can't get more URLs. Parts already sent stay stored. Playback is unaffected.
</div>
<div class="failure-impact is-hidden" data-component="os2">
<strong>If an object store machine fails:</strong> every object still has two more copies, and is copied again to get back to three. If the whole store is unreachable, nothing can be uploaded, encoded or watched, but nothing is lost.
</div>
<div class="failure-impact is-hidden" data-component="vs2">
<strong>If the video service fails:</strong> nobody can start or continue watching. Uploading and encoding carry on, and the videos will be ready when it's back.
</div>
<div class="failure-impact is-hidden" data-component="wf2">
<strong>If the workflow service fails:</strong> no new tasks are handed out, so new videos wait in "processing". Its state is saved after each step, so it resumes where it stopped. Videos already finished still play.
</div>
<div class="failure-impact is-hidden" data-component="enc2">
<strong>If an encode worker fails:</strong> its lease runs out and its one task runs again elsewhere. Losing many workers just lengthens the queue, so videos take longer to become ready.
</div>
<div class="failure-impact is-hidden" data-component="db2">
<strong>If the video database fails:</strong> nothing can start: no new uploads, no status changes, no playback. It needs a standby, and it holds the only record of which videos exist.
</div>
</div>

Every screen can now play the video, and uploads and encoding survive failures. But a viewer still commits to one quality when they press play, and connections change every few seconds. A file is the wrong unit to deliver, just as it was the wrong unit to upload.

<!-- stage:3:3. Adaptive Bitrate -->

## Stage 3 — Adaptive Bitrate

- **Each quality is cut into 4-second segments.** A 10-minute video has 150 segments per quality, 750 files in all. Each is a small file with its own URL.
- **Every quality has its keyframes in the same places.** The encoder is told to put a keyframe every 4 seconds, at the same moments in all 5 qualities. So each segment can start playing by itself, and segment 41 of any quality follows segment 40 of any other.
- **A manifest lists it all.** The master manifest lists the qualities, and each quality's own manifest lists its segments. These are plain text files beside the segments, in the HLS format; the same segments can be described by a DASH manifest too.
- **The player decides.** It measures how quickly recent segments arrived and how many seconds it has buffered, then picks the next segment's quality. The server knows nothing about any of this. It only serves files.
- **A seek is arithmetic.** 7:20 is 440 seconds, and 440 ÷ 4 is segment 110.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 380" width="860" height="380" role="img" aria-label="Theo's player asks a playback service for a manifest location, which reads the video database, then fetches manifests and segments from segment servers backed by the object store; the encoding pipeline writes segments to the object store and marks the video ready in the database">
  <rect x="20" y="130" width="140" height="110" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="170" text-anchor="middle" class="d-actor-label" font-size="12">Theo's Player</text>
  <text x="90" y="188" text-anchor="middle" class="d-label-muted" font-size="9">measures speed and buffer</text>
  <text x="90" y="203" text-anchor="middle" class="d-label-muted" font-size="9">picks each segment</text>
  <g data-fail-toggle="pb3">
    <rect x="290" y="30" width="180" height="85" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="380" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Playback Service</text>
    <text x="380" y="84" text-anchor="middle" class="d-label-muted" font-size="9">permissions · manifest URL</text>
  </g>
  <g data-fail-toggle="seg3">
    <rect x="290" y="240" width="180" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="380" y="279" text-anchor="middle" class="d-actor-label" font-size="12">Segment Servers</text>
    <text x="380" y="297" text-anchor="middle" class="d-label-muted" font-size="9">plain files over HTTP</text>
  </g>
  <g data-fail-toggle="db3">
    <rect x="640" y="30" width="190" height="85" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="735" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Video Database</text>
    <text x="735" y="84" text-anchor="middle" class="d-label-muted" font-size="9">status · manifest version</text>
  </g>
  <g data-fail-toggle="pipe3">
    <rect x="640" y="145" width="190" height="65" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="735" y="172" text-anchor="middle" class="d-actor-label" font-size="12">Encoding Pipeline</text>
    <text x="735" y="190" text-anchor="middle" class="d-label-muted" font-size="9">keyframes every 4 s · package</text>
  </g>
  <g data-fail-toggle="os3">
    <rect x="640" y="240" width="190" height="90" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="735" y="279" text-anchor="middle" class="d-actor-label" font-size="12">Object Store</text>
    <text x="735" y="297" text-anchor="middle" class="d-label-muted" font-size="9">750 segments · manifests</text>
  </g>
  <line id="v3-t-p" x1="162" y1="150" x2="286" y2="70" class="d-msg d-request" data-depends-on="pb3" marker-end="url(#arrowV3)"></line>
  <line id="v3-p-t" x1="286" y1="98" x2="162" y2="172" class="d-msg d-response" data-depends-on="pb3" marker-end="url(#arrowV3r)"></line>
  <line id="v3-t-g" x1="162" y1="200" x2="286" y2="265" class="d-msg d-request" data-depends-on="seg3" marker-end="url(#arrowV3)"></line>
  <line id="v3-g-t" x1="286" y1="295" x2="162" y2="224" class="d-msg d-response" data-depends-on="seg3" marker-end="url(#arrowV3r)"></line>
  <line id="v3-p-d" x1="472" y1="60" x2="636" y2="60" class="d-msg d-request" data-depends-on="pb3 db3" marker-end="url(#arrowV3)"></line>
  <line id="v3-d-p" x1="636" y1="90" x2="472" y2="90" class="d-msg d-response" data-depends-on="pb3 db3" marker-end="url(#arrowV3r)"></line>
  <line id="v3-g-s" x1="472" y1="270" x2="636" y2="270" class="d-msg d-request" data-depends-on="seg3 os3" marker-end="url(#arrowV3)"></line>
  <line id="v3-s-g" x1="636" y1="305" x2="472" y2="305" class="d-msg d-response" data-depends-on="seg3 os3" marker-end="url(#arrowV3r)"></line>
  <line id="v3-e-s" x1="735" y1="212" x2="735" y2="236" class="d-msg d-request" data-depends-on="pipe3 os3" marker-end="url(#arrowV3)"></line>
  <line id="v3-e-d" x1="735" y1="143" x2="735" y2="119" class="d-msg d-request" data-depends-on="pipe3 db3" marker-end="url(#arrowV3)"></line>
  <text x="430" y="365" text-anchor="middle" class="d-label-muted" font-size="10">play pressing play, then the train in a tunnel, then a seek to 7:20</text>
  <defs>
    <marker id="arrowV3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowV3r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "pl", "title": "Theo's player", "rows": [["connection", "—"], ["buffer", "—"], ["next segment", "—"], ["on screen", "—"]]}
],
"flows": [
{
"id": "start",
"label": "Pressing play",
"nodes": ["pb3", "seg3", "db3", "os3", "pipe3"],
"steps": [
{"el": "v3-e-s", "payload": "750 segments · manifests", "set": {"pl.connection": "—", "pl.buffer": "—", "pl.next segment": "—", "pl.on screen": "—"}, "text": "The pipeline now ends with a packaging step. It cuts each quality at its 4-second keyframes into 150 segments, and writes these and the manifests to the object store."},
{"el": "v3-e-d", "payload": "ready · manifest v1", "ms": 5, "text": "The video is marked ready."},
{"el": "v3-t-p", "payload": "POST /videos/v_48213/play", "set": {"pl.connection": "12 Mbps"}, "text": "Theo presses play on the way to the station."},
{"el": "v3-p-d", "payload": "SELECT status, visibility", "text": "The playback service checks that the video is ready and that Theo may watch it."},
{"el": "v3-d-p", "payload": "ready · public · v1", "ms": 3, "text": "Theo may."},
{"el": "v3-p-t", "payload": "manifest URL · token", "text": "The player gets the manifest's location and a short-lived token, and this service's job is finished. It won't hear from this player again."},
{"el": "v3-t-g", "payload": "master.m3u8", "text": "The player fetches the master manifest."},
{"el": "v3-g-s", "payload": "read file", "text": "A segment server reads it from the object store. It's a plain file."},
{"el": "v3-s-g", "payload": "text", "ms": 15, "text": "A few hundred bytes."},
{"el": "v3-g-t", "payload": "5 qualities", "text": "It lists all five qualities. The player knows nothing yet about this connection, so it starts low, to start fast."},
{"el": "v3-t-g", "payload": "360p/index · seg_000 · seg_001", "set": {"pl.next segment": "360p · seg_000"}, "text": "It fetches the 360p segment list, then the first two segments: 0.35 MB each."},
{"el": "v3-g-s", "payload": "read 2 segments", "text": "Each is a separate read."},
{"el": "v3-s-g", "payload": "0.7 MB", "ms": 15, "text": "Small files, quickly read."},
{"el": "v3-g-t", "payload": "2 segments in 0.5 s", "set": {"pl.buffer": "8 s", "pl.on screen": "360p · playing", "pl.next segment": "720p · seg_002"}, "text": "Eight seconds of video arrived in half a second. Playback begins, and the player has its first measurement: 12 Mbps. It moves up to 720p."},
{"el": "v3-t-g", "payload": "720p seg_002 … then 1080p", "set": {"pl.buffer": "24 s", "pl.next segment": "1080p · seg_020"}, "text": "With 15 seconds buffered and speed to spare, it moves up again to 1080p."},
{"el": "v3-g-t", "payload": "2.5 MB per segment", "set": {"pl.on screen": "1080p · playing"}, "text": "The picture sharpens without the viewer noticing a change. The segments line up exactly, so it's just the next piece of the same video."}
]
},
{
"id": "tunnel",
"label": "The train enters a tunnel",
"nodes": ["seg3", "os3"],
"steps": [
{"el": "v3-t-g", "payload": "1080p seg_041", "set": {"pl.connection": "8 Mbps", "pl.buffer": "24 s", "pl.next segment": "1080p · seg_041", "pl.on screen": "1080p · playing"}, "text": "Theo is 2 minutes 44 seconds in, watching 1080p with 24 seconds of video buffered. The player asks for the next segment."},
{"el": "v3-g-s", "payload": "read seg_041", "text": "Nothing about the server's job has changed."},
{"el": "v3-s-g", "payload": "2.5 MB", "ms": 15, "text": "The file's ready."},
{"el": "v3-g-t", "payload": "2.5 MB at 1 Mbps · 20 s", "set": {"pl.connection": "1 Mbps · tunnel", "pl.buffer": "8 s"}, "text": "The train enters a tunnel, and the connection falls to 1 Mbps. This one segment takes 20 seconds to arrive. Meanwhile, the video keeps playing from the buffer, which falls from 24 seconds to 4, then rises to 8 when the segment lands."},
{"el": "v3-t-g", "payload": "360p seg_042", "set": {"pl.next segment": "360p · seg_042"}, "text": "The player measures 1 Mbps. It picks the highest quality at or under 70% of that: 360p at 0.7 Mbps."},
{"el": "v3-g-t", "payload": "0.35 MB in 2.8 s", "set": {"pl.buffer": "9 s", "pl.on screen": "360p · playing"}, "text": "4 seconds of video now arrives in 2.8 seconds, so the buffer grows again, even in the tunnel. The picture is softer, and it never stops."},
{"el": "v3-t-g", "payload": "360p seg_043 … seg_049", "set": {"pl.buffer": "17 s"}, "text": "It stays there, slowly refilling the buffer."},
{"el": "v3-g-t", "payload": "connection back · 8 Mbps", "set": {"pl.connection": "8 Mbps", "pl.next segment": "720p · seg_050"}, "text": "The train leaves the tunnel. A fast segment measures 8 Mbps. The player steps up to 720p, with care: a brief burst of speed shouldn't send it straight back to 1080p."},
{"el": "v3-t-g", "payload": "720p seg_050 … 1080p seg_056", "set": {"pl.next segment": "1080p · seg_056"}, "text": "A few segments later, the speed has held, and the buffer is large. It returns to 1080p."},
{"el": "v3-g-t", "payload": "2.5 MB per segment", "set": {"pl.buffer": "24 s", "pl.on screen": "1080p · playing"}, "text": "Theo saw a softer picture for about 40 seconds and never saw a spinner. All of this was decided on the phone, and the servers just served files."}
]
},
{
"id": "seek",
"label": "A seek to 7:20",
"nodes": ["seg3", "os3"],
"steps": [
{"el": "v3-t-g", "payload": "480p seg_110", "set": {"pl.connection": "8 Mbps", "pl.buffer": "0 s", "pl.next segment": "480p · seg_110", "pl.on screen": "seeking"}, "text": "Theo drags the slider to 7:20. That's 440 seconds, and 440 ÷ 4 is segment 110. No index is needed. The buffer behind the old position is useless, and the player drops a notch to get pictures on screen quickly."},
{"el": "v3-g-s", "payload": "read seg_110", "text": "It's just another file."},
{"el": "v3-s-g", "payload": "0.6 MB", "ms": 15, "text": "Read."},
{"el": "v3-g-t", "payload": "0.6 MB in 0.6 s", "set": {"pl.buffer": "4 s", "pl.on screen": "480p · playing"}, "text": "Every segment starts with a keyframe, so it can be decoded with no earlier data. Playback resumes at exactly 7:20, 0.6 seconds later."},
{"el": "v3-t-g", "payload": "720p seg_111 · 1080p seg_113", "set": {"pl.next segment": "1080p · seg_113"}, "text": "The player climbs back up as the buffer grows."},
{"el": "v3-g-t", "payload": "segments", "set": {"pl.buffer": "16 s", "pl.on screen": "1080p · playing"}, "text": "It's back at 1080p within a few seconds. Only the segments around the new position were downloaded, not the whole file up to that point."}
]
}
]
}
</script>
<div class="diagram-caption">The pipeline cuts each quality into 4-second segments with their keyframes aligned. The player reads a manifest and chooses each segment's quality from its own measurements. Servers only serve files.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="pb3">
<strong>If the playback service fails:</strong> nobody new can start. Anyone already watching doesn't notice, because they have their manifest and token, and fetch segments directly.
</div>
<div class="failure-impact is-hidden" data-component="seg3">
<strong>If a segment server fails:</strong> its requests fail, and the player retries on another. A retry costs a few seconds of buffer, which is what the buffer is for.
</div>
<div class="failure-impact is-hidden" data-component="db3">
<strong>If the video database fails:</strong> no new plays can start, and new videos can't be marked ready. Everyone already watching carries on.
</div>
<div class="failure-impact is-hidden" data-component="pipe3">
<strong>If the encoding pipeline fails:</strong> new videos wait. Everything already packaged keeps playing.
</div>
<div class="failure-impact is-hidden" data-component="os3">
<strong>If the object store is unreachable:</strong> segments can't be read, and each viewer plays until their buffer runs out, about 20 seconds. Then every viewer stalls at once, because nothing sits between the servers and the store.
</div>
</div>

Playback now handles any connection, and each piece of it is a plain file. But all those files are served from one region. Aiko, in Osaka, is 250 ms from a European data centre, and a long round trip holds down how fast any connection can go. And the whole design has to deliver 75 Tbps, which no single site could send. A plain, unchanging file is about the easiest thing there is to cache, and it's time to cache it near the viewer.

<!-- stage:4:4. Caches Near the Viewer -->

## Stage 4 — Caches Near the Viewer

- **Edge sites hold copies near viewers.** About 200 sites around the world serve segments from memory and SSD, many inside or next to the viewers' own internet providers. About 95% of segment bytes are served from the edge ([CDNs & Edge Delivery](#/systems/cdn-edge-delivery)).
- **Segments can be cached for a year.** A segment's URL names its video, version and quality, and its contents never change. New encodings get new URLs, so there's nothing to invalidate.
- **A shield sits behind the edges.** Each region has one mid-tier cache. An edge that misses asks its shield, not the origin, so a region's 40 edges fetch each segment from the origin once. Shields answer about 80% of what reaches them, so the origin sees about 750 Gbps of the 75 Tbps.
- **Simultaneous misses are merged.** If 500 viewers at one edge ask for the same uncached segment at once, the edge fetches it once and answers all 500 when it arrives.
- **Permission is checked without calling home.** The playback service signs a token with the video ID and an expiry. Any edge can check the signature itself, so 6 million requests a second don't touch a database. The token is left out of the cache key, so all viewers share one copy ([Security & Authentication](#/systems/security-authentication)).
- **The player gets a list of hosts.** The play call returns the best sites for this viewer, in order. If one fails or slows down, the player moves to the next at the next segment. Within a site, segments are assigned to servers by consistent hashing, so each is stored on few machines.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 900 400" width="900" height="400" role="img" aria-label="The player asks a playback service, which reads the video database, for a manifest location and a list of hosts, then fetches segments from a nearby edge site or a second edge site; edges fetch misses from a regional shield, which fetches from the origin object store; an edge can go directly to the origin if the shield is down">
  <rect x="20" y="150" width="130" height="110" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="85" y="192" text-anchor="middle" class="d-actor-label" font-size="12">Player</text>
  <text x="85" y="210" text-anchor="middle" class="d-label-muted" font-size="9">list of hosts</text>
  <text x="85" y="225" text-anchor="middle" class="d-label-muted" font-size="9">token on each request</text>
  <g data-fail-toggle="pb4">
    <rect x="250" y="25" width="170" height="85" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="335" y="60" text-anchor="middle" class="d-actor-label" font-size="12">Playback Service</text>
    <text x="335" y="78" text-anchor="middle" class="d-label-muted" font-size="9">signs tokens · picks hosts</text>
  </g>
  <g data-fail-toggle="db4">
    <rect x="530" y="25" width="150" height="85" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="605" y="60" text-anchor="middle" class="d-actor-label" font-size="12">Video Database</text>
    <text x="605" y="78" text-anchor="middle" class="d-label-muted" font-size="9">with a memory cache</text>
  </g>
  <g data-fail-toggle="edgeA">
    <rect x="250" y="160" width="170" height="85" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="335" y="197" text-anchor="middle" class="d-actor-label" font-size="12">Nearby Edge</text>
    <text x="335" y="215" text-anchor="middle" class="d-label-muted" font-size="9">checks token · 95% of bytes</text>
  </g>
  <g data-fail-toggle="edgeB">
    <rect x="250" y="295" width="170" height="80" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="335" y="330" text-anchor="middle" class="d-actor-label" font-size="12">Second Edge</text>
    <text x="335" y="348" text-anchor="middle" class="d-label-muted" font-size="9">next host on the list</text>
  </g>
  <g data-fail-toggle="sh4">
    <rect x="510" y="215" width="130" height="90" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="575" y="252" text-anchor="middle" class="d-actor-label" font-size="12">Regional Shield</text>
    <text x="575" y="270" text-anchor="middle" class="d-label-muted" font-size="9">one per region</text>
  </g>
  <g data-fail-toggle="or4">
    <rect x="730" y="190" width="150" height="115" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="805" y="240" text-anchor="middle" class="d-actor-label" font-size="12">Origin</text>
    <text x="805" y="258" text-anchor="middle" class="d-label-muted" font-size="9">object store · ~1% of bytes</text>
  </g>
  <line id="v4-t-p" x1="152" y1="172" x2="246" y2="82" class="d-msg d-request" data-depends-on="pb4" marker-end="url(#arrowV4)"></line>
  <line id="v4-p-t" x1="246" y1="102" x2="152" y2="188" class="d-msg d-response" data-depends-on="pb4" marker-end="url(#arrowV4r)"></line>
  <line id="v4-p-d" x1="422" y1="55" x2="526" y2="55" class="d-msg d-request" data-depends-on="pb4 db4" marker-end="url(#arrowV4)"></line>
  <line id="v4-d-p" x1="526" y1="85" x2="422" y2="85" class="d-msg d-response" data-depends-on="pb4 db4" marker-end="url(#arrowV4r)"></line>
  <line id="v4-t-e" x1="152" y1="198" x2="246" y2="192" class="d-msg d-request" data-depends-on="edgeA" marker-end="url(#arrowV4)"></line>
  <line id="v4-e-t" x1="246" y1="222" x2="152" y2="222" class="d-msg d-response" data-depends-on="edgeA" marker-end="url(#arrowV4r)"></line>
  <line id="v4-t-b" x1="152" y1="238" x2="246" y2="320" class="d-msg d-request" data-depends-on="edgeB" marker-end="url(#arrowV4)"></line>
  <line id="v4-b-t" x1="246" y1="345" x2="152" y2="252" class="d-msg d-response" data-depends-on="edgeB" marker-end="url(#arrowV4r)"></line>
  <line id="v4-e-s" x1="422" y1="225" x2="506" y2="240" class="d-msg d-request" data-depends-on="edgeA sh4" marker-end="url(#arrowV4)"></line>
  <line id="v4-s-e" x1="506" y1="262" x2="422" y2="238" class="d-msg d-response" data-depends-on="edgeA sh4" marker-end="url(#arrowV4r)"></line>
  <line id="v4-b-s" x1="422" y1="322" x2="506" y2="282" class="d-msg d-request" data-depends-on="edgeB sh4" marker-end="url(#arrowV4)"></line>
  <line id="v4-s-b" x1="506" y1="296" x2="422" y2="345" class="d-msg d-response" data-depends-on="edgeB sh4" marker-end="url(#arrowV4r)"></line>
  <line id="v4-s-o" x1="642" y1="245" x2="726" y2="245" class="d-msg d-request" data-depends-on="sh4 or4" marker-end="url(#arrowV4)"></line>
  <line id="v4-o-s" x1="726" y1="280" x2="642" y2="280" class="d-msg d-response" data-depends-on="sh4 or4" marker-end="url(#arrowV4r)"></line>
  <line id="v4-e-o" x1="422" y1="182" x2="726" y2="208" class="d-msg d-request" data-depends-on="edgeA or4" marker-end="url(#arrowV4)"></line>
  <line id="v4-o-e" x1="726" y1="196" x2="422" y2="170" class="d-msg d-response" data-depends-on="edgeA or4" marker-end="url(#arrowV4r)"></line>
  <text x="450" y="392" text-anchor="middle" class="d-label-muted" font-size="10">play a hit near Manchester, then the first viewer in Osaka, then an edge site going dark</text>
  <defs>
    <marker id="arrowV4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowV4r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "ca", "title": "Where seg_041 is cached", "rows": [["nearby edge", "—"], ["shield", "—"], ["origin", "—"]]},
{"id": "pl", "title": "Viewer", "rows": [["who", "—"], ["waiting on the edge", "—"], ["buffer", "—"]]}
],
"flows": [
{
"id": "hit",
"label": "A hit near Manchester",
"nodes": ["pb4", "db4", "edgeA", "edgeB"],
"steps": [
{"el": "v4-t-p", "payload": "POST /play", "set": {"ca.nearby edge": "cached", "ca.shield": "cached", "ca.origin": "stored", "pl.who": "Theo · Manchester", "pl.waiting on the edge": "—", "pl.buffer": "—"}, "text": "Theo presses play near Manchester. This is the only request that does per-viewer work."},
{"el": "v4-p-d", "payload": "SELECT v_48213", "text": "The playback service checks the video's status, visibility and country limits. Most of these rows are already in memory."},
{"el": "v4-d-p", "payload": "ready · public · v1", "ms": 2, "text": "Theo may watch it."},
{"el": "v4-p-t", "payload": "hosts: man-2, lon-5 · signed token", "text": "The player gets a signed token and a list of hosts. The list names the Manchester site, inside Theo's internet provider's own network, then London."},
{"el": "v4-t-e", "payload": "1080p/seg_041 · token", "altEl": "v4-t-b", "text": "The player asks the nearest host for each segment.", "altText": "The Manchester site doesn't answer, so the player asks the next host on its list, London."},
{"el": "v4-e-t", "payload": "2.5 MB · hit", "ms": 1, "altEl": "v4-b-t", "altMs": 1, "set": {"pl.buffer": "growing"}, "text": "The edge checks the token's signature and expiry, without calling anyone. It ignores the token when looking up the file, so every viewer shares one copy. It's in memory, and it's served within a millisecond. Nothing else in the system knew this happened.", "altText": "London has it too, and serves it a few milliseconds further away. Theo doesn't notice."}
]
},
{
"id": "miss",
"label": "The first viewer in Osaka",
"nodes": ["pb4", "edgeA", "sh4", "or4"],
"steps": [
{"el": "v4-t-e", "payload": "1080p/seg_041 · token", "set": {"ca.nearby edge": "miss", "ca.shield": "miss", "ca.origin": "stored", "pl.who": "Aiko · Osaka", "pl.waiting on the edge": "1", "pl.buffer": "—"}, "text": "Aiko, in Osaka, is the first person in Japan to watch Knife Skills. The nearest edge doesn't have this segment."},
{"el": "v4-t-e", "payload": "499 more · same segment", "set": {"pl.waiting on the edge": "500"}, "text": "A Japanese food site has just linked to the video, and 499 others ask for the same segment within the next moments. The edge doesn't send 500 requests. It holds them all behind the one already on its way."},
{"el": "v4-e-s", "payload": "seg_041", "altEl": "v4-e-o", "text": "The edge asks its regional shield in Tokyo, not the origin.", "altText": "The shield is down, so the edge goes straight to the origin. It's slower and costs the origin more, but viewers keep watching."},
{"el": "v4-s-o", "payload": "seg_041", "altEl": "v4-e-o", "text": "The shield hasn't got it either. Its one request goes to the origin in Europe, on a long-distance link kept open for this traffic.", "altText": "The request travels to Europe."},
{"el": "v4-o-s", "payload": "2.5 MB", "ms": 270, "altEl": "v4-o-e", "altMs": 280, "set": {"ca.shield": "cached"}, "text": "The file comes back from the far side of the world. That's the slow part: about 270 ms, once.", "altText": "The file comes back from Europe, this time with no shield to remember it, so the next edge in Japan pays the same 280 ms."},
{"el": "v4-s-e", "payload": "2.5 MB", "ms": 8, "altEl": "v4-o-e", "altMs": 0, "set": {"ca.nearby edge": "cached"}, "text": "The shield keeps a copy, and passes the file on to Osaka. All 40 edge sites in the region can now get it from Tokyo, without the origin hearing another request.", "altText": "The edge keeps a copy."},
{"el": "v4-e-t", "payload": "2.5 MB × 500", "set": {"pl.waiting on the edge": "0", "pl.buffer": "growing"}, "text": "One origin read answers all 500 viewers at once. Their players had started on low-quality segments, so nobody saw the wait."},
{"el": "v4-t-e", "payload": "the next viewer", "set": {"pl.who": "another viewer in Osaka"}, "text": "The next viewer in Osaka asks for the same segment."},
{"el": "v4-e-t", "payload": "hit", "ms": 1, "text": "1 ms. It stays cached until the edge needs the space for something more popular."}
]
},
{
"id": "dark",
"label": "An edge site goes dark",
"nodes": ["edgeA", "edgeB", "sh4"],
"steps": [
{"el": "v4-t-e", "payload": "1080p/seg_077", "set": {"ca.nearby edge": "—", "ca.shield": "cached", "ca.origin": "stored", "pl.who": "Theo · Manchester", "pl.waiting on the edge": "—", "pl.buffer": "22 s"}, "text": "Halfway through the video, a fibre cut takes the Manchester site offline. Theo's request gets no answer."},
{"el": "v4-t-e", "payload": "no answer in 2 s", "set": {"ca.nearby edge": "unreachable", "pl.buffer": "20 s"}, "text": "After 2 seconds, the player stops waiting. The buffer has dropped from 22 to 20 seconds. That's still plenty."},
{"el": "v4-t-b", "payload": "lon-5 · seg_077", "text": "The next host on the list is London. The token works there too, because every edge can verify the same signature."},
{"el": "v4-b-s", "payload": "seg_077", "text": "London hasn't got this less-watched part of the video, so it asks the shield."},
{"el": "v4-s-b", "payload": "2.5 MB", "ms": 12, "text": "The shield has it. It filled when other edges in the region asked. The origin hears nothing at all."},
{"el": "v4-b-t", "payload": "2.5 MB", "set": {"pl.buffer": "23 s"}, "text": "Theo is back to normal, and didn't see a thing."},
{"el": "v4-b-s", "payload": "site's other misses", "text": "Everyone who was using Manchester moves within seconds, which shifts a site's worth of misses onto the neighbouring sites and the shield."},
{"el": "v4-s-b", "payload": "shield absorbs it", "ms": 12, "text": "This is why a shield matters most on a bad day. Without one, all of those misses would land on the origin in the same few seconds."}
]
}
]
}
</script>
<div class="diagram-caption">Edge sites near viewers hold copies of popular segments, and shields collapse each region's misses before they reach the origin. A signed token lets any edge check permission on its own, and the player carries a list of hosts to fall back on.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="pb4">
<strong>If the playback service fails:</strong> new plays can't start. Everyone already watching carries on until their token expires, and tokens last longer than most videos.
</div>
<div class="failure-impact is-hidden" data-component="db4">
<strong>If the video database fails:</strong> rows already in the playback service's cache keep working for popular videos. Others can't start, and no one watching notices.
</div>
<div class="failure-impact is-hidden" data-component="edgeA">
<strong>If the nearby edge fails:</strong> players move to the next host after one timeout, costing a couple of seconds of buffer. That site's traffic lands on its neighbours, which is why every site runs with spare capacity.
</div>
<div class="failure-impact is-hidden" data-component="edgeB">
<strong>If the second edge fails:</strong> nothing changes unless the viewer needed it. Its own viewers move on to their next hosts.
</div>
<div class="failure-impact is-hidden" data-component="sh4">
<strong>If the shield fails:</strong> edges go straight to the origin. Viewers keep watching popular videos from the edge, and misses get slower. The origin takes several times its normal load, so failover must be to another region's shield, or be limited, before it's overloaded.
</div>
<div class="failure-impact is-hidden" data-component="or4">
<strong>If the origin fails:</strong> anything already cached keeps playing, which is about 99% of bytes. Only videos cached nowhere fail. This is the most surprising benefit of the design: the storage that holds everything is rarely needed at any moment.
</div>
</div>

Delivery now works, and most of the traffic never reaches the data centre. But every video is treated the same, and they aren't the same. Knife Skills can go from 200 views a day to 40,000 in ten minutes, while a video from 2019 might get three views a year and still fill three copies on hot disks. 270 PB a day is the system's largest bill, and nothing yet looks at which videos are worth spending on, or notices when viewers on one network start to stall.

<!-- stage:5:5. Spending Where Viewers Are -->

## Stage 5 — Spending Where Viewers Are

- **Players report what they see.** Every 30 seconds each player sends its position, quality, stalls and which host it's using: about 800,000 events a second at peak, through an event stream ([Batch vs Stream](#/systems/batch-vs-stream)).
- **A popularity service watches the stream.** It keeps recent views per video, in memory, and compares them with what's usual. View counts for creators come from the same stream, a minute or so behind.
- **Rising videos are pushed before they're asked for.** A video with at least 1,000 views in 10 minutes and 20 times its usual rate gets its first minute preloaded to nearby edges, where most viewers will ask for it.
- **Expensive encodings go only on videos that repay them.** AV1 video needs about 30% fewer bytes for the same picture, and takes about 10 times the CPU to encode. Popular videos get it, on spare cores in a low-priority lane that yields to new uploads. Popular videos carry 90% of watch time, and about 60% of devices can decode AV1, so that cuts total delivery by about 16%.
- **Unwatched videos move to a cold store.** Videos with no views for 180 days, and all source files once encoded, move to erasure-coded storage at 1.5 times the data rather than 3 ([Storage Engines](#/systems/storage-engines)). About 80% of bytes are cold, which takes the 1.4 EB library from 4.2 EB of disk to about 2.5 EB.
- **Stall rates steer traffic.** The service groups stall rates by network and site. When a group is worse than usual, the playback service gives new viewers on that network a different site first.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 920 460" width="920" height="460" role="img" aria-label="The player sends events to an event stream read by a popularity and quality service, which preloads rising videos to the edges, starts AV1 encodes on an encode farm that writes to the hot store, and updates the video database; the playback service reads the database and gives players a manifest and hosts; edges and shields fetch from a hot store or a cold store, and a tiering path moves unwatched video from hot to cold">
  <rect x="20" y="170" width="130" height="110" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="85" y="212" text-anchor="middle" class="d-actor-label" font-size="12">Player</text>
  <text x="85" y="230" text-anchor="middle" class="d-label-muted" font-size="9">reports every 30 s</text>
  <g data-fail-toggle="pb5">
    <rect x="250" y="30" width="170" height="80" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="335" y="65" text-anchor="middle" class="d-actor-label" font-size="12">Playback Service</text>
    <text x="335" y="83" text-anchor="middle" class="d-label-muted" font-size="9">manifest version · host order</text>
  </g>
  <g data-fail-toggle="db5">
    <rect x="510" y="30" width="170" height="80" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="595" y="65" text-anchor="middle" class="d-actor-label" font-size="12">Video Database</text>
    <text x="595" y="83" text-anchor="middle" class="d-label-muted" font-size="9">versions · steering table</text>
  </g>
  <g data-fail-toggle="cdn5">
    <rect x="250" y="185" width="170" height="95" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="335" y="225" text-anchor="middle" class="d-actor-label" font-size="12">Edges + Shields</text>
    <text x="335" y="243" text-anchor="middle" class="d-label-muted" font-size="9">99% of bytes</text>
  </g>
  <g data-fail-toggle="cold5">
    <rect x="740" y="110" width="160" height="75" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="820" y="142" text-anchor="middle" class="d-actor-label" font-size="12">Cold Store</text>
    <text x="820" y="160" text-anchor="middle" class="d-label-muted" font-size="9">6 + 3 fragments · 1.5×</text>
  </g>
  <g data-fail-toggle="hot5">
    <rect x="740" y="230" width="160" height="75" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="820" y="262" text-anchor="middle" class="d-actor-label" font-size="12">Hot Store</text>
    <text x="820" y="280" text-anchor="middle" class="d-label-muted" font-size="9">3 copies</text>
  </g>
  <g data-fail-toggle="ev5">
    <rect x="250" y="355" width="170" height="75" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="335" y="388" text-anchor="middle" class="d-actor-label" font-size="12">Event Stream</text>
    <text x="335" y="406" text-anchor="middle" class="d-label-muted" font-size="9">800,000 events a second</text>
  </g>
  <g data-fail-toggle="pop5">
    <rect x="510" y="355" width="170" height="75" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="595" y="388" text-anchor="middle" class="d-actor-label" font-size="12">Popularity + Quality</text>
    <text x="595" y="406" text-anchor="middle" class="d-label-muted" font-size="9">views · stalls by network</text>
  </g>
  <g data-fail-toggle="enc5">
    <rect x="740" y="355" width="160" height="75" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="820" y="388" text-anchor="middle" class="d-actor-label" font-size="12">Encode Farm</text>
    <text x="820" y="406" text-anchor="middle" class="d-label-muted" font-size="9">uploads first · AV1 after</text>
  </g>
  <line id="v5-t-p" x1="152" y1="190" x2="246" y2="85" class="d-msg d-request" data-depends-on="pb5" marker-end="url(#arrowV5)"></line>
  <line id="v5-p-t" x1="246" y1="102" x2="152" y2="205" class="d-msg d-response" data-depends-on="pb5" marker-end="url(#arrowV5r)"></line>
  <line id="v5-p-d" x1="422" y1="58" x2="506" y2="58" class="d-msg d-request" data-depends-on="pb5 db5" marker-end="url(#arrowV5)"></line>
  <line id="v5-d-p" x1="506" y1="88" x2="422" y2="88" class="d-msg d-response" data-depends-on="pb5 db5" marker-end="url(#arrowV5r)"></line>
  <line id="v5-t-c" x1="152" y1="220" x2="246" y2="220" class="d-msg d-request" data-depends-on="cdn5" marker-end="url(#arrowV5)"></line>
  <line id="v5-c-t" x1="246" y1="250" x2="152" y2="250" class="d-msg d-response" data-depends-on="cdn5" marker-end="url(#arrowV5r)"></line>
  <line id="v5-t-e" x1="152" y1="270" x2="246" y2="375" class="d-msg d-request" data-depends-on="ev5" marker-end="url(#arrowV5)"></line>
  <line id="v5-e-pop" x1="422" y1="392" x2="506" y2="392" class="d-msg d-request" data-depends-on="ev5 pop5" marker-end="url(#arrowV5)"></line>
  <line id="v5-pop-c" x1="530" y1="353" x2="400" y2="284" class="d-msg d-request" data-depends-on="pop5 cdn5" marker-end="url(#arrowV5)"></line>
  <line id="v5-pop-d" x1="625" y1="353" x2="625" y2="114" class="d-msg d-request" data-depends-on="pop5 db5" marker-end="url(#arrowV5)"></line>
  <line id="v5-pop-enc" x1="682" y1="380" x2="736" y2="380" class="d-msg d-request" data-depends-on="pop5 enc5" marker-end="url(#arrowV5)"></line>
  <line id="v5-enc-pop" x1="736" y1="410" x2="682" y2="410" class="d-msg d-response" data-depends-on="pop5 enc5" marker-end="url(#arrowV5r)"></line>
  <line id="v5-enc-h" x1="820" y1="353" x2="820" y2="309" class="d-msg d-request" data-depends-on="enc5 hot5" marker-end="url(#arrowV5)"></line>
  <line id="v5-h-cold" x1="820" y1="228" x2="820" y2="189" class="d-msg d-request" data-depends-on="hot5 cold5" marker-end="url(#arrowV5)"></line>
  <line id="v5-c-h" x1="422" y1="245" x2="736" y2="255" class="d-msg d-request" data-depends-on="cdn5 hot5" marker-end="url(#arrowV5)"></line>
  <line id="v5-h-c" x1="736" y1="280" x2="422" y2="265" class="d-msg d-response" data-depends-on="cdn5 hot5" marker-end="url(#arrowV5r)"></line>
  <line id="v5-c-cold" x1="422" y1="205" x2="736" y2="135" class="d-msg d-request" data-depends-on="cdn5 cold5" marker-end="url(#arrowV5)"></line>
  <line id="v5-cold-c" x1="736" y1="160" x2="422" y2="225" class="d-msg d-response" data-depends-on="cdn5 cold5" marker-end="url(#arrowV5r)"></line>
  <text x="460" y="450" text-anchor="middle" class="d-label-muted" font-size="10">play a video going viral, then a video from 2019, then one network starting to stall</text>
  <defs>
    <marker id="arrowV5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowV5r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "v", "title": "Video", "rows": [["video", "—"], ["last 10 minutes", "—"], ["manifest", "—"], ["stored in", "—"]]},
{"id": "n", "title": "Effect", "rows": [["preloaded", "—"], ["delivery", "—"], ["stalls", "—"]]}
],
"flows": [
{
"id": "viral",
"label": "A video goes viral",
"nodes": ["pb5", "db5", "cdn5", "hot5", "ev5", "pop5", "enc5"],
"steps": [
{"el": "v5-t-e", "payload": "watched_s · 40,000 viewers", "set": {"v.video": "v_48213 · Knife Skills", "v.last 10 minutes": "40,000 views", "v.manifest": "v1 · H.264", "v.stored in": "hot", "n.preloaded": "—", "n.delivery": "—", "n.stalls": "—"}, "text": "A famous chef shares Knife Skills. It usually gets 200 views a day, and now it has 40,000 in ten minutes. Each player reports what it's doing every 30 seconds."},
{"el": "v5-e-pop", "payload": "40,000 views · usual: 1", "text": "The popularity service reads the stream. This video is far above both limits: 1,000 views in 10 minutes, and 20 times the usual rate."},
{"el": "v5-pop-c", "payload": "preload the first 60 s", "set": {"n.preloaded": "75 segments · 73 MB"}, "text": "It asks edge sites in the UK and Europe to load the video's first minute: 15 segments at 5 qualities, 73 MB per site. Most viewers watch the opening, and very few watch all of it, so this small slice takes most of the first wave."},
{"el": "v5-c-h", "payload": "75 segments", "text": "Shields read them from the hot store, once per region."},
{"el": "v5-h-c", "payload": "73 MB", "ms": 40, "text": "Edge sites fill before their viewers arrive. Each site paying a miss would have worked too, but the misses would all come at the moment the shields were busiest."},
{"el": "v5-pop-enc", "payload": "AV1 · background lane", "text": "Now the larger decision. At this rate, the video will reach about 3 million views and 405 TB of delivery. AV1 costs 33 CPU-hours once, and saves about 30% on the 60% of devices that can decode it: about 70 TB. For a video with 200 views, the same 33 CPU-hours would save 5 GB, so it wouldn't be worth doing."},
{"el": "v5-enc-h", "payload": "v2 · av1_* segments", "text": "The farm runs this on cores not needed for new uploads, and pauses it if uploads surge. Spare capacity means it finishes in about 10 minutes. The AV1 segments go into a new path under version 2. Nothing already written changes."},
{"el": "v5-enc-pop", "payload": "AV1 done", "text": "Done."},
{"el": "v5-pop-d", "payload": "manifest_version = 2", "ms": 5, "set": {"v.manifest": "v2 · H.264 + AV1"}, "text": "The video's row now points to version 2, whose master manifest lists both formats. Version 1 stays in place, so anyone already watching just carries on."},
{"el": "v5-t-p", "payload": "POST /play", "text": "The next viewer presses play."},
{"el": "v5-p-d", "payload": "SELECT v_48213", "text": "The playback service reads the row."},
{"el": "v5-d-p", "payload": "version 2", "ms": 2, "text": "Version 2."},
{"el": "v5-p-t", "payload": "/v/v_48213/2/master.m3u8", "text": "No cache needed clearing. A new viewer simply gets a new path. An unchanged URL still means unchanged contents."},
{"el": "v5-t-c", "payload": "av1_1080p/seg_000", "text": "A player that can decode AV1 picks those lines from the manifest. Others use the H.264 lines."},
{"el": "v5-c-t", "payload": "1.75 MB, not 2.5", "ms": 1, "set": {"n.delivery": "30% fewer bytes on capable devices"}, "text": "The same picture at 1.75 MB instead of 2.5 MB. Across the whole platform, this one decision saves about 16% of delivery, which is 43 PB a day."}
]
},
{
"id": "cold",
"label": "A video from 2019",
"nodes": ["pb5", "cdn5", "hot5", "cold5", "db5"],
"steps": [
{"el": "v5-h-cold", "payload": "no views for 180 days", "set": {"v.video": "v_12077 · village fair, 2019", "v.last 10 minutes": "0", "v.manifest": "v1 · H.264", "v.stored in": "cold", "n.preloaded": "—", "n.delivery": "—", "n.stalls": "—"}, "text": "A nightly job moves videos that have gone 180 days without a view to the cold store. Each object is split into 6 data fragments and 3 parity fragments, and any 6 rebuild it. Its URL doesn't change, and only the index knows where it's stored."},
{"el": "v5-t-p", "payload": "POST /play", "text": "Someone in Recife finds an old link and presses play."},
{"el": "v5-p-d", "payload": "SELECT v_12077", "text": "The row isn't in memory, because nobody has asked for it for months."},
{"el": "v5-d-p", "payload": "ready · v1", "ms": 8, "text": "A read from the database."},
{"el": "v5-p-t", "payload": "manifest · hosts", "text": "Everything is normal so far."},
{"el": "v5-t-c", "payload": "360p/seg_000", "text": "The player starts low, as always."},
{"el": "v5-c-cold", "payload": "miss everywhere · 6 of 9 fragments", "text": "Neither the edge nor the shield has this. The shield asks the store, which reads 6 fragments for each segment."},
{"el": "v5-cold-c", "payload": "rebuilt segment", "ms": 180, "text": "That takes about 150 ms longer than a hot read, plus the long trip from the origin. This viewer starts in a little over a second rather than half a second."},
{"el": "v5-c-t", "payload": "0.35 MB", "set": {"n.delivery": "about 0.5 s slower to start"}, "text": "It plays. This is the bet: a small delay, for the few who ask, in exchange for not keeping three copies of everything for the viewer who might turn up. The next segments are already cached, because the shield read ahead."},
{"el": "v5-t-c", "payload": "seg_001 …", "text": "From here on, it plays like any other video."},
{"el": "v5-c-t", "payload": "segments", "ms": 1, "text": "If views return and stay up, the popularity service moves the video back to the hot store. If not, the copies age out of the caches, and it's cold again."}
]
},
{
"id": "stalls",
"label": "One network starts to stall",
"nodes": ["pb5", "db5", "cdn5", "ev5", "pop5"],
"steps": [
{"el": "v5-t-e", "payload": "stall_ms · isp: northway · man-2", "set": {"v.video": "every video", "v.last 10 minutes": "—", "v.manifest": "—", "v.stored in": "—", "n.preloaded": "—", "n.delivery": "—", "n.stalls": "0.4%"}, "text": "At 8 p.m., one internet provider's link into the Manchester site fills up. Nothing has failed. Servers are healthy, and every health check passes. Only the players can see it."},
{"el": "v5-e-pop", "payload": "stall rate by network + site", "set": {"n.stalls": "northway + man-2: 3%"}, "text": "The quality service groups stall rates by network and site. Northway through man-2 has gone from 0.4% to 3% in ten minutes. Northway through London is still fine, and so is every other network through man-2."},
{"el": "v5-pop-d", "payload": "northway, manchester → lon-5 first", "ms": 5, "text": "That pattern points to the path, not the machines. The service reorders the steering table for that one network and area, and removes the change again once the stall rate through man-2 returns to normal."},
{"el": "v5-t-p", "payload": "POST /play", "text": "A new viewer on Northway presses play."},
{"el": "v5-p-d", "payload": "SELECT steering", "text": "The playback service reads the steering table, which it keeps in memory and refreshes every few seconds."},
{"el": "v5-d-p", "payload": "lon-5 first", "ms": 1, "text": "London first."},
{"el": "v5-p-t", "payload": "hosts: lon-5, man-2", "text": "This viewer starts in London."},
{"el": "v5-t-c", "payload": "lon-5 · seg_000", "text": "A little further away, and over a path with room to spare."},
{"el": "v5-c-t", "payload": "segments", "ms": 1, "set": {"n.stalls": "northway: back to 0.5%"}, "text": "Players already watching notice slow segments for themselves and try their next host. Within about 15 minutes the stall rate is back to normal, and no human has been woken up."}
]
}
]
}
</script>
<div class="diagram-caption">Player events feed a service that sees which videos are rising and which networks are struggling. It preloads rising videos, adds efficient encodings where they repay the cost, and steers viewers around congested paths. Unwatched video moves to a cold store.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="pb5">
<strong>If a playback server fails:</strong> requests move to the others. Without any of them, no new plays start, while existing ones continue until their tokens expire.
</div>
<div class="failure-impact is-hidden" data-component="db5">
<strong>If the video database fails:</strong> popular rows and the steering table stay in memory at the playback service, so most plays still start, using the last known steering. Rarely watched videos can't start.
</div>
<div class="failure-impact is-hidden" data-component="cdn5">
<strong>If an edge site or shield fails:</strong> players move to their next host, and shields fail over to another region's. If many sites fail at once, the rest have less capacity than viewers need. Players measure the slower speeds and step down to lower qualities, which lowers the load.
</div>
<div class="failure-impact is-hidden" data-component="hot5">
<strong>If a zone of the hot store fails:</strong> everything still has copies in other zones. The caches cover most reads meanwhile.
</div>
<div class="failure-impact is-hidden" data-component="cold5">
<strong>If a zone of the cold store fails:</strong> each object loses 3 of its 9 fragments and is rebuilt from the other 6. Reads of old videos get slower. Popular videos aren't affected.
</div>
<div class="failure-impact is-hidden" data-component="ev5">
<strong>If the event stream fails:</strong> viewers keep watching, because no one's playback depends on it. Counts and steering fall behind, and players retry their events later, so counts catch up. No viewer notices, though a video going viral in that window gets no head start.
</div>
<div class="failure-impact is-hidden" data-component="pop5">
<strong>If the popularity service fails:</strong> preloads, AV1 and steering changes pause, and caches still fill on demand. The system costs more and reacts more slowly. It rebuilds its counts from the stream.
</div>
<div class="failure-impact is-hidden" data-component="enc5">
<strong>If part of the encode farm fails:</strong> AV1 work stops first, so new uploads keep their cores, and videos already ready aren't affected.
</div>
</div>

This is the full design. Uploads go directly to an object store in 8 MB parts, and the source is kept for good. A workflow splits each source into one-minute parts and encodes each part at five qualities on a fleet of workers, with leases so that a failure repeats one task. Each quality is cut into 4-second segments with keyframes in the same places, and a player reads a manifest and chooses each segment's quality for itself, from its measured speed and buffer. Segments never change, so about 200 edge sites and a shield in each region can hold copies for a year. Signed tokens let an edge check permission alone, and players carry a list of hosts to fall back on. Finally, player events feed a service that preloads rising videos, encodes popular ones in AV1, moves unwatched ones to cold storage, and steers viewers around struggling networks.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### Why 4 seconds?

Segment length is a trade between how quickly a player can react and how much each segment costs.

| | 2-second segments | 4-second segments | 10-second segments |
|---|---|---|---|
| Time before a quality change takes effect | Short | Moderate | Long |
| Requests per viewer per minute | 30 | 15 | 6 |
| Compression | Worst: a keyframe every 2 s | Good | Best: fewest keyframes |
| Cache objects per hour of video, per quality | 1,800 | 900 | 360 |
| Seek | Lands close to the target | Lands close to the target | Noticeable wait |

Keyframes are the expensive part of compressed video, since each is stored as a complete picture. Shorter segments force more of them, and bitrate rises to hold the same quality. Four seconds is a common middle choice for on-demand video. Live streams aiming for low delay accept the costs of something shorter.

### How the player chooses

**By throughput.** Estimate the connection's speed from recent segments, then pick the highest quality under, say, 70% of that. It reacts quickly, but mobile throughput is noisy, so it can bounce between qualities.

**By buffer.** Ignore speed and look at seconds buffered: below 10 seconds, the lowest quality; above 30, the highest; in between, step up with the buffer. It's steady and uses the connection well, but it has nothing to go on at the start, when the buffer is empty.

Good players combine them: throughput at the start and after a seek, the buffer once there's enough to read. Two more rules matter in practice. Move down quickly and up slowly, because a stall hurts far more than a slightly soft picture. And give up on a segment that's going badly. In the tunnel, the 1080p segment took 20 seconds. A player that notices after 3 seconds can cancel that download and fetch 360p instead, if it has less buffered than the download would take to finish.

### Encoding each video for itself

A fixed list of qualities wastes bytes. At 1080p, a talking head against a plain wall looks perfect at 2 Mbps, while a football match needs 6 Mbps or more. Per-title encoding runs a few quick trial encodes of each video at different bitrates, scores the results with a measure of perceived quality, and sets each rung of the ladder to the lowest bitrate that reaches the target. Encoding by scene goes further, changing the bitrate within a video.

It costs extra CPU once, and saves bytes on every view. Like AV1, it makes sense in proportion to a video's views. Some services run it only once a video has shown that it's being watched.

### One file, or thousands?

Stage 3 writes each segment as its own object: 750 for a 10-minute video, and about 375 million new objects a day. An object store pays a cost per object, in index entries and in small files on disk.

The alternative is one file per quality, with a segment index, where the player or edge requests byte ranges from it. The object count falls by a factor of 150. Edge caches now have to treat `bytes=X-Y` of one URL as a separate object, which modern ones can, so long as players ask for the same ranges every time. Formats like CMAF make this natural, and the same media can be described by both HLS and DASH manifests rather than being stored twice. Stage 3 uses separate files because they are easiest to reason about. The design is otherwise the same.

### Live is different

On-demand video gives the system time: the whole video exists before anyone presses play. Live removes that margin.

- **Encoding must keep up with the clock.** Each second of input must be encoded within a second, at every quality, with no way to try again. A hot standby encoder runs for important streams.
- **The manifest changes.** It lists the latest few segments, and players re-fetch it every few seconds, so it gets a very short cache time, where segments still get a long one.
- **Delay comes from segments.** Players hold about three segments before playing. With 4-second segments, viewers are 15 to 30 seconds behind. Shorter segments, or segments delivered in parts while they are being written, bring that down to a few seconds.
- **Everyone wants the same segment at the same moment.** Merging simultaneous misses, which is useful in Stage 4, becomes essential here.

### Counting views

A view is at least 30 seconds watched, once per session. Events arrive at least once, because players retry, so counting them directly would overcount. Each event carries `session_id`, and a stream job keeps recently seen sessions per video for an hour. Its one-minute totals are added to `view_counts`.

That number is good enough to show within a minute. Creator payments and public rankings use a slower daily batch job, which reads the same events and removes more duplicates and fraud. Showing the two as one number means a video's count can sometimes go down, and that is usually better than paying for fake views ([Batch vs Stream](#/systems/batch-vs-stream)).

### Encoding on demand

Most videos are hardly ever watched, yet Stage 2 encodes all five qualities of each before its first view. Half of that work may never be watched. An alternative encodes 360p and 720p up front, and the others only when someone first asks for them, for videos with few views.

Encoding on request means holding that first viewer's segment for seconds, or playing them a lower quality while the higher one is made. It saves storage and CPU, and it adds a new way for a segment request to fail. A gentler version waits for a few views, then queues the missing qualities in the background.

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### Delivery is the bill

270 PB a day dwarfs everything else: each day's delivery is about as many bytes as a year of new storage. Almost every decision in Stage 5 trades one-time CPU for bytes on every future view. The sum works only for popular videos, so the popularity service exists mostly to decide where that sum comes out ahead.

### Starting fast or starting sharp

Starting at 360p means the first few seconds look soft. Starting at 1080p risks a long wait on a slow connection. A player can remember the last measured speed on this network, and start higher for returning viewers. But a stale guess costs a stall in the first seconds, when viewers are most likely to give up.

### The long tail defeats the cache

Half the library might get a tiny share of views, and no edge can hold all of it. Every extra percentage point of edge hit rate costs more disk than the one before. The shield and cold store exist to make that long tail cheap to miss, because it can't be made cheap to hold.

### Splitting costs some quality

Parallel encoding treats each part alone, so the encoder can't borrow bits across a part boundary, and simple rate control may see a small visible change there. Longer parts, or a first pass over the whole video that plans the rate for all parts, reduce this. They also lengthen the wait, and an hour-long video in a queue makes every other upload wait unless the lanes are kept fair ([Distributed Task Queue](#/systems-case-studies/distributed-task-queue)).

### Keeping the source forever

Sources are half the new storage, and most are never read again after the first encode. Deleting them would cut 137 PB a year. It would also mean any future format had to be made from an already compressed copy, which loses quality. Cold storage keeps that choice open at about half the cost.

### Immutable URLs and manifest versions

Never changing a segment makes caching trivial, and means every change is a new version. Old versions must be kept until the last viewer's token expires, then cleaned up. A small correction, such as fixing one bad segment, means writing a new version of the manifest, and the edges will start the new version's segments with cold caches.

### One provider, or several

Running your own edge sites inside internet providers is cheapest at this scale, but takes years and carries the capacity risk. Renting from commercial CDNs is quick and flexible, and is charged by the byte. Large services do both: their own for the steady majority, others for peaks and for regions where they have few sites. The steering table is what makes that mix possible, and it means another party that may have a bad evening.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

The platform takes untrusted files from strangers, runs complex code on them, then serves them to the world. The risks are attacks through the file itself, viewers reaching what they shouldn't, and harmful content being published ([Security & Authentication](#/systems/security-authentication)).

### The uploaded file is an attack

Video decoders are large, old, complicated programs, and they parse files that are made by anyone. A crafted file can crash one, or take it over. So every worker that touches a source runs in a sandbox with no network access beyond its own object paths, no other secrets, a CPU and time limit, and a fresh start for each task. A file that hits a limit, or fails to decode, is marked `failed`.

### Signed URLs for upload

A signed upload URL permits writing one part of one upload, for one hour. A leaked URL can't read anything or touch another video. Uploads that aren't completed are deleted after a week, so they can't be used as free storage.

### Playback tokens

The token signs the video ID and an expiry. Without it, an edge refuses the request, so segment URLs can't simply be copied into another site. Tokens can add a country or a session for sensitive content, at the price of fewer shared links working. Signing keys rotate, and edges accept both the old and the new during the changeover. Blocking by country happens at the play call, using the viewer's address, and the edge repeats the check for restricted videos.

### Taking a video down

A year-long cache means a video removed for legal reasons is still on hundreds of edges. So a takedown does three things: the row changes to `removed`, so no more tokens are issued for it; the video ID goes on a block list every edge checks with each token; and a purge removes the cached segments across all sites, usually within a few seconds. Then the store deletes the objects.

### Paid content

A token stops casual copying, but doesn't stop a paying viewer saving the stream. Paid films are encrypted with per-title keys, and a separate licence service hands keys only to a device's protected hardware after checking the viewer's rights. Segments stay ordinary, shareable, cacheable files, because they're encrypted once and every viewer gets the same bytes. That's digital rights management, and it costs some device compatibility and complexity. It raises the effort of copying, and doesn't end it.

### Harmful and stolen content

Before a video goes public, the pipeline compares it to fingerprints of known illegal content and copyrighted works, and runs automated checks for violence and sexual content. Clear matches are blocked. Uncertain ones are limited and sent for human review. A fingerprint survives re-encoding and cropping, where an exact file hash wouldn't.

### Fake views

Views can earn money and rankings, so people buy them. Events are signed with the session's playback token, so they can't be invented without starting a real session. The slower daily batch job looks for sessions from known data centres, watch patterns that no person would have, and many sessions from one address. Those are removed from final counts, and repeat offenders lose their earnings.

### Limits on uploads

New accounts have limits on upload size and count per day. Encoding is the system's costliest work, and it can be consumed by anyone with a free account ([Rate Limiting](#/systems/rate-limiting)).

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **What viewers experience**: time to first frame, stall ratio, stalls per hour, average bitrate and quality changes per hour, by country, network, device and site.
- **Delivery**: bytes per second by site, edge and shield hit rates, origin bytes per second, and error rates by site.
- **Pipeline**: queue wait by lane, time from upload to ready at p50 and p99, failed workflows, and repeated tasks per worker.
- **Uploads**: success rate, resumes per upload, and share abandoned.
- **Stream**: event rate, consumer lag, and how far behind view counts are.
- **Storage**: bytes by tier, cold reads a second, and any segment listed in a manifest that can't be read.
- **Cost**: bytes delivered per hour watched, by format, and CPU-hours per minute of video.

([Observability](#/systems/observability))

### What to alert on

- **The stall ratio above 1% on any large network or country** for 10 minutes. It's the number viewers feel, and it often moves before any server looks unhealthy.
- **Origin bytes doubling** without traffic doubling. Something has gone wrong with the caches.
- Time to first frame p99 above **4 seconds**.
- Time to ready p99 above **30 minutes**, or the upload lane's queue wait rising for 15 minutes.
- **Any segment in a published manifest that can't be read.** Page immediately.
- Failed workflows rising sharply. One bad encoder release or one attacker's files can look the same.
- Event stream lag above **5 minutes**, which delays view counts and turns off the steering loop.

### "My video has been processing for an hour" — what happens?

Look up its workflow. If it's waiting in the queue, check the upload lane's wait for all videos: a surge in uploads means adding workers or pausing background work. If one task has been repeating, look at its attempts and logs. A task that crashes each worker it runs on has hit a bad part of the file, or a bug in the encoder. After three attempts, a part is marked failed so it stops consuming workers, and the pipeline either retries it with safer encoder settings or tells the creator what's wrong. If the state hasn't moved and no task is running, the workflow service itself lost track of the video: restart it from its saved state, since finished tasks won't repeat.

### "Everyone in one country is buffering tonight" — what happens?

Break the stall ratio down by network and by site. If it's one network through one site, it's a congested path, and steering should already have moved new viewers: check that the steering change happened. If it's all networks through one site, that site has a problem, so remove it from the host lists. If it's one network through every site, it's that provider's own network, and steering can only send viewers to whichever path is best, while lower qualities carry the load. If it's only one device or app version, it's a player release: roll it back.

### "The origin's traffic tripled, and viewers look fine" — what happens?

Viewers look fine because the origin is coping for now, and it won't for long. Compare hit rates by site, by object type and by release. The classic cause is the cache key: a new player version or edge config that includes the token, a session ID or some other parameter in the key makes every viewer's request a separate object, so nothing is shared. Hit rates fall to almost nothing for that traffic. Revert the change, and expect a surge of misses as caches refill. Merging simultaneous misses and the shields hold back the worst of it. Add the cache hit rate by release to the rollout checks.
