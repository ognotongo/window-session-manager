"use strict";

/*
 * Window Session Manager — background script.
 *
 * Core idea: a "session" is one window plus its tabs. Because Firefox gives us
 * no way to enumerate a window's tabs *after* it closes, we snapshot tracked
 * windows continuously (debounced on tab events, plus a periodic timer). The
 * windows.onRemoved handler then only has to flip the session to "closed" —
 * the tab list is already saved.
 */

const DEFAULT_OPTIONS = {
  // Derive session names from the window title preface (what Window Titler sets).
  useWindowTitler: true,
  // Extra periodic snapshot of all tracked windows, in seconds. 0 disables.
  periodicSaveSecs: 30,
  // Turn every new (non-private) window into a session automatically.
  autoTrackNewWindows: false,
};

const SNAPSHOT_DEBOUNCE_MS = 750;
const WINDOW_VALUE_KEY = "wsmSessionId";

let options = { ...DEFAULT_OPTIONS };
let sessions = {};                 // sessionId -> session record
const windowToSession = new Map(); // windowId  -> sessionId
const snapshotTimers = new Map();  // windowId  -> debounce timeout id
let periodicTimer = null;

/* ---------------- persistence ---------------- */

async function loadState() {
  const stored = await browser.storage.local.get(["options", "sessions"]);
  options = { ...DEFAULT_OPTIONS, ...(stored.options || {}) };
  sessions = stored.sessions || {};
}

async function persistSessions() {
  await browser.storage.local.set({ sessions });
}

function broadcast() {
  // Tell any open sidebars to re-render. Rejects when none are open; ignore.
  browser.runtime.sendMessage({ type: "stateChanged" }).catch(() => {});
}

/* ---------------- snapshots ---------------- */

function scheduleSnapshot(windowId) {
  if (!windowToSession.has(windowId)) return;
  clearTimeout(snapshotTimers.get(windowId));
  snapshotTimers.set(
    windowId,
    setTimeout(() => {
      snapshotTimers.delete(windowId);
      snapshotWindow(windowId).catch(() => {});
    }, SNAPSHOT_DEBOUNCE_MS)
  );
}

async function snapshotWindow(windowId) {
  const sessionId = windowToSession.get(windowId);
  const session = sessionId && sessions[sessionId];
  if (!session) return;

  let tabs;
  try {
    tabs = await browser.tabs.query({ windowId });
  } catch (e) {
    return; // window already gone
  }
  if (!tabs.length) return;

  session.tabs = tabs.map((t) => ({
    url: t.url,
    title: t.title,
    pinned: t.pinned,
    active: t.active,
    cookieStoreId: t.cookieStoreId,
    favIconUrl: t.favIconUrl,
  }));
  session.lastSaved = Date.now();
  await persistSessions();
  broadcast();
}

async function snapshotAllTracked() {
  for (const windowId of windowToSession.keys()) {
    await snapshotWindow(windowId).catch(() => {});
  }
}

function restartPeriodicTimer() {
  clearInterval(periodicTimer);
  periodicTimer = null;
  if (options.periodicSaveSecs > 0) {
    periodicTimer = setInterval(
      () => snapshotAllTracked(),
      options.periodicSaveSecs * 1000
    );
  }
}

/* ---------------- session naming (Window Titler integration) ---------------- */

/*
 * Extensions cannot read each other's storage, but Window Titler works by
 * setting the window's titlePreface — and that preface is visible in
 * windows.Window.title (with the "tabs" permission). Recover it by stripping
 * the browser-name suffix and the active tab's title from the window title.
 */
async function getSuggestedName(windowId) {
  if (!options.useWindowTitler) return null;
  let win;
  try {
    win = await browser.windows.get(windowId, { populate: true });
  } catch (e) {
    return null;
  }
  let title = win.title || "";
  title = title.replace(
    /\s+[—–-]\s+(Mozilla Firefox|Firefox)( (Nightly|Developer Edition|Beta))?( \((Private Browsing|Navigation privée)\))?$/,
    ""
  );
  const activeTab = (win.tabs || []).find((t) => t.active);
  const tabTitle = activeTab ? activeTab.title || "" : "";
  let preface = title;
  if (tabTitle && title.endsWith(tabTitle)) {
    preface = title.slice(0, title.length - tabTitle.length);
  }
  preface = preface.trim();
  // Window Titler wraps the name in brackets by default; unwrap common styles.
  const wrapped =
    preface.match(/^\[(.*)\]$/) ||
    preface.match(/^\((.*)\)$/) ||
    preface.match(/^\{(.*)\}$/);
  if (wrapped) preface = wrapped[1].trim();
  preface = preface.replace(/[\s—–:|·-]+$/, "").trim();
  return preface || null;
}

