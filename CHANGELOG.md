# Changelog

## v0.5.1

### Fixed

- **Reinstalling or reloading the plugin no longer takes the host down.** The host mounts the next generation of an entry
  before disposing the previous one, and `ctx.storageDomain.open("dsh_session_folders")` rejects an already-open name with
  `DomainError: domain ... is already open` — reported by the host as `dsh: fatal load failure`, which kills the whole
  application process and not just this entry (the same failure class as the upstream "plugin prevents DSH from starting"
  reports). The entry now reuses the live domain through `ctx.storageDomain.get` when one exists
- The package keeps its unscoped name so the bundle row, the installed dependency and the client module id stay identical
  (the npm fork carries the same code under the maintainer scope, renamed)

## v0.5.0 — fork port to DSH 0.2.0-rc.1

Fork of upstream `dsh-session-folders@0.4.3` (MIT, © Eugene), ported to the DSH 0.2.0-rc.1 web client and host
contract; published under a new package name. Full reasoning per change: [FORK-NOTES.md](FORK-NOTES.md).

### Changed

- Client store: `@deepseek-ai/dsh-client-runtime/client` (gone in 0.2.x) → the platform seed `@deepseek-ai/dsh-client-store`; same `defineStore({init, persist, actions})` declaration
- Navigation, archive, and directory picking moved to the `uiWorkspace` client service (`openSession`, `archiveSession`, `pickDirectory`, `startSession`, `connectWorkspace`); the client `inject` list follows (`uiWorkspace` added, stale package list dropped)
- "Open in folder" now uses the host's `GET /open-in-app/apps` + `POST /open-in-app/open` pair (the previous `ctx.workspaces.openPath` no longer exists); the row keeps hiding the action when no file manager is resolved
- All 13 icon call sites renamed from the removed size suffixes to the weight suffixes (`IconCloseFill14` → `IconCloseFillMedium`, `IconFolderClose16` → `IconFolderCloseRegular`, …)
- Host half no longer imports harness packages (a profile plugin resolves modules from its own profile): the storage-domain declaration helper is inlined with the same validation, and `zod` is a runtime dependency instead of a peer
- Workspace-project refreshes rely on the host's changed frames (`ctx.workspaces.refresh()` was removed); the hook is a no-op

### Removed

- **Auto rename** (its context-menu entry, the `/auto-rename` route, and the `sessionTitle` / `llm` host injections): the route needed `@deepseek-ai/dsh-llm`, a devDependency that a profile plugin cannot import. Everything else — folders, drag-and-drop, context menus, pin, archive/restore, search, Recent, focus, collapse-all, session ID badge, tree guides — is unchanged

### Compatibility

- Targets DSH `0.2.0-rc.1` (verified in the packaged desktop app: host entry active, client entry occupying `sidebar.workspaces` at `priority: -1`, folder routes exercised against live workspace ids). Data keeps the upstream storage domain name `dsh_session_folders`, so folders created by the 0.1.x package remain readable

## v0.4.3 (2026-08-21)

### Added

