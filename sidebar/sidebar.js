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
let state = { sessions: [], options: {} };

// Transient UI state that must survive re-renders.
let namingInProgress = false; // "track this window" name input is showing
let suggestedName = "";
let editingSessionId = null;  // session currently being renamed
let confirmingDeleteId = null;
const expandedSessions = new Set(); // session ids with their tab list shown

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
  pin:
    '<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>',
};

function icon(name) {
  // Parse via DOMParser rather than assigning innerHTML (which trips a
  // web-ext security warning). Source strings are static constants.
  const markup =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
    'class="icon" aria-hidden="true">' +
    (ICON_PATHS[name] || "") +
    "</svg>";
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  return document.importNode(doc.documentElement, true);
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

  const open = state.sessions
    .filter((s) => s.open)
    .sort((a, b) => a.name.localeCompare(b.name));
  const closed = state.sessions
    .filter((s) => !s.open)
    .sort((a, b) => (b.lastSaved || 0) - (a.lastSaved || 0));

  if (!open.length && !closed.length) {
    container.append(
      el(
        "div",
        { class: "empty" },
        "No sessions yet. Click “Track this window” above to start one."
      )
    );
    return;
  }

  if (open.length) {
    container.append(el("div", { class: "list-heading" }, "Open"));
    open.forEach((s) => container.append(renderSession(s)));
  }
  if (closed.length) {
    container.append(el("div", { class: "list-heading" }, "Closed"));
    closed.forEach((s) => container.append(renderSession(s)));
  }
}

function renderSession(s) {
  const tabCount = (s.tabs || []).length;
  const meta = s.open
    ? `${tabCount} tab${tabCount === 1 ? "" : "s"} · open`
    : `${tabCount} tab${tabCount === 1 ? "" : "s"} · saved ${relativeTime(s.lastSaved)}`;
  const expanded = expandedSessions.has(s.id);

  const row = el("div", {
    class: `session${s.open ? " open" : ""}${editingSessionId === s.id ? " editing" : ""}`,
    title: s.open
      ? "Click to focus this window"
      : "Click to reopen this session in a new window",
    onclick: () => send({ type: "openSession", sessionId: s.id }),
    oncontextmenu: (e) => showContextMenu(e, s),
  });

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
    info.append(el("div", { class: "name" }, s.name));
    info.append(el("div", { class: "meta" }, meta));
  }
  row.append(info);

  const actions = el("div", { class: "actions" });
  actions.append(
    el(
      "button",
      {
        class: "icon-btn",
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
          class: "icon-btn",
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

function renderTabList(s) {
  const list = el("div", { class: "tab-list" });
  (s.tabs || []).forEach((t, i) => {
    const tabRow = el(
      "div",
      {
        class: "tab",
        title: `${t.url}\n${
          s.open
            ? "Click to focus this tab"
            : "Click to open just this tab in the current window"
        }`,
        onclick: () =>
          send({
            type: "openTab",
            sessionId: s.id,
            tabIndex: i,
            targetWindowId: currentWindowId,
          }),
      },
      faviconEl(t),
      t.pinned ? el("span", { class: "pin", title: "Pinned" }, icon("pin")) : null,
      el("span", { class: "tab-title" }, t.title || t.url)
    );
    list.append(tabRow);
  });
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
  document.body.append(menu);

  // Clamp to the viewport — sidebars are narrow.
  const rect = menu.getBoundingClientRect();
  let x = e.clientX;
  let y = e.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
  menu.style.left = `${Math.max(0, x)}px`;
  menu.style.top = `${Math.max(0, y)}px`;
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
  render();
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "stateChanged") refresh();
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

(async function init() {
  const win = await browser.windows.getCurrent();
  currentWindowId = win.id;
  await refresh();
})();
