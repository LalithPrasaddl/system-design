# Ticket Booking

A ticket booking system sells seats for an event. The tickets go on sale at a set time, to far more people than there are seats. A shoe in a warehouse is one of many identical units, but a seat is one particular place, Section 112, Row F, Seat 21, and every fan who wants it wants that one, not any seat. A group of four wants four seats next to each other, or none. And most of the people buying arrive in the same minute. This case study builds booking for one stadium concert: 50,000 seats, two million fans in line when sales open at 10:00, sold out within minutes. No seat is ever sold twice.

<!-- tab:requirements:Requirements -->

## Requirements

This case study builds the booking system for a ticketing platform that sells reserved seats for concerts and sports events. The running example is one stadium concert: 50,000 seats, on sale at 10:00 on a Friday. Payments go through the payment service from the [Payment Processing](#/systems-case-studies/payment-processing) case study, which this design calls but doesn't rebuild.

### Functional requirements

- **Show the seat map**: which seats are free in each section, with their prices.
- **Pick seats or ask for the best available**: a fan either clicks the seats they want, or asks for "the best 4 seats together in the floor sections under $250" and is given some.
- **Hold seats while the fan pays**, for a fixed time, so no one else can buy them.
- **Sell the seats** once payment succeeds, and issue a ticket for each one.
- **Release seats** from holds that run out or are abandoned, so they go back on sale.
- **Run a waiting room** for a popular on-sale: fans wait in line and are let in to buy a few at a time.
- **Limit tickets per fan**: at most 4 for this event.

### Non-functional requirements

- **Correctness:** a seat is sold to at most one fan. A group's seats are held together or not at all.
- **Fairness:** a fan's place in line doesn't depend on who refreshed fastest or ran the most scripts.
- **Latency:** holding seats under 200ms at p99, even when thousands of fans want the same section.
- **Availability:** 99.95% during an on-sale. A failure may slow the sale down. It must never sell a seat twice.
- **Freshness:** the seat map may be a second or two out of date. The hold is always checked against the real seat.
- **Scale:** 2 million fans in line, the whole event sold out in about 10 minutes.

### In scope

Holding and selling individual seats, holding groups of seats all-or-nothing, the seat map, best-available selection, the waiting room and who gets let in, and handling the rush for the best seats.

### Out of scope

**Event setup and venue maps**: the seats, sections and prices are given. **How payments work**: covered in Payment Processing. **Resale between fans.** **Scanning tickets at the gate**, beyond how a ticket is issued. **General admission** standing areas, which are a count rather than seats and are handled like a product's stock in [E-commerce Checkout & Inventory](#/systems-case-studies/checkout-inventory).

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

The whole event is small: 50,000 seats is 5MB of data. What shapes the design is how many fans want those seats at once, and how many want the same few hundred of them.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Seats</div>
<div class="stat-tile-value">50<span class="stat-tile-unit">K</span></div>
<div class="stat-tile-sub">62 sections · ~5MB in all</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Fans in line</div>
<div class="stat-tile-value">~2<span class="stat-tile-unit">M</span></div>
<div class="stat-tile-sub">40 for every seat</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Orders to sell out</div>
<div class="stat-tile-value">~20<span class="stat-tile-unit">K</span></div>
<div class="stat-tile-sub">2.5 tickets per order</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Seat map reads</div>
<div class="stat-tile-value">~400<span class="stat-tile-unit">K/s</span></div>
<div class="stat-tile-sub">if every fan in line had it open</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Hold requests</div>
<div class="stat-tile-value">~33<span class="stat-tile-unit">K/s</span></div>
<div class="stat-tile-sub">if every fan were let in at 10:00</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">One floor section</div>
<div class="stat-tile-value">~200<span class="stat-tile-unit">req</span></div>
<div class="stat-tile-sub">for its best seats, in the first second</div>
</div>
</div>

### Assumptions

- One stadium concert with **50,000** seats in **62** sections. The four floor sections, FLR-A to FLR-D, hold **1,000** seats each.
- **2 million** fans join the line; **1.4 million** of them arrive in the 15 minutes before 10:00.
- At most **4** tickets per fan. An order averages **2.5** tickets.
- About **1 in 3** fans let in to buy leaves without buying: nothing at their price, a declined card, or they give up.
- A fan with the seat map open refreshes it about every **5 seconds**.
- About **40%** of fans let in go for the floor first.
- A committed update takes about **2ms**, including a synchronous replica in another zone.
- A hold lasts **8 minutes**.

### Orders and shoppers

50,000 seats at 2.5 tickets an order is about **20,000 orders** to sell out. With 1 in 3 fans leaving without buying, about **30,000 fans** need to be let in to buy before every seat is gone. The other 1.97 million will not get a ticket, and most of the design's work is telling them so quickly and fairly.

### The seat map

If all 2 million fans in line had the seat map open, refreshing every 5 seconds, that would be **400,000 reads a second**. A seat map sent as one JSON document, about 20 bytes a seat, is 1MB, so that's 400GB a second. Sent as one bit per seat for each section, a section of 800 seats is 100 bytes. The map has to be small, cacheable, and shown only to fans who can actually buy.

### Holds

Let in all at once, 2 million fans arriving in the first minute would send about **33,000 hold requests a second** for 50,000 seats, most of them for the same few hundred best seats. Let in 30,000 at a time instead, they make about 2 hold attempts each.

### The best seats

If the first 2,000 fans are let in at 10:00:00 and 40% go for the floor, that's 800 requests in the first second across four floor sections: about **200 for each**, all wanting the same front rows. The database can easily take 200 updates a second in total. What it can't do is give 200 fans the same "best four seats" and have them all succeed.

<!-- tab:api-design:API Design -->

## API Design

Fans call the booking API through the platform's site and apps. Prices are integers in the currency's smallest unit, as in Payment Processing. Seats are named section, row and number: `112-F-21`.

### Waiting room

```
POST /v1/events/ev_77/line
→ 201 {"line_id": "ln_9k2", "status": "waiting", "position": 48211, "of": 1400000}

GET /v1/lines/ln_9k2
→ 200 {"status": "waiting", "position": 31870}
→ 200 {"status": "admitted", "token": "eyJldiI6…", "shop_until": "10:14:00"}
→ 200 {"status": "sold_out"}
```

### Seat map

```
GET /v1/events/ev_77/seatmap
→ 200 {"sections": [{"id": "112", "tier": "B", "price": 15000,
                     "map": "https://cdn…/ev_77/112.v8812.bin", "free": 214}, …]}
```

### Holds and orders

```
POST /v1/events/ev_77/holds
Authorization: Bearer <admission token>
Idempotency-Key: hk_c71_3
{"seats": ["112-F-21", "112-F-22", "112-F-23", "112-F-24"]}
  or
{"best_available": {"qty": 4, "sections": ["FLR-A", "FLR-B"], "max_price": 25000}}
→ 201 {"hold_id": "ord_4410", "seats": ["112-F-21", …], "total": 60000,
       "expires_at": "10:08:12"}
→ 409 {"error": "seats_taken", "taken": ["112-F-23"], "section_version": 8813}
→ 409 {"error": "none_available", "sections": ["FLR-A", "FLR-B"]}
→ 403 {"error": "not_admitted"}

DELETE /v1/holds/ord_4410                                   → 204, also if already gone

POST /v1/orders/ord_4410/pay
Idempotency-Key: hk_c71_3
{"payment_method": "tok_8Hq"}
→ 201 {"order_id": "ord_4410", "status": "confirmed", "tickets": ["tk_…", …]}
→ 402 {"status": "held", "decline_code": "insufficient_funds"}   try another card
→ 410 {"error": "hold_lost"}                                       seats taken after expiry
```

| Code | Meaning |
|---|---|
| `200` | Done |
| `201` | Created: joined the line, seats held, order confirmed |
| `204` | Hold released |
| `402` | Payment declined: the seats stay held until the hold expires |
| `403` | No valid admission token for an event with a waiting room |
| `409` | The seats asked for are taken, or none fit the request |
| `410` | The hold expired and its seats have been taken by someone else |
| `422` | More than the per-fan limit, or a key reused with a different request |
| `429` | Over the caller's request rate |

### Why the details matter

**A hold names every seat, or none.** The request either holds all four seats or holds nothing. A fan is never left with three seats together and one somewhere else.

**`409` says which seats were taken.** The fan's map was a second or two old. The response names the seats that went and the section's current version, so the app can redraw the section without reloading the page.

**`best_available` lets the server choose.** Thousands of fans looking at the same map would all click the same seats. Asked for "the best 4", the server gives each fan different ones.

**The order ID is the hold ID.** Holding, paying and releasing all name the order. A retried hold with the same key finds the same hold rather than holding four more seats.

**`410` only when the seats are actually gone.** A hold that has passed its expiry but whose seats nobody has taken can still be paid for.

**The admission token is checked on every hold.** A fan who skips the line has no token and gets `403`.

<!-- tab:data-model:Data Model -->

## Data Model

One relational database per event holds that event's seats, holds, orders and tickets. Different events are in different databases, so a busy on-sale never slows another event down. The line lives in an in-memory store, since it's large, short-lived and rebuilt for every on-sale.

### Seats and holds

```
seats                                     -- one row per seat
  seat_id          TEXT                   -- 112-F-21
  section          TEXT                   -- 112
  row              TEXT                   -- F
  number           SMALLINT               -- 21
  tier             TEXT                   -- B
  price            BIGINT                 -- 15000
  score            INT                    -- how good the seat is: lower is better
  status           TEXT                   -- available | held | sold
  hold_id          TEXT                   -- ord_4410 while held or sold
  hold_expires_at  TIMESTAMP
  PRIMARY KEY (seat_id)
  INDEX (section, status, score)

holds
  hold_id          TEXT PRIMARY KEY       -- ord_4410, also the order ID
  fan_id           TEXT
  seats            TEXT[]
  expires_at       TIMESTAMP
  status           TEXT                   -- held | paid | released

fan_tickets                               -- the per-fan limit
  fan_id           TEXT PRIMARY KEY
  sold             SMALLINT               -- tickets paid for
  active_hold      TEXT                   -- at most one hold at a time
  CHECK (sold <= 4)

section_owners                            -- from Stage 5
  section          TEXT PRIMARY KEY       -- FLR-A
  owner            TEXT                   -- allocator-1
  epoch            BIGINT                 -- 7, raised on every change of owner
  lease_until      TIMESTAMP
```

### Orders and tickets

```
orders
  order_id         TEXT PRIMARY KEY       -- ord_4410
  fan_id           TEXT
  status           TEXT                   -- held | confirmed | cancelled
  total            BIGINT
  payment_id       TEXT                   -- from the payment service

tickets
  ticket_id        TEXT PRIMARY KEY       -- tk_…
  order_id         TEXT
  seat_id          TEXT
  barcode_secret   BYTEA                  -- seeds the rotating barcode
  UNIQUE (seat_id)                        -- one ticket per seat, whatever else goes wrong
```

### The line

```
line:ev_77            sorted set   line_id → rank         -- random for early arrivals
line_status:ln_9k2    hash         status, fan_id, token, joined_at
```

### Why this storage

Every rule that stops a seat being sold twice is a database guarantee: a conditional update that only takes seats that are free, all of a group's seats in one transaction, and a unique constraint on tickets that refuses a second ticket for any seat even if every other check had a bug. That needs a relational database with real transactions ([Relational Databases](#/systems/databases-relational)). An event's 50,000 seats are about 5MB, so one primary holds them all in memory, with a synchronous replica in another zone ([Replication](#/systems/replication)). The line is 2 million entries of a few dozen bytes, about 100MB, kept in an in-memory store with a replica: losing it would be bad, but it lives for an hour and holds no money.

<!-- tab:architecture:Architecture:default -->

This case study builds ticket booking up in five stages. Each stage fixes a specific failure of the one before. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one request at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. Check, Then Book -->

## Stage 1 — Check the Seats, Then Book Them

The simplest booking site shows the seat map, lets the fan click seats, and when they pay, checks that the seats are still free, charges the card, and marks the seats sold. Everything is in one database.

```
free = db.query("SELECT seat_id FROM seats WHERE seat_id IN (…) AND status = 'available'")
if len(free) == len(wanted):
    payments.charge(30000, "tok_8Hq")                                       ~600ms
    db.exec("UPDATE seats SET status = 'sold', order_id = %s WHERE seat_id IN (…)", …)
```

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 780 310" width="780" height="310" role="img" aria-label="A fan books through an app server, which checks the seats in the event database, charges through the payment service, then marks the seats sold">
  <rect x="20" y="130" width="140" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="156" text-anchor="middle" class="d-actor-label" font-size="12">Fan</text>
  <text x="90" y="173" text-anchor="middle" class="d-label-muted" font-size="9">browser</text>
  <g data-fail-toggle="app1">
    <rect x="260" y="105" width="180" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="350" y="134" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
    <text x="350" y="152" text-anchor="middle" class="d-label-muted" font-size="9">checks the seats are free</text>
    <text x="350" y="167" text-anchor="middle" class="d-label-muted" font-size="9">charges · marks them sold</text>
  </g>
  <g data-fail-toggle="pay1">
    <rect x="580" y="25" width="180" height="64" rx="6" class="d-actor-box"></rect>
    <text x="670" y="52" text-anchor="middle" class="d-actor-label" font-size="12">Payment Service</text>
    <text x="670" y="69" text-anchor="middle" class="d-label-muted" font-size="9">charges the card</text>
  </g>
  <g data-fail-toggle="db1">
    <rect x="580" y="200" width="180" height="80" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="670" y="228" text-anchor="middle" class="d-actor-label" font-size="12">Event DB</text>
    <text x="670" y="246" text-anchor="middle" class="d-label-muted" font-size="9">seats · orders</text>
    <text x="670" y="261" text-anchor="middle" class="d-label-muted" font-size="9">one status per seat</text>
  </g>
  <line id="t1-f-app" x1="162" y1="148" x2="256" y2="148" class="d-msg d-request" data-depends-on="app1" marker-end="url(#arrowT1)"></line>
  <line id="t1-app-f" x1="256" y1="175" x2="162" y2="175" class="d-msg d-response" data-depends-on="app1" marker-end="url(#arrowT1r)"></line>
  <line id="t1-app-pay" x1="442" y1="125" x2="576" y2="60" class="d-msg d-request" data-depends-on="app1 pay1" marker-end="url(#arrowT1)"></line>
  <line id="t1-pay-app" x1="576" y1="78" x2="442" y2="142" class="d-msg d-response" data-depends-on="app1 pay1" marker-end="url(#arrowT1r)"></line>
  <line id="t1-app-db" x1="442" y1="165" x2="576" y2="215" class="d-msg d-request" data-depends-on="app1 db1" marker-end="url(#arrowT1)"></line>
  <line id="t1-db-app" x1="576" y1="232" x2="442" y2="185" class="d-msg d-response" data-depends-on="app1 db1" marker-end="url(#arrowT1r)"></line>
  <text x="390" y="302" text-anchor="middle" class="d-label-muted" font-size="10">play a normal booking, then two fans for one seat, then a group's seats going while they pay</text>
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
{"id": "row", "title": "Section 112 · row F", "rows": [["F-21", "—"], ["F-22", "—"], ["F-23", "—"], ["F-24", "—"]]},
{"id": "tk", "title": "Tickets", "rows": [["fan 1", "—"], ["fan 2", "—"]]}
],
"flows": [
{
"id": "normal",
"label": "Book two seats",
"nodes": ["app1", "pay1", "db1"],
"steps": [
{"el": "t1-f-app", "payload": "Pay for 112-F-21, F-22 · $300", "set": {"row.F-21": "available", "row.F-22": "available", "row.F-23": "available", "row.F-24": "available", "tk.fan 1": "—", "tk.fan 2": "—"}, "text": "A fan has picked two seats on the map, 112-F-21 and F-22, at $150 each, and clicks Pay."},
{"el": "t1-app-db", "payload": "SELECT … status = 'available' · F-21, F-22", "text": "The app server checks both seats are still free."},
{"el": "t1-db-app", "payload": "F-21 · F-22", "ms": 2, "text": "Both are."},
{"el": "t1-app-pay", "payload": "charge $300 · ord_4410", "text": "It charges the card."},
{"el": "t1-pay-app", "payload": "succeeded", "ms": 600, "text": "The charge succeeds, after about 600ms at the card processor and the bank."},
{"el": "t1-app-db", "payload": "F-21, F-22 → sold · ord_4410", "set": {"row.F-21": "sold · ord_4410", "row.F-22": "sold · ord_4410"}, "text": "It marks both seats sold to the order."},
{"el": "t1-db-app", "payload": "ok", "ms": 3, "text": "Saved."},
{"el": "t1-app-f", "payload": "2 tickets", "set": {"tk.fan 1": "F-21 · F-22"}, "text": "The fan gets two tickets. With one fan at a time, this works."}
]
},
{
"id": "race",
"label": "Two fans, one seat",
"nodes": ["app1", "pay1", "db1"],
"steps": [
{"el": "t1-f-app", "payload": "2 × Pay for 112-F-21 · 30ms apart", "set": {"row.F-21": "available", "row.F-22": "sold", "row.F-23": "sold", "row.F-24": "sold", "tk.fan 1": "—", "tk.fan 2": "—"}, "text": "Two fans click Pay for the same seat, 112-F-21, 30 milliseconds apart. Their requests reach two app servers running the same code."},
{"el": "t1-app-db", "payload": "2 × SELECT … F-21 available?", "text": "Each checks whether the seat is free."},
{"el": "t1-db-app", "payload": "yes · yes", "ms": 2, "text": "Both are told yes. Neither has written anything yet."},
{"el": "t1-app-pay", "payload": "2 × charge $150", "text": "Both charge their fan's card."},
{"el": "t1-pay-app", "payload": "succeeded · succeeded", "ms": 600, "text": "Both charges succeed. The gap between checking the seat and marking it sold is the whole 600ms of the payment."},
{"el": "t1-app-db", "payload": "F-21 → sold · ord_4410 · F-21 → sold · ord_4411", "set": {"row.F-21": "sold · ord_4411"}, "text": "Both mark the seat sold. The second write replaces the first, so the database says ord_4411 has it."},
{"el": "t1-app-f", "payload": "Ticket for F-21 · Ticket for F-21", "set": {"tk.fan 1": "F-21", "tk.fan 2": "F-21"}, "text": "Both fans get a ticket for 112-F-21. On the night, two people turn up for one seat, and the one whose order isn't in the database is turned away at the gate. In a quiet week this is rare. At 10:00 on sale day, with thousands of fans clicking the same seats during each other's payments, it happens constantly."}
]
},
{
"id": "group",
"label": "A group's seats go while they pay",
"nodes": ["app1", "pay1", "db1"],
"steps": [
{"el": "t1-f-app", "payload": "Open the map · section 112", "set": {"row.F-21": "available", "row.F-22": "available", "row.F-23": "available", "row.F-24": "available", "tk.fan 1": "—", "tk.fan 2": "—"}, "text": "A fan buying for four friends opens section 112 and sees F-21 to F-24 free, side by side."},
{"el": "t1-app-f", "payload": "F-21 … F-24 free", "text": "They select all four and go to the payment page. Nothing about the seats has changed in the database: they're just the four the fan has clicked."},
{"el": "t1-f-app", "payload": "(fan 2) Pay for 112-F-23", "set": {"row.F-23": "sold · ord_4411", "tk.fan 2": "F-23"}, "text": "While the first fan types their card number, a second fan buys F-23 alone, and gets it: the seat was free when they paid."},
{"el": "t1-f-app", "payload": "Pay for F-21 … F-24 · $600", "text": "Three minutes after choosing, the first fan clicks Pay."},
{"el": "t1-app-db", "payload": "SELECT … F-21 … F-24 available?", "text": "The app server checks all four."},
{"el": "t1-db-app", "payload": "F-21 · F-22 · F-24", "ms": 2, "text": "Only three are free. F-23 is gone."},
{"el": "t1-app-f", "payload": "Sorry — one of your seats was taken", "text": "The fan is sent back to the map, after filling in everything, to find four seats together again, which by now may not exist anywhere in the section. Seats are only taken at the very last moment, so nothing is set aside for the minutes a fan spends paying. A fan needs their seats kept for them, all four or none, from the moment they choose them."}
]
}
]
}
</script>
<div class="diagram-caption">The app server checks the seats are free, charges the card, then marks the seats sold. The check and the write are separate steps, 600ms apart, and nothing is set aside while the fan is paying.</div>
</div>

<div class="fail-hint">Click the app server, the payment service or the event DB to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="app1">
<strong>If the app server fails:</strong> a booking caught between the charge and the write leaves a fan charged for seats that are still marked available, and can be sold again.
</div>
<div class="failure-impact is-hidden" data-component="pay1">
<strong>If the payment service fails:</strong> nothing can be booked. The seats are untouched, because nothing is written until the charge succeeds.
</div>
<div class="failure-impact is-hidden" data-component="db1">
<strong>If the event DB fails:</strong> booking stops, and any fan already charged can't be recorded.
</div>
</div>

Stage 1 sells seats twice and breaks up groups, and both come from the same place: checking a seat and taking it are separate steps, with a payment in between. Taking the seats has to happen first, as one step that either gets every seat or none, and the seats have to stay taken while the fan pays.

<!-- stage:2:2. All-or-Nothing Holds -->

## Stage 2 — Holds That Take Every Seat or None

- **Choosing seats holds them.** When a fan chooses seats, a booking service holds them for 8 minutes, before the payment page opens.
- **One statement checks and takes.** `UPDATE seats SET status = 'held', hold_id = 'ord_4410', hold_expires_at = now() + 8 min WHERE seat_id IN (…4 seats…) AND (status = 'available' OR (status = 'held' AND hold_expires_at < now()))`. The database checks each seat's condition under that seat's lock.
- **All or nothing.** If fewer rows change than seats were asked for, the transaction is rolled back and nothing is held. The fan is told which seats were taken.
- **Seats are locked in seat ID order.** Two fans after overlapping groups always lock their shared seats in the same order, so one waits for the other instead of each holding a seat the other needs.
- **Expiry needs no clean-up job.** An expired hold is a seat the next fan's condition is allowed to take. Until someone does, the seat still belongs to the hold.
- **Payment authorizes, then sells.** The booking service authorizes the card, then marks the seats sold `WHERE hold_id = 'ord_4410' AND status = 'held'`, then captures the payment. If the seats are gone, it voids the authorization and the fan is never charged.
- **One ticket per seat**, enforced by a unique constraint on the tickets table, whatever else goes wrong.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 780 310" width="780" height="310" role="img" aria-label="A fan holds seats through the booking service, which holds them all-or-nothing in the event database, then authorizes the payment and marks the held seats sold">
  <rect x="20" y="130" width="140" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="156" text-anchor="middle" class="d-actor-label" font-size="12">Fan</text>
  <text x="90" y="173" text-anchor="middle" class="d-label-muted" font-size="9">browser</text>
  <g data-fail-toggle="bk2">
    <rect x="260" y="105" width="180" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="350" y="134" text-anchor="middle" class="d-actor-label" font-size="12">Booking Service</text>
    <text x="350" y="152" text-anchor="middle" class="d-label-muted" font-size="9">holds all seats or none</text>
    <text x="350" y="167" text-anchor="middle" class="d-label-muted" font-size="9">authorize · sell · capture</text>
  </g>
  <g data-fail-toggle="pay2">
    <rect x="580" y="25" width="180" height="64" rx="6" class="d-actor-box"></rect>
    <text x="670" y="52" text-anchor="middle" class="d-actor-label" font-size="12">Payment Service</text>
    <text x="670" y="69" text-anchor="middle" class="d-label-muted" font-size="9">authorize · capture · void</text>
  </g>
  <g data-fail-toggle="db2">
    <rect x="580" y="200" width="180" height="80" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="670" y="228" text-anchor="middle" class="d-actor-label" font-size="12">Event DB</text>
    <text x="670" y="246" text-anchor="middle" class="d-label-muted" font-size="9">seats · holds · orders</text>
    <text x="670" y="261" text-anchor="middle" class="d-label-muted" font-size="9">tickets: one per seat</text>
  </g>
  <line id="t2-f-bk" x1="162" y1="148" x2="256" y2="148" class="d-msg d-request" data-depends-on="bk2" marker-end="url(#arrowT2)"></line>
  <line id="t2-bk-f" x1="256" y1="175" x2="162" y2="175" class="d-msg d-response" data-depends-on="bk2" marker-end="url(#arrowT2r)"></line>
  <line id="t2-bk-pay" x1="442" y1="125" x2="576" y2="60" class="d-msg d-request" data-depends-on="bk2 pay2" marker-end="url(#arrowT2)"></line>
  <line id="t2-pay-bk" x1="576" y1="78" x2="442" y2="142" class="d-msg d-response" data-depends-on="bk2 pay2" marker-end="url(#arrowT2r)"></line>
  <line id="t2-bk-db" x1="442" y1="165" x2="576" y2="215" class="d-msg d-request" data-depends-on="bk2 db2" marker-end="url(#arrowT2)"></line>
  <line id="t2-db-bk" x1="576" y1="232" x2="442" y2="185" class="d-msg d-response" data-depends-on="bk2 db2" marker-end="url(#arrowT2r)"></line>
  <text x="390" y="302" text-anchor="middle" class="d-label-muted" font-size="10">play a group held and paid for, then two overlapping groups, then a hold that runs out</text>
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
{"id": "row", "title": "Section 112 · row F", "rows": [["F-21 … F-22", "—"], ["F-23 … F-24", "—"], ["F-25 … F-26", "—"]]},
{"id": "fan", "title": "Fans", "rows": [["fan 1 · ord_4410", "—"], ["fan 2 · ord_4411", "—"]]}
],
"flows": [
{
"id": "hold-pay",
"label": "Hold four seats, then pay",
"nodes": ["bk2", "pay2", "db2"],
"steps": [
{"el": "t2-f-bk", "payload": "Hold 112-F-21 … F-24", "set": {"row.F-21 … F-22": "available", "row.F-23 … F-24": "available", "row.F-25 … F-26": "available", "fan.fan 1 · ord_4410": "choosing", "fan.fan 2 · ord_4411": "—"}, "text": "A fan buying for a group selects four seats together, 112-F-21 to F-24, and clicks Continue."},
{"el": "t2-bk-db", "payload": "UPDATE … held · ord_4410 WHERE 4 seats free", "text": "The booking service runs one conditional update over all four seats, and in the same transaction inserts the hold, ord_4410, expiring at 10:08:12."},
{"el": "t2-db-bk", "payload": "4 rows changed · committed", "ms": 3, "set": {"row.F-21 … F-22": "held · ord_4410", "row.F-23 … F-24": "held · ord_4410", "fan.fan 1 · ord_4410": "holding 4 · until 10:08"}, "text": "Four seats asked for, four rows changed, so the transaction commits. All four are held."},
{"el": "t2-bk-f", "payload": "Held until 10:08 · pay $600", "text": "The payment page opens with a countdown. Whatever happens on the site for the next 8 minutes, these four seats are theirs."},
{"el": "t2-f-bk", "payload": "Pay · tok_8Hq", "text": "Two minutes later they pay."},
{"el": "t2-bk-pay", "payload": "authorize $600 · key ord_4410:auth", "text": "The booking service asks for an authorization: the bank sets aside $600 on the card without moving it."},
{"el": "t2-pay-bk", "payload": "authorized · pay_812", "ms": 600, "text": "Approved."},
{"el": "t2-bk-db", "payload": "sell WHERE hold_id = ord_4410 · insert 4 tickets", "text": "It marks the seats sold, but only those still held by ord_4410, and inserts a ticket for each, in one transaction."},
{"el": "t2-db-bk", "payload": "4 rows changed · committed", "ms": 3, "set": {"row.F-21 … F-22": "sold · ord_4410", "row.F-23 … F-24": "sold · ord_4410", "fan.fan 1 · ord_4410": "4 tickets"}, "text": "Sold. The unique constraint on tickets means a second ticket for any of these seats could never be inserted, even by a bug elsewhere."},
{"el": "t2-bk-pay", "payload": "capture pay_812", "text": "Only now, with the seats sold, is the $600 captured."},
{"el": "t2-bk-f", "payload": "4 tickets", "ms": 400, "text": "The fan has their four seats together."}
]
},
{
"id": "overlap",
"label": "Two overlapping groups",
"nodes": ["bk2", "db2"],
"steps": [
{"el": "t2-f-bk", "payload": "Hold F-21 … F-24 · Hold F-23 … F-26 · same ms", "set": {"row.F-21 … F-22": "available", "row.F-23 … F-24": "available", "row.F-25 … F-26": "available", "fan.fan 1 · ord_4410": "choosing", "fan.fan 2 · ord_4411": "choosing"}, "text": "Two fans each want four seats in row F. Their groups overlap: both include F-23 and F-24."},
{"el": "t2-bk-db", "payload": "UPDATE F-21 … F-24 · UPDATE F-23 … F-26", "text": "Both conditional updates reach the database at the same moment. Each locks its seats one at a time, in seat ID order. Fan 1 locks F-21, F-22, F-23, F-24. Fan 2 starts with F-23, finds it locked, and waits."},
{"el": "t2-db-bk", "payload": "fan 1: 4 rows changed · committed", "ms": 3, "set": {"row.F-21 … F-22": "held · ord_4410", "row.F-23 … F-24": "held · ord_4410", "fan.fan 1 · ord_4410": "holding 4"}, "text": "Fan 1's condition holds for all four, and the transaction commits."},
{"el": "t2-db-bk", "payload": "fan 2: 2 of 4 changed → rolled back", "ms": 2, "set": {"fan.fan 2 · ord_4411": "nothing held"}, "text": "Fan 2's update now checks F-23 and F-24 against what fan 1 committed: held, and not expired. Those two don't change. F-25 and F-26 do. Two rows changed for four seats asked, so the booking service rolls the whole transaction back, and F-25 and F-26 are left free. Had the two fans locked in different orders, each could have ended up holding a seat the other was waiting for, and one would have been killed as a deadlock instead of simply waiting its turn."},
{"el": "t2-bk-f", "payload": "409 · taken: F-23, F-24", "text": "Fan 2 is told, before entering anything, which of their seats went. They aren't left holding two seats in row F that they'd have to give back. One group got all four; the other got none and can choose again."}
]
},
{
"id": "expire",
"label": "A hold that runs out",
"nodes": ["bk2", "pay2", "db2"],
"steps": [
{"el": "t2-f-bk", "payload": "Hold F-21, F-22", "set": {"row.F-21 … F-22": "available", "row.F-23 … F-24": "sold", "row.F-25 … F-26": "sold", "fan.fan 1 · ord_4410": "choosing", "fan.fan 2 · ord_4411": "—"}, "text": "At 10:00 a fan holds F-21 and F-22."},
{"el": "t2-bk-db", "payload": "UPDATE … held · ord_4410 · until 10:08", "text": "The usual conditional update."},
{"el": "t2-db-bk", "payload": "2 rows changed", "ms": 3, "set": {"row.F-21 … F-22": "held · ord_4410 · until 10:08", "fan.fan 1 · ord_4410": "holding · stepped away"}, "text": "Held until 10:08. The fan then gets distracted, and the payment page sits open on their phone."},
{"el": "t2-f-bk", "payload": "(fan 2) Hold F-21, F-22 · 10:09", "set": {"fan.fan 2 · ord_4411": "choosing"}, "text": "At 10:09 a second fan tries for the same two seats. Nothing has happened to them at 10:08: there is no clean-up job. The hold has simply passed its expiry."},
{"el": "t2-bk-db", "payload": "UPDATE … WHERE available OR held and expired", "text": "The condition lets a fan take a seat that's free, or one whose hold has expired."},
{"el": "t2-db-bk", "payload": "2 rows changed · hold_id = ord_4411", "ms": 3, "set": {"row.F-21 … F-22": "held · ord_4411 · until 10:17", "fan.fan 2 · ord_4411": "holding 2"}, "text": "Both seats are now held by ord_4411. Expiry didn't release the seats. It only allowed someone else to take them."},
{"el": "t2-f-bk", "payload": "(fan 1) Pay · ord_4410 · 10:10", "text": "At 10:10 the first fan comes back and clicks Pay."},
{"el": "t2-bk-pay", "payload": "authorize $300 · key ord_4410:auth", "text": "The booking service authorizes the card."},
{"el": "t2-pay-bk", "payload": "authorized", "ms": 600, "text": "Approved."},
{"el": "t2-bk-db", "payload": "sell WHERE hold_id = ord_4410", "text": "It tries to sell the seats held by ord_4410."},
{"el": "t2-db-bk", "payload": "0 rows changed", "ms": 2, "text": "None are. Had nobody taken them, the hold_id would still have matched and the late payment would have succeeded, even after 10:08."},
{"el": "t2-bk-pay", "payload": "void · key ord_4410:void", "text": "It voids the authorization."},
{"el": "t2-bk-f", "payload": "410 · your hold ran out and the seats were taken", "ms": 400, "set": {"fan.fan 1 · ord_4410": "seats lost · not charged"}, "text": "The fan is told, and the bank releases the $300 without it ever having moved. Because the payment was authorized first and captured only after the seats were sold, the only fan who pays is one who gets seats."}
]
}
]
}
</script>
<div class="diagram-caption">The booking service holds a group's seats in one conditional update that changes all of them or, if any is taken, none. It authorizes the payment, sells the seats only if they're still held by the same order, then captures. An expired hold is just a seat the next fan is allowed to take.</div>
</div>

