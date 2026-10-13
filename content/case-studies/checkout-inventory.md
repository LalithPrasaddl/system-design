# E-commerce Checkout & Inventory

A checkout turns a customer's cart into an order a warehouse can ship. Taking the payment is one step of it. The harder part is the stock count. Two customers can try to buy the last unit within the same few milliseconds, and the count has to give the unit to exactly one of them. A customer who starts checking out should still have their item when they reach the Pay button. A unit held for a customer who walks away has to go back on sale. This case study builds checkout and inventory for a large online retailer: two million orders a day across twelve warehouses, and a limited sneaker release where 300,000 people try to buy 5,000 pairs in the first minute. No order is ever confirmed for stock that doesn't exist.

<!-- tab:requirements:Requirements -->

## Requirements

This case study builds checkout and inventory for an online retailer that sells home goods, clothing and shoes from its own twelve warehouses. Checkout turns a cart into an order. Inventory owns the stock count for every product in every warehouse. Payments go through the payment service from the [Payment Processing](#/systems-case-studies/payment-processing) case study, which this design calls but doesn't rebuild.

### Functional requirements

- **Show availability** on product pages and in the cart.
- **Hold stock during checkout.** A customer who starts checking out has their items held for a fixed time, so the stock can't sell out while they type their address.
- **Place an order**: hold the stock, take the payment, confirm the order, and tell the warehouse to ship it.
- **Release stock** from checkouts that are abandoned, declined or cancelled, so it goes back on sale.
- **Record every change to stock**: sales, restocks, returns, damage and the warehouse's own counts.
- **Run limited releases**: a fixed quantity of one product goes on sale at a set time.

### Non-functional requirements

- **Correctness:** an order is never confirmed for a unit that doesn't exist. Every unit is always in exactly one place: on sale, held, sold and waiting to ship, or shipped.
- **Availability:** 99.95% for checkout.
- **Latency:** starting checkout, which holds the stock, under 100ms at p99. Placing the order takes about a second, nearly all of it the payment.
- **Throughput:** 600 checkouts started a second at a holiday sale's peak. A limited release must survive 300,000 shoppers in its first minute.
- **Fairness:** in a limited release, a shopper's place in line doesn't depend on who refreshes fastest, and each customer can buy at most one.
- **Freshness:** availability on product pages may be a few seconds out of date. The stock count used at checkout never is.

### In scope

Holding stock, the conditional updates that stop two buyers taking one unit, holds that expire, the order's journey across the order, inventory and payment services, and limited releases on one product.

### Out of scope

**The catalog and search.** **Pricing and promotions**: checkout asks a pricing service for the price. **How payments work**: covered in Payment Processing. **Picking, packing and shipping** inside the warehouse, beyond telling inventory when a unit has shipped. **Tax.** **Returns** beyond putting a returned unit back on sale.

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

The numbers that shape inventory aren't storage. The whole stock count fits in memory on one machine. They are how many buyers want the same unit at the same moment, and how long each one keeps it from everyone else.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Orders</div>
<div class="stat-tile-value">~2<span class="stat-tile-unit">M/day</span></div>
<div class="stat-tile-sub">~23 a second on average</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Holds at peak</div>
<div class="stat-tile-value">~600<span class="stat-tile-unit">/s</span></div>
<div class="stat-tile-sub">checkouts started, holiday sale</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Availability reads</div>
<div class="stat-tile-value">~50<span class="stat-tile-unit">K/s</span></div>
<div class="stat-tile-sub">at peak, from product pages</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Stock rows</div>
<div class="stat-tile-value">~20<span class="stat-tile-unit">M</span></div>
<div class="stat-tile-sub">~2GB in all</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">One row's limit</div>
<div class="stat-tile-value">~500<span class="stat-tile-unit">/s</span></div>
<div class="stat-tile-sub">2ms per committed update</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Limited release</div>
<div class="stat-tile-value">60<span class="stat-tile-unit">per pair</span></div>
<div class="stat-tile-sub">300,000 shoppers, 5,000 pairs</div>
</div>
</div>

### Assumptions

- **2 million** orders a day, averaging **1.5 items** and **$60**.
- **40%** of checkouts started are abandoned before payment.
- A holiday sale pushes traffic to about **15×** the daily average for a few hours.
- **400 million** product page views a day, each showing availability.
- **5 million** products, each stocked in about **4** of the 12 warehouses.
- A stock row is about **100 bytes**.
- A committed update takes about **2ms**, including a synchronous replica in another zone.
- A hold lasts **10 minutes** while the customer checks out.

### Checkouts and holds

2 million orders a day, with 40% of checkouts abandoned, means about **3.3 million checkouts started a day**, around 38 a second. A holiday sale's 15× makes that about **600 a second**. Every one of them holds stock for up to 10 minutes, so at the peak up to **360,000 holds** are outstanding at once. About **1.3 million holds a day** expire without an order.

### Availability reads

400 million page views is about 4,600 a second on average, and about **50,000 a second** at a sale's peak. That is about 200 availability reads for every order placed, so they can't all go to the database that decides who gets the last unit.

### The stock count

5 million products in about 4 warehouses each is **20 million rows**. At 100 bytes each that is **2GB**: small enough for one database to keep entirely in memory. Inventory isn't large. It's contended.

### One row

A database can commit thousands of updates a second across different rows, but updates to one row take turns. Each holds the row's lock until it commits, about 2ms with the replica, so one row takes about **500 updates a second**. A normal product sees a few a minute. A limited release puts every buyer on the same row at the same second: 300,000 shoppers in a minute is 5,000 a second, ten times what that row can take, for 5,000 pairs.

<!-- tab:api-design:API Design -->

## API Design

Customers call checkout through the retailer's own site and apps. The inventory API is internal: only the order service and the warehouses call it. Quantities are whole units; prices are integers in the currency's smallest unit, as in Payment Processing.

### Checkout

```
POST /v1/checkouts
Idempotency-Key: ck_c88_19
{"cart_id": "cart_c88"}
→ 201 {"order_id": "ord_7310", "status": "held", "hold_expires_at": "14:12:00",
       "items": [{"sku": "L-204", "qty": 1, "unit_price": 6000}], "total": 6000}
→ 409 {"error": "insufficient_stock", "items": [{"sku": "L-204", "available": 0}]}

POST /v1/orders/ord_7310/place
Idempotency-Key: ck_c88_19
{"payment_method": "tok_8Hq"}
→ 201 {"order_id": "ord_7310", "status": "confirmed"}
→ 202 {"order_id": "ord_7310", "status": "processing"}        payment outcome not known yet
→ 402 {"order_id": "ord_7310", "status": "awaiting_payment",
       "decline_code": "insufficient_funds"}                    still held: try another card
→ 410 {"error": "hold_expired"}

GET /v1/orders/ord_7310
→ 200 {"order_id": "ord_7310", "status": "confirmed", "items": […]}
```

### Inventory

```
POST /v1/holds
{"hold_id": "ord_7310", "items": [{"sku": "L-204", "qty": 1}], "ttl_s": 600,
 "ship_to": "10115"}
→ 201 {"hold_id": "ord_7310", "expires_at": "14:12:00",
       "lines": [{"sku": "L-204", "warehouse": "east", "qty": 1}]}
→ 409 {"error": "insufficient_stock", "items": [{"sku": "L-204", "available": 0}]}

POST /v1/holds/ord_7310/extend     {"ttl_s": 1800}   → 200 | 410 expired
POST /v1/holds/ord_7310/commit                       → 200 | 410 expired
POST /v1/holds/ord_7310/release                      → 200, also if already released

POST /v1/stock/L-204/east/movements
{"ref": "rcv_5521", "kind": "receive", "qty": 20}
→ 201

GET /v1/availability?skus=L-204,B-9
→ 200 {"L-204": {"available": 3, "as_of": "14:02:07"}, "B-9": {"available": 0, …}}
```

| Code | Meaning |
|---|---|
| `200` | Done |
| `201` | Created: order held, order confirmed, hold placed, movement recorded |
| `202` | Order placed, payment outcome not known yet |
| `400` | Malformed request |
| `402` | Payment declined: the order stays held until the hold expires |
| `409` | Not enough stock for one or more items |
| `410` | The hold has expired |
| `422` | Key reused with a different request |
| `429` | Over the caller's request rate, or not admitted yet during a limited release |

### Why the details matter

**The order ID is the hold ID.** A hold is created, extended, committed and released by naming the order it belongs to. A retried hold request for ord_7310 finds the hold already there instead of holding a second unit.

**`409` comes before any payment.** A customer is told an item is gone at the start of checkout, before they enter anything, rather than after they've paid.

**A decline keeps the hold.** The customer can try another card without losing the item. The hold still expires on time if they don't.

**`release` succeeds if there is nothing to release.** It is called by abandoned checkouts, cancellations and the order service's own retries, and calling it twice is harmless.

**Stock changes are movements, not new totals.** A warehouse reports "20 received", never "there are now 25". A total computed elsewhere is out of date by the time it arrives.

**Availability carries `as_of`.** The number on a product page is a recent reading, not a promise. Only a hold is a promise.

<!-- tab:data-model:Data Model -->

## Data Model

Inventory lives in its own relational database, owned by the inventory service. Orders live in the order service's database. From Stage 4 the two are separate, and no transaction spans them.

### Stock

```
stock                                   -- one row per product per warehouse
  sku              TEXT                 -- L-204
  warehouse        TEXT                 -- east
  bucket           SMALLINT DEFAULT 0   -- above 0 only for limited releases (Stage 5)
  on_hand          INT                  -- physically on the shelf
  held             INT                  -- held by checkouts not yet paid
  allocated        INT                  -- paid for, waiting to ship
  PRIMARY KEY (sku, warehouse, bucket)
  CHECK (held >= 0 AND allocated >= 0 AND held + allocated <= on_hand)
  -- available to sell = on_hand - held - allocated

holds
  hold_id          TEXT                 -- ord_7310
  sku              TEXT
  warehouse        TEXT
  bucket           SMALLINT
  qty              INT
  status           TEXT                 -- held | allocated | released | expired
  expires_at       TIMESTAMP
  PRIMARY KEY (hold_id, sku)
  INDEX (status, expires_at)            -- for the expiry sweeper

stock_movements                         -- never updated, never deleted
  movement_id      BIGSERIAL PRIMARY KEY
  sku              TEXT
  warehouse        TEXT
  kind             TEXT                 -- hold | release | expire | allocate | ship |
                                        -- receive | return | damage | count
  qty              INT
  ref              TEXT                 -- ord_7310, rcv_5521, …
  created_at       TIMESTAMP
  UNIQUE (ref, sku, warehouse, kind)
```

One lamp, L-204, in the east warehouse, as it moves:

```
                                   on_hand  held  allocated  available
3 on the shelf                        3       0       0          3
ord_7310 starts checkout              3       1       0          2
ord_7310 is paid                      3       0       1          2
the warehouse ships it                2       0       0          2
```

### Orders

```
orders
  order_id         TEXT PRIMARY KEY     -- ord_7310
  customer_id      TEXT
  idempotency_key  TEXT
  status           TEXT                 -- held | awaiting_payment | confirmed |
                                        -- cancelled | shipped
  total            BIGINT
  currency         CHAR(3)
  payment_id       TEXT                 -- from the payment service
  UNIQUE (customer_id, idempotency_key)

order_items
  order_id         TEXT
  sku              TEXT
  qty              INT
  unit_price       BIGINT               -- the price when checkout started, never re-read

saga_steps                              -- the order's progress across services
  order_id         TEXT
  step             TEXT                 -- hold | authorize | commit | confirm |
                                        -- void | release | cancel
  status           TEXT                 -- requested | done | failed
  attempts         INT
  updated_at       TIMESTAMP
  PRIMARY KEY (order_id, step)

outbox                                  -- events for fulfilment, email, …
  id               BIGSERIAL PRIMARY KEY
  topic            TEXT                 -- order.confirmed
  payload          JSONB
  sent_at          TIMESTAMP
```

### Why this storage

Every rule that stops overselling is a database guarantee: a conditional update that only succeeds while units remain, a status change that only happens once, a hold and its count change committed together. That needs a relational database with real transactions ([Relational Databases](#/systems/databases-relational)). The `CHECK` constraint is a second line of defence: even a buggy update can't commit more held units than are on the shelf. The whole stock table is about 2GB, so one primary holds it in memory, with a synchronous replica in another zone ([Replication](#/systems/replication)). Size never forces inventory to be sharded. One very popular product can force it to be split, which Stage 5 does.

<!-- tab:architecture:Architecture:default -->

This case study builds checkout and inventory up in five stages. Each stage fixes a specific failure of the one before. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one request at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. Check, Then Write -->

## Stage 1 — Check the Stock, Then Write It

The simplest checkout reads the stock count, checks there's enough, charges the card, and writes the new count back. Stock and orders live in the shop's one database.

```
qty = db.query("SELECT quantity FROM stock WHERE sku = 'L-204'")       → 1
if qty >= 1:
    payments.charge(6000, "tok_8Hq")                                    ~600ms
    db.exec("UPDATE stock SET quantity = %d WHERE sku = 'L-204'", qty - 1)
    db.exec("INSERT INTO orders …")
```

Warehouses report deliveries through a receiving job that does the same: read the count, add what arrived, write the total.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 780 320" width="780" height="320" role="img" aria-label="A customer checks out through an app server, which reads stock from the shop database, charges through the payment service, then writes the new stock count; a receiving job also reads and writes the stock count">
  <rect x="20" y="130" width="140" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="156" text-anchor="middle" class="d-actor-label" font-size="12">Customer</text>
  <text x="90" y="173" text-anchor="middle" class="d-label-muted" font-size="9">browser</text>
  <g data-fail-toggle="app1">
    <rect x="260" y="105" width="180" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="350" y="134" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
    <text x="350" y="152" text-anchor="middle" class="d-label-muted" font-size="9">reads the count</text>
    <text x="350" y="167" text-anchor="middle" class="d-label-muted" font-size="9">charges · writes count − 1</text>
  </g>
  <g data-fail-toggle="pay1">
    <rect x="580" y="25" width="180" height="64" rx="6" class="d-actor-box"></rect>
    <text x="670" y="52" text-anchor="middle" class="d-actor-label" font-size="12">Payment Service</text>
    <text x="670" y="69" text-anchor="middle" class="d-label-muted" font-size="9">charges the card</text>
  </g>
  <g data-fail-toggle="db1">
    <rect x="580" y="200" width="180" height="90" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="670" y="230" text-anchor="middle" class="d-actor-label" font-size="12">Shop DB</text>
    <text x="670" y="248" text-anchor="middle" class="d-label-muted" font-size="9">stock · orders</text>
    <text x="670" y="263" text-anchor="middle" class="d-label-muted" font-size="9">one quantity per product</text>
  </g>
  <g data-fail-toggle="rcv1">
    <rect x="260" y="236" width="180" height="56" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="350" y="260" text-anchor="middle" class="d-actor-label" font-size="12">Receiving Job</text>
    <text x="350" y="276" text-anchor="middle" class="d-label-muted" font-size="9">records deliveries</text>
  </g>
  <line id="c1-c-app" x1="162" y1="148" x2="256" y2="148" class="d-msg d-request" data-depends-on="app1" marker-end="url(#arrowC1)"></line>
  <line id="c1-app-c" x1="256" y1="175" x2="162" y2="175" class="d-msg d-response" data-depends-on="app1" marker-end="url(#arrowC1r)"></line>
  <line id="c1-app-pay" x1="442" y1="125" x2="576" y2="60" class="d-msg d-request" data-depends-on="app1 pay1" marker-end="url(#arrowC1)"></line>
  <line id="c1-pay-app" x1="576" y1="78" x2="442" y2="142" class="d-msg d-response" data-depends-on="app1 pay1" marker-end="url(#arrowC1r)"></line>
  <line id="c1-app-db" x1="442" y1="165" x2="576" y2="215" class="d-msg d-request" data-depends-on="app1 db1" marker-end="url(#arrowC1)"></line>
  <line id="c1-db-app" x1="576" y1="232" x2="442" y2="185" class="d-msg d-response" data-depends-on="app1 db1" marker-end="url(#arrowC1r)"></line>
  <line id="c1-rcv-db" x1="442" y1="256" x2="576" y2="256" class="d-msg d-request" data-depends-on="rcv1 db1" marker-end="url(#arrowC1)"></line>
  <line id="c1-db-rcv" x1="576" y1="276" x2="442" y2="276" class="d-msg d-response" data-depends-on="rcv1 db1" marker-end="url(#arrowC1r)"></line>
  <text x="390" y="314" text-anchor="middle" class="d-label-muted" font-size="10">play a normal order, then two buyers for the last lamp, then a delivery during an order</text>
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
{"id": "db", "title": "Shop DB", "rows": [["L-204 quantity", "—"], ["orders for L-204", "—"]]},
{"id": "shelf", "title": "Warehouse shelf", "rows": [["L-204 lamps", "—"]]}
],
"flows": [
{
"id": "normal",
"label": "Buy the last lamp",
"nodes": ["app1", "pay1", "db1"],
"steps": [
{"el": "c1-c-app", "payload": "Buy 1 × lamp L-204 · $60", "set": {"db.L-204 quantity": "1", "db.orders for L-204": "none", "shelf.L-204 lamps": "1"}, "text": "A customer buys an oak desk lamp, L-204, for $60. There is one left in the warehouse."},
{"el": "c1-app-db", "payload": "SELECT quantity · L-204", "text": "The app server reads the stock count."},
{"el": "c1-db-app", "payload": "1", "ms": 2, "text": "One lamp left, so the order can go ahead."},
{"el": "c1-app-pay", "payload": "charge $60 · ord_7310", "text": "The app server asks the payment service to charge the card."},
{"el": "c1-pay-app", "payload": "succeeded", "ms": 600, "text": "The charge succeeds. It took about 600ms, nearly all of it at the card processor and the bank."},
{"el": "c1-app-db", "payload": "quantity = 0 · insert ord_7310", "set": {"db.L-204 quantity": "0", "db.orders for L-204": "ord_7310"}, "text": "The app server writes the new count, 1 − 1 = 0, and records the order."},
{"el": "c1-db-app", "payload": "ok", "ms": 3, "text": "Saved."},
{"el": "c1-app-c", "payload": "Order confirmed", "text": "One lamp, one order, a count of zero. With one customer at a time, this is correct."}
]
},
{
"id": "race",
"label": "Two buyers, one lamp",
"nodes": ["app1", "pay1", "db1"],
"steps": [
{"el": "c1-c-app", "payload": "2 × Buy L-204 · 40ms apart", "set": {"db.L-204 quantity": "1", "db.orders for L-204": "none", "shelf.L-204 lamps": "1"}, "text": "Two customers buy the last lamp 40 milliseconds apart. Their requests reach two app servers running the same code."},
{"el": "c1-app-db", "payload": "2 × SELECT quantity", "text": "Each reads the stock count."},
{"el": "c1-db-app", "payload": "1 · 1", "ms": 2, "text": "Both read 1. Neither has written anything yet, so the database has nothing else to tell them."},
{"el": "c1-app-pay", "payload": "2 × charge $60", "text": "Both go ahead and charge their customer's card."},
{"el": "c1-pay-app", "payload": "succeeded · succeeded", "ms": 600, "text": "Both charges succeed. The gap between reading the count and writing it is the whole 600ms of the payment, and any buyer who reads the count during it sees the same 1."},
{"el": "c1-app-db", "payload": "quantity = 0 · quantity = 0 · 2 orders", "set": {"db.L-204 quantity": "0", "db.orders for L-204": "ord_7310 · ord_7311"}, "text": "Both write 1 − 1 = 0, and both record an order. The count says zero, which looks right, and hides that two lamps were sold."},
{"el": "c1-app-c", "payload": "2 × Order confirmed", "text": "Two customers have paid for one lamp. The warehouse finds out when it can't fill the second order, and that customer gets an apology and a refund days later. On a quiet day this is rare. In a sale, with hundreds of buyers reading the same count during each other's payments, it happens all the time."}
]
},
{
"id": "lost",
"label": "A delivery during an order",
"nodes": ["app1", "pay1", "db1", "rcv1"],
"steps": [
{"el": "c1-app-db", "payload": "SELECT quantity · L-204", "set": {"db.L-204 quantity": "5", "db.orders for L-204": "none", "shelf.L-204 lamps": "5"}, "text": "There are 5 lamps. A customer orders one, and the app server reads the count."},
{"el": "c1-db-app", "payload": "5", "ms": 2, "text": "It reads 5."},
{"el": "c1-app-pay", "payload": "charge $60 · ord_7312", "text": "It calls the payment service."},
{"el": "c1-rcv-db", "payload": "SELECT quantity · L-204", "set": {"shelf.L-204 lamps": "25"}, "text": "While the charge is in progress, a delivery of 20 lamps is put on the shelf, and the receiving job records it. It reads the count first."},
{"el": "c1-db-rcv", "payload": "5", "ms": 2, "text": "It also reads 5."},
{"el": "c1-rcv-db", "payload": "quantity = 25", "set": {"db.L-204 quantity": "25"}, "text": "It writes 5 + 20 = 25."},
{"el": "c1-pay-app", "payload": "succeeded", "ms": 600, "text": "The customer's charge succeeds."},
{"el": "c1-app-db", "payload": "quantity = 4 · insert ord_7312", "set": {"db.L-204 quantity": "4", "db.orders for L-204": "ord_7312", "shelf.L-204 lamps": "25 (24 after shipping)"}, "text": "The app server writes 5 − 1 = 4, computed from a count that was already out of date. The delivery has vanished from the books."},
{"el": "c1-app-c", "payload": "Order confirmed", "text": "The shelf will hold 24 lamps and the count says 4. Twenty lamps can't be sold until someone counts the shelf by hand. Each writer replaced the count with a number it worked out from an earlier read, so whichever wrote last erased the other's change."}
]
}
]
}
</script>
<div class="diagram-caption">The app server reads the stock count, charges the card, then writes back the count minus one. The receiving job writes back the count plus each delivery. Both compute the new count from a read made earlier.</div>
</div>

<div class="fail-hint">Click the app server, the payment service, the shop DB or the receiving job to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="app1">
<strong>If the app server fails:</strong> an order caught between the charge and the write is left charged with no order and no change to the count. The payment service knows about the charge; the shop doesn't.
</div>
<div class="failure-impact is-hidden" data-component="pay1">
<strong>If the payment service fails:</strong> no orders can be placed. The stock count is untouched, because nothing is written until the charge succeeds.
</div>
<div class="failure-impact is-hidden" data-component="db1">
<strong>If the shop DB fails:</strong> checkout stops, and any order already charged can't be recorded.
</div>
<div class="failure-impact is-hidden" data-component="rcv1">
<strong>If the receiving job fails:</strong> deliveries sit on the shelf without being added to the count, so products show as sold out while stock is there.
</div>
</div>

Stage 1 oversells and loses deliveries, and both come from the same pattern: read the count, decide, then write a new total. Between the read and the write, someone else can change the count, and the write erases what they did. The check and the change have to be one indivisible step, done where the count lives.

<!-- stage:2:2. Conditional Decrement -->

## Stage 2 — An Inventory Service with a Conditional Decrement

- **An inventory service owns the stock count.** Checkout and the warehouses ask it to change stock; nothing else writes the table.
- **The check and the change are one statement.** `UPDATE stock SET quantity = quantity - 1 WHERE sku = 'L-204' AND quantity >= 1`. The database runs the condition against the current value, under the row's lock, and reports how many rows changed: 1 means the unit was taken, 0 means there wasn't one.
- **Every change is a delta**, never a new total. A delivery is `quantity = quantity + 20`, so it can't erase a sale made at the same moment.
- **Stock is taken before the card is charged.** If the charge fails, the unit is put back. The retailer would rather keep a unit off sale for a second than take money for one it doesn't have.
- **Every change is a movement row**, written in the same transaction, with a unique key on the order and the kind of change. A retried decrement or a repeated put-back applies once.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 820 330" width="820" height="330" role="img" aria-label="Checkout asks the inventory service to take a unit, which applies a conditional decrement in the inventory database, then charges the card through the payment service">
  <rect x="20" y="130" width="130" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="85" y="156" text-anchor="middle" class="d-actor-label" font-size="12">Customer</text>
  <text x="85" y="173" text-anchor="middle" class="d-label-muted" font-size="9">browser</text>
  <g data-fail-toggle="ck2">
    <rect x="200" y="130" width="140" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="270" y="156" text-anchor="middle" class="d-actor-label" font-size="12">Checkout</text>
    <text x="270" y="173" text-anchor="middle" class="d-label-muted" font-size="9">take stock, then pay</text>
  </g>
  <g data-fail-toggle="inv2">
    <rect x="420" y="115" width="170" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="505" y="143" text-anchor="middle" class="d-actor-label" font-size="12">Inventory Service</text>
    <text x="505" y="161" text-anchor="middle" class="d-label-muted" font-size="9">only writer of stock</text>
    <text x="505" y="176" text-anchor="middle" class="d-label-muted" font-size="9">changes by delta</text>
  </g>
  <g data-fail-toggle="idb2">
    <rect x="420" y="250" width="170" height="60" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="505" y="276" text-anchor="middle" class="d-actor-label" font-size="12">Inventory DB</text>
    <text x="505" y="293" text-anchor="middle" class="d-label-muted" font-size="9">stock · movements</text>
  </g>
  <g data-fail-toggle="pay2">
    <rect x="650" y="30" width="150" height="64" rx="6" class="d-actor-box"></rect>
    <text x="725" y="57" text-anchor="middle" class="d-actor-label" font-size="12">Payment Service</text>
    <text x="725" y="74" text-anchor="middle" class="d-label-muted" font-size="9">charges the card</text>
  </g>
  <line id="c2-cu-ck" x1="152" y1="150" x2="196" y2="150" class="d-msg d-request" data-depends-on="ck2" marker-end="url(#arrowC2)"></line>
  <line id="c2-ck-cu" x1="196" y1="172" x2="152" y2="172" class="d-msg d-response" data-depends-on="ck2" marker-end="url(#arrowC2r)"></line>
  <line id="c2-ck-inv" x1="342" y1="145" x2="416" y2="145" class="d-msg d-request" data-depends-on="ck2 inv2" marker-end="url(#arrowC2)"></line>
  <line id="c2-inv-ck" x1="416" y1="175" x2="342" y2="175" class="d-msg d-response" data-depends-on="ck2 inv2" marker-end="url(#arrowC2r)"></line>
  <line id="c2-inv-db" x1="480" y1="207" x2="480" y2="246" class="d-msg d-request" data-depends-on="inv2 idb2" marker-end="url(#arrowC2)"></line>
  <line id="c2-db-inv" x1="530" y1="246" x2="530" y2="207" class="d-msg d-response" data-depends-on="inv2 idb2" marker-end="url(#arrowC2r)"></line>
  <path id="c2-ck-pay" d="M250,128 L250,50 L646,50" class="d-msg d-request" data-depends-on="ck2 pay2" marker-end="url(#arrowC2)"></path>
  <path id="c2-pay-ck" d="M646,76 L295,76 L295,126" class="d-msg d-response" data-depends-on="ck2 pay2" marker-end="url(#arrowC2r)"></path>
  <text x="410" y="324" text-anchor="middle" class="d-label-muted" font-size="10">play two buyers for one lamp, then a declined card, then a crash after taking stock</text>
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
{"id": "inv", "title": "Inventory DB", "rows": [["L-204 quantity", "—"], ["latest movement", "—"]]},
{"id": "ord", "title": "Orders", "rows": [["customer 1", "—"], ["customer 2", "—"]]}
],
"flows": [
{
"id": "race",
"label": "Two buyers, one lamp",
"nodes": ["ck2", "inv2", "idb2", "pay2"],
"steps": [
{"el": "c2-cu-ck", "payload": "2 × Buy L-204 · 40ms apart", "set": {"inv.L-204 quantity": "1", "inv.latest movement": "—", "ord.customer 1": "—", "ord.customer 2": "—"}, "text": "The same two customers, the same last lamp, 40 milliseconds apart."},
{"el": "c2-ck-inv", "payload": "take 1 · ord_7310 · take 1 · ord_7311", "text": "Checkout asks the inventory service for one lamp for each order, before charging anyone."},
{"el": "c2-inv-db", "payload": "2 × UPDATE … quantity - 1 WHERE quantity >= 1", "text": "Both updates reach the database at nearly the same moment. Each one locks the row before it checks the condition, so the second waits for the first to finish."},
{"el": "c2-db-inv", "payload": "1 row changed · 0 rows changed", "ms": 3, "set": {"inv.L-204 quantity": "0", "inv.latest movement": "take · ord_7310"}, "text": "The first finds a quantity of 1, takes it, and commits along with its movement row. The second then checks its condition against the new value, 0, and changes nothing. There's no gap between checking and changing for anyone to slip into."},
{"el": "c2-inv-ck", "payload": "ok · out of stock", "ms": 1, "set": {"ord.customer 2": "told sold out · not charged"}, "text": "The inventory service tells checkout: the first order has its lamp, the second doesn't."},
{"el": "c2-ck-pay", "payload": "charge $60 · ord_7310", "text": "Only the first order is charged."},
{"el": "c2-pay-ck", "payload": "succeeded", "ms": 600, "set": {"ord.customer 1": "ord_7310 confirmed"}, "text": "The charge succeeds."},
{"el": "c2-ck-cu", "payload": "Confirmed · Sold out", "text": "One lamp, one order. The second customer is told it's sold out before their card is touched."}
]
},
{
"id": "decline",
"label": "A declined card",
"nodes": ["ck2", "inv2", "idb2", "pay2"],
"steps": [
{"el": "c2-ck-inv", "payload": "take 1 · ord_7310", "set": {"inv.L-204 quantity": "1", "inv.latest movement": "—", "ord.customer 1": "—", "ord.customer 2": "—"}, "text": "One lamp left. A customer clicks Pay, and checkout takes the lamp first."},
{"el": "c2-inv-db", "payload": "quantity - 1 + movement take · ord_7310", "text": "The decrement and its movement row commit in one transaction."},
{"el": "c2-db-inv", "payload": "1 row changed", "ms": 3, "set": {"inv.L-204 quantity": "0", "inv.latest movement": "take · ord_7310"}, "text": "The lamp is off sale."},
{"el": "c2-inv-ck", "payload": "ok", "ms": 1, "text": "Checkout has its lamp."},
{"el": "c2-ck-pay", "payload": "charge $60 · ord_7310", "text": "It charges the card."},
{"el": "c2-pay-ck", "payload": "declined · insufficient_funds", "ms": 600, "set": {"ord.customer 1": "declined"}, "text": "The card's bank declines."},
{"el": "c2-ck-inv", "payload": "put back 1 · ord_7310", "text": "Checkout asks for the lamp to be put back."},
{"el": "c2-inv-db", "payload": "quantity + 1 + movement put_back · ord_7310", "text": "The put-back is a delta too, with its own movement row. The unique key on the order and the kind of change means a repeated put-back, after a timeout say, finds its movement already there and adds nothing."},
{"el": "c2-db-inv", "payload": "1 row changed", "ms": 3, "set": {"inv.L-204 quantity": "1", "inv.latest movement": "put_back · ord_7310"}, "text": "The lamp is on sale again, about 600ms after it was taken."},
{"el": "c2-ck-cu", "payload": "Card declined", "text": "The customer is told their card was declined. If they try another card now, the lamp may already be gone, and they'll have filled in the whole checkout to find out."}
]
},
{
"id": "crash",
"label": "A crash after taking stock",
"nodes": ["ck2", "inv2", "idb2", "pay2"],
"steps": [
{"el": "c2-ck-inv", "payload": "take 1 · ord_7310", "set": {"inv.L-204 quantity": "1", "inv.latest movement": "—", "ord.customer 1": "—", "ord.customer 2": "—"}, "text": "One lamp left. A customer clicks Pay, and checkout takes the lamp."},
{"el": "c2-inv-db", "payload": "quantity - 1 + movement take · ord_7310", "text": "The decrement commits."},
{"el": "c2-db-inv", "payload": "1 row changed", "ms": 3, "set": {"inv.L-204 quantity": "0", "inv.latest movement": "take · ord_7310"}, "text": "The lamp is off sale, held for ord_7310."},
{"el": "c2-inv-ck", "payload": "ok", "ms": 1, "text": "Inventory tells checkout it has the lamp."},
{"el": "c2-ck-pay", "payload": "(never sent: process stopped)", "text": "Before checkout can call the payment service, its process is stopped by a routine deploy. The order existed only in that process's memory."},
{"el": "c2-ck-cu", "payload": "(connection dropped)", "set": {"ord.customer 1": "none · error page"}, "text": "The customer sees an error and leaves. The lamp is still on the shelf, but the count says zero, and nothing will ever put it back: the only thing that knew to was the process that stopped. Every deploy and every crash strands a few units this way, until a warehouse count finds them. The stock count needs to know who took each unit, and when to give it back if they never finish."}
]
}
]
}
</script>
<div class="diagram-caption">Checkout asks the inventory service to take a unit before charging. The inventory service takes it with one conditional update, so the check and the change can't be separated, and puts it back if the charge fails.</div>
</div>

