(function () {
  "use strict";

  const CONTENT_ROOT = "content/";
  const PROGRESS_KEY = "sd-progress-v1";
  const TRACKING_KEY = "sd-track-progress-v1";

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

  function buildSidebar(modules) {
    navTreeEl.innerHTML = "";
    modules.forEach((mod) => {
      const group = document.createElement("div");
      group.className = "nav-group";

      const heading = document.createElement("div");
      heading.className = "nav-group-title";
      heading.textContent = mod.title;
      group.appendChild(heading);

      const list = document.createElement("ul");
      list.className = "nav-list";

      mod.sections.forEach((sec) => {
        list.appendChild(buildNavItem(sec, false));

        (sec.branches || []).forEach((branch) => {
          list.appendChild(buildNavItem(branch, true));
        });
      });

      group.appendChild(list);
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

    document.title = `${sec.title} · System Design, Learned`;
    contentEl.focus();
    contentEl.scrollTop = 0;
    window.scrollTo(0, 0);

    setActiveNav(id);
    closeSidebarOnMobile();
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