<div class="fail-hint">Click the booking service, the payment service or the event DB to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="bk2">
<strong>If the booking service fails:</strong> its holds stay held until they expire, then become available to the next fan. A fan caught between the authorization and the sale has a payment authorized for seats not yet sold; the authorization lapses on its own after a few days, and a reconciliation job voids it sooner.
</div>
<div class="failure-impact is-hidden" data-component="pay2">
<strong>If the payment service fails:</strong> fans can hold seats but not pay. Their holds count down, and seats go back on sale as they expire. Nothing is sold twice.
</div>
<div class="failure-impact is-hidden" data-component="db2">
<strong>If the event DB fails:</strong> booking stops until the replica in another zone takes over, with every committed hold and sale.
</div>
</div>

A seat can no longer be sold twice, and a group gets all its seats or none. On a quiet day this is the whole design. At 10:00 on sale day it falls over. Two million fans open the seat map, and every refresh reads 50,000 seat rows from the database that also takes the holds: hundreds of thousands of reads a second against a database built for a few thousand. The few that get a map all see the same front rows free, and all click them. One fan gets each group of seats. The rest get `409`, look at a map that's already wrong, and click the next seats everyone else is clicking.

<!-- stage:3:3. Published Map, Best Available -->

## Stage 3 — A Published Seat Map, and Seats Chosen by the Server

