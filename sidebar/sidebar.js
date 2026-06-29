/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

const browser = globalThis.browser || globalThis.chrome;

/*
 * Sidebar UI. Each sidebar instance belongs to one window, so it can show
 * whether *this* window is tracked, and offer to start tracking it.
 *
 * Note: window.prompt()/confirm() are unreliable in sidebar documents, so
 * renaming and delete-confirmation are done inline.
 */

let currentWindowId = null;
let state = { sessions: [], options: {}, untrackedWindows: [] };

// Transient UI state that must survive re-renders.
let namingInProgress = false; // "track this window" name input is showing
let suggestedName = "";
let editingSessionId = null;  // session currently being renamed
let confirmingDeleteId = null;
let searchQuery = "";         // lowercased filter/search text from the header box
let dragSource = null;        // descriptor of the tab row currently being dragged
const expandedSessions = new Set(); // session ids with their tab list shown
const expandedWindows = new Set();  // untracked window ids with tabs shown
const collapsedSections = new Set(); // section keys (open/closed/untracked/results) hidden
// Per-render override of a tab group's collapsed state, keyed "sessionId:groupId".
// Absent means follow the group's saved collapsed flag.
const groupCollapseOverrides = new Map();

// Native tab-group colors mapped to swatch/accent values for the sidebar.
const GROUP_COLORS = {
  grey: "#8f8f9d",
  blue: "#4f8cff",
  red: "#e35e6b",
  yellow: "#f5c451",
  green: "#3fbf6f",
  pink: "#f06ccf",
  purple: "#a87ffb",
  cyan: "#46c5d6",
  orange: "#f59345",
};

const $ = (sel) => document.querySelector(sel);

function send(msg) {
  return browser.runtime.sendMessage(msg);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child);
  }
  return node;
}

/*
 * Inline stroke icons sharing one style so the whole panel matches: 24x24
 * viewBox, no fill, stroke = currentColor (set via the .icon CSS rule), so
 * each icon takes the color of its button. Paths adapted from Feather (MIT)
 * and Lucide (ISC). The header buttons embed the same markup directly in
 * sidebar.html.
 */
const ICON_PATHS = {
  edit: '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  trash:
    '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  chevronRight: '<polyline points="9 18 15 12 9 6"/>',
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  pin:
    '<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>',
};

const iconTemplates = new Map();

function icon(name) {
  // Parse each icon once via DOMParser (which avoids the innerHTML web-ext
  // warning) and cache the result; cloneNode per use is far cheaper than
  // re-parsing on every render. Source strings are static constants.
  let template = iconTemplates.get(name);
  if (!template) {
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
      'class="icon" aria-hidden="true">' +
      (ICON_PATHS[name] || "") +
      "</svg>";
    const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
    template = document.importNode(doc.documentElement, true);
    iconTemplates.set(name, template);
  }
  return template.cloneNode(true);
}

function relativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const days = Math.round(hr / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(ts).toLocaleDateString();
}

/* ---------------- search / filter ---------------- */

function matchesText(text) {
  return (
    typeof text === "string" &&
    text.toLowerCase().includes(searchQuery.toLowerCase())
  );
}

function tabMatches(t) {
  return matchesText(t.title) || matchesText(t.url);
}

// A session is kept by the filter when its name matches or any of its tabs do.
function sessionMatches(s) {
  return matchesText(s.name) || (s.tabs || []).some(tabMatches);
}

function untrackedMatches(w) {
  return matchesText(w.title) || (w.tabs || []).some(tabMatches);
}

/* ---------------- tab drag-and-drop ---------------- */

// Build the transfer descriptor handed to the background for a dragged tab.
// Open/closed session tabs reference their saved entry; untracked-window tabs
// carry the live tab id directly.
function sessionTabSource(s, t, i) {
  return {
    url: t.url,
    title: t.title,
    pinned: !!t.pinned,
    cookieStoreId: t.cookieStoreId,
    saved: { sessionId: s.id, tabIndex: i },
    live: null,
  };
}

function windowTabSource(w, t) {
  return {
    url: t.url,
    title: t.title,
    pinned: !!t.pinned,
    saved: null,
    live: { windowId: w.id, tabId: t.id },
  };
}

