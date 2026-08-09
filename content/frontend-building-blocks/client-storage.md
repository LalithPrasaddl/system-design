# Client-Side Storage

Client-Side Data & Caching covered data that lives for the duration of a page's session, in memory. This page is about the options for data that needs to survive a reload, a tab close, or even a browser restart — and picking the wrong one among them is a common source of both bugs and, in one specific case, real security exposure.

## The options, compared

| Storage | Size | Sent to server automatically? | Survives... | Access |
|---|---|---|---|---|
| Cookies | ~4KB per cookie | Yes, on every matching request | Until expiry (configurable) | Synchronous; can be marked `HttpOnly` (invisible to JS) |
| `localStorage` | ~5-10MB per origin | No | Until explicitly cleared | Synchronous, plain JS |
| `sessionStorage` | ~5-10MB per origin | No | Until the tab closes | Synchronous, plain JS |
| IndexedDB | Hundreds of MB+ (device-dependent) | No | Until explicitly cleared | Asynchronous, transactional, structured |

The "sent to server automatically" column matters more than it looks — it's the entire reason cookies still exist despite `localStorage` being easier to use. A cookie rides along with every request to a matching domain without any application code doing anything, which is exactly the behavior session authentication needs, and exactly the behavior that makes cookies the thing CSRF protection (Frontend Security) has to account for.

## Where a session token actually belongs

A common shortcut is storing an auth token in `localStorage` and attaching it to requests manually. It works, but it means *any* JavaScript running on the page — including an attacker's, if the page has an XSS vulnerability (Frontend Security) — can read it directly and exfiltrate it. An `HttpOnly` cookie is invisible to JavaScript entirely; a JS-level XSS bug can't read it no matter what. That doesn't make cookies free of risk (an `HttpOnly` cookie can still be *used* by a forged request if CSRF isn't separately handled), but it closes off the most direct theft path, which is why session cookies rather than `localStorage` are the standard recommendation for auth tokens specifically.

## Storage limits and eviction

Browsers enforce a per-origin quota, and under storage pressure — common on mobile devices — they can evict `localStorage` and IndexedDB data without warning, well before any user-visible "storage full" prompt. This is the same principle as cache eviction (Caching) but with far less control: there's no LRU policy you configure, just "the browser decided it needed the space." The practical implication is the same one that page ends on — if losing this data silently would produce a wrong answer rather than just a slower one, it was never safe to treat as the only copy. Client storage is for a local, disposable copy of something recoverable from the server, or for state that only ever needed to exist locally (a draft, a UI preference) in the first place.

## Why this matters for system design

Client storage is often the quiet backstop for offline support and instant-feeling reloads (see Offline & Resilience), but it's also a second place your data now lives, with its own consistency and security properties — different from the server's. Treating it as an untrusted, best-effort cache rather than a database keeps both of those properties from becoming surprises later: it should always be plausible to lose everything in it and recover cleanly from the server.

## Real-world examples

- **`localForage`** — a library that wraps IndexedDB (falling back to `localStorage`) behind a simpler key-value API.
- **Redux Persist** and similar state-persistence libraries — write client application state into `localStorage` or IndexedDB so it survives a reload.
- **Browser DevTools' Application panel** — where cookies, `localStorage`, `sessionStorage`, and IndexedDB contents can all be inspected directly, per origin.