- **The seat map is published, not queried.** A map publisher reads a replica of the event DB once a second, and writes one small file per section: one bit per seat, free or not, with a version number. Expired holds count as free.
- **A CDN serves the files.** Fans read the map from the CDN. However many fans have it open, the database is read once a second per section ([Caching](#/systems/caching)).
- **The map is a hint.** The hold is still a conditional update against the real seats. A fan who clicks a seat the map wrongly shows as free gets `409`, the seats that went, and the section's latest version.
- **Best available.** A fan can ask for "the best 4 together in FLR-A or FLR-B under $250". The booking service reads the free seats in the section, ordered by score, finds the best block of four adjacent seats in one row that doesn't strand a single empty seat, and holds it with the same conditional update. If another fan takes it first, it tries the next best block, up to 3 times.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 370" width="860" height="370" role="img" aria-label="A map publisher reads the event database replica every second and writes section files to a CDN that fans read; fans hold seats through the booking service, which writes to the event database primary">
  <rect x="20" y="170" width="130" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="85" y="196" text-anchor="middle" class="d-actor-label" font-size="12">Fan</text>
  <text x="85" y="213" text-anchor="middle" class="d-label-muted" font-size="9">browser</text>
  <g data-fail-toggle="cdn3">
    <rect x="220" y="30" width="170" height="64" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="305" y="57" text-anchor="middle" class="d-actor-label" font-size="12">CDN</text>
    <text x="305" y="74" text-anchor="middle" class="d-label-muted" font-size="9">one small file per section</text>
  </g>
  <g data-fail-toggle="pub3">
    <rect x="460" y="30" width="170" height="64" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="545" y="57" text-anchor="middle" class="d-actor-label" font-size="12">Map Publisher</text>
    <text x="545" y="74" text-anchor="middle" class="d-label-muted" font-size="9">every second</text>
  </g>
  <g data-fail-toggle="rep3">
    <rect x="690" y="30" width="150" height="64" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="765" y="57" text-anchor="middle" class="d-actor-label" font-size="12">DB Replica</text>
    <text x="765" y="74" text-anchor="middle" class="d-label-muted" font-size="9">read-only copy</text>
  </g>
  <g data-fail-toggle="bk3">
    <rect x="220" y="250" width="170" height="80" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="305" y="278" text-anchor="middle" class="d-actor-label" font-size="12">Booking Service</text>
    <text x="305" y="296" text-anchor="middle" class="d-label-muted" font-size="9">holds · best available</text>
    <text x="305" y="311" text-anchor="middle" class="d-label-muted" font-size="9">retries up to 3 blocks</text>
  </g>
  <g data-fail-toggle="db3">
    <rect x="460" y="250" width="170" height="80" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="545" y="278" text-anchor="middle" class="d-actor-label" font-size="12">Event DB</text>
    <text x="545" y="296" text-anchor="middle" class="d-label-muted" font-size="9">primary</text>
    <text x="545" y="311" text-anchor="middle" class="d-label-muted" font-size="9">seats · holds · tickets</text>
  </g>
  <line id="t3-f-cdn" x1="95" y1="168" x2="235" y2="97" class="d-msg d-request" data-depends-on="cdn3" marker-end="url(#arrowT3)"></line>
  <line id="t3-cdn-f" x1="255" y1="97" x2="115" y2="168" class="d-msg d-response" data-depends-on="cdn3" marker-end="url(#arrowT3r)"></line>
  <line id="t3-pub-cdn" x1="456" y1="62" x2="394" y2="62" class="d-msg d-request" data-depends-on="pub3 cdn3" marker-end="url(#arrowT3)"></line>
  <line id="t3-pub-rep" x1="632" y1="52" x2="686" y2="52" class="d-msg d-request" data-depends-on="pub3 rep3" marker-end="url(#arrowT3)"></line>
  <line id="t3-rep-pub" x1="686" y1="76" x2="632" y2="76" class="d-msg d-response" data-depends-on="pub3 rep3" marker-end="url(#arrowT3r)"></line>
  <line id="t3-db-rep" x1="632" y1="262" x2="745" y2="98" class="d-msg d-request" data-depends-on="db3 rep3" marker-end="url(#arrowT3)"></line>
  <line id="t3-f-bk" x1="152" y1="205" x2="216" y2="265" class="d-msg d-request" data-depends-on="bk3" marker-end="url(#arrowT3)"></line>
  <line id="t3-bk-f" x1="216" y1="290" x2="140" y2="232" class="d-msg d-response" data-depends-on="bk3" marker-end="url(#arrowT3r)"></line>
  <line id="t3-bk-db" x1="392" y1="275" x2="456" y2="275" class="d-msg d-request" data-depends-on="bk3 db3" marker-end="url(#arrowT3)"></line>
  <line id="t3-db-bk" x1="456" y1="305" x2="392" y2="305" class="d-msg d-response" data-depends-on="bk3 db3" marker-end="url(#arrowT3r)"></line>
  <text x="430" y="362" text-anchor="middle" class="d-label-muted" font-size="10">play loading the map, then asking for the best four, then clicking a seat someone just took</text>
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
{"id": "map", "title": "Section 112 map", "rows": [["published version", "—"], ["F-21 … F-22", "—"], ["DB reads for maps", "—"]]},
{"id": "hold", "title": "This fan's hold", "rows": [["seats", "—"]]}
],
"flows": [
{
"id": "map",
"label": "Load the seat map",
"nodes": ["cdn3", "pub3", "rep3", "db3"],
"steps": [
{"el": "t3-db-rep", "payload": "replicates every change", "set": {"map.published version": "8811", "map.F-21 … F-22": "free", "map.DB reads for maps": "—", "hold.seats": "—"}, "text": "Every hold and sale committed on the primary is copied to a read-only replica within milliseconds. Maps are built from the replica, so building them never slows a hold down."},
{"el": "t3-pub-rep", "payload": "seats changed since version 8811?", "text": "Once a second, the map publisher asks the replica which seats changed since the last version it published."},
{"el": "t3-rep-pub", "payload": "section 112: 14 changes", "ms": 4, "text": "Fourteen seats in section 112 changed status in the last second."},
{"el": "t3-pub-cdn", "payload": "112.v8812.bin · 100 bytes", "set": {"map.published version": "8812"}, "text": "The publisher writes a new file for the section: one bit per seat, 800 seats, 100 bytes, named by its version. An expired hold is written as free, since the next fan can take it. Sections with no changes keep their old file."},
{"el": "t3-f-cdn", "payload": "GET 112.v8812.bin", "text": "A fan's map page fetches the newest file for each section on screen, and again every few seconds."},
{"el": "t3-cdn-f", "payload": "100 bytes · from the edge", "ms": 1, "set": {"map.DB reads for maps": "1 a second per section"}, "text": "The CDN answers from an edge server near the fan. A million fans fetching this file is a million CDN hits and one database read. The cost is freshness: what the fan sees can be up to a couple of seconds old."}
]
},
{
"id": "best",
"label": "Ask for the best four",
"nodes": ["bk3", "db3"],
"steps": [
{"el": "t3-f-bk", "payload": "best 4 · FLR-A or FLR-B · ≤ $250", "set": {"map.published version": "8812", "map.F-21 … F-22": "free", "map.DB reads for maps": "1 a second per section", "hold.seats": "—"}, "text": "Instead of hunting the map, a fan asks for the best four seats together, in floor sections A or B, at up to $250 each."},
{"el": "t3-bk-db", "payload": "SELECT free seats in FLR-A ORDER BY score", "text": "The booking service reads the free seats in FLR-A, best first. Every seat has a score set when the event was created: lower is closer to the stage and nearer the centre."},
{"el": "t3-db-bk", "payload": "612 free seats", "ms": 4, "text": "612 of the section's 1,000 seats are free."},
{"el": "t3-bk-db", "payload": "hold FLR-A-C-11 … C-14 WHERE all 4 free", "text": "It finds the best four adjacent seats in one row: row C, seats 11 to 14. It skips a better block in row B that would have left a single empty seat between two groups, since nobody would ever buy that one. Then it holds them with the usual all-or-nothing update."},
{"el": "t3-db-bk", "payload": "4 rows changed", "ms": 3, "set": {"hold.seats": "FLR-A-C-11 … C-14"}, "text": "Held."},
{"el": "t3-bk-f", "payload": "FLR-A row C, 11–14 · held until 10:08", "text": "The fan gets four seats together without ever clicking one. Thousands of fans clicking the same map all aim at the same seats. Asked for the best available, the server gives each fan a different block."}
]
},
{
"id": "stale",
"label": "Click a seat someone just took",
"nodes": ["cdn3", "bk3", "db3"],
"steps": [
{"el": "t3-cdn-f", "payload": "112.v8812 · F-21, F-22 free", "set": {"map.published version": "8812", "map.F-21 … F-22": "free (on the map)", "map.DB reads for maps": "1 a second per section", "hold.seats": "—"}, "text": "A fan's map, version 8812, shows F-21 and F-22 free."},
{"el": "t3-f-bk", "payload": "Hold 112-F-21, F-22", "set": {"map.F-21 … F-22": "free on the map · F-22 held in the DB"}, "text": "They click both. 600ms earlier, another fan held F-22. The map won't show that until the next version."},
{"el": "t3-bk-db", "payload": "UPDATE … WHERE both free", "text": "The hold is checked against the real seats, not the map."},
{"el": "t3-db-bk", "payload": "1 of 2 changed → rolled back", "ms": 3, "text": "F-22 is held, so the whole hold is rolled back. The map being wrong costs the fan a click, never a seat sold twice."},
{"el": "t3-bk-f", "payload": "409 · taken: F-22 · version 8813 · F-11, F-12 free", "set": {"map.published version": "8813"}, "text": "The response names the seat that went, and the section's latest state, so the app redraws section 112 at once. It also suggests the nearest free pair."},
{"el": "t3-f-bk", "payload": "Hold 112-F-11, F-12", "text": "The fan takes the suggestion."},
{"el": "t3-bk-db", "payload": "UPDATE … WHERE both free", "text": "The same conditional update."},
{"el": "t3-db-bk", "payload": "2 rows changed", "ms": 3, "set": {"hold.seats": "112-F-11, F-12"}, "text": "Held."},
{"el": "t3-bk-f", "payload": "Held until 10:08", "text": "On a busy day a few clicks in a hundred hit a seat that just went. That's the price of a map that a million fans can read."}
]
}
]
}
</script>
<div class="diagram-caption">A map publisher reads a replica once a second and writes a small file per section to a CDN, which serves every fan. The map is only a hint: holds are still checked against the real seats on the primary. Fans can also ask the booking service to pick the best seats for them.</div>
</div>

