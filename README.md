# Window Session Manager

A browser extension that treats **each window as a named session**. Tracked
windows are auto-saved continuously; a sidebar (Firefox) / side panel
(Edge, Chrome) lists every session — open or closed — and clicking a closed
one reopens it as a new window with all its tabs.

It is a single Manifest V3 codebase: the shared `background.js` feature-detects
Firefox-only capabilities (window title preface, container tabs, restart
re-association via the sessions API) and gates them, so the same code runs on
Chromium. Only the manifest differs per browser, assembled by `build.js`.

## Install (development)

**Firefox** — load the source folder directly:

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and pick `manifest.json` in this folder.
3. The Sessions sidebar opens automatically (or press the toolbar button /
   `View → Sidebar → Sessions`).

`npx web-ext run` from this directory also works for a live-reload workflow.

**Edge / Chrome** — Chromium needs a different manifest (service worker +
side panel), so build the target folder first:

1. `node build.js chrome` — produces `dist/chrome/`.
2. Open `edge://extensions` (or `chrome://extensions`), enable **Developer
   mode**, click **Load unpacked**, and select the `dist/chrome` folder.
3. Click the toolbar button to open the Sessions side panel.

`node build.js` with no argument builds both `dist/firefox/` and
`dist/chrome/`. Re-run it after changing shared files (the build copies a
snapshot; it is not a live link).

### Cross-browser differences

The core experience is identical, but some Firefox features have no Chromium
equivalent and are silently absent on Edge/Chrome:

- **Window title preface** (showing the session name in the title bar) and the
  **Window Titler** name integration — Chromium does not let extensions set or
  read window titles.
- **Container tabs** (`cookieStoreId`) — Chromium has no containers.
- **Restart re-association** — Firefox tags windows via the sessions API so
  they re-link to their sessions after a browser restart; Chromium has no
  equivalent, so on Edge/Chrome open sessions become closed after a restart
  (restore them with a click).
- **Lazy restore** — on Firefox non-active tabs restore unloaded; on Chromium
  they load normally.

## How it works

- **Tracking**: In the sidebar, click *Track this window* to turn the current
  window into a session. Each session stores its tabs' URL, title, pinned
  state, active tab, and container (Multi-Account Containers `cookieStoreId`).
- **Auto-save**: Firefox provides no way to read a window's tabs *after* it
  closes, so the extension snapshots tracked windows on every tab change
  (debounced ~750 ms) plus an optional periodic timer (default 30 s,
  configurable in Options). When the window closes, the last snapshot simply
  becomes the closed session. A 💾 button in the sidebar forces a save.
- **Window Titler integration**: Extensions cannot read each other's storage,
  so the name is recovered from the window *title* instead — Window Titler
  works by setting a `titlePreface`, which is visible to other extensions via
  the `windows` API. The preface (brackets stripped) is offered as the default
  name when you start tracking; if there is none, you just type a name. This
  behavior can be turned off in Options.
- **Restore**: Clicking a closed session opens a new window. Only the
  previously active tab actually loads; all other tabs are created
  *discarded* (lazy-loaded, showing their saved titles) so restoring a
  50-tab session is instant and cheap. Clicking an **open** session focuses
  its window instead.
- **Restart-proof**: Tracked windows are tagged via the `sessions` API, so if
  Firefox restarts and restores your windows (or you use *Reopen Closed
  Window*), they are re-associated with their sessions automatically.
- **Session name in the window title** (on by default, see Options): the
  session name is written into the window title (`titlePreface`) when you
  track, rename, or restore a session, so windows stay visibly labeled — the
  same mechanism Window Titler uses. Renaming in the sidebar therefore
  updates the title bar immediately. Caveat: Window Titler's own stored
  names cannot be updated from outside, so if you also name the same window
  there, the two extensions overwrite each other (last writer wins,
  e.g. after a restart). Best used as a replacement for Window Titler on
  tracked windows.
- **Track all**: the ➕ button in the sidebar header tracks every currently
  untracked window at once, naming each from its Window Titler preface when
  present (timestamped fallback otherwise). Private windows are skipped.
- **Auto-track new windows** (off by default, see Options): every new window
  becomes a session automatically. The name comes from the Window Titler
  preface when present (checked ~1.5 s after the window opens, to give Window
  Titler time to apply it), otherwise a timestamped name is used. Private
  windows are never auto-tracked.
- **Tab list**: the ▸ chevron on a session expands its saved tabs (favicon,
  pinned marker, title). Clicking a tab in an **open** session focuses that
  tab; in a **closed** session it opens just that tab in the current window
  without restoring the whole session.
- **Current session**: the session backing the window you're in is marked with
  an accent stripe and a *current* badge in the Open list, so it's obvious at a
  glance which session you're looking at.
- **Search**: the header search box filters the session list by name, tab
  title, or URL, and gathers every matching tab — across open *and* closed
  sessions — into a dedicated **Search results** section under the Open list.
  Each result shows its parent session and, when clicked, focuses the tab if
  its session is open or opens it in the current window if closed.
- **Move / copy tabs between sessions**: drag any tab row (from an expanded
  session or untracked window) onto a session to move it there; hold **Ctrl**
  while dropping to copy instead. Right-clicking a tab offers the same *Move
  to* / *Copy to* choices as a menu. When the target session is **open** the
  tab is moved into its live window (a live tab is physically relocated via
  `tabs.move`); when it's **closed** the tab is appended to its saved list.
- **Right-click menu**: right-clicking a session offers *Close session* /
  *Open session* (depending on its state — closing takes a final snapshot
  first) and *Export session…*, which downloads just that session as a JSON
  file that the importer accepts. The matching 📂 button in the sidebar
  header imports a JSON export (single-session or full) without leaving the
  sidebar.
- **Export / import** (in Options): export downloads all sessions as a JSON
  file; import merges them back as closed sessions. Re-importing the same
  file updates sessions in place rather than duplicating, and never
  overwrites a session that is currently open.

## Limitations

- Privileged pages (`about:config`, `about:addons`, `file://`, other
  extensions' pages) cannot be opened by an extension and are skipped on
  restore.
- If a saved tab belonged to a container that no longer exists, it is
  restored in the default container.
- The Window Titler name is read when you *start tracking*; renaming the
  window later does not rename the session (use the sidebar's ✎ button).

## License

[Mozilla Public License 2.0](LICENSE).

## Ideas / future work

See [docs/IDEAS.md](docs/IDEAS.md) for the full enhancement backlog (organized
by theme, with effort/impact estimates and near-term picks).