<div class="fail-hint">Click checkout, the inventory service, the inventory DB or the payment service to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="ck2">
<strong>If checkout fails:</strong> any order between taking stock and finishing payment strands its units: off sale, on the shelf, and owned by nobody. Replay the third flow.
</div>
<div class="failure-impact is-hidden" data-component="inv2">
<strong>If the inventory service fails:</strong> no orders can be placed, because no unit can be taken. Nothing is oversold.
</div>
<div class="failure-impact is-hidden" data-component="idb2">
<strong>If the inventory DB fails:</strong> the same: checkout stops until its replica in another zone takes over, with every committed change.
</div>
<div class="failure-impact is-hidden" data-component="pay2">
<strong>If the payment service fails:</strong> orders take their stock, fail to charge, and put it back. Stock flickers off sale for each attempt, but nothing is lost or oversold.
</div>
</div>

The count can no longer oversell or lose a delivery. But a unit taken is held by nothing but a process's memory, so a crash strands it for good. And stock is only taken when the customer clicks Pay, after they've typed their address, chosen delivery and entered a card. The customer needs the item held from the moment checkout starts, and the hold needs an owner and an end.

<!-- stage:3:3. Holds That Expire -->

## Stage 3 — Holds That Expire

- **Three numbers per row.** `on_hand` is what's on the shelf, `held` is what checkouts are holding, `allocated` is what's been paid for and is waiting to ship. What can be sold is `on_hand − held − allocated`.
- **Stock is held when checkout starts.** Checkout creates the order, ord_7310, and asks inventory to hold its items. The hold is a row in the holds table, keyed by the order ID, inserted in the same transaction as the conditional `held = held + 1`. It expires in 10 minutes.
- **Placing the order extends the hold** to 30 minutes, so a payment waiting on the customer's bank doesn't lose its item.
- **Payment commits the hold.** `held` goes down and `allocated` goes up, in one transaction, only if the hold's status is still `held`.
- **A decline keeps the hold**, so the customer can try another card.
- **An expiry sweeper** runs every 10 seconds, finds holds past their expiry, and releases them: status to `expired`, `held` down by the quantity, only if the status is still `held`.
- **When the warehouse ships**, `on_hand` and `allocated` both go down.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 840 380" width="840" height="380" role="img" aria-label="Checkout asks the inventory service to hold stock when checkout starts and to commit the hold after payment; an expiry sweeper releases holds that run out">
  <rect x="20" y="55" width="130" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="85" y="81" text-anchor="middle" class="d-actor-label" font-size="12">Customer</text>
  <text x="85" y="98" text-anchor="middle" class="d-label-muted" font-size="9">browser</text>
  <g data-fail-toggle="ck3">
    <rect x="200" y="45" width="160" height="80" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="280" y="73" text-anchor="middle" class="d-actor-label" font-size="12">Checkout</text>
    <text x="280" y="91" text-anchor="middle" class="d-label-muted" font-size="9">holds when checkout starts</text>
    <text x="280" y="106" text-anchor="middle" class="d-label-muted" font-size="9">commits after payment</text>
  </g>
  <g data-fail-toggle="pay3">
    <rect x="640" y="40" width="180" height="64" rx="6" class="d-actor-box"></rect>
    <text x="730" y="67" text-anchor="middle" class="d-actor-label" font-size="12">Payment Service</text>
    <text x="730" y="84" text-anchor="middle" class="d-label-muted" font-size="9">charges the card</text>
  </g>
  <g data-fail-toggle="inv3">
    <rect x="420" y="170" width="180" height="80" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="510" y="198" text-anchor="middle" class="d-actor-label" font-size="12">Inventory Service</text>
    <text x="510" y="216" text-anchor="middle" class="d-label-muted" font-size="9">hold · extend · commit</text>
    <text x="510" y="231" text-anchor="middle" class="d-label-muted" font-size="9">each hold has an expiry</text>
  </g>
  <g data-fail-toggle="idb3">
    <rect x="420" y="300" width="180" height="60" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="510" y="326" text-anchor="middle" class="d-actor-label" font-size="12">Inventory DB</text>
    <text x="510" y="343" text-anchor="middle" class="d-label-muted" font-size="9">stock · holds · movements</text>
  </g>
  <g data-fail-toggle="sw3">
    <rect x="660" y="300" width="160" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="740" y="326" text-anchor="middle" class="d-actor-label" font-size="12">Expiry Sweeper</text>
    <text x="740" y="343" text-anchor="middle" class="d-label-muted" font-size="9">every 10s</text>
  </g>
  <line id="c3-cu-ck" x1="152" y1="75" x2="196" y2="75" class="d-msg d-request" data-depends-on="ck3" marker-end="url(#arrowC3)"></line>
  <line id="c3-ck-cu" x1="196" y1="100" x2="152" y2="100" class="d-msg d-response" data-depends-on="ck3" marker-end="url(#arrowC3r)"></line>
  <line id="c3-ck-pay" x1="362" y1="65" x2="636" y2="62" class="d-msg d-request" data-depends-on="ck3 pay3" marker-end="url(#arrowC3)"></line>
  <line id="c3-pay-ck" x1="636" y1="86" x2="362" y2="95" class="d-msg d-response" data-depends-on="ck3 pay3" marker-end="url(#arrowC3r)"></line>
  <line id="c3-ck-inv" x1="320" y1="127" x2="450" y2="166" class="d-msg d-request" data-depends-on="ck3 inv3" marker-end="url(#arrowC3)"></line>
  <line id="c3-inv-ck" x1="485" y1="166" x2="350" y2="127" class="d-msg d-response" data-depends-on="ck3 inv3" marker-end="url(#arrowC3r)"></line>
  <line id="c3-inv-db" x1="490" y1="252" x2="490" y2="296" class="d-msg d-request" data-depends-on="inv3 idb3" marker-end="url(#arrowC3)"></line>
  <line id="c3-db-inv" x1="540" y1="296" x2="540" y2="252" class="d-msg d-response" data-depends-on="inv3 idb3" marker-end="url(#arrowC3r)"></line>
  <line id="c3-sw-db" x1="656" y1="320" x2="604" y2="320" class="d-msg d-request" data-depends-on="sw3 idb3" marker-end="url(#arrowC3)"></line>
  <line id="c3-db-sw" x1="604" y1="342" x2="656" y2="342" class="d-msg d-response" data-depends-on="sw3 idb3" marker-end="url(#arrowC3r)"></line>
  <text x="420" y="374" text-anchor="middle" class="d-label-muted" font-size="10">play a hold that's paid for, then an abandoned checkout, then a payment that outlives its hold</text>
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
{"id": "st", "title": "L-204 · east warehouse", "rows": [["on_hand", "—"], ["held", "—"], ["allocated", "—"], ["available", "—"]]},
{"id": "h", "title": "Holds", "rows": [["ord_7310", "—"], ["ord_7311", "—"]]}
],
"flows": [
{
"id": "paid",
"label": "A hold, paid for",
"nodes": ["ck3", "pay3", "inv3", "idb3"],
"steps": [
{"el": "c3-cu-ck", "payload": "Checkout · 1 × L-204", "set": {"st.on_hand": "3", "st.held": "0", "st.allocated": "0", "st.available": "3", "h.ord_7310": "—", "h.ord_7311": "—"}, "text": "Three lamps are on the shelf in the east warehouse. A customer with one in their cart clicks Checkout."},
{"el": "c3-ck-inv", "payload": "hold 1 × L-204 · ord_7310 · 10 min", "text": "Checkout creates order ord_7310 and asks inventory to hold the lamp for it, before showing the checkout page."},
{"el": "c3-inv-db", "payload": "held + 1 if available ≥ 1 · insert hold ord_7310", "text": "In one transaction: add one to held, but only if on_hand − held − allocated is at least 1, and insert the hold row with its expiry. The hold row's key is the order ID, so a retried request finds the hold already there."},
{"el": "c3-db-inv", "payload": "committed", "ms": 3, "set": {"st.held": "1", "st.available": "2", "h.ord_7310": "held · expires 14:12"}, "text": "The lamp is held until 14:12. It is still on the shelf, but no one else can buy it."},
{"el": "c3-inv-ck", "payload": "held until 14:12", "ms": 1, "text": "Inventory confirms the hold."},
{"el": "c3-ck-cu", "payload": "Checkout · your lamp is held for 10 min", "text": "The checkout page opens. The customer can take their time with the address and delivery options. Whatever happens on the site meanwhile, this lamp is theirs."},
{"el": "c3-cu-ck", "payload": "Place order · tok_8Hq", "text": "Four minutes later they click Place order."},
{"el": "c3-ck-inv", "payload": "extend ord_7310 · 30 min", "set": {"h.ord_7310": "held · expires 14:36"}, "text": "Checkout first extends the hold to 30 minutes, so a payment that waits on the customer's bank doesn't lose the lamp halfway through."},
{"el": "c3-ck-pay", "payload": "charge $60 · key ord_7310:pay", "text": "Then it asks the payment service for the charge, with an idempotency key made from the order ID."},
{"el": "c3-pay-ck", "payload": "succeeded", "ms": 600, "text": "The charge succeeds."},
{"el": "c3-ck-inv", "payload": "commit ord_7310", "text": "Checkout tells inventory the hold has been paid for."},
{"el": "c3-inv-db", "payload": "held − 1 · allocated + 1 if hold still held", "text": "In one transaction: the hold's status goes from held to allocated, and the count moves from held to allocated, but only if the status is still held."},
{"el": "c3-db-inv", "payload": "committed", "ms": 3, "set": {"st.held": "0", "st.allocated": "1", "h.ord_7310": "allocated"}, "text": "The lamp is sold and waiting to ship. When the warehouse ships it, on_hand and allocated both drop by one, to 2 and 0."},
{"el": "c3-ck-cu", "payload": "Order confirmed", "text": "Available stayed at 2 from the moment checkout started. The customer was never at risk of losing the lamp, and no one else was ever offered it."}
]
},
{
"id": "abandon",
"label": "An abandoned checkout",
"nodes": ["ck3", "inv3", "idb3", "sw3"],
"steps": [
{"el": "c3-cu-ck", "payload": "Checkout · 1 × L-204", "set": {"st.on_hand": "1", "st.held": "0", "st.allocated": "0", "st.available": "1", "h.ord_7310": "—", "h.ord_7311": "—"}, "text": "One lamp left. A customer starts checking out."},
{"el": "c3-ck-inv", "payload": "hold 1 × L-204 · ord_7310 · 10 min", "text": "Checkout holds it."},
{"el": "c3-inv-db", "payload": "held + 1 if available ≥ 1 · insert hold", "text": "The conditional update and the hold row, in one transaction."},
{"el": "c3-db-inv", "payload": "committed", "ms": 3, "set": {"st.held": "1", "st.available": "0", "h.ord_7310": "held · expires 14:12"}, "text": "Held until 14:12."},
{"el": "c3-ck-cu", "payload": "Checkout · held for 10 min", "text": "The checkout page opens, and the customer closes the tab without paying. Four in ten checkouts end this way."},
{"el": "c3-cu-ck", "payload": "Checkout · 1 × L-204 (customer 2)", "text": "At 14:05 a second customer tries to buy the lamp."},
{"el": "c3-ck-inv", "payload": "hold 1 × L-204 · ord_7311", "text": "Checkout asks for a hold."},
{"el": "c3-inv-db", "payload": "held + 1 if available ≥ 1", "text": "The conditional update finds nothing available."},
{"el": "c3-db-inv", "payload": "0 rows changed", "ms": 2, "text": "The only lamp is held by ord_7310."},
{"el": "c3-inv-ck", "payload": "409 · insufficient stock", "ms": 1, "set": {"h.ord_7311": "refused · sold out"}, "text": "Customer 2 is told it's sold out, before entering anything."},
{"el": "c3-sw-db", "payload": "holds held and past expires_at?", "ms": 420000, "text": "At 14:12, the sweeper's next pass asks for holds still held whose expiry has passed. The index on status and expiry makes this a short read, however many holds there are."},
{"el": "c3-db-sw", "payload": "ord_7310 · expired 14:12", "ms": 3, "text": "ord_7310 is one."},
{"el": "c3-sw-db", "payload": "ord_7310 → expired · held − 1 if still held", "set": {"st.held": "0", "st.available": "1", "h.ord_7310": "expired"}, "text": "The sweeper releases it with the same kind of conditional update. The lamp is back on sale, and the product page shows it in stock within seconds. If customer 2 comes back, they can buy it. Unlike Stage 2's stranded lamp, this one had an owner and an end, and the end arrived without anyone needing to remember it."}
]
},
{
"id": "late",
"label": "A payment that outlives its hold",
"nodes": ["ck3", "pay3", "inv3", "idb3", "sw3"],
"steps": [
{"el": "c3-cu-ck", "payload": "Place order · ord_7310", "set": {"st.on_hand": "1", "st.held": "1", "st.allocated": "0", "st.available": "0", "h.ord_7310": "held · expires 14:36", "h.ord_7311": "—"}, "text": "The last lamp is held by ord_7310. The customer has placed the order, and the hold has been extended to 14:36."},
{"el": "c3-ck-pay", "payload": "charge $60 · key ord_7310:pay", "text": "Checkout asks for the charge."},
{"el": "c3-pay-ck", "payload": "202 · processing", "ms": 10000, "text": "The card processor is in the middle of an outage. The payment service doesn't know whether the card was charged, so it answers processing and keeps asking the processor."},
{"el": "c3-ck-cu", "payload": "Processing…", "text": "The customer is told the payment is processing."},
{"el": "c3-sw-db", "payload": "holds held and past expires_at?", "ms": 1800000, "text": "The outage lasts 40 minutes. At 14:36 the sweeper finds ord_7310's hold past its expiry."},
{"el": "c3-db-sw", "payload": "ord_7310 · expired 14:36", "ms": 3, "text": "The sweeper doesn't know about payments. It only knows the hold ran out."},
{"el": "c3-sw-db", "payload": "ord_7310 → expired · held − 1", "set": {"st.held": "0", "st.allocated": "1", "st.available": "0", "h.ord_7310": "expired", "h.ord_7311": "held → allocated"}, "text": "It releases the hold. A minute later, another customer holds the lamp as ord_7311 and pays through the other processor, which is working. The lamp is sold to them."},
{"el": "c3-pay-ck", "payload": "succeeded · ord_7310 (40 min late)", "text": "The processor recovers. It had charged ord_7310's card before the outage, and the payment service now reports success."},
{"el": "c3-ck-inv", "payload": "commit ord_7310", "text": "Checkout tries to commit the hold."},
{"el": "c3-inv-db", "payload": "held → allocated if hold still held", "text": "The commit is conditional on the hold's status still being held."},
{"el": "c3-db-inv", "payload": "0 rows changed · expired", "ms": 2, "text": "It isn't. The sweeper and the commit both changed the status only if it was still held, so exactly one of them could win, and the sweeper got there first. There is no way for the lamp to end up both released and sold."},
{"el": "c3-inv-ck", "payload": "410 · expired · none available to re-hold", "ms": 1, "text": "Inventory tries to hold another lamp for the order instead, from what's available now. There isn't one."},
{"el": "c3-ck-pay", "payload": "refund $60 · key ord_7310:refund", "text": "So checkout refunds the charge."},
{"el": "c3-pay-ck", "payload": "refunded", "ms": 500, "text": "The refund goes through."},
{"el": "c3-ck-cu", "payload": "Sorry — sold out · refunded", "text": "The customer is told the lamp sold out and their money is on its way back. It's a bad outcome, and a rare one: it needs a payment that takes longer than 30 minutes, for an item with nothing left to replace it. The alternative, a hold that never expires while a payment is unknown, would let one processor outage take stock off sale indefinitely. Two refunds for one order are impossible, because the refund's key is made from the order ID too."}
]
}
]
}
</script>
<div class="diagram-caption">Checkout holds stock when the customer starts checking out, extends the hold when they place the order, and commits it after payment. Every hold has an expiry, and a sweeper releases holds that run out. The commit and the release are both conditional on the hold still being held, so only one of them can happen.</div>
</div>

