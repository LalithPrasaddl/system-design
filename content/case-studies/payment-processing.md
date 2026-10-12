# Payment Processing

A payment service takes money from a customer's card and records where it went. Charging a card is one call to a card processor's API. The difficulty is that the call crosses a network to a system you don't control, and when it times out you don't know whether the customer was charged. Retry, and you may charge them twice. Don't retry, and you may have taken their money without recording it. This case study builds the payment service for a large online marketplace: twenty million payments a day, two external card processors, a double-entry ledger of who is owed what, and no customer ever charged twice for one order.

<!-- tab:requirements:Requirements -->

## Requirements

This case study builds the payment service for an online marketplace, where customers buy from thousands of merchants and the marketplace keeps a fee on every sale. The service charges customers through external card processors, keeps the books, and pays merchants what they're owed. It never sees a card number.

### Functional requirements

- **Charge a customer for an order**, through an external card processor, using a card token.
- **Retries are always safe.** Repeating a request returns the original result and never moves money a second time.
- **Outcomes that arrive later**: a bank asking the customer to approve the payment, and notifications the processor sends on its own schedule (webhooks).
- **Refund** all or part of a payment.
- **A double-entry ledger.** Every movement of money is recorded as balanced entries, giving an exact balance for every merchant and every internal account.
- **Pay merchants** what the ledger says they're owed, weekly.
- **Reconcile daily** against each processor's settlement report.
- **Tell other services** — orders first of all — when a payment's outcome is known.

### Non-functional requirements

- **Correctness:** a customer is never charged twice for one payment, a successful charge is never lost, and the ledger always balances to the cent.
- **Availability:** 99.95% for taking payments. An outage at one processor doesn't stop payments.
- **Latency:** under 1 second at the median, end to end. The processor and the card's bank take most of that; the service's own work stays under 50ms.
- **Throughput:** 2,000 payments a second at the peak of a sale.
- **Durability:** a committed payment or ledger entry survives the loss of a whole zone.
- **Reconciliation:** every line of every processor's settlement report is matched within 24 hours.
- **Retention:** payment and ledger records are kept for 7 years.

### In scope

Idempotent charges and refunds, the payment state machine, recovering unknown outcomes, the double-entry ledger, payouts, webhooks, the transactional outbox, reconciliation, routing between two processors, and sharding the ledger.

### Out of scope

**How card networks and banks approve a charge**: the processor handles that. **Fraud scoring models**: the service calls a risk check, which is its own system. **Currency conversion**: each payment is in one currency. **Tax, subscriptions and invoicing.** **The dispute process** beyond recording that a dispute was opened.

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

The numbers that shape a payment service aren't bytes. They are how long the processor takes, how often it fails to answer, and how much money is moving while it does.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Payments</div>
<div class="stat-tile-value">~20<span class="stat-tile-unit">M/day</span></div>
<div class="stat-tile-sub">~230 a second on average</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Peak</div>
<div class="stat-tile-value">~2,000<span class="stat-tile-unit">/s</span></div>
<div class="stat-tile-sub">during a sale</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Money moved</div>
<div class="stat-tile-value">~$1<span class="stat-tile-unit">B/day</span></div>
<div class="stat-tile-sub">$50 average payment</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Calls in flight</div>
<div class="stat-tile-value">~1,200</div>
<div class="stat-tile-sub">at peak, 600ms each</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Unknown outcomes</div>
<div class="stat-tile-value">~10<span class="stat-tile-unit">K/day</span></div>
<div class="stat-tile-sub">0.05% of calls time out</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Ledger growth</div>
<div class="stat-tile-value">~15<span class="stat-tile-unit">GB/day</span></div>
<div class="stat-tile-sub">~40TB over 7 years</div>
</div>
</div>

### Assumptions

- **20 million** payments a day, averaging **$50**.
- Sales push traffic to about **9×** the daily average for an hour or two.
- A charge takes the processor about **600ms** at the median and **3 seconds** at p99. The service waits at most **10 seconds**.
- **0.05%** of processor calls time out or lose their connection.
- **5%** of payments are partly or fully refunded.
- The processor sends about **2** webhooks per payment.
- One ledger entry is about **150 bytes**; a payment row about **1KB**.

### Payments and the processor

20 million a day is about **230 a second** on average, and **2,000 a second** at a sale's peak. Each charge waits about 600ms on the processor, so at the peak about **1,200 calls are in flight** at once. The service has to hold that many open requests without a thread blocked on each.

### Unknown outcomes

0.05% of 20 million is **10,000 payments a day** where the service asked for a charge and never heard back. Each of those customers may or may not have been charged. They are the reason most of this design exists.

### Money at stake

$50 × 20 million is **$1 billion a day**. A bug that charged twice even once in ten thousand payments would charge **2,000 customers twice every day**.

### The ledger

A charge posts 3 entries. Settlement, refunds and payouts add about 2 more per payment on average: **~100 million entries a day**, at 150 bytes about **15GB a day**. Kept for 7 years, that is **~40TB**, before indexes. Payment rows add 20GB a day.

### Webhooks

2 per payment is **40 million a day**: about 460 a second on average and 4,000 at the peak.

<!-- tab:api-design:API Design -->

## API Design

The payment service is called by the marketplace's own backend — checkout, orders, the merchant dashboard — never by browsers directly. Amounts are integers in the currency's smallest unit: 8000 means $80.00.

### Payments

```
POST /v1/payments
Idempotency-Key: chk_5521_a
{"order_id": "5521", "merchant_id": "m42", "amount": 8000, "currency": "USD",
 "payment_method": "tok_8Hq"}
→ 201 {"payment_id": "pay_771", "status": "succeeded", "processor_ref": "ch_9fK2"}
→ 202 {"payment_id": "pay_771", "status": "processing"}                  outcome not known yet
→ 202 {"payment_id": "pay_771", "status": "requires_action",
       "action_url": "https://…"}                                        the bank wants the customer
→ 402 {"payment_id": "pay_771", "status": "failed", "decline_code": "insufficient_funds"}

GET /v1/payments/pay_771
→ 200 {"payment_id": "pay_771", "status": "succeeded", "amount": 8000, "refunded": 3000}
```

### Refunds

```
POST /v1/payments/pay_771/refunds
Idempotency-Key: rf_5521_1
{"amount": 3000, "reason": "damaged"}
→ 201 {"refund_id": "re_41", "status": "succeeded"}
→ 422 {"error": "exceeds_refundable", "refundable": 5000}
```

### Webhooks from processors

```
POST /v1/webhooks/processor-a
Processor-Signature: t=1760148847,v1=5f2c…
{"id": "evt_31", "type": "payment.succeeded",
 "data": {"charge": "ch_9fK2", "metadata": {"payment_id": "pay_771"}}}
→ 200
```

### The ledger

```
GET /v1/ledger/accounts/merchant_payable:m42
→ 200 {"balance": 4500, "currency": "USD", "as_of_entry": 99812345}

GET /v1/ledger/accounts/merchant_payable:m42/entries?after=99800000
→ 200 {"entries": [{"txn": "tx_5521", "kind": "charge", "ref": "pay_771",
                    "direction": "credit", "amount": 7200}, …]}
```

| Code | Meaning |
|---|---|
| `200` | Done |
| `201` | Payment or refund succeeded |
| `202` | Accepted, outcome not known yet, or waiting on the customer |
| `400` | Malformed request, or no `Idempotency-Key` |
| `402` | Declined by the card's bank |
| `409` | A request with this key is still in progress: ask for the payment's status |
| `422` | Key reused with a different request, or a refund larger than what's left |
| `429` | Over the caller's request rate |
| `503` | No processor available: safe to retry with the same key |

### Why the details matter

**Every write needs an idempotency key.** The caller makes it once per attempt to pay — per checkout, not per click — and sends it with every retry. A request without one is rejected rather than risked.

**`202 processing` is not a failure.** It means the service doesn't know yet. A caller that treats it as a failure and starts a new payment is how customers get charged twice.

**A reused key with a different body is an error.** If a caller sends key chk_5521_a with $80 and later with $95, something in the caller is broken. Returning the $80 result would hide the bug.

**Amounts are integers.** Floating-point numbers can't represent $0.10 exactly, and the errors add up across millions of entries.

**The payment ID goes to the processor.** It is passed as the processor's idempotency key and stored in the charge's metadata, so every webhook and every line of the settlement report can be matched to a payment.

**`503` is safe to retry.** With the same key, a retry either finds the original payment or creates it once.

<!-- tab:data-model:Data Model -->

## Data Model

Payments and the ledger live in one relational database, so that a payment's status, its ledger entries and the event announcing it can be written in a single transaction.

### Payments

```
payments
  payment_id       TEXT PRIMARY KEY     -- pay_771
  caller           TEXT                 -- checkout, orders, …
  idempotency_key  TEXT                 -- chk_5521_a
  request_hash     TEXT                 -- of the request body
  order_id         TEXT
  merchant_id      TEXT
  amount           BIGINT               -- minor units: 8000 = $80.00
  currency         CHAR(3)
  status           TEXT                 -- created | processing | unknown |
                                        -- requires_action | succeeded | failed
  processor        TEXT                 -- A or B, fixed once the call is sent
  processor_ref    TEXT                 -- ch_9fK2
  refunded         BIGINT DEFAULT 0
  updated_at       TIMESTAMP
  UNIQUE (caller, idempotency_key)

refunds
  refund_id        TEXT PRIMARY KEY
  payment_id       TEXT
  idempotency_key  TEXT
  amount           BIGINT
  status           TEXT
  UNIQUE (payment_id, idempotency_key)
```

### The ledger

```
accounts
  account_id       TEXT PRIMARY KEY     -- merchant_payable:m42
  type             TEXT                 -- asset | liability | revenue | expense
  currency         CHAR(3)
  balance          BIGINT               -- cached: always the sum of its entries

transactions
  txn_id           TEXT PRIMARY KEY
  kind             TEXT                 -- charge | refund | settlement | payout | adjustment
  ref              TEXT                 -- pay_771, re_41, po_88, …
  created_at       TIMESTAMP

entries                                 -- never updated, never deleted
  entry_id         BIGSERIAL PRIMARY KEY
  txn_id           TEXT
  account_id       TEXT
  direction        TEXT                 -- debit | credit
  amount           BIGINT CHECK (amount > 0)
  -- per transaction: total debits = total credits, checked before commit
```

A charge of $80 on which the marketplace keeps $8 is one transaction with three entries:

```
txn tx_5521 · charge · pay_771
  debit   processor_receivable:A   8000     the processor now owes the marketplace $80
  credit  merchant_payable:m42     7200     the marketplace owes the merchant $72
  credit  platform_revenue          800     the marketplace's fee
```

### Events

```
processor_events                        -- every webhook received
  processor        TEXT
  event_id         TEXT                 -- evt_31
  received_at      TIMESTAMP
  PRIMARY KEY (processor, event_id)

outbox                                  -- events for other services
  id               BIGSERIAL PRIMARY KEY
  topic            TEXT                 -- payment.succeeded
  payload          JSONB
  sent_at          TIMESTAMP            -- null until published
```

### Why this storage

