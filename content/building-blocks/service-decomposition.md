# Service Decomposition

Scaling Fundamentals covered running more copies of the same application. This page is about a different, earlier decision: whether to build "the application" as one deployable thing at all, or split it into several independently deployable services from the start. It's a bigger decision than it looks, because it changes the nature of nearly every call the system makes internally.

## The monolith: one deployable unit

All the code ships and runs as a single unit — one codebase, one build, one deploy. That unit can still be horizontally scaled (Scaling Fundamentals), running many identical copies behind a load balancer; the "mono" is about deployment, not about running on one machine. What a monolith gets for free, precisely because it's one process: a function call between two "modules" is just a function call — fast, in-process, and it either fully succeeds or the whole process crashes. There's no partial failure to reason about, and a single database transaction can atomically update data owned by several modules at once.

That simplicity has a real cost as a codebase and team grow: every team's changes ship together, so one team's slow migration or broken test can block everyone else's release, and the whole application scales as one unit even when only one part of it — image processing, say — is actually the bottleneck.

## Microservices: many deployable units

Splitting along business-capability boundaries — an Orders service, a Users service, an Inventory service — makes each one independently deployable, independently scalable, and ownable by a single team. The trade sits exactly opposite the monolith's strengths: what used to be an in-process function call is now a network call (Client-Server Model & Networking Basics), which means it now has real latency, can fail partially, and needs the same defensive instincts as calling a database or any other remote dependency — timeouts, retries, and the failure handling covered in Rate Limiting & Backpressure aren't optional extras once a call crosses a process boundary.

## The cost most people underweight

| | Monolith | Microservices |
|---|---|---|
| Deploying one team's change | Ships with everyone else's | Independent |
| Cross-module transactions | One ACID transaction, for free | No single transaction spans services — needs an explicit pattern (see below) |
| Operational surface | One thing to run and monitor | Many things to run, monitor, and keep available |
| Scaling a specific hot path | Scales with everything else | Scales independently |

The transactions row is the trap that's easiest to underestimate. A monolith can update an order and decrement inventory in one database transaction — either both happen or neither does, guaranteed by the database. Once those two things live in separate services with separate databases, that guarantee is gone; a partial failure (the order is created, but the inventory update never arrives) is now a real, explicit case the system has to handle, typically with a **saga** — a sequence of local transactions, each with a defined compensating action to undo it if a later step fails. This is the same eventual-consistency trade-off from Consistency Models & CAP, just showing up between services instead of between database replicas.

## When it's worth it

The trigger is team friction, not load — the same framing Micro-Frontends uses on the frontend side. A single team can maintain a surprisingly large monolith without trouble. Splitting it early trades a real, immediate cost (network calls where function calls used to be, sagas where transactions used to be) for a payoff — team autonomy, independent scaling — that doesn't exist yet if there's no team-boundary friction to relieve. It tends to earn its cost once multiple teams are genuinely blocked shipping through one shared pipeline, or one part of the system has a scaling profile different enough from the rest that forcing them to scale together is a real waste.

## Why this matters for system design

Service decomposition is the decision that turns "a program" into "a distributed system" — and most of the rest of this module (Load Balancing, Message Queues, Rate Limiting, Consensus, Distributed Locking) only becomes necessary in the first place because a system is now made of multiple independent processes that have to coordinate over an unreliable network, instead of one process making ordinary function calls.

## Real-world examples

- **Amazon's early-2000s move** from a large internal monolith to a service-oriented architecture is commonly cited as an origin point for the modern microservices conversation.
- **Shopify** is a notable counter-example, running a deliberately large, well-modularized monolith at very high scale — a reminder that microservices aren't the automatic right answer.
- **Kubernetes and Docker** — not a topic of this page on their own, but the standard tooling for actually running and deploying many independent services in practice.