<div class="fail-hint">Click checkout, the payment service, the inventory service, the inventory DB or the expiry sweeper to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="ck3">
<strong>If checkout fails:</strong> its holds are left with no one to commit or release them. They expire on their own, at most 30 minutes later, and their stock goes back on sale. A crash no longer strands a unit forever.
</div>
<div class="failure-impact is-hidden" data-component="pay3">
<strong>If the payment service fails:</strong> orders wait in processing while their holds count down. A short outage costs nothing. One longer than 30 minutes starts releasing holds, and some paid orders end in a refund. Replay the third flow.
</div>
<div class="failure-impact is-hidden" data-component="inv3">
<strong>If the inventory service fails:</strong> no checkout can start, because no stock can be held. Orders already held carry on, and commit once it's back.
</div>
<div class="failure-impact is-hidden" data-component="idb3">
<strong>If the inventory DB fails:</strong> the same, until its replica takes over with every committed hold.
</div>
<div class="failure-impact is-hidden" data-component="sw3">
<strong>If the expiry sweeper fails:</strong> expired holds aren't released, so abandoned checkouts keep their stock off sale. Products show as sold out with units on the shelf. Nothing is oversold, and a sweeper that comes back releases everything overdue in its first pass.
</div>
</div>

A hold now has an owner, an order, and an end. But checkout is still one program that talks to inventory and payments in sequence, and keeps where it's got to in memory. In a real retailer orders, inventory and payments are separate services with separate databases, owned by separate teams. No database transaction can cover all three. An order that crashes between the payment and the commit needs something that remembers where it was.

