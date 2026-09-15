(function () {
  "use strict";

  const CONTENT_ROOT = "content/";
  const PROGRESS_KEY = "sd-progress-v1";
  const PROGRESS_MIGRATED_KEY = "sd-progress-tracks-migrated-v1";
  const TRACKING_KEY = "sd-track-progress-v1";
  const NAV_COLLAPSE_KEY = "sd-nav-collapsed-v1";

  const contentEl = document.getElementById("content");
  const navTreeEl = document.getElementById("nav-tree");
  const trackNameEl = document.getElementById("track-name");
  const progressSummaryEl = document.getElementById("progress-summary");
  const sidebarEl = document.getElementById("sidebar");
  const sidebarToggle = document.getElementById("sidebar-toggle");
  const sidebarScrim = document.getElementById("sidebar-scrim");
  const trackingToggleInput = document.getElementById("tracking-toggle-input");
  const searchTrigger = document.getElementById("search-trigger");
  const searchTriggerKbd = document.getElementById("search-trigger-kbd");
  const searchOverlay = document.getElementById("search-overlay");
  const searchInput = document.getElementById("search-input");
  const searchClose = document.getElementById("search-close");
  const searchResultsEl = document.getElementById("search-results");

  /** @type {{siteTitle: string, tagline: string, tracks: Array}} */
  let manifest = null;
  /**
   * Published tracks only. An unpublished track keeps all of its content in
   * the repo but is invisible to the hub, the nav, and the search index —
   * unpublishing is one boolean in the manifest, not a deletion.
   */
  let tracks = [];
  /** Map track id -> track */
  let tracksById = new Map();
  /** Track currently being read; null while the hub is showing */
  let currentTrackId = null;
  /** Map track id -> flat ordered list of sections (prev/next runs inside a track) */
  let sectionsByTrack = new Map();
  /** Map "<trackId>/<sectionId>" -> section entry */
  let sectionsByPath = new Map();
  /** Map bare "<sectionId>" -> section entry, for links written before tracks existed */
  let sectionsByLegacyId = new Map();
  /** Every section across every published track, in track order */
  let allSections = [];
  /**
   * Site-level pages belong to the whole site rather than to any one track,
   * so they live outside the track tree: no sidebar, no progress checkbox,
   * no place in a prev/next chain. They route off a bare "#/<id>".
   */
  let sitePagesById = new Map();
  /** Lazily-built full-text search index: [{path, title, moduleTitle, trackTitle, isBranch, text, textLower}] */
  let searchIndex = null;
  let searchIndexPromise = null;
  let searchResults = [];
  let searchSelectedIndex = -1;

  function loadProgress() {
    try {
      return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function saveProgress(progress) {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  }

  function isComplete(path) {
    return !!loadProgress()[path];
  }

  function setComplete(path, value) {
    const progress = loadProgress();
    if (value) {
      progress[path] = true;
    } else {
      delete progress[path];
    }
    saveProgress(progress);
    renderProgressSummary();
    updateNavCompletionMarks();
  }

  /**
   * Progress used to be keyed by bare section id, which stops being unique
   * once tracks can each have their own "caching" or "transformers". Rewrite
   * the stored keys to "<track>/<section>" once, so nobody loses the pages
   * they had already marked read.
   */
  function migrateProgressKeys() {
    if (localStorage.getItem(PROGRESS_MIGRATED_KEY) === "1") return;
    const progress = loadProgress();
    let changed = false;
    Object.keys(progress).forEach((key) => {
      if (key.indexOf("/") !== -1) return;
      const sec = sectionsByLegacyId.get(key);
      if (!sec) return;
      progress[sec.path] = true;
      delete progress[key];
      changed = true;
    });
    if (changed) saveProgress(progress);
    localStorage.setItem(PROGRESS_MIGRATED_KEY, "1");
  }

  function isTrackingEnabled() {
    return localStorage.getItem(TRACKING_KEY) === "1";
  }

  function setTrackingEnabled(value) {
    localStorage.setItem(TRACKING_KEY, value ? "1" : "0");
    document.body.classList.toggle("tracking-on", value);
  }

  function renderProgressSummary() {
    const flat = sectionsByTrack.get(currentTrackId) || [];
    const total = flat.length;
    const done = flat.filter((s) => isComplete(s.path)).length;
    progressSummaryEl.textContent = total ? `${done} / ${total} complete` : "";
  }

  function updateNavCompletionMarks() {
    navTreeEl.querySelectorAll("[data-section-id]").forEach((el) => {
      const id = el.getAttribute("data-section-id");
      el.classList.toggle("is-complete", isComplete(id));
    });
  }

  function decorateSection(sec, mod, track, isBranch) {
    return {
      ...sec,
      moduleTitle: mod.title,
      trackId: track.id,
      trackTitle: track.title,
      path: `${track.id}/${sec.id}`,
      isBranch,
    };
  }

  function flattenTrack(track) {
    const flat = [];
    track.modules.forEach((mod) => {
      mod.sections.forEach((sec) => {
        flat.push(decorateSection(sec, mod, track, false));
        (sec.branches || []).forEach((branch) => {
          flat.push({ ...decorateSection(branch, mod, track, true), parentId: sec.id });
        });
      });
    });
    return flat;
  }

  function stripModuleNumber(title) {
    return title.replace(/^\d+\.\s*/, "");
  }

  /** Resolve a bare id to its canonical href — site page or track section. */
  function hrefForSectionId(id) {
    if (sitePagesById.has(id)) return `#/${id}`;
    const sec = sectionsByLegacyId.get(id);
    return sec ? `#/${sec.path}` : "#/";
  }

  function loadCollapsedGroups() {
    try {
      return JSON.parse(localStorage.getItem(NAV_COLLAPSE_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function saveCollapsedGroups(state) {
    localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify(state));
  }

  function moduleIdForSection(modules, sectionId) {
    for (const mod of modules) {
      const found = mod.sections.some(
        (s) => s.id === sectionId || (s.branches || []).some((b) => b.id === sectionId)
      );
      if (found) return mod.id;
    }
    return null;
  }

  function setGroupCollapsed(group, heading, moduleId, collapsed) {
    group.classList.toggle("is-collapsed", collapsed);
    heading.setAttribute("aria-expanded", String(!collapsed));
    const state = loadCollapsedGroups();
    state[moduleId] = collapsed;
    saveCollapsedGroups(state);
  }

  function buildSidebar(track, activeSectionId) {
    navTreeEl.innerHTML = "";
    trackNameEl.textContent = track.title;
    const modules = track.modules;
    const stored = loadCollapsedGroups();
    const activeModuleId = moduleIdForSection(modules, activeSectionId) || (modules[0] && modules[0].id);

    modules.forEach((mod) => {
      // Module ids only have to be unique inside their own track, so the
      // collapse state is namespaced by track.
      const groupKey = `${track.id}/${mod.id}`;

      const group = document.createElement("div");
      group.className = "nav-group";
      group.setAttribute("data-module-id", groupKey);

      const isCollapsed = Object.prototype.hasOwnProperty.call(stored, groupKey)
        ? stored[groupKey]
        : mod.id !== activeModuleId;
      group.classList.toggle("is-collapsed", isCollapsed);

      const heading = document.createElement("button");
      heading.type = "button";
      heading.className = "nav-group-title";
      heading.setAttribute("aria-expanded", String(!isCollapsed));
      heading.setAttribute("aria-controls", `nav-list-${track.id}-${mod.id}`);

      const label = document.createElement("span");
      label.className = "nav-group-title-text";
      label.textContent = mod.title;
      heading.appendChild(label);

      const chevron = document.createElement("span");
      chevron.className = "nav-group-chevron";
      chevron.setAttribute("aria-hidden", "true");
      chevron.textContent = "▾";
      heading.appendChild(chevron);

      heading.addEventListener("click", () => {
        setGroupCollapsed(group, heading, groupKey, !group.classList.contains("is-collapsed"));
      });

      group.appendChild(heading);

      const listWrap = document.createElement("div");
      listWrap.className = "nav-list-wrap";
      listWrap.id = `nav-list-${track.id}-${mod.id}`;

      const list = document.createElement("ul");
      list.className = "nav-list";

      mod.sections.forEach((sec) => {
        list.appendChild(buildNavItem(sec, track.id, false));

        (sec.branches || []).forEach((branch) => {
          list.appendChild(buildNavItem(branch, track.id, true));
        });
      });

      listWrap.appendChild(list);
      group.appendChild(listWrap);
      navTreeEl.appendChild(group);
    });
  }

  function buildNavItem(sec, trackId, isBranch) {
    const path = `${trackId}/${sec.id}`;
    const li = document.createElement("li");
    li.className = "nav-item" + (isBranch ? " nav-item-branch" : "");
    li.setAttribute("data-section-id", path);

    const link = document.createElement("a");
    link.href = `#/${path}`;
    link.className = "nav-link";

    const check = document.createElement("span");
    check.className = "nav-check";
    check.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.textContent = sec.title;

    link.appendChild(check);
    link.appendChild(label);

    if (isBranch) {
      const badge = document.createElement("span");
      badge.className = "nav-optional-badge";
      badge.textContent = "Optional";
      link.appendChild(badge);
    }

    li.appendChild(link);
    return li;
  }

  function setActiveNav(path) {
    navTreeEl.querySelectorAll(".nav-item").forEach((el) => {
      el.classList.toggle("is-active", el.getAttribute("data-section-id") === path);
    });

    const activeItem = navTreeEl.querySelector(`.nav-item[data-section-id="${path}"]`);
    const group = activeItem && activeItem.closest(".nav-group");
    if (group && group.classList.contains("is-collapsed")) {
      const heading = group.querySelector(".nav-group-title");
      const moduleId = group.getAttribute("data-module-id");
      setGroupCollapsed(group, heading, moduleId, false);
    }
  }

  function renderNotFound() {
    document.body.classList.remove("hub-view");
    contentEl.innerHTML = `
      <div class="page">
        <h1>Page not found</h1>
        <p>That page doesn't exist. <a href="#/">Back to all tracks</a>.</p>
      </div>`;
  }

  async function renderSection(path) {
    const sec = sectionsByPath.get(path);
    if (!sec) {
      renderNotFound();
      return;
    }

    const track = tracksById.get(sec.trackId);
    if (sec.trackId !== currentTrackId) {
      currentTrackId = sec.trackId;
      buildSidebar(track, sec.id);
      renderProgressSummary();
    }
    document.body.classList.remove("hub-view");

    contentEl.innerHTML = '<div class="loading">Loading…</div>';

    let markdown;
    try {
      const res = await fetch(CONTENT_ROOT + sec.file, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      markdown = await res.text();
    } catch (err) {
      contentEl.innerHTML = `
        <div class="page">
          <h1>Couldn't load this page</h1>
          <p>There was a problem fetching <code>${sec.file}</code>. (${err.message})</p>
        </div>`;
      return;
    }

    const html = window.marked.parse(markdown);
    // Prev/next walks the current track only — the last AI page should not
    // hand the reader off to the first Electronics page.
    const flat = sectionsByTrack.get(sec.trackId) || [];
    const idx = flat.findIndex((s) => s.path === path);
    const prev = idx > 0 ? flat[idx - 1] : null;
    const next = idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null;

    contentEl.innerHTML = `
      <article class="page">
        <div class="eyebrow">${escapeHtml(sec.trackTitle)} · ${escapeHtml(stripModuleNumber(sec.moduleTitle))}${sec.isBranch ? " · Deep Dive" : ""}</div>
        ${html}
        <div class="complete-row">
          <label class="complete-toggle">
            <input type="checkbox" id="mark-complete" ${isComplete(path) ? "checked" : ""} />
            Mark as complete
          </label>
        </div>
        <nav class="page-nav">
          ${prev ? `<a class="page-nav-link prev" href="#/${prev.path}">← ${escapeHtml(prev.title)}</a>` : "<span></span>"}
          ${next ? `<a class="page-nav-link next" href="#/${next.path}">${escapeHtml(next.title)} →</a>` : "<span></span>"}
        </nav>
        <div class="ai-note">Drafted with AI assistance and reviewed for accuracy to the best of our knowledge — not a citation-grade source. <a href="${hrefForSectionId("about-this-content")}">How this content is made →</a></div>
      </article>`;

    document.getElementById("mark-complete").addEventListener("change", (e) => {
      setComplete(path, e.target.checked);
    });

    initCaseStudyTabs(contentEl);
    initCaseStudyStages(contentEl);
    initFailToggles(contentEl);

    document.title = `${sec.title} · ${track.title} · ${manifest.siteTitle}`;
    contentEl.focus();
    contentEl.scrollTop = 0;
    window.scrollTo(0, 0);

    setActiveNav(path);
    updateNavCompletionMarks();
    closeSidebarOnMobile();
  }

  /**
   * A site page renders in the hub's chrome-free layout — it is deliberately
   * not in any track's sidebar, because it describes the whole site.
   */
  async function renderSitePage(id) {
    const page = sitePagesById.get(id);
    if (!page) {
      renderNotFound();
      return;
    }

    currentTrackId = null;
    document.body.classList.add("hub-view");
    closeSidebar();
    navTreeEl.innerHTML = "";
    trackNameEl.textContent = "";
    progressSummaryEl.textContent = "";

    contentEl.innerHTML = '<div class="loading">Loading…</div>';

    let markdown;
    try {
      const res = await fetch(CONTENT_ROOT + page.file, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      markdown = await res.text();
    } catch (err) {
      contentEl.innerHTML = `
        <div class="page">
          <h1>Couldn't load this page</h1>
          <p>There was a problem fetching <code>${page.file}</code>. (${err.message})</p>
        </div>`;
      return;
    }

    contentEl.innerHTML = `
      <article class="page site-page">
        <a class="site-page-back" href="#/">← All tracks</a>
        ${window.marked.parse(markdown)}
      </article>`;

    document.title = `${page.title} · ${manifest.siteTitle}`;
    contentEl.focus();
    contentEl.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  /**
   * The hub is the site's front door: one card per published track. Adding a
   * domain is a new track in the manifest; retiring one is `published: false`,
   * which takes it off the hub, the nav and the search index while leaving
   * every markdown file exactly where it is.
   */
  function renderHub() {
    currentTrackId = null;
    document.body.classList.add("hub-view");
    closeSidebar();
    navTreeEl.innerHTML = "";
    trackNameEl.textContent = "";
    progressSummaryEl.textContent = "";

    const cards = tracks
      .map((track) => {
        const flat = sectionsByTrack.get(track.id) || [];
        const done = flat.filter((s) => isComplete(s.path)).length;
        const first = flat[0];
        const modules = track.modules
          .map((mod) => `<li>${escapeHtml(stripModuleNumber(mod.title))}</li>`)
          .join("");
        return `
          <a class="track-card" href="${first ? `#/${first.path}` : "#/"}">
            <h2 class="track-card-title">${escapeHtml(track.title)}</h2>
            <p class="track-card-blurb">${escapeHtml(track.blurb || "")}</p>
            <ul class="track-card-modules">${modules}</ul>
            <div class="track-card-foot">
              <span>${flat.length} ${flat.length === 1 ? "page" : "pages"}</span>
              <span class="track-card-progress">${done} read</span>
              <span class="track-card-go" aria-hidden="true">→</span>
            </div>
          </a>`;
      })
      .join("");

    contentEl.innerHTML = `
      <div class="hub">
        <header class="hub-header">
          <h1>${escapeHtml(manifest.siteTitle)}</h1>
          <p class="hub-tagline">${escapeHtml(manifest.tagline || "")}</p>
        </header>
        <div class="hub-grid">${cards}</div>
        <p class="hub-foot">
          <a href="${hrefForSectionId("about-this-content")}">How this content is made →</a>
        </p>
      </div>`;

    document.title = manifest.siteTitle;
    contentEl.focus();
    contentEl.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  /**
   * Case studies mark top-level design-process sections in their markdown
   * with HTML comments:
   *   <!-- tab:requirements:Requirements -->
   * Same mechanism as the stage tabs below, one level up: everything
   * between one marker and the next becomes a `.case-study-tab` panel, and
   * a top-level tab strip switches between them. The Architecture panel
   * contains its own nested stage markers, parsed separately by
   * initCaseStudyStages below.
   */
  function initCaseStudyTabs(container) {
    const markerRe = /^\s*tab:([a-z0-9-]+):(.+?)\s*$/;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_COMMENT);
    const markers = [];
    let node;
    while ((node = walker.nextNode())) {
      const m = node.nodeValue.match(markerRe);
      if (m) markers.push({ comment: node, tabId: m[1], label: m[2] });
    }
    if (!markers.length) return;

    markers.forEach((marker, i) => {
      const wrapper = document.createElement("div");
      wrapper.className = "case-study-tab" + (i === 0 ? "" : " is-hidden");
      wrapper.setAttribute("data-tab", marker.tabId);

      const startNode = marker.comment;
      const endNode = i + 1 < markers.length ? markers[i + 1].comment : null;
      const parent = startNode.parentNode;
      parent.insertBefore(wrapper, startNode);

      let cur = startNode;
      while (cur && cur !== endNode) {
        const next = cur.nextSibling;
        wrapper.appendChild(cur);
        cur = next;
      }
    });

    const tabWrappers = Array.from(container.querySelectorAll(".case-study-tab"));
    const tabBar = document.createElement("div");
    tabBar.className = "case-study-tabs";
    tabBar.setAttribute("role", "tablist");

    markers.forEach((marker, i) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "case-study-tab-btn" + (i === 0 ? " is-active" : "");
      tab.textContent = marker.label;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", i === 0 ? "true" : "false");
      tab.addEventListener("click", () => {
        tabWrappers.forEach((w, wi) => w.classList.toggle("is-hidden", wi !== i));
        tabBar.querySelectorAll(".case-study-tab-btn").forEach((b, bi) => {
          b.classList.toggle("is-active", bi === i);
          b.setAttribute("aria-selected", bi === i ? "true" : "false");
        });
      });
      tabBar.appendChild(tab);
    });

    tabWrappers[0].parentNode.insertBefore(tabBar, tabWrappers[0]);
  }

  /**
   * Case studies mark stage boundaries in their markdown with HTML comments:
   *   <!-- stage:1:Minimal System -->
   * CommonMark passes these through as literal comment nodes, so after the
   * markdown is rendered we walk the DOM, group everything between one
   * marker and the next into a `.case-study-stage` wrapper, and build a
   * tab strip that shows one stage at a time.
   */
  function initCaseStudyStages(container) {
    const markerRe = /^\s*stage:(\d+):(.+?)\s*$/;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_COMMENT);
    const markers = [];
    let node;
    while ((node = walker.nextNode())) {
      const m = node.nodeValue.match(markerRe);
      if (m) markers.push({ comment: node, stage: m[1], label: m[2] });
    }
    if (!markers.length) return;

    markers.forEach((marker, i) => {
      const wrapper = document.createElement("div");
      wrapper.className = "case-study-stage" + (i === 0 ? "" : " is-hidden");
      wrapper.setAttribute("data-stage", marker.stage);

      const startNode = marker.comment;
      const endNode = i + 1 < markers.length ? markers[i + 1].comment : null;
      const parent = startNode.parentNode;
      parent.insertBefore(wrapper, startNode);

      let cur = startNode;
      while (cur && cur !== endNode) {
        const next = cur.nextSibling;
        wrapper.appendChild(cur);
        cur = next;
      }
    });

    const stageWrappers = Array.from(container.querySelectorAll(".case-study-stage"));
    const tabBar = document.createElement("div");
    tabBar.className = "stage-tabs";
    tabBar.setAttribute("role", "tablist");

    markers.forEach((marker, i) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "stage-tab" + (i === 0 ? " is-active" : "");
      tab.textContent = marker.label;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", i === 0 ? "true" : "false");
      tab.addEventListener("click", () => {
        stageWrappers.forEach((w, wi) => w.classList.toggle("is-hidden", wi !== i));
        tabBar.querySelectorAll(".stage-tab").forEach((b, bi) => {
          b.classList.toggle("is-active", bi === i);
          b.setAttribute("aria-selected", bi === i ? "true" : "false");
        });
      });
      tabBar.appendChild(tab);
    });

    stageWrappers[0].parentNode.insertBefore(tabBar, stageWrappers[0]);
  }

  /**
   * Diagram components marked `data-fail-toggle="id"` become clickable.
   * Clicking toggles a `.is-failed` state on the component and reveals a
   * matching `.failure-impact[data-component="id"]` panel explaining what
   * breaks. Any connector marked `data-depends-on="id"` gets a degraded
   * (dashed/red) style while that component is failed.
   */
  function initFailToggles(container) {
    container.querySelectorAll("[data-fail-toggle]").forEach((el) => {
      el.addEventListener("click", () => {
        const componentId = el.getAttribute("data-fail-toggle");
        const failed = el.classList.toggle("is-failed");

        const impact = container.querySelector(`.failure-impact[data-component="${componentId}"]`);
        if (impact) impact.classList.toggle("is-hidden", !failed);

        container.querySelectorAll(`[data-depends-on~="${componentId}"]`).forEach((line) => {
          line.classList.toggle("is-degraded", failed);
        });
      });
    });
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  /**
   * Search is a lazily-built, client-side full-text index — there's no
   * server and no build step, so the first time search opens, every
   * section's raw markdown is fetched once, stripped to plain text, and
   * kept in memory for the rest of the session. Small enough corpus that
   * this costs nothing noticeable, and it never goes stale since it's
   * built from the same files the site already serves.
   */
  function stripMarkdownToText(md) {
    return md
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[#>*_`~|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function ensureSearchIndex() {
    if (searchIndexPromise) return searchIndexPromise;
    if (!allSections.length) return Promise.resolve([]);
    // allSections only holds published tracks, so an unpublished track never
    // leaks into results.
    searchIndexPromise = Promise.all(
      allSections.concat(sitePageEntries()).map((sec) =>
        fetch(CONTENT_ROOT + sec.file, { cache: "no-cache" })
          .then((res) => (res.ok ? res.text() : ""))
          .catch(() => "")
          .then((raw) => {
            const text = stripMarkdownToText(raw);
            return {
              path: sec.path,
              title: sec.title,
              moduleTitle: sec.moduleTitle,
              trackId: sec.trackId,
              trackTitle: sec.trackTitle,
              isBranch: sec.isBranch,
              text,
              textLower: text.toLowerCase(),
            };
          })
      )
    ).then((entries) => {
      searchIndex = entries;
      return entries;
    });
    return searchIndexPromise;
  }

  /** Site pages are searchable too, just without a track to belong to. */
  function sitePageEntries() {
    return Array.from(sitePagesById.values()).map((page) => ({
      ...page,
      path: page.id,
      moduleTitle: "About this site",
      trackId: null,
      trackTitle: null,
      isBranch: false,
    }));
  }

  function scoreEntry(entry, queryLower, queryWords) {
    const titleLower = entry.title.toLowerCase();
    let score = 0;
    if (titleLower === queryLower) score += 100;
    else if (titleLower.startsWith(queryLower)) score += 60;
    else if (titleLower.includes(queryLower)) score += 40;
    queryWords.forEach((w) => {
      if (titleLower.includes(w)) score += 8;
    });
    if (entry.textLower.includes(queryLower)) score += 12;
    queryWords.forEach((w) => {
      if (entry.textLower.includes(w)) score += 3;
    });
    // Search spans every track, but the track being read wins ties — the same
    // word can be a topic in two of them.
    if (entry.trackId === currentTrackId) score += 6;
    return score;
  }

  function extractSnippet(entry, queryLower, queryWords) {
    let idx = entry.textLower.indexOf(queryLower);
    if (idx === -1) {
      for (const w of queryWords) {
        idx = entry.textLower.indexOf(w);
        if (idx !== -1) break;
      }
    }
    if (idx === -1) {
      return entry.text.slice(0, 140) + (entry.text.length > 140 ? "…" : "");
    }
    const start = Math.max(0, idx - 60);
    const end = Math.min(entry.text.length, idx + 90);
    let snippet = entry.text.slice(start, end);
    if (start > 0) snippet = "…" + snippet;
    if (end < entry.text.length) snippet = snippet + "…";
    return snippet;
  }

  function runSearch(query) {
    const q = query.trim();
    if (!q || !searchIndex) return [];
    const queryLower = q.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter((w) => w.length >= 2);
    return searchIndex
      .map((entry) => ({ entry, score: scoreEntry(entry, queryLower, queryWords) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((r) => ({
        path: r.entry.path,
        title: r.entry.title,
        moduleTitle: r.entry.moduleTitle,
        trackTitle: r.entry.trackTitle,
        isBranch: r.entry.isBranch,
        snippet: extractSnippet(r.entry, queryLower, queryWords),
      }));
  }

  function searchResultMeta(r) {
    return [r.trackTitle, stripModuleNumber(r.moduleTitle), r.isBranch ? "Deep Dive" : null]
      .filter(Boolean)
      .join(" · ");
  }

  function renderSearchResults(results, query) {
    searchResults = results;
    searchSelectedIndex = results.length ? 0 : -1;

    if (!query.trim()) {
      searchResultsEl.innerHTML = '<div class="search-hint">Type to search across every page in every track.</div>';
      return;
    }
    if (!searchIndex) {
      searchResultsEl.innerHTML = '<div class="search-hint">Loading search index…</div>';
      return;
    }
    if (!results.length) {
      searchResultsEl.innerHTML = `<div class="search-hint">No results for "${escapeHtml(query)}".</div>`;
      return;
    }

    searchResultsEl.innerHTML = results
      .map(
        (r, i) => `
        <button type="button" class="search-result${i === 0 ? " is-selected" : ""}" data-index="${i}" role="option">
          <div class="search-result-title">${escapeHtml(r.title)}<span class="search-result-module">${escapeHtml(searchResultMeta(r))}</span></div>
          <div class="search-result-snippet">${escapeHtml(r.snippet)}</div>
        </button>`
      )
      .join("");
  }

  function moveSearchSelection(delta) {
    if (!searchResults.length) return;
    searchSelectedIndex = (searchSelectedIndex + delta + searchResults.length) % searchResults.length;
    searchResultsEl.querySelectorAll(".search-result").forEach((el, i) => {
      el.classList.toggle("is-selected", i === searchSelectedIndex);
    });
    const active = searchResultsEl.querySelector(".search-result.is-selected");
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function navigateToSearchResult(result) {
    closeSearch();
    window.location.hash = `#/${result.path}`;
  }

  function openSearch() {
    searchOverlay.classList.remove("is-hidden");
    document.body.classList.add("search-open");
    searchInput.value = "";
    searchResults = [];
    searchSelectedIndex = -1;
    renderSearchResults([], "");
    searchInput.focus();
    ensureSearchIndex().then(() => {
      renderSearchResults(runSearch(searchInput.value), searchInput.value);
    });
  }

  function closeSearch() {
    searchOverlay.classList.add("is-hidden");
    document.body.classList.remove("search-open");
  }

  function isSearchOpen() {
    return !searchOverlay.classList.contains("is-hidden");
  }

  searchTriggerKbd.textContent = /Mac|iPhone|iPod|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K";

  searchTrigger.addEventListener("click", openSearch);
  searchClose.addEventListener("click", closeSearch);
  searchOverlay.addEventListener("click", (e) => {
    if (e.target === searchOverlay) closeSearch();
  });
  searchInput.addEventListener("input", () => {
    renderSearchResults(runSearch(searchInput.value), searchInput.value);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSearchSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSearchSelection(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (searchSelectedIndex >= 0 && searchResults[searchSelectedIndex]) {
        navigateToSearchResult(searchResults[searchSelectedIndex]);
      }
    }
  });
  searchResultsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".search-result");
    if (!btn) return;
    const idx = Number(btn.getAttribute("data-index"));
    if (searchResults[idx]) navigateToSearchResult(searchResults[idx]);
  });
  document.addEventListener("keydown", (e) => {
    const isMod = e.metaKey || e.ctrlKey;
    if (isMod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      isSearchOpen() ? closeSearch() : openSearch();
    } else if (e.key === "Escape" && isSearchOpen()) {
      closeSearch();
    }
  });

  function handleRoute() {
    const hash = window.location.hash.replace(/^#\/?/, "").replace(/\/+$/, "");
    if (!hash) {
      renderHub();
      return;
    }

    // Site-level pages sit outside the tracks and keep a bare "#/<id>".
    if (sitePagesById.has(hash)) {
      renderSitePage(hash);
      return;
    }

    const parts = hash.split("/");

    // Canonical route: #/<track>/<section>
    if (parts.length >= 2 && sectionsByPath.has(`${parts[0]}/${parts[1]}`)) {
      renderSection(`${parts[0]}/${parts[1]}`);
      return;
    }

    if (parts.length === 1) {
      // #/<track> on its own opens that track at its first page.
      const trackFlat = sectionsByTrack.get(parts[0]);
      if (trackFlat && trackFlat.length) {
        window.location.replace(`#/${trackFlat[0].path}`);
        return;
      }
      // Links written before tracks existed were #/<section>. Rewrite them to
      // the canonical path so old bookmarks keep working.
      const legacy = sectionsByLegacyId.get(parts[0]);
      if (legacy) {
        window.location.replace(`#/${legacy.path}`);
        return;
      }
    }

    renderNotFound();
  }

  function openSidebar() {
    sidebarEl.classList.add("is-open");
    sidebarToggle.setAttribute("aria-expanded", "true");
  }
  function closeSidebar() {
    sidebarEl.classList.remove("is-open");
    sidebarToggle.setAttribute("aria-expanded", "false");
  }
  function closeSidebarOnMobile() {
    if (window.matchMedia("(max-width: 860px)").matches) closeSidebar();
  }

  sidebarToggle.addEventListener("click", () => {
    sidebarEl.classList.contains("is-open") ? closeSidebar() : openSidebar();
  });
  sidebarScrim.addEventListener("click", closeSidebar);

  async function init() {
    trackingToggleInput.checked = isTrackingEnabled();
    document.body.classList.toggle("tracking-on", trackingToggleInput.checked);
    trackingToggleInput.addEventListener("change", (e) => {
      setTrackingEnabled(e.target.checked);
    });

    try {
      const res = await fetch(CONTENT_ROOT + "manifest.json", { cache: "no-cache" });
      manifest = await res.json();
    } catch (err) {
      contentEl.innerHTML = `<div class="page"><h1>Failed to load course content</h1><p>${err.message}</p></div>`;
      return;
    }

    sitePagesById = new Map((manifest.pages || []).map((page) => [page.id, page]));
    tracks = (manifest.tracks || []).filter((t) => t.published !== false);
    tracksById = new Map(tracks.map((t) => [t.id, t]));
    sectionsByTrack = new Map();
    sectionsByPath = new Map();
    sectionsByLegacyId = new Map();
    allSections = [];

    tracks.forEach((track) => {
      const flat = flattenTrack(track);
      sectionsByTrack.set(track.id, flat);
      allSections = allSections.concat(flat);
      flat.forEach((sec) => {
        sectionsByPath.set(sec.path, sec);
        // First track to claim a bare id wins the legacy alias; every link
        // rendered by the app uses the full path, so this only ever serves
        // hand-written or bookmarked pre-track URLs.
        if (!sectionsByLegacyId.has(sec.id)) sectionsByLegacyId.set(sec.id, sec);
      });
    });

    migrateProgressKeys();

    window.addEventListener("hashchange", handleRoute);
    handleRoute();
  }

  init();
})();