Every correctness rule in this design is a database transaction: a unique key that lets an idempotency key exist once, a conditional update that moves a payment out of `unknown` once, entries that commit with the status change or not at all. That needs a relational database with real transactions ([Relational Databases](#/systems/databases-relational)). Each primary has a synchronous replica in another zone, so a commit is on two zones before it is acknowledged ([Replication](#/systems/replication)). Stage 5 shards it by merchant.

<!-- tab:architecture:Architecture:default -->

This case study builds the payment service up in five stages. Each stage fixes a specific failure of the one before. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one request at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. Charge Inline -->

## Stage 1 — Charge the Card Inside the Checkout Request

The simplest payment code lives in checkout. When the customer clicks Pay, the app server calls the processor's charge API, waits for the answer, and marks the order paid.

```
charge = processor.charge(amount=8000, token="tok_8Hq")     wait up to 10s
if charge.succeeded: orders.mark_paid(5521, charge.id)
```

The card number never touches the marketplace. The processor's payment form, embedded in the checkout page, sends it straight to the processor and gives the page back a token that stands for the card. That keeps the marketplace's own servers out of the strictest card-security rules, and it holds for every stage.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 780 300" width="780" height="300" role="img" aria-label="A customer pays through an app server, which calls the card processor and then marks the order paid in the orders database">
  <rect x="20" y="120" width="150" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="95" y="146" text-anchor="middle" class="d-actor-label" font-size="12">Customer</text>
  <text x="95" y="163" text-anchor="middle" class="d-label-muted" font-size="9">browser</text>
  <g data-fail-toggle="app1">
    <rect x="300" y="105" width="180" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="390" y="134" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
    <text x="390" y="152" text-anchor="middle" class="d-label-muted" font-size="9">checkout code</text>
    <text x="390" y="167" text-anchor="middle" class="d-label-muted" font-size="9">calls the processor inline</text>
  </g>
  <g data-fail-toggle="pr1">
    <rect x="600" y="25" width="160" height="70" rx="6" class="d-actor-box"></rect>
    <text x="680" y="54" text-anchor="middle" class="d-actor-label" font-size="12">Card Processor</text>
    <text x="680" y="71" text-anchor="middle" class="d-label-muted" font-size="9">external · asks the bank</text>
  </g>
  <g data-fail-toggle="db1">
    <rect x="600" y="200" width="160" height="70" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="680" y="229" text-anchor="middle" class="d-actor-label" font-size="12">Orders DB</text>
    <text x="680" y="246" text-anchor="middle" class="d-label-muted" font-size="9">order status</text>
  </g>
  <line id="s1-c-app" x1="172" y1="140" x2="296" y2="140" class="d-msg d-request" data-depends-on="app1" marker-end="url(#arrowP1)"></line>
  <line id="s1-app-c" x1="296" y1="165" x2="172" y2="165" class="d-msg d-response" data-depends-on="app1" marker-end="url(#arrowP1r)"></line>
  <line id="s1-app-pr" x1="482" y1="120" x2="596" y2="68" class="d-msg d-request" data-depends-on="app1 pr1" marker-end="url(#arrowP1)"></line>
  <line id="s1-pr-app" x1="596" y1="86" x2="482" y2="136" class="d-msg d-response" data-depends-on="app1 pr1" marker-end="url(#arrowP1r)"></line>
  <line id="s1-app-db" x1="482" y1="165" x2="596" y2="222" class="d-msg d-request" data-depends-on="app1 db1" marker-end="url(#arrowP1)"></line>
  <line id="s1-db-app" x1="596" y1="242" x2="482" y2="182" class="d-msg d-response" data-depends-on="app1 db1" marker-end="url(#arrowP1r)"></line>
  <text x="390" y="292" text-anchor="middle" class="d-label-muted" font-size="10">play a normal payment, then a timeout, then a crash between charging and saving</text>
  <defs>
    <marker id="arrowP1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowP1r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "card", "title": "Customer's card", "rows": [["charges", "—"]]},
{"id": "ord", "title": "Orders DB", "rows": [["order 5521", "—"]]}
],
"flows": [
{
"id": "normal",
"label": "Pay for an order",
"nodes": ["app1", "pr1", "db1"],
"steps": [
{"el": "s1-c-app", "payload": "Pay $80 · order 5521 · tok_8Hq", "set": {"card.charges": "none", "ord.order 5521": "awaiting payment"}, "text": "A customer checks out order 5521: $80 of books from merchant m42. The browser sends the order and the card token, tok_8Hq, which the processor's form produced a moment ago."},
{"el": "s1-app-pr", "payload": "charge $80 · tok_8Hq", "text": "The app server calls the processor's charge API with the amount and the token."},
{"el": "s1-pr-app", "payload": "succeeded · ch_9fK2", "ms": 600, "set": {"card.charges": "$80 · ch_9fK2"}, "text": "The processor asks the card's bank to approve the charge, and the bank does. That takes about 600ms, nearly all of it at the processor and the bank. The processor returns its own ID for the charge."},
{"el": "s1-app-db", "payload": "order 5521: paid · ch_9fK2", "set": {"ord.order 5521": "paid · ch_9fK2"}, "text": "The app server marks the order paid and stores the charge ID."},
{"el": "s1-db-app", "payload": "ok", "ms": 3, "text": "Saved."},
{"el": "s1-app-c", "payload": "Paid · order confirmed", "text": "The customer sees the confirmation. Every step happened in order, in one request, and most of the time this is all there is."}
]
},
{
"id": "timeout",
"label": "A timeout, then Pay again",
"nodes": ["app1", "pr1", "db1"],
"steps": [
{"el": "s1-c-app", "payload": "Pay $80 · order 5521", "set": {"card.charges": "none", "ord.order 5521": "awaiting payment"}, "text": "The customer clicks Pay."},
{"el": "s1-app-pr", "payload": "charge $80 · tok_8Hq", "text": "The app server calls the processor."},
{"el": "s1-pr-app", "payload": "(no answer after 10s)", "ms": 10000, "set": {"card.charges": "$80 · ch_9fK2 — the app doesn't know"}, "text": "The processor is slow today. The bank approves the charge after 11 seconds, but the app server stopped waiting at 10. From where it sits, it can't tell what happened. The request might never have arrived, or the charge might have gone through and only the reply was lost."},
{"el": "s1-app-c", "payload": "Payment failed — try again", "text": "The app server treats the timeout as a failure, and says so."},
{"el": "s1-c-app", "payload": "Pay $80 · order 5521", "text": "The customer clicks Pay again. To the app server, this is a brand-new request."},
{"el": "s1-app-pr", "payload": "charge $80 · tok_8Hq", "text": "It calls the processor again, with the same amount and the same card."},
{"el": "s1-pr-app", "payload": "succeeded · ch_3Lm7", "ms": 600, "set": {"card.charges": "$80 · ch_9fK2 and $80 · ch_3Lm7"}, "text": "The processor has no way to know this is the same purchase. It's a second charge, and it succeeds."},
{"el": "s1-app-db", "payload": "order 5521: paid · ch_3Lm7", "set": {"ord.order 5521": "paid · ch_3Lm7"}, "text": "The order is marked paid with the second charge."},
{"el": "s1-app-c", "payload": "Paid", "text": "The customer has paid $160 for an $80 order, and the first charge is recorded nowhere in the marketplace. It surfaces when the customer disputes it with their bank. At a 0.05% timeout rate there are 10,000 uncertain charges a day, and neither choice is safe: retrying risks charging twice, and not retrying risks keeping money for an order that never completes."}
]
},
{
"id": "crash",
"label": "A crash between charging and saving",
"nodes": ["app1", "pr1", "db1"],
"steps": [
{"el": "s1-c-app", "payload": "Pay $80 · order 5521", "set": {"card.charges": "none", "ord.order 5521": "awaiting payment"}, "text": "The customer clicks Pay."},
{"el": "s1-app-pr", "payload": "charge $80 · tok_8Hq", "text": "The app server calls the processor."},
{"el": "s1-pr-app", "payload": "succeeded · ch_9fK2", "ms": 600, "set": {"card.charges": "$80 · ch_9fK2"}, "text": "The charge succeeds, and the answer arrives."},
{"el": "s1-app-db", "payload": "(process stopped by a deploy)", "text": "Before the app server can write anything, its process is stopped for a routine deploy. The processor's answer existed only in that process's memory."},
{"el": "s1-app-c", "payload": "(connection dropped)", "text": "The customer's browser shows an error. The order still says awaiting payment, so the customer may pay again — or give up, charged $80 for an order the marketplace will never ship. Nothing in the marketplace records that the charge exists. The charge and the record of it have to be tied together, and a call that times out needs a way to be asked again without being done again."}
]
}
]
}
</script>
<div class="diagram-caption">The checkout app server calls the card processor inside the customer's request, waits up to 10 seconds, and marks the order paid if the charge succeeded.</div>
</div>

<div class="fail-hint">Click the app server, the processor or the orders DB to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="app1">
<strong>If the app server fails:</strong> any payment it was in the middle of is lost from the marketplace's view. If the processor had already charged the card, the customer has paid for an order still marked unpaid. Replay the third flow.
</div>
<div class="failure-impact is-hidden" data-component="pr1">
<strong>If the processor fails:</strong> no payment can be taken. Worse is a processor that is slow rather than down: calls time out after the charge went through, and each one is a customer who may have been charged without the marketplace knowing. Replay the second flow.
</div>
<div class="failure-impact is-hidden" data-component="db1">
<strong>If the orders DB fails:</strong> the app server charges the card and then can't record it. The customer is told the payment failed, though their money was taken.
</div>
</div>

Stage 1 fails in the two ways that matter most for money: it charges twice, and it loses charges. Both come from the same gap. The processor's side of the payment and the marketplace's side aren't connected, so when the conversation between them breaks off, neither side can pick it up again.

<!-- stage:2:2. Idempotent Payments -->

## Stage 2 — A Payment Service with Idempotency Keys

