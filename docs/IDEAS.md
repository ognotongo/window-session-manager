# Ideas & Future Enhancements

A living backlog of potential enhancements for Window Session Manager. Nothing
here is committed work — it's a menu to pull from. Each item has a rough
**effort** (S / M / L) and **impact** estimate, plus notes on dependencies or
gotchas. Items marked _(discussed)_ came up during development and were
deliberately deferred.

## Guiding principles

Decisions should be weighed against these, which is what the extension already
optimizes for:

- **Local & private.** Data stays in `storage.local`; no servers, no telemetry,
  no accounts. Anything touching the network or external storage must be
  opt-in and clearly disclosed.
- **One codebase, two browsers.** A single MV3 source runs on Firefox and
  Chromium (Edge); Firefox-only capabilities are feature-detected and gated.
  New features should degrade gracefully where an engine lacks an API rather
  than fork the code.
- **Minimal permissions.** Don't add a permission without a concrete,
  user-visible payoff; store reviewers (and users) scrutinize them.
- **The window is the unit.** A session is a window + its tabs. Features should
  reinforce that model, not blur it.

---

## Core session management

| Idea | Effort | Impact | Notes |
|---|---|---|---|
| **Session history / versioning** | L | High | Keep the last N tab-list snapshots per session so you can roll back after accidentally closing/navigating. Storage cost grows; needs pruning. Pairs well with per-session storage keys (below). |
| **Partial restore** | M | High | Checkbox-select which tabs to reopen instead of the whole window. Natural extension of the existing expand-tab UI. |
| **Restore into current window** | S | Med | Option to append a session's tabs to the focused window instead of opening a new one. |
| **Move / copy a tab between sessions** | M | Med | Drag a tab from one expanded session into another, or a context-menu "Send to session…". |
| **Duplicate a session** | S | Low | One-click clone of a closed session's tab list. |
| **Merge / split sessions** | M | Med | Combine two closed sessions, or split selected tabs into a new one. |
| **Soft delete / undo** | S | Med | Move deletes to a short-lived trash with an undo toast instead of the current two-click confirm. |
| **Session templates** | M | Med | Predefined URL sets ("Morning routine") that open as a fresh tracked window. |
| **Auto-archive stale sessions** | M | Low | Optionally fold closed sessions untouched for N days into an Archived group. |

## Organization & navigation

| Idea | Effort | Impact | Notes |
|---|---|---|---|
| **Search / filter box** | M | High | Filter sessions and tabs by name/URL/title in the sidebar header. High value once the list grows. |
| **Tags or folders** | L | Med | Group sessions beyond Open/Closed/Untracked. Adds data-model complexity. |
| **Pin / favorite sessions** | S | Med | Keep important sessions at the top of the list. |
| **Per-session color or icon** | S | Low | Visual differentiation; could also drive a window-title or tab-group color. |
| **Drag-and-drop reordering** | M | Low | Manual ordering of sessions; needs a persisted order field. |
| **Command palette / quick switcher** | M | Med | Keyboard-driven jump-to-session. Depends on a search index. |

## Keyboard & browser integration

| Idea | Effort | Impact | Notes |
|---|---|---|---|
| **Keyboard shortcuts (`commands`)** _(discussed)_ | S | Med | Open the panel, Save now, track current window, quick-switch. Add the `commands` manifest key + handlers. |
| **Browser context-menu integration** | M | Med | Right-click a page/link → "Add to session…". Needs the `contextMenus`/`menus` permission. |
| **Tab group preservation** | L | Med | Save/restore native tab groups (names, colors, collapsed state). APIs differ across engines; Firefox tab-group support is newer. |

## Sync, backup & portability

| Idea | Effort | Impact | Notes |
|---|---|---|---|
| **`storage.sync` cross-device** _(discussed)_ | M | High | Sync sessions across machines via the browser account. Tight size quotas (~100KB total, ~8KB/item) force chunking and a sessions-too-large fallback. |
| **Scheduled / automatic backup** | S | Med | Periodic JSON export to the Downloads folder; needs the `downloads` permission for a quiet save. |
| **Import from other managers** | M | Med | Map OneTab / Session Buddy / Tab Session Manager export formats into our import path. |
| **Optional cloud storage** | L | Low | User-provided Drive/Dropbox backend. Significant privacy surface — must be opt-in and clearly scoped. |

