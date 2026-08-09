# Frontend Security

Everything so far has assumed the code running in the browser is yours and the requests it makes are legitimate. This page is about the ways both of those assumptions break — the client-side half of the concerns the OWASP Top 10 catalogs, and the specific defenses that have become standard because of it.

## XSS: someone else's JavaScript, running as you

**Cross-site scripting** happens when untrusted input ends up executed as code in your page — most often, user-submitted text inserted directly into HTML without escaping, which lets it include an actual `<script>` tag or an event handler the browser then runs. Once that happens, the injected code runs with exactly the same access your own code has: it can read and modify the page, make requests as the logged-in user, and read anything sitting in `localStorage` — which is precisely why Client-Side Storage flagged `localStorage` as the wrong place for a session token. Most modern frameworks escape interpolated content by default; the actual danger zone is the explicit "trust me, this is safe HTML" escape hatch (`dangerouslySetInnerHTML` and equivalents), which should only ever wrap content that's been through a sanitizer.

## CSRF: a forged request riding on real credentials

<div class="diagram-wrap">
<svg viewBox="0 0 620 280" width="620" height="280" role="img" aria-label="A cross-site request forgery: a malicious page tricks the browser into submitting an authenticated request to a bank, with the session cookie attached automatically">
  <rect x="20" y="112" width="110" height="36" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="75" y="134" text-anchor="middle" class="d-actor-label" font-size="12">Your Browser</text>
  <rect x="260" y="20" width="140" height="36" rx="6" style="fill:var(--fail-soft);stroke:var(--fail);stroke-width:2;"></rect>
  <text x="330" y="42" text-anchor="middle" class="d-actor-label" font-size="12">Malicious Site</text>
  <rect x="260" y="204" width="140" height="36" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="330" y="226" text-anchor="middle" class="d-actor-label" font-size="12">Bank Server</text>
  <line x1="130" y1="122" x2="256" y2="54" class="d-msg d-request" marker-end="url(#arrowCsrf)"></line>
  <text x="200" y="80" text-anchor="middle" class="d-label-muted" font-size="11">1. visits page</text>
  <rect x="260" y="64" width="140" height="28" rx="5" class="d-note"></rect>
  <text x="330" y="82" text-anchor="middle" class="d-note-text" font-size="10">hidden auto-submit form</text>
  <line x1="130" y1="138" x2="256" y2="210" class="d-msg d-request" marker-end="url(#arrowCsrf)"></line>
  <text x="195" y="170" text-anchor="middle" class="d-label-muted" font-size="11">2. cookie attached</text>
  <text x="195" y="183" text-anchor="middle" class="d-label-muted" font-size="11">automatically</text>
  <rect x="260" y="244" width="140" height="28" rx="5" class="d-note"></rect>
  <text x="330" y="262" text-anchor="middle" class="d-note-text" font-size="10">looks legitimate</text>
  <defs>
    <marker id="arrowCsrf" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">Cookies are attached by the browser based on which domain a request is going to, not which page triggered it. A malicious page can submit a form (or fire a request) straight to a site you're already logged into, and your browser helpfully attaches your real session cookie — the bank has no way to tell this request apart from one you meant to send.</div>
</div>

The fix isn't "don't trust cookies" — it's giving the server a way to tell a same-site request from a forged cross-site one. A **CSRF token** is a per-session secret value the real page embeds in its own requests, which a forged request from another origin has no way to know. The **`SameSite`** cookie attribute solves it more directly, at the browser level: `SameSite=Lax` or `Strict` tells the browser not to attach that cookie to cross-site requests at all, which is why it's become the modern default in most browsers rather than something every application has to opt into individually.

## CORS: not what it sounds like

Browsers enforce a **same-origin policy** by default: a page's JavaScript can't read the response from a request to a different origin unless that origin explicitly allows it, via `Access-Control-Allow-Origin` and related headers — this is **CORS**. The common misconception is worth correcting directly: CORS doesn't usually stop the request from being *sent* — the request often still reaches the server and executes. What CORS controls is whether the browser lets the *calling page's JavaScript read the response*. That distinction matters in practice: a state-changing request without a proper CORS setup can still happen; it's the attacker's ability to read the result back that CORS is blocking. This becomes directly relevant once a frontend and its API live on different subdomains — the exact setup a BFF (Backend-for-Frontend & API Shape) usually has.

## CSP: a second line of defense

A **Content Security Policy** is a response header declaring which sources scripts, styles, and other resources are allowed to load from at all. It doesn't prevent an XSS injection from happening, but it can stop the injected code from doing anything: even if an attacker gets a `<script>` tag into the page, a strict CSP that only allows scripts from your own domain will simply refuse to execute one loaded from anywhere else.

## Why this matters for system design

None of these defenses are about scale or infrastructure — they're specific, well-understood answers to specific attack shapes, which is exactly why the trend has been toward baking them in by default rather than trusting every team to remember them: auto-escaping templates for XSS, `SameSite=Lax` as a browser default for CSRF, CSP as a blunt but effective backstop for whatever the first line of defense misses. The general lesson carries over from Client-Side Storage: never assume code running on a device you don't control is trustworthy by default, only by the specific mechanism that made it so.

## Real-world examples

- **The OWASP Top 10** — the standard, regularly updated reference this page's concerns are drawn from.
- **`SameSite=Lax`** — the cookie default in Chrome, Firefox, and Safari as of recent versions, a browser-level CSRF mitigation applied automatically.
- **DOMPurify** — a widely used library for sanitizing untrusted HTML before it's ever inserted into the DOM.
- **`Content-Security-Policy`** — the response header used by major sites to restrict which script sources the browser will execute.