- **Session ID badge**: hovering a session row reveals a small `id` badge left of the quick-archive button; one click copies `session-<id>` of that row to the clipboard (clipboard API with an execCommand fallback), the badge flashes a check mark for a moment, and the row itself is not opened
- **Folder tree guides**: a semi-transparent dashed trunk drops from each folder icon through the icon column to its sessions, with a small tick toward every session title; the session status icon paints over the line, as intended. When a folder holds the open session, its whole guide tree paints business blue. Drawn with pure CSS pseudo-elements (no measuring — scrolling and layout changes are free). Toggled by a new header button (on by default, persisted per browser)
- **Recent origin card**: hovering a session in the Recent section pops a small card to the right of the row (outside the list, portaled to the page body) showing the workspace and folder the session lives in — no more guessing where a Recent session belongs. Hides with the hover; replaces the native time tooltip on those rows. Clicking such a session reveals its home: the workspace group and folder expand and the list scrolls to the original row
- **Workspace focus mode**: hovering a workspace row reveals a crosshair toggle (also in the row's context menu); when on, only that workspace is listed — Recent, other workspaces, the Ungrouped bucket and the end-of-list drop zone hide until the focus is toggled off. Ephemeral by design: a restart shows everything again; a focused workspace that disappears unfocuses safely

### Changed

- The open session is now highlighted with a firm blue tint everywhere (Recent and the main tree) instead of the pale gray hover color that was easy to miss

## v0.4.2 (2026-08-21)

### Fixed

- Sidebar layout: with enough expanded folders/sessions to scroll, workspace group rows overlapped the sessions above them — the scrolling flex column squeezed list items below their content (loose buckets collapsed to their 4px minimum, the end-of-list drop zone to zero) and the rows inside painted over the neighbouring groups; list children no longer shrink (`flex-shrink: 0`)

## v0.4.1 (2026-08-21)

### Added

- Auto rename: a second concurrent auto-rename of the same session gets an immediate localized "already running" notice instead of racing the first model stream
- Pure folder helpers (name parsing, conflict check, exact-id-set validation, auto-title normalization) extracted into `lib/folder-utils.js` with a minimal `node:test` suite (`npm test`)

### Fixed

- Route hardening: every plugin route rejects non-JSON content types (400), cross-site fetches (403), and browser requests whose Origin does not match the Host (403); same-origin UI flows and Origin-less clients (curl/scripts) are unaffected
- Unarchive: the read-filter-write-poke of the registry's archive set runs inside the workspace registry's operation queue, so a concurrent archive from another browser can no longer lose an update (logged direct-write fallback when the queue is unavailable); missing workspace internals now answer 500 `workspace-internals-changed` instead of failing mid-write
- Restore-by-click reuses an existing "restored" folder regardless of letter case, and case-variant "Restored" folders no longer appear in the move submenu
- READMEs: auto-rename wording corrected to the actual "at most 3 words" cap in all three languages

## v0.4.0 (2026-08-20)

### Added

- Drag-and-drop reordering: workspace rows and folder rows can be dragged to new positions (folders always stay above the loose sessions; session sorting by time is unchanged); the order is persisted server-side
- Row actions moved to right-click context menus on session, folder, and workspace rows (the per-row "…" buttons are gone); every menu item carries an icon
- **Pin / Unpin sessions**: a pinned session always sits first in its folder or in the loose bucket; pin state is persisted server-side and follows the session across moves
- A pinned session with no status badge shows a small pin icon in its status slot
- **Archive block**: an archive icon on the workspace row shows/hides a virtual Archive folder with every archived session of the workspace (struck icon while shown); dropping a session onto it archives it (same as the context-menu action), dropping an archived session onto a folder or the loose area restores it there
- **Restore from the Archive**: right-click an archived session → "Restore to original folder" (the session returns where it was); click an archived session to restore it into the workspace's **Restored** folder (created on demand, always listed first, hidden while empty) and open it in chat
- **Show more / Show less** in every folder and the Archive block: at most five sessions are shown until the overflow row is clicked (mirrors the original session browser)
- **New session buttons**: a plus on a workspace row starts a session in that workspace; a smaller plus on a folder row starts a session directly inside that folder
- **Quick archive on hover**: hovering a session row swaps the timestamp for a small archive icon; clicking it archives the session (the swap happens in place, so the layout never shifts)
- **Open workspace folder**: the first button on a workspace row (folder icon) opens the workspace root directory in the system file manager (host's native `openPath` API)
- Restoring a session with a click now expands the **Restored** folder automatically when it was collapsed, so the restored session is immediately visible
- **Recent section**: above the workspace list, the five most recent workspace sessions (folders + loose area); clicking one opens it and highlights it in Recent and in its workspace/folder; the header collapses the section (state persists, Collapse all / Expand all apply)
- **Inline rename**: double-click a session title to edit it in place (Enter commits, Esc cancels; folders keep the click-to-collapse behavior, renaming stays in the context menu)
- **Auto rename**: the session context menu gains "Auto rename" — the session's own model reads its first user message and derives a short 3-4 word title (a description of the process, feature, or task, in the message's language); the result is pinned exactly like a manual rename and never overwritten by automatic title generation. Live sessions only (closed ones show a clear notice); errors are localized

### Fixed

- New-workspace dialog: a double click (or a second click before the button re-renders) no longer opens a second native folder picker; a busy guard ignores repeat clicks while one pick is in flight
- New-workspace dialog: the "Couldn't create the workspace" error after a successful create is gone — the success check now matches the client service contract (it throws on failure and returns the workspace entity on success)
- "Move to folder → New folder…": the flow crashed (`confirmNewFolder is not defined`); the function is restored as its own top-level handler and the rename-folder handler no longer swallows it
- Auto rename: the model token budget is raised to 512 so reasoning-style models finish their chain of thought and still emit the title; the title wording is capped at 3 words (prepositions not counted), reasoning is explicitly forbidden in the prompt
- Open workspace folder: the button keeps using the standard harness `host.openPath` RPC (multiplatform); an earlier experiment with a plugin route spawning the file manager directly was reverted per review
- Workspace drag-reorder: a drop zone below the last workspace row lets a dragged workspace be placed at the end of the list (previously a drop into the empty space below was ignored)

## v0.3.0 (2026-08-19)

### Added

- "New folder…" inside the "Move to folder…" submenu: create a folder and move the session into it in one go
- "Expand all" header button next to "Collapse all"; both buttons now collapse/expand every workspace group and folder, including ones created after the last manual toggle

## v0.2.0 (2026-08-19)

### Added

- Initial public release: one level of named folders per workspace in the sidebar; sessions can be moved into/out of folders by drag-and-drop or context menu; server-side persistence; search and status badges mirror the built-in session browser