function makeTabDraggable(node, source) {
  node.setAttribute("draggable", "true");
  node.addEventListener("dragstart", (e) => {
    dragSource = source;
    node.classList.add("dragging");
    e.dataTransfer.effectAllowed = "copyMove";
    // Firefox requires data to be set for a drag to start.
    e.dataTransfer.setData("text/plain", source.url || "");
  });
  node.addEventListener("dragend", () => {
    dragSource = null;
    node.classList.remove("dragging");
    document
      .querySelectorAll(".drop-target")
      .forEach((n) => n.classList.remove("drop-target"));
  });
}

// Mark a session row as a drop target for tab transfers. Ctrl-drop copies;
// a plain drop moves.
function makeSessionDropTarget(row, sessionId) {
  row.addEventListener("dragover", (e) => {
    if (!dragSource) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
    row.classList.add("drop-target");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
  row.addEventListener("drop", (e) => {
    if (!dragSource) return;
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove("drop-target");
    send({
      type: "transferTab",
      source: dragSource,
      targetSessionId: sessionId,
      copy: e.ctrlKey,
    });
    dragSource = null;
  });
}

/* ---------------- current window card ---------------- */

function renderCurrentWindow() {
  const container = $("#current-window");
  container.textContent = "";
  container.append(el("div", { class: "label" }, "This window"));

  const mySession = state.sessions.find(
    (s) => s.open && s.windowId === currentWindowId
  );

  if (mySession) {
    container.append(
      el(
        "div",
        { class: "row" },
        el("span", { class: "dot", style: "background: var(--open)" }),
        el("strong", {}, mySession.name),
        el("span", { style: "flex:1" }),
        el(
          "button",
          {
            class: "secondary",
            title: "Stop tracking this window and remove the session. The window stays open.",
            onclick: () => send({ type: "untrackWindow", windowId: currentWindowId }),
          },
          "Stop tracking"
        )
      )
    );
    return;
  }

  if (!namingInProgress) {
    container.append(
      el(
        "div",
        { class: "row" },
        el("span", { class: "dot" }),
        el("span", { style: "color: var(--fg-dim)" }, "Not tracked"),
        el("span", { style: "flex:1" }),
        el(
          "button",
          { class: "primary", onclick: startNaming },
          "Track this window"
        )
      )
    );
    return;
  }

  // Name entry, prefilled with the Window Titler-derived suggestion if any.
  const input = el("input", {
    type: "text",
    placeholder: "Session name",
    value: suggestedName,
    onkeydown: (e) => {
      if (e.key === "Enter") confirmTrack(input.value);
      if (e.key === "Escape") cancelNaming();
    },
  });
  container.append(
    el(
      "div",
      { class: "row" },
      input,
      el("button", { class: "primary", onclick: () => confirmTrack(input.value) }, "Save"),
      el("button", { class: "secondary", onclick: cancelNaming }, icon("close"))
    )
  );
  input.focus();
  input.select();
}

async function startNaming() {
  suggestedName =
    (await send({ type: "getSuggestedName", windowId: currentWindowId })) || "";
  namingInProgress = true;
  renderCurrentWindow();
}

function cancelNaming() {
  namingInProgress = false;
  renderCurrentWindow();
}

async function confirmTrack(name) {
  namingInProgress = false;
  await send({
    type: "trackWindow",
    windowId: currentWindowId,
    name: name || "Untitled session",
  });
}

/* ---------------- session list ---------------- */

function renderSessions() {
  const container = $("#session-list");
  container.textContent = "";

  let open = state.sessions
    .filter((s) => s.open)
    .sort((a, b) => a.name.localeCompare(b.name));
  let closed = state.sessions
    .filter((s) => !s.open)
    .sort((a, b) => (b.lastSaved || 0) - (a.lastSaved || 0));
  // The current window is already represented by the "This window" card, so
  // keep it out of the Untracked list to avoid showing it twice.
  let untracked = (state.untrackedWindows || []).filter(
    (w) => w.id !== currentWindowId
  );

  if (!open.length && !closed.length && !untracked.length) {
    container.append(
      el(
        "div",
        { class: "empty" },
        "No sessions yet. Click “Track this window” above to start one."
      )
    );
    return;
  }

  // With a search active, surface individual matching tabs in their own
  // section and filter the session rows down to those that match by name or
  // by a contained tab.
  let results = [];
  if (searchQuery) {
    results = buildSearchResults(open, closed);
    open = open.filter(sessionMatches);
    closed = closed.filter(sessionMatches);
    untracked = untracked.filter(untrackedMatches);
    if (!open.length && !closed.length && !untracked.length && !results.length) {
      container.append(
        el("div", { class: "empty" }, `No matches for “${searchQuery}”.`)
      );
      return;
    }
  }

  renderSection(container, "open", "Open", open, renderSession);
  // Results sit below the Open list, spanning open and closed sessions alike.
  renderSection(container, "results", "Search results", results, renderSearchResult);
  renderSection(container, "closed", "Closed", closed, renderSession);
  renderSection(
    container,
    "untracked",
    "Untracked",
    untracked,
    renderUntrackedWindow
  );
}

// Flatten every matching tab across the given open + closed sessions into
// result rows, each remembering its parent session and saved index.
function buildSearchResults(open, closed) {
  const results = [];
  for (const s of [...open, ...closed]) {
    (s.tabs || []).forEach((t, i) => {
      if (tabMatches(t)) results.push({ session: s, tab: t, tabIndex: i });
    });
  }
  return results;
}

function renderSearchResult(r) {
  const row = el(
    "div",
    {
      class: "tab result",
      title: `${r.tab.url}\n${
        r.session.open
          ? "Click to focus this tab"
          : "Click to open this tab in the current window"
      }`,
      onclick: () =>
        send({
          type: "openTab",
          sessionId: r.session.id,
          tabIndex: r.tabIndex,
          targetWindowId: currentWindowId,
        }),
    },
    faviconEl(r.tab),
    r.tab.pinned ? el("span", { class: "pin", title: "Pinned" }, icon("pin")) : null,
    el("span", { class: "tab-title" }, r.tab.title || r.tab.url),
    el(
      "span",
      {
        class: `result-session${r.session.open ? " open" : ""}`,
        title: `In session “${r.session.name}”`,
      },
      r.session.name
    )
  );
  makeTabDraggable(row, sessionTabSource(r.session, r.tab, r.tabIndex));
  return row;
}

function renderSection(container, key, label, items, renderItem) {
  if (!items.length) return;
  const collapsed = collapsedSections.has(key);
  container.append(
    el(
      "div",
      {
        class: "list-heading collapsible",
        onclick: () => {
          if (collapsed) collapsedSections.delete(key);
          else collapsedSections.add(key);
          render();
        },
      },
      icon(collapsed ? "chevronRight" : "chevronDown"),
      el("span", { class: "heading-label" }, label),
      el("span", { class: "heading-count" }, String(items.length))
    )
  );
  if (!collapsed) items.forEach((it) => container.append(renderItem(it)));
}

function renderUntrackedWindow(w) {
  const expanded = expandedWindows.has(w.id);
  const row = el("div", {
    class: "session untracked",
    title: "Click to focus this window",
    onclick: () => send({ type: "focusWindow", windowId: w.id }),
  });
  row.append(
    el(
      "button",
      {
        class: "icon-btn chevron",
        title: expanded ? "Hide tabs" : "Show tabs",
        onclick: (e) => {
          e.stopPropagation();
          if (expanded) expandedWindows.delete(w.id);
          else expandedWindows.add(w.id);
          render();
        },
      },
      expanded ? icon("chevronDown") : icon("chevronRight")
    )
  );
  row.append(el("span", { class: "dot" }));

  const info = el("div", { class: "info" });
  info.append(el("div", { class: "name" }, w.title));
  info.append(
    el(
      "div",
      { class: "meta" },
      `${w.tabCount} tab${w.tabCount === 1 ? "" : "s"} · untracked`
    )
  );
  row.append(info);

  const actions = el("div", { class: "actions" });
  actions.append(
    el(
      "button",
      {
        class: "icon-btn act-add",
        title: "Track this window",
        onclick: async (e) => {
          e.stopPropagation();
          const suggested = await send({
            type: "getSuggestedName",
            windowId: w.id,
          });
          await send({
            type: "trackWindow",
            windowId: w.id,
            name: suggested || w.title || "Untitled session",
          });
        },
      },
      icon("plus")
    )
  );
  row.append(actions);

  if (!expanded) return row;

  const group = el("div", { class: "session-group" }, row);
  group.append(renderWindowTabList(w));
  return group;
}

function renderWindowTabList(w) {
  const list = el("div", { class: "tab-list" });
  (w.tabs || []).forEach((t) => {
    const source = windowTabSource(w, t);
    const tabRow = el(
      "div",
      {
        class: "tab",
        title: `${t.url}\nClick to focus this tab\nDrag onto a session to move it (Ctrl to copy)`,
        onclick: () => send({ type: "focusTab", windowId: w.id, tabId: t.id }),
        oncontextmenu: (e) => showTabContextMenu(e, source),
      },
      faviconEl(t),
      t.pinned ? el("span", { class: "pin", title: "Pinned" }, icon("pin")) : null,
      el("span", { class: "tab-title" }, t.title || t.url)
    );
    makeTabDraggable(tabRow, source);
    list.append(tabRow);
  });
  if (!list.children.length) {
    list.append(el("div", { class: "tab none" }, "No tabs"));
  }
  return list;
}

function renderSession(s) {
  const tabCount = (s.tabs || []).length;
  const meta = s.open
    ? `${tabCount} tab${tabCount === 1 ? "" : "s"} · open`
    : `${tabCount} tab${tabCount === 1 ? "" : "s"} · saved ${relativeTime(s.lastSaved)}`;
  const expanded = expandedSessions.has(s.id);
  // The session backing this sidebar's own window — mark it so it's obvious
  // which session you're in at a glance.
  const isCurrent = s.open && s.windowId === currentWindowId;

  const row = el("div", {
    class:
      `session${s.open ? " open" : ""}` +
      `${isCurrent ? " current" : ""}` +
      `${editingSessionId === s.id ? " editing" : ""}`,
    title: s.open
      ? "Click to focus this window"
      : "Click to reopen this session in a new window",
    onclick: () => send({ type: "openSession", sessionId: s.id }),
    oncontextmenu: (e) => showContextMenu(e, s),
  });
  // Any session row can receive a tab dragged from elsewhere.
  makeSessionDropTarget(row, s.id);

  row.append(
    el(
      "button",
      {
        class: "icon-btn chevron",
        title: expanded ? "Hide tabs" : "Show tabs",
        onclick: (e) => {
          e.stopPropagation();
          if (expanded) expandedSessions.delete(s.id);
          else expandedSessions.add(s.id);
          render();
        },
      },
      expanded ? icon("chevronDown") : icon("chevronRight")
    )
  );
  row.append(el("span", { class: "dot" }));

  const info = el("div", { class: "info" });
  if (editingSessionId === s.id) {
    const input = el("input", {
      type: "text",
      value: s.name,
      onclick: (e) => e.stopPropagation(),
      onkeydown: (e) => {
        if (e.key === "Enter") {
          editingSessionId = null;
          send({ type: "renameSession", sessionId: s.id, name: input.value });
        }
        if (e.key === "Escape") {
          editingSessionId = null;
          render();
        }
      },
    });
    info.append(input);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  } else {
    info.append(
      el(
        "div",
        { class: "name-row" },
        el("span", { class: "name" }, s.name),
        isCurrent
          ? el("span", { class: "current-badge", title: "This window" }, "current")
          : null
      )
    );
    info.append(el("div", { class: "meta" }, meta));
  }
  row.append(info);

  const actions = el("div", { class: "actions" });
  actions.append(
    el(
      "button",
      {
        class: "icon-btn act-edit",
        title: "Rename",
        onclick: (e) => {
          e.stopPropagation();
          editingSessionId = s.id;
          confirmingDeleteId = null;
          render();
        },
      },
      icon("edit")
    )
  );
  if (s.open) {
    actions.append(
      el(
        "button",
        {
          class: "icon-btn act-close",
          title: "Close this session's window (keeps the saved session)",
          onclick: (e) => {
            e.stopPropagation();
            confirmingDeleteId = null;
            send({ type: "closeSession", sessionId: s.id });
          },
        },
        icon("close")
      )
    );
  }
  actions.append(
    el(
      "button",
      {
        class: s.open ? "icon-btn danger gap-before" : "icon-btn danger",
        title:
          confirmingDeleteId === s.id
            ? "Click again to permanently delete"
            : "Delete session",
        onclick: (e) => {
          e.stopPropagation();
          if (confirmingDeleteId === s.id) {
            confirmingDeleteId = null;
            send({ type: "deleteSession", sessionId: s.id });
          } else {
            confirmingDeleteId = s.id;
            render();
          }
        },
      },
      confirmingDeleteId === s.id ? "Sure?" : icon("trash")
    )
  );
  row.append(actions);

  if (!expanded) return row;

  const group = el("div", { class: "session-group" }, row);
  group.append(renderTabList(s));
  return group;
}

function faviconEl(t) {
  const fallback = el("span", { class: "favicon fallback" });
  if (!t.favIconUrl || !/^(https?|data):/i.test(t.favIconUrl)) return fallback;
  const img = el("img", { class: "favicon", src: t.favIconUrl, alt: "" });
  img.addEventListener("error", () => img.replaceWith(fallback));
  return img;
}

function renderTabRow(s, t, i) {
  const source = sessionTabSource(s, t, i);
  const tabRow = el(
    "div",
    {
      class: "tab",
      title: `${t.url}\n${
        s.open
          ? "Click to focus this tab"
          : "Click to open just this tab in the current window"
      }\nDrag onto a session to move it (Ctrl to copy)`,
      onclick: () =>
        send({
          type: "openTab",
          sessionId: s.id,
          tabIndex: i,
          targetWindowId: currentWindowId,
        }),
      oncontextmenu: (e) => showTabContextMenu(e, source),
    },
    faviconEl(t),
    t.pinned ? el("span", { class: "pin", title: "Pinned" }, icon("pin")) : null,
    el("span", { class: "tab-title" }, t.title || t.url)
  );
  makeTabDraggable(tabRow, source);
  return tabRow;
}

// Render one tab group as a colored header over its run of tabs. The header
// follows the group's saved collapsed state until the user toggles it here.
function renderTabGroup(s, groupId, meta, runTabs) {
  const color = (meta && GROUP_COLORS[meta.color]) || GROUP_COLORS.grey;
  const title = (meta && meta.title) || "Group";
  const key = `${s.id}:${groupId}`;
  const collapsed = groupCollapseOverrides.has(key)
    ? groupCollapseOverrides.get(key)
    : !!(meta && meta.collapsed);

  const wrap = el("div", { class: "tab-group", style: `--group-color: ${color}` });
  wrap.append(
    el(
      "div",
      {
        class: "tab-group-header",
        title: `Tab group: ${title}`,
        onclick: (e) => {
          e.stopPropagation();
          groupCollapseOverrides.set(key, !collapsed);
          render();
        },
      },
      el("span", { class: "tab-group-swatch", style: `background: ${color}` }),
      collapsed ? icon("chevronRight") : icon("chevronDown"),
      el("span", { class: "tab-group-title" }, title),
      el("span", { class: "tab-group-count" }, String(runTabs.length))
    )
  );
  if (!collapsed) {
    runTabs.forEach(({ t, i }) => wrap.append(renderTabRow(s, t, i)));
  }
  return wrap;
}

function renderTabList(s) {
  const list = el("div", { class: "tab-list" });
  const tabs = s.tabs || [];
  const groupMeta = new Map((s.groups || []).map((g) => [g.id, g]));

  // Walk the tabs in order, emitting ungrouped tabs directly and gathering each
  // contiguous run of same-group tabs (the browser keeps groups contiguous)
  // into a group block.
  let i = 0;
  while (i < tabs.length) {
    const gid = tabs[i].groupId;
    if (gid == null) {
      list.append(renderTabRow(s, tabs[i], i));
      i++;
      continue;
    }
    const start = i;
    while (i < tabs.length && tabs[i].groupId === gid) i++;
    const runTabs = [];
    for (let j = start; j < i; j++) runTabs.push({ t: tabs[j], i: j });
    list.append(renderTabGroup(s, gid, groupMeta.get(gid), runTabs));
  }

  if (!list.children.length) {
    list.append(el("div", { class: "tab none" }, "No tabs saved yet"));
  }
  return list;
}

/* ---------------- context menu ---------------- */

function closeContextMenu() {
  const menu = document.getElementById("context-menu");
  if (menu) menu.remove();
}

function showContextMenu(e, s) {
  e.preventDefault();
  e.stopPropagation();
  closeContextMenu();

  const item = (label, onclick) =>
    el(
      "div",
      {
        class: "menu-item",
        onclick: (ev) => {
          ev.stopPropagation();
          closeContextMenu();
          onclick();
        },
      },
      label
    );

  const menu = el(
    "div",
    { class: "context-menu", id: "context-menu" },
    item(s.open ? "Close session" : "Open session", () =>
      send({ type: s.open ? "closeSession" : "openSession", sessionId: s.id })
    ),
    item("Export session…", () => exportSessionToFile(s.id))
  );
  placeMenuAt(menu, e);
}

// Append a freshly built context menu and clamp it inside the viewport —
// sidebars are narrow.
function placeMenuAt(menu, e) {
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  let x = e.clientX;
  let y = e.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
  menu.style.left = `${Math.max(0, x)}px`;
  menu.style.top = `${Math.max(0, y)}px`;
}

// Right-click menu on a tab row: move or copy the tab into another session.
function showTabContextMenu(e, source) {
  e.preventDefault();
  e.stopPropagation();
  closeContextMenu();

  // Every session is a candidate except the one the tab already lives in.
  const targets = state.sessions
    .filter((s) => !(source.saved && source.saved.sessionId === s.id))
    .sort((a, b) => {
      if (a.open !== b.open) return a.open ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const menu = el("div", { class: "context-menu", id: "context-menu" });
  if (!targets.length) {
    menu.append(el("div", { class: "menu-empty" }, "No other sessions"));
  } else {
    const group = (label, copy) => {
      menu.append(el("div", { class: "menu-label" }, label));
      for (const s of targets) {
        menu.append(
          el(
            "div",
            {
              class: "menu-item",
              onclick: (ev) => {
                ev.stopPropagation();
                closeContextMenu();
                send({
                  type: "transferTab",
                  source,
                  targetSessionId: s.id,
                  copy,
                });
              },
            },
            el("span", { class: `menu-dot${s.open ? " open" : ""}` }),
            el("span", { class: "menu-item-label" }, s.name)
          )
        );
      }
    };
    group("Move to", false);
    group("Copy to", true);
  }
  placeMenuAt(menu, e);
}

document.addEventListener("click", closeContextMenu);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeContextMenu();
});
window.addEventListener("blur", closeContextMenu);

async function exportSessionToFile(sessionId) {
  const data = await send({ type: "exportSession", sessionId });
  const name = (data.sessions[0] && data.sessions[0].name) || "session";
  const slug = name.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "session";
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = el("a", {
    href: url,
    download: `session-${slug}-${new Date().toISOString().slice(0, 10)}.json`,
  });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ---------------- import ---------------- */

let toastTimer = null;

function showToast(text, isError) {
  const toast = $("#toast");
  toast.textContent = text;
  toast.classList.toggle("error", !!isError);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 5000);
}

async function importFromFile(file) {
  try {
    const data = JSON.parse(await file.text());
    const result = await send({ type: "importSessions", data });
    showToast(
      `Imported ${result.imported} of ${result.total} session(s).`,
      false
    );
  } catch (e) {
    showToast(`Import failed: ${e.message}`, true);
  }
}

/* ---------------- top-level ---------------- */

function render() {
  renderCurrentWindow();
  renderSessions();
}

async function refresh() {
  state = await send({ type: "getState" });
  // Drop transient UI state for sessions that vanished.
  if (editingSessionId && !state.sessions.some((s) => s.id === editingSessionId)) {
    editingSessionId = null;
  }
  for (const id of expandedSessions) {
    if (!state.sessions.some((s) => s.id === id)) expandedSessions.delete(id);
  }
  for (const key of groupCollapseOverrides.keys()) {
    const sid = key.slice(0, key.lastIndexOf(":"));
    if (!state.sessions.some((s) => s.id === sid)) {
      groupCollapseOverrides.delete(key);
    }
  }
  const liveWindowIds = new Set((state.untrackedWindows || []).map((w) => w.id));
  for (const id of expandedWindows) {
    if (!liveWindowIds.has(id)) expandedWindows.delete(id);
  }
  render();
}

// Coalesce bursts of stateChanged (e.g. tracking several windows at once)
// into a single getState + re-render.
let refreshScheduled = false;
function scheduleRefresh() {
  if (refreshScheduled) return;
  refreshScheduled = true;
  setTimeout(() => {
    refreshScheduled = false;
    refresh();
  }, 50);
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "stateChanged") scheduleRefresh();
});

$("#open-options").addEventListener("click", () =>
  browser.runtime.openOptionsPage()
);
$("#save-now").addEventListener("click", () => send({ type: "saveNow" }));
$("#track-all").addEventListener("click", () =>
  send({ type: "trackAllWindows" })
);
$("#import").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", () => {
  const input = $("#import-file");
  const file = input.files[0];
  input.value = ""; // allow re-selecting the same file
  if (file) importFromFile(file);
});

const searchInput = $("#search");
const searchClear = $("#search-clear");
function clearSearch() {
  searchInput.value = "";
  searchQuery = "";
  searchClear.hidden = true;
  renderSessions();
}
searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value.trim();
  searchClear.hidden = !searchInput.value;
  // Only the list depends on the query; the "This window" card does not.
  renderSessions();
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && searchInput.value) {
    e.stopPropagation(); // keep the global Escape handler from firing too
    clearSearch();
  }
});
searchClear.addEventListener("click", () => {
  clearSearch();
  searchInput.focus();
});

(async function init() {
  const win = await browser.windows.getCurrent();
  currentWindowId = win.id;
  await refresh();
})();
