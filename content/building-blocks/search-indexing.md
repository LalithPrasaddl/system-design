# Search & Indexing at Scale

The indexes covered in Databases I speed up exact-match and range lookups on structured columns — `WHERE user_id = 42`, `WHERE created_at > X`. They do essentially nothing for a different, extremely common question: "find every document that mentions 'distributed systems' and 'consensus', ranked by how relevant each one is." That's a different problem, needing a different structure.

## The inverted index

The core data structure behind virtually all text search is the **inverted index** — "inverted" because instead of mapping documents to the words they contain (the normal, forward direction), it maps each word to the list of documents that contain it.

<div class="diagram-wrap">
<svg viewBox="0 0 600 220" width="600" height="220" role="img" aria-label="Building an inverted index by mapping terms to the documents that contain them">
  <text x="90" y="25" text-anchor="middle" class="d-label">Documents</text>
  <rect x="20" y="40" width="140" height="30" rx="5" class="d-actor-box"></rect>
  <text x="90" y="60" text-anchor="middle" class="d-label" font-size="11">Doc 1: "fast cache"</text>
  <rect x="20" y="80" width="140" height="30" rx="5" class="d-actor-box"></rect>
  <text x="90" y="100" text-anchor="middle" class="d-label" font-size="11">Doc 2: "fast queue"</text>
  <rect x="20" y="120" width="140" height="30" rx="5" class="d-actor-box"></rect>
  <text x="90" y="140" text-anchor="middle" class="d-label" font-size="11">Doc 3: "slow cache"</text>
  <text x="420" y="25" text-anchor="middle" class="d-label">Inverted index</text>
  <rect x="330" y="40" width="80" height="28" rx="5" class="d-note"></rect>
  <text x="370" y="59" text-anchor="middle" class="d-note-text">fast</text>
  <text x="500" y="59" class="d-label-muted" font-size="12">→ [Doc 1, Doc 2]</text>
  <rect x="330" y="76" width="80" height="28" rx="5" class="d-note"></rect>
  <text x="370" y="95" text-anchor="middle" class="d-note-text">cache</text>
  <text x="500" y="95" class="d-label-muted" font-size="12">→ [Doc 1, Doc 3]</text>
  <rect x="330" y="112" width="80" height="28" rx="5" class="d-note"></rect>
  <text x="370" y="131" text-anchor="middle" class="d-note-text">queue</text>
  <text x="500" y="131" class="d-label-muted" font-size="12">→ [Doc 2]</text>
  <rect x="330" y="148" width="80" height="28" rx="5" class="d-note"></rect>
  <text x="370" y="167" text-anchor="middle" class="d-note-text">slow</text>
  <text x="500" y="167" class="d-label-muted" font-size="12">→ [Doc 3]</text>
  <line x1="160" y1="100" x2="326" y2="100" class="d-lifeline"></line>
</svg>
<div class="diagram-caption">A search for "fast cache" becomes a lookup of two short lists (Doc 1, Doc 2 for "fast"; Doc 1, Doc 3 for "cache") and an intersection — Doc 1 appears in both — rather than scanning every document's text.</div>
</div>

A query for multiple terms becomes set operations over these lists (called **postings lists**): "fast AND cache" intersects the two lists; "fast OR cache" unions them. This turns an operation that would otherwise mean scanning every document's full text into a lookup against a much smaller, purpose-built structure — the same fundamental idea as the B-tree index from Databases I (trade storage and build-time work for fast lookups later), applied to unstructured text instead of structured columns.

## Getting from raw text to terms

Before text goes into the index, it's run through **analysis**: lowercasing (so "Fast" and "fast" match), splitting into individual words (**tokenization**), removing extremely common words that add little search value (**stop words** — "the," "and," "is"), and often **stemming** or **lemmatization** — reducing words to a common root so "running," "runs," and "ran" can all match a search for "run." The same analysis has to be applied to a user's search query, or terms that mean the same thing to a human won't match at all.

## Ranking: search isn't just matching

Finding documents that contain the query terms is necessary but not sufficient — a search for "cache" that returns ten thousand matching documents in arbitrary order is barely more useful than returning none. Real search engines rank results by estimated relevance, most commonly using a scoring approach in the family of **TF-IDF** (term frequency–inverse document frequency) or its more refined successor **BM25**:

- **Term frequency** — a document that mentions the query term many times is probably more relevant to it than one that mentions it once.
- **Inverse document frequency** — a term that appears in only a few documents overall is more informative when it matches than a term that appears in nearly all of them (matching "the" tells you almost nothing; matching "consensus" tells you a lot).

The intuition, not the exact formula, is what's worth internalizing: relevance is about a term being both *frequent in this document* and *rare across the whole collection* — common words that show up everywhere are weighted down, and words that meaningfully distinguish this document from the rest are weighted up.

## Scaling a search index

A search index for a large corpus doesn't fit on one machine any more than a large database table does, and the answer is structurally the same one from Partitioning & Sharding: split the index into **shards**, each covering a subset of documents, distributed across multiple machines.

The query pattern that results is called **scatter-gather**: a search query is sent to every shard in parallel (each searches its own subset and returns its own top-ranked matches), and a coordinating node merges those partial result sets into one final ranked list. This is a genuinely different access pattern than the hash-based sharding used for key-value lookups — a search query, unlike a lookup by ID, has no single key that tells you which shard holds the answer, so *every* shard has to be asked on every query. This is also exactly why search infrastructure (Elasticsearch, Solr — both built on the Lucene library) is usually a separate, purpose-built system rather than a feature bolted onto a general-purpose database: the query and scaling patterns are different enough to justify dedicated infrastructure.

## Keeping a search index in sync

A search index is almost always a **derived** data store — built from data whose source of truth lives elsewhere (a relational database, most often). This raises a problem that should look familiar: two copies of related information (the source-of-truth row, and its representation in the search index) that need to stay reasonably in agreement, which is exactly the consistency question from the Consistency Models section, now applied to a purpose-built secondary store instead of a database replica. The common solution ties directly back to Message Queues: writes to the primary database publish an event, and a consumer updates the search index asynchronously in response — accepting eventual consistency (a brief window where a new or updated record hasn't yet shown up in search results) in exchange for not coupling every write to the primary database with a synchronous update to the search index as well.

## Why this matters for system design

"Add search" is one of the most common features that turns a straightforward CRUD design into a genuinely multi-component system: a purpose-built inverted index, a scatter-gather query pattern across shards, a ranking function, and an asynchronous pipeline keeping it in sync with the source of truth — each one a direct application of a building block from earlier in this module, combined to solve a problem none of them solve individually.
