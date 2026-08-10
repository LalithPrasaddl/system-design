# Idempotency & Exactly-Once Delivery

Message Queues already treats at-least-once delivery as a fact of life. This page is about the practical answer to that fact: rather than trying to guarantee a message arrives exactly once — which turns out not to be achievable — make the operation safe to receive more than once, and the difference stops mattering.

## Why exactly-once delivery isn't actually achievable

To guarantee a message was delivered exactly once, the sender needs an acknowledgment that it arrived. But that acknowledgment can itself be lost — the receiver can process the message successfully and then the network fails before its "got it" response makes it back. From the sender's side, "the receiver never got it" and "the receiver got it, processed it, and the ack was lost" are indistinguishable. The only reasonable move is to retry, and a retry risks a duplicate. This isn't a solvable engineering gap — it's a direct consequence of an unreliable network (Client-Server Model & Networking Basics), and no amount of cleverness removes the ambiguity; it can only be pushed somewhere else.

That somewhere else is the receiver. The achievable guarantee is **at-least-once delivery** — retry until acknowledged, accepting that the same message might arrive more than once — paired with a receiver that handles a duplicate safely. From the outside, that combination behaves exactly like exactly-once delivery, without depending on a guarantee the network can't actually provide.

## Idempotency: making "twice" as safe as "once"

An operation is **idempotent** if doing it multiple times has the same effect as doing it once. "Set my balance to $50" is naturally idempotent — running it twice still leaves the balance at $50. "Add $50 to my balance" is not — running it twice adds $100. That second shape is extremely common: any add, increment, or append operation has this problem by default, and it's exactly the kind of operation a retried request can hit twice.

## Idempotency keys

The standard fix doesn't change what the operation does — it makes a non-idempotent operation behave idempotently under retries. The client generates a unique key for one specific logical operation ("charge this cart, once") and sends it with every attempt, including retries. The server checks whether it's already seen that key before doing any real work; if it has, it returns the stored result of the original attempt instead of processing again.

<div class="diagram-wrap">
<svg viewBox="0 0 600 200" width="600" height="200" role="img" aria-label="A client retrying a request after a timeout, with the server recognizing the idempotency key and returning the original result instead of processing the charge twice">
  <rect x="20" y="20" width="110" height="36" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="75" y="42" text-anchor="middle" class="d-actor-label">Client</text>
  <rect x="460" y="20" width="110" height="36" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="515" y="42" text-anchor="middle" class="d-actor-label">Server</text>
  <line x1="130" y1="38" x2="456" y2="38" class="d-msg d-request" marker-end="url(#arrowIdem)"></line>
  <text x="295" y="30" text-anchor="middle" class="d-label-muted" font-size="10">POST /charge, Idempotency-Key: X</text>
  <rect x="60" y="80" width="480" height="34" rx="6" class="d-note"></rect>
  <text x="300" y="101" text-anchor="middle" class="d-note-text" font-size="12">First time seeing key X: charge the card, store the result</text>
  <line x1="300" y1="130" x2="300" y2="150" class="d-lifeline"></line>
  <text x="300" y="146" text-anchor="middle" class="d-label-muted" font-size="10">client times out, never saw the response — retries with the same key X</text>
  <rect x="60" y="160" width="480" height="34" rx="6" class="d-note"></rect>
  <text x="300" y="181" text-anchor="middle" class="d-note-text" font-size="12">Key X already seen: return the stored result — no second charge</text>
  <defs>
    <marker id="arrowIdem" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">The client can't tell whether its first request actually failed or just never made it back a response — so it retries. The idempotency key lets the server recognize the retry and answer with the original result instead of charging the card again.</div>
</div>

## Why this matters for system design

At-least-once delivery plus an idempotent receiver is a more robust answer than chasing an exactly-once guarantee the network fundamentally can't provide end to end — and this is a pattern worth recognizing everywhere it recurs in this course: build a layer that behaves the way you need on top of a weaker guarantee you can actually get, rather than trying to strengthen the guarantee itself. Consensus does the same thing for agreement on top of an unreliable network; a cache does it for speed on top of a source it can always safely fall back to.

## Real-world examples

- **Stripe's API** — a widely documented example of idempotency keys used specifically so a retried payment request can never double-charge a card.
- **Kafka's idempotent producer mode** — de-duplicates retried sends at the broker using a sequence number per producer, the same idea applied inside the messaging system itself.
- **HTTP's `PUT`** — defined by the spec to be idempotent, unlike `POST`, which is a major reason APIs favor `PUT` for "create or replace" operations that might need to be safely retried.
