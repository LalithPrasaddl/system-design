# Prices That Won't Update

<div class="drill-meta"><span class="drill-level" data-level="warmup">Warm-up</span><span>Distributed Cache</span><span>Expiry and invalidation</span></div>

This drill runs on the finished design from the [Distributed Cache](#/systems-case-studies/distributed-cache) case study. One rule from it matters here: every value written to the cache carries a TTL of about five minutes. Some writers don't bother deleting cache keys when they change the database, and that's allowed, because the TTL guarantees a stale value lasts five minutes at most.

<div class="incident-card">
<div class="incident-card-head"><span class="incident-sev">SEV-3</span><span>Monday 09:30 · escalated by customer support</span></div>
<p><strong>Customers report that product pages show one price and checkout charges another.</strong> Product 88213 shows $19.99 on its page and charges $24.99 at checkout. Checkout reads the price from the database, and the product page reads it from the cache. Support says the complaints started on Friday evening.</p>
</div>

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Support tickets</div>
<div class="stat-tile-value">37</div>
<div class="stat-tile-sub">since Friday evening</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Products affected</div>
<div class="stat-tile-value">14</div>
<div class="stat-tile-sub">of 40 repriced on Friday</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Wrong for</div>
<div class="stat-tile-value">~3<span class="stat-tile-unit">days</span></div>
<div class="stat-tile-sub">the TTL is 5 minutes</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Cache hit ratio</div>
<div class="stat-tile-value">95<span class="stat-tile-unit">%</span></div>
<div class="stat-tile-sub">normal</div>
</div>
</div>

## Investigate

Open the panels in the order you would check them.

<details class="evidence">
<summary>Browser and CDN</summary>

Product pages are sent with `Cache-Control: private, no-store`, and the CDN passes them straight through without caching. Support reproduced the wrong price in a private window, on a phone and on a laptop. The HTML is built fresh on every request.

</details>

<details class="evidence">
<summary>Database</summary>

```
SELECT id, price, updated_at, updated_by FROM products WHERE id = 88213;

  id    | price | updated_at        | updated_by
  88213 | 24.99 | Fri 18:04         | repricing-job
```

The repricing job runs every evening. It updates prices in the database and does not touch the cache. Its config has a comment: `# cache picks up new prices within 5 min (TTL)`. On Friday it repriced 40 products.

</details>

<details class="evidence">
<summary>Cache</summary>

```
> GET product:88213
"{\"id\":88213,\"price\":19.99, ...}"

> TTL product:88213
(integer) -1

> TTL product:51120          # a product nobody has complained about
(integer) 212
```

`TTL` returns the seconds left before a key expires. All 14 affected products return `-1`. In a random sample of 10,000 product keys, 9,951 have a TTL and 49 have none.

</details>

<details class="evidence">
<summary>Recent changes</summary>

```
Wed 11:20  merch-import  v1.0 launched: nightly supplier import, ~5,000 products
Thu 15:05  cdn           new image-resize rule for /img/*
Fri 10:00  repricing     schedule moved from 02:00 to 18:00
```

</details>

<details class="evidence">
<summary>merch-import source</summary>

```python
for product in imported:
    db.upsert(product)
    # warm the cache so the first shoppers don't hit a cold page
    cache.set(f"product:{product.id}", serialize(product))
```

For comparison, the shared cache helper the product page uses when it fills the cache:

```python
cache.set(key, serialize(value), ex=300 + jitter())
```

</details>

## Your turn

Write your answers down before opening anything below.

1. **The cache is supposed to be at most five minutes stale. Why has this price been wrong for three days?**
2. **Why 14 products, and not all 40 repriced on Friday?**
3. **What would you do now, and what would you change?**

<div class="drill-notes">
<label for="drill-notes-input">Your notes</label>
<textarea id="drill-notes-input" rows="7" placeholder="Why it's stuck, why only 14, what you'd do…"></textarea>
<div class="drill-notes-hint">Saved in this browser only.</div>
</div>

### Stuck?

<details class="hint">
<summary><span class="reveal-step">1</span> Hint</summary>

First rule out the places a web developer would look first: the browser and the CDN. Then check what `TTL` says about the affected keys.

</details>

<details class="hint">
<summary><span class="reveal-step">2</span> Hint</summary>

A `TTL` of `-1` means the key never expires. Which code wrote these keys, and how is it different from the shared helper?

</details>

## Reveal

<details class="reveal">
<summary><span class="reveal-step">1</span> Root cause</summary>

**Two pieces of code that are each fine on their own.**

- **The repricing job doesn't delete cache keys.** It relies on the TTL to clear old prices within five minutes. The design allows this.
- **The new import job writes cache keys with no TTL.** It skipped the shared helper and called `cache.set` without `ex`, so the keys it wrote on Wednesday never expire.

When the repricing job changed those products' prices on Friday, nothing removed the old value from the cache. The TTL is the safety net for every writer that skips invalidation, and these keys had none. Nothing was ever going to correct them.

**Why only 14 of 40.** The job repriced 40 products on Friday. The other 26 were not in Wednesday's import, so their cache keys had a normal TTL and showed the new price within five minutes. These 14 were in both: imported on Wednesday with no TTL, then repriced on Friday.

**Why eviction didn't clear them either.** When a cache is full, it evicts the keys nobody has read recently, which can quietly fix a key with no TTL. But a product page that customers keep visiting is read all the time, so its key is never evicted. The keys most likely to be seen wrong are also the ones most likely to stay wrong.

**The red herrings.** The browser and the CDN don't store this page. The image-resize rule only touches `/img/*`. The new repricing schedule only made the price change happen on a Friday evening, so it was Monday before anyone acted on the complaints.

</details>

<details class="reveal">
<summary><span class="reveal-step">2</span> The fixes most people try first</summary>

- **Flush the whole cache.** It fixes the 14 prices immediately and sends every read to the database at once. The case study showed that losing five points of hit ratio is enough to overload it, so this turns a pricing bug into an outage.
- **Purge the CDN, or ask customers to clear their browser cache.** The stale value is not stored there.
- **Delete the 14 keys.** This is the right first step, but it leaves about 5,000 other imported keys with no TTL. Each one goes wrong the next time any writer changes that product without deleting its key.
- **Make the repricing job delete keys after updating them.** This is reasonable, but it fixes only one writer. The real promise is that every key expires, whoever changes the database. Any other script or admin query that edits a price will hit the same problem.

</details>

<details class="reveal">
<summary><span class="reveal-step">3</span> The right fix</summary>

**Now:**

1. **Delete the 14 keys.** Customers stop seeing wrong prices within seconds.
2. **Give every other key with no TTL an expiry, spread out over time.** Walk the cache with `SCAN`, which reads keys in small batches, not with `KEYS *`, which locks up a node while it reads everything. For each key without a TTL, set one at a random time between 1 and 10 minutes from now. Spreading the expiry times means the imported keys refill gradually instead of all missing at the same moment.

**Then change the design so it can't happen again:**

- **Make the cache client require a TTL.** `set()` without `ex` either throws an error or applies a default maximum, such as one hour. The promise "every key expires" now lives in one place, not in every caller's memory.
- **Warm the cache through the shared helper**, the same path the product page uses.
- **Optionally, invalidate from the database's change stream.** A small process reads every committed change in the database and deletes the matching cache keys. Writers that never touch the cache are then covered too, and the TTL goes back to being a backstop, not the only defence. The case study's Deep Dives tab describes this approach.

**How to catch it next time:**

- Track the **number of keys with no TTL**. Most cache servers report total keys and keys with an expiry, so the difference is easy to graph. For this design it should be zero, and anything else means an alert.
- Add a test that checks the **price on the product page matches the price at checkout** for a sample of products. That turns a customer complaint into an alert.

</details>

## Concepts used

- [Caching](#/systems/caching): cache-aside, TTLs, and invalidation
- [Observability](#/systems/observability): alerting on an invariant, not only on errors
- [Distributed Cache](#/systems-case-studies/distributed-cache): the design this drill runs on