<div class="fail-hint">Click the CDN, the map publisher, the replica, the booking service or the event DB to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="cdn3">
<strong>If the CDN fails:</strong> fans can't see the map, but best available still works, since it never reads the map. Fans who pick seats are stuck until it's back, or fall back to a coarse view: free seats per section, served by the booking service.
</div>
<div class="failure-impact is-hidden" data-component="pub3">
<strong>If the map publisher fails:</strong> the maps stop changing. Fans see seats free that are long gone, and more of their clicks get <code>409</code>. Nothing is sold twice. The map page shows how old it is, and an alert fires after 10 seconds without a new version.
</div>
<div class="failure-impact is-hidden" data-component="rep3">
<strong>If the replica fails:</strong> the publisher can't read, with the same effect. It must not fall back to the primary at full rate, or the maps would slow down the holds.
</div>
<div class="failure-impact is-hidden" data-component="bk3">
<strong>If a booking service instance fails:</strong> the others take its requests. Holds it made are in the database and expire on their own if never paid.
</div>
<div class="failure-impact is-hidden" data-component="db3">
<strong>If the event DB fails:</strong> holds stop until the replica in another zone takes over. Maps stay up, a few seconds out of date.
</div>
</div>

The map no longer touches the database, and fans asking for the best available get different seats. What's left is everyone arriving at once. At 10:00, two million fans hit the booking service in the same minute, about 33,000 hold requests a second for 50,000 seats. The database and the payment processors are swamped by fans who almost all can't get a seat, and which ones get through depends on who clicks fastest and who runs a script.

