# Security & Authentication

Frontend Security covered the client-side half of the OWASP concerns — XSS, CSRF, CORS. This page is the backend half: proving who's making a request (**authentication**), deciding what they're allowed to do (**authorization**), and protecting the data itself, independent of which client is asking.

## Authentication: who is this?

Two shapes dominate, with a real trade-off between them:

- **Session-based auth** — on login, the server creates a session record and gives the client an opaque session ID cookie. Every later request looks that ID up. Revoking access is trivial — delete the session — but it requires a shared session store once there's more than one app server, since a stateless app server (Scaling Fundamentals) has nowhere local to keep session state.
- **Token-based auth (JWT)** — the server issues a signed token containing the user's identity and claims directly. Later requests are verified by checking the signature, with no lookup at all — genuinely stateless, fitting the stateless app server model perfectly. The trade-off runs the other way: a token can't be revoked before it expires, short of maintaining a blocklist — which reintroduces the exact shared-state problem token auth was meant to avoid. In practice, tokens are issued with a short expiry and paired with a longer-lived refresh token.

<div class="diagram-wrap">
<svg viewBox="0 0 600 190" width="600" height="190" role="img" aria-label="An authenticated request handled two ways: a session lookup against a shared store, or a token verified locally with no lookup">
  <rect x="20" y="20" width="110" height="36" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="75" y="42" text-anchor="middle" class="d-actor-label">Client</text>
  <rect x="460" y="20" width="120" height="36" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="520" y="42" text-anchor="middle" class="d-actor-label">App Server</text>
  <line x1="130" y1="38" x2="456" y2="38" class="d-msg d-request" marker-end="url(#arrowAuth)"></line>
  <text x="295" y="30" text-anchor="middle" class="d-label-muted" font-size="11">authenticated request</text>
  <rect x="60" y="80" width="480" height="36" rx="6" class="d-note"></rect>
  <text x="300" y="102" text-anchor="middle" class="d-note-text" font-size="12">Session-based: look up the ID in a shared store — revocable instantly, needs shared state</text>
  <rect x="60" y="128" width="480" height="36" rx="6" class="d-note"></rect>
  <text x="300" y="150" text-anchor="middle" class="d-note-text" font-size="12">Token-based (JWT): verify the signature locally — stateless, can't revoke early</text>
  <defs>
    <marker id="arrowAuth" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">Both answer "who is this?" — the difference is whether answering that question requires a round trip to shared state, or can be checked entirely from the request itself.</div>
</div>

**OAuth and OIDC** solve a different problem: delegated access — letting a third-party app act on a user's behalf without ever handing it the user's password. OAuth defines a scoped, revocable grant; OpenID Connect (OIDC) layers identity on top of the same flow, answering "who is this user" rather than just "what is this app allowed to do." The full flow is out of scope here, but the concept worth keeping is delegation without sharing credentials — the mechanism behind every "Sign in with Google" button.

## Authorization: what are they allowed to do?

**Role-based access control (RBAC)** assigns users to roles and roles to permissions — simple, and it covers most real needs. **Attribute-based access control (ABAC)** evaluates a policy against the request, resource, and user's attributes dynamically, needed when a permission depends on context a fixed role can't cleanly express — "can edit this document only if you're on the same team *and* the document isn't currently locked."

## Encryption: protecting the data itself

Two genuinely different guarantees, often conflated: **encryption in transit** (TLS) stops a network-level observer from reading data on the wire, but says nothing about what happens to it once it lands on a disk. **Encryption at rest** protects stored data — on disk, in a database — so a stolen disk or a database dump isn't directly readable. "We use HTTPS" is a claim about the first; it's silent about the second, and assuming one implies the other is a common, genuinely costly gap.

## Secrets management

Database passwords, API keys, and signing keys need to live somewhere an application can read at runtime that isn't its own source code — a secret committed to a repository stays in that repository's history forever, even after it's "removed" in a later commit. Dedicated secrets stores (Vault, a cloud provider's Secrets Manager) issue secrets to services at runtime, often with automatic rotation, so a leaked secret has a bounded window before it's replaced rather than being valid indefinitely.

## Why this matters for system design

None of this is a layer bolted on at the end. The choice between session and token auth decides whether app servers can stay genuinely stateless (Scaling Fundamentals); authorization checks belong at the same system boundary as everything else validated early and cheaply (Rate Limiting & Backpressure); and getting a system's trust boundaries wrong is consistently far more expensive to fix after the fact than any performance trade-off covered elsewhere in this course.

## Real-world examples

- **OAuth 2.0 and OpenID Connect** — the standard protocols behind third-party and social login.
- **JWT (JSON Web Tokens)** — the common format for stateless auth tokens.
- **HashiCorp Vault, AWS Secrets Manager** — dedicated secrets management systems with automatic rotation.
- **Redis or Memcached as a shared session store** — the standard fix for session-based auth behind a load-balanced fleet of app servers.
