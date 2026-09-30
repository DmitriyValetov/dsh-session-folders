Hi! Thanks for this plugin — the session-folders browser is the one thing I missed after moving to the 0.2.x line. I ported it to **DSH 0.2.0-rc.1** and it runs live in my desktop profile; here is the patch and every drift I hit, in case you want to fold it into the package (happy to open it as a PR, or to adapt it to whatever shape you prefer).

### What drifts on 0.2.0-rc.1

| Area | 0.1.x (current package) | 0.2.0-rc.1 |
|---|---|---|
| Store factory | `require("@deepseek-ai/dsh-client-runtime/client").defineStore` | `require("@deepseek-ai/dsh-client-store").defineStore` — same `{init, persist, actions}` declaration; `@deepseek-ai/dsh-client-runtime` no longer exists |
| Navigation | `ctx.sessions.open(id)` | `ctx.uiWorkspace.openSession(id)` |
| Archive | `ctx.workspaces.archiveSession(id)` | still present on `ctx.workspaces`, but `ctx.uiWorkspace.archiveSession(id, {stopActivity})` is the UI-domain route |
| Directory picking | `ctx.workspaces.pickDirectory()` | `ctx.uiWorkspace.pickDirectory()` |
| Session start / connect | `ctx.workspaces.startSession/connectWorkspace` | `ctx.uiWorkspace.startSession/connectWorkspace` |
| Workspace list refresh | `ctx.workspaces.refresh()` | removed; the projection follows the Host's changed frames (a no-op is enough) |
| Open workspace folder | `ctx.workspaces.openPath(path)` | removed; the host half now serves `GET /open-in-app/apps` + `POST /open-in-app/open` with `{app, path}` (the same pair the official split button posts to) |
| Icon set | size suffixes (`IconCloseFill14`, `IconFolderClose16`, …) | weight suffixes, no aliases (`IconCloseFillMedium`, `IconFolderCloseRegular`, …) — 13 call sites renamed |
| Client inject list | `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime", …]` | `[]`: `react`/`react-dom`/`dsh-client-store`/`dsh-client-ui-primitives` are platform seeds; the runtime package is gone |
| Host imports | `import { defineDomain } from "@deepseek-ai/dsh-storage-domain"`, `import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm"`, `zod` as a peer | see below — this is the one thing that needs your decision |

Slot, service, and data contracts otherwise match: `sidebar.workspaces` stays a `single` root slot (the port keeps `priority: -1`), the component receives `wide`/`expandSidebar`/`useSessions`/`useWorkspaces`/`useStore`/`actions`/`t` exactly as 0.2.0 binds them, `WorkspaceView` and the session summaries keep `workspaceId`/`path`/`title`/`sessionIds`/`displayTitle`/`pendingInteraction`/`origin`/`blank`/`updatedAt`, `archivedSessionIds` still ships in the workspace snapshot, and `ctx.webServer.register({kind: "exact", path, handler})`, `ctx.storageDomain.open/get`, `ctx.workspaceRegistry.list()` are unchanged.

### The host-side import boundary (needs your call)

A profile plugin resolves modules from the profile's own `node_modules`, so harness packages are only importable there if they are actually installed:

- On my machine the desktop profile sets `autoInstallPeers: false` (`pnpm-workspace.yaml`), so your `peerDependencies` on `@deepseek-ai/dsh-workspace` / `@deepseek-ai/dsh-storage-domain` are **not** installed, and `lib/index.js` fails to import at activation ("failed to import") — the whole plugin stays dead.
- `@deepseek-ai/dsh-llm` is only a `devDependency`, so the auto-rename route cannot import `BlockAssembler`/`createUserMessage` in any profile.

In my port I:
1. inlined `defineDomain` (validation only — name/version/table checks and the "global schema must not accept null" rule) — no structural change to your domain spec;
2. moved `zod` from `peerDependencies` to `dependencies` (self-contained install, no reliance on the profile's hoisting);
3. **removed** the auto-rename route, its client menu entry, and the `sessionTitle`/`llm` inject entries. If you want to keep auto rename, the alternatives are to declare `@deepseek-ai/dsh-llm` (and its peers) as real dependencies, or to keep the stream call and assemble the text locally instead of importing the assembler — your call, I only removed the feature because it cannot resolve as published.

`package.json` edits that go with the patch:

```jsonc
"dsh": { "client": { "inject": [], "platform": "web" } },   // was the 0.1.x package list
"dependencies": { "zod": "^4.4.3" },                        // moved out of peerDependencies
"peerDependencies": { "react": "^18.2.0", "react-dom": "^18.2.0" }   // harness peers dropped; react-dom optional
```

### Verification

Live on the packaged desktop app, DSH `0.2.0-rc.1` (macOS), after installing the patched package into the desktop profile:

- host half: entry `fiberPhase: active`; `POST /dsh-session-folders/list` → `200 {"folders":[],"workspaceOrder":[],"pinnedLoose":{}}`; the storage domain `dsh_session_folders` initializes and persists (`~/.dsh/storages/dsh_session_folders.json`);
- create/rename/delete/move/reorder/pin/unarchive routes exercised with real workspace ids (validation against `ctx.workspaceRegistry.list()` bites as expected: `404 workspace-not-found`, `409 name-conflict`);
- client half: `sidebar.workspaces` occupants read back as `dsh-session-folders/client` at `priority: -1` (`active: true`) with the official browser at `priority: 0` (`active: false`) — i.e. the entry registers, renders without abdicating, and shadows as designed;
- only `react`, `react-dom`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-primitives` are required at runtime; all primitives/icons used by the port were checked against the 0.2.0 bundles.

What I could not check statically (worth a look on a real page before release): the prop contracts of the higher-level primitives (`Menu`, `Modal`, `Toast`, `Tooltip`) — they render fine here, but I did not diff their 0.1.x/0.2.0 signatures.

The full diff against 0.4.3 (verified with `git apply --check -p1` on a pristine package) lives in my fork: https://github.com/DmitriyValetov/dsh-session-folders (tag `v0.5.0`) — patch: https://github.com/DmitriyValetov/dsh-session-folders/blob/v0.5.0/upstream/port-to-dsh-0.2.0.patch

Thanks again — and if you would rather keep one package than two, I will happily drop mine as soon as yours carries the 0.2.x line.