- **A payment service owns payments.** Checkout asks it to take a payment and never calls the processor itself.
- **Checkout generates an idempotency key** when the customer opens the payment page: one key per checkout, sent with every attempt to pay ([Idempotency](#/systems/idempotency)).
- **The intent is written first.** Before calling the processor, the service inserts a payment row, pay_771, with status `created` and the caller's key. A unique constraint on the key means the row can exist only once.
- **The processor gets a key too**: the payment ID. Processors keep the result of each key for at least 24 hours and return it for a repeated request instead of charging again.
- **A timeout is recorded as `unknown`**, never as failed. Checkout is told the payment is processing.
- **A recovery worker** looks every 30 seconds for payments left `unknown`, or stuck in `processing`, for more than a minute. It resends each one to the processor with the same key until it gets an answer.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 820 340" width="820" height="340" role="img" aria-label="Checkout asks a payment service for a payment; the service records it in the payments database before calling the card processor, and a recovery worker resends unresolved payments to the processor">
  <rect x="20" y="140" width="130" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="85" y="166" text-anchor="middle" class="d-actor-label" font-size="12">Customer</text>
  <text x="85" y="183" text-anchor="middle" class="d-label-muted" font-size="9">browser</text>
  <g data-fail-toggle="ck2">
    <rect x="200" y="140" width="130" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="265" y="166" text-anchor="middle" class="d-actor-label" font-size="12">Checkout</text>
    <text x="265" y="183" text-anchor="middle" class="d-label-muted" font-size="9">one key per checkout</text>
  </g>
  <g data-fail-toggle="ps2">
    <rect x="390" y="115" width="170" height="100" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="475" y="143" text-anchor="middle" class="d-actor-label" font-size="12">Payment Service</text>
    <text x="475" y="161" text-anchor="middle" class="d-label-muted" font-size="9">writes the intent first</text>
    <text x="475" y="176" text-anchor="middle" class="d-label-muted" font-size="9">payment ID = processor key</text>
    <text x="475" y="191" text-anchor="middle" class="d-label-muted" font-size="9">timeout → unknown</text>
  </g>
  <g data-fail-toggle="pr2">
    <rect x="640" y="30" width="160" height="70" rx="6" class="d-actor-box"></rect>
    <text x="720" y="59" text-anchor="middle" class="d-actor-label" font-size="12">Card Processor</text>
    <text x="720" y="76" text-anchor="middle" class="d-label-muted" font-size="9">keeps each key 24h+</text>
  </g>
  <g data-fail-toggle="rw2">
    <rect x="640" y="230" width="160" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="720" y="256" text-anchor="middle" class="d-actor-label" font-size="12">Recovery Worker</text>
    <text x="720" y="273" text-anchor="middle" class="d-label-muted" font-size="9">every 30s</text>
  </g>
  <g data-fail-toggle="db2">
    <rect x="390" y="255" width="170" height="60" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="475" y="281" text-anchor="middle" class="d-actor-label" font-size="12">Payments DB</text>
    <text x="475" y="298" text-anchor="middle" class="d-label-muted" font-size="9">unique (caller, key)</text>
  </g>
  <line id="s2-cu-ck" x1="152" y1="160" x2="196" y2="160" class="d-msg d-request" data-depends-on="ck2" marker-end="url(#arrowP2)"></line>
  <line id="s2-ck-cu" x1="196" y1="182" x2="152" y2="182" class="d-msg d-response" data-depends-on="ck2" marker-end="url(#arrowP2r)"></line>
  <line id="s2-ck-ps" x1="332" y1="150" x2="386" y2="150" class="d-msg d-request" data-depends-on="ck2 ps2" marker-end="url(#arrowP2)"></line>
  <line id="s2-ps-ck" x1="386" y1="178" x2="332" y2="178" class="d-msg d-response" data-depends-on="ck2 ps2" marker-end="url(#arrowP2r)"></line>
  <line id="s2-ps-pr" x1="562" y1="130" x2="636" y2="78" class="d-msg d-request" data-depends-on="ps2 pr2" marker-end="url(#arrowP2)"></line>
  <line id="s2-pr-ps" x1="636" y1="94" x2="562" y2="146" class="d-msg d-response" data-depends-on="ps2 pr2" marker-end="url(#arrowP2r)"></line>
  <line id="s2-ps-db" x1="450" y1="217" x2="450" y2="251" class="d-msg d-request" data-depends-on="ps2 db2" marker-end="url(#arrowP2)"></line>
  <line id="s2-db-ps" x1="500" y1="251" x2="500" y2="217" class="d-msg d-response" data-depends-on="ps2 db2" marker-end="url(#arrowP2r)"></line>
  <line id="s2-rw-db" x1="636" y1="252" x2="564" y2="272" class="d-msg d-request" data-depends-on="rw2 db2" marker-end="url(#arrowP2)"></line>
  <line id="s2-db-rw" x1="564" y1="292" x2="636" y2="274" class="d-msg d-response" data-depends-on="rw2 db2" marker-end="url(#arrowP2r)"></line>
  <line id="s2-rw-pr" x1="700" y1="228" x2="700" y2="104" class="d-msg d-request" data-depends-on="rw2 pr2" marker-end="url(#arrowP2)"></line>
  <line id="s2-pr-rw" x1="740" y1="104" x2="740" y2="228" class="d-msg d-response" data-depends-on="rw2 pr2" marker-end="url(#arrowP2r)"></line>
  <text x="410" y="334" text-anchor="middle" class="d-label-muted" font-size="10">play the retry after a timeout, then a double-click, then a crash after the charge</text>
  <defs>
    <marker id="arrowP2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowP2r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "pdb", "title": "Payments DB", "rows": [["pay_771", "—"]]},
{"id": "card", "title": "Customer's card", "rows": [["charges", "—"]]}
],
"flows": [
{
"id": "retry",
"label": "A timeout, then Pay again",
"nodes": ["ck2", "ps2", "pr2", "db2"],
"steps": [
{"el": "s2-cu-ck", "payload": "Pay $80 · order 5521", "set": {"pdb.pay_771": "—", "card.charges": "none"}, "text": "The customer clicks Pay. When the payment page opened, checkout created an idempotency key for this checkout, chk_5521_a. Every attempt to pay for it will carry that key."},
{"el": "s2-ck-ps", "payload": "POST /payments · key chk_5521_a", "text": "Checkout asks the payment service for the payment."},
{"el": "s2-ps-db", "payload": "insert pay_771 · created · chk_5521_a", "text": "Before contacting the processor, the service writes down what it's about to do. The key column is unique, so this payment can be recorded only once."},
{"el": "s2-db-ps", "payload": "inserted", "ms": 3, "set": {"pdb.pay_771": "processing · key chk_5521_a"}, "text": "The row exists, and the service marks it processing: the call is about to go out."},
{"el": "s2-ps-pr", "payload": "charge $80 · key pay_771", "text": "It calls the processor, passing its own payment ID as the processor's idempotency key."},
{"el": "s2-pr-ps", "payload": "(no answer after 10s)", "ms": 10000, "set": {"card.charges": "$80 · ch_9fK2"}, "text": "The same slow day. The bank approves after 11 seconds; the service stops waiting at 10."},
{"el": "s2-ps-db", "payload": "pay_771 → unknown", "set": {"pdb.pay_771": "unknown"}, "text": "The service records what it actually knows: the outcome is unknown. Not failed."},
{"el": "s2-ps-ck", "payload": "202 · processing", "ms": 2, "text": "Checkout is told the payment is still processing."},
{"el": "s2-ck-cu", "payload": "Processing…", "text": "Checkout shows a processing message rather than an error. The customer, impatient, clicks Pay again anyway."},
{"el": "s2-ck-ps", "payload": "POST /payments · key chk_5521_a", "text": "Same checkout, so the same key."},
{"el": "s2-ps-db", "payload": "insert · key chk_5521_a", "text": "The service tries to insert a payment with that key."},
{"el": "s2-db-ps", "payload": "exists: pay_771 · unknown", "ms": 2, "text": "The key already belongs to pay_771, whose outcome is unknown. The service doesn't create a second payment. It finishes the first."},
{"el": "s2-ps-pr", "payload": "charge $80 · key pay_771", "text": "It resends the charge with the same processor key."},
{"el": "s2-pr-ps", "payload": "succeeded · ch_9fK2 (original)", "ms": 300, "set": {"pdb.pay_771": "succeeded · ch_9fK2"}, "text": "The processor has seen key pay_771 before. It doesn't charge again. It returns the result of the first request — the charge that went through 11 seconds after it was sent — and the service records it."},
{"el": "s2-ps-ck", "payload": "201 · succeeded", "ms": 3, "text": "Checkout gets the success."},
{"el": "s2-ck-cu", "payload": "Paid", "text": "One charge of $80. However many times the customer clicks, every attempt lands on the same payment row, and every call to the processor carries the same key."}
]
},
{
"id": "double",
"label": "Two clicks at once",
"nodes": ["ck2", "ps2", "pr2", "db2"],
"steps": [
{"el": "s2-cu-ck", "payload": "Pay · Pay (double-click)", "set": {"pdb.pay_771": "—", "card.charges": "none"}, "text": "The customer double-clicks Pay. Two requests leave the browser a few milliseconds apart."},
{"el": "s2-ck-ps", "payload": "2 × POST · key chk_5521_a", "text": "Both reach the payment service, on two different servers, with the same key."},
{"el": "s2-ps-db", "payload": "2 × insert · key chk_5521_a", "text": "Each tries to insert a payment with that key. Looking the key up first and inserting only if it's absent wouldn't be safe: both could look, both find nothing, and both insert."},
{"el": "s2-db-ps", "payload": "one inserted · one duplicate key", "ms": 3, "set": {"pdb.pay_771": "processing · key chk_5521_a"}, "text": "The unique constraint decides. Exactly one insert succeeds; the other fails with a duplicate-key error."},
{"el": "s2-ps-ck", "payload": "409 · in progress (the loser)", "ms": 1, "text": "The losing request is told that a request with this key is already in progress. Checkout waits for the outcome instead of starting another payment."},
{"el": "s2-ps-pr", "payload": "charge $80 · key pay_771", "text": "Only the winner calls the processor."},
{"el": "s2-pr-ps", "payload": "succeeded · ch_9fK2", "ms": 600, "set": {"pdb.pay_771": "succeeded · ch_9fK2", "card.charges": "$80 · ch_9fK2"}, "text": "The charge succeeds, and the service records it."},
{"el": "s2-ps-ck", "payload": "201 · succeeded", "ms": 3, "text": "The winner's response reaches checkout."},
{"el": "s2-ck-cu", "payload": "Paid", "text": "One charge. Uniqueness is checked by the database, in one place, rather than by servers that can each be fooled by the other's timing."}
]
},
{
"id": "recover",
"label": "A crash after the charge",
"nodes": ["ps2", "pr2", "db2", "rw2"],
"steps": [
{"el": "s2-ck-ps", "payload": "POST /payments · key chk_5521_a", "set": {"pdb.pay_771": "—", "card.charges": "none"}, "text": "Checkout asks for the payment."},
{"el": "s2-ps-db", "payload": "insert pay_771 · created", "text": "The service records it first."},
{"el": "s2-db-ps", "payload": "inserted", "ms": 3, "set": {"pdb.pay_771": "processing"}, "text": "The payment is marked processing."},
{"el": "s2-ps-pr", "payload": "charge $80 · key pay_771", "text": "The service calls the processor."},
{"el": "s2-pr-ps", "payload": "succeeded · ch_9fK2 (unread)", "ms": 600, "set": {"card.charges": "$80 · ch_9fK2"}, "text": "The processor charges the card and replies, but the service's process is stopped by a deploy before it reads the answer. This time the marketplace hasn't lost track of the payment: pay_771 is in the database, marked processing."},
{"el": "s2-rw-db", "payload": "processing or unknown for over 1 min?", "ms": 60000, "text": "Every 30 seconds, the recovery worker asks for payments left processing or unknown for more than a minute. A minute later, pay_771 is one."},
{"el": "s2-db-rw", "payload": "pay_771 · processing since 14:02:07", "ms": 5, "text": "It gets pay_771, with its amount and token."},
{"el": "s2-rw-pr", "payload": "charge $80 · key pay_771", "text": "It resends the charge with the same key."},
{"el": "s2-pr-rw", "payload": "succeeded · ch_9fK2 (original)", "ms": 300, "text": "The processor returns the original result."},
{"el": "s2-rw-db", "payload": "pay_771 → succeeded · ch_9fK2", "set": {"pdb.pay_771": "succeeded · ch_9fK2"}, "text": "The worker records it. Checkout has been polling the payment while the customer waits, and now sees it succeed. Had the first request never reached the processor, the resend would simply have been the first charge. Either way, there is exactly one."}
]
}
]
}
</script>
<div class="diagram-caption">Checkout sends one idempotency key per checkout. The payment service records the payment under that key before calling the processor, uses the payment ID as the processor's key, and records a timeout as unknown. A recovery worker resends unresolved payments with the same key.</div>
</div>

