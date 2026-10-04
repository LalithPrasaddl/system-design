# Notification System

A notification system delivers messages from a product to its users: a push to their phone, an email, a text message, an entry in an in-app inbox. Every other part of the product sends through it — payments, security, social activity, marketing. Three things make it hard. The last step of every delivery is a third-party provider that is slow, rate-limited and sometimes down. A notification must arrive once: a lost login code locks someone out, and a duplicate one costs money and trust. And a broadcast to fifty million people shares the pipeline with a login code that must arrive in seconds. This case study builds a system that keeps those promises.

<!-- tab:requirements:Requirements -->

## Requirements

This case study builds the central notification service of a large consumer product. Dozens of internal services send through it. None of them talk to a push, email or SMS provider directly.

### Functional requirements

- **Send a notification** to one user, from any internal service. The caller names an event type (`payment_received`, `login_code`, `new_follower`) and supplies the data. It does not choose channels or write the text.
- **Four channels:** mobile push, email, SMS, and an in-app inbox.
- **User preferences:** a user can turn off any category of notification on any channel, set quiet hours, and unsubscribe from email in one click. Security notifications can't be turned off.
- **Broadcasts:** send one notification type to a segment of millions of users, optionally at a fixed local time in each user's time zone.
- **Scheduled sends:** a notification can be held until a given time.
- **In-app inbox:** list recent notifications, show an unread count, mark items read.
- **Delivery tracking:** the status of every notification on every channel — queued, sent, delivered, failed — for support staff and for the sending service.

### Non-functional requirements

- **Never silently lose an accepted notification.** Once the service has accepted a request, the notification is delivered or recorded as failed with a reason.
- **No visible duplicates.** A user should receive each notification once per channel, even when callers, workers or providers retry.
- **Fast for urgent notifications.** Login codes, security alerts and payment confirmations reach the provider within **5 seconds at p99**. Marketing can take minutes.
- **Isolated priorities.** No volume of low-priority traffic may delay a high-priority notification.
- **Highly available intake.** The send API targets **99.99%**. A caller should never fail its own work because notifications are having a bad day.
- **Respect for the user.** Preferences, quiet hours and frequency limits are applied to every notification, including broadcasts.

### In scope

Accepting requests, applying preferences, rendering templates, delivering through each channel's providers, retries and deduplication, priorities and pacing, scheduled and time-zone-aware sends, delivery receipts, device-token and email-address hygiene, and the in-app inbox.

### Out of scope

**Running mail servers or a phone network.** Email, SMS and mobile push are delivered through providers; the platform push services for each phone operating system are the only route to a phone's lock screen. **Live in-app delivery** over an open connection, covered in [Real-time Delivery](#/systems/realtime-delivery). **Campaign authoring tools** and **choosing the best send time** per user, which are product and machine-learning problems built on top of this service.

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

The volume here is moderate by the standards of a large product. What shapes the design is the mix: the same pipeline carries sub-second login codes and half-hour broadcasts, and its final step is a provider with its own limits.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Send requests</div>
<div class="stat-tile-value">~40<span class="stat-tile-unit">K/sec</span></div>
<div class="stat-tile-sub">at peak</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Deliveries</div>
<div class="stat-tile-value">~2<span class="stat-tile-unit">B/day</span></div>
<div class="stat-tile-sub">across all channels</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Largest broadcast</div>
<div class="stat-tile-value">50<span class="stat-tile-unit">M</span></div>
<div class="stat-tile-sub">users in 30 minutes</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Urgent deadline</div>
<div class="stat-tile-value">5<span class="stat-tile-unit">s</span></div>
<div class="stat-tile-sub">p99, request to provider</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">SMS spend</div>
<div class="stat-tile-value">~$80<span class="stat-tile-unit">K/day</span></div>
<div class="stat-tile-sub">every duplicate is paid for</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Delivery log</div>
<div class="stat-tile-value">~800<span class="stat-tile-unit">GB/day</span></div>
<div class="stat-tile-sub">one record per delivery</div>
</div>
</div>

### Assumptions

- **300 million** registered users, **100 million** active each day, with about **1.5 devices** each.
- **1.2 billion** send requests a day from internal services. Peak traffic is about **3×** the average.
- Each notification goes to **1.6 channels** on average after preferences are applied.
- Broadcasts run several times a week. The largest goes to **50 million** users and must finish within **30 minutes**.
- Providers answer a send in **100–300ms** normally, and sometimes take seconds.

### Requests

- Send requests: 1.2 billion a day is about **14,000/sec**, peaking at **~40,000/sec**.
- A 50-million-user broadcast in 30 minutes adds **~28,000/sec** on its own — as much as the normal peak again, for half an hour.

### Deliveries by channel

| Channel | Per day | Typical cost |
|---|---|---|
| Push | ~1 billion | Free, but rate-limited per connection |
| In-app inbox | ~600 million | Internal write |
| Email | ~300 million | ~$0.0001 each |
| SMS | ~8 million | ~$0.01 each, much more in some countries |

SMS is a tiny share of volume and most of the bill: 8 million × $0.01 is **~$80,000 a day**. A bug that sends every SMS twice costs $80,000 a day, and a fraud that triggers SMS sends costs whatever the attacker likes.

### Concurrency

At peak, about 30,000 provider calls a second are in flight, each taking about 150ms. By Little's law, that is 30,000 × 0.15 = **~4,500 requests open at any moment**. If a provider slows to 3 seconds, the same traffic holds **90,000** open requests. Whatever holds those requests open must be built to wait.

### Storage

- **Delivery log:** about 400 bytes per delivery record. 2 billion a day is **~800GB/day**; 30 days kept online is **~24TB** before replication.
- **Preferences:** about 500 bytes per user, **~150GB**. Read once per notification, so about 40,000 reads a second at peak — cached in memory.
- **Device tokens:** 450 million devices × ~200 bytes = **~90GB**.
- **Inbox:** 50 items per user for 90 days, ~400 bytes each: 300M × 50 × 400B = **~6TB**.

<!-- tab:api-design:API Design -->

## API Design

### Sending (internal services)

```
POST /v1/notifications
Idempotency-Key: payments:txn_77120
{
  "user_id": "u_8812",
  "type": "payment_received",
  "data": {"amount": "₹2,500", "from_name": "Ana"},
  "send_at": null
}
→ 202 {"notification_id": "364018610995269632", "status": "accepted"}

POST /v1/broadcasts
Idempotency-Key: growth:weekly_digest:2026-10-05
{
  "type": "weekly_digest",
  "segment_id": "seg_active_90d",
  "send_at_local": "2026-10-05T09:00"
}
→ 202 {"broadcast_id": "b_5512", "estimated_recipients": 48211907}

GET /v1/notifications/364018610995269632
→ 200 {"notification_id": "…", "type": "payment_received",
       "deliveries": [
         {"channel": "push",  "status": "delivered", "device": "ios_…3f"},
         {"channel": "email", "status": "skipped",   "reason": "preference"}]}
```

### Users

```
GET  /v1/me/inbox?limit=20&before=364018610995269632
GET  /v1/me/inbox/unread_count
POST /v1/me/inbox/read            {"up_to": "364018610995269632"}

GET  /v1/me/notification-preferences
PUT  /v1/me/notification-preferences
     {"social": {"push": true, "email": false},
      "quiet_hours": {"start": "22:00", "end": "08:00", "tz": "Asia/Kolkata"}}

POST   /v1/me/devices             {"platform": "ios", "token": "…", "app_version": "8.4.1"}
DELETE /v1/me/devices/{device_id}

GET /v1/unsubscribe?t=<signed token>     one click, no sign-in
```

### Providers

```
POST /v1/webhooks/{provider}      delivery receipts, bounces, complaints
```

| Status | Meaning |
|---|---|
| `202` | Accepted. Delivery happens later; this is not a confirmation that anything was sent |
| `200` / `204` | Success, for reads and preference changes |
| `400` | Unknown type, missing template data, or a broadcast to a type not allowed in broadcasts |
| `401` / `403` | The calling service isn't authenticated, or isn't allowed to send this type |
| `404` | Unknown user, notification or segment |
| `409` | The idempotency key was reused with a different request body |
| `429` | The calling service is over its sending quota |

### Why the details matter

**The answer is 202, not 200.** The API accepts the notification and returns. It does not wait for a provider. The caller can't know whether the notification was delivered, and shouldn't wait to find out: that is how a slow email provider becomes a slow payment service.

**Callers send events, not messages.** A caller says "payment_received, for this user, with this data". The notification service decides the channels, the wording, the language and whether to send at all. If each service wrote its own text and picked its own channels, there would be no single place to apply preferences, quiet hours, frequency limits or a kill switch.

**The idempotency key is required.** Every caller retries on a timeout, and a timeout doesn't mean the first request failed. The key is scoped to the caller (`payments:` above) and kept for 24 hours. A repeated key returns the original `notification_id` and sends nothing new. A repeated key with a different body is a `409`, because it means the caller has a bug ([Idempotency & Exactly-Once Delivery](#/systems/idempotency)).

**Broadcasts name a segment, not a list.** Sending 50 million user IDs in a request body would be a 500MB request. The broadcast names a segment that the notification service expands itself, at its own pace.

**Unsubscribe works without signing in.** The link in every marketing email carries a signed token naming the user and the category. Email providers and the law in many countries require unsubscribing to take one click; a sign-in page in between doesn't count.

<!-- tab:data-model:Data Model -->

## Data Model

There are three kinds of data. **Configuration** — notification types and templates — changes rarely and is read constantly. **Per-user state** — preferences, devices, the inbox — is read on every notification. **The delivery log** is written several times per delivery and read mostly for support and debugging.

### Notification types

```
notification_types
  type              TEXT  PRIMARY KEY      -- 'login_code', 'payment_received', 'weekly_digest'
  category          TEXT                   -- security | transactional | social | marketing
  priority          TEXT                   -- critical | normal | bulk
  channels          ARRAY<TEXT>            -- channels this type may use, in order of preference
  user_can_disable  BOOLEAN                -- false for security
  ttl_seconds       INT                    -- drop if not delivered by then; 600 for a login code
  owner_service     TEXT                   -- the only service allowed to send this type

templates
  type, channel, locale                    -- PRIMARY KEY
  subject           TEXT                   -- email only
  body              TEXT                   -- 'Ana sent you {{amount}}'
  version           INT
```

The type carries every decision the caller doesn't make. Priority decides the lane (Stage 4). The TTL decides when a late notification is no longer worth sending: a login code delivered after 10 minutes is useless, and a "your driver has arrived" push delivered an hour late is worse than none.

### Preferences and devices

```
preferences                               -- key-value, cached
  user_id         BIGINT  PRIMARY KEY
  settings        JSON                    -- {category: {channel: on/off}}
  quiet_hours     JSON                    -- start, end, time zone
  email_status    TEXT                    -- ok | unsubscribed_all | bounced | complained

devices                                   -- partitioned by user_id
  user_id         BIGINT
  device_id       TEXT
  platform        TEXT                    -- ios | android | web
  push_token      TEXT
  app_version     TEXT
  last_seen_at    TIMESTAMP
  status          TEXT                    -- active | invalid
  PRIMARY KEY (user_id, device_id)
```

Preferences are read on every notification, so they are cached in memory and written through on change. Devices are partitioned by user, because the question is always "where can I reach this person?".

