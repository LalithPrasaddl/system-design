# Designs, Learned

Interactive, textbook-depth material on how things are designed, split into independent **tracks**. Each track is its own self-contained path with its own modules, ordering, and progress; the site's front door is a hub that lists them. No prior experience assumed.

Current tracks — case studies are their own track alongside the track they draw on, so a reader can come straight in at the worked-system level without going through the building blocks first:

| Track | Status | Covers |
| --- | --- | --- |
| System Design | published | Client-server basics through the building blocks — caching, databases, replication, consensus, queues |
| System Design Case Studies | published | Whole systems built up in stages, from the smallest version that works to one that holds under scale |
| AI & LLMs | published | What language models do, and the systems around them — retrieval, tools, agents, serving |
| AI Case Studies | published | End-to-end AI systems, with evaluation treated as part of the architecture |
| Electronics | unpublished | Analog and digital hardware design |

## Stack

Plain HTML/CSS/JS. No framework, no build step, no server/backend.

- **Routing:** hash-based (`#/track-id/section-id`), handled client-side in `assets/js/app.js`. `#/` renders the track hub, and `#/page-id` a site-level page. A bare `#/section-id` — the URL shape used before tracks existed — still resolves and redirects itself to the canonical path, so old links and bookmarks keep working.
- **Content:** Markdown files under `content/`, fetched and rendered at runtime with `marked.js` (vendored locally in `assets/js/vendor/`, not loaded from a CDN).
- **Navigation:** driven entirely by `content/manifest.json` — the hub, the sidebar, section order, and prev/next links are all generated from it. The sidebar only ever shows the current track's modules, and prev/next never walks off the end of a track into the next one.
- **Progress tracking:** a "mark as complete" checkbox per page, stored in the visitor's `localStorage` keyed by `track-id/section-id`. The sidebar's completion count is per track. No account, no server, no cross-device sync.

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
  manifest.json             The site tree: tracks -> modules -> sections -> optional "branches"
  site/                      Site-level pages, owned by no track
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

Section ids must be unique **within their track**, and form the URL together with the track id (`#/my-track-id/my-section-id`). Reusing an id across two tracks is fine and expected — "transformers" means one thing in AI and another in electronics — but note that a bare `#/my-section-id` legacy link then resolves to whichever track declares it first in the manifest, so prefer full paths when linking between pages.

## Site-level pages

Some pages describe the whole site rather than a track — "How This Content Is Made" is the current one. Those live in a top-level `pages` array in the manifest, alongside `tracks` rather than inside one:

```json
"pages": [
  { "id": "about-this-content", "title": "How This Content Is Made", "file": "site/about-this-content.md" }
]
```

A site page routes off a bare `#/page-id`, renders without a sidebar, and has no progress checkbox and no prev/next — it belongs to no track's reading order. It is reachable from the hub footer and from the footer of every content page, and it is included in search. Put its markdown under `content/site/`.

## Adding or retiring a track

A track is a top-level entry in `manifest.json`:

```json
{
  "id": "electronics",
  "title": "Electronics",
  "blurb": "One sentence, shown on the hub card.",
  "published": true,
  "modules": [ ... ]
}
```

Set `"published": false` to retire one. It disappears from the hub, the sidebar, and the search index, but every markdown file stays exactly where it is and the track comes back by flipping the flag — retiring a track is never a deletion.

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
5. **Architecture** — the system built up in stages, from minimal to production-scale. Each stage gets its own sub-tab, an interactive flow player, and clickable, click-to-fail diagrams. This is the tab that opens first (see `:default` below) — it is the most useful thing on the page, and leading with it beats making readers find it.
6. **Deep Dives** — optional, focused explorations of one hard sub-problem (e.g., short-code generation strategies).
7. **Bottlenecks & Trade-offs** — where this design still strains, and what you'd give up to fix it.
8. **Security & Abuse Prevention** — the attack surface specific to this system and how the design accounts for it.
9. **Monitoring & Operations** — what you'd alert on, and what a runbook looks like when a component fails.

AI case studies live under `content/ai-case-studies/` and use the same structure with one addition: an **Evaluation** tab between Data Model and Architecture. It sits there because an AI system's eval strategy drives its architecture rather than following it — it occupies the slot "correctness" holds in a classic case study, and the stages that follow are justified by the numbers it defines. Cost per request is also folded into Scale Estimates as a first-class figure, since it is what decides model choice, caching, and how much work the expensive stage is allowed to do.

Each top-level section is marked with an HTML comment, parsed client-side the same way stage markers are:

```
<!-- tab:requirements:Requirements -->
```

The `id` (`requirements`) must be unique within the page; the label (`Requirements`) is what renders on the tab. Content before the first marker (typically a one- or two-sentence framing of the problem) renders above the tab strip, outside any tab. Inside the **Architecture** tab, stages are marked exactly as documented above (`<!-- stage:1:Minimal System -->`) — the same mechanism nested one level deeper, so Architecture shows its own stage sub-tabs.

A marker may end in `:default` to name the tab that opens first, regardless of where it sits in the strip:

```
<!-- tab:architecture:Architecture:default -->
```

Without one, the first tab opens. Tab order still follows the design process (requirements first), but the reader lands on the architecture, which is the part worth seeing immediately. At most one `:default` per page; if several are marked, the first wins.

### Flow players

A diagram marked `data-flow-player` becomes an interactive, narrated walkthrough. It carries a JSON spec naming its flows, and the player draws one step at a time along the real SVG connectors:

```
<div class="diagram-wrap" data-flow-player>
  <svg>… <line id="s2-app-cache" data-depends-on="app2 cache2" …> …</svg>
  <script type="application/json" class="flow-spec">
  {"state":[{"id":"cache","title":"Cache memory","rows":[["aX9dQ2z","(empty)"]]}],
   "flows":[{"id":"read-hit","label":"Follow a link — cache hit","nodes":["app2","cache2"],
     "steps":[{"el":"s2-app-cache","payload":"GET aX9dQ2z","ms":1,
               "set":{"cache.aX9dQ2z":"example.com/…"},
               "text":"App server checks the cache first."}]}]}
  </script>
</div>
```

Per step: `el` is the connector's `id`; `payload` is the labelled pill that rides along it; `ms` adds to the running latency readout; `text` is the caption; `set` writes into a state panel (`panelId.rowKey`). `altEl` (with optional `altText`, `altMs`, `altSet`) names a fallback connector to take when `el`'s component has been failed — that is how a load balancer routes around a dead app server instead of the flow simply stopping. A flow's `nodes` lists component ids to keep lit; everything else on the diagram dims while that flow is selected.

Connectors must carry `data-depends-on` for failure handling to work, and both `<line>` and `<path>` elements are supported. Latency numbers are server-side only by convention — client network round trips dominate every path and would bury the differences the diagram exists to show.

## Status

Content is being added incrementally, track by track and module by module. `content/manifest.json` is the source of truth for what currently exists and what is published.