<div class="fail-hint">Click checkout, the payment service, the processor, the recovery worker or the payments DB to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="ck2">
<strong>If checkout fails:</strong> customers can't start paying. A payment already sent to the payment service carries on without it, and when checkout comes back, a retry with the same key finds the payment's result.
</div>
<div class="failure-impact is-hidden" data-component="ps2">
<strong>If the payment service fails:</strong> new payments can't start. A payment that was mid-call is left processing in the database, and the recovery worker resolves it a minute later. Replay the third flow.
</div>
<div class="failure-impact is-hidden" data-component="pr2">
<strong>If the processor fails:</strong> payments pile up as unknown. None is lost and none is retried as a new charge: the recovery worker keeps resending each with its own key until the processor answers.
</div>
<div class="failure-impact is-hidden" data-component="rw2">
<strong>If the recovery worker fails:</strong> unknown payments stay unknown until it's back, and customers whose payment hit a timeout wait longer for their orders. Nothing is charged twice. A customer who retries still resolves their own payment through the service.
</div>
<div class="failure-impact is-hidden" data-component="db2">
<strong>If the payments DB fails:</strong> the service refuses every payment, because it can't record the intent before charging. Refusing is the safe choice: a charge with no record is exactly what Stage 2 exists to prevent.
</div>
</div>

Charges now happen once. But the payment row says only that $80 was charged. It doesn't say whose money that is: $72 for the merchant, $8 for the marketplace, minus what the processor keeps as its fee, minus any refund. Finance needs to know what the marketplace owes every merchant, to the cent, and to be able to prove it.

<!-- stage:3:3. Double-Entry Ledger -->

## Stage 3 — A Double-Entry Ledger

- **Every movement of money is a ledger transaction** of two or more entries, each a debit or a credit to one account. Total debits must equal total credits, or the transaction is rejected.
- **There is an account for everyone money can be owed to or by**: `processor_receivable:A` (what processor A has collected for the marketplace and not yet paid over), `merchant_payable:m42`, `platform_revenue`, `processor_fees`, `payouts_in_transit`, `bank_cash`.
- **Entries are never changed or deleted.** A mistake is corrected by a new transaction that reverses it.
- **A balance is the sum of an account's entries.** Each account also keeps a cached balance, updated in the same database transaction as its entries, so reading it doesn't mean adding up millions of rows.
- **A payment's status and its entries commit together.** pay_771 becomes `succeeded` in the same transaction that posts its charge entries. The status change is conditional — only from `processing`, `unknown` or `requires_action` — so the entries are posted once, however many times the success is reported.
- **Refunds and payouts are ledger transactions too.** A payout takes the money out of the merchant's balance before the bank transfer is sent.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 820 340" width="820" height="340" role="img" aria-label="Checkout calls the payment service, which charges through the card processor and posts balanced entries to the ledger in the same database; a payout job reads merchant balances and sends bank transfers">
  <g data-fail-toggle="ck3">
    <rect x="20" y="40" width="150" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="95" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Checkout</text>
    <text x="95" y="83" text-anchor="middle" class="d-label-muted" font-size="9">and the merchant dashboard</text>
  </g>
  <g data-fail-toggle="ps3">
    <rect x="260" y="30" width="180" height="80" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="350" y="58" text-anchor="middle" class="d-actor-label" font-size="12">Payment Service</text>
    <text x="350" y="76" text-anchor="middle" class="d-label-muted" font-size="9">charges · refunds</text>
    <text x="350" y="91" text-anchor="middle" class="d-label-muted" font-size="9">posts ledger transactions</text>
  </g>
  <g data-fail-toggle="pr3">
    <rect x="620" y="30" width="180" height="70" rx="6" class="d-actor-box"></rect>
    <text x="710" y="59" text-anchor="middle" class="d-actor-label" font-size="12">Card Processor</text>
    <text x="710" y="76" text-anchor="middle" class="d-label-muted" font-size="9">processor A</text>
  </g>
  <g data-fail-toggle="db3">
    <rect x="260" y="200" width="180" height="110" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="350" y="228" text-anchor="middle" class="d-actor-label" font-size="12">Payments + Ledger DB</text>
    <text x="350" y="247" text-anchor="middle" class="d-label-muted" font-size="9">payments · accounts</text>
    <text x="350" y="262" text-anchor="middle" class="d-label-muted" font-size="9">transactions · entries</text>
    <text x="350" y="277" text-anchor="middle" class="d-label-muted" font-size="9">debits = credits, always</text>
  </g>
  <g data-fail-toggle="pj3">
    <rect x="620" y="150" width="180" height="56" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="710" y="174" text-anchor="middle" class="d-actor-label" font-size="12">Payout Job</text>
    <text x="710" y="190" text-anchor="middle" class="d-label-muted" font-size="9">weekly</text>
  </g>
  <g data-fail-toggle="bk3">
    <rect x="620" y="256" width="180" height="56" rx="6" class="d-actor-box"></rect>
    <text x="710" y="280" text-anchor="middle" class="d-actor-label" font-size="12">Bank</text>
    <text x="710" y="296" text-anchor="middle" class="d-label-muted" font-size="9">transfers to merchants</text>
  </g>
  <line id="s3-ck-ps" x1="172" y1="60" x2="256" y2="60" class="d-msg d-request" data-depends-on="ck3 ps3" marker-end="url(#arrowP3)"></line>
  <line id="s3-ps-ck" x1="256" y1="85" x2="172" y2="85" class="d-msg d-response" data-depends-on="ck3 ps3" marker-end="url(#arrowP3r)"></line>
  <line id="s3-ps-pr" x1="442" y1="55" x2="616" y2="55" class="d-msg d-request" data-depends-on="ps3 pr3" marker-end="url(#arrowP3)"></line>
  <line id="s3-pr-ps" x1="616" y1="80" x2="442" y2="80" class="d-msg d-response" data-depends-on="ps3 pr3" marker-end="url(#arrowP3r)"></line>
  <line id="s3-ps-db" x1="330" y1="112" x2="330" y2="196" class="d-msg d-request" data-depends-on="ps3 db3" marker-end="url(#arrowP3)"></line>
  <line id="s3-db-ps" x1="380" y1="196" x2="380" y2="112" class="d-msg d-response" data-depends-on="ps3 db3" marker-end="url(#arrowP3r)"></line>
  <line id="s3-pj-db" x1="616" y1="170" x2="444" y2="232" class="d-msg d-request" data-depends-on="pj3 db3" marker-end="url(#arrowP3)"></line>
  <line id="s3-db-pj" x1="444" y1="252" x2="616" y2="192" class="d-msg d-response" data-depends-on="pj3 db3" marker-end="url(#arrowP3r)"></line>
  <line id="s3-pj-bk" x1="690" y1="208" x2="690" y2="252" class="d-msg d-request" data-depends-on="pj3 bk3" marker-end="url(#arrowP3)"></line>
  <line id="s3-bk-pj" x1="740" y1="252" x2="740" y2="208" class="d-msg d-response" data-depends-on="pj3 bk3" marker-end="url(#arrowP3r)"></line>
  <text x="410" y="332" text-anchor="middle" class="d-label-muted" font-size="10">play a charge, then a partial refund, then the merchant's payout</text>
  <defs>
    <marker id="arrowP3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowP3r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "lg", "title": "Ledger balances", "rows": [["processor_receivable:A", "—"], ["merchant_payable:m42", "—"], ["platform_revenue", "—"]]},
{"id": "tx", "title": "Latest transaction", "rows": [["debits", "—"], ["credits", "—"]]}
],
"flows": [
{
"id": "charge",
"label": "A charge, as balanced entries",
"nodes": ["ck3", "ps3", "pr3", "db3"],
"steps": [
{"el": "s3-ck-ps", "payload": "POST /payments · $80 · m42", "set": {"lg.processor_receivable:A": "$0.00", "lg.merchant_payable:m42": "$0.00", "lg.platform_revenue": "$0.00", "tx.debits": "—", "tx.credits": "—"}, "text": "Order 5521 again: $80 from merchant m42, on which the marketplace keeps a 10% fee. To keep the numbers readable, every balance starts at zero."},
{"el": "s3-ps-pr", "payload": "charge $80 · key pay_771", "text": "The payment is recorded and the processor called, exactly as in Stage 2."},
{"el": "s3-pr-ps", "payload": "succeeded · ch_9fK2", "ms": 600, "text": "The charge succeeds. Now: where is the $80? Not in the marketplace's bank account. The processor holds it, and will pay it over in two days, less its fee."},
{"el": "s3-ps-db", "payload": "pay_771 succeeded + 3 entries · one transaction", "set": {"tx.debits": "processor_receivable:A $80.00", "tx.credits": "merchant_payable:m42 $72.00 · platform_revenue $8.00"}, "text": "So the processor now owes the marketplace $80: a debit to processor_receivable:A. Of that, $72 is owed on to the merchant and $8 is the marketplace's fee: credits to merchant_payable:m42 and platform_revenue. Debits of $80, credits of $72 + $8."},
{"el": "s3-db-ps", "payload": "committed · debits = credits", "ms": 4, "set": {"lg.processor_receivable:A": "$80.00", "lg.merchant_payable:m42": "$72.00", "lg.platform_revenue": "$8.00"}, "text": "The database checks that the transaction balances, then commits the entries and the payment's new status together: both or neither. The status update applies only if pay_771 was still waiting for its outcome. A second report of the same success, from a retry or the recovery worker, finds it already succeeded and posts nothing."},
{"el": "s3-ps-ck", "payload": "201 · succeeded", "ms": 2, "text": "Every dollar is recorded twice, once where it came from and once where it went, so all the accounts together always sum to zero. A bug that credits a merchant without a matching debit can't be committed at all. And m42's balance isn't a number someone overwrote: it is the sum of entries, each pointing at the payment that caused it."}
]
},
{
"id": "refund",
"label": "A partial refund",
"nodes": ["ck3", "ps3", "pr3", "db3"],
"steps": [
{"el": "s3-ck-ps", "payload": "refund $30 · pay_771 · key rf_5521_1", "set": {"lg.processor_receivable:A": "$80.00", "lg.merchant_payable:m42": "$72.00", "lg.platform_revenue": "$8.00", "tx.debits": "—", "tx.credits": "—"}, "text": "One of the three books arrives damaged, and the merchant refunds $30 of the $80 from its dashboard."},
{"el": "s3-ps-db", "payload": "lock pay_771 · refunded so far?", "text": "The service locks pay_771's row and checks how much is left to refund. Two refunds sent at the same moment can't both pass this check, because the second waits for the first to commit."},
{"el": "s3-db-ps", "payload": "$80 charged · $0 refunded", "ms": 2, "text": "Up to $80 can be refunded, so $30 is allowed. The refund is recorded under its key before the processor is called, just like a charge."},
{"el": "s3-ps-pr", "payload": "refund $30 · ch_9fK2 · key re_41", "text": "The service asks the processor to refund $30 of charge ch_9fK2."},
{"el": "s3-pr-ps", "payload": "refunded", "ms": 500, "text": "The processor will return $30 to the customer's card."},
{"el": "s3-ps-db", "payload": "re_41 succeeded + 3 entries", "set": {"tx.debits": "merchant_payable:m42 $27.00 · platform_revenue $3.00", "tx.credits": "processor_receivable:A $30.00"}, "text": "The refund reverses the charge in proportion: the merchant gives back $27, the marketplace gives back its $3 fee, and the processor will now pay over $30 less."},
{"el": "s3-db-ps", "payload": "committed", "ms": 4, "set": {"lg.processor_receivable:A": "$50.00", "lg.merchant_payable:m42": "$45.00", "lg.platform_revenue": "$5.00"}, "text": "The original charge's entries are untouched. Anyone reading m42's account sees $72 in, then $27 out, with the refund that caused it."}
]
},
{
"id": "payout",
"label": "Paying the merchant",
"nodes": ["pj3", "db3", "bk3"],
"steps": [
{"el": "s3-pj-db", "payload": "balance of merchant_payable:m42?", "set": {"lg.processor_receivable:A": "$50.00", "lg.merchant_payable:m42": "$45.00", "lg.platform_revenue": "$5.00", "tx.debits": "—", "tx.credits": "—"}, "text": "Every Friday, the payout job pays each merchant what the ledger says it's owed."},
{"el": "s3-db-pj", "payload": "$45.00", "ms": 3, "text": "m42 is owed $45."},
{"el": "s3-pj-db", "payload": "payout po_88 + 2 entries", "set": {"tx.debits": "merchant_payable:m42 $45.00", "tx.credits": "payouts_in_transit $45.00", "lg.merchant_payable:m42": "$0.00"}, "text": "Before any money moves, the job records payout po_88 and moves the $45 from merchant_payable:m42 into payouts_in_transit, in one transaction. m42's balance is now zero, so if the job runs twice, or restarts after a crash, it finds nothing more to pay."},
{"el": "s3-pj-bk", "payload": "transfer $45 to m42 · key po_88", "text": "Then it asks the bank for the transfer, with the payout's ID as the idempotency key."},
{"el": "s3-bk-pj", "payload": "accepted", "ms": 200, "text": "The bank accepts it. If this answer had been lost, resending with key po_88 couldn't pay twice."},
{"el": "s3-pj-db", "payload": "po_88 settled: in_transit → bank_cash", "set": {"tx.debits": "payouts_in_transit $45.00", "tx.credits": "bank_cash $45.00"}, "text": "When the bank confirms the transfer has settled, a last transaction moves the $45 out of payouts_in_transit and out of the marketplace's bank account. Had the transfer bounced — a closed account — a reversing transaction would have put the $45 back into merchant_payable:m42. At every moment, the ledger says exactly where the money is."}
]
}
]
}
</script>
<div class="diagram-caption">Charges, refunds and payouts are each posted as one balanced ledger transaction, in the same database transaction as the status change that caused them. A payout moves the merchant's balance into payouts_in_transit before the bank transfer is sent.</div>
</div>

