# Prompting & Context Engineering

LLM Vocabulary described the context window as a fixed token budget. RAG showed one way to fill part of that budget on purpose, with retrieved content. This page is about managing the whole budget deliberately — what actually goes into a prompt, and why it's there.

## The parts of a prompt

A request to an LLM is rarely just "the user's question." In practice, a prompt is usually assembled out of several distinct pieces:

- A **system prompt** — standing instructions that apply to every request: the model's role, tone, and any constraints.
- Conversation history — earlier messages in the same conversation, if any.
- Retrieved context (RAG) — documents pulled in specifically to help answer this question.
- The user's actual input.

All of these compete for the same context window (LLM Vocabulary). A longer system prompt, or more retrieved documents, leaves less room for conversation history — and the other way around.

## Few-shot prompting

Instead of (or alongside) writing instructions, you can include a handful of worked examples of the exact input/output pattern you want. This is called **few-shot prompting**.

It works because, underneath everything, the model is still just doing next-token prediction (Training Lifecycle). Show it a few examples of a pattern, and it continues that same pattern for the new input.

**Zero-shot** prompting — no examples, just an instruction — uses fewer tokens and works well with models that are already good at following instructions. Few-shot earns back its extra token cost when the format or style you want is unusual enough that an instruction alone doesn't reliably produce it.

## Structured output

Many production systems need a model's response in a specific, machine-readable shape — JSON matching a particular schema — so the response can be fed straight into other code, instead of being parsed out of free-form prose.

Modern LLM APIs support this directly, through **structured output** (sometimes called **JSON mode**). The model's output is forced to match a given schema, instead of you relying on an instruction like "respond only in JSON" and just hoping it's followed correctly every single time.

This matters for the same reason a well-defined API contract matters elsewhere in this course (Communication Styles): the code calling the model needs to be able to trust the shape of whatever comes back.

## Context window as a resource budget

**Context engineering** is the discipline of treating the context window the way this course treats any other limited resource — network bandwidth, cache capacity, a rate limiter's budget. Something to allocate deliberately, not fill up carelessly.

A prompt padded with irrelevant history, or with too much retrieved content, doesn't just waste money on unnecessary tokens (Tokenization). Many models measurably lose accuracy on relevant information that's buried in the middle of a very long context — an effect researchers call "lost in the middle."

More context is not automatically better. The right context, kept as tight as the task actually allows, usually beats stuffing in everything you can.

## Why this matters for system design

A prompt is the interface between an application's code and the model. Like any interface in this course, it's worth designing on purpose, rather than letting it grow ad hoc over time.

Fixed instructions belong in one versioned system prompt, not repeated inline everywhere. Retrieved content should be as relevant and as concise as the retrieval step (RAG) can make it. And the context budget itself needs to be actively managed as conversation history and retrieved content pile up — the same way any system in this course needs a deliberate policy for what to keep and what to throw out once it hits a limit (Caching).

## Real-world examples

- **OpenAI's and Anthropic's structured output / tool-schema features** — force a model's output into valid JSON matching a schema, enforced at the API level.
- **"Lost in the middle" (Liu et al., 2023)** — the widely cited study showing models retrieve information from the start and end of a long context more reliably than from the middle.
- **Prompt templates and prompt versioning tools** (e.g. LangSmith, PromptLayer) — treat prompts as versioned, testable pieces of the system, rather than inline strings, because a prompt change can affect production behavior just as much as a code change can.
