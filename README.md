# System Design, Learned

An interactive, textbook-depth course on system design — client-server basics through building blocks (caching, databases, replication, consensus, queues, etc.) to full case studies. No prior system design experience assumed.

## Stack

Plain HTML/CSS/JS. No framework, no build step, no server/backend.

- **Routing:** hash-based (`#/section-id`), handled client-side in `assets/js/app.js`.
- **Content:** Markdown files under `content/`, fetched and rendered at runtime with `marked.js` (vendored locally in `assets/js/vendor/`, not loaded from a CDN).
- **Navigation:** driven entirely by `content/manifest.json` — the sidebar, section order, and prev/next links are all generated from it.
- **Progress tracking:** a "mark as complete" checkbox per page, stored in the visitor's `localStorage`. No account, no server, no cross-device sync.

Because there's no build step, the site can be served by pointing any static file server at the project root:

```
python3 -m http.server 8000
# then open http://localhost:8000
```

## Project structure

```
index.html                 Shell: sidebar + content mount point
assets/
  css/styles.css            All styling, incl. the shared diagram visual language
  js/app.js                 Router, sidebar builder, markdown fetch/render, progress tracking
  js/vendor/marked.min.js   Vendored markdown parser (not a CDN dependency)
content/
  manifest.json             The course tree: modules -> sections -> optional "branches"
  start-here/                Welcome + course map
  foundations/                One folder per module, one .md file per section
```

## Adding a new page

1. Write the content as a Markdown file under the appropriate `content/<module>/` folder.
2. Add an entry for it in `content/manifest.json`, inside the relevant module's `sections` array:
   ```json
   { "id": "my-section-id", "title": "My Section Title", "file": "module-folder/my-file.md" }
   ```
3. Optional "go deeper" content nests under a section via a `branches` array of the same shape — it renders as a collapsible sub-item in the sidebar, clearly marked optional, and does not interrupt the main prev/next flow.

The `id` becomes the URL (`#/my-section-id`) and must be unique across the whole manifest.

## Content conventions

- Pages are written as standalone, complete pieces — no references to the course's own build status, timelines, or comparisons to other material.
- Diagrams are hand-built inline SVG, not a charting library or Mermaid. A shared set of CSS classes (`.diagram-wrap`, `.d-actor-box`, `.d-lifeline`, `.d-msg`/`.d-request`/`.d-response`, `.d-note`, `.d-block`, `.d-axis`, etc. — see `assets/css/styles.css`) keeps every diagram visually consistent and automatically theme-aware in light/dark, so new diagrams should reuse these classes rather than inventing new colors/styles per page.
- `.d-actor-box` rects take an optional `data-role` attribute — `client`, `compute`, `routing`, `cache`, or `datastore` — that tints the box's fill/stroke by kind, reusing the same four identity colors as the sidebar's module groups. Every box still carries its own text label (color is a supplementary cue, not the only one), so add a role where it's obvious from context, but don't force one onto a box that doesn't cleanly fit any of the five.
- **Important Markdown gotcha:** a diagram's `<div class="diagram-wrap">...</div>` block must not contain any blank line anywhere inside it (including inside the `<svg>`). CommonMark only passes raw HTML through untouched up to the first blank line — a blank line partway through breaks the SVG's structure and it renders as garbled stacked text instead of shapes. Always include explicit `width`/`height` attributes on `<svg>` matching its `viewBox`, too.

### Case study structure

Every case study under `content/case-studies/` follows the same two-level tab structure, covering the full design process end to end — not just one architecture diagram:

1. **Requirements** — functional requirements, non-functional requirements (with target numbers), and explicit in/out of scope.
2. **Scale Estimates** — back-of-envelope QPS, storage, and bandwidth math, worked out from stated assumptions.
3. **API Design** — the actual endpoints, request/response shapes, and status codes.
4. **Data Model** — schema, chosen storage type, and why.
5. **Architecture** — the system built up in stages, from minimal to production-scale. Each stage gets its own sub-tab and clickable, click-to-fail diagrams.
6. **Deep Dives** — optional, focused explorations of one hard sub-problem (e.g., short-code generation strategies).
7. **Bottlenecks & Trade-offs** — where this design still strains, and what you'd give up to fix it.
8. **Security & Abuse Prevention** — the attack surface specific to this system and how the design accounts for it.
9. **Monitoring & Operations** — what you'd alert on, and what a runbook looks like when a component fails.

Each top-level section is marked with an HTML comment, parsed client-side the same way stage markers are:

```
<!-- tab:requirements:Requirements -->
```

The `id` (`requirements`) must be unique within the page; the label (`Requirements`) is what renders on the tab. Content before the first `tab:` marker (typically a one- or two-sentence framing of the problem) renders above the tab strip, outside any tab. Inside the **Architecture** tab, stages are marked exactly as documented above (`<!-- stage:1:Minimal System -->`) — this is the same mechanism nested one level deeper, so the Architecture tab shows its own stage sub-tabs.

## Status

Content is being added incrementally, module by module. `content/manifest.json` is the source of truth for what currently exists.
