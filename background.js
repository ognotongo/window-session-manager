/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

/*
 * Window Session Manager — background.
 *
 * Core idea: a "session" is one window plus its tabs. Because the browser
 * gives us no way to enumerate a window's tabs *after* it closes, we snapshot
 * tracked windows continuously (debounced on tab events, plus a periodic
 * alarm). windows.onRemoved then only has to flip the session to "closed" —
 * the tab list is already saved.
 *
 * Lifecycle note (MV3): this runs as a Chrome/Edge service worker or a
 * Firefox event page, both of which are suspended when idle and lose all
 * in-memory state. Nothing here may assume it survives between events:
 *   - storage.local is the source of truth; the in-memory `sessions`/`options`
 *     are a cache rebuilt on each wake via ensureReady().
 *   - `windowToSession` is derived state, rebuilt from live windows on wake.
 *   - the periodic save uses alarms (which survive suspension), never
 *     setInterval. The short per-event setTimeout debounce is best-effort and
 *     backed up by the alarm.
 *
 * Cross-browser note: Firefox-only capabilities are feature-detected and
 * gated, so the same file runs on Chromium (Edge) where they are absent:
 *   - window title preface (Window Titler integration)
 *   - sessions.{get,set,remove}WindowValue (restart re-association)
 *   - container tabs (cookieStoreId) and discarded-tab creation
 */

const browser = globalThis.browser || globalThis.chrome;

// Capability probes. getBrowserInfo is Firefox-only; setWindowValue is the
// sessions-API extension Chromium lacks.
const isFirefox = typeof browser.runtime.getBrowserInfo === "function";
const hasWindowValues = !!(
  browser.sessions && browser.sessions.setWindowValue
);

const DEFAULT_OPTIONS = {
  // Derive session names from the window title preface (what Window Titler
  // sets). Firefox only.
  useWindowTitler: true,
  // Periodic snapshot of all tracked windows, in seconds. 0 disables. Clamped
  // up to the browser's alarm minimum (see ALARM_MIN_SECONDS).
  periodicSaveSecs: 30,
  // Turn every new (non-private) window into a session automatically.
  autoTrackNewWindows: false,
  // Write the session name into the window title (titlePreface) on track,
  // rename, and restore — the same mechanism Window Titler uses. Firefox only.
  setTitlePreface: true,
};

const SNAPSHOT_DEBOUNCE_MS = 750;
const WINDOW_VALUE_KEY = "wsmSessionId";
// Object keys that would mutate the prototype rather than add an entry; never
// use these as a session id from untrusted (imported) data.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PERIODIC_ALARM = "wsm-periodic-save";
// Both engines clamp alarm periods to a floor (~30s Chrome, ~60s Firefox);
// use the larger so behavior matches the configured value where possible.
const ALARM_MIN_SECONDS = 60;

let options = { ...DEFAULT_OPTIONS };
let sessions = {};                 // sessionId -> session record
const windowToSession = new Map(); // windowId  -> sessionId (derived)
const snapshotTimers = new Map();  // windowId  -> debounce timeout id

/* ---------------- readiness / state rebuild ---------------- */

// Memoized per background lifetime: loads cached state and rebuilds the
// window->session map exactly once per wake. Every event handler awaits this
// before touching state.
let readyPromise = null;
function ensureReady() {
  if (!readyPromise) readyPromise = rebuildState();
  return readyPromise;
}

async function rebuildState() {
  const stored = await browser.storage.local.get(["options", "sessions"]);
  options = { ...DEFAULT_OPTIONS, ...(stored.options || {}) };
  sessions = stored.sessions || {};
  await reconcileWindows();
}

async function persistSessions() {
  await browser.storage.local.set({ sessions });
}

function broadcast() {
  // Tell any open sidebars/panels to re-render. Rejects when none are open.
  browser.runtime.sendMessage({ type: "stateChanged" }).catch(() => {});
}

/*
 * Rebuild windowToSession from the set of live windows. Used on every wake
 * (state was lost) and after a browser restart (window ids changed). On
 * Firefox we recover the association from the per-window value we stored; on
 * Chromium, which has no window values, we fall back to matching the windowId
 * recorded on the session — valid within a browser session but not across a
 * restart, where those ids are stale and the sessions become closed.
 */