<!-- stage:4:4. A Checkout Saga -->

## Stage 4 — A Checkout Saga Across Three Services

- **Three services, three databases.** The order service owns orders. The inventory service owns stock. The payment service owns payments. Each changes only its own database.
- **Checkout is a saga**: a fixed sequence of steps, each one a local transaction in one service. Hold the stock, authorize the payment, commit the hold, confirm the order.
- **Every step has a compensating step** that undoes it: release the hold, void the authorization, cancel the order. If a step fails for good, the saga runs the compensations for the steps already done, in reverse.
- **The order service records each step** in the orders database before it calls the next service, and records the result when it comes back. Its progress survives a crash.
- **Every call carries a key made from the order and the step**: `ord_7310:hold`, `ord_7310:pay`, `ord_7310:commit`. Resending a step after a crash finds the original result instead of doing it twice ([Idempotency](#/systems/idempotency)).
- **The payment is authorized, not charged.** The card's bank holds the $60 without moving it, and the payment service captures it when the warehouse ships. A compensation then voids an authorization rather than refunding a charge.
- **A saga worker** finds sagas that haven't moved for 30 seconds and resumes them from their last recorded step.
- **Confirmation goes out through an outbox** in the orders database, so fulfilment hears about every confirmed order exactly when it's committed.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 380" width="860" height="380" role="img" aria-label="The order service runs checkout as a saga, recording each step in the orders database and calling the inventory service and the payment service; a saga worker resumes stalled sagas and an outbox tells fulfilment about confirmed orders">
  <rect x="20" y="55" width="130" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="85" y="81" text-anchor="middle" class="d-actor-label" font-size="12">Customer</text>
  <text x="85" y="98" text-anchor="middle" class="d-label-muted" font-size="9">browser</text>
  <g data-fail-toggle="os4">
    <rect x="210" y="45" width="180" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="300" y="74" text-anchor="middle" class="d-actor-label" font-size="12">Order Service</text>
    <text x="300" y="92" text-anchor="middle" class="d-label-muted" font-size="9">runs checkout as a saga</text>
    <text x="300" y="107" text-anchor="middle" class="d-label-muted" font-size="9">records every step</text>
  </g>
  <g data-fail-toggle="inv4">
    <rect x="660" y="40" width="180" height="64" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="750" y="67" text-anchor="middle" class="d-actor-label" font-size="12">Inventory Service</text>
    <text x="750" y="84" text-anchor="middle" class="d-label-muted" font-size="9">own database · holds</text>
  </g>
  <g data-fail-toggle="pay4">
    <rect x="660" y="170" width="180" height="64" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="750" y="197" text-anchor="middle" class="d-actor-label" font-size="12">Payment Service</text>
    <text x="750" y="214" text-anchor="middle" class="d-label-muted" font-size="9">authorize now · capture at ship</text>
  </g>
  <g data-fail-toggle="odb4">
    <rect x="210" y="260" width="180" height="80" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="300" y="287" text-anchor="middle" class="d-actor-label" font-size="12">Orders DB</text>
    <text x="300" y="305" text-anchor="middle" class="d-label-muted" font-size="9">orders · saga steps</text>
    <text x="300" y="320" text-anchor="middle" class="d-label-muted" font-size="9">outbox</text>
  </g>
  <g data-fail-toggle="sw4">
    <rect x="20" y="270" width="140" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="90" y="296" text-anchor="middle" class="d-actor-label" font-size="12">Saga Worker</text>
    <text x="90" y="313" text-anchor="middle" class="d-label-muted" font-size="9">resumes stalled sagas</text>
  </g>
  <g data-fail-toggle="ff4">
    <rect x="660" y="290" width="180" height="56" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="750" y="314" text-anchor="middle" class="d-actor-label" font-size="12">Fulfilment</text>
    <text x="750" y="330" text-anchor="middle" class="d-label-muted" font-size="9">picks · packs · ships</text>
  </g>
  <line id="d4-cu-os" x1="152" y1="75" x2="206" y2="75" class="d-msg d-request" data-depends-on="os4" marker-end="url(#arrowC4)"></line>
  <line id="d4-os-cu" x1="206" y1="100" x2="152" y2="100" class="d-msg d-response" data-depends-on="os4" marker-end="url(#arrowC4r)"></line>
  <line id="d4-os-inv" x1="392" y1="65" x2="656" y2="62" class="d-msg d-request" data-depends-on="os4 inv4" marker-end="url(#arrowC4)"></line>
  <line id="d4-inv-os" x1="656" y1="86" x2="392" y2="88" class="d-msg d-response" data-depends-on="os4 inv4" marker-end="url(#arrowC4r)"></line>
  <line id="d4-os-pay" x1="392" y1="112" x2="656" y2="190" class="d-msg d-request" data-depends-on="os4 pay4" marker-end="url(#arrowC4)"></line>
  <line id="d4-pay-os" x1="656" y1="212" x2="392" y2="128" class="d-msg d-response" data-depends-on="os4 pay4" marker-end="url(#arrowC4r)"></line>
  <line id="d4-os-db" x1="280" y1="137" x2="280" y2="256" class="d-msg d-request" data-depends-on="os4 odb4" marker-end="url(#arrowC4)"></line>
  <line id="d4-db-os" x1="320" y1="256" x2="320" y2="137" class="d-msg d-response" data-depends-on="os4 odb4" marker-end="url(#arrowC4r)"></line>
  <line id="d4-sw-db" x1="162" y1="290" x2="206" y2="290" class="d-msg d-request" data-depends-on="sw4 odb4" marker-end="url(#arrowC4)"></line>
  <line id="d4-db-sw" x1="206" y1="314" x2="162" y2="314" class="d-msg d-response" data-depends-on="sw4 odb4" marker-end="url(#arrowC4r)"></line>
  <line id="d4-sw-os" x1="110" y1="268" x2="240" y2="139" class="d-msg d-request" data-depends-on="sw4 os4" marker-end="url(#arrowC4)"></line>
  <line id="d4-db-ff" x1="392" y1="310" x2="656" y2="316" class="d-msg d-request" data-depends-on="odb4 ff4" marker-end="url(#arrowC4)"></line>
  <text x="430" y="372" text-anchor="middle" class="d-label-muted" font-size="10">play a saga to the end, then one that has to undo itself, then a crash halfway through</text>
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
{"id": "sg", "title": "Saga ord_7310", "rows": [["order", "—"], ["hold", "—"], ["payment", "—"]]},
{"id": "card", "title": "Customer's card", "rows": [["$60", "—"]]}
],
"flows": [
{
"id": "happy",
"label": "A saga, start to finish",
"nodes": ["os4", "inv4", "pay4", "odb4", "ff4"],
"steps": [
{"el": "d4-cu-os", "payload": "Place order · ord_7310", "set": {"sg.order": "—", "sg.hold": "—", "sg.payment": "—", "card.$60": "untouched"}, "text": "The customer places an order for the lamp. Checkout is now the order service's job."},
{"el": "d4-os-db", "payload": "ord_7310 · held · step hold: requested", "set": {"sg.order": "held", "sg.hold": "requested"}, "text": "Before calling inventory, the order service records the order, with the price shown at checkout, and the step it's about to take."},
{"el": "d4-os-inv", "payload": "hold 1 × L-204 · key ord_7310:hold", "text": "It asks inventory for the hold. A repeat of this call, with the same key, would find the same hold."},
{"el": "d4-inv-os", "payload": "held until 14:36", "ms": 4, "set": {"sg.hold": "held"}, "text": "Inventory holds the lamp in its own database, in its own transaction."},
{"el": "d4-os-db", "payload": "step hold: done · step authorize: requested", "text": "The order service records the result, and the next step, before taking it."},
{"el": "d4-os-pay", "payload": "authorize $60 · key ord_7310:pay", "text": "It asks the payment service to authorize $60: the bank holds the money on the card without moving it."},
{"el": "d4-pay-os", "payload": "authorized · pay_812", "ms": 600, "set": {"sg.payment": "authorized · pay_812", "card.$60": "authorized · not charged"}, "text": "The bank approves."},
{"el": "d4-os-inv", "payload": "commit · key ord_7310:commit", "text": "The order service records the authorization, then commits the hold."},
{"el": "d4-inv-os", "payload": "allocated", "ms": 4, "set": {"sg.hold": "allocated"}, "text": "The lamp is sold, waiting to ship."},
{"el": "d4-os-db", "payload": "ord_7310 confirmed + outbox order.confirmed", "set": {"sg.order": "confirmed"}, "text": "The order is confirmed, and an event for fulfilment goes into the outbox in the same transaction."},
{"el": "d4-os-cu", "payload": "Order confirmed", "ms": 2, "text": "The customer sees the confirmation."},
{"el": "d4-db-ff", "payload": "order.confirmed · ord_7310", "set": {"card.$60": "captured at shipping"}, "text": "The outbox relay delivers the event, and fulfilment picks and packs the lamp. When it ships, inventory takes it off on_hand, and the payment service captures the $60. Three services, each changing only its own data, and the order's own record showing exactly how far it got."}
]
},
{
"id": "undo",
"label": "A saga that has to undo itself",
"nodes": ["os4", "inv4", "pay4", "odb4"],
"steps": [
{"el": "d4-os-inv", "payload": "hold 1 × L-204 · key ord_7310:hold", "set": {"sg.order": "held", "sg.hold": "held until 14:36", "sg.payment": "—", "card.$60": "untouched"}, "text": "The last lamp is held for ord_7310 until 14:36, and the order is placed at 14:06."},
{"el": "d4-os-pay", "payload": "authorize $60 · key ord_7310:pay", "text": "The order service asks for the authorization."},
{"el": "d4-pay-os", "payload": "requires_action · bank approval", "ms": 500, "set": {"sg.payment": "waiting for the bank"}, "text": "The customer's bank wants them to approve the payment in their banking app. They put the phone down and come back to it 35 minutes later."},
{"el": "d4-pay-os", "payload": "authorized · pay_812 · 14:41", "ms": 2100000, "set": {"sg.payment": "authorized · pay_812", "sg.hold": "expired at 14:36 · lamp sold to another order", "card.$60": "authorized · not charged"}, "text": "The authorization arrives at 14:41. The hold expired at 14:36, and the lamp has since been held and sold to another order."},
{"el": "d4-os-inv", "payload": "commit · key ord_7310:commit", "text": "The order service tries the next step."},
{"el": "d4-inv-os", "payload": "410 · expired · none to re-hold", "ms": 4, "text": "The hold has expired and there's no other lamp. This step has failed for good, and nothing will make it succeed. The saga must undo the steps that did succeed, in reverse order."},
{"el": "d4-os-db", "payload": "step commit: failed · step void: requested", "set": {"sg.order": "compensating"}, "text": "It records the failure, and the first compensation."},
{"el": "d4-os-pay", "payload": "void pay_812 · key ord_7310:void", "text": "It asks the payment service to void the authorization."},
{"el": "d4-pay-os", "payload": "voided", "ms": 400, "set": {"sg.payment": "voided", "card.$60": "released by the bank · never charged"}, "text": "Because the payment was only authorized, no money ever moved. The bank drops the held $60 from the customer's card. Had it been a charge, as in Stage 3, the undo would be a refund that takes days to reach them."},
{"el": "d4-os-inv", "payload": "release · key ord_7310:release", "text": "Releasing the hold undoes the first step. It has already expired, and release succeeds if there's nothing to release, so this is harmless."},
{"el": "d4-os-db", "payload": "ord_7310 cancelled + outbox order.cancelled", "set": {"sg.order": "cancelled"}, "text": "The order is cancelled, and an event tells the email service to let the customer know."},
{"el": "d4-os-cu", "payload": "Sorry — sold out · nothing charged", "text": "Every completed step has been undone by its own compensation. A saga doesn't make three services act as one transaction. It makes sure that whatever happens, each one ends up either done or undone, and never stuck halfway."}
]
},
{
"id": "crash",
"label": "A crash halfway through",
"nodes": ["os4", "inv4", "pay4", "odb4", "sw4"],
"steps": [
{"el": "d4-os-db", "payload": "ord_7310 · step hold: requested", "set": {"sg.order": "held", "sg.hold": "requested", "sg.payment": "—", "card.$60": "untouched"}, "text": "A new order, ord_7310. The order service records it."},
{"el": "d4-os-inv", "payload": "hold · key ord_7310:hold", "text": "It asks for the hold."},
{"el": "d4-inv-os", "payload": "held until 14:36", "ms": 4, "set": {"sg.hold": "held"}, "text": "The lamp is held."},
{"el": "d4-os-db", "payload": "step hold: done · step authorize: requested", "set": {"sg.payment": "requested"}, "text": "The order service records that the hold is done and the authorization is about to be requested."},
{"el": "d4-os-pay", "payload": "authorize $60 · key ord_7310:pay", "text": "It asks for the authorization."},
{"el": "d4-pay-os", "payload": "authorized · pay_812 (unread)", "ms": 600, "set": {"card.$60": "authorized · not charged"}, "text": "The bank approves, but the order service's process is stopped by a deploy before it reads the answer. The customer's card has $60 authorized for an order whose service has gone away."},
{"el": "d4-sw-db", "payload": "sagas not moved for 30s?", "ms": 30000, "text": "Every 10 seconds, the saga worker asks for sagas that haven't recorded a step in the last 30."},
{"el": "d4-db-sw", "payload": "ord_7310 · last: authorize requested", "ms": 3, "text": "ord_7310 is one. Its last record says the authorization was requested, with no result. The worker doesn't know whether the payment service ever got the request."},
{"el": "d4-sw-os", "payload": "resume ord_7310 from authorize", "text": "It hands the saga to a healthy order service instance, to carry on from that step."},
{"el": "d4-os-pay", "payload": "authorize $60 · key ord_7310:pay (again)", "text": "The order service asks again, with the same key."},
{"el": "d4-pay-os", "payload": "authorized · pay_812 (original)", "ms": 300, "set": {"sg.payment": "authorized · pay_812"}, "text": "The payment service has seen ord_7310:pay before. It returns the original authorization instead of making a second one."},
{"el": "d4-os-inv", "payload": "commit · key ord_7310:commit", "text": "The saga carries on: commit the hold."},
{"el": "d4-inv-os", "payload": "allocated", "ms": 4, "set": {"sg.hold": "allocated"}, "text": "The lamp is sold."},
{"el": "d4-os-db", "payload": "ord_7310 confirmed + outbox", "set": {"sg.order": "confirmed"}, "text": "The order is confirmed, 30 seconds late. The customer's page, which has been polling the order, shows the confirmation. Recording each step before taking it, and keying each call by its step, means a saga can be picked up by anyone, at any point, and finished exactly once."}
]
}
]
}
</script>
<div class="diagram-caption">The order service runs checkout as a saga: hold, authorize, commit, confirm. It records each step in its own database before calling the service that does it, keys every call by order and step, and runs compensations in reverse if a step fails for good. A saga worker resumes sagas that stall.</div>
</div>