<div class="fail-hint">Click checkout, the payment service, the processor, the database, the payout job or the bank to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="ck3">
<strong>If checkout fails:</strong> no new payments or refunds are requested. The ledger is unaffected.
</div>
<div class="failure-impact is-hidden" data-component="ps3">
<strong>If the payment service fails mid-charge:</strong> the payment is left processing with no entries posted. The recovery worker resolves it, and the entries are posted in the same transaction as the success — never twice, never without it.
</div>
<div class="failure-impact is-hidden" data-component="pr3">
<strong>If the processor fails:</strong> charges and refunds wait as unknown, with no entries. The ledger only ever records money that has actually moved.
</div>
<div class="failure-impact is-hidden" data-component="db3">
<strong>If the database fails:</strong> everything stops — payments, refunds and payouts. A synchronous replica in another zone takes over with every committed entry. Nothing can be charged without being recorded, so the service refuses work rather than charging blind.
</div>
<div class="failure-impact is-hidden" data-component="pj3">
<strong>If the payout job fails:</strong> merchants are paid late. A payout recorded before the crash has already left the merchant's balance, so a restarted job resends that transfer with the same key instead of paying again.
</div>
<div class="failure-impact is-hidden" data-component="bk3">
<strong>If the bank fails:</strong> transfers wait in payouts_in_transit. Merchant balances stay correct, because the money is accounted for while it waits.
</div>
</div>

The books are exact for everything the service does itself. But not everything happens inside the service's own requests. Some banks ask the customer to approve a payment in their banking app, and the outcome arrives minutes later. The processor reports refunds that failed and charges that were disputed on its own schedule. Other services need to hear about every payment, reliably. And nothing has yet checked the service's records against the processor's.

<!-- stage:4:4. Webhooks, Outbox, Reconciliation -->

## Stage 4 — Outcomes That Arrive Later, and Checking the Books

