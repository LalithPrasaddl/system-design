# How a Transformer Actually Works

Tokenization explained how text becomes a sequence of tokens. This page explains what the model does with that sequence.

Modern LLMs are **transformers** — an architecture introduced in 2017 and still the basis of essentially every model in production today. The mechanism is worth understanding directly, because most of the vocabulary in this track (context windows, KV caches, why long prompts cost more) is a consequence of it.

## The model only does one thing: predict the next token

A trained LLM takes a sequence of tokens and produces a score for every token in its vocabulary, saying how likely each one is to come next.

That is the entire output. One probability distribution over "what comes next."

To generate a sentence, the application picks a likely token, appends it to the sequence, and runs the model again on the now-slightly-longer sequence. Then again. Each token of the response is a separate full pass through the model.

This is called **autoregressive** generation, and it has a practical consequence. The tokens you send in can all be processed together, in one pass. The tokens that come out cannot — each one depends on the one before it, so they're produced strictly one at a time. That asymmetry is why input and output tokens have different costs and different speeds (Model Serving & Inference Infrastructure).

## Tokens become vectors

A token is just an id — a number pointing into the tokenizer's vocabulary. The model can't do arithmetic on an id, so the first step is to look up a vector for each one: a long list of numbers standing in for that token's meaning.

These are **embeddings**, the same idea covered in Embeddings & Vector Search. There, they were something you computed and stored in a database. Here they're internal — the model's own working representation.

Position information gets added as well. "The server sent the cache" and "the cache sent the server" contain identical tokens. Without something marking where each token sits, the model would have no way to tell those apart.

## Attention: every token looks at the others

Here is the central mechanism.

A token's meaning depends on what surrounds it. "Cached" means one thing after "the server" and something else after "the chicken was". The model needs a way for each position to pull in information from the other positions.

**Attention** is that way. For each position, the model runs a kind of soft lookup over all the earlier positions:

- Each position emits a **query** — in effect, "what information am I looking for?"
- Every position also emits a **key** — "this is what I have."
- And a **value** — "and this is the information itself."

The model compares the query against every key. Positions that match well get a high weight. Positions that don't get a low one. It then blends all the values together in proportion to those weights.

So each position ends up pulling information from whichever earlier positions turned out to be relevant, and largely ignoring the rest. Nothing hand-codes which ones are relevant — the queries and keys are learned during training (Training Lifecycle).

<div class="diagram-wrap">
<svg viewBox="0 0 620 215" width="620" height="215" role="img" aria-label="Attention weights from the token cached back to each earlier token in the sentence, with the strongest weight on the token server">
  <rect x="20" y="30" width="55" height="36" rx="5" class="d-block d-block-request"></rect>
  <text x="47" y="53" text-anchor="middle" class="d-block-label" font-size="11">The</text>
  <rect x="83" y="30" width="85" height="36" rx="5" class="d-block d-block-request"></rect>
  <text x="125" y="53" text-anchor="middle" class="d-block-label" font-size="11">server</text>
  <rect x="176" y="30" width="65" height="36" rx="5" class="d-block d-block-request"></rect>
  <text x="208" y="53" text-anchor="middle" class="d-block-label" font-size="11">sent</text>
  <rect x="249" y="30" width="55" height="36" rx="5" class="d-block d-block-request"></rect>
  <text x="276" y="53" text-anchor="middle" class="d-block-label" font-size="11">the</text>
  <rect x="312" y="30" width="85" height="36" rx="5" class="d-block d-block-response"></rect>
  <text x="354" y="53" text-anchor="middle" class="d-block-label" font-size="11">cached</text>
  <rect x="415" y="30" width="95" height="36" rx="5" fill="none" stroke="var(--border)" stroke-width="1.5" stroke-dasharray="4,4"></rect>
  <text x="462" y="53" text-anchor="middle" class="d-label-muted" font-size="11">next token?</text>
  <text x="47" y="84" text-anchor="middle" class="d-label-muted" font-size="10">0.03</text>
  <text x="125" y="84" text-anchor="middle" class="d-label-muted" font-size="10">0.51</text>
  <text x="208" y="84" text-anchor="middle" class="d-label-muted" font-size="10">0.14</text>
  <text x="276" y="84" text-anchor="middle" class="d-label-muted" font-size="10">0.05</text>
  <text x="354" y="84" text-anchor="middle" class="d-label-muted" font-size="10">0.27</text>
  <path d="M354,96 Q201,225 47,96" class="d-msg d-request" stroke-width="0.8"></path>
  <path d="M354,96 Q240,190 125,96" class="d-msg d-request" stroke-width="5"></path>
  <path d="M354,96 Q281,155 208,96" class="d-msg d-request" stroke-width="2.2"></path>
  <path d="M354,96 Q315,128 276,96" class="d-msg d-request" stroke-width="1"></path>
  <text x="20" y="200" class="d-label-muted" font-size="11">the position holding "cached" pulls most of its information from "server" — a relationship learned in training, not written down anywhere</text>
