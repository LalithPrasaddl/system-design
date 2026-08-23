# Fine-Tuning in Practice

Training Lifecycle described fine-tuning as one stage in creating a foundation model in the first place. This page is about the other, much more common meaning of the word: a team taking an already-trained model and adapting it to their own data or task, without touching the original pretraining at all.

## Full fine-tuning vs. parameter-efficient fine-tuning (PEFT)

**Full fine-tuning** updates every single parameter in the model, training it further on new examples. It can produce the strongest results. But it also means storing and updating a full copy of a model that might have billions of parameters — expensive in both computing power and storage. Each fine-tune you do this way produces an entirely new, multi-gigabyte (or bigger) model that needs to be stored and served on its own.

**LoRA (low-rank adaptation)** is the most common alternative, part of a family of techniques called **PEFT** (parameter-efficient fine-tuning). Instead of touching the original model at all, LoRA freezes it completely and trains a small set of extra parameters — far fewer than the full model — layered on top.

The result captures much of the benefit of full fine-tuning, at a small fraction of the compute and storage cost. And critically, it produces a small "adapter" file, not a whole new model. That means one shared base model can be paired with many different lightweight adapters — one per task, or one per customer — without duplicating the entire model each time.

<div class="diagram-wrap">
<svg viewBox="0 0 620 170" width="620" height="170" role="img" aria-label="Full fine-tuning updates all model weights into a new full-size model; LoRA freezes the base model and trains a small adapter, letting one base model pair with many adapters">
  <rect x="20" y="20" width="150" height="40" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="95" y="45" text-anchor="middle" class="d-actor-label" font-size="12">base model</text>
  <line x1="170" y1="40" x2="240" y2="40" class="d-msg d-request" marker-end="url(#arrowFt1)"></line>
  <text x="205" y="33" text-anchor="middle" class="d-label-muted" font-size="9">full fine-tune</text>
  <rect x="240" y="20" width="180" height="40" rx="6" class="d-block d-block-response"></rect>
  <text x="330" y="45" text-anchor="middle" class="d-block-label" font-size="11">new full-size model copy</text>
  <rect x="20" y="100" width="150" height="40" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="95" y="125" text-anchor="middle" class="d-actor-label" font-size="12">base model (frozen)</text>
  <line x1="170" y1="120" x2="230" y2="120" class="d-msg d-request" marker-end="url(#arrowFt2)"></line>
  <text x="200" y="113" text-anchor="middle" class="d-label-muted" font-size="9">+ LoRA</text>
  <rect x="230" y="100" width="90" height="40" rx="6" class="d-block d-block-response"></rect>
  <text x="275" y="125" text-anchor="middle" class="d-block-label" font-size="10">small adapter</text>
  <rect x="330" y="100" width="90" height="40" rx="6" class="d-block d-block-response"></rect>
  <text x="375" y="120" text-anchor="middle" class="d-block-label" font-size="10">adapter</text>
  <text x="375" y="132" text-anchor="middle" class="d-block-label" font-size="10">#2, #3...</text>
  <text x="245" y="165" text-anchor="middle" class="d-label-muted" font-size="10">one frozen base model, many small swappable adapters</text>
  <defs>
    <marker id="arrowFt1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
    <marker id="arrowFt2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
  </defs>
</svg>
<div class="diagram-caption">Full fine-tuning produces a whole new model per task. LoRA keeps one shared base model and trains only a small adapter per task — cheaper to produce, and cheap enough to swap at serving time.</div>
</div>

## When teams actually reach for fine-tuning

Fine-tuning is a real, ongoing cost — collecting data, running training jobs, evaluating the result, and maintaining it as the underlying base model gets updated. So it's worth being specific about when it's actually the right tool.

It's a good fit for teaching a model a consistent *style*, *format*, or narrow behavior — always respond in a specific structured way, or adopt a specific tone — reliably enough that prompting alone can't guarantee it.

It's a poor fit for teaching a model new *facts*, or giving it access to information that changes often. That's what RAG is for instead (the next page) — updating a retrieval index is far cheaper and faster than running a whole new fine-tuning job every time the facts change.

Most teams should try a better prompt (Prompting & Context Engineering) or RAG first, and reach for fine-tuning only once those genuinely don't solve the specific, narrow problem they have.

## Distillation

**Knowledge distillation** is a related but different idea. Instead of adapting a model to new data, you train a smaller "student" model to imitate the outputs of a larger "teacher" model — the goal is to capture most of the teacher's useful behavior, but at a fraction of its size and cost to run.

Fine-tuning adapts a model to new data. Distillation compresses an existing model's behavior into a cheaper one. The two are often combined: fine-tune a large teacher model first, then distill it down into something cheaper to actually serve (Model Serving & Inference Infrastructure).

## Why this matters for system design

Fine-tuning, RAG, and prompting are three different ways to change how a model answers, at three very different costs. Before any implementation work starts, a conversation about "customizing the model" needs to land on which of the three actually fits the problem.

Reaching for the most expensive option — fine-tuning — by default, when a cheaper one would work fine, is a common and avoidable mistake. It's the same shape of mistake as reaching for a distributed transaction (Partitioning & Sharding) when a much simpler idempotent retry (Idempotency & Exactly-Once Delivery) would have solved the actual problem.

## Real-world examples

- **LoRA** (Hu et al., 2021) — now the default fine-tuning method for most open-source and self-hosted model customization.
- **OpenAI and Anthropic's fine-tuning APIs** — hosted fine-tuning offered directly on top of their models, with no training infrastructure to manage yourself.
- **DistilBERT** — an early, widely cited example of distillation producing a much smaller model that keeps most of a larger teacher model's performance.
- **Hugging Face's PEFT library** — the standard open-source toolkit for LoRA and similar parameter-efficient fine-tuning methods.