## Cross-browser parity (Chromium/Edge)

| Idea | Effort | Impact | Notes |
|---|---|---|---|
| **Chrome lazy restore** _(discussed)_ | M | Med | On Firefox, inactive tabs restore `discarded`; Chromium's `tabs.create` rejects that. Create normally, then `tabs.discard(id)` so large restores stay light. See the `isFirefox` gate in `openSession`. |
| **Chromium restart re-association** _(discussed)_ | M | Med | Firefox tags windows via `sessions.setWindowValue`; Chromium can't, so open sessions become closed after a browser restart. Heuristic re-link by matching saved tab URLs to restored windows. |
| **Session-name-in-title alternative on Chromium** | L | Low | Chromium won't let extensions set window titles. No clean equivalent; likely "won't fix," documented as a known gap. |

## Privacy & data hygiene

| Idea | Effort | Impact | Notes |
|---|---|---|---|
| **Exclude-URL patterns** | S | Med | Let users keep matching URLs (banking, localhost, query-token links) out of saved sessions entirely. |
| **Encryption at rest** | L | Low | Optional passphrase to encrypt stored URLs/titles. Real key-management complexity; most users won't need it. From the security review: URLs are currently stored plaintext in `storage.local`. |
| **Strip credentials from saved URLs** | S | Low | Drop `user:pass@` and optionally known token query params before persisting. |

## Reliability & architecture

| Idea | Effort | Impact | Notes |
|---|---|---|---|
| **Per-session storage keys** _(discussed)_ | M | Med | `persistSessions` rewrites the entire `sessions` blob on every change — the main scalability ceiling. Split into `session:<id>` keys (or IndexedDB) so one change writes one record. Needs a migration. |
| **Storage-schema versioning** | S | Med | Add a `schemaVersion` and a migration step in `rebuildState` so future format changes upgrade old data safely. |
| **Quota monitoring** | S | Low | Warn when `storage.local` usage approaches limits. |
| **Cache untracked-window enumeration** _(discussed)_ | M | Low | `getState` enumerates all windows+tabs each call; coalescing the sidebar refresh mitigated frequency. A cache invalidated on window/tab events would cut per-call cost. |

## Tooling & project quality

| Idea | Effort | Impact | Notes |
|---|---|---|---|
| **Unit tests** | M | High | The pure logic (name derivation, `sanitizeImportedTab`, reconcile, import dedup) is very testable with mocked browser APIs (e.g. vitest + `sinon-chrome`). |
| **CI (GitHub Actions)** | S | Med | Run `web-ext lint` + `node --check` + tests on every PR. |
| **Release script** | S | Med | One command to bump the version in **both** manifests, build `dist/firefox` and `dist/chrome`, and zip — avoids the manual version-bump-in-two-places step. |
| **AMO / Edge publish automation** | M | Low | `web-ext sign` for AMO; Edge Add-ons API for Partner Center uploads. |
| **Type checking via JSDoc + `tsc`** | M | Low | Catch shape bugs without a full TypeScript migration. |
| **CHANGELOG** | S | Low | User-facing change log per release. |

---

## Suggested near-term picks

If pulling the next few items, these give the most value per unit of effort and
stay within the guiding principles:

1. **Search / filter box** (M / High) — the single biggest usability win as the
   session list grows.
2. **Keyboard shortcuts** (S / Med) — cheap, and expected of a power-user tool.
3. **Partial restore** (M / High) — builds directly on the existing expandable
   tab UI.
4. **Unit tests + CI** (M / High) — locks in the behavior we keep iterating on
   and makes future changes safer.
5. **Release script** (S / Med) — removes the recurring two-manifest version
   bump as a manual footgun.