<div class="fail-hint">Click the order service, inventory, payments, the orders DB, the saga worker or fulfilment to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="os4">
<strong>If an order service instance fails:</strong> its sagas stop wherever they were. The saga worker hands each to another instance within 30 seconds, and it carries on from the last recorded step. Replay the third flow.
</div>
<div class="failure-impact is-hidden" data-component="inv4">
<strong>If the inventory service fails:</strong> new sagas can't hold stock, so checkout can't start. Sagas already past the hold wait at their commit step and retry until it's back. Their holds were extended to 30 minutes, which covers most outages.
</div>
<div class="failure-impact is-hidden" data-component="pay4">
<strong>If the payment service fails:</strong> sagas wait at their authorize step while their holds count down. The worker retries them with the same key, so a payment service that got the request before failing returns the original result.
</div>
<div class="failure-impact is-hidden" data-component="odb4">
<strong>If the orders DB fails:</strong> no saga can record a step, so none can take one. The order service stops until the replica takes over. No call is ever made to another service without first being recorded.
</div>
<div class="failure-impact is-hidden" data-component="sw4">
<strong>If the saga worker fails:</strong> sagas whose order service crashed stay stalled, with their stock held, until their holds expire. Sagas that don't crash are unaffected.
</div>
<div class="failure-impact is-hidden" data-component="ff4">
<strong>If fulfilment fails:</strong> confirmed orders wait in the outbox and are delivered when it's back. Their stock stays allocated, so it can't be sold twice in the meantime.
</div>
</div>

