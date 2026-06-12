# Window Session Manager

A Firefox extension that treats **each window as a named session**. Tracked
windows are auto-saved continuously; the sidebar lists every session — open or
closed — and clicking a closed one reopens it as a new window with all its
tabs.

## Install (development)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and pick `manifest.json` in this folder.
3. The Sessions sidebar opens automatically (or press the toolbar button /
   `View → Sidebar → Sessions`).

For a persistent dev workflow, [`web-ext`](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/)
works too: `npx web-ext run` from this directory.

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
- **Auto-track new windows** (off by default, see Options): every new window
  becomes a session automatically. The name comes from the Window Titler
  preface when present (checked ~1.5 s after the window opens, to give Window
  Titler time to apply it), otherwise a timestamped name is used. Private
  windows are never auto-tracked.
- **Tab list**: the ▸ chevron on a session expands its saved tabs (favicon,
  pinned marker, title). Clicking a tab in an **open** session focuses that
  tab; in a **closed** session it opens just that tab in the current window
  without restoring the whole session.
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

## Ideas / future work

- Keyboard shortcut (`commands` manifest key) to save or open the sidebar.
- Sync sessions across machines via `storage.sync` (size limits apply).