<!-- stage:4:4. A Waiting Room -->

## Stage 4 — A Waiting Room That Lets In Only as Many as There Are Seats

- **Fans join a line before booking.** Everyone who arrives in the 15 minutes before 10:00 is given a random place in line. Anyone later joins the back. Refreshing doesn't move anyone forward ([Rate Limiting](#/systems/rate-limiting)).
- **Admitted fans get a signed token**, valid for 14 minutes, that the booking service checks on every hold. A fan who skips the line has no token and gets `403`.
- **Fans are let in only while there are seats for them.** Before each batch, the waiting room asks how many seats are free and how many admitted fans haven't held any yet. Each of those fans will want about 2.5 seats, and 1 in 3 won't buy. If they would already use up every free seat, it waits.
- **The line is told the truth.** When every seat is held or sold, the line is told nothing is free now but some may come back. When every seat is sold, the line is told it's over.
- **Four tickets per fan.** A fan has at most one hold at a time, and holding new seats releases their old ones. Seats already bought count against the limit of 4, checked in the same transaction as the hold.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 360" width="860" height="360" role="img" aria-label="Fans join a waiting room that keeps the line in a line store and admits fans after asking the booking service how many seats are free; admitted fans hold seats through the booking service, which writes to the event database">
  <rect x="20" y="140" width="130" height="64" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="85" y="167" text-anchor="middle" class="d-actor-label" font-size="12">Fans</text>
  <text x="85" y="184" text-anchor="middle" class="d-label-muted" font-size="9">2,000,000 at 10:00</text>
  <g data-fail-toggle="wr4">
    <rect x="210" y="120" width="170" height="100" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="295" y="150" text-anchor="middle" class="d-actor-label" font-size="12">Waiting Room</text>
    <text x="295" y="168" text-anchor="middle" class="d-label-muted" font-size="9">random place in line</text>
    <text x="295" y="183" text-anchor="middle" class="d-label-muted" font-size="9">admits while seats remain</text>
    <text x="295" y="198" text-anchor="middle" class="d-label-muted" font-size="9">signed token · 14 min</text>
  </g>
  <g data-fail-toggle="ls4">
    <rect x="210" y="270" width="170" height="60" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="295" y="296" text-anchor="middle" class="d-actor-label" font-size="12">Line Store</text>
    <text x="295" y="313" text-anchor="middle" class="d-label-muted" font-size="9">places · in memory</text>
  </g>
  <g data-fail-toggle="bk4">
    <rect x="450" y="120" width="170" height="100" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="535" y="150" text-anchor="middle" class="d-actor-label" font-size="12">Booking Service</text>
    <text x="535" y="168" text-anchor="middle" class="d-label-muted" font-size="9">checks the token</text>
    <text x="535" y="183" text-anchor="middle" class="d-label-muted" font-size="9">holds · best available</text>
    <text x="535" y="198" text-anchor="middle" class="d-label-muted" font-size="9">counts free seats</text>
  </g>
  <g data-fail-toggle="db4">
    <rect x="690" y="120" width="150" height="100" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="765" y="160" text-anchor="middle" class="d-actor-label" font-size="12">Event DB</text>
    <text x="765" y="178" text-anchor="middle" class="d-label-muted" font-size="9">seats · holds</text>
    <text x="765" y="193" text-anchor="middle" class="d-label-muted" font-size="9">per-fan counts</text>
  </g>
  <line id="t4-f-wr" x1="152" y1="160" x2="206" y2="160" class="d-msg d-request" data-depends-on="wr4" marker-end="url(#arrowT4)"></line>
  <line id="t4-wr-f" x1="206" y1="190" x2="152" y2="190" class="d-msg d-response" data-depends-on="wr4" marker-end="url(#arrowT4r)"></line>
  <line id="t4-wr-ls" x1="275" y1="222" x2="275" y2="266" class="d-msg d-request" data-depends-on="wr4 ls4" marker-end="url(#arrowT4)"></line>
  <line id="t4-ls-wr" x1="315" y1="266" x2="315" y2="222" class="d-msg d-response" data-depends-on="wr4 ls4" marker-end="url(#arrowT4r)"></line>
  <line id="t4-wr-bk" x1="382" y1="150" x2="446" y2="150" class="d-msg d-request" data-depends-on="wr4 bk4" marker-end="url(#arrowT4)"></line>
  <line id="t4-bk-wr" x1="446" y1="190" x2="382" y2="190" class="d-msg d-response" data-depends-on="wr4 bk4" marker-end="url(#arrowT4r)"></line>
  <path id="t4-f-bk" d="M75,138 L75,60 L515,60 L515,116" class="d-msg d-request" data-depends-on="bk4" marker-end="url(#arrowT4)"></path>
  <path id="t4-bk-f" d="M555,116 L555,40 L110,40 L110,138" class="d-msg d-response" data-depends-on="bk4" marker-end="url(#arrowT4r)"></path>
  <line id="t4-bk-db" x1="622" y1="150" x2="686" y2="150" class="d-msg d-request" data-depends-on="bk4 db4" marker-end="url(#arrowT4)"></line>
  <line id="t4-db-bk" x1="686" y1="190" x2="622" y2="190" class="d-msg d-response" data-depends-on="bk4 db4" marker-end="url(#arrowT4r)"></line>
  <text x="430" y="352" text-anchor="middle" class="d-label-muted" font-size="10">play the line at 10:00, then admitting only as many as there are seats, then two hundred fans after the floor</text>
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
{"id": "ev", "title": "Event ev_77", "rows": [["free", "—"], ["held", "—"], ["sold", "—"]]},
{"id": "wr", "title": "Waiting room", "rows": [["in line", "—"], ["admitted, no hold yet", "—"], ["admitting", "—"]]}
],
"flows": [
{
"id": "line",
"label": "The line at 10:00",
"nodes": ["wr4", "ls4", "bk4", "db4"],
"steps": [
{"el": "t4-f-wr", "payload": "Join line · 09:52", "set": {"ev.free": "50,000", "ev.held": "0", "ev.sold": "0", "wr.in line": "1,400,000 by 10:00", "wr.admitted, no hold yet": "0", "wr.admitting": "not yet"}, "text": "At 09:52 a fan opens the event page and joins the line."},
{"el": "t4-wr-ls", "payload": "add ln_9k2 · joined 09:52", "text": "The waiting room records them in the line store. Fans arriving before 10:00 aren't ordered by arrival yet."},
{"el": "t4-ls-wr", "payload": "ok", "ms": 1, "text": "Recorded. By 10:00, 1.4 million fans have joined."},
{"el": "t4-wr-ls", "payload": "10:00:00 · shuffle the 1.4M early arrivals", "text": "At 10:00:00, the waiting room gives every early arrival a random rank. Arriving at 09:45 or 09:59, on a fast connection or a slow one, with one tab or fifty, makes no difference. Fans arriving after 10:00 go to the back, in order of arrival."},
{"el": "t4-ls-wr", "payload": "ln_9k2 → 48,211th", "ms": 300, "text": "This fan is 48,211th."},
{"el": "t4-wr-f", "payload": "You're 48,211th in line", "text": "The page tells them their place and keeps it updated. Fans in line see a place, not a seat map, so the 400,000 map reads a second never happen."},
{"el": "t4-wr-bk", "payload": "free seats? admitted fans without a hold?", "text": "Before letting anyone in, the waiting room asks the booking service how many seats are free and how many admitted fans haven't held any yet."},
{"el": "t4-bk-wr", "payload": "50,000 free · 0 waiting to hold", "ms": 2, "set": {"wr.admitting": "2,000 now, then ~250 a second"}, "text": "Every seat is free. The waiting room lets in the first 2,000 fans at once, then about 250 a second, the rate the payment processors can take."},
{"el": "t4-wr-f", "payload": "(fan 1) admitted · token · until 10:14", "set": {"wr.in line": "1,398,000", "wr.admitted, no hold yet": "2,000"}, "text": "The first fan in line is admitted with a token signed by the waiting room, naming the fan and the event, valid for 14 minutes."},
{"el": "t4-f-bk", "payload": "best 2 · 112 · token", "text": "They go straight to booking. Every hold request carries the token, and the booking service checks its signature and expiry before doing anything else."},
{"el": "t4-bk-db", "payload": "hold 2 · fan has 0 of 4", "text": "The hold checks the fan's ticket count in the same transaction: no seats bought yet, so two more is within the limit of 4."},
{"el": "t4-db-bk", "payload": "2 rows changed", "ms": 3, "set": {"ev.free": "49,998", "ev.held": "2"}, "text": "Held."},
{"el": "t4-bk-f", "payload": "112-F-21, F-22 · held until 10:08", "text": "Fans reach booking at a rate the system can serve, in an order nobody could game."}
]
},
{
"id": "budget",
"label": "Admitting only as many as there are seats",
"nodes": ["wr4", "bk4", "db4"],
"steps": [
{"el": "t4-wr-bk", "payload": "free seats? admitted fans without a hold?", "set": {"ev.free": "1,800", "ev.held": "3,600", "ev.sold": "44,600", "wr.in line": "1,610,000", "wr.admitted, no hold yet": "1,200", "wr.admitting": "250 a second"}, "text": "At 10:06, most seats are sold. The waiting room checks before its next batch."},
{"el": "t4-bk-db", "payload": "count free seats · count holds", "text": "The booking service counts free seats, with expired holds counting as free."},
{"el": "t4-db-bk", "payload": "1,800 free · 3,600 held", "ms": 4, "text": "1,800 seats are free; 3,600 are held by fans who are paying now."},
{"el": "t4-bk-wr", "payload": "1,800 free · 1,200 admitted without a hold", "ms": 1, "text": "1,200 admitted fans haven't held anything yet. At 2.5 seats each, with 1 in 3 not buying, they'll want about 2,000 seats: more than are free."},
{"el": "t4-wr-f", "payload": "Seats are going fast · you're 31,870th", "set": {"wr.admitting": "paused"}, "text": "So the waiting room stops letting people in. Admitting more would send fans to a booking page where nearly every hold fails, and they'd lose their place in line for nothing."},
{"el": "t4-wr-bk", "payload": "free seats? (10:12)", "ms": 360000, "text": "By 10:12, the free seats have all been held, and the admitted fans have mostly bought or left."},
{"el": "t4-bk-wr", "payload": "0 free · 900 held", "ms": 2, "set": {"ev.free": "0", "ev.held": "900", "ev.sold": "49,100", "wr.admitted, no hold yet": "0"}, "text": "No seat is free. 900 are held by fans still paying, and some of those holds will run out."},
{"el": "t4-wr-f", "payload": "Every seat is held · some may come back", "text": "The 1.6 million fans in line are told at once, rather than each finding out after admission."},
{"el": "t4-bk-wr", "payload": "40 free · expired holds", "ms": 180000, "set": {"ev.free": "40", "ev.held": "0", "ev.sold": "49,960", "wr.admitting": "16 fans"}, "text": "At 10:15 the last holds have been paid for or have expired. 40 seats came back. The waiting room lets in 16 more fans, enough for 40 seats."},
{"el": "t4-wr-f", "payload": "Sold out", "ms": 120000, "set": {"ev.free": "0", "ev.sold": "50,000", "wr.admitting": "closed"}, "text": "Two minutes later, every seat is sold. Everyone still in line is told it's over, fifteen minutes after it began. About 31,000 fans were ever let in. None of the other 1.97 million had to fight for a seat that wasn't there."}
]
},
{
"id": "floor",
"label": "Two hundred fans after the floor",
"nodes": ["bk4", "db4"],
"steps": [
{"el": "t4-f-bk", "payload": "200 × best 2 · FLR-A · within 1 second", "set": {"ev.free": "49,000", "ev.held": "1,000", "ev.sold": "0", "wr.in line": "1,398,000", "wr.admitted, no hold yet": "2,000", "wr.admitting": "250 a second"}, "text": "10:00:01. The first 2,000 fans were let in together, and about 200 of them ask for the best two seats in floor section A within the same second."},
{"el": "t4-bk-db", "payload": "200 × SELECT free seats in FLR-A", "text": "For each request, the booking service reads the section's free seats and picks the best block."},
{"el": "t4-db-bk", "payload": "200 × the same 1,000 rows", "ms": 6, "text": "All 200 read the section within a few milliseconds of each other, so all 200 get the same answer."},
{"el": "t4-bk-db", "payload": "200 × hold FLR-A-A-15, A-16", "text": "And all 200 work out the same best block: row A, seats 15 and 16."},
{"el": "t4-db-bk", "payload": "1 wins · 199 × 0 rows changed", "ms": 40, "text": "One fan gets them. The other 199 queue behind each other on those two rows' locks, and each finds them taken."},
{"el": "t4-bk-db", "payload": "199 × read again · 199 × hold A-17, A-18", "text": "Each of the 199 reads the section again, and works out the same next best block. Again, one wins. A fan's first three attempts all go this way, so after three tries, 197 fans are given an error and sent back to try again."},
{"el": "t4-db-bk", "payload": "~600 section reads · 3 holds", "ms": 2000, "text": "One second of demand for one section has cost the database about 600 reads of 1,000 rows each, and 600 lock waits on the same handful of rows, to hold 3 pairs of seats. The four floor sections together take most of the database's capacity, and hold latency for every section in the stadium climbs to seconds."},
{"el": "t4-bk-f", "payload": "197 × Something went wrong · try again", "text": "The fans who wanted the best seats get errors and try again, which makes it worse. The work grows with the square of the fans asking: every fan computes the answer every other fan computes, and only one of them can use it. The section needs one place that hands out its seats in turn, so nobody computes an answer someone else is about to take."}
]
}
]
}
</script>
<div class="diagram-caption">Fans wait in a random-order line and are let in only while there are free seats for them, each with a signed token the booking service checks. Admitted fans hold seats as before.</div>
</div>