async function reconcileWindows() {
  windowToSession.clear();
  let wins = [];
  try {
    wins = await browser.windows.getAll();
  } catch (e) {
    wins = [];
  }
  const normalWins = wins.filter((w) => !w.type || w.type === "normal");

  // Firefox: recover associations from per-window values, looked up in
  // parallel rather than one awaited round-trip per window.
  const values = hasWindowValues
    ? await Promise.all(
        normalWins.map((w) =>
          browser.sessions
            .getWindowValue(w.id, WINDOW_VALUE_KEY)
            .catch(() => null)
        )
      )
    : [];
  // Chromium fallback: match by the windowId recorded on an open session.
  // Build the lookup once (O(sessions)) instead of scanning per window.
  const byWindowId = new Map();
  for (const s of Object.values(sessions)) {
    if (s.open && s.windowId != null) byWindowId.set(s.windowId, s.id);
  }

  let changed = false;
  const claimed = new Set();
  normalWins.forEach((win, i) => {
    const sessionId = (hasWindowValues ? values[i] : null) || byWindowId.get(win.id) || null;
    if (!sessionId || !sessions[sessionId] || claimed.has(sessionId)) return;
    claimed.add(sessionId);
    const s = sessions[sessionId];
    const wasLinked = s.open && s.windowId === win.id;
    s.open = true;
    s.windowId = win.id;
    windowToSession.set(win.id, sessionId);
    // Only re-assert the title preface on a real (re-)link, not every idle
    // wake where it is already set.
    if (!wasLinked) {
      changed = true;
      applyTitlePreface(win.id, s.name);
    }
  });
  // Anything not matched to a live window is a closed session.
  for (const session of Object.values(sessions)) {
    if (!claimed.has(session.id) && (session.open || session.windowId != null)) {
      session.open = false;
      session.windowId = null;
      changed = true;
    }
  }
  // Only persist/notify when state actually changed — most wakes are no-ops.
  if (changed) {
    await persistSessions();
    broadcast();
  }
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

// Capture a tracked window's tabs into its session, in memory only. Returns
// whether anything was stored. Persisting/broadcasting is left to the caller
// so batch operations can do it once.
async function captureWindow(windowId) {
  const sessionId = windowToSession.get(windowId);
  const session = sessionId && sessions[sessionId];
  if (!session) return false;

  let tabs;
  try {
    tabs = await browser.tabs.query({ windowId });
  } catch (e) {
    return false; // window already gone
  }
  if (!tabs.length) return false;

  session.tabs = tabs.map((t) => ({
    url: t.url,
    title: t.title,
    pinned: t.pinned,
    active: t.active,
    cookieStoreId: t.cookieStoreId,
    favIconUrl: t.favIconUrl,
  }));
  session.lastSaved = Date.now();
  return true;
}

async function snapshotWindow(windowId) {
  if (await captureWindow(windowId)) {
    await persistSessions();
    broadcast();
  }
}

async function snapshotAllTracked() {
  // Capture every tracked window in parallel, then persist/broadcast once
  // rather than once per window.
  const results = await Promise.all(
    [...windowToSession.keys()].map((id) => captureWindow(id).catch(() => false))
  );
  if (results.some(Boolean)) {
    await persistSessions();
    broadcast();
  }
}

function setupPeriodicAlarm() {
  browser.alarms.clear(PERIODIC_ALARM).catch(() => {});
  if (options.periodicSaveSecs > 0) {
    const seconds = Math.max(options.periodicSaveSecs, ALARM_MIN_SECONDS);
    browser.alarms.create(PERIODIC_ALARM, { periodInMinutes: seconds / 60 });
  }
}

// Chromium/Edge: make the toolbar button open the side panel. No-op on
// Firefox, which uses sidebar_action + the action.onClicked handler instead.
// The API is reached through a local var (not browser.sidePanel.*) so the
// Firefox-only web-ext linter doesn't flag this guarded Chromium call.
function setupSidePanel() {
  const sidePanel = browser["sidePanel"];
  if (sidePanel && sidePanel.setPanelBehavior) {
    sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}

/* ---------------- session naming (Window Titler integration) ---------------- */

/*
 * Extensions cannot read each other's storage, but Window Titler works by
 * setting the window's titlePreface — and that preface is visible in
 * windows.Window.title (with the "tabs" permission). Recover it by stripping
 * the browser-name suffix and the active tab's title from the window title.
 * Firefox only: Chromium windows expose no title.
 */
async function getSuggestedName(windowId) {
  if (!isFirefox || !options.useWindowTitler) return null;
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

/* ---------------- window title preface ---------------- */

/*
 * Note: this competes with Window Titler for the same titlePreface — last
 * writer wins. We deliberately take it over for tracked windows. No-op on
 * Chromium, which does not let extensions set window titles.
 */
function applyTitlePreface(windowId, name) {
  if (!isFirefox || !options.setTitlePreface) return;
  browser.windows
    .update(windowId, { titlePreface: name ? `[${name}] ` : "" })
    .catch(() => {});
}

function clearTitlePreface(windowId) {
  if (!isFirefox) return;
  browser.windows.update(windowId, { titlePreface: "" }).catch(() => {});
}

const TITLE_PREFACE_REAPPLY_MS = 2000;

/*
 * On freshly created windows, other actors can overwrite the preface we just
 * set — Window Titler reacts to windows.onCreated and applies its stored
 * (usually empty) preface for the new window. Apply now and once more after
 * a short delay so we end up the last writer. The name is re-read at fire
 * time in case the session was renamed or untracked in between.
 */
function applyTitlePrefacePersistent(windowId) {
  const apply = () => {
    const sessionId = windowToSession.get(windowId);
    const session = sessionId && sessions[sessionId];
    if (session) applyTitlePreface(windowId, session.name);
  };
  apply();
  if (isFirefox && options.setTitlePreface) {
    setTimeout(apply, TITLE_PREFACE_REAPPLY_MS);
  }
}

/* ---------------- tracking ---------------- */

function newSessionId() {
  return (
    (crypto.randomUUID && crypto.randomUUID()) ||
    `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

// Create a session for a window without persisting/broadcasting, so callers
// (single track vs. track-all) control how often that happens.
async function trackWindowCore(windowId, name) {
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
  // undo-close-window restore (Firefox only).
  if (hasWindowValues) {
    await browser.sessions
      .setWindowValue(windowId, WINDOW_VALUE_KEY, id)
      .catch(() => {});
  }
  applyTitlePreface(windowId, sessions[id].name);
  await captureWindow(windowId);
  return sessions[id];
}

async function trackWindow(windowId, name) {
  const session = await trackWindowCore(windowId, name);
  await persistSessions();
  broadcast();
  return session;
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
    await trackWindowCore(win.id, name);
    tracked++;
  }
  // Persist/broadcast once for the whole batch instead of per window.
  if (tracked) {
    await persistSessions();
    broadcast();
  }
  return { tracked };
}

/*
 * Stop tracking a window: forget the session entirely (it disappears from the
 * list) while leaving the window itself open. The window is untagged so it is
 * not re-associated on the next wake.
 */
async function untrackWindow(windowId) {
  const sessionId = windowToSession.get(windowId);
  if (!sessionId) return;
  windowToSession.delete(windowId);
  clearTimeout(snapshotTimers.get(windowId));
  snapshotTimers.delete(windowId);
  delete sessions[sessionId];
  if (hasWindowValues) {
    await browser.sessions
      .removeWindowValue(windowId, WINDOW_VALUE_KEY)
      .catch(() => {});
  }
  // Drop the preface we set; with the option off it may belong to Window
  // Titler, so leave it alone.
  if (options.setTitlePreface) clearTitlePreface(windowId);
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
  if (session.open && session.windowId != null) {
    applyTitlePreface(session.windowId, session.name);
  }
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

function makeExportEnvelope(list) {
  return {
    format: "window-session-manager",
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions: list,
  };
}

function exportSessions() {
  return makeExportEnvelope(Object.values(sessions));
}

function exportOneSession(sessionId) {
  const session = sessions[sessionId];
  if (!session) throw new Error("Unknown session");
  return makeExportEnvelope([session]);
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
    // Reject ids that would mutate the object prototype instead of adding an
    // entry (e.g. "__proto__") since the id comes from an untrusted file.
    const rawId = typeof raw.id === "string" ? raw.id : "";
    const id =
      rawId && !UNSAFE_KEYS.has(rawId) ? rawId : newSessionId();
    if (
      Object.prototype.hasOwnProperty.call(sessions, id) &&
      sessions[id].open
    ) {
      continue;
    }
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
  if (hasWindowValues) {
    await browser.sessions
      .setWindowValue(win.id, WINDOW_VALUE_KEY, sessionId)
      .catch(() => {});
  }
  applyTitlePrefacePersistent(win.id);

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
    } else if (isFirefox && /^https?:/i.test(t.url)) {
      // Lazy-load everything except the active tab: the page stays unloaded
      // (showing its saved title) until the user clicks it. Firefox only —
      // Chromium's tabs.create rejects `discarded`/`title`.
      props.active = false;
      props.discarded = true;
      if (t.title) props.title = t.title;
    } else {
      props.active = false;
    }
    if (isFirefox && t.cookieStoreId && t.cookieStoreId !== "firefox-default") {
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
  await snapshotWindow(win.id); // persists + broadcasts
}

/*
 * Close an open session's window. A final snapshot is taken first in case a
 * debounced save is still pending; windows.onRemoved then marks the session
 * closed as usual.
 */
async function closeSession(sessionId) {
  const session = sessions[sessionId];
  if (!session || !session.open || session.windowId == null) return;
  await snapshotWindow(session.windowId).catch(() => {});
  await browser.windows.remove(session.windowId).catch(() => {});
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
  if (isFirefox && saved.cookieStoreId && saved.cookieStoreId !== "firefox-default") {
    props.cookieStoreId = saved.cookieStoreId;
  }
  try {
    await browser.tabs.create(props);
  } catch (e) {
    delete props.cookieStoreId;
    await browser.tabs.create(props).catch(() => {});
  }
}

/* ---------------- moving / copying tabs between sessions ---------------- */

/*
 * Resolve the live tab behind a transfer source, if any. Untracked-window
 * sources carry the live tab id directly; open-session sources reference a
 * saved snapshot entry, so the live tab is matched by URL (falling back to the
 * saved index) inside the session's window, mirroring openSingleTab. Closed
 * sessions have no live tab and return null.
 */
async function resolveLiveSourceTab(source) {
  if (source.live && source.live.tabId != null) return source.live;
  if (source.saved) {
    const s = sessions[source.saved.sessionId];
    if (s && s.open && s.windowId != null) {
      const live = await browser.tabs
        .query({ windowId: s.windowId })
        .catch(() => []);
      const match =
        live.find((t) => t.url === source.url) || live[source.saved.tabIndex];
      if (match) return { windowId: s.windowId, tabId: match.id };
    }
  }
  return null;
}

// Create a tab carrying the source's URL into a live window, lazy-loaded the
// same way openSession restores tabs. Returns whether a tab was created.
async function createTabFromSource(windowId, source) {
  if (!isRestorableUrl(source.url)) return false;
  const props = {
    windowId,
    url: source.url,
    pinned: !!source.pinned,
    active: false,
  };
  if (isFirefox && /^https?:/i.test(source.url)) {
    props.discarded = true;
    if (source.title) props.title = source.title;
  }
  if (
    isFirefox &&
    source.cookieStoreId &&
    source.cookieStoreId !== "firefox-default"
  ) {
    props.cookieStoreId = source.cookieStoreId;
  }
  try {
    await browser.tabs.create(props);
  } catch (e) {
    delete props.cookieStoreId;
    try {
      await browser.tabs.create(props);
    } catch (e2) {
      delete props.discarded;
      delete props.title;
      try {
        await browser.tabs.create(props);
      } catch (e3) {
        return false;
      }
    }
  }
  return true;
}

function savedTabFromSource(source) {
  const tab = {
    url: source.url,
    title: source.title || source.url,
    pinned: !!source.pinned,
    active: false,
  };
  if (typeof source.cookieStoreId === "string") {
    tab.cookieStoreId = source.cookieStoreId;
  }
  return tab;
}

// Remove the source tab after a successful move (the copy path never calls
// this). A live tab is closed; a saved entry in a closed session is spliced
// out. windowToSession windows touched here are added to `affected` so the
// caller re-snapshots them.
async function removeTransferSource(source, live, affected) {
  if (live && (!source.saved || isSessionOpen(source.saved.sessionId))) {
    await browser.tabs.remove(live.tabId).catch(() => {});
    affected.add(live.windowId);
    return;
  }
  if (source.saved) {
    const s = sessions[source.saved.sessionId];
    if (s && Array.isArray(s.tabs)) {
      const at =
        s.tabs[source.saved.tabIndex] &&
        s.tabs[source.saved.tabIndex].url === source.url
          ? source.saved.tabIndex
          : s.tabs.findIndex((t) => t.url === source.url);
      if (at >= 0) {
        s.tabs.splice(at, 1);
        s.lastSaved = Date.now();
      }
    }
  }
}

function isSessionOpen(sessionId) {
  const s = sessions[sessionId];
  return !!(s && s.open && s.windowId != null);
}

/*
 * Move or copy a single tab into a target session. Handles every combination
 * of source/target state:
 *   - target open  + live source  + move  -> physically move the live tab
 *     (tabs.move) into the target's window;
 *   - target open  + (copy, or a closed-session source) -> create a tab from
 *     the URL in the target's window;
 *   - target closed -> append the tab to the target's saved list.
 * On a move the source is then removed (live tab closed, or saved entry
 * dropped). Affected tracked windows are re-snapshotted so the sidebar and
 * storage reflect the change immediately.
 */
async function transferTab(source, targetSessionId, copy) {
  const target = sessions[targetSessionId];
  if (!target || !source || typeof source.url !== "string" || !source.url) {
    return;
  }
  // Dropping a saved tab back onto its own session is a no-op.
  if (source.saved && source.saved.sessionId === targetSessionId && !copy) {
    return;
  }

  const live = await resolveLiveSourceTab(source);
  const affected = new Set();

  if (target.open && target.windowId != null) {
    if (live && !copy) {
      try {
        await browser.tabs.move(live.tabId, {
          windowId: target.windowId,
          index: -1,
        });
        affected.add(live.windowId);
        affected.add(target.windowId);
      } catch (e) {
        // Move rejected (e.g. tab vanished); leave the source untouched.
        return;
      }
    } else {
      const created = await createTabFromSource(target.windowId, source);
      if (!created) return;
      affected.add(target.windowId);
      if (!copy) await removeTransferSource(source, live, affected);
    }
  } else {
    target.tabs = target.tabs || [];
    target.tabs.push(savedTabFromSource(source));
    target.lastSaved = Date.now();
    if (!copy) await removeTransferSource(source, live, affected);
  }

  // Re-snapshot any tracked windows we changed; both branches still need a
  // persist+broadcast for closed sessions edited in memory.
  for (const windowId of affected) {
    if (windowToSession.has(windowId)) await captureWindow(windowId);
  }
  await persistSessions();
  broadcast();
}

/* ---------------- auto-track ---------------- */

const AUTO_TRACK_DELAY_MS = 1500;

function maybeAutoTrack(win) {
  if (!options.autoTrackNewWindows) return;
  if (win.type && win.type !== "normal") return;
  if (win.incognito) return; // never persist private windows to disk
  // The delay lets openSession()/session restore claim the window first, and
  // gives Window Titler time to apply its title preface.
  setTimeout(async () => {
    await ensureReady();
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

/* ---------------- untracked windows ---------------- */

/*
 * Live normal (non-private) windows not associated with a session, with a
 * label and tab count for the sidebar's Untracked section.
 */
async function getUntrackedWindows() {
  let wins = [];
  try {
    wins = await browser.windows.getAll({
      populate: true,
      windowTypes: ["normal"],
    });
  } catch (e) {
    return [];
  }
  const result = [];
  for (const win of wins) {
    if (win.incognito) continue; // private windows are never tracked
    if (windowToSession.has(win.id)) continue;
    const tabs = win.tabs || [];
    const active = tabs.find((t) => t.active) || tabs[0];
    result.push({
      id: win.id,
      title: (active && active.title && active.title.trim()) || `Window ${win.id}`,
      tabCount: tabs.length,
      tabs: tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        favIconUrl: t.favIconUrl,
        pinned: t.pinned,
        active: t.active,
      })),
    });
  }
  return result;
}

// Bring an (untracked) window to the front.
async function focusWindow(windowId) {
  await browser.windows.update(windowId, { focused: true }).catch(() => {});
}

// Focus a live tab in an (untracked) window.
async function focusTab(windowId, tabId) {
  await browser.tabs.update(tabId, { active: true }).catch(() => {});
  await browser.windows.update(windowId, { focused: true }).catch(() => {});
}

/* ---------------- event wiring ---------------- */

async function onTabEvent(windowId) {
  if (windowId == null) return;
  await ensureReady();
  scheduleSnapshot(windowId);
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

browser.windows.onCreated.addListener(async (win) => {
  await ensureReady();
  // Re-link windows restored via "Reopen Closed Window" / session restore,
  // then consider auto-tracking brand-new ones.
  if (!win.type || win.type === "normal") {
    const sessionId = hasWindowValues
      ? await browser.sessions
          .getWindowValue(win.id, WINDOW_VALUE_KEY)
          .catch(() => null)
      : null;
    if (sessionId && sessions[sessionId] && !windowToSession.has(win.id)) {
      sessions[sessionId].open = true;
      sessions[sessionId].windowId = win.id;
      windowToSession.set(win.id, sessionId);
      applyTitlePrefacePersistent(win.id);
      scheduleSnapshot(win.id);
      await persistSessions();
    }
    // Refresh the sidebar so the new window shows up — either as a re-linked
    // session or in the Untracked section.
    broadcast();
  }
  maybeAutoTrack(win);
});

browser.windows.onRemoved.addListener(async (windowId) => {
  await ensureReady();
  const sessionId = windowToSession.get(windowId);
  if (!sessionId) {
    // An untracked window closed — refresh the Untracked section.
    broadcast();
    return;
  }
  clearTimeout(snapshotTimers.get(windowId));
  snapshotTimers.delete(windowId);
  windowToSession.delete(windowId);
  markSessionClosed(sessionId);
  await persistSessions();
  broadcast();
});

if (browser.action && browser.action.onClicked) {
  browser.action.onClicked.addListener(() => {
    // Firefox: open the sidebar. Chromium's side panel is wired separately.
    if (browser.sidebarAction) browser.sidebarAction.open().catch(() => {});
  });
}

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== PERIODIC_ALARM) return;
  await ensureReady();
  await snapshotAllTracked();
});

browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.options) return;
  await ensureReady();
  const before = options;
  options = { ...DEFAULT_OPTIONS, ...(changes.options.newValue || {}) };
  setupPeriodicAlarm();
  if (before.setTitlePreface !== options.setTitlePreface) {
    for (const [windowId, sessionId] of windowToSession) {
      if (options.setTitlePreface) {
        applyTitlePreface(windowId, sessions[sessionId] && sessions[sessionId].name);
      } else {
        clearTitlePreface(windowId);
      }
    }
  }
});

browser.runtime.onInstalled.addListener(async () => {
  await ensureReady();
  setupPeriodicAlarm();
  setupSidePanel();
});

browser.runtime.onStartup.addListener(async () => {
  await ensureReady();
  setupPeriodicAlarm();
  setupSidePanel();
});

/* ---------------- sidebar / options API ---------------- */

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Use sendResponse + `return true` rather than returning the promise:
  // Chrome/Edge's onMessage ignores a returned promise, so the promise-return
  // pattern (which Firefox honors) would silently drop every response on Edge.
  handleMessage(msg).then(
    (result) => sendResponse(result),
    (err) => {
      console.error("Session manager message failed:", err);
      sendResponse(undefined);
    }
  );
  return true;
});

async function handleMessage(msg) {
  await ensureReady();
  switch (msg && msg.type) {
    case "getState":
      return {
        sessions: Object.values(sessions),
        options,
        untrackedWindows: await getUntrackedWindows(),
      };
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
    case "transferTab":
      return transferTab(msg.source, msg.targetSessionId, msg.copy);
    case "focusWindow":
      return focusWindow(msg.windowId);
    case "focusTab":
      return focusTab(msg.windowId, msg.tabId);
    case "closeSession":
      return closeSession(msg.sessionId);
    case "exportSessions":
      return exportSessions();
    case "exportSession":
      return exportOneSession(msg.sessionId);
    case "importSessions":
      return importSessions(msg.data);
  }
  return undefined;
}