Checkout now survives a crash at any step and undoes itself cleanly when a step fails. It works for products that a few people buy a minute. It doesn't work for one that 300,000 people try to buy in the same minute: every one of those holds is a conditional update on the same row.

<!-- stage:5:5. A Limited Release -->

## Stage 5 — A Limited Release on One Product

A sneaker release: 5,000 pairs of SNK-77, on sale at 10:00:00, one per customer. 300,000 shoppers are waiting.

- **A waiting room in front of checkout.** Everyone who arrives before 10:00 is given a random place in line; anyone after joins the back. Refreshing doesn't move anyone forward. The waiting room admits shoppers at the rate checkout and the payment processors can take, about 400 a second, each with a signed entry token valid for 10 minutes ([Rate Limiting](#/systems/rate-limiting)).
- **The stock is split into buckets.** SNK-77's 5,000 pairs are 20 rows of 250 pairs each, with the same `on_hand`, `held` and `allocated` columns. A hold picks a bucket at random and tries the next if it's empty. Twenty rows can be updated in parallel, so the product can take about 20 × 500 = 10,000 holds a second instead of 500.
- **The inventory service keeps a list of empty buckets in memory**, so as stock runs low a hold tries only the buckets that had stock a moment ago.
- **A sold-out flag.** When the last bucket empties, inventory sets a flag the waiting room and the product page read. The waiting room stops admitting and tells the line. When expired holds put pairs back, the flag clears and the waiting room admits one more shopper per pair.
- **Ordinary products keep one row per warehouse.** Buckets are set up only for products released this way.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 370" width="860" height="370" role="img" aria-label="Shoppers wait in a waiting room that admits them to the order service at a fixed rate; the inventory service holds pairs from twenty bucket rows in the inventory database and sets a sold-out flag that the waiting room reads">
  <rect x="20" y="150" width="140" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="176" text-anchor="middle" class="d-actor-label" font-size="12">Shoppers</text>
  <text x="90" y="193" text-anchor="middle" class="d-label-muted" font-size="9">300,000 at 10:00</text>
  <g data-fail-toggle="wr5">
    <rect x="220" y="135" width="170" height="90" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="305" y="163" text-anchor="middle" class="d-actor-label" font-size="12">Waiting Room</text>
    <text x="305" y="181" text-anchor="middle" class="d-label-muted" font-size="9">random place in line</text>
    <text x="305" y="196" text-anchor="middle" class="d-label-muted" font-size="9">admits ~400/s · signed token</text>
  </g>
  <g data-fail-toggle="os5">
    <rect x="450" y="30" width="170" height="64" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="535" y="57" text-anchor="middle" class="d-actor-label" font-size="12">Order Service</text>
    <text x="535" y="74" text-anchor="middle" class="d-label-muted" font-size="9">the checkout saga</text>
  </g>
  <g data-fail-toggle="inv5">
    <rect x="450" y="150" width="170" height="80" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="535" y="178" text-anchor="middle" class="d-actor-label" font-size="12">Inventory Service</text>
    <text x="535" y="196" text-anchor="middle" class="d-label-muted" font-size="9">random bucket · skips empty</text>
    <text x="535" y="211" text-anchor="middle" class="d-label-muted" font-size="9">sets the sold-out flag</text>
  </g>
  <g data-fail-toggle="idb5">
    <rect x="690" y="150" width="150" height="80" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="765" y="178" text-anchor="middle" class="d-actor-label" font-size="12">Inventory DB</text>
    <text x="765" y="196" text-anchor="middle" class="d-label-muted" font-size="9">SNK-77 in 20 rows</text>
    <text x="765" y="211" text-anchor="middle" class="d-label-muted" font-size="9">250 pairs each</text>
  </g>
  <g data-fail-toggle="fl5">
    <rect x="450" y="286" width="170" height="56" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="535" y="310" text-anchor="middle" class="d-actor-label" font-size="12">Sold-out Flag</text>
    <text x="535" y="326" text-anchor="middle" class="d-label-muted" font-size="9">read by the waiting room</text>
  </g>
  <line id="e5-sh-wr" x1="162" y1="170" x2="216" y2="170" class="d-msg d-request" data-depends-on="wr5" marker-end="url(#arrowC5)"></line>
  <line id="e5-wr-sh" x1="216" y1="195" x2="162" y2="195" class="d-msg d-response" data-depends-on="wr5" marker-end="url(#arrowC5r)"></line>
  <line id="e5-wr-os" x1="370" y1="133" x2="446" y2="70" class="d-msg d-request" data-depends-on="wr5 os5" marker-end="url(#arrowC5)"></line>
  <line id="e5-os-wr" x1="446" y1="88" x2="392" y2="140" class="d-msg d-response" data-depends-on="wr5 os5" marker-end="url(#arrowC5r)"></line>
  <line id="e5-os-inv" x1="515" y1="96" x2="515" y2="146" class="d-msg d-request" data-depends-on="os5 inv5" marker-end="url(#arrowC5)"></line>
  <line id="e5-inv-os" x1="560" y1="146" x2="560" y2="96" class="d-msg d-response" data-depends-on="os5 inv5" marker-end="url(#arrowC5r)"></line>
  <line id="e5-inv-db" x1="622" y1="178" x2="686" y2="178" class="d-msg d-request" data-depends-on="inv5 idb5" marker-end="url(#arrowC5)"></line>
  <line id="e5-db-inv" x1="686" y1="205" x2="622" y2="205" class="d-msg d-response" data-depends-on="inv5 idb5" marker-end="url(#arrowC5r)"></line>
  <line id="e5-inv-fl" x1="560" y1="232" x2="560" y2="282" class="d-msg d-request" data-depends-on="inv5 fl5" marker-end="url(#arrowC5)"></line>
  <line id="e5-wr-fl" x1="370" y1="227" x2="446" y2="300" class="d-msg d-request" data-depends-on="wr5 fl5" marker-end="url(#arrowC5)"></line>
  <line id="e5-fl-wr" x1="446" y1="324" x2="340" y2="229" class="d-msg d-response" data-depends-on="wr5 fl5" marker-end="url(#arrowC5r)"></line>
  <text x="430" y="362" text-anchor="middle" class="d-label-muted" font-size="10">play the release at 10:00, then an empty bucket, then selling out and a pair coming back</text>
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
{"id": "bk", "title": "SNK-77 stock", "rows": [["bucket 3", "—"], ["bucket 11", "—"], ["all 20 buckets", "—"]]},
{"id": "wr", "title": "Waiting room", "rows": [["in line", "—"], ["admitting", "—"]]}
],
"flows": [
{
"id": "release",
"label": "The release at 10:00",
"nodes": ["wr5", "os5", "inv5", "idb5"],
"steps": [
{"el": "e5-sh-wr", "payload": "300,000 × Buy SNK-77 · 10:00:00", "set": {"bk.bucket 3": "250 available", "bk.bucket 11": "250 available", "bk.all 20 buckets": "5,000 available", "wr.in line": "300,000", "wr.admitting": "not yet"}, "text": "At 10:00:00, 300,000 shoppers press Buy for 5,000 pairs. Sent straight to checkout, that's 5,000 requests a second at one product's stock row, which takes about 500. The rest would queue on the row's lock until they timed out, and the order service and the payment processors would be swamped too, by shoppers who almost all can't have a pair."},
{"el": "e5-wr-sh", "payload": "you're number 48,211 in line", "text": "Instead, the waiting room answers each shopper with a place in line. Everyone who arrived in the 15 minutes before 10:00 was put in random order, so a fast connection or a refresh script gains nothing. The page keeps the shopper informed as the line moves."},
{"el": "e5-wr-os", "payload": "admit 400/s · signed token", "set": {"wr.admitting": "400 a second"}, "text": "It admits about 400 shoppers a second, the rate checkout and the payment processors can take, each with a token signed by the waiting room that the order service checks. A request to checkout without one is turned away. At this rate, every pair can be held in under 15 seconds."},
{"el": "e5-os-inv", "payload": "hold 1 × SNK-77 · ord_9001", "text": "An admitted shopper starts checkout, and the saga asks inventory for a hold, exactly as for the lamp."},
{"el": "e5-inv-db", "payload": "bucket 3: held + 1 if available ≥ 1", "text": "SNK-77's 5,000 pairs are stored as 20 rows of 250. The inventory service picks one at random, bucket 3, and runs the usual conditional update on it. Other holds, at the same moment, land on other buckets: different rows, with different locks, so they don't wait for each other."},
{"el": "e5-db-inv", "payload": "1 row changed · bucket 3", "ms": 3, "set": {"bk.bucket 3": "249 available", "bk.all 20 buckets": "4,999 available"}, "text": "One pair held. The hold row records which bucket it came from, so its commit, its release or its expiry changes that bucket and no other."},
{"el": "e5-inv-os", "payload": "held · bucket 3 · 10 min", "ms": 1, "text": "The saga has its pair, and the shopper's checkout page opens. Twenty rows can take about 10,000 holds a second, far above the 400 the waiting room lets through. The waiting room protects checkout; the buckets mean the stock row is never what limits it."}
]
},
{
"id": "empty",
"label": "An empty bucket",
"nodes": ["os5", "inv5", "idb5"],
"steps": [
{"el": "e5-os-inv", "payload": "hold 1 × SNK-77 · ord_9412", "set": {"bk.bucket 3": "0 available", "bk.bucket 11": "37 available", "bk.all 20 buckets": "612 available", "wr.in line": "251,000", "wr.admitting": "400 a second"}, "text": "Ten seconds in, 612 pairs are left. Buckets drain unevenly, and bucket 3 has just run out."},
{"el": "e5-inv-db", "payload": "bucket 3: held + 1 if available ≥ 1", "text": "The random pick for this hold is bucket 3."},
{"el": "e5-db-inv", "payload": "0 rows changed", "ms": 2, "text": "Bucket 3 is empty, though the product isn't. The inventory service adds bucket 3 to its list of empty buckets, so other holds stop picking it."},
{"el": "e5-inv-db", "payload": "bucket 11: held + 1 if available ≥ 1", "text": "It tries another bucket that had stock a moment ago: bucket 11."},
{"el": "e5-db-inv", "payload": "1 row changed · bucket 11", "ms": 2, "set": {"bk.bucket 11": "36 available", "bk.all 20 buckets": "611 available"}, "text": "Held. As the release goes on, most buckets empty, and more holds need a second or third try. Each try is about 2ms, so even near the end a hold takes a few milliseconds."},
{"el": "e5-inv-os", "payload": "held · bucket 11", "ms": 1, "text": "The cost of buckets is that no single row knows how many pairs are left. The total is the sum of 20 rows, which the product page reads from a cache refreshed every second, and the last few pairs may sit in different buckets."}
]
},
{
"id": "soldout",
"label": "Sold out, then a pair comes back",
"nodes": ["wr5", "os5", "inv5", "idb5", "fl5"],
"steps": [
{"el": "e5-inv-db", "payload": "bucket 17: held + 1 · the last pair", "set": {"bk.bucket 3": "0 available", "bk.bucket 11": "0 available", "bk.all 20 buckets": "1 available", "wr.in line": "238,000", "wr.admitting": "400 a second"}, "text": "Fifteen seconds in, one pair is left, in bucket 17, and a hold takes it."},
{"el": "e5-db-inv", "payload": "1 row changed", "ms": 2, "set": {"bk.all 20 buckets": "0 available · 5,000 held or sold"}, "text": "Every bucket is now empty. Every pair is held by a checkout or already paid for."},
{"el": "e5-inv-fl", "payload": "SNK-77 sold out", "text": "Inventory sets the sold-out flag."},
{"el": "e5-wr-fl", "payload": "SNK-77 sold out?", "text": "The waiting room checks the flag before admitting each batch of shoppers."},
{"el": "e5-fl-wr", "payload": "yes", "ms": 1, "set": {"wr.admitting": "paused"}, "text": "It stops admitting."},
{"el": "e5-wr-sh", "payload": "Sold out · pairs may come back · keep your place?", "text": "The 238,000 shoppers still in line are told, at once, instead of each being admitted to a checkout that would only refuse them. The product page shows sold out too, from the same flag."},
{"el": "e5-inv-db", "payload": "expired: ord_9107 · bucket 6 + 1", "ms": 600000, "set": {"bk.all 20 buckets": "1 available"}, "text": "At 10:10, the first holds expire: shoppers who were admitted, got a pair held, and never paid. The expiry sweeper releases each into the bucket it came from. ord_9107 puts one pair back in bucket 6."},
{"el": "e5-inv-fl", "payload": "SNK-77: 1 available", "text": "Inventory clears the flag."},
{"el": "e5-wr-fl", "payload": "SNK-77 sold out?", "text": "The waiting room checks again."},
{"el": "e5-fl-wr", "payload": "no · 1 available", "ms": 1, "set": {"wr.admitting": "1 per pair returned"}, "text": "One pair is available."},
{"el": "e5-wr-os", "payload": "admit the next shopper in line", "text": "It admits the next shopper in line, one for each pair that comes back. Over the next few minutes a few hundred pairs return this way, and go to the people who waited longest. When the last hold is paid for or expired and nothing is left, the release is over."}
]
}
]
}
</script>
<div class="diagram-caption">A waiting room puts shoppers in random order and admits them at the rate checkout can take. The product's stock is split into 20 bucket rows so holds can be taken in parallel. When every bucket is empty, a sold-out flag stops the waiting room admitting anyone until expired holds put pairs back.</div>
</div>