<div class="fail-hint">Click the waiting room, the line store, the booking service or the event DB to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="wr4">
<strong>If the waiting room fails:</strong> nobody new is let in, and the sale pauses. Fans already admitted carry on with their tokens. It must not fail open: letting two million fans through at once is the overload it exists to prevent.
</div>
<div class="failure-impact is-hidden" data-component="ls4">
<strong>If the line store fails:</strong> its replica takes over with every place in line. If both were lost, the line would be rebuilt from the fans who reconnect, with their original join times from their signed line IDs, rather than starting again in order of who reconnects first.
</div>
<div class="failure-impact is-hidden" data-component="bk4">
<strong>If a booking service instance fails:</strong> another takes its requests. Admitted fans' tokens are checked by signature, so any instance accepts them.
</div>
<div class="failure-impact is-hidden" data-component="db4">
<strong>If the event DB fails:</strong> holds stop until the replica takes over, and the waiting room stops admitting, since it can't count free seats.
</div>
</div>

The waiting room keeps the load to what the system can take, and only lets in fans who can still get a seat. Inside it, though, the best sections still collapse: every fan asking for the best seats in floor A computes the same best seats, and all but one of them fail. More database won't fix that. What's needed is for one place to own each section and hand its seats out one request at a time.

<!-- stage:5:5. Section Allocators -->

## Stage 5 — One Allocator Owns Each Section