- **Webhooks.** The processor sends a signed notification for every event: a charge that succeeded after the bank's approval, a refund that failed, a dispute opened. A webhook receiver verifies the signature and applies the same conditional status change the service would.
- **Duplicates are expected.** The processor resends any webhook that isn't acknowledged within a few seconds. Event IDs are stored under a unique key, and a repeat is acknowledged and ignored.
- **A transactional outbox.** A payment's status change, its ledger entries and an event for other services are written in one transaction. A relay publishes unsent events, and receivers ignore events they've already processed.
- **Daily reconciliation.** Each processor publishes a settlement report: every charge, refund and fee it settled the day before. A reconciler matches every line to a payment, posts the settlement entries, and sends every line that doesn't match to a queue for finance.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 400" width="860" height="400" role="img" aria-label="The payment service and a webhook receiver both update the payments database; an outbox relay publishes payment events to the order service; a reconciler matches the processor's settlement report against the database">
  <rect x="20" y="50" width="150" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="95" y="76" text-anchor="middle" class="d-actor-label" font-size="12">Customer</text>
  <text x="95" y="93" text-anchor="middle" class="d-label-muted" font-size="9">browser</text>
  <g data-fail-toggle="ps4">
    <rect x="230" y="44" width="180" height="76" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="320" y="72" text-anchor="middle" class="d-actor-label" font-size="12">Payment Service</text>
    <text x="320" y="90" text-anchor="middle" class="d-label-muted" font-size="9">via checkout</text>
    <text x="320" y="105" text-anchor="middle" class="d-label-muted" font-size="9">charges · refunds</text>
  </g>
  <g data-fail-toggle="pr4">
    <rect x="660" y="50" width="180" height="70" rx="6" class="d-actor-box"></rect>
    <text x="750" y="79" text-anchor="middle" class="d-actor-label" font-size="12">Card Processor</text>
    <text x="750" y="96" text-anchor="middle" class="d-label-muted" font-size="9">webhooks · daily reports</text>
  </g>
  <g data-fail-toggle="db4">
    <rect x="230" y="190" width="170" height="96" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="315" y="216" text-anchor="middle" class="d-actor-label" font-size="12">Payments DB</text>
    <text x="315" y="234" text-anchor="middle" class="d-label-muted" font-size="9">payments · ledger</text>
    <text x="315" y="249" text-anchor="middle" class="d-label-muted" font-size="9">processor events</text>
    <text x="315" y="264" text-anchor="middle" class="d-label-muted" font-size="9">outbox</text>
  </g>
  <g data-fail-toggle="wh4">
    <rect x="490" y="170" width="160" height="56" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="570" y="194" text-anchor="middle" class="d-actor-label" font-size="12">Webhook Receiver</text>
    <text x="570" y="210" text-anchor="middle" class="d-label-muted" font-size="9">verifies · dedups</text>
  </g>
  <g data-fail-toggle="rl4">
    <rect x="20" y="200" width="150" height="56" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="95" y="224" text-anchor="middle" class="d-actor-label" font-size="12">Outbox Relay</text>
    <text x="95" y="240" text-anchor="middle" class="d-label-muted" font-size="9">polls every 100ms</text>
  </g>
  <g data-fail-toggle="os4">
    <rect x="20" y="320" width="150" height="56" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="95" y="344" text-anchor="middle" class="d-actor-label" font-size="12">Order Service</text>
    <text x="95" y="360" text-anchor="middle" class="d-label-muted" font-size="9">ships paid orders</text>
  </g>
  <g data-fail-toggle="rc4">
    <rect x="660" y="290" width="180" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="750" y="316" text-anchor="middle" class="d-actor-label" font-size="12">Reconciler</text>
    <text x="750" y="333" text-anchor="middle" class="d-label-muted" font-size="9">daily · line by line</text>
  </g>
  <line id="k4-c-ps" x1="172" y1="70" x2="226" y2="70" class="d-msg d-request" data-depends-on="ps4" marker-end="url(#arrowP4)"></line>
  <line id="k4-ps-c" x1="226" y1="95" x2="172" y2="95" class="d-msg d-response" data-depends-on="ps4" marker-end="url(#arrowP4r)"></line>
  <path id="k4-c-pr" d="M95,48 L95,32 L740,32 L740,46" class="d-msg d-request" data-depends-on="pr4" marker-end="url(#arrowP4)"></path>
  <path id="k4-pr-c" d="M790,48 L790,18 L60,18 L60,46" class="d-msg d-response" data-depends-on="pr4" marker-end="url(#arrowP4r)"></path>
  <line id="k4-ps-pr" x1="412" y1="68" x2="656" y2="72" class="d-msg d-request" data-depends-on="ps4 pr4" marker-end="url(#arrowP4)"></line>
  <line id="k4-pr-ps" x1="656" y1="94" x2="412" y2="92" class="d-msg d-response" data-depends-on="ps4 pr4" marker-end="url(#arrowP4r)"></line>
  <line id="k4-ps-db" x1="300" y1="122" x2="300" y2="186" class="d-msg d-request" data-depends-on="ps4 db4" marker-end="url(#arrowP4)"></line>
  <line id="k4-db-ps" x1="340" y1="186" x2="340" y2="122" class="d-msg d-response" data-depends-on="ps4 db4" marker-end="url(#arrowP4r)"></line>
  <line id="k4-pr-wh" x1="690" y1="122" x2="600" y2="166" class="d-msg d-request" data-depends-on="pr4 wh4" marker-end="url(#arrowP4)"></line>
  <line id="k4-wh-pr" x1="625" y1="166" x2="725" y2="122" class="d-msg d-response" data-depends-on="pr4 wh4" marker-end="url(#arrowP4r)"></line>
  <line id="k4-wh-db" x1="486" y1="200" x2="404" y2="215" class="d-msg d-request" data-depends-on="wh4 db4" marker-end="url(#arrowP4)"></line>
  <line id="k4-rl-db" x1="172" y1="218" x2="226" y2="218" class="d-msg d-request" data-depends-on="rl4 db4" marker-end="url(#arrowP4)"></line>
  <line id="k4-db-rl" x1="226" y1="242" x2="172" y2="242" class="d-msg d-response" data-depends-on="rl4 db4" marker-end="url(#arrowP4r)"></line>
  <line id="k4-rl-os" x1="95" y1="258" x2="95" y2="316" class="d-msg d-request" data-depends-on="rl4 os4" marker-end="url(#arrowP4)"></line>
  <line id="k4-pr-rc" x1="770" y1="122" x2="770" y2="286" class="d-msg d-request" data-depends-on="pr4 rc4" marker-end="url(#arrowP4)"></line>
  <line id="k4-rc-db" x1="656" y1="310" x2="404" y2="262" class="d-msg d-request" data-depends-on="rc4 db4" marker-end="url(#arrowP4)"></line>
  <line id="k4-db-rc" x1="404" y1="278" x2="656" y2="326" class="d-msg d-response" data-depends-on="rc4 db4" marker-end="url(#arrowP4r)"></line>
  <text x="430" y="392" text-anchor="middle" class="d-label-muted" font-size="10">play the bank's approval, then the outbox, then the nightly reconciliation</text>
  <defs>
    <marker id="arrowP4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowP4r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "p", "title": "Payments", "rows": [["pay_771", "—"], ["pay_8812", "—"]]},
{"id": "ev", "title": "Events and checks", "rows": [["processor events", "—"], ["outbox", "—"], ["reconciliation", "—"]]}
],
"flows": [
{
"id": "approval",
"label": "The bank asks the customer",
"nodes": ["ps4", "pr4", "db4", "wh4"],
"steps": [
{"el": "k4-c-ps", "payload": "Pay $80 · key chk_5521_a", "set": {"p.pay_771": "—", "p.pay_8812": "—", "ev.processor events": "—", "ev.outbox": "—", "ev.reconciliation": "—"}, "text": "The customer pays. This time the card's bank wants the customer to confirm the payment in its banking app. Many banks require this for online payments."},
{"el": "k4-ps-pr", "payload": "charge $80 · key pay_771", "set": {"p.pay_771": "processing"}, "text": "The service records the payment and calls the processor, as before."},
{"el": "k4-pr-ps", "payload": "requires_action · bank page", "ms": 500, "set": {"p.pay_771": "requires_action"}, "text": "The processor can't complete the charge yet. It answers requires_action, with a link to the bank's approval page."},
{"el": "k4-ps-c", "payload": "approve with your bank", "ms": 2, "text": "Checkout shows the bank's page to the customer."},
{"el": "k4-c-pr", "payload": "approve in the bank's app", "text": "The customer approves the payment on their phone. That can take ten seconds, ten minutes, or never happen."},
{"el": "k4-pr-c", "payload": "back to the marketplace", "text": "The browser is sent back to the marketplace with a note that the approval finished. That note travels through the customer's browser, where anyone could forge it, so the service doesn't treat it as proof of payment. It only shows a waiting message."},
{"el": "k4-pr-wh", "payload": "payment.succeeded · evt_31 · signed", "text": "The proof comes from the processor itself: a webhook to the marketplace's receiver, signed with a secret the two share."},
{"el": "k4-wh-db", "payload": "evt_31 new → pay_771 succeeded + entries + outbox", "set": {"p.pay_771": "succeeded · charge posted", "ev.processor events": "evt_31", "ev.outbox": "payment.succeeded pay_771"}, "text": "The receiver checks the signature. Then, in one transaction, it records evt_31, moves pay_771 from requires_action to succeeded, posts the charge entries, and writes an outbox event."},
{"el": "k4-wh-pr", "payload": "200", "ms": 4, "text": "Then it acknowledges the webhook."},
{"el": "k4-pr-wh", "payload": "payment.succeeded · evt_31 (again)", "text": "The acknowledgement was lost on the way, so a few seconds later the processor sends evt_31 again. Processors deliver webhooks at least once, never exactly once."},
{"el": "k4-wh-db", "payload": "evt_31 already recorded", "text": "evt_31 is already in the processor events table, so nothing changes and nothing is posted. The conditional status change would have caught it anyway — pay_771 is no longer waiting — but the event table also catches events that don't change a status, such as an update to a dispute."},
{"el": "k4-wh-pr", "payload": "200", "ms": 2, "text": "The receiver acknowledges again, and the processor stops sending."}
]
},
{
"id": "outbox",
"label": "Telling the order service",
"nodes": ["ps4", "db4", "rl4", "os4"],
"steps": [
{"el": "k4-ps-db", "payload": "pay_771 succeeded + entries + outbox row", "set": {"p.pay_771": "succeeded", "p.pay_8812": "—", "ev.processor events": "—", "ev.outbox": "payment.succeeded pay_771 · unsent", "ev.reconciliation": "—"}, "text": "The payment service records a success. The order service needs to hear about it, so that order 5521 ships. Calling it directly goes wrong one way or the other. Call it after the commit, and a crash in between means the order never ships. Call it before, and a commit that then fails means an order ships unpaid. So the event goes into an outbox table, in the same transaction as the payment."},
{"el": "k4-db-ps", "payload": "committed", "ms": 4, "text": "Payment, entries and event are committed together."},
{"el": "k4-ps-c", "payload": "Paid", "ms": 2, "text": "The customer is answered. Suppose the service crashes right now: nothing is lost, because the event is already in the database."},
{"el": "k4-rl-db", "payload": "unsent events?", "text": "The outbox relay asks for unsent events every 100ms."},
{"el": "k4-db-rl", "payload": "event 4410 · payment.succeeded · order 5521", "ms": 2, "text": "It finds the new one."},
{"el": "k4-rl-os", "payload": "payment.succeeded · event 4410", "text": "It publishes the event to the order service."},
{"el": "k4-rl-db", "payload": "mark 4410 sent", "set": {"ev.outbox": "payment.succeeded pay_771 · sent"}, "text": "Then it marks the event sent. If the relay crashed between publishing and marking, it would publish the event again on restart. So the order service keeps the IDs of the events it has processed and ignores a repeat. Every event is delivered at least once, and acted on once."}
]
},
{
"id": "recon",
"label": "The nightly reconciliation",
"nodes": ["pr4", "db4", "rc4"],
"steps": [
{"el": "k4-pr-rc", "payload": "settlement report · Oct 10 · 20M lines", "set": {"p.pay_771": "succeeded", "p.pay_8812": "failed (as recorded)", "ev.processor events": "—", "ev.outbox": "—", "ev.reconciliation": "running"}, "text": "Each morning, processor A publishes yesterday's settlement report: every charge, refund and fee it settled, about 20 million lines, and the total it's paying into the marketplace's bank account."},
{"el": "k4-rc-db", "payload": "payments and refunds for Oct 10", "text": "The reconciler loads the marketplace's own records for the same day."},
{"el": "k4-db-rc", "payload": "20M payments · 1M refunds", "ms": 90000, "text": "It matches each line of the report to a payment by the payment ID in the charge's metadata, and checks the amount and currency."},
{"el": "k4-rc-db", "payload": "settlement: bank_cash + processor_fees ← processor_receivable:A", "set": {"ev.reconciliation": "19,999,997 matched and settled"}, "text": "Matched lines are settled in the ledger: what the processor owed becomes cash in the bank, less its fee. For pay_771 that's $77.38 in the bank and $2.62 in processor_fees, against the $80 receivable. The receivable for the day drops to zero."},
{"el": "k4-rc-db", "payload": "3 exceptions → finance queue", "set": {"p.pay_8812": "failed here · $40 settled by A", "ev.reconciliation": "3 exceptions for finance"}, "text": "Three lines don't match. pay_8812 is recorded as failed, but the processor settled $40 for it: a bug in a new release treated a timeout as a decline. The customer was charged for an order the marketplace cancelled, so finance refunds them and the bug is fixed. A refund the service recorded as succeeded was later rejected by the customer's bank, so the money was never returned. And a charge made at 23:59:59 isn't in the report at all: it fell after the processor's cut-off and will appear tomorrow. The reconciler holds it for a day before calling it missing. Every mistake that slips past idempotency keys and status checks ends up here within a day, as a line that doesn't match."}
]
}
]
}
</script>
<div class="diagram-caption">The processor reports outcomes through signed webhooks, deduplicated by event ID. Every status change writes its ledger entries and an outbox event in the same transaction, and a relay publishes the events. Each morning a reconciler matches the processor's settlement report against the database, line by line.</div>
</div>

<div class="fail-hint">Click the payment service, the processor, the database, the webhook receiver, the outbox relay, the order service or the reconciler to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="ps4">
<strong>If the payment service fails:</strong> new payments stop. Outcomes for payments already sent keep arriving by webhook and are recorded by the receiver, so a payment waiting on the customer's bank still completes.
</div>
<div class="failure-impact is-hidden" data-component="pr4">
<strong>If the processor fails:</strong> charges wait as unknown, webhooks stop, and the day's report is late. When the processor recovers it sends the webhooks it owes, and the recovery worker resolves the rest.
</div>
<div class="failure-impact is-hidden" data-component="db4">
<strong>If the database fails:</strong> the service, the receiver and the relay all stop. The receiver can't acknowledge webhooks, so the processor keeps resending them, for up to three days, until the database is back.
</div>
<div class="failure-impact is-hidden" data-component="wh4">
<strong>If the webhook receiver fails:</strong> the processor's webhooks go unacknowledged and are resent with backoff. Payments waiting on the customer's bank stay requires_action until it recovers, then complete. The recovery worker also asks the processor about payments left waiting for more than an hour.
</div>
<div class="failure-impact is-hidden" data-component="rl4">
<strong>If the outbox relay fails:</strong> payments still succeed, but orders don't hear about them, and paid orders wait to ship. Events pile up in the outbox and are published, in order, when it recovers. Replay the second flow.
</div>
<div class="failure-impact is-hidden" data-component="os4">
<strong>If the order service fails:</strong> events wait for it. Payments are unaffected.
</div>
<div class="failure-impact is-hidden" data-component="rc4">
<strong>If the reconciler fails:</strong> nothing changes for customers, but the day's mismatches go unseen and the processor's receivable isn't settled in the ledger. It catches up on the missed reports when it runs again.
</div>
</div>

Every payment is now accounted for, whichever way its outcome arrives, and checked against the processor every day. Two single points remain. One processor: when it's down, the marketplace can't take money. And one database: at a sale's peak it takes 2,000 payments a second, and every one of them updates the same account, the marketplace's revenue.

<!-- stage:5:5. Two Processors, Sharded Ledger -->

## Stage 5 — Two Processors and a Sharded Ledger