/* ---------------- tracking ---------------- */

function newSessionId() {
  return (
    (crypto.randomUUID && crypto.randomUUID()) ||
    `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

async function trackWindow(windowId, name) {
  const id = newSessionId();
  sessions[id] = {
    id,
    name: (name || "Untitled session").trim() || "Untitled session",
    created: Date.now(),
    lastSaved: Date.now(),
    open: true,
    windowId,
    tabs: [],
  };
  windowToSession.set(windowId, id);
  // Tag the window so we can re-associate it after a browser restart or an
  // undo-close-window restore.
  await browser.sessions
    .setWindowValue(windowId, WINDOW_VALUE_KEY, id)
    .catch(() => {});
  await snapshotWindow(windowId);
  broadcast();
  return sessions[id];
}

async function trackAllWindows() {
  const wins = await browser.windows.getAll({ windowTypes: ["normal"] });
  const usedNames = new Set(Object.values(sessions).map((s) => s.name));
  let tracked = 0;
  for (const win of wins) {
    if (win.incognito) continue; // never persist private windows to disk
    if (windowToSession.has(win.id)) continue;
    const suggested = await getSuggestedName(win.id).catch(() => null);
    let name = suggested || `Session ${new Date().toLocaleString()}`;
    if (usedNames.has(name)) {
      let n = 2;
      while (usedNames.has(`${name} (${n})`)) n++;
      name = `${name} (${n})`;
    }
    usedNames.add(name);
    await trackWindow(win.id, name);
    tracked++;
  }
  return { tracked };
}

async function untrackWindow(windowId) {
  const sessionId = windowToSession.get(windowId);
  if (!sessionId) return;
  await snapshotWindow(windowId).catch(() => {});
  windowToSession.delete(windowId);
  clearTimeout(snapshotTimers.get(windowId));
  snapshotTimers.delete(windowId);
  const session = sessions[sessionId];
  if (session) {
    session.open = false;
    session.windowId = null;
  }
  await browser.sessions
    .removeWindowValue(windowId, WINDOW_VALUE_KEY)
    .catch(() => {});
  await persistSessions();
  broadcast();
}

function markSessionClosed(sessionId) {
  const session = sessions[sessionId];
  if (!session) return;
  session.open = false;
  session.windowId = null;
}

async function renameSession(sessionId, name) {
  const session = sessions[sessionId];
  if (!session) return;
  session.name = (name || "").trim() || session.name;
  await persistSessions();
  broadcast();
}

async function deleteSession(sessionId) {
  const session = sessions[sessionId];
  if (!session) return;
  if (session.open && session.windowId != null) {
    await untrackWindow(session.windowId);
  }
  delete sessions[sessionId];
  await persistSessions();
  broadcast();
}

/* ---------------- export / import ---------------- */

function exportSessions() {
  return {
    format: "window-session-manager",
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions: Object.values(sessions),
  };
}

function sanitizeImportedTab(t) {
  if (!t || typeof t.url !== "string" || !t.url) return null;
  const tab = {
    url: t.url,
    title: typeof t.title === "string" && t.title ? t.title : t.url,
    pinned: !!t.pinned,
    active: !!t.active,
  };
  if (typeof t.cookieStoreId === "string") tab.cookieStoreId = t.cookieStoreId;
  if (typeof t.favIconUrl === "string") tab.favIconUrl = t.favIconUrl;
  return tab;
}

async function importSessions(data) {
  const list = Array.isArray(data)
    ? data
    : data && Array.isArray(data.sessions)
      ? data.sessions
      : null;
  if (!list) {
    throw new Error("Not a session export: expected a “sessions” array.");
  }
  let imported = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const tabs = Array.isArray(raw.tabs)
      ? raw.tabs.map(sanitizeImportedTab).filter(Boolean)
      : [];
    if (!tabs.length) continue;
    // Keep the original id so re-importing the same file updates in place
    // instead of duplicating — but never clobber a session that is currently
    // open in a live window. Imported sessions always arrive closed.
    const id = typeof raw.id === "string" && raw.id ? raw.id : newSessionId();
    if (sessions[id] && sessions[id].open) continue;
    sessions[id] = {
      id,
      name:
        (typeof raw.name === "string" && raw.name.trim()) || "Imported session",
      created: typeof raw.created === "number" ? raw.created : Date.now(),
      lastSaved: typeof raw.lastSaved === "number" ? raw.lastSaved : Date.now(),
      open: false,
      windowId: null,
      tabs,
    };
    imported++;
  }
  await persistSessions();
  broadcast();
  return { imported, total: list.length };
}

/* ---------------- restoring ---------------- */

function isRestorableUrl(url) {
  // Privileged pages (about:config, about:addons, file:, other extensions'
  // pages…) cannot be opened by an extension, so they are skipped on restore.
  return /^https?:/i.test(url) || url === "about:blank";
}

async function openSession(sessionId) {
  const session = sessions[sessionId];
  if (!session) throw new Error("Unknown session");

  if (session.open && session.windowId != null) {
    await browser.windows.update(session.windowId, { focused: true });
    return;
  }

  let tabs = (session.tabs || []).filter((t) => isRestorableUrl(t.url));
  if (!tabs.length) tabs = [{ url: "about:blank", active: true }];
  let activeIndex = tabs.findIndex((t) => t.active);
  if (activeIndex < 0) activeIndex = 0;

  // Start with an empty window, append every session tab in order, then drop
  // the placeholder the window came with.
  const win = await browser.windows.create({});
  const placeholderId = win.tabs[0].id;

  session.open = true;
  session.windowId = win.id;
  windowToSession.set(win.id, sessionId);
  await browser.sessions
    .setWindowValue(win.id, WINDOW_VALUE_KEY, sessionId)
    .catch(() => {});

  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i];
    const props = {
      windowId: win.id,
      url: t.url,
      pinned: !!t.pinned,
      index: i + 1,
    };
    if (i === activeIndex) {
      props.active = true;
    } else if (/^https?:/i.test(t.url)) {
      // Lazy-load everything except the active tab: the page stays unloaded
      // (showing its saved title) until the user clicks it.
      props.active = false;
      props.discarded = true;
      if (t.title) props.title = t.title;
    } else {
      props.active = false;
    }
    if (t.cookieStoreId && t.cookieStoreId !== "firefox-default") {
      props.cookieStoreId = t.cookieStoreId;
    }
    try {
      await browser.tabs.create(props);
    } catch (e) {
      // Container missing or discard rejected — retry progressively simpler.
      delete props.cookieStoreId;
      try {
        await browser.tabs.create(props);
      } catch (e2) {
        delete props.discarded;
        delete props.title;
        await browser.tabs.create(props).catch(() => {});
      }
    }
  }
  await browser.tabs.remove(placeholderId).catch(() => {});
  await snapshotWindow(win.id);
  broadcast();
}

/*
 * Open one saved tab. For an open session, focus the matching live tab; for a
 * closed one, open the tab into the caller's window without restoring the
 * whole session.
 */
async function openSingleTab(sessionId, tabIndex, targetWindowId) {
  const session = sessions[sessionId];
  const saved = session && session.tabs && session.tabs[tabIndex];
  if (!saved) return;

  if (session.open && session.windowId != null) {
    const live = await browser.tabs
      .query({ windowId: session.windowId })
      .catch(() => []);
    const match = live.find((t) => t.url === saved.url) || live[tabIndex];
    if (match) {
      await browser.tabs.update(match.id, { active: true });
      await browser.windows.update(session.windowId, { focused: true });
      return;
    }
  }

  if (!isRestorableUrl(saved.url)) return;
  const props = { url: saved.url, active: true };
  if (targetWindowId != null) props.windowId = targetWindowId;
  if (saved.cookieStoreId && saved.cookieStoreId !== "firefox-default") {
    props.cookieStoreId = saved.cookieStoreId;
  }
  try {
    await browser.tabs.create(props);
  } catch (e) {
    delete props.cookieStoreId;
    await browser.tabs.create(props).catch(() => {});
  }
}

/* ---------------- window (re-)association ---------------- */

async function associateWindow(win) {
  if (win.type && win.type !== "normal") return;
  const sessionId = await browser.sessions
    .getWindowValue(win.id, WINDOW_VALUE_KEY)
    .catch(() => null);
  if (sessionId && sessions[sessionId]) {
    // Another live window may already own this session (e.g. duplicated
    // restore); first one wins.
    if (
      sessions[sessionId].open &&
      sessions[sessionId].windowId != null &&
      windowToSession.has(sessions[sessionId].windowId) &&
      sessions[sessionId].windowId !== win.id
    ) {
      return;
    }
    sessions[sessionId].open = true;
    sessions[sessionId].windowId = win.id;
    windowToSession.set(win.id, sessionId);
    scheduleSnapshot(win.id);
  }
}

async function reconcileOnStartup() {
  const wins = await browser.windows.getAll();
  for (const win of wins) {
    await associateWindow(win);
  }
  // Anything not matched to a live window is a closed session.
  const openIds = new Set(windowToSession.values());
  for (const session of Object.values(sessions)) {
    if (!openIds.has(session.id)) {
      session.open = false;
      session.windowId = null;
    }
  }
  await persistSessions();
  broadcast();
}

/* ---------------- event wiring ---------------- */

function onTabEvent(windowId) {
  if (windowId != null) scheduleSnapshot(windowId);
}

browser.tabs.onCreated.addListener((tab) => onTabEvent(tab.windowId));
browser.tabs.onRemoved.addListener((tabId, info) => {
  if (!info.isWindowClosing) onTabEvent(info.windowId);
});
browser.tabs.onMoved.addListener((tabId, info) => onTabEvent(info.windowId));
browser.tabs.onAttached.addListener((tabId, info) =>
  onTabEvent(info.newWindowId)
);
browser.tabs.onDetached.addListener((tabId, info) =>
  onTabEvent(info.oldWindowId)
);
try {
  browser.tabs.onUpdated.addListener(
    (tabId, changeInfo, tab) => onTabEvent(tab.windowId),
    { properties: ["url", "title", "pinned"] }
  );
} catch (e) {
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if ("url" in changeInfo || "title" in changeInfo || "pinned" in changeInfo) {
      onTabEvent(tab.windowId);
    }
  });
}

browser.windows.onCreated.addListener((win) => {
  // Re-link windows restored via "Reopen Closed Window" / session restore.
  associateWindow(win)
    .then(() => persistSessions())
    .then(broadcast)
    .then(() => maybeAutoTrack(win));
});

const AUTO_TRACK_DELAY_MS = 1500;

function maybeAutoTrack(win) {
  if (!options.autoTrackNewWindows) return;
  if (win.type && win.type !== "normal") return;
  if (win.incognito) return; // never persist private windows to disk
  // The delay lets openSession()/session restore claim the window first, and
  // gives Window Titler time to apply its title preface.
  setTimeout(async () => {
    if (!options.autoTrackNewWindows) return;
    if (windowToSession.has(win.id)) return;
    try {
      await browser.windows.get(win.id);
    } catch (e) {
      return; // window already closed again
    }
    const suggested = await getSuggestedName(win.id).catch(() => null);
    const name = suggested || `Session ${new Date().toLocaleString()}`;
    await trackWindow(win.id, name);
  }, AUTO_TRACK_DELAY_MS);
}

browser.windows.onRemoved.addListener(async (windowId) => {
  const sessionId = windowToSession.get(windowId);
  if (!sessionId) return;
  clearTimeout(snapshotTimers.get(windowId));
  snapshotTimers.delete(windowId);
  windowToSession.delete(windowId);
  markSessionClosed(sessionId);
  await persistSessions();
  broadcast();
});

browser.browserAction.onClicked.addListener(() => {
  browser.sidebarAction.open().catch(() => {});
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.options) {
    options = { ...DEFAULT_OPTIONS, ...(changes.options.newValue || {}) };
    restartPeriodicTimer();
  }
});

/* ---------------- sidebar / options API ---------------- */

browser.runtime.onMessage.addListener((msg) => {
  switch (msg && msg.type) {
    case "getState":
      return Promise.resolve({
        sessions: Object.values(sessions),
        options,
      });
    case "getSuggestedName":
      return getSuggestedName(msg.windowId);
    case "trackWindow":
      return trackWindow(msg.windowId, msg.name);
    case "trackAllWindows":
      return trackAllWindows();
    case "untrackWindow":
      return untrackWindow(msg.windowId);
    case "openSession":
      return openSession(msg.sessionId);
    case "renameSession":
      return renameSession(msg.sessionId, msg.name);
    case "deleteSession":
      return deleteSession(msg.sessionId);
    case "saveNow":
      return snapshotAllTracked();
    case "openTab":
      return openSingleTab(msg.sessionId, msg.tabIndex, msg.targetWindowId);
    case "exportSessions":
      return Promise.resolve(exportSessions());
    case "importSessions":
      return importSessions(msg.data);
  }
  return undefined;
});

/* ---------------- init ---------------- */

(async function init() {
  await loadState();
  await reconcileOnStartup();
  restartPeriodicTimer();
})();