- **Every section has one owner.** Six allocator processes divide the 62 sections between them. Each holds its sections' seats in memory: which are free, who holds the rest, and the best free blocks in each row.
- **Requests for a section wait in its queue.** The booking service sends each hold to the owner of the section asked for. The owner takes requests one at a time, picks the best free block from memory, and marks it held. No two requests can compute the same block, so nothing is retried.
- **Holds are committed in batches.** Every 5ms, the owner writes the holds it has made to the event DB in one transaction, with the same conditional updates as before, and replies to those fans only once the transaction commits. Nothing a fan is told is held can be lost.
- **Ownership is a lease with an epoch.** The `section_owners` row says which allocator owns FLR-A, until when, and with what epoch. Each batch's transaction checks that the epoch is still the owner's, so an allocator that has lost a section can't write to it ([Distributed Locking](#/systems/distributed-locking)).
- **A new owner reloads from the database.** If an allocator stops renewing its leases, another claims its sections with a higher epoch, reads their seats, about 1,000 rows each, and carries on.
- **The allocators publish the maps.** Each owner writes its sections' map files to the CDN once a second, from memory, so the replica is no longer read for maps.
- **Selling is unchanged.** Payment, sale and tickets work as in Stage 2, through the owner.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 360" width="860" height="360" role="img" aria-label="The booking service sends each hold to the allocator that owns its section; two allocators each hold their sections in memory and commit holds in batches to the event database, checking their ownership epoch">
  <rect x="20" y="150" width="120" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="176" text-anchor="middle" class="d-actor-label" font-size="12">Fans</text>
  <text x="80" y="193" text-anchor="middle" class="d-label-muted" font-size="9">admitted · with token</text>
  <g data-fail-toggle="bk5">
    <rect x="200" y="130" width="160" height="100" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="280" y="160" text-anchor="middle" class="d-actor-label" font-size="12">Booking Service</text>
    <text x="280" y="178" text-anchor="middle" class="d-label-muted" font-size="9">checks the token</text>
    <text x="280" y="193" text-anchor="middle" class="d-label-muted" font-size="9">sends each hold to</text>
    <text x="280" y="208" text-anchor="middle" class="d-label-muted" font-size="9">its section's owner</text>
  </g>
  <g data-fail-toggle="a1">
    <rect x="430" y="40" width="180" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="520" y="68" text-anchor="middle" class="d-actor-label" font-size="12">Allocator 1</text>
    <text x="520" y="86" text-anchor="middle" class="d-label-muted" font-size="9">owns FLR-A · epoch 7</text>
    <text x="520" y="101" text-anchor="middle" class="d-label-muted" font-size="9">seats in memory · one at a time</text>
  </g>
  <g data-fail-toggle="a2">
    <rect x="430" y="230" width="180" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="520" y="258" text-anchor="middle" class="d-actor-label" font-size="12">Allocator 2</text>
    <text x="520" y="276" text-anchor="middle" class="d-label-muted" font-size="9">owns FLR-B · epoch 4</text>
    <text x="520" y="291" text-anchor="middle" class="d-label-muted" font-size="9">seats in memory · one at a time</text>
  </g>
  <g data-fail-toggle="db5">
    <rect x="690" y="140" width="150" height="80" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="765" y="168" text-anchor="middle" class="d-actor-label" font-size="12">Event DB</text>
    <text x="765" y="186" text-anchor="middle" class="d-label-muted" font-size="9">seats · holds</text>
    <text x="765" y="201" text-anchor="middle" class="d-label-muted" font-size="9">section owners · epochs</text>
  </g>
  <line id="t5-f-bk" x1="142" y1="170" x2="196" y2="170" class="d-msg d-request" data-depends-on="bk5" marker-end="url(#arrowT5)"></line>
  <line id="t5-bk-f" x1="196" y1="200" x2="142" y2="200" class="d-msg d-response" data-depends-on="bk5" marker-end="url(#arrowT5r)"></line>
  <line id="t5-bk-a1" x1="362" y1="150" x2="426" y2="95" class="d-msg d-request" data-depends-on="bk5 a1" marker-end="url(#arrowT5)"></line>
  <line id="t5-a1-bk" x1="426" y1="115" x2="362" y2="170" class="d-msg d-response" data-depends-on="bk5 a1" marker-end="url(#arrowT5r)"></line>
  <line id="t5-bk-a2" x1="362" y1="195" x2="426" y2="255" class="d-msg d-request" data-depends-on="bk5 a2" marker-end="url(#arrowT5)"></line>
  <line id="t5-a2-bk" x1="426" y1="275" x2="362" y2="215" class="d-msg d-response" data-depends-on="bk5 a2" marker-end="url(#arrowT5r)"></line>
  <path id="t5-a1-db" d="M612,75 L660,75 L660,155 L686,155" class="d-msg d-request" data-depends-on="a1 db5" marker-end="url(#arrowT5)"></path>
  <path id="t5-db-a1" d="M686,175 L645,175 L645,95 L612,95" class="d-msg d-response" data-depends-on="a1 db5" marker-end="url(#arrowT5r)"></path>
  <path id="t5-a2-db" d="M612,285 L660,285 L660,205 L686,205" class="d-msg d-request" data-depends-on="a2 db5" marker-end="url(#arrowT5)"></path>
  <path id="t5-db-a2" d="M686,190 L645,190 L645,265 L612,265" class="d-msg d-response" data-depends-on="a2 db5" marker-end="url(#arrowT5r)"></path>
  <text x="430" y="352" text-anchor="middle" class="d-label-muted" font-size="10">play the same two hundred fans after the floor, then an allocator failing, then a request that spills to the next section</text>
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
{"id": "fa", "title": "Section FLR-A", "rows": [["owner", "—"], ["free seats", "—"], ["queue", "—"]]},
{"id": "db", "title": "Event DB", "rows": [["FLR-A owner row", "—"], ["last batch", "—"]]}
],
"flows": [
{
"id": "rush",
"label": "Two hundred fans after the floor",
"nodes": ["bk5", "a1", "db5"],
"steps": [
{"el": "t5-f-bk", "payload": "200 × best 2 · FLR-A · within 1 second", "set": {"fa.owner": "allocator 1 · epoch 7", "fa.free seats": "1,000", "fa.queue": "—", "db.FLR-A owner row": "allocator 1 · epoch 7", "db.last batch": "—"}, "text": "The same 200 fans, the same second, the same best seats in floor A."},
{"el": "t5-bk-a1", "payload": "200 × best 2 · FLR-A", "set": {"fa.queue": "200 requests"}, "text": "The booking service sends every request for FLR-A to its owner, allocator 1. They join the section's queue."},
{"el": "t5-a1-db", "payload": "batch: 23 holds · epoch 7 · one transaction", "set": {"fa.free seats": "954", "fa.queue": "177 requests"}, "text": "Allocator 1 takes requests one at a time. The first gets row A, 15 and 16. The next gets row A, 17 and 18, because 15 and 16 are already marked held in memory. Each pick takes microseconds and never collides. Every 5ms, the holds made so far go to the database in one transaction: check that FLR-A's epoch is still 7, run the conditional updates, insert the holds."},
{"el": "t5-db-a1", "payload": "committed · 46 rows changed", "ms": 6, "set": {"db.last batch": "23 holds · committed"}, "text": "Committed. The conditional updates still guard every seat, so even a bug in the allocator's memory couldn't hold a seat twice: the batch would fail instead."},
{"el": "t5-a1-bk", "payload": "23 × held · rows A–B", "ms": 1, "text": "Only now are those 23 fans told their seats are held. The rest of the queue is being worked through in the next batches."},
{"el": "t5-a1-db", "payload": "next 8 batches · 177 holds", "set": {"fa.free seats": "600", "fa.queue": "empty"}, "ms": 45, "text": "Within about 50ms, all 200 fans have been given their pair, in the order they arrived: no retries, no wasted reads, and about 10 transactions where Stage 4 needed 600 reads and 600 lock waits."},
{"el": "t5-db-a1", "payload": "committed", "ms": 6, "set": {"db.last batch": "all 200 holds committed"}, "text": "Every hold is committed."},
{"el": "t5-bk-f", "payload": "200 × seats held · p99 ~60ms", "text": "Every fan who asked got the best seats left at their turn. The work is one pick per request, however many fans want the section."}
]
},
{
"id": "failover",
"label": "An allocator fails",
"nodes": ["bk5", "a1", "a2", "db5"],
"steps": [
{"el": "t5-a1-db", "payload": "renew FLR-A lease · epoch 7", "set": {"fa.owner": "allocator 1 · epoch 7", "fa.free seats": "412", "fa.queue": "30 requests", "db.FLR-A owner row": "allocator 1 · epoch 7 · until 10:03:10", "db.last batch": "committed"}, "text": "Every 3 seconds, allocator 1 renews its lease on its sections, for 10 seconds at a time."},
{"el": "t5-bk-a1", "payload": "best 2 · FLR-A (no answer)", "set": {"fa.owner": "allocator 1 · paused"}, "text": "At 10:03:00 allocator 1 stops responding: a long pause in its process. Requests for FLR-A time out, and fans asking for the floor see a short wait."},
{"el": "t5-a2-db", "payload": "claim FLR-A WHERE lease expired · epoch 8", "ms": 10000, "text": "At 10:03:10 its lease runs out. Allocator 2, which watches for expired leases, claims FLR-A: set the owner to allocator 2 and the epoch to 8, but only if the lease has expired."},
{"el": "t5-db-a2", "payload": "claimed · epoch 8 · 1,000 seat rows", "ms": 8, "set": {"fa.owner": "allocator 2 · epoch 8", "db.FLR-A owner row": "allocator 2 · epoch 8"}, "text": "It reads FLR-A's seats from the database. Every hold allocator 1 ever told a fan about is there, because it never replied before committing. Holds it made in memory but never committed weren't promised to anyone."},
{"el": "t5-bk-a2", "payload": "best 2 · FLR-A (retried)", "text": "The booking service learns the new owner and sends the waiting requests to allocator 2."},
{"el": "t5-a2-bk", "payload": "held · row K", "ms": 6, "set": {"fa.free seats": "380", "fa.queue": "empty"}, "text": "Holds in FLR-A resume, about 10 seconds after allocator 1 stopped."},
{"el": "t5-a1-db", "payload": "batch: 4 holds · epoch 7", "set": {"fa.owner": "allocator 2 · epoch 8 · allocator 1 woke up"}, "text": "Then allocator 1 wakes up. It doesn't know any time has passed, and it sends the batch it was building, with epoch 7."},
{"el": "t5-db-a1", "payload": "rolled back · FLR-A is at epoch 8", "ms": 3, "set": {"db.last batch": "epoch 7 refused"}, "text": "The batch's first check fails: FLR-A's epoch is 8. Nothing is written. Allocator 1 drops the section and tells its four fans to try again, which sends them to allocator 2. Two allocators can believe they own a section; only one can ever write to it."}
]
},
{
"id": "spill",
"label": "A request that spills to the next section",
"nodes": ["bk5", "a1", "a2", "db5"],
"steps": [
{"el": "t5-f-bk", "payload": "best 4 together · FLR-A or FLR-B", "set": {"fa.owner": "allocator 1 · epoch 7", "fa.free seats": "37 · no 4 together", "fa.queue": "—", "db.FLR-A owner row": "allocator 1 · epoch 7", "db.last batch": "—"}, "text": "At 10:04, a fan asks for the best four together, in floor A, or floor B if A has none."},
{"el": "t5-bk-a1", "payload": "best 4 · FLR-A", "text": "The booking service asks each section's owner in the fan's order of preference. First, FLR-A."},
{"el": "t5-a1-bk", "payload": "none · 37 free, no 4 together", "ms": 1, "text": "FLR-A has 37 seats free, but nowhere four in a row. The allocator answers from memory in microseconds: no database read was needed to find that out."},
{"el": "t5-bk-a2", "payload": "best 4 · FLR-B", "text": "Next, FLR-B's owner, allocator 2."},
{"el": "t5-a2-db", "payload": "batch: hold FLR-B-M-3 … M-6 · epoch 4", "text": "It finds four together in row M and commits them in its next batch."},
{"el": "t5-db-a2", "payload": "committed", "ms": 6, "text": "Committed."},
{"el": "t5-a2-bk", "payload": "held · FLR-B row M, 3–6", "ms": 1, "text": "Held."},
{"el": "t5-bk-f", "payload": "FLR-B row M, 3–6 · held until 10:12", "text": "A request that spans sections asks their owners one after another, never two at once, so a fan never ends up holding seats in both. The allocators also write their sections' map files to the CDN every second, straight from memory, so the maps come from the same place that hands out the seats."}
]
}
]
}
</script>
<div class="diagram-caption">Each section is owned by one allocator, which keeps its seats in memory and hands them out one request at a time. Holds are committed to the event DB in batches every 5ms, with a check that the allocator still owns the section, before any fan is told. A lease with an epoch moves sections to another allocator when one fails.</div>
</div>

