# Model Serving & Inference Infrastructure

LLM Vocabulary drew a clear line between training (build once) and inference (serve continuously). This page covers the system design of that second half — what actually happens, and what's actually expensive, when a model answers a real, live request.

## Why inference is its own hard problem

Serving an LLM isn't as simple as "run the model." All the same request-serving concerns that apply to any backend service still apply (Scaling Fundamentals, Load Balancing) — but layered on top of an unusual kind of workload.

Two things make it unusual: each request needs a large model's weights loaded onto specialized, expensive hardware (typically a GPU). And the response isn't computed all at once — it's generated one token at a time, in sequence.

## Token-by-token generation and streaming

A model produces its response one token at a time. Each new token is generated based on everything that came before it — including your original prompt — and then that new token gets fed back in to help generate the next one.

This is why LLM responses are usually **streamed** to you, token by token, as they're produced — instead of you waiting for the entire response to finish first. It's the same latency-hiding trick as sending the first byte of an HTTP response before the rest is ready, just applied to text generation instead of a database query.

## Batching for throughput

A GPU is far more efficient processing many requests' worth of work at once than one request at a time. So serving systems **batch** multiple requests together into a single pass through the model, whenever they can. This is the same reason a database batches writes, or a message queue's consumer processes messages in batches (Batch vs. Stream Processing) — the fixed overhead per operation gets spread across more work, so it costs less per item.

There's a complication specific to LLMs, though: requests don't all finish at the same time, since responses vary in length. **Continuous batching** solves this — instead of waiting for a whole batch to finish together, the system adds a new request into an open slot the moment an old one finishes. This keeps the GPU busy, without making a short request wait behind a long one that's still generating.

<div class="diagram-wrap">
<svg viewBox="0 0 620 190" width="620" height="190" role="img" aria-label="Continuous batching: three requests of different lengths share a GPU batch, with a finished request's slot immediately replaced by a new request instead of waiting for the whole batch to finish">
  <text x="20" y="25" class="d-label" font-size="11">static batching</text>
  <rect x="20" y="35" width="200" height="16" class="d-block d-block-request"></rect>
  <rect x="20" y="55" width="120" height="16" class="d-block d-block-request"></rect>
  <rect x="140" y="55" width="80" height="16" class="d-block d-block-blocked" opacity="0.4"></rect>
  <rect x="20" y="75" width="80" height="16" class="d-block d-block-request"></rect>
  <rect x="100" y="75" width="120" height="16" class="d-block d-block-blocked" opacity="0.4"></rect>
  <text x="230" y="66" class="d-label-muted" font-size="9">idle GPU slots waiting on the longest request</text>
  <text x="20" y="115" class="d-label" font-size="11">continuous batching</text>
  <rect x="20" y="125" width="200" height="16" class="d-block d-block-request"></rect>
  <rect x="20" y="145" width="120" height="16" class="d-block d-block-request"></rect>
  <rect x="140" y="145" width="80" height="16" class="d-block d-block-response"></rect>
  <rect x="20" y="165" width="80" height="16" class="d-block d-block-request"></rect>
  <rect x="100" y="165" width="60" height="16" class="d-block d-block-response"></rect>
  <rect x="160" y="165" width="60" height="16" class="d-block d-block-response"></rect>
  <text x="230" y="156" class="d-label-muted" font-size="9">a finished request's slot is immediately reused by a new one</text>
</svg>
<div class="diagram-caption">Static batching leaves the GPU idle for a slot once its request finishes, waiting on the longest one in the batch. Continuous batching fills that slot with a new request immediately, keeping GPU utilization high.</div>
</div>

## The KV cache

Recomputing everything from scratch, for every single new token, would be extremely wasteful. So instead, the model caches some of its intermediate calculations from previous tokens — this is called the **KV cache** (key-value cache) — and reuses them, computing only what's actually new at each step.

This cache grows as the conversation gets longer, and it takes up a large chunk of GPU memory per request. This is a direct reason why longer context windows and more requests running at once both cost more to serve — independent of how big the model's parameter count is.

## Quantization

**Quantization** reduces the precision of the numbers used to store a model's weights — for example, going from 16-bit numbers down to 8-bit or 4-bit ones. This shrinks the model's memory footprint and speeds up inference, at some small cost to output quality.

It's the LLM equivalent of trading a bit of precision for a real, measurable win in cost and speed — the same kind of deliberate trade-off as choosing a lossy compression format elsewhere in a system, made once the quality cost has been measured and found acceptable.

## Rollout and versioning

Deploying a new model version behind an existing API carries the same risk as any backend deployment. A canary or gradual rollout — releasing the change to a small slice of traffic first, and watching closely — catches a quality or speed regression before every single user hits the new version at once. This is the same discipline Multi-Region & Disaster Recovery applies to any risky rollout.

## Why this matters for system design

Inference infrastructure is really a latency, throughput, and cost problem, just wearing an ML costume. Batching, caching, and precision trade-offs here are the direct equivalents of connection pooling, caching (Caching), and compression decisions this course already covers — just applied to a GPU-bound, one-token-at-a-time kind of workload, instead of a typical request/response one.

Treating "the model is slow" as purely a modeling problem — when it's often actually a serving-infrastructure problem — is a common and costly misdiagnosis.

## Real-world examples

- **vLLM** — an open-source inference server built specifically around continuous batching and efficient KV cache management (via a technique called "PagedAttention").
- **NVIDIA Triton, TensorRT-LLM** — production inference-serving infrastructure with built-in batching and quantization support.
- **Streaming responses** in the OpenAI and Anthropic APIs — token-by-token delivery, offered directly as an API option.
- **GPTQ, AWQ** — widely used quantization methods for shrinking open models down to 4-bit precision, with minimal loss in quality.
