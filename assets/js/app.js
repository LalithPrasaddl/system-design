(function () {
  "use strict";

  const CONTENT_ROOT = "content/";
  const PROGRESS_KEY = "sd-progress-v1";
  const TRACKING_KEY = "sd-track-progress-v1";
  const NAV_COLLAPSE_KEY = "sd-nav-collapsed-v1";

  const contentEl = document.getElementById("content");
  const navTreeEl = document.getElementById("nav-tree");
  const progressSummaryEl = document.getElementById("progress-summary");
  const sidebarEl = document.getElementById("sidebar");
  const sidebarToggle = document.getElementById("sidebar-toggle");
  const sidebarScrim = document.getElementById("sidebar-scrim");
  const trackingToggleInput = document.getElementById("tracking-toggle-input");

  /** @type {{modules: Array}} */
  let manifest = null;
  /** Flat ordered list of {id, title, file, moduleTitle, isBranch} for prev/next + lookup */
  let flatSections = [];
  /** Map id -> section entry */
  let sectionsById = new Map();

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

  function isComplete(id) {
    return !!loadProgress()[id];
  }

  function setComplete(id, value) {
    const progress = loadProgress();
    if (value) {
      progress[id] = true;
    } else {
      delete progress[id];
    }
    saveProgress(progress);
    renderProgressSummary();
    updateNavCompletionMarks();
  }

  function isTrackingEnabled() {
    return localStorage.getItem(TRACKING_KEY) === "1";
  }

  function setTrackingEnabled(value) {
    localStorage.setItem(TRACKING_KEY, value ? "1" : "0");
    document.body.classList.toggle("tracking-on", value);
  }

  function renderProgressSummary() {
    const total = flatSections.length;
    const done = flatSections.filter((s) => isComplete(s.id)).length;
    progressSummaryEl.textContent = total ? `${done} / ${total} complete` : "";
  }

  function updateNavCompletionMarks() {
    navTreeEl.querySelectorAll("[data-section-id]").forEach((el) => {
      const id = el.getAttribute("data-section-id");
      el.classList.toggle("is-complete", isComplete(id));
    });
  }

  function flattenSections(modules) {
    const flat = [];
    modules.forEach((mod) => {
      mod.sections.forEach((sec) => {
        flat.push({ ...sec, moduleTitle: mod.title, isBranch: false });
        (sec.branches || []).forEach((branch) => {
          flat.push({ ...branch, moduleTitle: mod.title, isBranch: true, parentId: sec.id });
        });
      });
    });
    return flat;
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

  function buildSidebar(modules) {
    navTreeEl.innerHTML = "";
    const stored = loadCollapsedGroups();
    const currentHash = window.location.hash.replace(/^#\/?/, "");
    const activeModuleId = moduleIdForSection(modules, currentHash) || (modules[0] && modules[0].id);

    modules.forEach((mod) => {
      const group = document.createElement("div");
      group.className = "nav-group";
      group.setAttribute("data-module-id", mod.id);

      const isCollapsed = Object.prototype.hasOwnProperty.call(stored, mod.id)
        ? stored[mod.id]
        : mod.id !== activeModuleId;
      group.classList.toggle("is-collapsed", isCollapsed);

      const heading = document.createElement("button");
      heading.type = "button";
      heading.className = "nav-group-title";
      heading.setAttribute("aria-expanded", String(!isCollapsed));
      heading.setAttribute("aria-controls", `nav-list-${mod.id}`);

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
        setGroupCollapsed(group, heading, mod.id, !group.classList.contains("is-collapsed"));
      });

      group.appendChild(heading);

      const listWrap = document.createElement("div");
      listWrap.className = "nav-list-wrap";
      listWrap.id = `nav-list-${mod.id}`;

      const list = document.createElement("ul");
      list.className = "nav-list";

      mod.sections.forEach((sec) => {
        list.appendChild(buildNavItem(sec, false));

        (sec.branches || []).forEach((branch) => {
          list.appendChild(buildNavItem(branch, true));
        });
      });

      listWrap.appendChild(list);
      group.appendChild(listWrap);
      navTreeEl.appendChild(group);
    });
  }

  function buildNavItem(sec, isBranch) {
    const li = document.createElement("li");
    li.className = "nav-item" + (isBranch ? " nav-item-branch" : "");
    li.setAttribute("data-section-id", sec.id);

    const link = document.createElement("a");
    link.href = `#/${sec.id}`;
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

  function setActiveNav(id) {
    navTreeEl.querySelectorAll(".nav-item").forEach((el) => {
      el.classList.toggle("is-active", el.getAttribute("data-section-id") === id);
    });

    const activeItem = navTreeEl.querySelector(`.nav-item[data-section-id="${id}"]`);
    const group = activeItem && activeItem.closest(".nav-group");
    if (group && group.classList.contains("is-collapsed")) {
      const heading = group.querySelector(".nav-group-title");
      const moduleId = group.getAttribute("data-module-id");
      setGroupCollapsed(group, heading, moduleId, false);
    }
  }

  function renderNotFound() {
    contentEl.innerHTML = `
      <div class="page">
        <h1>Page not found</h1>
        <p>That section doesn't exist. <a href="#/${flatSections[0] ? flatSections[0].id : ""}">Go to the start</a>.</p>
      </div>`;
  }

  async function renderSection(id) {
    const sec = sectionsById.get(id);
    if (!sec) {
      renderNotFound();
      return;
    }

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
    const idx = flatSections.findIndex((s) => s.id === id);
    const prev = idx > 0 ? flatSections[idx - 1] : null;
    const next = idx >= 0 && idx < flatSections.length - 1 ? flatSections[idx + 1] : null;

    contentEl.innerHTML = `
      <article class="page">
        <div class="eyebrow">${escapeHtml(sec.moduleTitle)}${sec.isBranch ? " · Deep Dive" : ""}</div>
        ${html}
        <div class="complete-row">
          <label class="complete-toggle">
            <input type="checkbox" id="mark-complete" ${isComplete(id) ? "checked" : ""} />
            Mark as complete
          </label>
        </div>
        <nav class="page-nav">
          ${prev ? `<a class="page-nav-link prev" href="#/${prev.id}">← ${escapeHtml(prev.title)}</a>` : "<span></span>"}
          ${next ? `<a class="page-nav-link next" href="#/${next.id}">${escapeHtml(next.title)} →</a>` : "<span></span>"}
        </nav>
        <div class="ai-note">Drafted with AI assistance and reviewed for accuracy to the best of our knowledge — not a citation-grade source. <a href="#/about-this-content">How this content is made →</a></div>
      </article>`;

    document.getElementById("mark-complete").addEventListener("change", (e) => {
      setComplete(id, e.target.checked);
    });

    initCaseStudyTabs(contentEl);
    initCaseStudyStages(contentEl);
    initFailToggles(contentEl);

    document.title = `${sec.title} · System Design, Learned`;
    contentEl.focus();
    contentEl.scrollTop = 0;
    window.scrollTo(0, 0);

    setActiveNav(id);
    closeSidebarOnMobile();
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

  function handleRoute() {
    const hash = window.location.hash.replace(/^#\/?/, "");
    if (!hash) {
      if (flatSections.length) {
        window.location.replace(`#/${flatSections[0].id}`);
      }
      return;
    }
    renderSection(hash);
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

    flatSections = flattenSections(manifest.modules);
    sectionsById = new Map(flatSections.map((s) => [s.id, s]));

    buildSidebar(manifest.modules);
    renderProgressSummary();
    updateNavCompletionMarks();

    window.addEventListener("hashchange", handleRoute);
    handleRoute();
  }

  init();
})();