- **Two processors.** The payment service sends each new payment to processor A or processor B, choosing by cost, card type and health. A circuit breaker per processor counts errors and timeouts. When one is failing, new payments go to the other.
- **Card tokens both processors accept.** A token made by processor A's form means nothing to processor B. Card numbers are kept in a card vault — a small, tightly controlled service, the only part of the marketplace allowed to hold them — which gives each processor a token of its own for the same card.
- **A payment stays with the processor it was sent to.** A payment whose outcome is unknown at A is resolved at A, however long that takes. It is never retried at B.
- **The database is sharded by merchant.** 16 shards, each holding its merchants' payments, ledger entries and outbox ([Partitioning & Sharding](#/systems/partitioning-sharding)). Everything a payment writes lands on one shard.
- **Shared accounts are split per shard.** `platform_revenue` and `processor_receivable:A` become 16 sub-accounts each, one per shard. A payment only touches its own shard's sub-accounts, and a reporting job adds them up.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 820 360" width="820" height="360" role="img" aria-label="Checkout calls the payment service, which routes each payment to processor A or processor B and records it on the ledger shard that owns the merchant; a recovery worker resolves unknown payments at the processor they were sent to">
  <rect x="20" y="140" width="150" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="95" y="166" text-anchor="middle" class="d-actor-label" font-size="12">Checkout</text>
  <text x="95" y="183" text-anchor="middle" class="d-label-muted" font-size="9">and other callers</text>
  <g data-fail-toggle="ps5">
    <rect x="250" y="110" width="190" height="110" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="345" y="140" text-anchor="middle" class="d-actor-label" font-size="12">Payment Service</text>
    <text x="345" y="158" text-anchor="middle" class="d-label-muted" font-size="9">breaker per processor</text>
    <text x="345" y="173" text-anchor="middle" class="d-label-muted" font-size="9">tokens from the card vault</text>
    <text x="345" y="188" text-anchor="middle" class="d-label-muted" font-size="9">shard = hash(merchant)</text>
  </g>
  <g data-fail-toggle="pa5">
    <rect x="620" y="24" width="180" height="64" rx="6" class="d-actor-box"></rect>
    <text x="710" y="51" text-anchor="middle" class="d-actor-label" font-size="12">Processor A</text>
    <text x="710" y="68" text-anchor="middle" class="d-label-muted" font-size="9">usual choice</text>
  </g>
  <g data-fail-toggle="rw5">
    <rect x="620" y="140" width="180" height="56" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="710" y="164" text-anchor="middle" class="d-actor-label" font-size="12">Recovery Worker</text>
    <text x="710" y="180" text-anchor="middle" class="d-label-muted" font-size="9">asks the original processor</text>
  </g>
  <g data-fail-toggle="pb5">
    <rect x="620" y="256" width="180" height="64" rx="6" class="d-actor-box"></rect>
    <text x="710" y="283" text-anchor="middle" class="d-actor-label" font-size="12">Processor B</text>
    <text x="710" y="300" text-anchor="middle" class="d-label-muted" font-size="9">second processor</text>
  </g>
  <g data-fail-toggle="s35">
    <rect x="220" y="280" width="130" height="56" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="285" y="304" text-anchor="middle" class="d-actor-label" font-size="12">Shard 3</text>
    <text x="285" y="320" text-anchor="middle" class="d-label-muted" font-size="9">m42 · revenue:s3</text>
  </g>
  <g data-fail-toggle="s75">
    <rect x="380" y="280" width="140" height="56" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="450" y="304" text-anchor="middle" class="d-actor-label" font-size="12">Shard 7</text>
    <text x="450" y="320" text-anchor="middle" class="d-label-muted" font-size="9">m77 · revenue:s7</text>
  </g>
  <line id="k5-c-ps" x1="172" y1="160" x2="246" y2="160" class="d-msg d-request" data-depends-on="ps5" marker-end="url(#arrowP5)"></line>
  <line id="k5-ps-c" x1="246" y1="186" x2="172" y2="186" class="d-msg d-response" data-depends-on="ps5" marker-end="url(#arrowP5r)"></line>
  <line id="k5-ps-a" x1="442" y1="130" x2="616" y2="52" class="d-msg d-request" data-depends-on="ps5 pa5" marker-end="url(#arrowP5)"></line>
  <line id="k5-a-ps" x1="616" y1="70" x2="442" y2="145" class="d-msg d-response" data-depends-on="ps5 pa5" marker-end="url(#arrowP5r)"></line>
  <line id="k5-ps-b" x1="442" y1="190" x2="616" y2="278" class="d-msg d-request" data-depends-on="ps5 pb5" marker-end="url(#arrowP5)"></line>
  <line id="k5-b-ps" x1="616" y1="296" x2="442" y2="205" class="d-msg d-response" data-depends-on="ps5 pb5" marker-end="url(#arrowP5r)"></line>
  <line id="k5-rw-a" x1="690" y1="138" x2="690" y2="92" class="d-msg d-request" data-depends-on="rw5 pa5" marker-end="url(#arrowP5)"></line>
  <line id="k5-a-rw" x1="740" y1="92" x2="740" y2="138" class="d-msg d-response" data-depends-on="rw5 pa5" marker-end="url(#arrowP5r)"></line>
  <line id="k5-rw-ps" x1="616" y1="168" x2="446" y2="168" class="d-msg d-request" data-depends-on="rw5 ps5" marker-end="url(#arrowP5)"></line>
  <line id="k5-ps-s3" x1="300" y1="222" x2="290" y2="276" class="d-msg d-request" data-depends-on="ps5 s35" marker-end="url(#arrowP5)"></line>
  <line id="k5-s3-ps" x1="320" y1="276" x2="330" y2="222" class="d-msg d-response" data-depends-on="ps5 s35" marker-end="url(#arrowP5r)"></line>
  <line id="k5-ps-s7" x1="400" y1="222" x2="430" y2="276" class="d-msg d-request" data-depends-on="ps5 s75" marker-end="url(#arrowP5)"></line>
  <line id="k5-s7-ps" x1="455" y1="276" x2="425" y2="222" class="d-msg d-response" data-depends-on="ps5 s75" marker-end="url(#arrowP5r)"></line>
  <text x="410" y="354" text-anchor="middle" class="d-label-muted" font-size="10">play a routed payment, then processor A failing mid-payment, then a sale's peak</text>
  <defs>
    <marker id="arrowP5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowP5r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "rt", "title": "Routing", "rows": [["processor A", "—"], ["processor B", "—"]]},
{"id": "sh", "title": "Ledger", "rows": [["pay_771", "—"], ["pay_904", "—"], ["platform_revenue", "—"]]}
],
"flows": [
{
"id": "route",
"label": "A payment, routed and recorded",
"nodes": ["ps5", "pa5", "pb5", "s35"],
"steps": [
{"el": "k5-c-ps", "payload": "Pay $80 · order 5521 · m42", "set": {"rt.processor A": "healthy", "rt.processor B": "healthy", "sh.pay_771": "—", "sh.pay_904": "—", "sh.platform_revenue": "—"}, "text": "Order 5521 once more. The payment service hashes the merchant, m42, to find its shard: shard 3. The payment row is written there first, as in Stage 2."},
{"el": "k5-ps-a", "payload": "charge $80 · key pay_771", "altEl": "k5-ps-b", "altText": "Processor A is down and its breaker is open, so this new payment goes to processor B, using the token for this card that the card vault holds for B. It has never been sent anywhere, so sending it to B can't charge twice.", "altSet": {"rt.processor A": "breaker open", "rt.processor B": "taking new payments"}, "text": "Both processors are healthy, and A is cheaper for this card type, so the payment goes to A. The row now records processor A, permanently."},
{"el": "k5-a-ps", "payload": "succeeded · ch_9fK2", "altEl": "k5-b-ps", "ms": 600, "text": "The charge succeeds."},
{"el": "k5-ps-s3", "payload": "pay_771 succeeded + entries + outbox", "set": {"sh.pay_771": "succeeded · shard 3", "sh.platform_revenue": "+$8 on revenue:s3"}, "text": "The status change, the three entries and the outbox event all go to shard 3. The fee is credited to platform_revenue:s3, the marketplace revenue account's sub-account on this shard, so nothing in the transaction leaves the shard."},
{"el": "k5-s3-ps", "payload": "committed", "ms": 4, "text": "One shard, one local transaction, exactly as before sharding."},
{"el": "k5-ps-c", "payload": "201 · succeeded", "ms": 2, "text": "Fail processor A and replay: the payment goes to B instead, and nothing else changes."}
]
},
{
"id": "outage",
"label": "Processor A fails mid-payment",
"nodes": ["ps5", "pa5", "pb5", "rw5", "s75"],
"steps": [
{"el": "k5-c-ps", "payload": "Pay $120 · order 6120 · m77", "set": {"rt.processor A": "healthy", "rt.processor B": "healthy", "sh.pay_771": "—", "sh.pay_904": "processing at A · shard 7", "sh.platform_revenue": "—"}, "text": "A customer of merchant m77 pays $120. m77's shard is shard 7, where the payment is recorded as pay_904."},
{"el": "k5-ps-a", "payload": "charge $120 · key pay_904", "text": "It goes to processor A."},
{"el": "k5-a-ps", "payload": "(no answer after 10s)", "ms": 10000, "set": {"rt.processor A": "timing out"}, "text": "Processor A is in the middle of an outage, and the call times out."},
{"el": "k5-ps-s7", "payload": "pay_904 → unknown · processor A", "set": {"sh.pay_904": "unknown at A"}, "text": "pay_904 is recorded as unknown, still assigned to processor A. Retrying it at B would be quick, and wrong. A may have charged the card before it went down. B has never seen key pay_904, so it would charge the card again: $240 for a $120 order."},
{"el": "k5-ps-c", "payload": "202 · processing", "ms": 2, "text": "Checkout tells the customer the payment is processing."},
{"el": "k5-ps-b", "payload": "charge · key pay_905 (a new payment)", "set": {"rt.processor A": "breaker open", "rt.processor B": "taking new payments"}, "text": "Within 30 seconds, more than 20% of calls to A have failed, and A's breaker opens. New payments — ones never sent anywhere — go to B. The marketplace keeps taking money."},
{"el": "k5-b-ps", "payload": "succeeded", "ms": 600, "text": "B's charges succeed."},
{"el": "k5-rw-a", "payload": "status of pay_904?", "text": "Meanwhile, the recovery worker asks A about pay_904 every minute, and gets no answer."},
{"el": "k5-a-rw", "payload": "succeeded · ch_77Tq", "ms": 1200000, "text": "A recovers after 20 minutes and answers: it charged the card before the outage. The customer was charged once."},
{"el": "k5-rw-ps", "payload": "pay_904 succeeded at A", "text": "The worker hands the result to the payment service."},
{"el": "k5-ps-s7", "payload": "pay_904 succeeded + entries", "set": {"sh.pay_904": "succeeded at A · shard 7", "rt.processor A": "recovering · test traffic"}, "text": "pay_904 succeeds on shard 7, and order 6120 ships 20 minutes late: that is the price of never charging twice. A's breaker lets a trickle of new payments through to test it, and closes once they succeed."}
]
},
{
"id": "sale",
"label": "A sale: 2,000 payments a second",
"nodes": ["ps5", "s35", "s75"],
"steps": [
{"el": "k5-c-ps", "payload": "2,000 payments a second", "set": {"rt.processor A": "healthy", "rt.processor B": "healthy", "sh.pay_771": "—", "sh.pay_904": "—", "sh.platform_revenue": "one account · 500 updates/s max"}, "text": "A holiday sale: payments peak at 2,000 a second. In one database, every one of them updates platform_revenue's cached balance — the same row, 2,000 times a second. Each update has to wait for the one before it to commit, about 2ms each including the replica in another zone. So that one row can take about 500 payments a second, and everything else queues behind it."},
{"el": "k5-ps-s3", "payload": "m42's payment · revenue:s3", "set": {"sh.platform_revenue": "16 sub-accounts · ~125 updates/s each"}, "text": "With 16 shards, each payment goes to its merchant's shard and credits that shard's sub-account. m42's payment credits platform_revenue:s3."},
{"el": "k5-ps-s7", "payload": "m77's payment · revenue:s7", "text": "m77's, at the same moment, credits platform_revenue:s7. Different rows on different machines, so neither waits for the other."},
{"el": "k5-s3-ps", "payload": "committed", "ms": 4, "text": "Each shard takes about 125 payments a second, well within what one database primary handles."},
{"el": "k5-s7-ps", "payload": "committed", "ms": 4, "text": "The marketplace's total revenue is the sum of 16 balances, which a reporting job adds up every minute."},
{"el": "k5-ps-c", "payload": "201 · succeeded", "ms": 2, "text": "A merchant's payments, refunds and payouts all live on one shard, so nothing a merchant does needs two shards. The one thing that does — the marketplace's own totals — is read, never written, across shards."}
]
}
]
}
</script>
<div class="diagram-caption">The payment service routes each new payment to a healthy processor, and a payment stays with that processor until its outcome is known. Payments and ledger entries are sharded by merchant, and accounts every payment touches are split into one sub-account per shard.</div>
</div>

