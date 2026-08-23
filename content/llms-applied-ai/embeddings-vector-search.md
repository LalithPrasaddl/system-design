# Embeddings & Vector Search

Everything so far in this module has been about the model itself. This page covers a different, closely related tool that shows up constantly around LLM systems: turning text (or images, or audio) into numbers that capture its meaning. Once meaning is represented as numbers, "how similar are these two things" becomes a question a computer can actually answer.

## What an embedding is

An **embedding** is a list of numbers — typically hundreds or a few thousand of them — that represents one piece of text (or image, or audio clip).

These numbers aren't random. They come from a model trained so that inputs with similar meaning end up close together, and inputs with different meanings end up far apart, in this imaginary space of numbers. "Close" and "far" are measured with a distance calculation (most commonly **cosine similarity**).

The payoff: "how similar are these two pieces of text in meaning" turns into "how close are these two lists of numbers" — a precise, well-defined math question, instead of a fuzzy human judgment call.

<div class="diagram-wrap">
<svg viewBox="0 0 560 220" width="560" height="220" role="img" aria-label="A 2D projection of an embedding space: sentences about dogs cluster together, sentences about databases cluster together, and the two clusters sit far apart">
  <rect x="20" y="20" width="520" height="180" rx="6" fill="none" stroke="var(--border)" stroke-width="1.5"></rect>
  <circle cx="110" cy="70" r="7" class="d-block d-block-request"></circle>
  <text x="122" y="66" class="d-label-muted" font-size="10">"my dog loves the park"</text>
  <circle cx="140" cy="105" r="7" class="d-block d-block-request"></circle>
  <text x="152" y="101" class="d-label-muted" font-size="10">"puppies need daily walks"</text>
  <circle cx="95" cy="115" r="7" class="d-block d-block-request"></circle>
  <text x="60" y="140" class="d-label-muted" font-size="9">(dogs cluster)</text>
  <circle cx="410" cy="140" r="7" class="d-block d-block-response"></circle>
  <text x="330" y="130" class="d-label-muted" font-size="10">"index this column for fast lookups"</text>
  <circle cx="440" cy="165" r="7" class="d-block d-block-response"></circle>
  <text x="360" y="185" class="d-label-muted" font-size="10">"the shard is out of disk space"</text>
  <text x="440" y="70" class="d-label-muted" font-size="9">(databases cluster)</text>
</svg>
<div class="diagram-caption">A real embedding space has hundreds of dimensions; this is a 2D projection for intuition. Meaning determines distance — text about dogs sits nowhere near text about databases, regardless of shared words.</div>
</div>

## Nearest-neighbor search

Given a query's embedding, **nearest-neighbor search** finds the stored embeddings closest to it — in other words, the pieces of stored content that are most similar in meaning to the query.

The simplest approach compares the query against every single stored vector, one by one. This is completely accurate, but it gets slower as the number of stored vectors grows. It's fine for a few thousand items, but far too slow for the tens or hundreds of millions of items many real systems actually store.

**Approximate nearest neighbor (ANN)** algorithms solve this. The most common one today is called **HNSW**. These algorithms trade a tiny bit of accuracy for a huge speedup, using an index structure built specifically to avoid comparing against every single stored vector. (This index is conceptually a close relative of the indexes covered in Search & Indexing at Scale.)

## Vector databases

A **vector database** stores embeddings alongside the original content, and lets you run nearest-neighbor search as a normal query — the same way a relational database lets you run SQL queries. (Some teams instead just add vector search as an extra feature to a database they already use, rather than adopting a dedicated one.)

Beyond raw nearest-neighbor search, a real vector database handles the same operational concerns any database does: keeping data safe (durability), handling updates and deletes, filtering results by other criteria (for example, "similar documents, but only from this user's account"), and scaling the index across multiple machines as the collection grows. That last one is really just partitioning again (Partitioning & Sharding) — just partitioning a vector index instead of a table.

## Why this matters for system design

Embeddings turn "find things that are similar in meaning" into a well-defined nearest-neighbor search. That's a task a normal keyword or exact-match index (Search & Indexing at Scale) simply can't do — two relevant pieces of text might not share a single word in common.

This is the exact mechanism RAG is built on. Retrieving the most relevant content for a query is, underneath, exactly this kind of vector search.

## Real-world examples

- **Pinecone, Weaviate, Qdrant, Milvus** — dedicated, purpose-built vector database products.
- **pgvector** — a PostgreSQL extension that adds vector storage and search to a database you might already be using — the same "bolt the capability onto what you already have" pattern as Citus does for sharding (Partitioning & Sharding).
- **OpenAI's and Cohere's embedding APIs** — widely used hosted models whose entire job is to turn text into an embedding.
- **HNSW (hierarchical navigable small world graphs)** — the ANN algorithm behind most production vector search systems today.