<div class="fail-hint">Click the waiting room, the order service, the inventory service, the inventory DB or the sold-out flag to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="wr5">
<strong>If the waiting room fails:</strong> nobody is admitted, and the release stalls. It must not fail open: letting 300,000 shoppers through at once is the overload it exists to prevent. The line, and each shopper's place in it, is stored so a restarted waiting room carries on where it stopped.
</div>
<div class="failure-impact is-hidden" data-component="os5">
<strong>If an order service instance fails:</strong> its sagas are resumed by the saga worker, as in Stage 4. Admitted shoppers keep their token and their hold.
</div>
<div class="failure-impact is-hidden" data-component="inv5">
<strong>If the inventory service fails:</strong> no pair can be held, and admitted shoppers see an error until it's back. Their entry tokens are still valid for 10 minutes. The empty-bucket list is rebuilt from the rows, so a restarted instance only takes a few extra tries per hold.
</div>
<div class="failure-impact is-hidden" data-component="idb5">
<strong>If the inventory DB fails:</strong> holds stop for about 30 seconds while the replica takes over, with every committed hold. Nothing held is lost and nothing is oversold.
</div>
<div class="failure-impact is-hidden" data-component="fl5">
<strong>If the sold-out flag fails:</strong> the waiting room can't tell the stock is gone, so it keeps admitting shoppers, who are each refused by inventory. Wasted work, but never an oversold pair: the flag decides who gets to try, and the bucket rows decide who gets a pair.
</div>
</div>

