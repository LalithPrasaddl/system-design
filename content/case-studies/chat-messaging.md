# Chat / Messaging App

A chat app sends a message from one person to another, or to a group, in well under a second. That sounds simple. Three things make it hard. A message must arrive even when the recipient's phone is off, and it must arrive once, in the same order on every device that shows the conversation. The server can't wait for phones to ask for new messages; it has to push to them, which means holding hundreds of millions of connections open at once. And the small extras that make chat feel alive — "online", "typing…", "read" — produce more traffic than the messages themselves. This case study builds a system that handles all three.

<!-- tab:requirements:Requirements -->

## Requirements

This case study builds the messaging backend of a large consumer chat app, used on phones, desktop apps and the web.

### Functional requirements

- **One-to-one and group conversations.** Groups have up to 1,000 members.
- **Send and receive text messages** in real time, and media (photos, videos, files) by reference.
- **Message history** that a user can scroll back through, on any of their devices.
- **Multiple devices per user.** A phone, a laptop and a browser tab all show the same conversations and the same messages.
- **Offline delivery.** Messages sent to someone whose phone is off arrive when it comes back, and a push notification tells them there is something to read.
- **Receipts:** sent (✓), delivered (✓✓) and read.
- **Presence and typing indicators:** "online", "last seen 21:04", "Leo is typing…".

### Non-functional requirements

- **Never lose an acknowledged message.** Once the sender sees ✓, the message is stored durably and will reach every recipient.
- **No duplicates.** A message appears once, even when the sender's phone resends it after a dropped connection.
- **Same order everywhere.** Every device in a conversation shows its messages in the same order.
- **Fast.** When both people are online, a message reaches the recipient's device within **500ms at p99**, measured on the server. The sender's ✓ arrives within **200ms at p99**.
- **Highly available sending:** **99.99%**.
- **Presence and typing are best-effort.** They can be a few seconds stale, and losing one is acceptable.

### In scope

Persistent connections, message ordering, deduplication, storage and history, groups and fan-out, multi-device sync, offline push, receipts, presence and typing.

### Out of scope

