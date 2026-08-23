# Retrieval-Augmented Generation (RAG)

Fine-Tuning in Practice pointed out that teaching a model new or frequently-changing facts is a poor fit for fine-tuning. RAG is the pattern built specifically to solve that problem instead: give the model the relevant information right when it needs to answer, rather than trying to bake that information into its weights at all.

## The problem RAG solves

An LLM's knowledge is frozen at whatever was in its training data. And its context window (LLM Vocabulary) is far too small to hold an entire company's knowledge base at once.

RAG bridges both gaps. Instead of asking the model to answer purely from what it happened to learn during training, the system first retrieves the specific pieces of content most relevant to the current question. Only those pieces get included in the prompt, as context for generating the answer.

The model still writes the actual response. But now it's answering with the real, current document sitting right in front of it — not relying only on whatever it memorized months or years ago during training.

## The retrieve-then-generate pipeline

<div class="diagram-wrap">
<svg viewBox="0 0 640 220" width="640" height="220" role="img" aria-label="RAG pipeline: a user query is embedded, matched against a vector index to retrieve relevant chunks, which are inserted into the prompt sent to the LLM to generate the final answer">
  <rect x="15" y="20" width="100" height="36" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="65" y="42" text-anchor="middle" class="d-actor-label" font-size="12">User query</text>
  <line x1="115" y1="38" x2="185" y2="38" class="d-msg d-request" marker-end="url(#arrowRag1)"></line>
  <rect x="185" y="20" width="100" height="36" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="235" y="42" text-anchor="middle" class="d-actor-label" font-size="11">Embed query</text>
  <line x1="285" y1="38" x2="355" y2="38" class="d-msg d-request" marker-end="url(#arrowRag2)"></line>
  <rect x="355" y="20" width="120" height="36" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="415" y="42" text-anchor="middle" class="d-actor-label" font-size="11">Vector search</text>
  <text x="415" y="12" text-anchor="middle" class="d-label-muted" font-size="9">nearest-neighbor lookup</text>
  <line x1="415" y1="56" x2="415" y2="90" class="d-lifeline"></line>
  <rect x="330" y="90" width="170" height="34" rx="6" class="d-block d-block-response"></rect>
  <text x="415" y="111" text-anchor="middle" class="d-block-label" font-size="11">top-k relevant chunks</text>
  <line x1="415" y1="124" x2="415" y2="150" class="d-lifeline"></line>
  <rect x="200" y="150" width="430" height="40" rx="6" class="d-note"></rect>
  <text x="415" y="167" text-anchor="middle" class="d-note-text" font-size="11">prompt = system instructions + retrieved chunks + user query</text>
  <line x1="415" y1="190" x2="415" y2="200" class="d-lifeline"></line>
  <text x="415" y="215" text-anchor="middle" class="d-label" font-size="12">LLM generates the final answer, grounded in the retrieved content</text>
  <defs>
    <marker id="arrowRag1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
    <marker id="arrowRag2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
  </defs>
</svg>
<div class="diagram-caption">Retrieval happens before generation, not instead of it — the LLM still writes the final answer, but with the specific relevant source material placed directly in its context instead of relying on what it memorized during training.</div>
</div>

The retrieval half depends directly on Embeddings & Vector Search: documents are chunked and embedded ahead of time and stored in a vector index; at query time, the query itself is embedded and the closest chunks are pulled from that index.

## Chunking trade-offs

Documents have to be split into smaller **chunks** before they get embedded. A single embedding represents one reasonably-sized piece of text well, but it blurs together the meaning of a very long document into something too vague to be useful.

Chunk size is a real trade-off. Chunks that are too large waste context window space on irrelevant surrounding text, and make the embedding less specific. Chunks that are too small can lose context a correct answer actually needs — or worse, split one relevant fact across two chunks, so that neither chunk retrieves well on its own.

A common fix is to let consecutive chunks overlap slightly, so a fact sitting right at a chunk boundary doesn't get fully lost on either side.

## Why this matters for system design

RAG is a system design pattern before it's a machine learning technique. It's the same idea as an index (Search & Indexing at Scale) or a cache (Caching): don't hold everything at once, fetch what's relevant on demand. RAG just applies that idea to an LLM's limited, expensive context window instead of a limited amount of RAM.

It's also usually cheaper and faster to keep up to date than fine-tuning. Updating a RAG system's knowledge just means re-indexing new or changed documents — it doesn't mean retraining a model. That's exactly why RAG, not fine-tuning, is the default answer for "make the model aware of our own content that keeps changing."

## Real-world examples

- **LangChain, LlamaIndex** — the most widely used open-source frameworks built specifically for creating RAG pipelines.
- **Perplexity, Bing Chat / Copilot** — consumer products where every answer is visibly backed by retrieved, cited web sources — RAG's retrieval step made visible to the user.
- **Enterprise "chat with your docs" products** — the single most common commercial use of RAG: letting a company's internal knowledge base be queried in plain language, without fine-tuning a model on it.
