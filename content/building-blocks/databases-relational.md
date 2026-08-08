# Databases I — Relational Fundamentals

A database's job sounds simple — store data, get it back later — but almost everything interesting in this course eventually traces back to how hard that job actually is once multiple people are reading and writing at once, the data doesn't fit on one machine, or the machine holding it crashes mid-write. This section covers the relational model: the dominant approach for the last five decades, and still the right default for a large share of real systems.

## Tables, rows, and schemas

A relational database organizes data into **tables** — a fixed set of named, typed columns, with each row being one record. A `users` table might have columns `id`, `name`, `email`, `created_at`; every row must have a value (or explicit null) for each. This upfront structure is the **schema**, and it's enforced by the database itself — you cannot insert a row that violates it.

Data that would otherwise be duplicated is instead split across multiple related tables and joined back together on demand. An `orders` table doesn't repeat the customer's name and email on every row; it stores a `user_id` that references a row in `users`, and a query that needs both **joins** the two tables together on that reference. This is **normalization**: structuring data to minimize duplication, at the cost of needing joins to reassemble it.

## SQL: asking questions about the data

**SQL (Structured Query Language)** is how you interact with a relational database — not by writing code that manually walks through rows, but by declaring *what* you want and letting the database figure out *how* to get it:

```sql
SELECT orders.id, orders.total, users.email
FROM orders
JOIN users ON orders.user_id = users.id
WHERE orders.created_at > '2026-01-01';
```

This declarative style is a real strength: the database's query planner decides the actual execution strategy (which table to scan first, which index to use), and can get smarter over time — using statistics about the data, available indexes, and cost estimates — without you rewriting a single query.

## Indexes: the difference between fast and slow

Without help, finding a row that matches a condition means checking every single row — a **full table scan**. On a table with a few hundred rows, that's instant. On a table with hundreds of millions, it's unusable.

An **index** is a separate, ordered data structure the database maintains alongside a table, mapping the values in a chosen column (or columns) directly to the rows that have them — commonly implemented as a B-tree (structure covered in the Storage Engines deep dive). Looking up `WHERE email = 'ada@example.com'` against an index on `email` means the database can jump almost directly to the matching rows, rather than checking every row in the table.

<div class="diagram-wrap">
<svg viewBox="0 0 600 190" width="600" height="190" role="img" aria-label="Table scan versus index lookup">
  <text x="150" y="25" text-anchor="middle" class="d-label">Without an index</text>
  <rect x="60" y="40" width="180" height="26" rx="4" class="d-block d-block-blocked"></rect>
  <text x="150" y="58" text-anchor="middle" class="d-label" font-size="11">check every row, one by one</text>
  <line x1="60" y1="80" x2="240" y2="80" class="d-axis"></line>
  <text x="150" y="100" text-anchor="middle" class="d-label-muted">O(n) — gets slower as the table grows</text>
  <text x="450" y="25" text-anchor="middle" class="d-label">With an index</text>
  <rect x="400" y="40" width="100" height="26" rx="4" class="d-block d-block-request"></rect>
  <text x="450" y="58" text-anchor="middle" class="d-block-label">jump directly</text>
  <line x1="380" y1="80" x2="520" y2="80" class="d-axis"></line>
  <text x="450" y="100" text-anchor="middle" class="d-label-muted">O(log n) — stays fast as the table grows</text>
  <text x="300" y="150" text-anchor="middle" class="d-label-muted">The trade-off: every index speeds up matching reads, but has to be updated on every write to that column.</text>
</svg>
</div>

That last line matters: indexes aren't free. Every index you add is extra work on every `INSERT`/`UPDATE`/`DELETE` that touches the indexed column, and extra storage. The real skill isn't "add indexes everywhere" — it's indexing the columns your actual query patterns filter and join on, and no others.

## Transactions and ACID

A **transaction** groups multiple operations into a single unit that either fully happens or fully doesn't — critical the moment an operation involves more than one step. Transferring money between two accounts means decrementing one balance and incrementing another; if the process crashes after the first step and before the second, money has simply vanished unless both steps were wrapped in a transaction that guarantees they succeed or fail together.

Relational databases formalize this guarantee as **ACID**:

- **Atomicity** — a transaction's operations all happen, or none do. No partial transactions.
- **Consistency** — a transaction can only move the database from one valid state to another (respecting its own constraints — foreign keys, uniqueness, etc.). Note this is a different, narrower sense of "consistency" than the one used in CAP theorem later in this course — a common point of confusion worth flagging now.
- **Isolation** — concurrent transactions don't see each other's incomplete, in-progress changes, even though they're physically running against the same data at the same time.
- **Durability** — once a transaction is confirmed committed, it survives a crash immediately afterward — it's been written somewhere that won't disappear when power is lost.

Isolation in particular has real cost: guaranteeing transactions never interfere with each other in any way requires either locking (making some transactions wait for others) or extra bookkeeping (tracking multiple versions of a row so readers and writers don't block each other — a technique called MVCC, used internally by most modern relational databases). Databases expose this as tunable **isolation levels** (e.g. read committed, repeatable read, serializable), trading strictness for performance — stricter isolation gives stronger guarantees but generally means more waiting and lower throughput under concurrent load.

## Why this matters for system design

The relational model's real strength is that it makes strong correctness guarantees the default, not something you have to build yourself: constraints, joins, and ACID transactions handle a large class of bugs (partial writes, duplicated or orphaned data, races between concurrent updates) before they ever reach your application code. That reliability has a cost in flexibility and horizontal scalability — themes covered directly in the next few sections (NoSQL models, replication, and partitioning) — but for data where correctness matters more than raw write throughput (financial records, inventory, anything with real invariants to enforce), it's usually still the right starting point.