**Voice and video calls**, which use a separate media path. **Broadcast channels** with hundreds of thousands of followers, which are a feed rather than a conversation ([Social Media News Feed](#/systems-case-studies/news-feed)). **Search over message history.** **Encryption key management** — the Security tab covers what end-to-end encryption changes in this design, but not the cryptographic protocol itself.

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

The message rate is large but ordinary. What shapes the design is everything around it: the number of connections held open, the number of devices each message must reach, and the background traffic that keeps connections and presence alive.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Messages sent</div>
<div class="stat-tile-value">~700<span class="stat-tile-unit">K/sec</span></div>
<div class="stat-tile-sub">at peak</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Open connections</div>
<div class="stat-tile-value">200<span class="stat-tile-unit">M</span></div>
<div class="stat-tile-sub">at peak</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Device deliveries</div>
<div class="stat-tile-value">~3.9<span class="stat-tile-unit">M/sec</span></div>
<div class="stat-tile-sub">at peak</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Heartbeats</div>
<div class="stat-tile-value">~6.7<span class="stat-tile-unit">M/sec</span></div>
<div class="stat-tile-sub">more than all messages</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Message history</div>
<div class="stat-tile-value">~5<span class="stat-tile-unit">TB/day</span></div>
<div class="stat-tile-sub">text only, before replication</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Delivery target</div>
<div class="stat-tile-value">500<span class="stat-tile-unit">ms</span></div>
<div class="stat-tile-sub">p99, online to online</div>
</div>
</div>

### Assumptions

- **1 billion** registered users, **500 million** active each day, with about **1.5 devices** each.
- At peak, **200 million** devices are connected at the same moment.
- Each active user sends **40 messages a day**. Peak traffic is about **3×** the average.
- **70%** of messages are one-to-one. Groups average **10 members**.
- A text message averages **100 bytes**; about **5%** of messages carry media.

### Messages

- 500 million users × 40 = **20 billion messages a day**, about **230,000/sec**, peaking at **~700,000/sec**.

### Deliveries

Each message must reach every device of every recipient, plus the sender's own other devices.

- A one-to-one message reaches one recipient: about 1.5 devices, plus about 0.5 of the sender's other devices.
- A group message reaches 9 other members: about 13.5 devices.
- Weighted: 0.7 × 2 + 0.3 × 14 ≈ **5.6 devices per message**: about **112 billion deliveries a day**, **~1.3M/sec** on average and **~3.9M/sec** at peak.

### Connections

A server process can hold a few hundred thousand idle connections. Each one costs about 20KB of memory for its TLS state and buffers, so 250,000 connections is about 5GB — memory isn't the limit; the CPU cost of handshakes and heartbeats is. 200 million connections ÷ 250,000 per server is **800 servers**. Losing one of three zones must not overload the rest, so plan for about **1,200**.

### Heartbeats

Phones on mobile networks sit behind network address translators that silently drop connections idle for more than a minute or two. Each connection sends a small heartbeat about every **30 seconds** to stay open and to prove it is still alive. 200 million ÷ 30 = **~6.7 million heartbeats a second** — ten times the peak message rate. Whatever handles heartbeats must never touch a database.

### Storage

- **History:** about 250 bytes per message with its metadata and index entries. 20 billion × 250 bytes = **~5TB a day**, **~1.8PB a year**, **~5.5PB** with three replicas. History is kept indefinitely, so this only grows.
- **Media:** 1 billion media messages a day at ~200KB each is **~200TB a day**, in object storage, not in the message store. It dwarfs everything else and is a separate problem.
- **Per-user sync log** (Stage 4): about 4 copies of each message, ~20TB a day written, but each entry is removed once every device has it. Its live size is set by devices that are offline, not by total traffic.

### Presence

If every status change were sent to every contact, 500 million users × 10 changes a day × 200 contacts = **1 trillion presence updates a day**, about 12 million a second — far more than the messages. Stage 5 avoids this.

<!-- tab:api-design:API Design -->

## API Design

A chat client talks to the server in two ways. **A WebSocket** carries everything that happens live: sending, receiving, receipts, typing ([Real-Time Delivery](#/systems/realtime-delivery)). **Plain HTTP** carries everything that is a request for data: history, conversation lists, media uploads.

### The connection

```
GET wss://chat.example.com/v1/connect
Authorization: Bearer <access token>
X-Device-Id: d_ios_3f21
→ 101 Switching Protocols
```

### Frames from the client

```
{"t": "send",      "conv": "c_481", "client_msg_id": "c_9f2e71", "body": "on my way"}
{"t": "delivered", "conv": "c_481", "up_to": 1044}
{"t": "read",      "conv": "c_481", "up_to": 1044}
{"t": "sync",      "since": 88412}
{"t": "typing",    "conv": "c_481"}
{"t": "watch",     "users": ["u_maya"]}
{"t": "ping"}
```

### Frames from the server

```
{"t": "ack",      "client_msg_id": "c_9f2e71", "conv": "c_481", "seq": 1044,
                  "msg_id": "364018610995269632", "ts": "2026-10-04T21:02:11.402Z"}
{"t": "msg",      "conv": "c_481", "seq": 1044, "from": "u_maya",
                  "body": "on my way", "user_seq": 88413}
{"t": "receipt",  "conv": "c_481", "user": "u_leo", "kind": "read", "up_to": 1044}
{"t": "presence", "user": "u_maya", "status": "last_seen", "at": "2026-10-04T21:04:00Z"}
{"t": "typing",   "conv": "c_481", "user": "u_leo"}
{"t": "error",    "client_msg_id": "c_9f2e71", "code": "not_member"}
{"t": "pong"}
```

### HTTP

```
GET  /v1/conversations?updated_after=2026-10-01T00:00:00Z
POST /v1/conversations                  {"kind": "group", "title": "Trip", "members": ["u_leo", "u_ana"]}
GET  /v1/conversations/c_481/messages?before_seq=1044&limit=50
POST /v1/conversations/c_481/members    {"add": ["u_sam"]}
POST /v1/media                          → {"media_id": "m_7a1", "upload_url": "<signed URL>"}
POST /v1/devices                        {"push_token": "…", "platform": "ios"}
```

| Code | Meaning |
|---|---|
| `101` | WebSocket opened |
| `200` / `201` | Success, for history, conversations and uploads |
| `401` | Access token missing or expired: refresh it and reconnect |
| `403` | Not a member of this conversation |
| `413` | Message or upload too large |
| `429` | Over a sending or connection limit: back off |
| Close `4001` | Token expired on an open connection: refresh and reconnect |
| Close `4008` | Server is draining for a restart: reconnect, after a random delay |
| Error `not_member` | A send to a conversation the user has left or been removed from |

### Why the details matter

**The client chooses `client_msg_id` before the first attempt.** It is created when the user taps send, stored on the phone with the unsent message, and reused on every retry. That is what lets the server recognize a resend as the same message ([Idempotency & Exactly-Once Delivery](#/systems/idempotency)).

**The server's `ack` carries the sequence number.** The order of messages in a conversation is decided by the server, never by the phone's clock. Phones' clocks are often wrong by seconds or minutes, and a message ordered by the sender's clock can appear above messages that were sent before it.

**Receipts are watermarks.** `"read", "up_to": 1044` means everything up to message 1044 has been read. One frame replaces one per message, and a lost frame is fixed by the next one.

**`sync` takes one number.** A device that reconnects sends the position it reached in its own sync log, not a position for each of its conversations (Stage 4).

**History is plain HTTP.** Scrolling back is a paginated read that can be cached and retried like any other request. It has no reason to share the live connection.

**Media is uploaded first, sent second.** The client uploads the file to object storage through a signed URL, then sends a normal message that refers to it by `media_id`. The message path never carries megabytes.

<!-- tab:data-model:Data Model -->

## Data Model

There are three kinds of data. **Durable history** — conversations, members and messages — is kept forever and is the record of what was said. **Delivery state** — each user's sync log and each device's position in it — exists to get messages to devices and is trimmed once they have them. **Live state** — who is connected where, who is online — lives in memory and is rebuilt from the connections themselves if it is lost.

### Conversations and members

```
conversations                             -- partitioned by conv_id
  conv_id          BIGINT  PRIMARY KEY
  kind             TEXT                   -- direct | group
  title            TEXT
  member_count     INT
  last_seq         BIGINT                 -- highest sequence number assigned
  created_at       TIMESTAMP

members                                   -- partitioned by conv_id
  conv_id          BIGINT
  user_id          BIGINT
  role             TEXT                   -- member | admin
  joined_seq       BIGINT                 -- history is visible from here on
  delivered_seq    BIGINT                 -- watermark: delivered to at least one device
  read_seq         BIGINT                 -- watermark: read
  PRIMARY KEY (conv_id, user_id)

user_conversations                        -- partitioned by user_id
  user_id          BIGINT
  conv_id          BIGINT
  last_activity_at TIMESTAMP
  muted, pinned    BOOLEAN
  PRIMARY KEY (user_id, conv_id)
```

`members` is partitioned by conversation, because the message service asks "who is in this conversation?" on every send. `user_conversations` holds the same membership the other way round, for the conversation list on a user's screen. The two are kept in step by the membership change itself, which is rare.

### Messages

```
messages                                  -- partitioned by conv_id
  conv_id          BIGINT
  seq              BIGINT                 -- clustered, descending
  msg_id           BIGINT                 -- globally unique, time-ordered
  sender_id        BIGINT
  sender_device    TEXT
  client_msg_id    TEXT                   -- unique per (conv_id, sender_device)
  kind             TEXT                   -- text | media | system | edit | delete
  body             BYTES                  -- ciphertext under end-to-end encryption
  media_id         TEXT
  created_at       TIMESTAMP
  PRIMARY KEY (conv_id, seq)
```

A conversation's messages live in one partition, newest first, so opening a chat is one range read. `seq` counts up from 1 within each conversation with no gaps, so a device that sees 1047 right after 1045 knows it is missing one. `msg_id` is a globally unique, time-ordered ID for references from elsewhere — replies, media, reports ([Distributed ID Generator](#/systems-case-studies/distributed-id-generator)). Edits and deletions are new rows with their own `seq` that refer to the original, so every device learns about them through the same ordered stream.

This is a wide-column store's ideal workload: append-only writes, reads by partition and range, and data that grows forever ([Databases II — NoSQL Models](#/systems/databases-nosql)). A conversation that has been busy for years is split into time buckets within its partition key, so no single partition grows without limit.

### Delivery state

```
sync_log                                  -- partitioned by user_id
  user_id          BIGINT
  user_seq         BIGINT                 -- this user's own counter, clustered ascending
  conv_id          BIGINT
  seq              BIGINT
  event            TEXT                   -- message | edit | delete | read | membership
  payload          BYTES                  -- a copy of the message
  PRIMARY KEY (user_id, user_seq)

device_cursors
  user_id          BIGINT
  device_id        TEXT
  synced_up_to     BIGINT                 -- the user_seq this device has acknowledged
  push_token       TEXT
  PRIMARY KEY (user_id, device_id)
```

Each user has one ordered log of everything their devices need to hear about, across all conversations, and each device has a position in it. Entries are deleted once every device has passed them, or after 30 days; a device away longer than that rebuilds from history instead.

### Live state

```
sessions          (in memory, replicated)  user_id → [(device_id, gateway_id, connected_at)]   TTL 90s
presence          (in memory)              user_id → online | last_seen_at                     TTL 60s
watchers          (in memory)              user_id → gateways with someone watching
```

Nothing here is written to disk on the hot path. Every entry expires unless the connection that created it keeps refreshing it, so a crashed server's entries disappear on their own.

<!-- tab:architecture:Architecture:default -->

This case study builds the chat system up in five stages. Each stage fixes a specific failure of the one before. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one message at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. Polling -->

## Stage 1 — One Server, and Phones That Ask

The smallest version that works: one stateless HTTP server and a database. Sending is a `POST`. Receiving is a `GET` that asks "anything after the last message I have?", which every phone repeats every 3 seconds while the app is open.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 600 280" width="600" height="280" role="img" aria-label="Maya's phone and Leo's phone both talking to one chat server over HTTP; the server reads and writes a message database">
  <rect x="16" y="40" width="120" height="44" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="76" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Maya's Phone</text>
  <rect x="16" y="190" width="120" height="44" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="76" y="216" text-anchor="middle" class="d-actor-label" font-size="12">Leo's Phone</text>
  <g data-fail-toggle="srv1">
    <rect x="230" y="110" width="140" height="50" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="300" y="132" text-anchor="middle" class="d-actor-label" font-size="12">Chat Server</text>
    <text x="300" y="148" text-anchor="middle" class="d-label-muted" font-size="9">HTTP · stateless</text>
  </g>
  <g data-fail-toggle="db1">
    <rect x="440" y="110" width="140" height="50" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="510" y="132" text-anchor="middle" class="d-actor-label" font-size="12">Database</text>
    <text x="510" y="148" text-anchor="middle" class="d-label-muted" font-size="9">messages by conversation</text>
  </g>
  <line id="c1-maya-srv" x1="138" y1="54" x2="226" y2="118" class="d-msg d-request" data-depends-on="srv1" marker-end="url(#arrowC1)"></line>
  <line id="c1-srv-maya" x1="226" y1="132" x2="138" y2="70" class="d-msg d-response" data-depends-on="srv1" marker-end="url(#arrowC1r)"></line>
  <line id="c1-leo-srv" x1="138" y1="200" x2="226" y2="142" class="d-msg d-request" data-depends-on="srv1" marker-end="url(#arrowC1)"></line>
  <line id="c1-srv-leo" x1="226" y1="156" x2="138" y2="216" class="d-msg d-response" data-depends-on="srv1" marker-end="url(#arrowC1r)"></line>
  <line id="c1-srv-db" x1="372" y1="126" x2="436" y2="126" class="d-msg d-request" data-depends-on="srv1 db1" marker-end="url(#arrowC1)"></line>
  <line id="c1-db-srv" x1="436" y1="144" x2="372" y2="144" class="d-msg d-response" data-depends-on="srv1 db1" marker-end="url(#arrowC1r)"></line>
  <text x="300" y="268" text-anchor="middle" class="d-label-muted" font-size="10">play the message, then the empty poll, then the lost answer</text>
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
{"id": "leo", "title": "Leo's phone", "rows": [["messages shown", "…1043"], ["time after Maya sent", "—"]]},
{"id": "load", "title": "Server load at 200M open apps", "rows": [["polls per second", "—"], ["polls that find nothing", "—"]]}
],
"flows": [
{
"id": "poll",
"label": "Maya sends, Leo's phone asks",
"nodes": ["srv1", "db1"],
"steps": [
{"el": "c1-maya-srv", "payload": "POST ‘on my way’", "text": "Maya sends Leo a message. Her phone posts it to the chat server."},
{"el": "c1-srv-db", "payload": "insert c_481 #1044", "text": "The server gives it the next number in the conversation, 1044, and stores it."},
{"el": "c1-db-srv", "payload": "OK", "ms": 4, "text": "Stored."},
{"el": "c1-srv-maya", "payload": "201 #1044", "text": "Maya's phone shows the message as sent. Leo doesn't know about it yet, and nothing can tell him: the server has no way to reach his phone. It can only answer when the phone asks."},
{"el": "c1-leo-srv", "payload": "GET after 1043", "text": "2.1 seconds later, Leo's phone asks its regular question: anything in this conversation after message 1043?"},
{"el": "c1-srv-db", "payload": "c_481 after 1043", "text": "The server checks."},
{"el": "c1-db-srv", "payload": "#1044", "ms": 3, "text": "One new message."},
{"el": "c1-srv-leo", "payload": "‘on my way’", "set": {"leo.messages shown": "…1044", "leo.time after Maya sent": "~2.1s (up to 3s)"}, "text": "Leo sees it 2.1 seconds after Maya sent it. With a 3-second interval the wait is anywhere from 0 to 3 seconds, and averages 1.5. That's slow for a conversation, and the cost of making it faster is the next flow."}
]
},
{
"id": "empty",
"label": "Nothing new — asked again anyway",
"nodes": ["srv1", "db1"],
"steps": [
{"el": "c1-leo-srv", "payload": "GET after 1044", "text": "Three seconds later Leo's phone asks again."},
{"el": "c1-srv-db", "payload": "c_481 after 1044", "text": "The server checks the database."},
{"el": "c1-db-srv", "payload": "nothing", "ms": 3, "text": "Nothing new."},
{"el": "c1-srv-leo", "payload": "200 []", "set": {"load.polls per second": "~67 million", "load.polls that find nothing": "~99%"}, "text": "Multiply by every open app: 200 million devices asking every 3 seconds is about 67 million requests a second, against 700,000 messages a second at peak. Ninety-nine polls in a hundred find nothing. Asking every second, to make chat feel live, triples it. Holding each request open until something arrives — long polling — removes the empty answers, but the server then needs to know which held request belongs to which user, which is exactly what the next stage builds properly."}
]
},
{
"id": "lost",
"label": "Maya's phone loses the answer",
"nodes": ["srv1", "db1"],
"steps": [
{"el": "c1-maya-srv", "payload": "POST ‘running late’", "set": {"leo.messages shown": "…1044", "leo.time after Maya sent": "—"}, "text": "Maya sends another message from a train."},
{"el": "c1-srv-db", "payload": "insert #1045", "text": "The server stores it as 1045."},
{"el": "c1-db-srv", "payload": "OK", "ms": 4, "text": "Stored."},
{"el": "c1-srv-maya", "payload": "(lost in a tunnel)", "text": "The answer never reaches her phone: the train enters a tunnel and the connection drops. The message was stored. Maya's phone doesn't know that, and shows a clock icon."},
{"el": "c1-maya-srv", "payload": "POST ‘running late’", "text": "When the signal returns, the phone does the sensible thing and sends the unsent message again."},
{"el": "c1-srv-db", "payload": "insert #1046", "text": "The server can't tell this is a repeat. It is a new request with the same text, and someone could genuinely send the same text twice."},
{"el": "c1-db-srv", "payload": "OK", "ms": 4, "set": {"leo.messages shown": "…1046 (‘running late’ × 2)"}, "text": "Stored again, as 1046."},
{"el": "c1-srv-maya", "payload": "201 #1046", "text": "Leo will see ‘running late’ twice. Mobile networks drop connections all the time, so this isn't rare. Stage 3 makes the resend harmless."}
]
}
]
}
</script>
<div class="diagram-caption">The server can only answer; it can never speak first. Every message waits for the recipient's next poll, and every poll that finds nothing still costs a request and a database read.</div>
</div>

<div class="fail-hint">Click the chat server or the database to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="srv1">
<strong>If the chat server fails:</strong> nobody can send or receive. Because it keeps no state, the fix is simple: run several copies behind a load balancer ([Load Balancing](#/systems/load-balancing)). That is the one thing this design does well — a property the next stage gives up.
</div>
<div class="failure-impact is-hidden" data-component="db1">
<strong>If the database fails:</strong> sends fail and polls fail. Phones keep their unsent messages and retry, which is fine — until the database comes back and 200 million phones' polls and retries arrive at once.
</div>
</div>

Polling works for a few thousand users. It fails because the server has no way to speak first: latency is set by the polling interval, and nearly all the work is answering "no". The next stage keeps a connection open so the server can push.

<!-- stage:2:2. Persistent Connections -->

## Stage 2 — Hold a Connection Open

Each phone opens one **WebSocket** to the chat server when the app starts, and keeps it open. The server keeps a map in memory from each user to their open connection. When a message arrives, the server stores it, then writes it straight down the recipient's connection. No polling.

The rule that makes this safe is the order of operations: **store, then acknowledge, then deliver**. The sender's ✓ means the message is in the database, and a recipient that missed the live push can always fetch it.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 640 280" width="640" height="280" role="img" aria-label="Maya's and Leo's phones each holding an open WebSocket to one chat server, which keeps a map of connections in memory and writes to a message database">
  <rect x="16" y="40" width="120" height="44" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="76" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Maya's Phone</text>
  <rect x="16" y="190" width="120" height="44" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="76" y="216" text-anchor="middle" class="d-actor-label" font-size="12">Leo's Phone</text>
  <g data-fail-toggle="srv2">
    <rect x="230" y="100" width="150" height="70" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="305" y="124" text-anchor="middle" class="d-actor-label" font-size="12">Chat Server</text>
    <text x="305" y="141" text-anchor="middle" class="d-label-muted" font-size="9">open connections in memory</text>
    <text x="305" y="156" text-anchor="middle" class="d-label-muted" font-size="9">maya → conn 17 · leo → conn 42</text>
  </g>
  <g data-fail-toggle="db2">
    <rect x="460" y="110" width="150" height="50" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="535" y="132" text-anchor="middle" class="d-actor-label" font-size="12">Message Database</text>
    <text x="535" y="148" text-anchor="middle" class="d-label-muted" font-size="9">by conversation · seq</text>
  </g>
  <line id="c2-maya-srv" x1="138" y1="52" x2="226" y2="112" class="d-msg d-request" data-depends-on="srv2" marker-end="url(#arrowC2)"></line>
  <line id="c2-srv-maya" x1="226" y1="126" x2="138" y2="70" class="d-msg d-response" data-depends-on="srv2" marker-end="url(#arrowC2r)"></line>
  <line id="c2-leo-srv" x1="138" y1="204" x2="226" y2="154" class="d-msg d-request" data-depends-on="srv2" marker-end="url(#arrowC2)"></line>
  <line id="c2-srv-leo" x1="226" y1="166" x2="138" y2="220" class="d-msg d-response" data-depends-on="srv2" marker-end="url(#arrowC2r)"></line>
  <line id="c2-srv-db" x1="382" y1="126" x2="456" y2="126" class="d-msg d-request" data-depends-on="srv2 db2" marker-end="url(#arrowC2)"></line>
  <line id="c2-db-srv" x1="456" y1="144" x2="382" y2="144" class="d-msg d-response" data-depends-on="srv2 db2" marker-end="url(#arrowC2r)"></line>
  <text x="320" y="268" text-anchor="middle" class="d-label-muted" font-size="10">play the live message, then Leo offline, then the restart</text>
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
{"id": "maya", "title": "Maya's screen", "rows": [["latest message", "—"]]},
{"id": "leo", "title": "Leo's phone", "rows": [["connection", "open (conn 42)"], ["last seq", "1043"]]}
],
"flows": [
{
"id": "live",
"label": "Live delivery",
"nodes": ["srv2", "db2"],
"steps": [
{"el": "c2-maya-srv", "payload": "send ‘on my way’", "text": "Maya's phone sends the message as a frame on the WebSocket it opened when the app started."},
{"el": "c2-srv-db", "payload": "insert c_481 #1044", "text": "The server assigns the next sequence number in the conversation and stores the message."},
{"el": "c2-db-srv", "payload": "OK", "ms": 4, "text": "Stored, and replicated before the database answers."},
{"el": "c2-srv-maya", "payload": "ack #1044", "set": {"maya.latest message": "‘on my way’ ✓"}, "text": "Maya's phone shows one tick. It means the server has the message — not that Leo does."},
{"el": "c2-srv-leo", "payload": "msg #1044", "ms": 1, "set": {"leo.last seq": "1044"}, "text": "The server looks Leo up in its in-memory map, finds connection 42, and writes the message down it. Leo's phone receives it about 5ms after Maya sent it. Nothing asked for it."},
{"el": "c2-leo-srv", "payload": "delivered up_to 1044", "text": "Leo's phone confirms that it has everything up to 1044."},
{"el": "c2-srv-maya", "payload": "delivered #1044", "set": {"maya.latest message": "‘on my way’ ✓✓"}, "text": "The server passes that on to Maya: two ticks."}
]
},
{
"id": "offline",
"label": "Leo is offline, then reconnects",
"nodes": ["srv2", "db2"],
"steps": [
{"el": "c2-maya-srv", "payload": "send ‘running late’", "set": {"leo.connection": "closed (on the underground)", "leo.last seq": "1044"}, "text": "Leo is on the underground with no signal. His connection closed, and the server removed him from its map. Maya sends a message."},
{"el": "c2-srv-db", "payload": "insert #1045", "text": "Stored as 1045, as before."},
{"el": "c2-db-srv", "payload": "OK", "ms": 4, "text": "Stored."},
{"el": "c2-srv-maya", "payload": "ack #1045", "set": {"maya.latest message": "‘running late’ ✓"}, "text": "One tick for Maya. The server finds no connection for Leo, so it does nothing more. The message is safe in the database; there is nothing to hold or retry."},
{"el": "c2-leo-srv", "payload": "connect · last seq 1044", "set": {"leo.connection": "open (conn 51)"}, "text": "Twenty minutes later Leo's phone has signal again. It reconnects and says where it got to: message 1044."},
{"el": "c2-srv-db", "payload": "c_481 after 1044", "text": "The server reads everything after that."},
{"el": "c2-db-srv", "payload": "#1045", "ms": 3, "text": "One message."},
{"el": "c2-srv-leo", "payload": "#1045", "set": {"leo.last seq": "1045"}, "text": "Leo has it. The server never had to remember what Leo missed — the phone's own position is the bookmark. Live push is for speed; this catch-up read is what makes delivery certain."},
{"el": "c2-leo-srv", "payload": "delivered up_to 1045", "text": "Leo's phone confirms."},
{"el": "c2-srv-maya", "payload": "delivered #1045", "set": {"maya.latest message": "‘running late’ ✓✓"}, "text": "Maya gets her second tick twenty minutes after the first. That gap is what ✓ and ✓✓ exist to show."}
]
},
{
"id": "restart",
"label": "The server restarts",
"nodes": ["srv2"],
"steps": [
{"el": "c2-srv-maya", "payload": "connection closed", "text": "A new version of the chat server is deployed. Restarting the process closes every connection it holds."},
{"el": "c2-srv-leo", "payload": "connection closed", "set": {"leo.connection": "closed"}, "text": "Leo's too. Every connected user is cut off at the same moment."},
{"el": "c2-maya-srv", "payload": "reconnect", "text": "Every phone notices within seconds and reconnects. Each reconnection costs a TLS handshake, an authentication check and a catch-up read — and they all happen at once."},
{"el": "c2-leo-srv", "payload": "reconnect · last seq 1045", "set": {"leo.connection": "open (conn 8)"}, "text": "Leo is back. On one server, this works. But one server holds a few hundred thousand connections, and this app needs 200 million. With many servers, Maya and Leo will usually be connected to different ones — and Maya's server has no map entry for Leo."}
]
}
]
}
</script>
<div class="diagram-caption">The server keeps each user's open connection in a map and pushes messages down it. Messages are always stored before they are acknowledged, so a recipient who was offline catches up from the database by saying how far they got.</div>
</div>

<div class="fail-hint">Click the chat server or the message database to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="srv2">
<strong>If the chat server fails:</strong> every connection drops, and the in-memory map is gone. Nothing durable is lost — every acknowledged message is in the database, and phones still hold their unacknowledged ones. But every client reconnects at once. If they all retry immediately, the restarted server is flattened by handshakes before it can serve anyone. Clients must wait a random delay, growing with each failed attempt, before reconnecting.
</div>
<div class="failure-impact is-hidden" data-component="db2">
<strong>If the message database fails:</strong> the server can't store messages, so it must not acknowledge them. It could still push them to connected recipients, but it must not: a recipient would then have a message that the sender believes failed and will send again. Sends wait on the phone and retry. Connections stay open, so recovery is quick when the database returns.
</div>
</div>

The server can now push, and offline users catch up correctly. But all of it depends on one machine holding every connection and the only map of where everyone is. The next stage spreads connections across many servers and makes the map shared.

<!-- stage:3:3. Gateways & Ordering -->

## Stage 3 — Many Gateways, One Owner per Conversation

Split the chat server into three parts, each with one job.

- **Gateways** hold connections, and nothing else. A load balancer spreads phones across about 1,200 of them. A gateway authenticates the connection, passes frames on, and writes frames down sockets.
- A **session registry** records which gateway each user's devices are connected to. Gateways write to it when a device connects, and refresh the entry with each heartbeat batch.
- The **message service** does the real work. It is partitioned by conversation, so every message in a conversation goes through the same **owner** ([Partitioning & Sharding](#/systems/partitioning-sharding)). The owner assigns sequence numbers, rejects duplicates, stores the message, and sends it to recipients' gateways.

One owner per conversation is what gives every device the same order: there is only one place that hands out the next number. It also makes deduplication cheap, because every resend of a message reaches the same owner.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 760 410" width="760" height="410" role="img" aria-label="Maya's phone on gateway A and Leo's phone on gateway B; a message service owns the conversation, writes to a message store, and finds Leo's gateway in a session registry; Leo can reconnect to gateway C">
  <rect x="10" y="30" width="110" height="44" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="65" y="56" text-anchor="middle" class="d-actor-label" font-size="12">Maya's Phone</text>
  <g data-fail-toggle="gwa3">
    <rect x="150" y="30" width="120" height="44" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="210" y="50" text-anchor="middle" class="d-actor-label" font-size="12">Gateway A</text>
    <text x="210" y="65" text-anchor="middle" class="d-label-muted" font-size="9">Maya's socket</text>
  </g>
  <g data-fail-toggle="ms3">
    <rect x="330" y="150" width="150" height="64" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="405" y="172" text-anchor="middle" class="d-actor-label" font-size="12">Message Service</text>
    <text x="405" y="188" text-anchor="middle" class="d-label-muted" font-size="9">owner of c_481</text>
    <text x="405" y="202" text-anchor="middle" class="d-label-muted" font-size="9">assigns seq · rejects repeats</text>
  </g>
  <g data-fail-toggle="store3">
    <rect x="570" y="40" width="170" height="48" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="655" y="60" text-anchor="middle" class="d-actor-label" font-size="12">Message Store</text>
    <text x="655" y="76" text-anchor="middle" class="d-label-muted" font-size="9">by conversation · seq</text>
  </g>
  <g data-fail-toggle="reg3">
    <rect x="570" y="270" width="170" height="48" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="655" y="290" text-anchor="middle" class="d-actor-label" font-size="12">Session Registry</text>
    <text x="655" y="306" text-anchor="middle" class="d-label-muted" font-size="9">user → gateway · in memory</text>
  </g>
  <g data-fail-toggle="gwb3">
    <rect x="150" y="260" width="120" height="44" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="210" y="280" text-anchor="middle" class="d-actor-label" font-size="12">Gateway B</text>
    <text x="210" y="295" text-anchor="middle" class="d-label-muted" font-size="9">Leo's socket</text>
  </g>
  <rect x="10" y="300" width="110" height="44" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="65" y="326" text-anchor="middle" class="d-actor-label" font-size="12">Leo's Phone</text>
  <rect x="150" y="340" width="120" height="44" rx="6" class="d-actor-box" data-role="routing"></rect>
  <text x="210" y="366" text-anchor="middle" class="d-actor-label" font-size="12">Gateway C</text>
  <line id="c3-maya-gwa" x1="122" y1="46" x2="146" y2="46" class="d-msg d-request" data-depends-on="gwa3" marker-end="url(#arrowC3)"></line>
  <line id="c3-gwa-maya" x1="146" y1="62" x2="122" y2="62" class="d-msg d-response" data-depends-on="gwa3" marker-end="url(#arrowC3r)"></line>
  <line id="c3-gwa-ms" x1="250" y1="76" x2="350" y2="146" class="d-msg d-request" data-depends-on="gwa3 ms3" marker-end="url(#arrowC3)"></line>
  <line id="c3-ms-gwa" x1="366" y1="146" x2="266" y2="76" class="d-msg d-response" data-depends-on="gwa3 ms3" marker-end="url(#arrowC3r)"></line>
  <line id="c3-ms-store" x1="482" y1="166" x2="596" y2="92" class="d-msg d-request" data-depends-on="ms3 store3" marker-end="url(#arrowC3)"></line>
  <line id="c3-store-ms" x1="612" y1="92" x2="482" y2="180" class="d-msg d-response" data-depends-on="ms3 store3" marker-end="url(#arrowC3r)"></line>
  <line id="c3-ms-reg" x1="482" y1="190" x2="570" y2="256" class="d-msg d-request" data-depends-on="ms3 reg3" marker-end="url(#arrowC3)"></line>
  <line id="c3-reg-ms" x1="570" y1="270" x2="482" y2="204" class="d-msg d-response" data-depends-on="ms3 reg3" marker-end="url(#arrowC3r)"></line>
  <line id="c3-ms-gwb" x1="330" y1="200" x2="274" y2="262" class="d-msg d-request" data-depends-on="ms3 gwb3" marker-end="url(#arrowC3)"></line>
  <line id="c3-gwb-ms" x1="276" y1="276" x2="342" y2="216" class="d-msg d-response" data-depends-on="ms3 gwb3" marker-end="url(#arrowC3r)"></line>
  <line id="c3-gwb-leo" x1="148" y1="284" x2="122" y2="308" class="d-msg d-request" data-depends-on="gwb3" marker-end="url(#arrowC3)"></line>
  <line id="c3-leo-gwb" x1="122" y1="318" x2="148" y2="298" class="d-msg d-response" data-depends-on="gwb3" marker-end="url(#arrowC3r)"></line>
  <line id="c3-leo-gwc" x1="122" y1="334" x2="148" y2="352" class="d-msg d-request" marker-end="url(#arrowC3)"></line>
  <line id="c3-gwc-leo" x1="148" y1="368" x2="122" y2="342" class="d-msg d-response" marker-end="url(#arrowC3r)"></line>
  <line id="c3-gwc-reg" x1="272" y1="356" x2="568" y2="300" class="d-msg d-request" data-depends-on="reg3" marker-end="url(#arrowC3)"></line>
  <line id="c3-gwc-ms" x1="262" y1="338" x2="380" y2="216" class="d-msg d-request" data-depends-on="ms3" marker-end="url(#arrowC3)"></line>
  <line id="c3-ms-gwc" x1="396" y1="216" x2="274" y2="342" class="d-msg d-response" data-depends-on="ms3" marker-end="url(#arrowC3r)"></line>
  <text x="380" y="402" text-anchor="middle" class="d-label-muted" font-size="10">play the message, then the lost ack, then fail gateway B and replay the first flow before playing the crash</text>
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
{"id": "conv", "title": "Conversation c_481", "rows": [["last seq", "1043"], ["recent client IDs", "…"]]},
{"id": "reg", "title": "Session registry", "rows": [["maya", "gateway A"], ["leo", "gateway B"]]},
{"id": "ph", "title": "Phones", "rows": [["Maya sees", "—"], ["Leo's last seq", "1043"]]}
],
"flows": [
{
"id": "cross",
"label": "Maya and Leo on different gateways",
"nodes": ["gwa3", "ms3", "store3", "reg3", "gwb3"],
"steps": [
{"el": "c3-maya-gwa", "payload": "send c_9f2e · ‘on my way’", "text": "Maya's phone is connected to gateway A, one of about 1,200. Her app sends the message with a client message ID, c_9f2e, created when she tapped send."},
{"el": "c3-gwa-ms", "payload": "c_481 · c_9f2e", "text": "Gateway A doesn't process messages. It forwards this one to the message service instance that owns conversation c_481. Every message in this conversation, from any member on any gateway, goes to this same owner."},
{"el": "c3-ms-store", "payload": "insert #1044 (c_9f2e)", "text": "The owner checks that Maya is a member, takes the next sequence number, 1044, and stores the message together with its client ID."},
{"el": "c3-store-ms", "payload": "OK", "ms": 4, "set": {"conv.last seq": "1044", "conv.recent client IDs": "…, c_9f2e"}, "text": "Stored and replicated. The owner also keeps recent client IDs in memory, so most repeats are caught without a read."},
{"el": "c3-ms-gwa", "payload": "ack c_9f2e → #1044", "ms": 1, "text": "The acknowledgement goes back to Maya's gateway. It carries both IDs: her phone's and the server's sequence number."},
{"el": "c3-gwa-maya", "payload": "✓ #1044", "set": {"ph.Maya sees": "‘on my way’ ✓"}, "text": "One tick. Her phone now knows exactly where this message sits in the conversation."},
{"el": "c3-ms-reg", "payload": "where is leo?", "text": "Now delivery. Leo is connected somewhere among 1,200 gateways. The owner asks the session registry."},
{"el": "c3-reg-ms", "payload": "leo → gateway B", "ms": 1, "text": "Gateway B. The registry is an in-memory store, partitioned by user; this is a sub-millisecond lookup."},
{"el": "c3-ms-gwb", "payload": "#1044 for leo", "ms": 1, "text": "The owner sends the message to gateway B, addressed to Leo."},
{"el": "c3-gwb-leo", "payload": "msg #1044", "ms": 1, "set": {"ph.Leo's last seq": "1044"}, "text": "Gateway B writes it down Leo's socket. Leo has it about 8ms after Maya pressed send, counting only server time."},
{"el": "c3-leo-gwb", "payload": "delivered up_to 1044", "text": "Leo's phone confirms."},
{"el": "c3-gwb-ms", "payload": "leo delivered 1044", "text": "Gateway B passes the receipt to the owner, which records Leo's delivered watermark."},
{"el": "c3-ms-gwa", "payload": "receipt: delivered 1044", "ms": 1, "text": "The owner sends the receipt to Maya through gateway A."},
{"el": "c3-gwa-maya", "payload": "✓✓", "set": {"ph.Maya sees": "‘on my way’ ✓✓"}, "text": "Two ticks. Fail gateway B and replay this flow: the message is stored and Maya gets ✓, but delivery stops at the dead gateway — until Leo reconnects elsewhere, which is the third flow."}
]
},
{
"id": "resend",
"label": "The ack is lost — Maya's phone resends",
"nodes": ["gwa3", "ms3", "store3"],
"steps": [
{"el": "c3-maya-gwa", "payload": "send c_a71b · ‘running late’", "set": {"ph.Maya sees": "‘running late’ 🕓"}, "text": "Stage 1's tunnel again. Maya sends ‘running late’, with client ID c_a71b."},
{"el": "c3-gwa-ms", "payload": "c_481 · c_a71b", "text": "Forwarded to the owner."},
{"el": "c3-ms-store", "payload": "insert #1045 (c_a71b)", "text": "Numbered 1045 and stored."},
{"el": "c3-store-ms", "payload": "OK", "ms": 4, "set": {"conv.last seq": "1045", "conv.recent client IDs": "…, c_9f2e, c_a71b"}, "text": "Stored."},
{"el": "c3-ms-gwa", "payload": "ack c_a71b → #1045", "ms": 1, "text": "The acknowledgement leaves for gateway A."},
{"el": "c3-gwa-maya", "payload": "(connection drops)", "text": "Maya's connection drops before the ack arrives. Her phone still shows the clock icon: it doesn't know whether the message was stored."},
{"el": "c3-maya-gwa", "payload": "resend c_a71b · ‘running late’", "text": "On reconnecting, her phone resends every message it has no ack for — with the same client ID, c_a71b."},
{"el": "c3-gwa-ms", "payload": "c_481 · c_a71b", "text": "The resend reaches the same owner, because the owner is chosen by conversation, not by gateway."},
{"el": "c3-ms-store", "payload": "c_a71b seen?", "text": "The owner's memory of recent client IDs already has the answer. The unique index on (conversation, device, client ID) in the store backs it up — after an owner restart, for example."},
{"el": "c3-store-ms", "payload": "yes — #1045", "ms": 1, "text": "c_a71b is message 1045. No 1046 is created."},
{"el": "c3-ms-gwa", "payload": "ack c_a71b → #1045", "ms": 1, "text": "The owner sends the original acknowledgement again."},
{"el": "c3-gwa-maya", "payload": "✓ #1045", "set": {"ph.Maya sees": "‘running late’ ✓"}, "text": "Maya's clock icon turns into a tick, and Leo sees the message once. Retrying is safe, so the phone can retry as often as it likes."}
]
},
{
"id": "crash",
"label": "Gateway B crashes — Leo reconnects",
"nodes": ["gwa3", "ms3", "store3", "reg3"],
"steps": [
{"el": "c3-maya-gwa", "payload": "send ‘are you there?’", "set": {"ph.Maya sees": "—"}, "text": "Gateway B has just crashed, taking 250,000 connections with it, Leo's among them. Maya sends another message."},
{"el": "c3-gwa-ms", "payload": "c_481 · c_51d0", "text": "To the owner."},
{"el": "c3-ms-store", "payload": "insert #1046", "text": "Numbered and stored."},
{"el": "c3-store-ms", "payload": "OK", "ms": 4, "set": {"conv.last seq": "1046"}, "text": "Stored."},
{"el": "c3-ms-gwa", "payload": "ack #1046", "ms": 1, "text": "Acknowledged to gateway A."},
{"el": "c3-gwa-maya", "payload": "✓ #1046", "set": {"ph.Maya sees": "‘are you there?’ ✓"}, "text": "Maya has one tick."},
{"el": "c3-ms-reg", "payload": "where is leo?", "text": "The owner looks Leo up."},
{"el": "c3-reg-ms", "payload": "gateway B (stale)", "ms": 1, "text": "The registry still says gateway B: its entries expire 90 seconds after their last refresh. The owner sends the message there, gets no answer, and moves on. It doesn't retry or hold the message — it's already stored, which is all the guarantee needs."},
{"el": "c3-leo-gwc", "payload": "connect · c_481 at 1045", "text": "Leo's phone noticed the dead socket when its heartbeat went unanswered. It waits a random 0–5 seconds — 250,000 phones are doing the same, and spreading them out keeps the reconnections from arriving in one burst — then connects through the load balancer, landing on gateway C."},
{"el": "c3-gwc-reg", "payload": "leo → gateway C", "set": {"reg.leo": "gateway C"}, "text": "Gateway C registers Leo, overwriting the stale entry."},
{"el": "c3-gwc-ms", "payload": "sync c_481 after 1045", "text": "Then it asks c_481's owner for everything after the position Leo's phone reported."},
{"el": "c3-ms-store", "payload": "c_481 after 1045", "text": "The owner reads from the store."},
{"el": "c3-store-ms", "payload": "#1046", "ms": 3, "text": "One message."},
{"el": "c3-ms-gwc", "payload": "#1046", "ms": 1, "text": "Sent to gateway C."},
{"el": "c3-gwc-leo", "payload": "msg #1046", "set": {"ph.Leo's last seq": "1046"}, "text": "Leo has it, a few seconds late. But this was one conversation. Leo is in 300, and his phone had to ask about each one — 300 catch-up reads, for every one of 250,000 phones reconnecting at once: 75 million reads to learn that most conversations had nothing new. The next stage gives each user one place to look."}
]
}
]
}
</script>
<div class="diagram-caption">Gateways only hold connections. Each conversation's owner in the message service assigns sequence numbers, rejects resends, and finds recipients through the session registry. A recipient whose gateway dies reconnects anywhere and catches up from the store.</div>
</div>

<div class="fail-hint">Click either named gateway, the message service, the message store or the session registry to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="gwa3">
<strong>If gateway A fails:</strong> Maya, and the 250,000 others connected to it, lose their connections. Their unacknowledged messages stay on their phones and are resent after reconnecting; resends are harmless. Nobody else notices. Gateways are interchangeable, so any gateway can take any phone.
</div>
<div class="failure-impact is-hidden" data-component="gwb3">
<strong>If gateway B fails:</strong> messages for Leo are stored and acknowledged to their senders as usual, but the live push has nowhere to go. Replay the first flow with it failed to see delivery stop. Nothing is lost: Leo's phone reconnects to another gateway and catches up from its last position, as the third flow shows.
</div>
<div class="failure-impact is-hidden" data-component="ms3">
<strong>If a message service instance fails:</strong> the conversations it owns can't accept messages until a new owner takes over, usually within seconds. Ownership is a lease held in a coordination service; when it expires, another instance takes it, reads each conversation's highest stored sequence number, and continues from there ([Distributed Locking & Leader Election](#/systems/distributed-locking)). Phones hold their unsent messages and resend them. The Deep Dives tab covers how a slow old owner is stopped from writing after it has been replaced.
</div>
<div class="failure-impact is-hidden" data-component="store3">
<strong>If the message store fails:</strong> no message can be acknowledged, so sends wait on phones. The store is replicated across zones, and a write is acknowledged once a majority of replicas have it ([Replication](#/systems/replication)), so losing one replica or one zone doesn't stop writes.
</div>
<div class="failure-impact is-hidden" data-component="reg3">
<strong>If the session registry fails:</strong> owners can't find recipients, so live delivery stops; messages are still stored and acknowledged. Recipients receive them when they next sync. The registry can be rebuilt without any backup: each gateway knows exactly which users it holds and re-registers them all when the registry returns.
</div>
</div>

The system now spans many servers, keeps one order per conversation, and turns resends into no-ops. Two things still don't scale: a reconnecting device has to ask about every conversation separately, and a group message is delivered recipient by recipient inside the owner, while the sender waits on nothing but everyone else in that conversation waits behind it.

<!-- stage:4:4. Groups & Multi-Device Sync -->

## Stage 4 — Groups, Multiple Devices and Offline Push

Two changes, and one addition.

- **A per-user sync log.** Each user gets one ordered log of everything their devices need: new messages, edits, read receipts from their other devices. Each entry has the next number in that user's own sequence (`user_seq`). Each device remembers the last `user_seq` it has, so reconnecting is one question — "everything after 88,412" — however many conversations the user is in.
- **Fan-out moves out of the owner.** The owner stores the message once, acknowledges it, and hands it to a **fan-out queue**. **Fan-out workers** append it to each member's sync log, push it to members' connected devices, and send a push notification to devices that aren't connected ([Message Queues & Event-Driven Architecture](#/systems/message-queues)).
- **Offline devices get a push notification**, through the [Notification System](#/systems-case-studies/notification-system). It only says there is something to read. The message itself arrives by sync when the app opens.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 800 380" width="800" height="380" role="img" aria-label="Maya's gateway sends to the message service, which stores once and queues a fan-out job; fan-out workers append to per-user sync logs, look up sessions, deliver to members' gateways and send push notifications; Leo's laptop syncs from its sync log through a gateway">
  <rect x="10" y="40" width="120" height="44" rx="6" class="d-actor-box" data-role="routing"></rect>
  <text x="70" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Maya's Gateway</text>
  <rect x="165" y="40" width="140" height="44" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="235" y="60" text-anchor="middle" class="d-actor-label" font-size="12">Message Service</text>
  <text x="235" y="75" text-anchor="middle" class="d-label-muted" font-size="9">seq · store once · ack</text>
  <g data-fail-toggle="fq4">
    <rect x="340" y="40" width="120" height="44" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="400" y="60" text-anchor="middle" class="d-actor-label" font-size="12">Fan-out Queue</text>
    <text x="400" y="75" text-anchor="middle" class="d-label-muted" font-size="9">partitioned by conversation</text>
  </g>
  <g data-fail-toggle="fw4">
    <rect x="495" y="40" width="130" height="44" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="560" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Fan-out Workers</text>
  </g>
  <rect x="660" y="40" width="130" height="44" rx="6" class="d-actor-box" data-role="cache"></rect>
  <text x="725" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Session Registry</text>
  <rect x="165" y="160" width="140" height="48" rx="6" class="d-actor-box" data-role="datastore"></rect>
  <text x="235" y="180" text-anchor="middle" class="d-actor-label" font-size="12">Message Store</text>
  <text x="235" y="196" text-anchor="middle" class="d-label-muted" font-size="9">history · once per message</text>
  <g data-fail-toggle="sync4">
    <rect x="340" y="160" width="150" height="48" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="415" y="180" text-anchor="middle" class="d-actor-label" font-size="12">Per-user Sync Log</text>
    <text x="415" y="196" text-anchor="middle" class="d-label-muted" font-size="9">user_seq · device positions</text>
  </g>
  <rect x="165" y="290" width="140" height="48" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="235" y="319" text-anchor="middle" class="d-actor-label" font-size="12">Leo's Laptop</text>
  <rect x="495" y="290" width="130" height="48" rx="6" class="d-actor-box" data-role="routing"></rect>
  <text x="560" y="310" text-anchor="middle" class="d-actor-label" font-size="12">Gateways</text>
  <text x="560" y="326" text-anchor="middle" class="d-label-muted" font-size="9">members' sockets</text>
  <g data-fail-toggle="push4">
    <rect x="660" y="290" width="130" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="725" y="310" text-anchor="middle" class="d-actor-label" font-size="12">Notification System</text>
    <text x="725" y="326" text-anchor="middle" class="d-label-muted" font-size="9">push to offline devices</text>
  </g>
  <line id="c4-gw-ms" x1="132" y1="56" x2="161" y2="56" class="d-msg d-request" marker-end="url(#arrowC4)"></line>
  <line id="c4-ms-gw" x1="161" y1="72" x2="132" y2="72" class="d-msg d-response" marker-end="url(#arrowC4r)"></line>
  <line id="c4-ms-store" x1="225" y1="86" x2="225" y2="156" class="d-msg d-request" marker-end="url(#arrowC4)"></line>
  <line id="c4-store-ms" x1="245" y1="156" x2="245" y2="86" class="d-msg d-response" marker-end="url(#arrowC4r)"></line>
  <line id="c4-ms-fq" x1="307" y1="62" x2="336" y2="62" class="d-msg d-request" data-depends-on="fq4" marker-end="url(#arrowC4)"></line>
  <line id="c4-fq-fw" x1="462" y1="62" x2="491" y2="62" class="d-msg d-request" data-depends-on="fq4 fw4" marker-end="url(#arrowC4)"></line>
  <line id="c4-fw-sync" x1="530" y1="86" x2="474" y2="156" class="d-msg d-request" data-depends-on="fw4 sync4" marker-end="url(#arrowC4)"></line>
  <line id="c4-fw-reg" x1="627" y1="56" x2="656" y2="56" class="d-msg d-request" data-depends-on="fw4" marker-end="url(#arrowC4)"></line>
  <line id="c4-reg-fw" x1="656" y1="72" x2="627" y2="72" class="d-msg d-response" data-depends-on="fw4" marker-end="url(#arrowC4r)"></line>
  <line id="c4-fw-gws" x1="560" y1="86" x2="560" y2="286" class="d-msg d-request" data-depends-on="fw4" marker-end="url(#arrowC4)"></line>
  <line id="c4-fw-notif" x1="610" y1="86" x2="705" y2="286" class="d-msg d-request" data-depends-on="fw4 push4" marker-end="url(#arrowC4)"></line>
  <line id="c4-lap-gws" x1="307" y1="306" x2="491" y2="306" class="d-msg d-request" marker-end="url(#arrowC4)"></line>
  <line id="c4-gws-lap" x1="491" y1="322" x2="307" y2="322" class="d-msg d-response" marker-end="url(#arrowC4r)"></line>
  <line id="c4-gws-sync" x1="515" y1="286" x2="455" y2="212" class="d-msg d-request" data-depends-on="sync4" marker-end="url(#arrowC4)"></line>
  <line id="c4-sync-gws" x1="437" y1="212" x2="497" y2="286" class="d-msg d-response" data-depends-on="sync4" marker-end="url(#arrowC4r)"></line>
  <text x="400" y="370" text-anchor="middle" class="d-label-muted" font-size="10">play the group message, then Leo's laptop waking up, then the 900-member group</text>
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
{"id": "grp", "title": "The message", "rows": [["stored", "—"], ["sync log entries", "—"]]},
{"id": "dlv", "title": "Devices", "rows": [["pushed live", "—"], ["sent a notification", "—"]]},
{"id": "lap", "title": "Leo's laptop", "rows": [["synced up to", "88,412"], ["conversations with news", "—"]]}
],
"flows": [
{
"id": "group",
"label": "Maya posts in a 12-person group",
"nodes": ["fq4", "fw4", "sync4", "push4"],
"steps": [
{"el": "c4-gw-ms", "payload": "send ‘Flights booked!’ → trip", "text": "Maya posts in ‘Trip’, a group of 12 people with 19 devices between them."},
{"el": "c4-ms-store", "payload": "insert trip #88", "text": "The group's owner numbers it 88 and stores it once, in the group's history."},
{"el": "c4-store-ms", "payload": "OK", "ms": 4, "set": {"grp.stored": "once, as trip #88"}, "text": "Stored."},
{"el": "c4-ms-gw", "payload": "ack #88", "ms": 1, "text": "Maya gets her tick now. She doesn't wait for 18 devices to receive it, and in a 900-member group she doesn't wait for 900."},
{"el": "c4-ms-fq", "payload": "fan out trip #88", "ms": 1, "text": "The owner puts a fan-out job on the queue. The queue is partitioned by conversation, so the group's messages are fanned out in the order they were numbered."},
{"el": "c4-fq-fw", "payload": "trip #88", "text": "A fan-out worker takes the job and loads the group's member list."},
{"el": "c4-fw-sync", "payload": "append to 12 sync logs", "ms": 5, "set": {"grp.sync log entries": "12 (one per member)"}, "text": "It appends an entry to each member's sync log, including Maya's own — her laptop needs to show the message she sent from her phone. Each entry gets the next number in that member's log. These writes are spread across many partitions and done in parallel."},
{"el": "c4-fw-reg", "payload": "sessions: 12 users", "text": "Then it asks the session registry where the members' devices are connected."},
{"el": "c4-reg-fw", "payload": "14 connected · 4 not", "ms": 1, "text": "Fourteen devices are connected. Four aren't. Maya's phone, the sender, is skipped."},
{"el": "c4-fw-gws", "payload": "trip #88 → 14 sockets", "ms": 2, "set": {"dlv.pushed live": "14 devices"}, "text": "The worker sends the message to those devices' gateways, grouped by gateway: one call per gateway, carrying every message for the devices it holds."},
{"el": "c4-fw-notif", "payload": "4 offline devices", "set": {"dlv.sent a notification": "4 devices"}, "text": "The four disconnected devices get a push notification through the notification system, with a collapse key per conversation so thirty messages in the group show as one notification rather than thirty. The notification is a nudge. When the app opens, it syncs and gets the real messages — the notification can be lost without losing anything."}
]
},
{
"id": "laptop",
"label": "Leo's laptop wakes up after a weekend",
"nodes": ["sync4"],
"steps": [
{"el": "c4-lap-gws", "payload": "connect · sync after 88,412", "set": {"lap.synced up to": "88,412", "lap.conversations with news": "—"}, "text": "Leo opens his laptop on Monday. It was last connected on Friday, when it had reached position 88,412 in Leo's sync log. That one number is everything it needs to say."},
{"el": "c4-gws-sync", "payload": "leo after 88,412", "text": "The gateway reads Leo's sync log from that position."},
{"el": "c4-sync-gws", "payload": "212 entries · 14 conversations", "ms": 6, "text": "212 entries — messages, edits, and the read receipts from his phone — across 14 conversations. One range read of one partition. It costs the same whether Leo is in 30 conversations or 3,000; in Stage 3 the laptop would have asked about each of them."},
{"el": "c4-gws-lap", "payload": "212 entries", "set": {"lap.synced up to": "88,624", "lap.conversations with news": "14"}, "text": "The laptop applies them in order. Because his phone's read receipts are in the log too, conversations Leo already read on his phone show as read on his laptop."},
{"el": "c4-lap-gws", "payload": "ack up to 88,624", "text": "The laptop confirms its new position."},
{"el": "c4-gws-sync", "payload": "laptop → 88,624", "ms": 2, "text": "The gateway records it. Once every one of Leo's devices is past an entry, the entry can be deleted: the sync log is a delivery queue, not the history. A device that stays away longer than 30 days — or a brand-new one — loads recent history over HTTP instead."}
]
},
{
"id": "big",
"label": "A 900-member group",
"nodes": ["fq4", "fw4", "sync4", "push4"],
"steps": [
{"el": "c4-gw-ms", "payload": "send → neighbourhood", "set": {"grp.stored": "—", "grp.sync log entries": "—", "dlv.pushed live": "—", "dlv.sent a notification": "—"}, "text": "Maya posts in her neighbourhood group: 900 members."},
{"el": "c4-ms-store", "payload": "insert #5,120", "text": "Stored once, as before."},
{"el": "c4-store-ms", "payload": "OK", "ms": 4, "set": {"grp.stored": "once, as #5,120"}, "text": "Stored."},
{"el": "c4-ms-gw", "payload": "ack #5,120", "ms": 1, "text": "Maya's tick is just as fast as in a two-person chat."},
{"el": "c4-ms-fq", "payload": "fan out #5,120", "ms": 1, "text": "Queued for fan-out."},
{"el": "c4-fq-fw", "payload": "#5,120", "text": "A worker takes it. Big fan-outs are split into chunks of 100 members that several workers process in parallel."},
{"el": "c4-fw-sync", "payload": "append to 900 sync logs", "ms": 40, "set": {"grp.sync log entries": "900"}, "text": "900 appends. One message became 900 writes. If the group is lively — 10 messages a minute — that's 9,000 writes a minute from one group. Fine at 900 members; at 100,000 it isn't. That is why groups are capped at 1,000. Larger audiences become broadcast channels that members read from directly, like a feed, instead of having a copy written for each of them."},
{"el": "c4-fw-reg", "payload": "sessions: 900 users", "text": "Session lookups, batched."},
{"el": "c4-reg-fw", "payload": "310 connected", "ms": 3, "text": "About a third have a device connected."},
{"el": "c4-fw-gws", "payload": "#5,120 → 310 sockets", "ms": 6, "set": {"dlv.pushed live": "310 devices"}, "text": "Pushed to their gateways."},
{"el": "c4-fw-notif", "payload": "~1,000 offline devices", "set": {"dlv.sent a notification": "only if not muted"}, "text": "Most members of large groups mute them, so the fan-out worker checks each member's mute setting before asking for a notification. Unmuted, offline devices get one notification per conversation, collapsed, at the notification system's normal priority — never its critical lane, which is kept for login codes."}
]
}
]
}
</script>
<div class="diagram-caption">The message is stored once and acknowledged at once. Fan-out workers then write a copy into every member's sync log, push it to connected devices, and ask the notification system to wake the rest. Any device catches up with one read of its user's sync log.</div>
</div>

<div class="fail-hint">Click the fan-out queue, the fan-out workers, the sync log or the notification system to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="fq4">
<strong>If the fan-out queue fails:</strong> messages are still stored and acknowledged, but nobody receives them. Senders see ✓ and never ✓✓. To keep a message from being stored but never queued, the owner writes the message and its fan-out job in the same database write, and a relay moves jobs to the queue — the outbox pattern. When the queue returns, the relay catches up and nothing is lost.
</div>
<div class="failure-impact is-hidden" data-component="fw4">
<strong>If the fan-out workers fail:</strong> jobs wait in the queue; delivery is late for everyone, but in order. A worker that crashes halfway through a group is redone from the start by the next worker. Appending the same message twice to a sync log is harmless because the entry is keyed by conversation and sequence number, and devices ignore a message they already have.
</div>
<div class="failure-impact is-hidden" data-component="sync4">
<strong>If the sync log fails:</strong> workers can't record deliveries, so they don't acknowledge the job and it stays in the queue. They can still push live to connected devices, so online users keep chatting. Reconnecting devices can't catch up from the log; they fall back to reading their recent conversations' history directly, which is slower but correct.
</div>
<div class="failure-impact is-hidden" data-component="push4">
<strong>If the notification system fails:</strong> offline users aren't woken up. Their messages are safe in their sync logs and arrive the moment they open the app. This is the gentlest failure in the system, which is why the notification only says "something is waiting" and never carries the only copy of anything.
</div>
</div>

Messages now reach every device of every member, whether it is online or not, and catching up costs one read. What's missing is everything that tells people what the other side is doing: whether they're online, typing, or have read the message.

<!-- stage:5:5. Presence, Typing & Receipts -->

## Stage 5 — Presence, Typing and Read Receipts

These three look similar on screen and need very different handling.

- **Presence** ("online", "last seen 21:04") changes constantly and matters to few people at a time. It lives in an in-memory **presence service** with expiring entries, fed by gateways, and is sent only to people who are looking: a device **watches** a user while a conversation with them is open, and stops when it closes.
- **Typing** is the most frequent and least important signal. It goes through the same presence service, is never stored and never retried, and disappears from the screen after a few seconds by itself.
- **Read receipts** are part of the conversation's record. They go through the conversation's owner, are stored as a watermark per member, and reach the sender's devices and the reader's own other devices.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 800 330" width="800" height="330" role="img" aria-label="Leo's phone on gateway B and Maya's phone on gateway A; both gateways talk to an in-memory presence service for presence and typing, and to the message service for read receipts">
  <rect x="10" y="140" width="110" height="44" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="65" y="166" text-anchor="middle" class="d-actor-label" font-size="12">Leo's Phone</text>
  <rect x="160" y="140" width="120" height="44" rx="6" class="d-actor-box" data-role="routing"></rect>
  <text x="220" y="166" text-anchor="middle" class="d-actor-label" font-size="12">Gateway B</text>
  <g data-fail-toggle="pres5">
    <rect x="330" y="30" width="160" height="60" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="410" y="52" text-anchor="middle" class="d-actor-label" font-size="12">Presence Service</text>
    <text x="410" y="68" text-anchor="middle" class="d-label-muted" font-size="9">presence · watchers · typing</text>
    <text x="410" y="81" text-anchor="middle" class="d-label-muted" font-size="9">in memory · entries expire</text>
  </g>
  <g data-fail-toggle="ms5">
    <rect x="330" y="236" width="160" height="56" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="410" y="259" text-anchor="middle" class="d-actor-label" font-size="12">Message Service</text>
    <text x="410" y="275" text-anchor="middle" class="d-label-muted" font-size="9">read watermarks per member</text>
  </g>
  <rect x="540" y="140" width="116" height="44" rx="6" class="d-actor-box" data-role="routing"></rect>
  <text x="598" y="166" text-anchor="middle" class="d-actor-label" font-size="12">Gateway A</text>
  <rect x="694" y="140" width="96" height="44" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="742" y="166" text-anchor="middle" class="d-actor-label" font-size="12">Maya's Phone</text>
  <line id="c5-leo-gwb" x1="122" y1="154" x2="156" y2="154" class="d-msg d-request" marker-end="url(#arrowC5)"></line>
  <line id="c5-gwb-leo" x1="156" y1="170" x2="122" y2="170" class="d-msg d-response" marker-end="url(#arrowC5r)"></line>
  <line id="c5-gwb-pres" x1="250" y1="138" x2="350" y2="94" class="d-msg d-request" data-depends-on="pres5" marker-end="url(#arrowC5)"></line>
  <line id="c5-pres-gwb" x1="366" y1="94" x2="266" y2="138" class="d-msg d-response" data-depends-on="pres5" marker-end="url(#arrowC5r)"></line>
  <line id="c5-gwa-pres" x1="560" y1="138" x2="470" y2="94" class="d-msg d-request" data-depends-on="pres5" marker-end="url(#arrowC5)"></line>
  <line id="c5-pres-gwa" x1="454" y1="94" x2="544" y2="138" class="d-msg d-response" data-depends-on="pres5" marker-end="url(#arrowC5r)"></line>
  <line id="c5-gwb-ms" x1="250" y1="186" x2="350" y2="232" class="d-msg d-request" data-depends-on="ms5" marker-end="url(#arrowC5)"></line>
  <line id="c5-ms-gwa" x1="470" y1="232" x2="560" y2="186" class="d-msg d-request" data-depends-on="ms5" marker-end="url(#arrowC5)"></line>
  <line id="c5-gwa-maya" x1="658" y1="154" x2="690" y2="154" class="d-msg d-request" marker-end="url(#arrowC5)"></line>
  <line id="c5-maya-gwa" x1="690" y1="170" x2="658" y2="170" class="d-msg d-response" marker-end="url(#arrowC5r)"></line>
  <text x="400" y="320" text-anchor="middle" class="d-label-muted" font-size="10">play presence, then typing, then the read receipt; fail the presence service and replay all three</text>
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
{"id": "pres", "title": "Presence service", "rows": [["maya", "online"], ["watching maya", "nobody"]]},
{"id": "leo", "title": "Leo's screen", "rows": [["under Maya's name", "—"]]},
{"id": "maya", "title": "Maya's screen", "rows": [["under Leo's name", "—"], ["‘are you there?’", "✓✓ delivered"]]}
],
"flows": [
{
"id": "presence",
"label": "Leo opens the chat — is Maya online?",
"nodes": ["pres5"],
"steps": [
{"el": "c5-leo-gwb", "payload": "open chat with maya", "text": "Leo opens his conversation with Maya. Until now his phone hasn't been told anything about Maya's presence, even though she is in his contacts."},
{"el": "c5-gwb-pres", "payload": "watch maya", "text": "Gateway B tells the presence service that one of its connections is watching Maya."},
{"el": "c5-pres-gwb", "payload": "maya: online", "ms": 1, "set": {"pres.watching maya": "gateway B (for leo)"}, "text": "The presence service records the watcher and answers with Maya's current status."},
{"el": "c5-gwb-leo", "payload": "Maya · online", "set": {"leo.under Maya's name": "online"}, "text": "Leo sees ‘online’. Only people with a chat with Maya open are told about her. Sending every change to all her contacts would be the trillion-updates-a-day design from Scale Estimates; watching only open chats cuts it by orders of magnitude."},
{"el": "c5-gwa-pres", "payload": "heartbeats (batch)", "text": "Maya's phone sends gateway A a heartbeat every 30 seconds. Gateway A batches the heartbeats of all its connections and refreshes their presence entries, which expire after 60 seconds. 6.7 million heartbeats a second never reach a database."},
{"el": "c5-gwa-pres", "payload": "maya disconnected", "set": {"pres.maya": "last seen 21:04"}, "text": "Maya locks her phone and the app closes its connection. Gateway A reports it at once. The presence service waits a few seconds before announcing it — phones disconnect and reconnect constantly as they switch networks, and ‘online, offline, online’ flicker helps nobody. If her phone had just lost signal without closing cleanly, her entry would expire after 60 seconds instead."},
{"el": "c5-pres-gwb", "payload": "maya: last seen 21:04", "ms": 1, "text": "The presence service tells only the gateways watching Maya."},
{"el": "c5-gwb-leo", "payload": "last seen 21:04", "set": {"leo.under Maya's name": "last seen 21:04"}, "text": "Leo's screen updates. When he closes the chat, his phone stops watching and the presence service forgets him."}
]
},
{
"id": "typing",
"label": "Leo is typing",
"nodes": ["pres5"],
"steps": [
{"el": "c5-leo-gwb", "payload": "typing · c_481", "set": {"maya.under Leo's name": "—"}, "text": "Leo starts typing a reply. His phone sends a typing signal — at most once every 3 seconds while he keeps typing, not once per key."},
{"el": "c5-gwb-pres", "payload": "leo typing in c_481", "text": "Gateway B passes it to the presence service, which knows which gateways have this conversation open."},
{"el": "c5-pres-gwa", "payload": "leo typing", "ms": 1, "text": "Maya has the chat open on her phone, so the signal goes to gateway A. Nobody else's device hears about it."},
{"el": "c5-gwa-maya", "payload": "Leo is typing…", "set": {"maya.under Leo's name": "typing…"}, "text": "‘typing…’ appears under Leo's name. Maya's phone removes it after 5 seconds unless another signal arrives. Nothing here is stored, acknowledged or retried. If a typing signal is lost, nobody can tell. It is the most frequent signal in the system, so it gets the least machinery."}
]
},
{
"id": "read",
"label": "Leo reads the messages",
"nodes": ["ms5"],
"steps": [
{"el": "c5-leo-gwb", "payload": "read c_481 up_to 1046", "set": {"maya.‘are you there?’": "✓✓ delivered"}, "text": "Leo scrolls to the bottom of the chat. His phone reports that everything up to message 1046 has been read: one watermark, not one receipt per message."},
{"el": "c5-gwb-ms", "payload": "leo read 1046", "text": "Unlike typing, this matters later, so it goes to c_481's owner in the message service."},
{"el": "c5-ms-gwa", "payload": "receipt: leo read 1046", "ms": 3, "set": {"maya.‘are you there?’": "✓✓ read"}, "text": "The owner stores 1046 as Leo's read watermark — a single number per member — and puts a read event in Maya's sync log and Leo's. Maya's devices learn that Leo read it. Leo's laptop learns it too, and clears the unread badge for this chat."},
{"el": "c5-gwa-maya", "payload": "✓✓ read", "text": "Maya sees the ticks turn to ‘read’. In groups, receipts aren't pushed to the sender one member at a time — in a 900-member group that would be 900 events per message. The sender's app shows a count, and fetches who read it only when asked. A user who has turned read receipts off still has a read watermark — their own devices need it — but it isn't shared with anyone else."}
]
}
]
}
</script>
<div class="diagram-caption">Presence and typing go through an in-memory service that only sends updates to devices that are watching. Read receipts go through the conversation's owner, because they are part of the conversation's record and must reach every device of both people.</div>
</div>

<div class="fail-hint">Click the presence service or the message service to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="pres5">
<strong>If the presence service fails:</strong> nobody's status is shown and typing indicators stop. Messages and receipts are unaffected — replay the read receipt with it failed. The app shows no status rather than a wrong one: ‘online’ shown for someone who has left is worse than showing nothing. Nothing in it needs restoring. When it comes back, gateways report their connections and watchers again within one heartbeat interval.
</div>
<div class="failure-impact is-hidden" data-component="ms5">
<strong>If the message service fails:</strong> receipts wait along with messages for the conversation's new owner. Presence and typing continue, since they don't touch the message service — which is why they were kept apart. Phones keep their read watermark and resend it, and because a watermark only moves forward, a resend changes nothing if it already arrived.
</div>
</div>

This is the full design. Phones hold one connection to one of a large pool of gateways that do nothing but hold connections. Each conversation has one owner, which numbers messages, rejects resends by their client IDs, stores each message once and acknowledges it. Fan-out workers copy each message into every member's sync log, push it to connected devices through the session registry, and ask the notification system to wake the rest. A device that reconnects reads its user's sync log from where it left off. Presence and typing ride on a separate in-memory service that only talks to devices that are looking. The message store and sync logs are the record; everything else — connections, sessions, presence — can be lost and rebuilt.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### Ordering: what "same order" really promises

The promise is that every device shows a conversation's messages in the same order — the order the owner assigned. It is not that this order matches the order people pressed send. If Maya and Leo send at the same moment, whichever message reaches the owner first gets the lower number, and both phones show that order, even if Maya pressed send a few milliseconds earlier.

While a message is unacknowledged, the sender's phone shows it at the bottom, marked as pending. When the ack arrives with its sequence number, the phone moves it to its real place. Usually that's where it already was. When someone else's message got in first, the pending message moves down one line.

Gaps are how a device detects a lost message. Sequence numbers in a conversation have no gaps, so a device that holds 1045 and receives 1047 knows 1046 exists and asks for it, instead of waiting for the next sync.

Ordering is only promised within a conversation. Two different conversations have different owners and no shared order, which no user notices.

### When an owner is replaced

An owner is the only process allowed to number a conversation's messages. If it pauses for a long garbage collection, its lease can expire and another instance can take over. When the old one wakes up, it still believes it is the owner and may try to write message 1047 — which the new owner has already written.

Two things prevent damage. Each lease comes with a **fencing token**, a number that increases every time ownership changes hands, and the store rejects writes carrying an older token than it has seen for that conversation. And messages are written with a conditional insert — "only if (conversation, seq) doesn't exist" — so two writers can never both store a 1047 ([Distributed Locking & Leader Election](#/systems/distributed-locking)).

### Keeping connections alive

- **Heartbeats** set how quickly a dead connection is noticed. Every 30 seconds means up to about a minute before a phone that lost signal is treated as offline. Shorter intervals notice faster and drain phone batteries, because each heartbeat wakes the phone's radio.
- **Reconnecting** uses a random delay that grows with each failure — around 1 second, then 2, 4, up to a minute. Without the randomness, every phone dropped by a failed gateway comes back in the same second.
- **Deploying gateways** without a reconnect storm: a gateway being replaced stops accepting new connections and closes its existing ones gradually over about ten minutes, with a close code that tells clients to reconnect after a random delay. A full gateway fleet rollout takes hours, by design.
- **Load balancing** is done at the TCP level, not per request: once a connection is placed on a gateway, it stays there. New gateways only receive new connections, so a freshly added gateway fills up slowly, as phones reconnect for their own reasons.

### Media messages

The client uploads the photo to object storage through a short-lived signed URL, then sends an ordinary message containing the media ID, its size, a tiny blurred preview, and — with end-to-end encryption — the key to decrypt it. Recipients download the file from a CDN only when they view it. Uploads are resumable, because a 50MB video over a mobile connection often fails partway. Without end-to-end encryption, identical files forwarded many times are stored once, by content hash; with it, each upload is a different ciphertext, and that saving is lost.

### Large groups

Every member of a group gets a copy of each message in their sync log, so a group's cost grows with its size multiplied by its activity. Up to 1,000 members, that's affordable and keeps reading cheap: every member's device reads one log. Past that, the trade-off flips, exactly as it does for accounts with millions of followers in a feed: write once, and let members read the channel directly when they open it ([Social Media News Feed](#/systems-case-studies/news-feed)). Such channels also drop per-member delivery receipts and typing indicators, which make no sense at that size.

### Users in different regions

Users connect to gateways in the nearest region. Each conversation is owned in one region — usually the region of the user who created it — and messages from members elsewhere are forwarded to it, adding the round-trip between regions, typically 50–150ms. Fan-out happens in the owner's region and delivers to remote gateways across regions. If a region fails, its conversations' ownership moves to another region from the replicated store; messages that were acknowledged but not yet replicated to the new region are the risk, which is why message writes are replicated to a second region before the ack for conversations whose members span regions ([Multi-Region & Disaster Recovery](#/systems/multi-region-dr)).

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### Gateways hold state that's expensive to move

A stateless web server can be restarted at any moment. A gateway can't: every restart disconnects hundreds of thousands of people, who all reconnect and resync. Deploys are slow and gradual, scaling down means waiting for connections to drain, and a fleet that's unevenly loaded stays that way until phones reconnect for their own reasons. The design accepts this because the alternative, polling, costs a hundred times more work.

### One owner per conversation limits one conversation's speed

Every message in a conversation goes through one process, which can number a few thousand messages a second. No conversation between people gets close to that. A chat that did — a huge live event — would need its messages numbered approximately, or not at all, and would no longer promise one exact order.

### Fan-out multiplies writes

Each message is stored once but written to every member's sync log. That is about 4 writes per message on average, and up to 1,000 for a big group. It keeps reconnection cheap, which happens far more often than sending. The group size cap is what keeps the multiplier bounded.

### History only grows

At 5TB a day, history is never small and never shrinks. Recent months stay on fast storage. Older messages move to cheaper storage that is slower to read, which is acceptable because few people scroll back years. With end-to-end encryption, history often isn't kept on the server at all after delivery, and the phone holds it instead — saving storage, and moving the problem of backups to the user.

### Presence is approximate by design

Watching only open chats, debouncing disconnects, and expiring entries after 60 seconds all trade accuracy for traffic. "Online" can be up to a minute out of date. Showing it precisely to every contact would cost more than all the messages in the system.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

A chat system holds people's private conversations, lets strangers send messages to one another, and keeps a live connection to every device. Each of those is an attack surface ([Security & Authentication](#/systems/security-authentication)).

### Authenticating a connection that stays open for days

The access token is checked when the connection opens. Tokens are short-lived, so the gateway closes a connection with code `4001` when its token expires, and the client reconnects with a fresh one. When someone logs out of all devices, or an account is locked, the session registry lists every connection the user has, and their gateways close them at once — an open socket must not outlive the permission that opened it.

### Membership is checked by the server on every send

The client says which conversation a message is for; the conversation's owner checks that the sender is a member before numbering it. A removed member's devices stop receiving messages from the moment of removal, and a new member sees history only from their `joined_seq` onward. History requests over HTTP check the same things.

### Browsers and WebSockets

A browser will open a WebSocket to any site, sending that site's cookies, from a page on any other site. If the connection were authenticated by cookie alone, a malicious page could open a chat connection as its visitor and read their messages. Gateways check the `Origin` header for browser connections and require a token, not just a cookie.

### Spam and unwanted contact

Rate limits apply per user, per device and per IP, and are much tighter for new accounts and for messages to people who aren't contacts ([Rate Limiting & Backpressure](#/systems/rate-limiting)). Messages from strangers go to a separate request folder. Forwarding a message many times marks it as forwarded and limits how many chats it can be forwarded to at once, which slows down chain messages. Reporting a conversation sends the reported messages to the moderation team with the reporter's consent.

### End-to-end encryption

With end-to-end encryption, each device has its own keys, and the sender's phone encrypts every message separately for each recipient device. The server stores and forwards ciphertext it can't read. Most of this design is unchanged: ordering, deduplication, sync logs and receipts all work on ciphertext. Three things change. Fan-out is per device rather than per user, because each device gets its own encrypted copy. The server can't scan content for spam, so abuse detection relies on rate limits, metadata patterns and user reports. And media can't be deduplicated. Metadata — who talks to whom, and when — is still visible to the server, so keeping as little of it as possible, for as short a time as possible, matters as much as the encryption itself.

### Media links

Media is fetched with unguessable, signed URLs that expire after minutes. A URL copied out of an app and posted elsewhere stops working. Uploads are scanned for type and size before they are accepted, since a "photo" can be anything.

### Connection floods

Opening a connection costs the server a TLS handshake and an authentication check. Gateways limit new connections per IP and per account, and admit new connections at a controlled rate after an outage, so a reconnect storm — accidental or deliberate — is spread out instead of overwhelming the fleet.

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **Send to ack** time at p50 and p99: the sender's ✓.
- **Send to delivered** time for recipients who are online: the real measure of whether chat feels instant.
- **Open connections** per gateway and in total, and the **connection rate**. A sudden rise in new connections means many phones were disconnected at once.
- **Fan-out queue lag**: how long messages wait between ack and fan-out.
- **Sync** requests per second and entries returned per request. Large syncs mean devices are being disconnected for long stretches.
- **Sequence gaps** reported by clients. Should be near zero.
- **Resends rejected as duplicates** per minute. A rise means acks are being lost somewhere.
- **Presence updates** sent per second, and the share of connections that time out rather than close cleanly.

([Observability](#/systems/observability))

### What to alert on

- Send-to-ack p99 above **200ms**, or send-to-delivered p99 above **500ms**, for 5 minutes.
- New connections per second above five times the usual level: a reconnect storm is starting.
- Fan-out lag above **5 seconds**.
- Any gateway above 90% of its connection limit.
- Client-reported sequence gaps above a small baseline.
- Message owner handovers above their usual rate: owners are crashing or losing their leases.

### A zone's gateways go down — what happens?

About a third of all connections drop at once, around 60 million phones. Every acknowledged message is safe and unacknowledged ones are still on the phones, so nothing is lost; the risk is the reconnection. Phones wait a random delay before reconnecting, and the remaining gateways admit new connections at a controlled rate, so the fleet fills up over a few minutes instead of being hit in one second. Watch the connection rate fall back to normal and the sync rate spike and settle. Stale session registry entries for the dead gateways expire within 90 seconds; messages sent to them meanwhile are picked up by sync. Scale the remaining zones' gateways if they approach their connection limit — the fleet was sized for this.

### Messages arrive late, but only in groups — what happens?

One-to-one chats deliver normally, so the gateways and owners are fine. Check fan-out queue lag. If it is high, check whether one partition is behind the rest: a single very active large group can monopolize a partition's workers, delaying every other group that hashes to it. Split oversized fan-outs into more chunks, and check that the group size cap wasn't bypassed. If every partition is behind, fan-out workers are short, or the sync log is slow — check its write latency.

### Users report messages in the wrong order — what happens?

First, check what "wrong" means. If the messages were sent at nearly the same moment, the server's order is the correct one, and the report is about expectations. If the order differs between two devices, something is broken. Check for owner handovers around that time and whether any write with an old fencing token was accepted, and check that clients sort by sequence number, not by timestamp — a client release that sorts by local time produces exactly this report.