### The delivery log

```
notifications                             -- partitioned by hash(notification_id)
  notification_id   BIGINT  PRIMARY KEY   -- time-ordered
  user_id           BIGINT
  type              TEXT
  data              JSON
  created_at        TIMESTAMP

deliveries                                -- partitioned by hash(notification_id)
  delivery_id       TEXT  PRIMARY KEY     -- notification_id + channel + device
  notification_id   BIGINT
  channel           TEXT
  target            TEXT                  -- device token, email address, phone number
  status            TEXT                  -- pending | sending | sent | delivered | failed | skipped
  lease_owner       TEXT                  -- which worker is sending it
  lease_expires_at  TIMESTAMP
  attempts          INT
  provider_msg_id   TEXT
  last_error        TEXT

idempotency_keys                          -- key-value, 24h TTL
  caller_key        TEXT  PRIMARY KEY     -- 'payments:txn_77120'
  notification_id   BIGINT
  request_hash      TEXT
```

One notification produces several deliveries, one per channel and device, and each has its own status. A delivery's ID is built from its notification, channel and device, so it is the same every time the same delivery is attempted — that is what lets a provider recognize a retry (Stage 3). The status moves only forward, by conditional update: a record is set to `sending` only if it is `pending` or its lease has expired. The log is write-heavy, append-mostly and expires after 30 days, a good fit for a wide-column store with TTLs ([Databases II — NoSQL Models](#/systems/databases-nosql)).

### The inbox

```
inbox                                     -- partitioned by user_id
  user_id           BIGINT
  notification_id   BIGINT                -- clustered, descending
  type, title, body, link
  read              BOOLEAN
  PRIMARY KEY (user_id, notification_id)

inbox_state
  user_id           BIGINT  PRIMARY KEY
  read_up_to        BIGINT                -- everything at or below this ID is read
  unread_count      INT
```

The inbox is one partition per user, newest first, so a page is a single range read. Reading everything is one write to `read_up_to`, not one write per item.

<!-- tab:architecture:Architecture:default -->

This case study builds the notification system up in five stages. Each stage fixes a specific failure of the one before. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one request at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. Send Inline -->

## Stage 1 — One Service, Sending Inline

The smallest version that works: a notification service that other services call over HTTP. It looks up the user's preferences and devices, renders the text, calls the provider, and returns once the provider has answered. The calling service waits the whole time. Nothing is queued and nothing is retried.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 600 280" width="600" height="280" role="img" aria-label="A payment service calling a notification service, which reads a database and calls push and email providers before answering">
  <rect x="16" y="110" width="130" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="81" y="139" text-anchor="middle" class="d-actor-label" font-size="12">Payment Service</text>
  <g data-fail-toggle="ns1">
    <rect x="210" y="110" width="140" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="280" y="131" text-anchor="middle" class="d-actor-label" font-size="12">Notification Service</text>
    <text x="280" y="147" text-anchor="middle" class="d-label-muted" font-size="9">look up · render · send</text>
  </g>
  <g data-fail-toggle="db1">
    <rect x="420" y="20" width="160" height="50" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="500" y="42" text-anchor="middle" class="d-actor-label" font-size="12">Database</text>
    <text x="500" y="58" text-anchor="middle" class="d-label-muted" font-size="9">users · preferences · devices</text>
  </g>
  <g data-fail-toggle="push1">
    <rect x="420" y="116" width="160" height="40" rx="6" class="d-actor-box" data-role="client"></rect>
    <text x="500" y="141" text-anchor="middle" class="d-actor-label" font-size="12">Push Provider</text>
  </g>
  <g data-fail-toggle="email1">
    <rect x="420" y="200" width="160" height="40" rx="6" class="d-actor-box" data-role="client"></rect>
    <text x="500" y="225" text-anchor="middle" class="d-actor-label" font-size="12">Email Provider</text>
  </g>
  <line id="n1-pay-ns" x1="148" y1="126" x2="206" y2="126" class="d-msg d-request" data-depends-on="ns1" marker-end="url(#arrowN1)"></line>
  <line id="n1-ns-pay" x1="206" y1="144" x2="148" y2="144" class="d-msg d-response" data-depends-on="ns1" marker-end="url(#arrowN1r)"></line>
  <line id="n1-ns-db" x1="340" y1="108" x2="416" y2="54" class="d-msg d-request" data-depends-on="ns1 db1" marker-end="url(#arrowN1)"></line>
  <line id="n1-db-ns" x1="416" y1="68" x2="352" y2="114" class="d-msg d-response" data-depends-on="ns1 db1" marker-end="url(#arrowN1r)"></line>
  <line id="n1-ns-push" x1="352" y1="128" x2="416" y2="128" class="d-msg d-request" data-depends-on="ns1 push1" marker-end="url(#arrowN1)"></line>
  <line id="n1-push-ns" x1="416" y1="144" x2="352" y2="144" class="d-msg d-response" data-depends-on="ns1 push1" marker-end="url(#arrowN1r)"></line>
  <line id="n1-ns-email" x1="336" y1="160" x2="416" y2="210" class="d-msg d-request" data-depends-on="ns1 email1" marker-end="url(#arrowN1)"></line>
  <line id="n1-email-ns" x1="416" y1="226" x2="322" y2="162" class="d-msg d-response" data-depends-on="ns1 email1" marker-end="url(#arrowN1r)"></line>
  <text x="300" y="268" text-anchor="middle" class="d-label-muted" font-size="10">play the push, then the slow provider, then the retry — watch the payment service wait</text>
  <defs>
    <marker id="arrowN1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowN1r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "pay", "title": "Payment service", "rows": [["waiting on notifications", "—"], ["requests held open at 40K/sec", "—"]]},
{"id": "maya", "title": "Maya's phone and mailbox", "rows": [["pushes received", "0"], ["emails received", "0"]]}
],
"flows": [
{
"id": "push",
"label": "Payment received — send a push",
"nodes": ["ns1", "db1", "push1"],
"steps": [
{"el": "n1-pay-ns", "payload": "payment_received → maya", "text": "Ana has just paid Maya. The payment service has committed the payment, and now calls the notification service to tell Maya."},
{"el": "n1-ns-db", "payload": "maya: prefs, devices", "text": "The notification service reads Maya's preferences and devices."},
{"el": "n1-db-ns", "payload": "push on · 1 phone", "ms": 3, "text": "Maya allows push for payments and has one phone registered."},
{"el": "n1-ns-push", "payload": "‘Ana sent you ₹2,500’", "text": "It renders the template in Maya's language and sends it to the push provider."},
{"el": "n1-push-ns", "payload": "accepted", "ms": 120, "set": {"maya.pushes received": "1"}, "text": "The provider accepts the message in about 120ms, and delivers it to the phone shortly after."},
{"el": "n1-ns-pay", "payload": "200 sent", "set": {"pay.waiting on notifications": "~125ms", "pay.requests held open at 40K/sec": "~5,000"}, "text": "The payment service has waited 125ms for a notification it doesn't care about. At 40,000 sends a second, that is about 5,000 requests held open across the callers at any moment, by Little's law. Tolerable — while the provider is fast."}
]
},
{
"id": "slow",
"label": "The email provider is slow",
"nodes": ["ns1", "db1", "email1"],
"steps": [
{"el": "n1-pay-ns", "payload": "statement_ready → maya", "text": "The same payment service sends Maya's monthly statement, by email."},
{"el": "n1-ns-db", "payload": "maya: prefs", "text": "Preferences first."},
{"el": "n1-db-ns", "payload": "email on", "ms": 3, "text": "Email is allowed."},
{"el": "n1-ns-email", "payload": "send statement", "text": "The email provider is having a bad hour. It is not down — it is slow."},
{"el": "n1-email-ns", "payload": "accepted (after 4s)", "ms": 4000, "set": {"maya.emails received": "1"}, "text": "It answers after 4 seconds. The email does go out."},
{"el": "n1-ns-pay", "payload": "200 sent", "set": {"pay.waiting on notifications": "~4,000ms", "pay.requests held open at 40K/sec": "~160,000"}, "text": "The payment service waited 4 seconds. Across all callers, 40,000 sends a second at 4 seconds each is 160,000 requests held open. Every caller's thread pool and connection pool fills, and their own requests start queueing. A slow email provider has become a slow payment service, a slow sign-up flow and a slow everything."}
]
},
{
"id": "retry",
"label": "A timeout, then a retry",
"nodes": ["ns1", "db1", "email1"],
"steps": [
{"el": "n1-pay-ns", "payload": "statement_ready → maya", "set": {"maya.emails received": "0"}, "text": "The statement again. This time the payment service has a sensible 10-second timeout."},
{"el": "n1-ns-db", "payload": "maya: prefs", "text": "Preferences."},
{"el": "n1-db-ns", "payload": "email on", "ms": 3, "text": "Email is allowed."},
{"el": "n1-ns-email", "payload": "send statement", "text": "The send reaches the provider, which queues the email and starts to answer."},
{"el": "n1-email-ns", "payload": "(no answer)", "ms": 10000, "set": {"maya.emails received": "1"}, "text": "The answer never arrives: the connection drops on the way back. The email was sent. Nobody here knows that."},
{"el": "n1-ns-pay", "payload": "504 timeout", "text": "The payment service sees a timeout. It has two choices, and both are wrong. Give up, and if the send had failed, Maya never gets her statement. Retry, and if the send had worked, she gets two."},
{"el": "n1-pay-ns", "payload": "retry", "text": "It retries, as most callers do."},
{"el": "n1-ns-email", "payload": "send statement", "text": "The notification service has no record of the first attempt, so it sends again."},
{"el": "n1-email-ns", "payload": "accepted", "ms": 200, "set": {"maya.emails received": "2"}, "text": "Maya has two copies. For an email, that's an annoyance. For an SMS with a login code it is a cost, and for a ‘payment received’ push it looks like she was paid twice."},
{"el": "n1-ns-pay", "payload": "200 sent", "text": "The next stage separates accepting a notification from delivering it, so the caller never waits on a provider and the retrying moves to where it can be done safely."}
]
}
]
}
</script>
<div class="diagram-caption">Every send waits on the database and a provider before the caller gets an answer. Compare the payment service's waiting time across the three flows: the provider's worst moment becomes every caller's.</div>
</div>

