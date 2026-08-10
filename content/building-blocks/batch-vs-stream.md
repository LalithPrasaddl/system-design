# Batch vs. Stream Processing

Message Queues covers moving individual events between services as they happen. This page is a related but distinct question: once there's a large volume of data to process, do you process all of it at once, on a schedule, or continuously, as each piece arrives?

<div class="diagram-wrap">
<svg viewBox="0 0 640 180" width="640" height="180" role="img" aria-label="Batch processing runs in scheduled chunks with idle time between them; stream processing runs continuously with no idle time">
  <text x="75" y="58" text-anchor="end" class="d-label" font-size="12">Batch</text>
  <rect x="90" y="40" width="80" height="28" class="d-block d-block-request"></rect>
  <rect x="250" y="40" width="80" height="28" class="d-block d-block-request"></rect>
  <rect x="410" y="40" width="80" height="28" class="d-block d-block-request"></rect>
  <text x="75" y="118" text-anchor="end" class="d-label" font-size="12">Stream</text>
  <rect x="90" y="100" width="495" height="28" class="d-block d-block-response"></rect>
  <line x1="90" y1="140" x2="585" y2="140" class="d-axis"></line>
  <text x="592" y="144" class="d-label-muted" font-size="11">time →</text>
</svg>
<div class="diagram-caption">Batch runs process a chunk of accumulated data on a schedule, with idle time between runs. Streaming processes each event as it arrives, continuously — there's no "run" boundary and no idle time, just a constant flow.</div>
</div>

## Batch processing

Process a large, bounded set of data all at once, on a schedule — nightly, hourly. Computing yesterday's total revenue by reading every order from the past 24 hours in one job is a batch job. The whole input is available before processing starts, so there's no question of "what if more data arrives mid-calculation" — which makes it simple to reason about, and historical data is easy to reprocess by simply rerunning the job over old input. Large batches also amortize fixed overhead efficiently, processing more per unit of work than handling each record individually would. The cost is freshness: the result is only as current as the last run — "yesterday's revenue" is exactly that, not revenue as of right now.

## Stream processing

Process each event as it arrives, continuously, with no defined end to the input — a stream is unbounded, unlike a batch's fixed set. This is built directly on the message queues and logs already covered: a stream processor is, in essence, a consumer that continuously transforms or aggregates events as they're read off the log (Log-Based Systems). Results are available with much lower latency — seconds, not hours — but the code now has to explicitly handle things a batch job gets for free. What happens when an event arrives late, out of order relative to when it actually occurred? What's the boundary of "revenue so far today" when today isn't over yet? That last question requires an explicit **windowing** decision — 5-minute windows, 1-hour windows — with a defined rule for events that arrive right at a window's edge.

## The trade, in one line

Batch trades freshness for simplicity; streaming trades simplicity for freshness. Neither is universally better, which is why real data pipelines often use both deliberately — a distinction with established names: a **lambda architecture** runs a batch layer (for a fully correct, if delayed, view) and a stream layer (for a fast, if occasionally approximate, view) side by side; a **kappa architecture** uses streaming only, treating a full historical recompute as just replaying the stream from the beginning rather than maintaining a separate batch system.

## Why this matters for system design

This is the same freshness-versus-cost trade running through Caching (a TTL's staleness window) and Client-Side Data & Caching (stale-while-revalidate), applied to entire data pipelines instead of individual reads: the right choice depends on how bad it actually is for a specific number to be hours stale versus seconds stale, not on which approach is inherently the better engineering.

## Real-world examples

- **Apache Spark** — the standard large-scale batch processing engine, and, via Spark Streaming, also capable of stream processing — a reminder that the same engine can sometimes do both.
- **Apache Flink, Kafka Streams** — stream processing engines built to consume directly from a log like Kafka and produce continuously updated results.
- **Airflow** — a common scheduler for orchestrating batch jobs (nightly ETL pipelines) as dependency graphs.
