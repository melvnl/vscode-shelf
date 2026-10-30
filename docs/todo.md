# VSCode Shelf Extension — Progress & Todo

## Status snapshot (as of 2026-10-31)

**Working end-to-end:**
- ✅ Project folder: `/Users/melvin.fa/Documents/private/personal/vscode-shelf/`
- ✅ Rich PyCharm-style Shelve Changes modal (name, description, file tree with cascade checkboxes, revertAfter toggle)
- ✅ Shelve from Source Control right-click (per-file or whole changelist)
- ✅ Lazy git repo detection (survives git extension cold-start race)
- ✅ Patch generation + application via git CLI, with untracked file snapshots
- ✅ Auto `.git/info/exclude` entry so shelf storage never appears in Source Control
- ✅ Side-by-side diff viewer for every file in a shelf (reconstructed via `diff` npm package)
- ✅ Conflict pre-check on unshelve — modal error + shelf preserved on conflict
- ✅ Soft delete with Recently Deleted bucket + Recover
- ✅ Error surfacing via dedicated `Shelf` output channel

**Known limitations (deferred to v2):**
- No binary file diffs (unified diff can't encode them)
- No per-hunk shelving (just per-file)
- Diff view pane labels can't be custom-named ("Base version" / "Shelved version") — a VSCode API limitation
- Base content is reconstructed from current HEAD, not stored at shelf creation time — diff may look off if HEAD moved after shelving

---

## What is PyCharm Shelf (and what makes it different from git stash)?

PyCharm Shelf is **not** a git stash wrapper. Key distinctions:

| | PyCharm Shelf | git stash |
|---|---|---|
| Storage | Unified diff/patch files on disk | Git object store (commits) |
| Named | Yes, custom name at creation | Optional message only |
| Partial shelve | Yes — per-file or per-hunk | All or nothing (without flags) |
| Survives repo deletion | Yes — files live in `.idea/shelf/` | No — tied to `.git/` |
| Visible in git log | No | No |
| Ordering | Chronological list, all visible | Stack (LIFO) |
| Apply behavior | Apply and optionally keep shelf | Pop (destroys entry) or apply |

## Technical architecture (as shipped)

**Storage: patch files + untracked snapshots** (matching PyCharm behavior)
- Store in `.vscode/shelves/<slug-timestamp>/` per project
- Each shelf = a folder with:
  - `metadata.json` — Shelf model (id, name, description, createdAt, files, branch, deleted?, deletedAt?)
  - `changes.patch` — unified diff of tracked file changes
  - `untracked.json` — content snapshots for new/untracked files (unified diff doesn't cover them)
- Soft-deleted shelves move to `.vscode/shelves/_deleted/<id>/`
- `.vscode/shelves/` auto-added to `.git/info/exclude` on first shelve — never committed, never seen by teammates

**VSCode Extension type:** Native TypeScript extension targeting VSCode `^1.90.0`

---

## Current project layout

```
vscode-shelf/
├── package.json                    # Manifest: commands, menus, views, settings
├── tsconfig.json
├── .eslintrc.json
├── .prettierrc
├── .vscodeignore
├── .gitignore
├── .vscode/
│   ├── launch.json                 # F5 → Extension Development Host
│   └── tasks.json
├── node_modules/
│   └── diff/                       # Runtime dep for in-memory patch application
├── src/
│   ├── extension.ts                # Activation + all command wiring
│   ├── ShelfManager.ts             # CRUD on shelves + .git/info/exclude management
│   ├── ShelfProvider.ts            # TreeDataProvider for the sidebar
│   ├── PatchEngine.ts              # git diff/apply + conflict pre-check
│   ├── models/
│   │   └── Shelf.ts                # Shelf, ShelfFile, ChangeType types
│   ├── ui/
│   │   ├── ShelveDialog.ts         # Webview-based rich shelve modal
│   │   └── ShelfDiffProvider.ts    # TextDocumentContentProvider for shelf-diff://
│   └── utils/
│       ├── git.ts                  # Git ext API, git CLI runner, parse porcelain
│       └── fs.ts                   # vscode.workspace.fs helpers
└── out/                            # Compiled .js
```

---

## Phase-by-phase status

### Phase 1 — Project Setup ✅ **DONE**
- [x] Initialize VSCode extension project
- [x] Set up tsconfig.json, package.json, .vscodeignore
- [x] Set up ESLint + Prettier
- [x] Set up build script (`tsc -p`)
- [x] Scaffold folder structure (as above, with added `src/ui/`)
- [x] Add `.vscode/launch.json` so F5 launches Extension Development Host

### Phase 2 — Core Data Layer ✅ **DONE**
- [x] Define `Shelf` + `ShelfFile` + `ChangeType` models (`src/models/Shelf.ts`)
- [x] Implement `ShelfManager`:
  - [x] `listShelves()` — reads all shelf folders, sorted newest-first
  - [x] `listDeletedShelves()` — reads from `_deleted/`
  - [x] `createShelf(name, files, opts)` — generates patch + untracked snapshots + writes metadata
  - [x] `restoreShelf(id, keepShelf)` — conflict pre-check then applies patch
  - [x] `deleteShelf(id)` — soft delete via rename to `_deleted/`
  - [x] `permanentlyDeleteShelf(id)` — hard delete
  - [x] `recoverShelf(id)` — restore from `_deleted/`
  - [x] `renameShelf(id, newName)` — update metadata.json
  - [x] `findShelf(id)` — look up shelf whether live or deleted
  - [x] `readUntrackedSnapshots(id, deleted)` — read untracked.json
  - [x] `getPatchFileUri(id, deleted)` — for raw patch viewer
  - [x] `ensureLocalGitIgnore()` — adds to `.git/info/exclude` idempotently
- [x] Implement `PatchEngine`:
  - [x] `generatePatch(files)` — runs `git diff HEAD --binary -- <files>` + captures untracked content separately
  - [x] `applyPatch(patch)` — pre-check with `git apply --check`, then real apply
  - [x] `canApplyPatch(patch)` — dry-run returning ok/conflict details
  - [x] `revertTracked(filePaths)` — `git checkout HEAD -- <files>`
  - [x] `deleteUntracked(filePaths)` — removes new files from working tree
  - [x] `writeUntracked(snapshots)` — restores untracked files on unshelve
  - [x] `checkUntrackedConflicts(snapshots)` — byte-compare before overwrite
  - [x] `PatchConflictError` with conflicting file list
- [x] Handle edge cases:
  - [x] Untracked files — JSON snapshots alongside patch
  - [x] No HEAD (fresh repo) — fallback to `git diff` without HEAD
  - [ ] Binary files — unified diff can't encode; **not fully handled**
  - [ ] Renamed files — detected via porcelain `R` but patch roundtrip untested
  - [ ] Merge conflict state files — untested

### Phase 3 — VSCode Git API Integration ✅ **DONE**
- [x] Access `vscode.git` extension API via `getAPI(1)`
- [x] `waitForFirstRepo(timeoutMs)` — subscribes to `onDidOpenRepository` + `onDidChangeState`
- [x] Lazy `ensureManager()` — repo resolution deferred to first command invocation; survives git ext cold start
- [x] `getChangedFiles(repoRoot)` — parses `git status --porcelain -z` into ShelfFile[]
- [x] Subscribe to `onDidOpenRepository` so tree view refreshes on new repo detection
- [ ] Multi-root workspace — currently uses `repositories[0]` only, **untested in multi-root**

### Phase 4 — UI ✅ **MOSTLY DONE**

#### 4.1 — View container placement ✅
- [x] Dedicated `shelfContainer` activity bar entry
- [x] SCM-embedded `shelfView` (visible when `scmProvider == git`)
- [x] Standalone `shelfViewStandalone` under the activity bar entry
- [ ] Activity bar icon — `resources/shelf.svg` referenced but **not yet shipped** (shows broken icon)

#### 4.2 — TreeDataProvider ✅
- [x] `ShelfProvider implements vscode.TreeDataProvider<ShelfTreeItem>`
- [x] Root → shelves (sorted newest first) + `Recently Deleted` bucket
- [x] Shelf → files with change-type icons (`diff-modified`, `diff-added`, etc.)
- [x] Deleted bucket → deleted shelves (recoverable)
- [x] Description format: `"<count> file(s), <localeDate>"`
- [x] Late-bound manager via `setManager()` for lazy git resolution

#### 4.3 — View toolbar ✅ (partial)
- [x] Shelve Changes button in navigation group
- [x] Refresh button
- [ ] Shelve Silently (command exists, no toolbar button)
- [ ] Expand All / Collapse All toolbar buttons (VSCode's native collapse-all works)
- [ ] Overflow menu with Clear Recently Deleted / Export / Import

#### 4.4 — Context menus ✅
- [x] On shelf: Unshelve, Unshelve and Keep, Rename, Delete, Show Diff, Show Raw Patch
- [x] On deleted shelf: Recover
- [x] On file inside shelf: click opens side-by-side diff (via `node.command`)
- [x] SCM resourceState context: Shelve This File...
- [x] SCM resourceGroup context: Shelve Changes...
- [ ] File inside shelf right-click: Unshelve Just This File / Remove from Shelf
- [ ] Deleted bucket: Clear All
- [ ] Deleted shelf: Delete Permanently

#### 4.5 — Shelve dialog ✅
- [x] Webview panel (not QuickPick chain) — rich HTML form
- [x] Shelf name text input (pre-filled, auto-focused + selected)
- [x] Description textarea
- [x] File tree with checkboxes, folder cascade, indeterminate parent state
- [x] "Remove changes from working copy after shelving" toggle (default from `shelf.revertAfterShelve`)
- [x] Live `N of M selected` summary
- [x] Submit disabled when name empty or 0 files selected
- [x] Change-type badges (modified / added / deleted / renamed) with VSCode theme colors
- [x] Preselection support — right-click a file → modal opens with only that file checked
- [ ] Inline diff viewer below the tree (PyCharm has this; deferred to v2 — significant work)
- [ ] Changelist dropdown (we only have one implicit changelist)

#### 4.6 — SCM Resource Group integration ❌ **NOT DONE**
- [ ] Shelved resources rendered inline with Changes/Staged
- [ ] (Low priority — tree view already serves this purpose)

#### 4.7 — Status bar indicator ❌ **NOT DONE**
- [ ] `vscode.window.createStatusBarItem` showing shelf count

#### 4.8 — Welcome view ✅
- [x] `contributes.viewsWelcome` with Shelve Current Changes button + Learn more link

#### 4.9 — Notifications & progress ✅
- [x] `vscode.window.withProgress` on shelve/unshelve
- [x] Success toasts on successful ops
- [x] Error toasts with "Show Log" action opening the Shelf output channel
- [x] Modal confirmation before delete (gated by `shelf.confirmBeforeDelete`)
- [x] **Modal error for unshelve conflicts** — explicit file list + "shelf preserved" message

### Phase 5 — Commands ✅ **DONE**
- [x] `shelf.shelveChanges` — opens modal, shelves selected files
- [x] `shelf.shelveSilently` — shelves all with auto-generated name
- [x] `shelf.shelveThisFile` — right-click file → modal with that file preselected
- [x] `shelf.unshelve` — restore + delete shelf (with conflict pre-check)
- [x] `shelf.unshelveAndKeep` — restore without deleting shelf
- [x] `shelf.deleteShelf` — soft delete with optional confirm
- [x] `shelf.renameShelf` — inline input
- [x] `shelf.showDiff` — opens side-by-side diff for every file in the shelf
- [x] `shelf.showRawPatch` — opens the raw unified-diff file (debug/power user)
- [x] `shelf.openFileDiff` — fired when user clicks a file node in the tree
- [x] `shelf.recoverDeleted` — restore from Recently Deleted
- [x] `shelf.refresh`
- [x] `shelf.openSettings`
- [x] `shelf.showLog` — opens the Shelf output channel

### Phase 6 — Settings ✅ **DONE**
- [x] `shelf.storageLocation` — `workspace` (default) / `global` *(global storage not yet implemented in code)*
- [x] `shelf.revertAfterShelve` — default true
- [x] `shelf.showInSourceControlPanel` — default true
- [x] `shelf.maxDeletedShelves` — default 10 *(enforcement not yet implemented)*
- [x] `shelf.confirmBeforeDelete` — default true (gates the delete modal)
- [x] `shelf.autoLocalIgnore` — default true (controls `.git/info/exclude` write)
- [ ] `shelf.autoShelveOnCheckout` — not implemented

### Phase 7 — Diff Viewer ✅ **DONE**
- [x] URI scheme `shelf-diff:` registered via `vscode.workspace.registerTextDocumentContentProvider`
- [x] URI format: `shelf-diff://<shelfId>/<base|shelved>/<filepath>?v=before|after` — real filename as basename for language detection
- [x] `ShelfDiffProvider` reconstructs content:
  - [x] Modified file: `git show HEAD:file` + `Diff.applyPatch` in memory
  - [x] Added file: untracked snapshot content
  - [x] Deleted file: empty on `after` side
- [x] Clicking a file in the tree opens `vscode.diff` with before/after URIs
- [x] Tab title: `Shelved: filename.ext` (matches PyCharm format)
- [x] Right-click shelf → Show Diff opens one tab per file
- [x] Right-click shelf → Show Raw Patch opens the unified-diff file
- [x] `diff` npm package added as runtime dep

### Phase 8 — Keyboard Shortcuts ❌ **NOT DONE**
- [ ] Default `Cmd/Ctrl+Shift+H` for `shelf.shelveChanges`
- [ ] `contributes.keybindings` manifest entries

### Phase 9 — Edge Cases & Polish ✅ **MOSTLY DONE**
- [x] Empty workspace / no git repo — friendly info message
- [x] Patch apply conflicts — PatchConflictError with modal, shelf preserved
- [x] Untracked (never-committed) files — JSON snapshot pathway
- [x] Loading states — `withProgress` on long ops
- [x] Progress notifications
- [x] Unshelve conflict warning — modal with specific conflicting file list
- [x] Shelf name auto-suggest — defaults to `Uncommitted changes at <timestamp>`
- [x] **Harden error surfacing** — every command wrapped in `wrap(label, fn)` with output channel logging + "Show Log" toast action
- [x] **`.git/info/exclude` auto-write** — shelf storage never pollutes Source Control
- [x] **Lazy git repo lookup** — handles git extension cold-start race
- [ ] Binary file handling — no snapshot path for binaries yet
- [ ] Rename roundtrip test
- [ ] Line-ending (CRLF) on Windows

### Phase 10 — Testing ❌ **NOT DONE**
- [ ] Unit tests for `PatchEngine` (generate → apply round-trip)
- [ ] Unit tests for `ShelfManager` CRUD
- [ ] Integration: shelve → verify clean tree → unshelve → verify restored
- [ ] Binary / new / deleted / renamed roundtrips
- [ ] Multi-root workspace

### Phase 11 — Packaging & Publishing ❌ **NOT DONE**
- [ ] Design + ship `resources/shelf.svg` activity bar icon
- [ ] Write `README.md` with GIF demo
- [ ] Set up `vsce` for packaging
- [ ] Publish to VSCode Marketplace
- [ ] Add to Open VSX Registry (for VSCodium / Cursor)

---

## New tasks that emerged mid-build (post-plan)

| # | Task | Status | Notes |
|---|---|---|---|
| 6 | Harden error surfacing at activation + command boundaries | ✅ | `wrap()` helper + output channel + "Show Log" toast |
| 7 | Query `git status` to list changed files for shelving | ✅ | `getChangedFiles()` in `utils/git.ts` |
| 8 | Multi-select file picker for Shelve Changes | ✅ | Replaced by webview modal (Task 11) |
| 9 | SCM resourceState/resourceGroup context menus | ✅ | Right-click file → Shelve This File... |
| 10 | Fix git repo lookup race (git ext not ready at activation) | ✅ | `waitForFirstRepo()` + lazy `ensureManager()` |
| 11 | Build webview-based Shelve Changes modal | ✅ | `src/ui/ShelveDialog.ts` with tree checkboxes |
| 12 | Route Shelve This File through the modal with preselection | ✅ | — |
| 13 | Auto `.git/info/exclude` on first shelve | ✅ | `ShelfManager.ensureLocalGitIgnore()` |
| 14 | Pre-check patch conflicts and reject unshelve cleanly | ✅ | `canApplyPatch` + `checkUntrackedConflicts` + modal |
| 15 | Implement Show Diff via TextDocumentContentProvider | ✅ | `shelf-diff:` scheme + `diff` lib |
| 16 | Polish diff view to match PyCharm look | ✅ | `Shelved: filename` title, clean URI structure |
| 17 | Split Show Diff (per-file side-by-side) from Show Raw Patch | ✅ | Right-click shelf gives both options |

---

## Immediate next steps (ordered by value)

1. **Design + add `resources/shelf.svg`** so the activity bar icon stops showing broken
2. **Keyboard shortcut** `Cmd+Shift+H` → Shelve Changes (Phase 8)
3. **Binary file handling** — detect binaries from `git status` and snapshot them as base64 (not unified diff)
4. **Status bar indicator** showing shelf count (Phase 4.7)
5. **Multi-root workspace support** — iterate `api.repositories` and show per-repo shelf trees
6. **Unit + integration tests** — critical before publishing
7. **README + GIF demo**
8. **`vsce package` + publish**

---

## Key technical risks (status)

| Risk | Mitigation shipped? |
|---|---|
| Untracked files | ✅ JSON snapshot pathway |
| Patch conflicts on unshelve | ✅ `git apply --check` + modal error + shelf preserved |
| Binary files | ❌ Not yet — will be caught by `git apply` failure for now |
| Platform (CRLF) | ❌ Not tested on Windows |
| Performance (large diffs) | ⚠️ `withProgress` present; 64MB buffer; no streaming |

---

## Out of scope (v1)

- Shelving specific hunks within a file
- Syncing shelves across machines
- Importing PyCharm `.idea/shelf/` patches
- Full conflict resolution UI (we error out and tell user to resolve manually)
- Changelist dropdown (we only have one implicit changelist)
- Inline diff viewer embedded inside the Shelve modal (PyCharm has this)
- Fully custom pane labels "Base version" / "Shelved version" — VSCode API doesn't expose this