<div class="fail-hint">Click the notification service, the database, or either provider to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="ns1">
<strong>If the notification service fails:</strong> every caller's send fails at once. Each caller must decide what to do about it, and most will either log an error and move on — losing the notification — or fail their own request. A payment that succeeded but reports an error because its receipt couldn't be sent is the worst outcome of all. Running several copies behind a load balancer helps with crashes ([Load Balancing](#/systems/load-balancing)), but not with the coupling.
</div>
<div class="failure-impact is-hidden" data-component="db1">
<strong>If the database fails:</strong> no preferences, no devices, so nothing can be sent. Every caller's request fails. The database holds small, rarely changing data that is read on every send — exactly what a cache is for, which later stages add ([Caching](#/systems/caching)).
</div>
<div class="failure-impact is-hidden" data-component="push1">
<strong>If the push provider fails:</strong> every push fails, and the callers see the errors. There is nowhere to put a notification that couldn't be sent yet, so each caller must keep it and retry on its own schedule — dozens of services, each reimplementing retries, each slightly differently.
</div>
<div class="failure-impact is-hidden" data-component="email1">
<strong>If the email provider fails:</strong> every email send fails, but push sends that happen in the same request may already have gone out. Replay the slow-provider flow with it failed to see the request stop at the provider. A partial failure like this leaves the caller unable to retry safely: retrying the whole request repeats the push.
</div>
</div>

This design is fine for a product sending a few thousand notifications a day to one provider. It fails because it couples three things that have nothing to do with each other: the caller's request, the provider's speed, and the decision whether to try again. The rest of the stages pull them apart.

<!-- stage:2:2. Queue & Channel Workers -->

## Stage 2 — Accept, Queue, Deliver

Split accepting a notification from delivering it. The **notification API** checks the request, records it durably, puts it on a queue and returns `202` — in a few milliseconds, whatever the providers are doing. A **router** takes notifications from the queue, reads the user's preferences, decides which channels to use, renders the text, and puts one delivery per channel on that **channel's own queue**. **Channel workers** take deliveries from their queue, call the provider, and retry with backoff when it fails ([Message Queues & Event-Driven Architecture](#/systems/message-queues)).

Each channel has its own queue and its own workers, so a failing email provider fills only the email queue. Push keeps flowing.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 760 400" width="760" height="400" role="img" aria-label="A payment service calling a notification API that records and queues notifications; a router applies preferences and fans out to separate push and email queues, each with its own workers and provider">
  <rect x="10" y="30" width="116" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="68" y="59" text-anchor="middle" class="d-actor-label" font-size="12">Payment Service</text>
  <g data-fail-toggle="api2">
    <rect x="156" y="30" width="126" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="219" y="59" text-anchor="middle" class="d-actor-label" font-size="12">Notification API</text>
  </g>
  <g data-fail-toggle="store2">
    <rect x="156" y="120" width="126" height="48" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="219" y="140" text-anchor="middle" class="d-actor-label" font-size="12">Notification Store</text>
    <text x="219" y="156" text-anchor="middle" class="d-label-muted" font-size="9">log · idempotency keys</text>
  </g>
  <g data-fail-toggle="inq2">
    <rect x="312" y="30" width="126" height="48" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="375" y="59" text-anchor="middle" class="d-actor-label" font-size="12">Incoming Queue</text>
  </g>
  <g data-fail-toggle="router2">
    <rect x="468" y="30" width="126" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="531" y="51" text-anchor="middle" class="d-actor-label" font-size="12">Router</text>
    <text x="531" y="67" text-anchor="middle" class="d-label-muted" font-size="9">preferences · templates</text>
  </g>
  <g data-fail-toggle="prefs2">
    <rect x="630" y="30" width="120" height="48" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="690" y="51" text-anchor="middle" class="d-actor-label" font-size="12">Preferences</text>
    <text x="690" y="67" text-anchor="middle" class="d-label-muted" font-size="9">+ devices, cached</text>
  </g>
  <rect x="400" y="150" width="126" height="44" rx="6" class="d-actor-box" data-role="routing"></rect>
  <text x="463" y="176" text-anchor="middle" class="d-actor-label" font-size="12">Push Queue</text>
  <rect x="580" y="150" width="126" height="44" rx="6" class="d-actor-box" data-role="routing"></rect>
  <text x="643" y="176" text-anchor="middle" class="d-actor-label" font-size="12">Email Queue</text>
  <rect x="400" y="236" width="126" height="44" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="463" y="262" text-anchor="middle" class="d-actor-label" font-size="12">Push Workers</text>
  <g data-fail-toggle="emailw2">
    <rect x="580" y="236" width="126" height="44" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="643" y="262" text-anchor="middle" class="d-actor-label" font-size="12">Email Workers</text>
  </g>
  <rect x="400" y="322" width="126" height="44" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="463" y="348" text-anchor="middle" class="d-actor-label" font-size="12">Push Provider</text>
  <g data-fail-toggle="emailp2">
    <rect x="580" y="322" width="126" height="44" rx="6" class="d-actor-box" data-role="client"></rect>
    <text x="643" y="348" text-anchor="middle" class="d-actor-label" font-size="12">Email Provider</text>
  </g>
  <rect x="30" y="250" width="250" height="48" rx="6" class="d-note"></rect>
  <text x="155" y="270" text-anchor="middle" class="d-note-text" font-size="11">SMS and in-app inbox lanes</text>
  <text x="155" y="286" text-anchor="middle" class="d-note-text" font-size="9">have their own queue and workers, built the same way</text>
  <line id="n2-prod-api" x1="128" y1="46" x2="152" y2="46" class="d-msg d-request" data-depends-on="api2" marker-end="url(#arrowN2)"></line>
  <line id="n2-api-prod" x1="152" y1="62" x2="128" y2="62" class="d-msg d-response" data-depends-on="api2" marker-end="url(#arrowN2r)"></line>
  <line id="n2-api-store" x1="205" y1="80" x2="205" y2="116" class="d-msg d-request" data-depends-on="api2 store2" marker-end="url(#arrowN2)"></line>
  <line id="n2-store-api" x1="233" y1="116" x2="233" y2="80" class="d-msg d-response" data-depends-on="api2 store2" marker-end="url(#arrowN2r)"></line>
  <line id="n2-api-inq" x1="284" y1="54" x2="308" y2="54" class="d-msg d-request" data-depends-on="api2 inq2" marker-end="url(#arrowN2)"></line>
  <line id="n2-inq-router" x1="440" y1="54" x2="464" y2="54" class="d-msg d-request" data-depends-on="inq2 router2" marker-end="url(#arrowN2)"></line>
  <line id="n2-router-prefs" x1="596" y1="46" x2="626" y2="46" class="d-msg d-request" data-depends-on="router2 prefs2" marker-end="url(#arrowN2)"></line>
  <line id="n2-prefs-router" x1="626" y1="62" x2="596" y2="62" class="d-msg d-response" data-depends-on="router2 prefs2" marker-end="url(#arrowN2r)"></line>
  <line id="n2-router-pushq" x1="510" y1="80" x2="472" y2="146" class="d-msg d-request" data-depends-on="router2" marker-end="url(#arrowN2)"></line>
  <line id="n2-router-emailq" x1="556" y1="80" x2="618" y2="146" class="d-msg d-request" data-depends-on="router2" marker-end="url(#arrowN2)"></line>
  <line id="n2-pushq-pushw" x1="463" y1="196" x2="463" y2="232" class="d-msg d-request" marker-end="url(#arrowN2)"></line>
  <line id="n2-emailq-emailw" x1="643" y1="196" x2="643" y2="232" class="d-msg d-request" data-depends-on="emailw2" marker-end="url(#arrowN2)"></line>
  <line id="n2-pushw-pushp" x1="450" y1="282" x2="450" y2="318" class="d-msg d-request" marker-end="url(#arrowN2)"></line>
  <line id="n2-pushp-pushw" x1="476" y1="318" x2="476" y2="282" class="d-msg d-response" marker-end="url(#arrowN2r)"></line>
  <line id="n2-emailw-emailp" x1="630" y1="282" x2="630" y2="318" class="d-msg d-request" data-depends-on="emailw2 emailp2" marker-end="url(#arrowN2)"></line>
  <line id="n2-emailp-emailw" x1="656" y1="318" x2="656" y2="282" class="d-msg d-response" data-depends-on="emailw2 emailp2" marker-end="url(#arrowN2r)"></line>
  <line id="n2-pushw-store" x1="396" y1="250" x2="286" y2="164" class="d-msg d-request" data-depends-on="store2" marker-end="url(#arrowN2)"></line>
  <text x="380" y="390" text-anchor="middle" class="d-label-muted" font-size="10">play the push, then fail the email provider and play the statement; the payment service is done at 202 either way</text>
  <defs>
    <marker id="arrowN2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowN2r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "n", "title": "Notification …9632", "rows": [["status", "—"], ["payment service waited", "—"]]},
{"id": "d", "title": "Deliveries", "rows": [["push", "—"], ["email", "—"]]}
],
"flows": [
{
"id": "push",
"label": "Payment received — accept and deliver",
"nodes": ["api2", "store2", "inq2", "router2", "prefs2"],
"steps": [
{"el": "n2-prod-api", "payload": "payment_received → maya", "text": "The payment service sends the same request as in Stage 1, with an idempotency key built from the transaction ID."},
{"el": "n2-api-store", "payload": "insert notification + key", "text": "The API checks that the payment service may send this type and that the template data is complete. Then it records the notification and its idempotency key in the notification store, with a time-ordered ID ending …9632."},
{"el": "n2-store-api", "payload": "OK", "ms": 3, "set": {"n.status": "accepted"}, "text": "The notification is durable. From here on, the system has promised to deliver it or record why it couldn't."},
{"el": "n2-api-inq", "payload": "…9632", "ms": 1, "text": "The API puts the notification's ID on the incoming queue."},
{"el": "n2-api-prod", "payload": "202 accepted", "set": {"n.payment service waited": "~5ms"}, "text": "The payment service is done after about 5ms. It will never wait on a provider again. The latency readout keeps counting the background work, but nobody is waiting for it."},
{"el": "n2-inq-router", "payload": "…9632", "text": "A router takes the notification from the queue."},
{"el": "n2-router-prefs", "payload": "maya: prefs, devices", "text": "It reads Maya's preferences and devices from a cache. Preferences are read on every notification and change rarely, so the cache holds nearly all of them."},
{"el": "n2-prefs-router", "payload": "push ✓ · email ✗ · 1 phone", "ms": 1, "text": "Maya allows push for payments, and has turned off payment emails."},
{"el": "n2-router-pushq", "payload": "delivery …9632/push/ios", "ms": 1, "set": {"n.status": "routed", "d.push": "pending", "d.email": "skipped — preference"}, "text": "The router renders the push text in Maya's language and puts one delivery on the push queue. Email is recorded as skipped, with the reason, so support can later answer ‘why didn't I get an email?’."},
{"el": "n2-pushq-pushw", "payload": "delivery", "text": "A push worker takes the delivery."},
{"el": "n2-pushw-pushp", "payload": "‘Ana sent you ₹2,500’", "text": "It sends it to the push provider over a long-lived connection."},
{"el": "n2-pushp-pushw", "payload": "accepted", "ms": 120, "text": "Accepted in about 120ms."},
{"el": "n2-pushw-store", "payload": "…/push: sent", "ms": 2, "set": {"d.push": "sent", "n.status": "sent"}, "text": "The worker records the delivery as sent, then acknowledges the queue message so it isn't delivered again. Maya's phone buzzes about 130ms after the payment service asked."}
]
},
{
"id": "email-down",
"label": "Monthly statement — email provider down",
"nodes": ["api2", "store2", "inq2", "router2", "prefs2", "emailw2", "emailp2"],
"steps": [
{"el": "n2-prod-api", "payload": "statement_ready → maya", "text": "The payment service sends Maya's monthly statement. The email provider is returning errors to every request."},
{"el": "n2-api-store", "payload": "insert notification + key", "text": "Recorded, as before."},
{"el": "n2-store-api", "payload": "OK", "ms": 3, "set": {"n.status": "accepted"}, "text": "Durable."},
{"el": "n2-api-inq", "payload": "…9701", "ms": 1, "text": "Queued."},
{"el": "n2-api-prod", "payload": "202 accepted", "set": {"n.payment service waited": "~5ms"}, "text": "The payment service is done in 5ms. The provider's outage is invisible to it."},
{"el": "n2-inq-router", "payload": "…9701", "text": "The router picks it up."},
{"el": "n2-router-prefs", "payload": "maya: prefs", "text": "Statements are allowed by email."},
{"el": "n2-prefs-router", "payload": "email ✓", "ms": 1, "text": "Email is on for statements."},
{"el": "n2-router-emailq", "payload": "delivery …9701/email", "ms": 1, "set": {"d.push": "—", "d.email": "pending"}, "text": "One delivery on the email queue."},
{"el": "n2-emailq-emailw", "payload": "delivery", "text": "An email worker takes it."},
{"el": "n2-emailw-emailp", "payload": "send statement", "text": "And calls the provider, with a 5-second timeout."},
{"el": "n2-emailp-emailw", "payload": "503", "ms": 40, "set": {"d.email": "retrying — attempt 1 failed"}, "text": "The provider fails. The worker doesn't drop the delivery or hold it. It returns it to the queue with a delay — 30 seconds, then 1, 2, 4, 8 minutes and so on, each with some random jitter so that thousands of retries don't all land at the same instant."},
{"el": "n2-emailw-emailp", "payload": "send (attempt 5)", "text": "Fifteen minutes later the provider has recovered. The fifth attempt goes through."},
{"el": "n2-emailp-emailw", "payload": "accepted", "ms": 200, "set": {"d.email": "sent after 5 attempts", "n.status": "sent"}, "text": "Maya gets her statement late, but she gets it. Meanwhile pushes kept flowing through their own lane. A delivery that still fails after about 24 hours of retries — or after its type's TTL — is moved to a dead-letter queue and recorded as failed, for someone to look at."}
]
},
{
"id": "pref-off",
"label": "Maya has turned this category off",
"nodes": ["router2", "prefs2"],
"steps": [
{"el": "n2-inq-router", "payload": "new_follower → maya", "set": {"n.status": "accepted", "n.payment service waited": "—"}, "text": "A social service sends ‘Leo started following you’ to Maya."},
{"el": "n2-router-prefs", "payload": "maya: prefs", "text": "The router checks her preferences."},
{"el": "n2-prefs-router", "payload": "social: all off", "ms": 1, "set": {"n.status": "skipped — preference", "d.push": "skipped", "d.email": "skipped"}, "text": "Maya turned off social notifications on every channel. The router records the notification as skipped and queues nothing. The social service didn't have to know about Maya's preferences, and couldn't get them wrong."}
]
}
]
}
</script>
<div class="diagram-caption">The API records and queues a notification, then answers at once. The router applies preferences and splits it into one delivery per channel; each channel has its own queue, workers and provider. Fail the email provider and play the statement to see retries happen in the email lane only.</div>
</div>

<div class="fail-hint">Click the API, the notification store, the incoming queue, the router, the preferences cache, the email workers or the email provider to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="api2">
<strong>If the notification API fails:</strong> callers can't hand over notifications. This is the one part of the system every other service talks to, so it is stateless, runs many copies across zones, and is held to the highest availability target. Callers keep a small local retry buffer for the moments it is unreachable — but only a buffer, not their own delivery logic.
</div>
<div class="failure-impact is-hidden" data-component="store2">
<strong>If the notification store fails:</strong> the API can't record new notifications, so it can't accept them: accepting a notification it hasn't recorded would break the promise that an accepted notification is never lost. Sends fail with a 503 and callers retry. Workers can't record delivery status either; they keep delivering and buffer the status updates. The store is replicated across zones ([Replication](#/systems/replication)).
</div>
<div class="failure-impact is-hidden" data-component="inq2">
<strong>If the incoming queue fails:</strong> notifications are recorded but not queued. The API can still return 202, because the notification store has them: a sweeper finds notifications that have been ‘accepted’ for more than a minute without being routed and queues them again. A cleaner version writes the notification and its outgoing message in the same database transaction, and a relay publishes from there — the outbox pattern ([Message Queues & Event-Driven Architecture](#/systems/message-queues)).
</div>
<div class="failure-impact is-hidden" data-component="router2">
<strong>If the routers fail:</strong> notifications pile up in the incoming queue and nothing new reaches any channel. Nothing is lost. Routers keep no state, so they are easy to restart and scale. When they come back, the backlog is drained — and Stage 4 makes sure the urgent part of that backlog goes first.
</div>
<div class="failure-impact is-hidden" data-component="prefs2">
<strong>If the preferences cache fails:</strong> routers fall back to the preferences database, which is sized for writes and cache misses, not 40,000 reads a second. They must not fall back to ‘send anyway’: sending a notification someone turned off is a broken promise, and for marketing email it can be illegal. Under heavy load, routers keep processing critical notifications from the database and hold everything else until the cache is back.
</div>
<div class="failure-impact is-hidden" data-component="emailw2">
<strong>If the email workers fail:</strong> the email queue grows and emails go out late. Push, SMS and inbox are unaffected — this is the point of separate lanes. A worker that crashes mid-delivery leaves its message unacknowledged, and the queue hands it to another worker after a timeout. Whether that can send the email twice is the subject of Stage 3.
</div>
<div class="failure-impact is-hidden" data-component="emailp2">
<strong>If the email provider fails:</strong> email deliveries are retried with backoff, as the statement flow shows. If the outage lasts, a second email provider can take over: email and SMS can be sent through more than one provider, and workers switch when one's error rate crosses a threshold. Push has no second provider — each phone platform's push service is the only route to its phones — so push deliveries simply wait, and those past their TTL are dropped.
</div>
</div>

Callers no longer wait on providers, and providers no longer fail callers. But every retry in this stage — the caller's, the queue's, the worker's — is a chance to send the same thing twice. The next stage makes those retries safe.

<!-- stage:3:3. Effectively Once -->

## Stage 3 — Effectively Once

Every hand-off in this system can be retried: the caller retries the API, the queue redelivers to workers, the worker retries the provider. Retrying is how nothing gets lost — this is **at-least-once delivery**. Each retry also risks a duplicate. Exactly-once delivery across a network isn't possible: a sender can never be certain whether a request it got no answer to was carried out. What is possible is making the repeat harmless, so the user sees one notification. That is called **effectively once**, and it needs a deduplication point at each hand-off ([Idempotency & Exactly-Once Delivery](#/systems/idempotency)).

- **Caller to API:** the idempotency key. A repeated key returns the existing notification.
- **Queue to worker:** a lease on the delivery record. Only one worker may be sending a delivery at a time.
- **Worker to provider:** the delivery ID, passed to the provider as its idempotency key. A provider that supports this recognizes a repeat and doesn't send again.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 700 330" width="700" height="330" role="img" aria-label="An auth service calling the API, which checks an idempotency store; an SMS queue delivering to two workers, which claim deliveries in a delivery log before calling an SMS provider">
  <rect x="16" y="34" width="120" height="44" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="76" y="60" text-anchor="middle" class="d-actor-label" font-size="12">Auth Service</text>
  <rect x="180" y="34" width="130" height="44" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="245" y="60" text-anchor="middle" class="d-actor-label" font-size="12">API + Router</text>
  <g data-fail-toggle="idem3">
    <rect x="180" y="140" width="130" height="48" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="245" y="160" text-anchor="middle" class="d-actor-label" font-size="12">Idempotency Keys</text>
    <text x="245" y="176" text-anchor="middle" class="d-label-muted" font-size="9">caller key → notification</text>
  </g>
  <g data-fail-toggle="q3">
    <rect x="360" y="30" width="130" height="52" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="425" y="52" text-anchor="middle" class="d-actor-label" font-size="12">SMS Queue</text>
    <text x="425" y="68" text-anchor="middle" class="d-label-muted" font-size="9">redelivers after 30s</text>
  </g>
  <rect x="360" y="140" width="130" height="44" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="425" y="166" text-anchor="middle" class="d-actor-label" font-size="12">SMS Worker A</text>
  <rect x="360" y="250" width="130" height="44" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="425" y="276" text-anchor="middle" class="d-actor-label" font-size="12">SMS Worker B</text>
  <g data-fail-toggle="dlog3">
    <rect x="560" y="126" width="124" height="48" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="622" y="146" text-anchor="middle" class="d-actor-label" font-size="12">Delivery Log</text>
    <text x="622" y="162" text-anchor="middle" class="d-label-muted" font-size="9">status · lease</text>
  </g>
  <g data-fail-toggle="sms3">
    <rect x="560" y="246" width="124" height="48" rx="6" class="d-actor-box" data-role="client"></rect>
    <text x="622" y="266" text-anchor="middle" class="d-actor-label" font-size="12">SMS Provider</text>
    <text x="622" y="282" text-anchor="middle" class="d-label-muted" font-size="9">dedupes on delivery ID</text>
  </g>
  <line id="n3-prod-api" x1="138" y1="50" x2="176" y2="50" class="d-msg d-request" marker-end="url(#arrowN3)"></line>
  <line id="n3-api-prod" x1="176" y1="66" x2="138" y2="66" class="d-msg d-response" marker-end="url(#arrowN3r)"></line>
  <line id="n3-api-idem" x1="230" y1="80" x2="230" y2="136" class="d-msg d-request" data-depends-on="idem3" marker-end="url(#arrowN3)"></line>
  <line id="n3-idem-api" x1="260" y1="136" x2="260" y2="80" class="d-msg d-response" data-depends-on="idem3" marker-end="url(#arrowN3r)"></line>
  <line id="n3-api-q" x1="312" y1="56" x2="356" y2="56" class="d-msg d-request" data-depends-on="q3" marker-end="url(#arrowN3)"></line>
  <line id="n3-q-wa" x1="425" y1="84" x2="425" y2="136" class="d-msg d-request" data-depends-on="q3" marker-end="url(#arrowN3)"></line>
  <path id="n3-q-wb" d="M358 76 H340 V266 H356" fill="none" class="d-msg d-request" data-depends-on="q3" marker-end="url(#arrowN3)"></path>
  <line id="n3-wa-dlog" x1="492" y1="150" x2="556" y2="144" class="d-msg d-request" data-depends-on="dlog3" marker-end="url(#arrowN3)"></line>
  <line id="n3-dlog-wa" x1="556" y1="158" x2="492" y2="164" class="d-msg d-response" data-depends-on="dlog3" marker-end="url(#arrowN3r)"></line>
  <line id="n3-wa-sms" x1="492" y1="176" x2="556" y2="248" class="d-msg d-request" data-depends-on="sms3" marker-end="url(#arrowN3)"></line>
  <line id="n3-sms-wa" x1="556" y1="262" x2="478" y2="186" class="d-msg d-response" data-depends-on="sms3" marker-end="url(#arrowN3r)"></line>
  <line id="n3-wb-dlog" x1="492" y1="256" x2="566" y2="178" class="d-msg d-request" data-depends-on="dlog3" marker-end="url(#arrowN3)"></line>
  <line id="n3-dlog-wb" x1="580" y1="178" x2="504" y2="262" class="d-msg d-response" data-depends-on="dlog3" marker-end="url(#arrowN3r)"></line>
  <line id="n3-wb-sms" x1="492" y1="270" x2="556" y2="270" class="d-msg d-request" data-depends-on="sms3" marker-end="url(#arrowN3)"></line>
  <line id="n3-sms-wb" x1="556" y1="286" x2="492" y2="286" class="d-msg d-response" data-depends-on="sms3" marker-end="url(#arrowN3r)"></line>
  <text x="350" y="320" text-anchor="middle" class="d-label-muted" font-size="10">play each flow and watch the count of texts on Maya's phone</text>
  <defs>
    <marker id="arrowN3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowN3r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "d", "title": "Delivery …4410/sms", "rows": [["status", "—"], ["lease", "—"], ["provider message", "—"]]},
{"id": "maya", "title": "Maya's phone", "rows": [["login codes received", "0"]]}
],
"flows": [
{
"id": "caller-retry",
"label": "The caller retries",
"nodes": ["idem3", "q3"],
"steps": [
{"el": "n3-prod-api", "payload": "login_code · key auth:req_31", "set": {"maya.login codes received": "0"}, "text": "Maya is signing in on a new laptop. The auth service asks for a login code to be sent to her phone by SMS, with an idempotency key built from its own request ID."},
{"el": "n3-api-idem", "payload": "insert-if-absent auth:req_31", "text": "The API tries to insert the key. The insert succeeds only if the key isn't there yet — one atomic operation, so two concurrent requests with the same key can't both succeed."},
{"el": "n3-idem-api", "payload": "new → …4410", "ms": 2, "text": "The key is new. It now points to notification …4410."},
{"el": "n3-api-q", "payload": "delivery …4410/sms", "ms": 1, "set": {"d.status": "pending"}, "text": "The notification is routed and one SMS delivery is queued."},
{"el": "n3-api-prod", "payload": "202 …4410", "text": "The 202 is sent, but a network blip drops it. The auth service times out after 2 seconds."},
{"el": "n3-prod-api", "payload": "login_code · key auth:req_31", "text": "The auth service retries with the same key, as it should."},
{"el": "n3-api-idem", "payload": "insert-if-absent auth:req_31", "text": "The API tries the insert again."},
{"el": "n3-idem-api", "payload": "exists → …4410", "ms": 2, "text": "The key exists. The API compares the request body with the one stored with the key, finds it identical, and does nothing else."},
{"el": "n3-api-prod", "payload": "202 …4410 (same)", "text": "The auth service gets the original answer. One delivery is queued, not two. This covers the first hand-off."}
]
},
{
"id": "worker-crash",
"label": "A worker crashes after sending",
"nodes": ["q3", "dlog3", "sms3"],
"steps": [
{"el": "n3-q-wa", "payload": "delivery …4410/sms", "set": {"d.status": "pending", "d.lease": "—", "d.provider message": "—", "maya.login codes received": "0"}, "text": "Worker A takes the delivery from the SMS queue. The queue hides the message from other workers for 30 seconds. If A doesn't acknowledge it by then, the queue assumes A is dead and hands it to someone else."},
{"el": "n3-wa-dlog", "payload": "claim: pending → sending", "text": "Before calling the provider, A claims the delivery: a conditional update that sets the status to ‘sending’ with A's name and a 30-second lease, and succeeds only if the status is ‘pending’ or the previous lease has expired."},
{"el": "n3-dlog-wa", "payload": "claimed", "ms": 2, "set": {"d.status": "sending", "d.lease": "worker A, 30s"}, "text": "A holds the lease. No other worker can claim this delivery for 30 seconds."},
{"el": "n3-wa-sms", "payload": "send code · key …4410/sms", "text": "A calls the SMS provider, passing the delivery ID as the provider's idempotency key."},
{"el": "n3-sms-wa", "payload": "msg_9f2 accepted", "ms": 150, "set": {"maya.login codes received": "1"}, "text": "The provider accepts and sends the text. Maya's phone gets the code. Then worker A's machine dies — before it records ‘sent’, and before it acknowledges the queue message."},
{"el": "n3-q-wb", "payload": "…4410/sms (redelivered)", "text": "Thirty seconds later the queue hands the same message to worker B. From the queue's point of view, A failed. That is at-least-once delivery working as designed."},
{"el": "n3-wb-dlog", "payload": "claim: pending → sending", "text": "B tries to claim the delivery."},
{"el": "n3-dlog-wb", "payload": "claimed · was ‘sending’", "ms": 2, "set": {"d.lease": "worker B, 30s"}, "text": "A's lease has expired, so B gets it. But the record says the delivery was already ‘sending’: someone tried, and nobody knows whether it worked. Nothing in this system can find out — only the provider knows."},
{"el": "n3-wb-sms", "payload": "send code · key …4410/sms", "text": "So B sends again, with the same idempotency key. The delivery ID is built from the notification, channel and device, so it is the same on every attempt."},
{"el": "n3-sms-wb", "payload": "msg_9f2 (already sent)", "ms": 120, "set": {"d.provider message": "msg_9f2", "maya.login codes received": "1"}, "text": "The provider has seen this key before. It returns the original message ID and sends nothing. Maya's phone still shows one code."},
{"el": "n3-wb-dlog", "payload": "sent · msg_9f2", "ms": 2, "set": {"d.status": "sent", "d.lease": "—"}, "text": "B records the delivery as sent and acknowledges the queue message. A crash at the worst possible moment produced no duplicate, because the one component that knew the truth was asked in a way it could answer safely."}
]
},
{
"id": "no-provider-key",
"label": "The same crash, provider without idempotency",
"nodes": ["q3", "dlog3", "sms3"],
"steps": [
{"el": "n3-q-wb", "payload": "…4410/sms (redelivered)", "set": {"d.status": "sending", "d.lease": "worker A, expired", "d.provider message": "—", "maya.login codes received": "1"}, "text": "The same story: A sent the code and died. This time the SMS provider has no idempotency key support — many don't."},
{"el": "n3-wb-dlog", "payload": "claim: pending → sending", "text": "B claims the delivery."},
{"el": "n3-dlog-wb", "payload": "claimed · was ‘sending’", "ms": 2, "set": {"d.lease": "worker B, 30s"}, "text": "The outcome of A's attempt is unknown. B has to choose, and the choice is set per notification type. Send again, risking a duplicate: at-least-once. Or record ‘unknown’ and stop, risking a lost message: at-most-once."},
{"el": "n3-wb-sms", "payload": "send code", "text": "For a login code, a duplicate is a small cost and a missing code locks Maya out, so the type says send again."},
{"el": "n3-sms-wb", "payload": "msg_a07 accepted", "ms": 150, "set": {"d.provider message": "msg_a07", "d.status": "sent", "maya.login codes received": "2"}, "text": "Maya gets two identical codes; both work. For a marketing message the type says at-most-once instead, because nobody is harmed by a missing promotion and everyone is annoyed by two. The window is small — only a crash between the provider's answer and the status write causes it — but it can't be closed from this side."}
]
}
]
}
</script>
<div class="diagram-caption">Three hand-offs, three deduplication points: the idempotency key at the API, a lease on the delivery record between workers, and the delivery ID passed to the provider. Play the worker crash to see a redelivered message produce no second text.</div>
</div>

<div class="fail-hint">Click the idempotency keys, the SMS queue, the delivery log or the SMS provider to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="idem3">
<strong>If the idempotency-key store fails:</strong> the API can't tell a new request from a retry. It can refuse requests until the store is back, which is safe but makes notifications unavailable. Or it can accept them without the check and risk duplicates for the length of the outage. Most systems refuse for critical types and accept for the rest. The keys can live in the same replicated store as the notification log, so the check and the insert are one write and fail together.
</div>
<div class="failure-impact is-hidden" data-component="q3">
<strong>If the SMS queue fails:</strong> new SMS deliveries can't be queued and the router holds them. Deliveries already taken by workers finish normally. If the queue loses messages rather than just stopping, the delivery log still lists every delivery as ‘pending’, and a sweeper requeues pending deliveries older than a few minutes. The log is the record of what must happen; the queue is only how work is handed out.
</div>
<div class="failure-impact is-hidden" data-component="dlog3">
<strong>If the delivery log fails:</strong> workers can't claim deliveries, so they must either stop sending or send without a claim. Sending without claims means two workers can send the same delivery at the same time if the queue redelivers. For a short outage, stopping is the safer choice: the queue keeps the work. Replay the worker crash with the log failed to see the claim fail.
</div>
<div class="failure-impact is-hidden" data-component="sms3">
<strong>If the SMS provider fails:</strong> deliveries are retried with backoff, as in Stage 2, and after a threshold of errors workers switch to a second SMS provider. The switch is where duplicates are most likely: a delivery whose outcome at the first provider is unknown is resent through the second, which has never seen its key. For login codes that is acceptable; for anything else, unknown outcomes are not resent across providers.
</div>
</div>

With leases, keys and forward-only statuses, each delivery has one owner at a time and one recorded outcome. Duplicates are now rare, and the cases where they remain are a deliberate choice per notification type. What hasn't been dealt with is volume: everything still shares the same lanes.

<!-- stage:4:4. Priorities & Pacing -->

## Stage 4 — Priority Lanes and Pacing

A 50-million-user broadcast and a login code both end up as push deliveries. In Stage 3's design they share a queue, and a queue is first in, first out. A login code queued behind 50 million marketing pushes waits for all of them.

This stage separates traffic by priority, and controls how fast each kind reaches providers:

- **Priority lanes.** Every channel has a **critical** lane (login codes, security alerts, payments), a **normal** lane (social activity) and a **bulk** lane (marketing, digests). Each lane has its own queue and its own reserved workers. The priority comes from the notification type, not from the caller.
- **Paced broadcasts.** A **broadcast expander** turns a segment into individual notifications at a fixed rate, rather than all at once.
- **Provider rate limits.** Workers send to each provider through a token bucket sized to that provider's limit, and slow down when it pushes back ([Rate Limiting & Backpressure](#/systems/rate-limiting)).
- **A scheduler** holds notifications until a time: a `send_at`, the end of a user's quiet hours, or 9:00 in each user's time zone.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 680 400" width="680" height="400" role="img" aria-label="An auth service and a campaign service feeding separate critical and bulk lanes; a broadcast expander and a scheduler feed the bulk queue; critical and bulk workers share one push provider">
  <rect x="16" y="40" width="120" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="76" y="61" text-anchor="middle" class="d-actor-label" font-size="12">Auth Service</text>
  <text x="76" y="77" text-anchor="middle" class="d-label-muted" font-size="9">login codes</text>
  <rect x="16" y="280" width="120" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="76" y="301" text-anchor="middle" class="d-actor-label" font-size="12">Campaign Service</text>
  <text x="76" y="317" text-anchor="middle" class="d-label-muted" font-size="9">50M-user broadcast</text>
  <rect x="176" y="40" width="130" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="241" y="61" text-anchor="middle" class="d-actor-label" font-size="12">API + Router</text>
  <text x="241" y="77" text-anchor="middle" class="d-label-muted" font-size="9">lane chosen by type</text>
  <g data-fail-toggle="sched4">
    <rect x="176" y="160" width="130" height="48" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="241" y="181" text-anchor="middle" class="d-actor-label" font-size="12">Scheduler</text>
    <text x="241" y="197" text-anchor="middle" class="d-label-muted" font-size="9">send_at · quiet hours</text>
  </g>
  <g data-fail-toggle="exp4">
    <rect x="176" y="280" width="130" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="241" y="301" text-anchor="middle" class="d-actor-label" font-size="12">Broadcast Expander</text>
    <text x="241" y="317" text-anchor="middle" class="d-label-muted" font-size="9">paced · 30K/sec</text>
  </g>
  <rect x="356" y="40" width="130" height="44" rx="6" class="d-actor-box" data-role="routing"></rect>
  <text x="421" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Critical Queue</text>
  <g data-fail-toggle="bq4">
    <rect x="356" y="280" width="130" height="44" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="421" y="306" text-anchor="middle" class="d-actor-label" font-size="12">Bulk Queue</text>
  </g>
  <g data-fail-toggle="cw4">
    <rect x="526" y="40" width="130" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="591" y="61" text-anchor="middle" class="d-actor-label" font-size="12">Critical Workers</text>
    <text x="591" y="77" text-anchor="middle" class="d-label-muted" font-size="9">reserved capacity</text>
  </g>
  <g data-fail-toggle="bw4">
    <rect x="526" y="280" width="130" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="591" y="301" text-anchor="middle" class="d-actor-label" font-size="12">Bulk Workers</text>
    <text x="591" y="317" text-anchor="middle" class="d-label-muted" font-size="9">token bucket</text>
  </g>
  <g data-fail-toggle="pp4">
    <rect x="526" y="160" width="130" height="48" rx="6" class="d-actor-box" data-role="client"></rect>
    <text x="591" y="189" text-anchor="middle" class="d-actor-label" font-size="12">Push Provider</text>
  </g>
  <line id="n4-auth-router" x1="138" y1="64" x2="172" y2="64" class="d-msg d-request" marker-end="url(#arrowN4)"></line>
  <line id="n4-router-cq" x1="308" y1="62" x2="352" y2="62" class="d-msg d-request" marker-end="url(#arrowN4)"></line>
  <line id="n4-cq-cw" x1="488" y1="62" x2="522" y2="62" class="d-msg d-request" data-depends-on="cw4" marker-end="url(#arrowN4)"></line>
  <line id="n4-cw-pp" x1="580" y1="90" x2="580" y2="156" class="d-msg d-request" data-depends-on="cw4 pp4" marker-end="url(#arrowN4)"></line>
  <line id="n4-pp-cw" x1="604" y1="156" x2="604" y2="90" class="d-msg d-response" data-depends-on="cw4 pp4" marker-end="url(#arrowN4r)"></line>
  <line id="n4-camp-exp" x1="138" y1="304" x2="172" y2="304" class="d-msg d-request" data-depends-on="exp4" marker-end="url(#arrowN4)"></line>
  <line id="n4-exp-bq" x1="308" y1="302" x2="352" y2="302" class="d-msg d-request" data-depends-on="exp4 bq4" marker-end="url(#arrowN4)"></line>
  <line id="n4-exp-cq" x1="296" y1="278" x2="400" y2="88" class="d-msg d-request" data-depends-on="exp4" marker-end="url(#arrowN4)"></line>
  <line id="n4-bq-bw" x1="488" y1="302" x2="522" y2="302" class="d-msg d-request" data-depends-on="bq4 bw4" marker-end="url(#arrowN4)"></line>
  <line id="n4-bw-pp" x1="580" y1="278" x2="580" y2="212" class="d-msg d-request" data-depends-on="bw4 pp4" marker-end="url(#arrowN4)"></line>
  <line id="n4-pp-bw" x1="604" y1="212" x2="604" y2="278" class="d-msg d-response" data-depends-on="bw4 pp4" marker-end="url(#arrowN4r)"></line>
  <line id="n4-router-sched" x1="241" y1="90" x2="241" y2="156" class="d-msg d-request" data-depends-on="sched4" marker-end="url(#arrowN4)"></line>
  <line id="n4-sched-bq" x1="296" y1="210" x2="372" y2="276" class="d-msg d-request" data-depends-on="sched4 bq4" marker-end="url(#arrowN4)"></line>
  <text x="340" y="370" text-anchor="middle" class="d-label-muted" font-size="10">play the shared queue first, then the lanes — compare how long the login code waits</text>
  <defs>
    <marker id="arrowN4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowN4r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "b", "title": "Weekly digest broadcast", "rows": [["recipients", "50M"], ["queued ahead of the login code", "—"]]},
{"id": "otp", "title": "Maya's login code", "rows": [["waited in queue", "—"], ["deadline", "5s"]]}
],
"flows": [
{
"id": "shared",
"label": "Broadcast and login code, one queue",
"nodes": ["exp4", "pp4"],
"steps": [
{"el": "n4-camp-exp", "payload": "weekly_digest → seg_active_90d", "text": "The growth team sends the weekly digest to 50 million users. For this flow, imagine there is only one push queue — the top one — as in Stage 3."},
{"el": "n4-exp-cq", "payload": "50M deliveries", "set": {"b.queued ahead of the login code": "~50M"}, "text": "The segment is expanded and all 50 million deliveries go into the queue within a couple of minutes. Workers send about 30,000 a second, so the queue will take about 28 minutes to drain."},
{"el": "n4-auth-router", "payload": "login_code → maya", "text": "A minute later, Maya tries to sign in and the auth service asks for a login code."},
{"el": "n4-router-cq", "payload": "login code", "text": "The router puts it on the same queue, behind tens of millions of digest pushes."},
{"el": "n4-cq-cw", "payload": "…after the digest", "set": {"otp.waited in queue": "~27 minutes"}, "text": "The workers get to it 27 minutes later. Maya gave up after one. The code expired after ten. Every login, payment alert and security warning sent during that half hour was late in the same way, and for the same reason: a queue doesn't know that some messages matter more."}
]
},
{
"id": "lanes",
"label": "Broadcast and login code, separate lanes",
"nodes": ["exp4", "bq4", "bw4", "cw4", "pp4"],
"steps": [
{"el": "n4-camp-exp", "payload": "weekly_digest → seg_active_90d", "set": {"b.queued ahead of the login code": "—", "otp.waited in queue": "—"}, "text": "The same broadcast. The digest type is marked bulk, so the expander handles it."},
{"el": "n4-exp-bq", "payload": "≤ 30K/sec", "text": "The expander reads the segment page by page and creates notifications at 30,000 a second, the rate that finishes 50 million in about 28 minutes. Each one still goes through preferences, quiet hours and frequency limits. They go only to the bulk queue."},
{"el": "n4-bq-bw", "payload": "deliveries", "text": "Bulk workers take them."},
{"el": "n4-bw-pp", "payload": "digest pushes", "text": "They send through a token bucket that keeps the bulk lane below its share of the provider's rate limit, leaving room for everything else."},
{"el": "n4-pp-bw", "payload": "accepted", "ms": 150, "text": "The broadcast proceeds at its own steady pace."},
{"el": "n4-auth-router", "payload": "login_code → maya", "text": "Maya's login code arrives in the middle of it."},
{"el": "n4-router-cq", "payload": "login code", "text": "The login code type is critical, so it goes to the critical queue. That queue is nearly always empty."},
{"el": "n4-cq-cw", "payload": "login code", "ms": 2, "set": {"otp.waited in queue": "~2ms"}, "text": "A critical worker takes it at once. Critical workers are reserved: they never process bulk work, even when they are idle and the bulk queue is long. Idle capacity is the price of a guarantee."},
{"el": "n4-cw-pp", "payload": "login code", "text": "It goes to the same push provider, over separate connections with their own share of the rate limit."},
{"el": "n4-pp-cw", "payload": "accepted", "ms": 120, "text": "Maya has her code in well under a second. The broadcast and the login code shared the provider, but not a queue."}
]
},
{
"id": "throttled",
"label": "The provider pushes back",
"nodes": ["bw4", "pp4"],
"steps": [
{"el": "n4-bw-pp", "payload": "digest pushes", "text": "Mid-broadcast, the push provider starts rejecting some requests: it is protecting itself from this sender's volume."},
{"el": "n4-pp-bw", "payload": "429 · retry after 10s", "ms": 30, "text": "A 429 with a hint to retry later. Ignoring it — retrying at once, as fast as possible — is how a sender gets its connection throttled for much longer, or blocked."},
{"el": "n4-bw-pp", "payload": "half rate", "text": "Bulk workers halve their token bucket's rate and return the rejected deliveries to the queue with a delay. When requests succeed again, they raise the rate gradually. The broadcast finishes later than planned. That is fine: it's a digest."},
{"el": "n4-pp-bw", "payload": "accepted", "ms": 150, "text": "Critical workers saw none of this. Their share of the limit was never used by the bulk lane."}
]
},
{
"id": "quiet",
"label": "Quiet hours",
"nodes": ["sched4", "bq4"],
"steps": [
{"el": "n4-router-sched", "payload": "price_drop → leo · hold until 08:00", "set": {"otp.waited in queue": "—"}, "text": "A shopping service has sent Leo a price-drop alert. For Leo it is 2:10 in the morning, inside his quiet hours of 22:00 to 08:00. The type is marketing, so quiet hours apply. The router doesn't drop the notification. It hands it to the scheduler, keyed by the minute it is due. A login code at 2:10 would ignore quiet hours: security types are exempt."},
{"el": "n4-sched-bq", "payload": "released at 08:00", "text": "At 08:00 in Leo's time zone, the scheduler releases it into the bulk lane, where it is delivered like any other. If the price drop has ended by then, the type's TTL has expired and it is dropped instead. Broadcasts sent ‘at 9:00 local time’ work the same way: the expander hands each recipient's notification to the scheduler for their own 9:00."}
]
}
]
}
</script>
<div class="diagram-caption">Critical and bulk traffic have separate queues and separate reserved workers, and share only the provider. Broadcasts are expanded at a fixed rate; quiet hours and local-time sends wait in the scheduler. Compare how long the login code waits in the first two flows.</div>
</div>

<div class="fail-hint">Click the scheduler, the broadcast expander, the bulk queue, the critical workers, the bulk workers or the push provider to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="sched4">
<strong>If the scheduler fails:</strong> held notifications aren't released on time, and new ones that need holding can't be stored. Everything else is unaffected. When it returns, it releases everything that came due in the meantime — at a controlled rate, so the backlog doesn't arrive as one burst. Anything that came due long enough ago to be past its TTL is dropped rather than delivered hours late.
</div>
<div class="failure-impact is-hidden" data-component="exp4">
<strong>If the broadcast expander fails:</strong> broadcasts stop partway. The expander records its position in the segment after each page, so a replacement continues from the last page rather than starting again — starting again would send the first part twice. Idempotency keys built from the broadcast ID and user ID catch any overlap.
</div>
<div class="failure-impact is-hidden" data-component="bq4">
<strong>If the bulk queue fails:</strong> marketing and digests stop. Critical and normal lanes don't notice. This is the lane that can most afford to wait, and the one whose failure matters least.
</div>
<div class="failure-impact is-hidden" data-component="cw4">
<strong>If the critical workers fail:</strong> login codes and security alerts stop — the worst outage this system can have. Critical workers run in every zone, are scaled for a multiple of peak, and are deployed separately from bulk workers, so a bad release goes to the bulk lane first. Replay the lanes flow with them failed to see the login code stop. A broadcast doesn't cause this failure, which was the point of the stage.
</div>
<div class="failure-impact is-hidden" data-component="bw4">
<strong>If the bulk workers fail:</strong> broadcasts stall in the bulk queue. Their deliveries have TTLs, so a digest delayed by hours is dropped rather than sent the next morning.
</div>
<div class="failure-impact is-hidden" data-component="pp4">
<strong>If the push provider fails:</strong> both lanes stop, because there is no second push provider for a phone platform. Deliveries wait in their queues and retry with backoff. When the provider recovers, critical queues drain first, and critical deliveries whose TTL passed — a login code from 20 minutes ago — are dropped. Critical types can fall back to another channel: a login code that can't go by push is sent by SMS.
</div>
</div>

### Frequency limits

Lanes stop broadcasts from delaying urgent notifications. They don't stop the product from sending too much. The router enforces per-user limits for each category — for example, at most 3 marketing pushes a day and 1 an hour — with counters that expire. A notification over the limit is dropped and logged as `skipped — frequency`. Critical types have no limit. Without this, each team's broadcast is reasonable on its own, and users receive all of them on the same afternoon.

<!-- stage:5:5. Receipts, Tokens & Inbox -->

## Stage 5 — Receipts, Device Tokens and the Inbox

So far, information has flowed one way: from the system to providers. In this stage it flows back. Providers report what happened to each message: whether an email bounced, whether a push token belongs to an app that was uninstalled, whether someone marked an email as spam. Ignoring these reports has a cost that grows over time. The system keeps paying to send to phones that no longer have the app. And email providers start filtering the product's mail as spam, because it keeps sending to addresses that don't exist.

This stage adds a **webhook receiver** for provider callbacks and a **receipt processor** that updates the delivery log, marks bad device tokens invalid, and adds bad email addresses to a **suppression list** that workers check before sending. It also adds the **in-app inbox**, the one channel this system delivers itself.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 720 370" width="720" height="370" role="img" aria-label="Channel workers checking devices and suppression list before sending to providers; providers calling back to a webhook receiver; a receipt processor updating the delivery log and suppression list; workers writing to an inbox store that the app reads">
  <g data-fail-toggle="dev5">
    <rect x="16" y="40" width="150" height="52" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="91" y="62" text-anchor="middle" class="d-actor-label" font-size="12">Devices &amp; Suppression</text>
    <text x="91" y="79" text-anchor="middle" class="d-label-muted" font-size="9">tokens · blocked addresses</text>
  </g>
  <rect x="16" y="150" width="130" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="81" y="179" text-anchor="middle" class="d-actor-label" font-size="12">Channel Workers</text>
  <rect x="210" y="150" width="140" height="48" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="280" y="171" text-anchor="middle" class="d-actor-label" font-size="12">Providers</text>
  <text x="280" y="187" text-anchor="middle" class="d-label-muted" font-size="9">push · email · SMS</text>
  <g data-fail-toggle="wh5">
    <rect x="400" y="150" width="140" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="470" y="171" text-anchor="middle" class="d-actor-label" font-size="12">Webhook Receiver</text>
    <text x="470" y="187" text-anchor="middle" class="d-label-muted" font-size="9">verifies signatures</text>
  </g>
  <g data-fail-toggle="rp5">
    <rect x="400" y="40" width="140" height="48" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="470" y="69" text-anchor="middle" class="d-actor-label" font-size="12">Receipt Processor</text>
  </g>
  <g data-fail-toggle="dlog5">
    <rect x="580" y="40" width="130" height="48" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="645" y="69" text-anchor="middle" class="d-actor-label" font-size="12">Delivery Log</text>
  </g>
  <g data-fail-toggle="inbox5">
    <rect x="400" y="280" width="140" height="48" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="470" y="301" text-anchor="middle" class="d-actor-label" font-size="12">Inbox Store</text>
    <text x="470" y="317" text-anchor="middle" class="d-label-muted" font-size="9">per user · read marker</text>
  </g>
  <rect x="580" y="280" width="130" height="48" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="645" y="309" text-anchor="middle" class="d-actor-label" font-size="12">Maya's App</text>
  <line id="n5-cw-dev" x1="60" y1="148" x2="60" y2="96" class="d-msg d-request" data-depends-on="dev5" marker-end="url(#arrowN5)"></line>
  <line id="n5-dev-cw" x1="100" y1="96" x2="100" y2="148" class="d-msg d-response" data-depends-on="dev5" marker-end="url(#arrowN5r)"></line>
  <line id="n5-cw-prov" x1="148" y1="166" x2="206" y2="166" class="d-msg d-request" marker-end="url(#arrowN5)"></line>
  <line id="n5-prov-cw" x1="206" y1="182" x2="148" y2="182" class="d-msg d-response" marker-end="url(#arrowN5r)"></line>
  <line id="n5-prov-wh" x1="352" y1="174" x2="396" y2="174" class="d-msg d-request" data-depends-on="wh5" marker-end="url(#arrowN5)"></line>
  <line id="n5-wh-rp" x1="470" y1="148" x2="470" y2="92" class="d-msg d-request" data-depends-on="wh5 rp5" marker-end="url(#arrowN5)"></line>
  <line id="n5-rp-dlog" x1="542" y1="64" x2="576" y2="64" class="d-msg d-request" data-depends-on="rp5 dlog5" marker-end="url(#arrowN5)"></line>
  <line id="n5-rp-dev" x1="398" y1="64" x2="170" y2="64" class="d-msg d-request" data-depends-on="rp5 dev5" marker-end="url(#arrowN5)"></line>
  <line id="n5-cw-inbox" x1="110" y1="200" x2="396" y2="296" class="d-msg d-request" data-depends-on="inbox5" marker-end="url(#arrowN5)"></line>
  <line id="n5-app-inbox" x1="578" y1="296" x2="544" y2="296" class="d-msg d-request" data-depends-on="inbox5" marker-end="url(#arrowN5)"></line>
  <line id="n5-inbox-app" x1="544" y1="312" x2="578" y2="312" class="d-msg d-response" data-depends-on="inbox5" marker-end="url(#arrowN5r)"></line>
  <text x="360" y="358" text-anchor="middle" class="d-label-muted" font-size="10">play the uninstalled app, then the bounce, then the inbox</text>
  <defs>
    <marker id="arrowN5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowN5r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "dev", "title": "Devices & suppression", "rows": [["maya · phone", "active"], ["maya · old tablet", "active"], ["ana@old-job.example", "ok"]]},
{"id": "inbox", "title": "Maya's inbox", "rows": [["items", "47"], ["unread", "2"]]}
],
"flows": [
{
"id": "uninstalled",
"label": "A push to an uninstalled app",
"nodes": ["dev5"],
"steps": [
{"el": "n5-cw-dev", "payload": "maya: active devices", "text": "A push worker has a delivery for Maya and looks up her active devices."},
{"el": "n5-dev-cw", "payload": "phone · old tablet", "ms": 1, "text": "Two. Maya uninstalled the app from her old tablet months ago, but nothing told this system."},
{"el": "n5-cw-prov", "payload": "push × 2", "text": "The worker sends to both tokens."},
{"el": "n5-prov-cw", "payload": "phone ✓ · tablet: unregistered", "ms": 120, "text": "The push provider answers at once: the phone's token is fine, the tablet's token is no longer registered. Push providers report this in the send response, not later."},
{"el": "n5-cw-dev", "payload": "tablet token → invalid", "ms": 1, "set": {"dev.maya · old tablet": "invalid"}, "text": "The worker marks the tablet's token invalid. Future pushes go only to the phone. Across 450 million devices, tokens go stale at a rate of millions a week — uninstalls, new phones, reinstalls that issue new tokens. Senders that keep pushing to dead tokens waste capacity, and providers may throttle them."}
]
},
{
"id": "bounce",
"label": "An email bounces",
"nodes": ["dev5", "wh5", "rp5", "dlog5"],
"steps": [
{"el": "n5-cw-dev", "payload": "is ana@old-job… suppressed?", "set": {"dev.ana@old-job.example": "ok"}, "text": "An email worker has a receipt for Ana, at her old work address. It checks the suppression list first."},
{"el": "n5-dev-cw", "payload": "not suppressed", "ms": 1, "text": "The address isn't on it."},
{"el": "n5-cw-prov", "payload": "send receipt email", "text": "The worker sends the email."},
{"el": "n5-prov-cw", "payload": "queued · id em_771", "ms": 200, "text": "The email provider accepts it. Unlike push, email's outcome isn't known yet: the provider still has to hand it to Ana's old employer's mail server."},
{"el": "n5-prov-wh", "payload": "bounce em_771 · no such user", "text": "A minute later the provider calls back: a hard bounce, meaning the mailbox doesn't exist. The webhook receiver checks the request's signature, so a forged callback can't unsubscribe anyone. It puts the receipt on a queue and answers at once — providers retry callbacks that are slow to answer."},
{"el": "n5-wh-rp", "payload": "receipt", "text": "The receipt processor takes it from the queue."},
{"el": "n5-rp-dlog", "payload": "em_771: bounced", "ms": 2, "text": "It finds the delivery by the provider's message ID and records it as bounced."},
{"el": "n5-rp-dev", "payload": "suppress ana@old-job…", "ms": 2, "set": {"dev.ana@old-job.example": "suppressed — hard bounce"}, "text": "And it adds the address to the suppression list. Every future email to it is skipped before it reaches the provider. This matters beyond one user: mail services judge a sender by its bounce and spam-complaint rates, and a sender with high rates finds all of its email — including other users' password resets — going to spam folders. A spam complaint is handled the same way, by suppressing marketing email for that address."}
]
},
{
"id": "inbox",
"label": "Maya reads her inbox",
"nodes": ["inbox5"],
"steps": [
{"el": "n5-cw-inbox", "payload": "add ‘Ana sent you ₹2,500’", "ms": 2, "set": {"inbox.items": "48", "inbox.unread": "3"}, "text": "The inbox lane's worker writes the payment notification into Maya's inbox partition and increments her unread count. This is the inbox channel: no provider, just a write."},
{"el": "n5-app-inbox", "payload": "GET inbox + unread count", "text": "Maya opens the app on her phone. The bell shows 3."},
{"el": "n5-inbox-app", "payload": "20 newest · 3 unread", "ms": 3, "text": "The first page is one range read of her partition, newest first. If the app holds an open connection to the server, the new item can also be pushed to the screen as it is written ([Real-time Delivery](#/systems/realtime-delivery))."},
{"el": "n5-app-inbox", "payload": "read up_to …9632", "text": "She opens the inbox. The app marks everything up to the newest item as read."},
{"el": "n5-inbox-app", "payload": "unread 0", "ms": 2, "set": {"inbox.unread": "0"}, "text": "One write sets her read marker and resets the count. The read state lives on the server, not on the phone, so her laptop shows 0 next time it checks. To clear the badge on her other devices straight away, the system sends them a silent push that updates the badge without showing anything."}
]
}
]
}
</script>
<div class="diagram-caption">Push providers report dead tokens in the send response; email providers report bounces and complaints later, through signed callbacks. Both are written back into the data that workers check before sending. The inbox is written directly and read by the app.</div>
</div>

