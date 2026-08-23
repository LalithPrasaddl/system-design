# Training Lifecycle

LLM Vocabulary described training as one big, expensive, one-time process that produces a model's weights. In reality, it's not one step — it's a sequence of distinct stages, and each stage changes the model's behavior in a different way. This page walks through that sequence, and explains what "retraining" actually means in practice.

## Pretraining: learning to predict the next token

**Pretraining** is the first stage, and by far the most expensive one.

The model is trained on a massive, broad collection of text (Datasets & Data Pipelines), with one simple goal: given the text so far, predict what token comes next. That's it — that's the entire objective.

It sounds too simple to work, but repeated across trillions of tokens, this one simple task is enough for the model to pick up grammar, facts, reasoning patterns, and writing style — all as a side effect of getting better and better at prediction.

This is the stage that eats up the huge training clusters and the days-to-weeks of compute time. What it produces is the **base model** (LLM Vocabulary) — genuinely capable, but not yet aimed at following instructions or holding a conversation.

## Supervised fine-tuning (SFT): learning to follow instructions

**Supervised fine-tuning (SFT)** comes next. The base model is trained again — this time on a much smaller, carefully chosen set of examples: an instruction, paired with the response a human would actually want back.

This stage isn't really about teaching the model new facts. It's about teaching it the *shape* of a good answer — reply directly, in a helpful and consistent way, instead of just continuing the text the way a base model would.

This is the step that turns a base model into an instruct model.

## RLHF and DPO: learning from preferences

SFT examples show the model one correct answer per prompt. But that doesn't teach the model about *degrees* of quality — how to choose between two decent, but not identical, answers.

That's the job of **reinforcement learning from human feedback (RLHF)**, and its lighter, more modern alternative, **DPO (direct preference optimization)**. Both work the same basic way: instead of "here's the right answer," they train on ranked pairs. A human (or sometimes another model, acting as a judge) looks at two candidate responses to the same prompt and says which one is better. The model is then nudged to produce more answers like the one that was preferred.

This stage is the biggest reason a model feels genuinely helpful and well-behaved, rather than just technically following instructions.

<div class="diagram-wrap">
<svg viewBox="0 0 640 160" width="640" height="160" role="img" aria-label="The training pipeline: pretraining on a broad corpus, then supervised fine-tuning on instruction pairs, then preference tuning on ranked comparisons">
  <rect x="15" y="40" width="140" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="85" y="64" text-anchor="middle" class="d-actor-label" font-size="12">Pretraining</text>
  <text x="85" y="82" text-anchor="middle" class="d-label-muted" font-size="10">broad corpus,</text>
  <text x="85" y="94" text-anchor="middle" class="d-label-muted" font-size="10">next-token prediction</text>
  <line x1="155" y1="70" x2="235" y2="70" class="d-msg d-request" marker-end="url(#arrowTl1)"></line>
  <text x="195" y="63" text-anchor="middle" class="d-label-muted" font-size="9">base model</text>
  <rect x="235" y="40" width="140" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="305" y="64" text-anchor="middle" class="d-actor-label" font-size="12">SFT</text>
  <text x="305" y="82" text-anchor="middle" class="d-label-muted" font-size="10">instruction/response</text>
  <text x="305" y="94" text-anchor="middle" class="d-label-muted" font-size="10">pairs</text>
  <line x1="375" y1="70" x2="455" y2="70" class="d-msg d-request" marker-end="url(#arrowTl2)"></line>
  <text x="415" y="63" text-anchor="middle" class="d-label-muted" font-size="9">instruct model</text>
  <rect x="455" y="40" width="150" height="60" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="530" y="64" text-anchor="middle" class="d-actor-label" font-size="12">RLHF / DPO</text>
  <text x="530" y="82" text-anchor="middle" class="d-label-muted" font-size="10">ranked response</text>
  <text x="530" y="94" text-anchor="middle" class="d-label-muted" font-size="10">pairs</text>
  <text x="320" y="135" text-anchor="middle" class="d-label-muted" font-size="11">each stage trains on smaller, more curated data than the one before it</text>
  <defs>
    <marker id="arrowTl1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
    <marker id="arrowTl2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
  </defs>
</svg>
<div class="diagram-caption">Each stage narrows the training data and changes the model's behavior in a specific way: pretraining teaches raw capability, SFT teaches instruction-following, preference tuning teaches which of two decent answers people actually prefer.</div>
</div>

## What "retraining" actually means

In practice, when someone says "we're retraining the model," they almost never mean redoing the full, extremely expensive pretraining stage from scratch. That would be enormously costly, and it's rare enough to be a headline event for a company, not a routine task.

What they usually mean is one of the cheaper options: fine-tuning an existing base model on new or updated data (Fine-Tuning in Practice), or running a new preference-tuning pass to fix one specific behavior. A full new pretraining run — an entirely new model generation — only happens occasionally, at the scale of a company like OpenAI or Anthropic.

## Why this matters for system design

Treating "training" as one single step hides the decision that actually matters day to day. Pretraining is a cost only a handful of companies in the world pay directly. But fine-tuning and preference-tuning are tools any team can use, on top of an existing foundation model, for a small fraction of that cost.

Knowing which stage a given change actually belongs to is what separates three very different amounts of work: "we need a whole new base model" (almost never actually needed), "we need to fine-tune on our own data" (Fine-Tuning in Practice), or "we just need a better prompt" (Prompting & Context Engineering). From the outside, these can all sound like the same request. They are not.

## Real-world examples

- **GPT, Claude, Llama, Gemini** — each is pretrained once per generation, then separately fine-tuned and preference-tuned into the chat/instruct model you actually use.
- **InstructGPT (OpenAI, 2022)** — the paper that popularized RLHF, showing it made GPT-3 dramatically easier to use without touching its pretrained weights.
- **DPO (2023)** — introduced as a simpler, more stable alternative to RLHF's more complex training process. Now widely used by teams fine-tuning open models.
