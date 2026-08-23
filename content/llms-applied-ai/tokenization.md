# Tokenization

LLM Vocabulary explained the context window as a budget measured in tokens — not words, not characters. This page explains what a token actually is, and why models use them instead of working with raw text directly.

## Why not just feed in raw characters or words?

You might expect a model to just read individual letters, or whole words. Both have real problems.

Reading one character at a time makes even a short sentence very long. A huge chunk of the model's limited context window would get used up just spelling out common words it's going to see, spelled the same way, over and over.

Reading one whole word at a time has the opposite problem. A model that only knows a fixed list of whole words has no way to handle a word it's never seen before — a typo, a made-up name, a word from a language it wasn't trained on. It would simply have nothing to fall back on.

Tokenization is the practical middle ground between these two extremes.

## Subword tokenization

Most modern LLMs use a **subword tokenizer**. The most common method is called **byte-pair encoding (BPE)**.

Here's roughly how it's built: start with individual characters, then repeatedly merge whichever pair of characters appears together most often across a huge amount of training text. Do this enough times, and you end up with a vocabulary of tens of thousands of common chunks — some are whole common words ("the", "system"), some are common word pieces ("token", "ization"), and as a last resort, individual characters or bytes are still available.

The payoff: common words become a single token. Rarer words get split into a few familiar pieces. And text the tokenizer has genuinely never seen before — a typo, a made-up name — still gets encoded. It just takes more, smaller tokens to do it, instead of failing outright.

<div class="diagram-wrap">
<svg viewBox="0 0 600 170" width="600" height="170" role="img" aria-label="The sentence tokenizing a distributed system splitting into six tokens, with the common word tokenizing splitting into two subword pieces">
  <text x="20" y="30" class="d-label" font-size="13">"tokenizing a distributed system"</text>
  <rect x="20" y="55" width="70" height="34" rx="5" class="d-block d-block-request"></rect>
  <text x="55" y="76" text-anchor="middle" class="d-block-label" font-size="11">token</text>
  <rect x="94" y="55" width="60" height="34" rx="5" class="d-block d-block-request"></rect>
  <text x="124" y="76" text-anchor="middle" class="d-block-label" font-size="11">izing</text>
  <rect x="158" y="55" width="34" height="34" rx="5" class="d-block d-block-response"></rect>
  <text x="175" y="76" text-anchor="middle" class="d-block-label" font-size="11">a</text>
  <rect x="196" y="55" width="90" height="34" rx="5" class="d-block d-block-response"></rect>
  <text x="241" y="76" text-anchor="middle" class="d-block-label" font-size="11">distributed</text>
  <rect x="290" y="55" width="76" height="34" rx="5" class="d-block d-block-response"></rect>
  <text x="328" y="76" text-anchor="middle" class="d-block-label" font-size="11">system</text>
  <text x="20" y="125" class="d-label-muted" font-size="11">6 tokens for 4 words — common whole words stay whole; "tokenizing" splits into familiar pieces</text>
  <text x="20" y="150" class="d-label-muted" font-size="11">a rare or unseen word would split into even more, smaller pieces — but it always encodes</text>
</svg>
<div class="diagram-caption">A subword tokenizer keeps common whole words as single tokens and only splits rarer words into familiar pieces — the vocabulary never has to reject a word outright.</div>
</div>

## Why token count, not word or character count, drives cost and limits

Both the context window (LLM Vocabulary) and API pricing are measured in tokens — not words, not characters. That's because tokens are the actual unit the model processes. Every bit of compute cost comes from processing tokens, one at a time.

As a rough rule of thumb, English text averages about 1.3 tokens per word. But this varies a lot. Dense code, non-English languages, and rare or unusual vocabulary all tokenize less efficiently — meaning they eat up more of your token budget per visible character than plain English prose does.

This is exactly why estimating cost, or how much fits in a context window, by counting words is unreliable. You have to count tokens.

## Why this matters for system design

Tokenization is the first place where an LLM system's cost and limits stop being abstract and start being concrete numbers. A prompt template, a retrieved document (RAG), and the user's actual input all compete for the same token budget — and the exact same content can cost noticeably more or less to encode depending on its language and structure.

Any system that estimates cost, cuts off input that's too long, or checks whether something fits in the context window is really doing math in tokens, not characters. That's the same principle this course already uses when reasoning about network or storage costs (Latency, Throughput) — measure the real unit, not a rough stand-in for it.

## Real-world examples

- **OpenAI's tiktoken** and **Hugging Face's tokenizers** — widely used open-source tools that implement BPE tokenization.
- **OpenAI and Anthropic API pricing** — charged per input and output token, not per word or per request.
- Tokenizing non-English text or code is measurably less efficient — the same sentence in some other languages, or the same snippet of code, can take 2-3x the tokens that equivalent English prose would.
