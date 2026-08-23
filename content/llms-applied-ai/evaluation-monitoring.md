# Evaluation & Monitoring

Observability is about finding out something is wrong in a running system, without having to guess. An LLM-backed system needs that same discipline — but aimed at a much harder question. Not just "is it up and fast," but "is it still giving good answers" — a question with no single fixed right answer to check against.

## Evals: testing a model like a system, not just a demo

An **eval** is a structured, repeatable test suite for a model or a prompt. It's a set of inputs, paired with a way of scoring the outputs, run automatically instead of being judged by hand every time.

Evals range in how objective they are. Some are simple automated benchmarks — a fixed set of questions with known correct answers. Others are more involved: using a second, stronger model to judge subjective qualities like helpfulness or tone. This is called **LLM-as-judge**, and it's used when there's no single exact right answer to compare against.

Without evals, a prompt or model change ships on vibes — someone's gut feeling that it seems better. Evals turn "does this change actually make responses better" into a measurable, repeatable question. It's the same shift a test suite makes for ordinary code changes.

## Hallucination

A **hallucination** is a confident, fluent, and simply wrong answer — a fact that's made up, a citation to a document that doesn't exist, an answer that sounds entirely plausible but is incorrect.

It's not a "bug" in the usual sense of the word. It's a direct consequence of how generation actually works (Model Serving & Inference Infrastructure). The model is always producing its best statistical guess at the next token — it has no built-in way of telling the difference between "a fact it actually recalled" and "text that just sounds plausible."

Grounding answers in retrieved source material (RAG) reduces hallucination, by giving the model something concrete to work from. But it doesn't eliminate the risk entirely — the model can still misread or misstate what the retrieved content actually says.

## Drift: data drift vs. model drift

**Data drift** is when real-world input gradually changes shape over time, compared to what the system was originally built or tested against — new slang, a new product category, a shift in what users are actually asking about.

**Model drift** (also called **concept drift**) is when a model's effective quality degrades over time, relative to the current task. This can happen because the world it's answering questions about changed, or because the model provider silently updated the model behind the scenes.

Both are the LLM-specific version of a general Observability problem: a system that was performing well can start performing worse with no code change at all on your part, purely because the world around it moved.

<div class="diagram-wrap">
<svg viewBox="0 0 600 170" width="600" height="170" role="img" aria-label="An eval score trend line staying flat, then declining after real-world inputs drift away from what the model was evaluated against, until a monitoring alert fires">
  <line x1="40" y1="140" x2="560" y2="140" class="d-axis"></line>
  <line x1="40" y1="140" x2="40" y2="20" class="d-axis"></line>
  <text x="30" y="30" text-anchor="end" class="d-label-muted" font-size="10">quality</text>
  <text x="560" y="155" text-anchor="end" class="d-label-muted" font-size="10">time →</text>
  <polyline points="40,60 150,58 260,62 320,80 400,105 480,122 560,128" fill="none" stroke="var(--accent)" stroke-width="2.5"></polyline>
  <line x1="320" y1="20" x2="320" y2="140" stroke="var(--border)" stroke-width="1" stroke-dasharray="4,4"></line>
  <text x="326" y="30" class="d-label-muted" font-size="10">real-world inputs start drifting</text>
  <circle cx="480" cy="122" r="5" class="d-block d-block-blocked"></circle>
  <text x="490" y="118" class="d-label-muted" font-size="10">alert threshold crossed</text>
</svg>
<div class="diagram-caption">Quality doesn't drop all at once — it erodes gradually as the inputs a model sees drift away from what it was trained or evaluated against, which is exactly why this needs continuous monitoring, not a one-time eval before launch.</div>
</div>

## Feedback loops and guardrails

Production LLM systems typically combine two things: evals run before shipping, and live signals gathered afterward. Those live signals include explicit user feedback (a thumbs up/down button), implicit signals (did the user immediately rephrase the same question — a likely sign the first answer failed?), and automated **guardrails** — checks run on live input or output, like filtering unsafe content or catching malformed structured output (Prompting & Context Engineering), before a response ever reaches the user.

Together, these close the loop Observability describes more generally: catch a real problem happening in production, not just in a test suite you ran before launch.

## Why this matters for system design

Evaluation and monitoring are really just Observability's vocabulary — metrics, alerting on symptoms users would notice, treating quality as something you measure continuously rather than check once — applied to a system where "correct" is fuzzier than an HTTP error code, and where a model can quietly get worse with no deploy of your own code at all.

Any team shipping an LLM feature without evals and ongoing quality monitoring is running the equivalent of a production service with no metrics or alerting (Observability). It might be totally fine. But there's no way to actually know that — until a user notices first.

## Real-world examples

- **OpenAI Evals, Anthropic's eval tooling, promptfoo** — open frameworks for building and running repeatable eval suites against prompts or models.
- **LMSYS Chatbot Arena** — a widely referenced public benchmark that uses head-to-head human votes to compare models, a close cousin of LLM-as-judge, run at large scale.
- **Hallucination leaderboards** (e.g. Vectara's) — public benchmarks that specifically track how often different models make things up in summarization tasks.
- **Guardrails AI, NeMo Guardrails** — open-source libraries built specifically for enforcing output rules and safety checks around a model's responses.