</svg>
<div class="diagram-caption">Attention weights for one position, looking backwards. Thicker lines are higher weights. Every position does this, against every position before it.</div>
</div>

Two more details complete the picture. The whole operation runs many times in parallel with different learned queries and keys — these are **attention heads**, and different heads end up tracking different kinds of relationships. And the result is stacked into **layers**: attention, then a small network that processes each position on its own, repeated dozens of times over. Attention moves information *between* positions. The per-position network does the thinking *within* one.

In a chat model, a position can only look backwards, never forwards. That restriction is what makes next-token prediction trainable — the model is never allowed to see the answer it's being asked to predict.

## Why long context costs more than you'd expect

Count the comparisons in the diagram. Every position compares itself against every earlier position.

At 1,000 tokens that's on the order of a million comparisons. At 10,000 tokens it's a hundred million. The work grows with the *square* of the sequence length, not in step with it. Doubling the context roughly quadruples the attention work.

This is the mechanical reason a long context window is an engineering achievement rather than a configuration value. It's also why trimming a prompt is worth more than it looks — halving the input cuts far more than half the attention work.

## What the KV cache actually caches

Generating a long answer would be hopelessly wasteful if every step reprocessed the entire sequence from scratch. It doesn't, and the reason has a name that comes up constantly once you get to serving: the **KV cache**.

Generating each new token means attending back over every previous token — which requires their keys and values. But those never change. The key and value for token 5 are identical whether the model is generating token 6 or token 600.

So the server computes them once and holds onto them. That is the KV cache: the keys and values for every token in the sequence so far. It turns each generation step from "recompute the entire sequence" into "compute one new token and reuse the rest."

It also explains the cost precisely. The cache holds an entry per token, per layer, for every request currently in flight. It grows as the conversation grows, and no two requests can share one. That's why GPU memory — not parameter count — is frequently the limit on how many users a single server can serve at once.

## Why this matters for system design

The transformer's shape explains constraints that otherwise look arbitrary.

The context window is a hard architectural limit, not a policy someone chose. Input and output tokens are priced differently because they genuinely cost different amounts to produce. Long prompts are expensive at a faster-than-linear rate. Serving capacity is bounded by cache memory rather than compute.

Every one of those is a design constraint you have to plan around, in the same way disk seek behavior or network round trips constrain the systems in the rest of this course. Knowing where the constraint comes from is what tells you which ones you can engineer around and which ones you cannot.

## Real-world examples

- **"Attention Is All You Need"** (Vaswani et al., 2017) — the paper that introduced the transformer. Every model in this track descends from it.
- **FlashAttention** — a widely deployed reordering of the attention computation that cuts memory traffic substantially without changing the math or the result.
- **PagedAttention / vLLM** — treats the KV cache like paged virtual memory, so a server can pack many more concurrent requests into the same GPU.
- **Grouped-query attention (GQA)** — used in Llama and similar models, it lets several query heads share one set of keys and values, shrinking the KV cache directly.