<div class="fail-hint">Click the payment service, either processor, the recovery worker or either shard to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="ps5">
<strong>If a payment service instance fails:</strong> it is one of many, behind a load balancer. Its in-flight payments are left processing on their shards and resolved by the recovery worker.
</div>
<div class="failure-impact is-hidden" data-component="pa5">
<strong>If processor A fails:</strong> its breaker opens and new payments go to B. Payments already sent to A stay unknown until A answers. Replay the first flow to see a new payment rerouted, and the second to see one caught mid-call.
</div>
<div class="failure-impact is-hidden" data-component="pb5">
<strong>If processor B fails:</strong> the same, the other way round: new payments go to A.
</div>
<div class="failure-impact is-hidden" data-component="rw5">
<strong>If the recovery worker fails:</strong> unknown payments wait longer, and their orders with them. Nothing is charged twice.
</div>
<div class="failure-impact is-hidden" data-component="s35">
<strong>If shard 3 fails:</strong> its synchronous replica takes over within about 30 seconds. Until then, payments for merchants on shard 3 are refused; merchants on the other 15 shards are unaffected.
</div>
<div class="failure-impact is-hidden" data-component="s75">
<strong>If shard 7 fails:</strong> the same, for shard 7's merchants. A shard failure affects about one merchant in sixteen, never all of them.
</div>
</div>

This is the full design. Every payment is recorded under the caller's idempotency key before any money moves, and the payment ID is the processor's idempotency key, so retries from any direction find the same payment and the same charge. A timeout is recorded as unknown and resolved by asking the same processor again, never by charging somewhere else. Each change of a payment's status commits in one transaction with balanced ledger entries and an outbox event, so the books, the payment and the rest of the marketplace never disagree, and a status change only happens once. Outcomes arrive by webhook as well as by reply, deduplicated by event ID, and every morning the processors' settlement reports are matched against the ledger line by line. Two processors behind circuit breakers keep payments flowing when one fails, and a ledger sharded by merchant, with shared accounts split per shard, absorbs a sale's peak.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### Two idempotency keys

A payment passes through two idempotency keys, each protecting one hop.

- **The caller's key** (chk_5521_a) protects the hop from checkout to the payment service. Checkout makes it once per attempt to pay, so a retried request finds the same payment. It is scoped to the caller, so two services can't collide, and stored with a hash of the request body, so a reused key with a different amount is caught.
- **The payment ID** (pay_771) protects the hop from the payment service to the processor. Every call for that payment, from the service, the recovery worker or a retry, carries it.

**Keys don't last forever.** Processors keep a key's result for a limited time, often 24 hours. After that, resending pay_771 would be treated as new, and charge again. So the recovery worker escalates. A payment unknown for an hour is looked up by its payment ID in the charge's metadata instead of being resent, and one unresolved after 12 hours goes to a person. The service keeps its own callers' keys for 30 days, longer than any caller retries.

**A request still in flight.** If a second request with the same key arrives while the first is still waiting on the processor, the second doesn't wait on a lock for 10 seconds. It is answered `409` at once, and the caller asks for the payment's status.

### The payment state machine

```
created ──► processing ──► succeeded
                │    └───► failed
                │    └───► requires_action ──► succeeded | failed
                └──► unknown ──► succeeded | failed
```

Every transition is a conditional update: `UPDATE payments SET status = 'succeeded' WHERE payment_id = 'pay_771' AND status IN ('processing', 'unknown', 'requires_action')`. If no row changes, someone else already moved it, and this attempt posts nothing. That one condition is what makes the service's reply, the recovery worker and the webhook safe to race each other: only one of them posts the entries.

`succeeded` and `failed` are final. A refund doesn't change the payment's status; it is a separate record against it, with its own state.

### Authorize now, capture later

Many marketplaces don't charge until the order ships. At checkout they **authorize**: the bank holds the amount on the customer's card without moving it. When the merchant ships, they **capture** all or part of it. An authorization that is never captured lapses, typically after 7 days.

This splits one charge into two calls, each with its own idempotency key and its own state. The ledger records nothing at authorization, because no money has moved, and posts the charge entries at capture. Partial capture, for an order that ships only half its items, posts entries for the captured amount and releases the rest.

### Exactly once, built from at least once

No network call happens exactly once. A request can be lost, or its reply can be lost, and the sender can't tell which. Every piece of this design therefore sends at least once and makes repeats harmless:

| Hop | Sent at least once by | Repeat made harmless by |
|---|---|---|
| Checkout → payment service | checkout retries | caller's idempotency key |
| Payment service → processor | service and recovery worker | payment ID as processor key |
| Processor → webhook receiver | processor resends | event ID table |
| Payment status → ledger | any of the three above | conditional status update |
| Outbox → order service | relay republishes | event IDs at the receiver |
| Payout → bank | payout job retries | payout ID as bank key |

Remove any one of the right-hand column and the chain stops being effectively exactly once. That is why reconciliation exists: to catch the day it isn't.

### Matching the settlement report

A settlement report line has the processor's charge ID, the payment ID from metadata, an amount, a currency, a fee and a type. The reconciler sorts both sides by payment ID and walks them together. Each line ends up as one of:

- **Matched**: same payment, amount and currency. Posted as settlement.
- **Amount differs**: a partial capture or a refund recorded differently on each side. Sent to finance.
- **Only in the report**: the processor moved money the marketplace has no record of, or recorded as failed. The most urgent kind, since a customer may have paid for nothing.
- **Only in the ledger**: the marketplace recorded money the processor didn't move. Held for a day, since it's usually after the processor's cut-off, then sent to finance.

Then the day's total is checked against the deposit that actually arrived in the bank account. The report, the ledger and the bank statement have to agree.

### Money in integers

Amounts are stored in the currency's smallest unit, as 64-bit integers: cents for US dollars, yen for Japanese yen (which has no smaller unit), fils for Bahraini dinars (three decimal places). Splitting money can leave a remainder — $10.00 three ways is $3.33, $3.33 and $3.34 — and the rule for who gets the extra cent is fixed in code, so the entries always add up exactly.

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### The processor sets the latency

Of the 600ms a payment takes, the service's own work is under 50ms. The rest is the processor and the card's bank, and no design on the marketplace's side changes it. What the design controls is how long it waits — 10 seconds — and what it does when the wait runs out.

### Unknown means waiting

A payment that hits a timeout can't be retried somewhere faster. Its order waits until the original processor answers: usually seconds, during an outage tens of minutes. That delay is the cost of never charging twice, and the design accepts it.

### A second processor is a second everything

Two processors mean two integrations, two kinds of webhook, two settlement reports to reconcile, and a card vault to give each a token, which brings the vault into the strictest tier of card-security rules. Many marketplaces run one processor for years before the cost of an outage justifies a second.

### A huge merchant on one shard

Sharding by merchant keeps every merchant's money on one shard. A merchant with a fifth of a sale's traffic puts a fifth of the load on one shard. The fix is to give the largest merchants shards of their own, or to split one merchant's payable account into sub-accounts the same way as platform revenue, at the cost of a payout that reads several.

### Synchronous replication costs every write

Every commit waits for a replica in another zone, about 1–2ms. Asynchronous replication would be faster, but a primary that failed would take its last few payments with it — charges made with no record. For money, the design pays the latency.

### Reconciliation is a day behind

A mismatch is found the morning after. A bug that misrecords payments runs for up to a day before reconciliation sees it. Checks that run every few minutes on the service's own data — every payment succeeded at the processor has entries; no order has two succeeded payments — shorten that for the most likely mistakes, without waiting for the processor's report.

### An immutable ledger grows forever

Entries are never deleted, and must be kept for 7 years: about 40TB. Entries older than a few months move to cheaper storage, partitioned by month, and only the cached balances and recent entries stay on the primaries.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

A payment service moves money, so every weakness in it is worth something to someone ([Security & Authentication](#/systems/security-authentication)).

### Card numbers stay out

Card numbers go from the customer's browser straight to the processor, through the processor's own form, and the marketplace sees only tokens. Only the card vault in Stage 5 ever holds a card number. It is isolated on its own network, audited separately, and nothing else can read from it. Keeping card numbers out of every other system keeps every other system out of the strictest card-security rules.

### Webhooks can be forged

Anyone can send a request to the webhook URL. The receiver checks each webhook's signature against the secret shared with the processor, and rejects any whose timestamp is more than 5 minutes old, so a captured webhook can't be replayed later. For high-value events, it fetches the event from the processor's API rather than trusting the payload.

### The amount comes from the server

The amount to charge comes from the order service, never from the customer's browser. A customer who edits the page to send $1 for an $80 order changes nothing.

### Card testing

Criminals with lists of stolen card numbers test which ones work by making many small purchases. The signs are many payments from one account, device or network address, many different cards, and many declines. Rate limits on each, a fraud check before the charge, and the bank asking the customer to approve suspicious payments stop most of it ([Rate Limiting](#/systems/rate-limiting)). Every declined test still costs a processor fee.

### Refunds

A merchant can refund only its own payments, and never more than was charged minus what's already been refunded — checked with the payment's row locked, so two refunds can't both pass. Refunds to a different card than the one charged are not allowed.

### Changing the ledger

Nobody edits the ledger. Corrections are adjustment transactions, which need two people: one to propose and one to approve. Every adjustment records both, and the reason.

### Secrets

Processor API keys and webhook secrets live in a secrets manager, are rotated on a schedule, and are readable only by the services that need them. A leaked processor key could issue refunds to any card.

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **Approval rate**: the share of payments the banks approve, per processor, card type and country. A drop usually means a processor problem, not a sudden change in customers.
- **Decline reasons**, per processor.
- **Processor latency** at p50 and p99, and **timeouts**.
- **Unknown payments**: how many, and how old the oldest is.
- **Webhook lag**: from the event's timestamp to the receiver recording it.
- **Outbox lag**: the age of the oldest unsent event, per shard.
- **Reconciliation**: matched lines, exceptions, and the money in exceptions.
- **The trial balance**: the sum of every account's balance. It must be exactly zero.
- **Payouts** sent, settled and returned.

([Observability](#/systems/observability))

### What to alert on

- The trial balance on any shard is not zero, by even one cent.
- Any order with two succeeded payments.
- Approval rate at a processor more than **5 points** below its usual level for 10 minutes.
- Any payment unknown for more than **1 hour**.
- Outbox lag above **1 minute**.
- Any reconciliation exception in the "only in the report" category, or a day's exceptions above **$10,000**.
- A processor's breaker opening.

### "A customer says they were charged twice" — what happens?

Look up every payment for the order. Two payments, with two different idempotency keys, means the caller started a second payment instead of retrying the first: find out why checkout made a new key. Two charges at the processor for one payment would mean the processor ignored its own key, which the reconciliation report confirms. One payment and one charge means the customer is looking at the authorization and the capture, or at a pending charge from a failed attempt that their bank will drop.

### "Reconciliation is $40,000 out" — what happens?

Split the exceptions by kind. A large "only in the ledger" total on the first of the month is usually the processor's cut-off moving. A cluster of "only in the report" lines that all started at the same time points to a release: check what deployed then, and whether a timeout path is recording failures. Mismatched amounts on one merchant point at partial captures or refunds handled differently on each side.

### "Processor A's approval rate dropped" — what happens?

Check whether the drop is across all cards or one card type or country. One network or country points at the processor's connection to it; shifting those payments to processor B is a routing change. Everything at once, with timeouts rising, is an outage, and the breaker should already have opened. If approval rates are down at both processors, the cause is more likely on the marketplace's side: a change to what checkout sends, or a fraud rule blocking too much.