<div class="fail-hint">Click the devices and suppression store, the webhook receiver, the receipt processor, the delivery log or the inbox store to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="dev5">
<strong>If the devices and suppression store fails:</strong> workers don't know where to send pushes, or whether an address is suppressed. For push there is no safe default, so push deliveries wait. For email, sending without the suppression check would mail people who unsubscribed, which is illegal for marketing in many countries — so marketing email waits too, while critical email can be sent using a short-lived local copy of the suppression list that each worker keeps.
</div>
<div class="failure-impact is-hidden" data-component="wh5">
<strong>If the webhook receiver fails:</strong> provider callbacks fail. Providers retry them for hours, so a short outage loses nothing. A long one leaves delivery statuses stale and lets bounced addresses keep receiving mail. The receiver only checks signatures and queues, so it rarely fails for any reason except load. Replay the bounce with it failed to see the callback stop.
</div>
<div class="failure-impact is-hidden" data-component="rp5">
<strong>If the receipt processor fails:</strong> callbacks are queued but not processed. Sending is unaffected. Receipts are applied when it returns; processing them is idempotent, so a receipt applied twice changes nothing.
</div>
<div class="failure-impact is-hidden" data-component="dlog5">
<strong>If the delivery log fails:</strong> receipts can't be matched to deliveries, and support can't see statuses. Suppression and token updates don't depend on the log, so they continue. The receipt processor holds unmatched receipts and retries them.
</div>
<div class="failure-impact is-hidden" data-component="inbox5">
<strong>If the inbox store fails:</strong> the inbox shows an error and new inbox items wait in the inbox queue. Push and email are unaffected — Maya still gets her phone notification, she just can't see it in the app's list. The inbox store is replicated and partitioned by user ([Partitioning & Sharding](#/systems/partitioning-sharding)).
</div>
</div>

This is the full design. Services hand the system an event with an idempotency key and get an answer in milliseconds. A router applies preferences, quiet hours and frequency limits, renders the text, and splits the event into one delivery per channel and device, in a lane chosen by priority. Workers claim each delivery, send it through a rate-limited connection with the delivery ID as the provider's idempotency key, and retry with backoff until the delivery's TTL. Providers' answers and callbacks flow back into the device list and suppression list, so each failure makes the next send better aimed. The notification store and delivery log are the record of what was promised and what happened; the queues only hand out the work.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### Delivery guarantees, channel by channel

| | Push | Email | SMS | Inbox |
|---|---|---|---|---|
| Outcome known | At send, mostly | Minutes later, by callback | Seconds to minutes, by callback | At write |
| Provider deduplication | Partial (collapse IDs) | Rarely | Some providers | Not needed: a keyed write |
| Duplicate cost | Annoyance | Annoyance | Money, and trust | None: the key overwrites |
| Retry window | Minutes | Hours | Minutes | Until the store is back |

"Delivered" means different things per channel. A push provider accepting a message means it will try to reach the phone, not that it did — a phone that is off receives it when it comes back on, if the message hasn't expired. An email accepted by the recipient's mail server may still go to a spam folder. The delivery log records what each channel can actually report, and nothing more.

### Collapsing and digests

"Leo liked your post", "Ana liked your post", "Sam liked your post" — three notifications in a minute, or one? Social notifications are better grouped. Two techniques:

- **Collapse keys.** The push provider replaces an undelivered notification with a newer one that has the same collapse key, and the phone shows only the latest. "12 people liked your post" replaces "11 people liked your post". This is free, but only works while the earlier one is still undelivered.
- **Aggregation windows.** The router holds social notifications for a short window — a minute, say — keyed by user and post, then sends one notification summarizing everything in the window. This uses the scheduler from Stage 4. The cost is a minute's delay, which is acceptable for a like and not for a login code; critical types never wait.

Daily or weekly digests are the same idea with a longer window and a different template.

### Fallback between channels

Some notifications must arrive by some route. A login code is sent by push if the user has an active device with notifications on; if the push isn't confirmed delivered within 30 seconds, the router sends the same code by SMS. The type defines the order and the timeout. Fallback trades money for reliability, so it is limited to types where failure has a real cost, and suppressed if the user has already used the code.

### Templates and localization

Templates are versioned, and each notification records the version it was rendered with, so support can see exactly what a user received. Rendering happens in the router, not the worker: a retried delivery sends the same text as the first attempt, even if the template was edited in between. Every value inserted into a template is escaped for its channel — HTML for email, plain text for push and SMS — and templates are rendered with a missing-value check, because "Hi {{first_name}}" sent to a million people is a very visible bug.

### Sending at 9:00 local time

A broadcast "at 9:00 local time" isn't one send; it is 24-plus sends, one as each time zone reaches 9:00. The expander groups the segment by time zone and hands each group to the scheduler for its own 9:00. That also spreads the broadcast over a day instead of concentrating it, which smooths the load on the bulk lane. Users whose time zone is unknown are assigned one from their country or recent activity, and as a last resort get the sender's default.

### Ordering

The system doesn't guarantee that notifications arrive in the order they were sent. "Your order has shipped" can arrive before "Your order is confirmed" if the second was retried once. Global ordering would need every notification for a user through one queue partition, in sequence, with retries blocking everything behind them. Instead, ordering is handled where it matters: notifications that supersede each other share a collapse key, so the newest replaces the older, and types carry enough context to make sense alone.

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### Providers set the speed limit

Every channel except the inbox ends at a provider whose limits this system doesn't control: requests per second per connection, messages per second per sender number, daily volume per sending domain. Capacity planning starts with those limits, not with worker count. Adding workers past a provider's limit only produces more 429s. Large broadcasts are planned around them, and a new email domain has to be "warmed up" — its volume raised gradually over weeks — before mail services trust it at full rate.

### Reserved capacity sits idle

Critical workers and their share of provider rate limits are reserved, so they are idle most of the time while the bulk lane may be backed up. Letting the bulk lane borrow idle critical capacity would make broadcasts faster, and would bring back exactly the problem Stage 4 solved the first time a login spike arrived during a borrowed moment. The idle capacity is the guarantee.

### Duplicates aren't fully eliminated

With idempotent providers, duplicates need a crash at a specific moment and a provider that ignores keys. Without them, the at-least-once types will sometimes send twice. The design narrows the window and makes the choice explicit per type; it doesn't make the window disappear. Measuring the duplicate rate — by sampling deliveries with the same delivery ID that reached the provider twice — is the only way to know whether it is small enough.

### The router is a shared dependency for every team

Every notification in the product passes through one routing layer and one set of type definitions. That central control is the design's main advantage, and also its main risk: a bad template, a wrong priority, or a misconfigured segment affects everyone. Type and template changes go through review, roll out gradually, and every type and broadcast has a kill switch that workers check before each send.

### The delivery log is large

Several writes per delivery — pending, sending, sent, delivered — at 2 billion deliveries a day makes the delivery log the largest write workload in the system. Keeping only 30 days online, writing status changes as appends rather than read-modify-write updates where possible, and sampling the "delivered" receipts for high-volume, low-value types keep it manageable. Older records go to cheap storage for analytics.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

A notification system can reach every user's phone, mailbox and lock screen in the product's own name. That makes it valuable to attackers in ways that have little to do with the system's internals ([Security & Authentication](#/systems/security-authentication)).

### SMS pumping

Attackers trigger SMS sends — usually login codes or sign-up verification — to premium-rate or attacker-controlled numbers, and take a share of what the product pays per message. It shows up as a sudden rise in SMS to unusual country codes or number ranges, often with no completed sign-ins. Defenses: rate limits on code requests per phone number, per number prefix, per IP and per country; a challenge before sending a code to a new number; allowing SMS only to countries where the product has users; and a per-hour SMS spend alert that pages someone ([Rate Limiter as a Service](#/systems-case-studies/rate-limiter)).

### Internal callers are not all equal

Each notification type is owned by one service, and only that service may send it. The API authenticates callers with service credentials and checks the type's owner. Without this, a compromised or buggy internal service could send "Your account has been suspended — sign in here" to every user, with the product's name on it. Broadcast types require a second approval to send to more than a set number of users.

### Template data is untrusted

The data a caller supplies often contains text written by users: a display name, a comment. Inserted into an email template without escaping, a display name containing HTML becomes part of the email. Every value is escaped for its channel, links in templates must point to the product's own domains, and user-supplied text is length-limited and stripped of anything that looks like a link.

### Lock screens are public

A push notification is often visible on a locked phone, to anyone nearby. Sensitive types — login codes, balances, health or message content — use templates that say less on the lock screen ("You have a new message") and show the detail only inside the app. Login code pushes carry the code but not the account it belongs to.

### Callbacks and unsubscribe links can be forged

A forged bounce or complaint callback could suppress any user's email, including their password resets. Webhooks are accepted only with a valid provider signature. Unsubscribe tokens are signed with a server key, name a single user and category, and can't be edited to unsubscribe someone else.

### Notifications can confirm that an account exists

"If an account exists for this address, we've sent a reset link" only protects anyone if the response is identical either way — including how long it takes. The API returns before sending, so timing doesn't reveal whether the address was found.

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **End-to-end time** from acceptance to provider handoff, per lane and channel, at p50 and p99. The critical lane's p99 is the system's most important number.
- **Queue depth and oldest message age** per lane and channel.
- **Provider health:** error rate, latency and 429 rate per provider.
- **Delivery outcomes** per type and channel: sent, delivered, failed, skipped — with skip reasons (preference, quiet hours, frequency, suppressed, expired).
- **Email reputation:** bounce and complaint rates per sending domain.
- **Invalid push tokens** per day, and the share of sends to tokens later found invalid.
- **SMS volume and spend** per hour and per destination country.
- **Duplicate rate**, sampled, and **dead-letter volume** per type.

### What to alert on

- Critical-lane p99 above **5 seconds**, or its oldest message older than 10 seconds.
- Any provider's error rate above 5% for 2 minutes.
- Email complaint rate above about **0.1%** or hard bounce rate above about 2% — thresholds mail services act on.
- SMS spend per hour above twice its usual level, or SMS to a country that normally receives almost none — the signature of SMS pumping.
- Dead-letter queue growing for any critical type.
- Notifications ‘accepted’ for over a minute without being routed: the sweeper exists, but should rarely have work.

### An email provider is down — what happens?

Email deliveries fail and go back to their queues with backoff. Nothing is lost and nothing else slows down. If the error rate stays above the failover threshold, workers switch to the secondary provider; check that it happened and that the secondary's rate limit can absorb the load. When the primary recovers, switch back gradually. Deliveries whose outcome at the failed provider is unknown are not resent through the secondary unless their type allows duplicates.

### A broadcast went out wrong — what happens?

A broken template or the wrong segment is noticed minutes after the broadcast starts, usually from complaints. Flip the broadcast's kill switch: workers check it before each send, so sending stops within seconds, and the expander stops creating new deliveries. Deliveries already queued are dropped as workers reach them. Because the expander paces the broadcast, most of the segment hasn't been sent yet — pacing is also what makes a mistake recoverable. Any correction is a new broadcast, with a new ID, to the users the delivery log shows actually received the first.

### Login codes are late — what happens?

Check the critical lane's queue depth first. If it's deep, critical workers are short — scale them out; they share no queue with anything else. If the queue is empty but end-to-end time is high, the delay is at the provider: check its latency and 429 rate on the critical connections. If push is failing, confirm the SMS fallback is firing, and watch SMS spend while it does.