This is the full design. Inventory owns the stock count, and every change to it is a conditional update or a delta, applied where the count lives, so no two buyers can take the same unit and no change can erase another. Stock is held from the moment a customer starts checking out, in a hold keyed by their order, that expires on its own if they never finish. Committing and expiring a hold are both conditional on it still being held, so a unit can't end up both sold and released. Checkout is a saga across the order, inventory and payment services, each step recorded before it's taken and keyed by order and step, so a crash at any point is resumed exactly once, and a step that fails for good is undone by compensations in reverse. For a limited release, a waiting room admits shoppers in random order at the rate checkout can take, the product's stock is split into buckets that can be held in parallel, and a sold-out flag tells the line the moment there is nothing left to try for.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### When to hold stock

| Hold at | Good | Bad |
|---|---|---|
| Add to cart | The customer never loses an item they've chosen | Most carts are never bought. Stock sits held for people browsing, and a popular product looks sold out while units sit in abandoned carts |
| Start of checkout | The customer who is actually paying keeps their item while they type | 4 in 10 checkouts are abandoned, so units are off sale for up to 10 minutes each |
| Place order | Stock is off sale for the shortest time | The customer fills in everything, then learns the item is gone |

This design holds at the start of checkout, for 10 minutes, and extends to 30 at place order. The hold length is the dial. Shorter returns abandoned stock faster and annoys slow customers; longer does the opposite. For a limited release, where every unpaid hold is a pair someone in line could have bought, the hold can be cut to 5 minutes.

### Three ways to stop two writers

All three serialize writers to one row. They differ in where the waiting happens.

- **Conditional update** (this design): `UPDATE … SET held = held + 1 WHERE … AND on_hand - held - allocated >= 1`. One statement, one round trip, and the row is locked only while it runs. The answer is in the number of rows changed.
- **Lock, read, write**: `SELECT … FOR UPDATE`, check the count in the application, then update. Correct, but the row stays locked across two round trips and any application logic in between. It's needed when the decision is too complicated for one statement's condition.
- **Optimistic, with a version**: read the row and its version, then `UPDATE … WHERE version = 41`. If someone changed it in between, zero rows change and the writer reads again and retries. Fine when collisions are rare. On a hot product almost every attempt collides, and the retries add load exactly when there's least to spare.

### What can happen to a unit

```
                 hold                commit              ship
 available ──────────────► held ──────────────► allocated ──────────► shipped
     ▲                      │                       │
     └── release / expire ──┘                       │
     ▲                                              │
     └────────────── cancel before shipping ────────┘
```

Every arrow is a conditional update and a movement row. The movement log is what makes the count explainable: L-204's on_hand in the east warehouse is the sum of every receive, ship, return, damage and count movement since the product was added. When the warehouse counts its shelves and finds 23 lamps where the system says 24, the difference is posted as a `count` movement with the counter's name, rather than the number being overwritten, so lost or stolen stock shows up in the log rather than disappearing.

### Choosing a warehouse

A product is stocked in about 4 of the 12 warehouses. The hold asks for stock against a delivery address, and inventory picks which warehouse to hold from:

1. The nearest warehouse that has **every** item in the order, so it ships in one box.
2. Failing that, the fewest warehouses that cover the order between them, nearest first.
3. Each warehouse's hold is a separate line in the holds table, against that warehouse's row.

Product pages show a total across warehouses, but every hold is against one warehouse's row. Holding against a total would mean that a customer could be promised a lamp that is only available 2,000 miles away, or split across warehouses in a way nobody chose.

### Orchestration or choreography

This design's saga is **orchestrated**: the order service decides every step and keeps the saga's state. The alternative is **choreography**: each service reacts to events from the others. Inventory hears `order.placed` and holds, payments hear `stock.held` and authorizes, and so on. Choreography has no central coordinator to fail, but the order's progress is spread across several services' event logs, and answering "where is ord_7310 stuck?" means reading all of them. Checkout has a fixed order of steps, compensations that must run in reverse, and customers asking where their order is, so one owner of the state is worth it ([Message Queues](#/systems/message-queues)).

### Availability on product pages

A product page doesn't read the inventory database. It reads a cache of availability per product, refreshed from inventory's movement log within a few seconds ([Caching](#/systems/caching)). The number shown can be slightly wrong, which is acceptable because it isn't a promise: the hold at checkout is. Showing "Only 3 left" from a cache can occasionally mean the 3 have just gone, and the customer learns at checkout start, before entering anything. Many retailers show "Low stock" below a threshold instead of an exact number, which is both more honest about the staleness and less useful to a competitor scraping stock levels.

### Prices at checkout

The price is read once, when checkout starts, and stored on the order item. If the price changes while the customer is checking out, they pay what they were shown. Re-reading the price at Place order would mean the customer could be charged an amount they never saw.

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### Holds take stock off sale

At the peak of a holiday sale, up to 360,000 holds are outstanding, and about 4 in 10 of them will never be paid. Every one keeps a unit from another customer for up to 10 minutes. For most products, with plenty in stock, this costs nothing. For the last few units of a popular one, it means customers are told it's sold out while units sit in abandoned checkouts.

### Never oversell, or sometimes oversell

This design never confirms an order without a unit to fill it. Some retailers deliberately accept orders beyond stock for products that restock quickly, because a delayed order loses less than a refused one. That is a business choice, made per product, and the design supports it by raising the limit in the condition: `on_hand + backorder_limit − held − allocated`. What it never does is oversell by accident.

### The count is only as right as the shelf

The system's on_hand is what it was told. Damage, theft and mis-shelved items make the shelf disagree with it, and an order allocated a unit the warehouse can't find still has to be cancelled. Regular counts of each shelf, with differences posted as movements, keep the gap small. They can't close it.

### Buckets blur the count

A product split into 20 buckets has no single row saying how many are left. Holds take a few tries once most buckets are empty, and the count on the product page is a sum. For a release that sells out in fifteen seconds, both are fine. For ordinary products they would be pointless cost, which is why only limited releases use them.

### The waiting room is a wait

Shoppers in line wait minutes to learn whether they'll get a pair, and most won't. The admit rate is a compromise between how long they wait and how hard checkout is pushed. The waiting room is also one more component that must work for a release to happen at all, and it must be tested at full scale before the release, not during it.

### A saga is visible halfway

Between steps, an order is in states no single transaction would show: held but not paid, authorized but not committed. The customer's order page, support tools and reports all have to understand these states, and a saga that stalls shows them for longer. The saga worker keeps that short; it can't make it zero.

### Synchronous replication on every hold

Every hold waits for a replica in another zone, which is most of its 2ms and what limits a hot row to about 500 updates a second. Asynchronous replication would roughly double that, but a primary that failed could take its last few holds with it, and the units they held could be sold again.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

Checkout decides who gets scarce stock and what they pay for it, so both are worth abusing ([Security & Authentication](#/systems/security-authentication)).

### Bots in limited releases

A limited release of products that resell above their price draws automated buyers. Random order among early arrivals removes the advantage of speed. Beyond that: one pair per customer, checked against the account, the card, the delivery address and the device; bot detection and challenges before a shopper enters the line; and entry tokens bound to the shopper's session, so a token can't be passed to another machine. Orders are also reviewed after the release, and duplicates going to one address are cancelled before they ship.

### Holding stock without paying

Holds are free, so a competitor or a reseller can hold stock just to keep it off sale. Each customer can have at most 3 checkouts open at once, and at most the per-customer limit of any product held. An account whose holds expire again and again is limited further. In a limited release, a hold needs a waiting room token, which needs a place in line.

### Price and quantity tampering

The price comes from the pricing service when checkout starts, and the amount charged from the order record. Neither is ever taken from the browser. A request that edits the quantity to −1 or 10,000 is checked against the product's limits before any hold is attempted.

### Discount codes

A code is checked and applied when checkout starts, and its use is recorded with the order. A code limited to one use per customer is enforced with a unique key on the code and the customer, the same way a hold is: by the database, not by a read followed by a write.

### Reading stock levels

Exact counts on product pages tell competitors and scalpers how much stock there is and how fast it sells. Showing "In stock" or "Low stock" rather than an exact number, and rate-limiting the availability API, gives away less ([Rate Limiting](#/systems/rate-limiting)).

### Who can change stock

Only the inventory service writes stock. Warehouses report movements through its API, each with a reference to the delivery, shipment or count that caused it. A manual adjustment needs a reason, and above a threshold, a second person's approval.

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **Oversold orders**: confirmed orders the warehouse couldn't fill. Expected to be zero except for shelf errors.
- **Holds**: created, committed, expired and released per minute, and the share of each product's on_hand that's held.
- **Expired-then-paid**: orders whose payment arrived after their hold expired, and how many ended in a cancellation.
- **Hold latency** at p50 and p99, and **lock wait time** per product, to find hot rows before customers do.
- **Sagas**: how many are in each step, and the age of the oldest that hasn't moved.
- **Outbox lag** in the orders database.
- **Stock differences** found by warehouse counts, per warehouse and per product.
- **During a release**: line length, admit rate, holds per second, buckets empty, and time to sell out.

([Observability](#/systems/observability))

### What to alert on

- Any row where `held + allocated` exceeds `on_hand`. The `CHECK` constraint should make this impossible; a report of it means something is writing around the constraint.
- Any oversold order not explained by a shelf count.
- A saga not moved for more than **5 minutes**.
- The expiry sweeper not completing a pass for **1 minute**.
- A product with more than **90%** of its on_hand held, outside a limited release.
- Lock wait time on any product above **50ms** at p99.
- Expired-then-paid orders above **0.1%** of orders in an hour, which usually means a payment problem.

### "A customer's order was confirmed, then cancelled for stock" — what happens?

Look at the order's saga steps and the product's movements. If the hold was committed and the warehouse later couldn't find the unit, the shelf and the count disagree: count the shelf and post the difference. If the saga shows a payment that arrived after the hold expired, the cause is upstream, in the payment service or the customer's bank. If neither applies, a unit was allocated twice, which the conditional updates should make impossible, and the movement log shows exactly which two orders were given it.

### "The product page says in stock, but every checkout says sold out" — what happens?

Check what the stock is doing. If held is close to on_hand, the units are in open checkouts, and the product page is counting them as available: fix the cache to subtract holds. If held is close to on_hand and the holds are long past their expiry, the sweeper has stopped: restart it and the stock comes back in its first pass. If the cache is simply minutes behind, the movement feed into it has stalled.

### "Checkouts are timing out during a release" — what happens?

Check where the time goes. Long lock waits on the product's rows mean too few buckets for the admit rate: add buckets, or lower the rate. Fast holds but slow sagas point at the payment processors, which a release can push past their own limits: lower the admit rate to what they can take. If the waiting room is admitting faster than its configured rate, it has failed open, and the line should be paused until it's fixed.
