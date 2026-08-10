# Observability

Every other Building Block in this course can fail or degrade in ways that are invisible until a user complains, unless the system itself reports what it's doing. Observability is how you find out something is wrong — or confirm it's fine — without guessing. Every case study's "Monitoring & Operations" tab in this course draws directly on the vocabulary this page defines once.

## The three pillars

- **Metrics** — numeric measurements aggregated over time: request rate, error rate, p50/p99 latency (Latency, Throughput), cache hit ratio (Caching). Cheap to store and query even at huge volume, precisely because they're pre-aggregated — the cost of that cheapness is losing the ability to inspect any *one* request.
- **Logs** — a timestamped record of a specific event, usually with rich detail: a specific error message, a specific request's parameters. Expensive at volume, since every event is stored individually, but exactly what a metric's aggregate number can't give you: what happened during one specific incident.
- **Traces** — follow a single request as it moves across multiple services or hops. A trace stitches together the timing of every hop that one request made, which makes it the only one of the three that directly answers "which specific hop was actually slow."

<div class="diagram-wrap">
<svg viewBox="0 0 640 220" width="640" height="220" role="img" aria-label="A trace waterfall showing one request's time spent across a load balancer, app server, a cache miss, and a database query">
  <text x="75" y="62" text-anchor="end" class="d-label" font-size="11">Load Balancer</text>
  <rect x="90" y="44" width="460" height="24" class="d-block d-block-request"></rect>
  <text x="75" y="96" text-anchor="end" class="d-label" font-size="11">App Server</text>
  <rect x="110" y="78" width="410" height="24" class="d-block d-block-request"></rect>
  <text x="75" y="130" text-anchor="end" class="d-label" font-size="11">Cache (miss)</text>
  <rect x="140" y="112" width="60" height="24" class="d-block d-block-blocked"></rect>
  <text x="75" y="164" text-anchor="end" class="d-label" font-size="11">Database</text>
  <rect x="210" y="146" width="280" height="24" class="d-block d-block-response"></rect>
  <line x1="90" y1="190" x2="585" y2="190" class="d-axis"></line>
  <text x="592" y="194" class="d-label-muted" font-size="11">time →</text>
</svg>
<div class="diagram-caption">The full request (top) is mostly one thing: a database query (bottom, green) that takes up most of the total time. The cache check (orange) was quick but still a miss — this is exactly the picture a real distributed trace shows, and exactly what a metric alone can't: which specific hop the time actually went to.</div>
</div>

## SLIs, SLOs, and error budgets

An **SLI** (service level indicator) is a specific measured metric — "the percentage of requests under 200ms." An **SLO** (service level objective) is a target for that SLI over a window — "99.9% of requests under 200ms, measured over 30 days." The **error budget** is the SLO's inverse: if the target is 99.9%, the budget is the 0.1% allowed to miss it. Framing it as a budget to spend, rather than a line that must never be crossed, changes team behavior directly — a budget nowhere near exhausted means it's fine to ship a riskier change; a budget nearly gone means it's time to slow down and stabilize before shipping anything else.

## Alerting philosophy

Alert on symptoms a user would actually notice — elevated error rate, high latency, a fast-burning error budget — rather than on every individual cause. Paging someone every time a specific database's CPU touches 80%, with no user-facing impact yet, trains people to ignore alerts. That's worse than not alerting at all: alert fatigue means the alert that *does* matter gets ignored along with all the noise.

## Why this matters for system design

Observability isn't polish added after a system works — it's the only way to know which of the trade-offs made throughout this course (a cache's hit rate, a queue's consumer lag, a shard's skew) is the one actually causing a problem right now, instead of guessing. Every case study's Monitoring & Operations tab is this page's vocabulary, applied to one specific system.

## Real-world examples

- **Prometheus** — the standard open-source system for collecting and querying metrics.
- **Datadog, Grafana** — dashboarding and alerting platforms built on top of metrics, logs, and traces together.
- **Jaeger, Honeycomb** — distributed tracing systems, built around exactly the waterfall view shown above.
- **Google's SRE book** — the origin of the SLI/SLO/error-budget framing now used industry-wide.
