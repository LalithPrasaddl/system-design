# Storage Engines

Databases I and II covered data *models* — how data is organized conceptually (tables, documents, key-value pairs) and queried. This section is one layer deeper: how a database actually stores bytes on disk and gets them back, which is a mostly separate concern from the model sitting on top of it. Many databases you'd recognize as "very different" (a relational database and a key-value store) can share deep architectural DNA at the storage engine layer, and databases that look similar on the surface can behave very differently under load because of storage engine choices underneath.

## The write-ahead log: durability before anything else

Recall ACID's Durability guarantee (Databases I): once a transaction commits, it survives a crash immediately afterward. This can't be achieved by only updating a database's normal data structures in place — if the machine loses power mid-update, that structure could be left in a corrupted, half-written state with no way to know what it looked like a moment before.

The standard solution is a **write-ahead log (WAL)**: before any change is applied to the database's actual data structures, it's first appended to a simple, append-only log on disk. Appending to the end of a file is fast (sequential writes are dramatically cheaper than writes scattered across a disk, a fact that resurfaces constantly below) and, critically, safe to reason about — if the system crashes, it can replay the WAL from the last known-good point to reconstruct exactly what should have happened. This is the same fundamental idea as the append-only log from the Kafka deep dive, applied here to a single database's internal durability rather than to communication between services — recognizing that repetition is worth more than either instance alone.

## Two families of storage engine

Once durability is handled via the WAL, the database still needs a data structure that supports efficient lookups and range scans — and there are two dominant, genuinely different approaches to that problem, each with a real and opposite trade-off:

- **B-tree based engines** (used by most traditional relational databases — PostgreSQL, MySQL's InnoDB) update data **in place**. Finding a row means walking down a balanced tree structure to the exact page it lives on and modifying it directly.
- **LSM-tree based engines** (used by Cassandra, RocksDB, and many other write-optimized systems) never modify data in place. Writes are buffered in memory and later flushed to disk as new, immutable files; reads may need to check several of these files and merge the results.

The full mechanics and trade-off between these two is substantial enough to warrant its own page — see the deep dive below if you want to understand exactly why one favors read latency and the other favors write throughput, and how each actually works internally.

## Why this matters for system design

When you pick a database in Databases I or II, you're often implicitly also picking a storage engine philosophy, and that choice shows up directly in production behavior: a write-heavy workload (logging, metrics, event ingestion) tends to perform very differently on an LSM-based engine than a B-tree-based one, even if both databases expose the exact same query language on top. Knowing that this layer exists — and that "which database" and "which storage engine" are two separate decisions, sometimes made for you by the database's design, sometimes configurable within it — is what lets you explain *why* two seemingly similar databases behave differently under the same load, rather than only observing that they do.

## Real-world examples

- **B-tree based** — PostgreSQL, MySQL's InnoDB, SQLite.
- **LSM-tree based** — Cassandra, RocksDB, HBase.
- **WiredTiger** — MongoDB's default storage engine, itself capable of both B-tree and LSM-style configurations, and a good example of the model/engine split described above.