<div class="fail-hint">Click the booking service, either allocator or the event DB to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="bk5">
<strong>If a booking service instance fails:</strong> another takes its requests. It holds no state: tokens are checked by signature, and section owners are read from the database and cached.
</div>
<div class="failure-impact is-hidden" data-component="a1">
<strong>If allocator 1 fails:</strong> holds in its sections stop for about 10 seconds, until its leases expire and another allocator claims them, reloads them from the database, and carries on. Nothing a fan was told is held is lost. Replay the second flow.
</div>
<div class="failure-impact is-hidden" data-component="a2">
<strong>If allocator 2 fails:</strong> the same for its sections. With six allocators, a failure pauses about a sixth of the stadium for 10 seconds, and the other five share its sections.
</div>
<div class="failure-impact is-hidden" data-component="db5">
<strong>If the event DB fails:</strong> no batch can commit, so no fan is told a hold succeeded. Allocators keep their queues and retry until the replica takes over, about 30 seconds. Leases can't be renewed either, so no section changes owner in the meantime.
</div>
</div>

This is the full design. Every seat is taken by a conditional update that either takes every seat in a group or none, checked against the real seat rather than any map, with a unique constraint on tickets behind it. A hold lasts 8 minutes, and an expired hold is simply a seat the next fan is allowed to take. The card is authorized before the seats are sold and captured after, so only fans who get seats pay. Maps are small per-section files on a CDN, and fans can ask for the best available instead of fighting over the same seats on the same map. A waiting room puts early arrivals in random order and lets fans in only while there are seats for them. Inside, each section is owned by one allocator that hands out its seats one request at a time from memory and commits them in batches, fenced by an epoch, so the best seats in the stadium go to fans in the order they asked, without a single retry.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### Picking the best seats

Every seat gets a score when the event is set up, from how far it is from the stage and from the centre line, and how good its view is. Best available then means:

1. Among the fan's sections, in their order of preference, and within their price limit,
2. find runs of adjacent free seats in one row at least as long as the group,
3. choose the run with the lowest total score,
4. and don't leave a single free seat at either end, between the group and an aisle or another group. One seat on its own is the hardest seat in the stadium to sell.

If no row has enough seats together, the fan is offered the best split, two and two in consecutive rows, rather than nothing. Inside an allocator, each row keeps its free runs in memory, so this is a short search through a few dozen rows rather than a scan of the section.

### Expiry without a clean-up job

| Approach | How a hold ends | Trade-off |
|---|---|---|
| A sweeper job | A job finds expired holds every few seconds and frees their seats | Seats come back up to one pass late. A stopped sweeper keeps seats off sale |
| A timer per hold | Each hold sets a timer that frees its seats | Timers live in some process's memory and are lost when it restarts |
| Lazy expiry (this design) | The hold's seats can be taken by anyone once it has expired | Nothing to run or lose. The seat map and the free-seat counts must treat an expired hold as free |

Lazy expiry also has a useful side effect: a fan whose payment finishes a little late still gets their seats, as long as nobody else has taken them yet.

### How long a hold lasts

The hold is the dial between the fan paying and the fan in line. A long hold lets a fan pay calmly, enter a code from their bank, or fetch a card. Every minute of it is a minute those seats can't go to anyone else, and on sale day about 1 in 3 holds is never paid for. Eight minutes covers almost every real payment. Fans who are still entering details near the end can extend once, by 4 minutes, so a slow bank check doesn't cost them the seats.

### Who gets let in

The waiting room's admission rule, before each batch:

```
expected_demand = admitted_without_hold × 2.5 seats × (2/3 who buy)
admit_now       = min(rate_limit, (free_seats − expected_demand) / (2.5 × 2/3))
```

Letting in too many sends fans into a booking page with nothing left to book. Letting in too few leaves seats unsold while fans wait. The waiting room errs slightly towards too many, because fans who leave without buying, and holds that expire, put seats back faster than the numbers predict.

### Random order for early arrivals

Ordering the whole line by arrival time rewards whoever arrives first by milliseconds, which is whoever runs the most scripts closest to the servers. Shuffling everyone who arrived before the sale opens makes the 15 minutes beforehand a fair window: arriving at 09:46 or 09:59 is the same. After 10:00, arrival order is fair again, since the early arrivals are already ahead.

### Why an allocator per section, and not a lock

A lock per section would also stop two fans computing the same block, but each fan would still hold the lock across a database read and write, a few milliseconds each, so the section could serve a few hundred requests a second. The allocator does the work in memory and pays the database cost once per batch, which is why it can serve thousands. It is the same idea as a single-writer partition in a log ([Log-Based Systems](#/systems/log-based-systems)): give one process ownership of the hot data, and let it decide in order, instead of making many processes agree.

### Tickets that are hard to copy

A ticket's barcode is generated on the fan's phone from the ticket's secret and the current time, and changes every 15 seconds. A screenshot is useless by the time it's shared. The gate scanners know each ticket's secret, so they can check a barcode without calling the platform, which matters in a stadium where 50,000 phones share one mobile network. A ticket transferred to a friend gets a new secret, so the original holder's copy stops working.

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### Most fans don't get a ticket

Two million fans for 50,000 seats means 39 in 40 go home without one, however good the system is. The design's job for them is to say so quickly and fairly: a random place in line, told when everything is held, told when it's over. A system that lets everyone in to try only makes the same outcome slower and more frustrating.

### The waiting room is a wait

Fans spend minutes in line, most to be told they missed out. Admitting faster would shorten the wait for those who get in, and fill the booking page with fans who can't. The admission rule is a judgement about expected demand, and when it's wrong, seats sit unsold for a minute or fans meet an empty section.

### The map is always slightly wrong

A one-second map read by a million fans is cheap and a few seconds stale. On sale day, a few clicks in a hundred land on a seat that just went. A live map pushed to every fan would be fresher and would cost a connection per fan; it's worth doing only for fans already admitted, and even then best available sidesteps the problem.

### Holds keep seats from fans who would pay

At the peak, thousands of seats are held by fans who will never pay. Shorter holds return them sooner and rush the fans who will. Lazy expiry doesn't help here: an expired hold is free to take, but only once someone asks for it.

### Allocators add a moving part

Allocators make the best sections fast, at the cost of leases, epochs, failover and a 10-second pause for a section when its owner fails. For an event that sells out over a week, they're unnecessary: Stage 3 is enough. They earn their place only when hundreds of fans want the same section in the same second.

### Fairness against what fans asked for

Best available gives each fan the best seats left at their turn. A fan who wants specific seats and clicks them can still lose to one who asked for the best available a moment earlier. Holding seats the fan clicked, rather than ones the server chose, will always be slightly unfair to someone, and the design accepts that rather than forcing everyone through best available.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

Tickets to a popular event resell for many times their price, so every step of buying one is worth automating, faking or hoarding ([Security & Authentication](#/systems/security-authentication)).

### Bots and scalpers

Random order among early arrivals removes the value of being fastest. Beyond that: a challenge and device checks before a fan joins the line; one place in line per verified account, with a phone number that has bought tickets before counting for more than a new one; the limit of 4 enforced by account, card, phone and billing address together; and orders reviewed after the sale, with tickets for accounts sharing a card or device cancelled before the event. For the most in-demand events, fans register days ahead and a random draw decides who gets a place in line at all.

### Skipping the line

An admission token is signed by the waiting room, names the fan and the event, and expires. The booking service checks it on every hold, so a fan who calls the API directly gets `403`. Tokens are bound to the fan's session, so a token passed to another device or account is refused.

### Holding seats without paying

Holds are free, so they can be used to keep seats off sale. A fan can have one hold at a time, and holding new seats releases the old ones. A token is valid for 14 minutes, enough for one hold and one extension. Accounts whose holds expire again and again are limited.

### Price tampering

The price comes from the seat row when the hold is made, and the amount authorized from the hold. Neither is ever taken from the browser.

### Fake and duplicate tickets

A ticket is a row with a unique seat, and its barcode changes every 15 seconds from a secret only the fan's app and the gate know. A screenshot, a printed copy or a ticket resold to two buyers is refused at the gate. Transfers go through the platform, which issues a new secret and invalidates the old one.

### Reading the seat map

Map files show only free or not, never who holds a seat. Rate limits on the booking API stop a script from probing seats one by one to learn more ([Rate Limiting](#/systems/rate-limiting)).

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **Seats**: free, held and sold, per section and in total, every second.
- **Holds**: requests, successes, `409`s and expiries per second, per section, and hold latency at p50 and p99.
- **The line**: fans in line, admission rate, admitted fans without a hold, and how long the fan at the front has waited.
- **Allocators**: queue length and age of the oldest request per section, batch commit time, lease renewals, and changes of owner.
- **Maps**: the age of each section's latest published version.
- **Payments**: authorizations, declines and voids per minute, and seats lost after expiry.

([Observability](#/systems/observability))

### What to alert on

- Any attempt to insert a second ticket for a seat. The unique constraint refuses it; that it happened at all means something upstream has a bug.
- A batch refused for a wrong epoch more than a few times a minute: allocators are fighting over sections.
- Any section's map not republished for **10 seconds**.
- The oldest request in any section's queue older than **2 seconds**.
- The waiting room admitting faster than its configured rate. It may have failed open.
- Hold latency at p99 above **500ms** for a minute.
- More than **20%** of holds failing with `409` in a section: the map is staler than it should be, or the section needs best available only.

### "Two fans turned up with tickets for the same seat" — what happens?

Look up the seat's tickets. If there is only one ticket row, one of the two is a copy: check the barcodes the gate scanned, and which account the real ticket belongs to. If there are somehow two rows, the unique constraint was dropped or bypassed: stop sales for the event and find out how. Then check the seat's holds and the sale's transaction: a sale should only ever have changed rows still held by its own order.

### "The line isn't moving" — what happens?

Ask the waiting room why it isn't admitting. If admitted fans without a hold are using up the free seats, it's working as designed and the line should be told seats are nearly gone. If the free-seat count isn't coming back from the booking service, the event DB or its replica is struggling: fix that first. If it is admitting but fans aren't reaching booking, check the token signing keys on both sides.

### "The best sections are slow to book" — what happens?

Check the allocator that owns them. A long queue with slow batch commits means the event DB is the limit: look at its write latency. A long queue with fast commits means the allocator's own work is too slow, or it owns too many busy sections: move some to another allocator by releasing their leases. If the owner keeps changing, two allocators are fighting over leases, usually because one is pausing for longer than the lease renewal interval.
