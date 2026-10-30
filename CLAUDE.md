# CLAUDE.md

Context for Claude agents working in this repo. Read this before touching code.

## What this project is

A VSCode extension that replicates PyCharm's **Shelf** feature. Lets users save named snapshots of uncommitted changes (per file or per changelist) to a local-only store, then unshelve them later. Explicitly **not** a `git stash` wrapper.

The user is a backend engineer who lives in PyCharm for Python work and VSCode for frontend/fullstack work, and misses shelves when switching tools. Target: visual + behavioral parity with PyCharm's shelf, within what the VSCode API allows.

## Core architectural decisions (do not re-propose these)

| Decision | Why |
|---|---|
| **Patch-based storage, not git stash** | Stash pollutes `git stash list`, breaks the "local only" contract, LIFO instead of a flat named list. Shelves live in `.vscode/shelves/<id>/` with `metadata.json` + `changes.patch` + optional `untracked.json`. |
| **`.git/info/exclude`, not project `.gitignore`** | Local-only per-repo ignore. Shelves never appear in Source Control, never touch any file teammates see. Written on first shelve via `ShelfManager.ensureLocalGitIgnore()`. |
| **Webview panel for shelve dialog, not floating modal** | VSCode's extension API does not expose floating HTML modals. Every rich extension (GitHub PRs, Jupyter, Live Share) uses editor-tab webviews for the same reason. Don't try to build one. |
| **Lazy git repo lookup** | The vscode.git extension initializes asynchronously after our `activate()`. Blocking there races — `getPrimaryRepoRoot()` returns undefined even when a repo exists. Use `waitForFirstRepo()` + `ensureManager()` for lazy resolution instead. |
| **Diff viewer via `shelf-diff:` virtual URIs** | `vscode.diff(left, right, title)` + a `TextDocumentContentProvider`. In-memory patch application via the `diff` npm package. Pane labels cannot be customized — VSCode derives them from URI basenames. |
| **Conflict pre-check, don't try to recover** | `git apply --check` + byte-compare for untracked. On any conflict → `PatchConflictError`, modal with explicit file list, shelf preserved. No 3-way merge UI, no partial apply. |

## File map

```
src/
├── extension.ts            activation + all command registrations
├── ShelfManager.ts         CRUD on shelves, .git/info/exclude mgmt, maxDeletedShelves purge
├── ShelfProvider.ts        TreeDataProvider for sidebar (supports late-bound manager)
├── PatchEngine.ts          git diff/apply, PatchConflictError, binary detection, untracked snapshots
├── models/Shelf.ts         Shelf, ShelfFile, ChangeType types
├── ui/
│   ├── ShelveDialog.ts     webview-based shelve modal (name, description, tree w/ cascade checkboxes)
│   └── ShelfDiffProvider.ts  shelf-diff:// scheme + Diff.applyPatch to reconstruct shelved file content
└── utils/
    ├── git.ts              vscode.git ext API, waitForFirstRepo, runGit CLI, parsePorcelain
    └── fs.ts               vscode.workspace.fs helpers
resources/shelf.svg         activity bar icon (24x24, uses currentColor)
docs/todo.md                ongoing progress tracker — update when shipping meaningful work
```

## Non-obvious conventions

- **Every command handler is wrapped in `wrap(label, fn)`** in `extension.ts`. This catches thrown errors, logs them to the `Shelf` output channel with full stack, and shows a toast with a "Show Log" action. Never register a raw handler — if it throws, VSCode shows a useless generic "resulted in an error" wrapper and the user is stuck.

- **`output.appendLine()` liberally in command handlers.** The `Shelf` output channel is the primary debugging surface. If you add a new flow, log entry/exit points so users can diagnose issues themselves.

- **Shelf IDs are `<slug>-<base36-timestamp>`.** Generated in `ShelfManager.makeId()`. Treat them as opaque; don't parse the timestamp back out.

- **Untracked file snapshots use `encoding: 'utf8' | 'base64'`.** Binary detection is a NUL-byte scan over the first 8KB (matches git's heuristic). Writing back uses `snapshotToBuffer()` to decode correctly. Never read untracked file bytes as a string before this check — you'll corrupt binaries.

- **`restoreShelf()` does conflict pre-check BEFORE any mutation.** The order matters: `canApplyPatch` → `checkUntrackedConflicts` → throw if either fails → only then `applyPatch` + `writeUntracked` + maybe `deleteShelf`. If you add new restore steps, keep them AFTER the pre-check.

- **Diff view URIs put the real filename as the basename** so VSCode's language detector picks the right syntax. Format: `shelf-diff://<shelfId>/base/<filepath>?v=before` or `/shelved/<filepath>?v=after`. The variant lives in a path prefix segment, not in the filename.

- **`node_modules/` is excluded from the vsix** — the runtime dep (`diff`) is inlined via esbuild. If you add another runtime dep, the bundle picks it up automatically. If you add something that can't be bundled (native modules), update `.vscodeignore` to include its folder.

## Dev workflow

```bash
npm install                 # once
npm run compile             # tsc check, outputs out/ (for F5 dev host)
npm run bundle              # esbuild single-file production build
npm run package             # produces vscode-shelf-*.vsix (~17 KB)
```

In VSCode:
- Open the project folder → press **F5** to launch an Extension Development Host
- Open a git repo in that new window to see the extension activate
- **Close the dev host window fully (Cmd+W) to pick up new code**, not Cmd+R. The reload sometimes keeps cached module state and the user sees stale behavior.
- Output panel → dropdown → "Shelf" to watch the extension log

## Known limitations / rejected scope

- **No per-hunk shelving** — too much UI complexity for v1
- **No multi-root workspace support** — uses `api.repositories[0]` only; would require per-repo tree views
- **No `autoShelveOnCheckout`** — VSCode doesn't expose git branch-switch hooks cleanly; config exists but is a stub
- **No `global` storage** — `shelf.storageLocation` has `global` as an enum value but it's not wired; defaulting workspace is fine for v1
- **No binary file snapshots for diff viewer** — binary untracked files store correctly (base64) but the diff view shows a placeholder, not a visual compare. Binary tracked file changes rely on `git diff --binary` roundtrip.
- **Pane labels are "Base: filename" / "Shelved: filename" implicitly via URI structure.** Cannot show literal "Base version" / "Shelved version" labels like PyCharm — VSCode diff viewer doesn't expose that.

## Common pitfalls when working here

1. **Don't block activation on git.** If you add a new activation step, make it lazy or fire-and-forget. Blocking `activate()` on repo lookup leads to the "silently inactive" bug we already hit.

2. **Don't catch errors silently.** The `wrap()` helper handles user-facing error surfacing. If you catch inside a wrapped function, you suppress the toast. Only catch when you want to intentionally recover.

3. **Don't `write()` the webview HTML without CSP + nonce.** The shelve dialog uses a per-render nonce for `script-src`. Follow the same pattern if you add webviews.

4. **Don't use `vscode.window.showQuickPick` for rich forms.** It's modal-style but can't show trees, textareas, or anything beyond flat list items. Use a webview panel.

5. **Don't put `node_modules/<name>` paths in `.vscodeignore`.** The bundler inlines deps; the exclusion is already in effect. Fiddling with it will break the vsix.

6. **Don't rename `shelf.showDiff` to `shelf.openFileDiff` or similar.** The command IDs are referenced from `package.json` menu contributions AND from the TreeItem `command` field. Changing one without the other silently breaks UI wiring.

## Progress tracker

See `docs/todo.md` for current status. It's the source of truth for what's done, what's in flight, and what's deferred. Update it when you ship meaningful work. Mark checkboxes, don't rewrite the structure.

## When the user asks for something new

- First check `docs/todo.md` to see if it's already listed (and whether it was deferred for a reason)
- If it conflicts with any architectural decision in the table above, surface the tradeoff before implementing — these decisions were made deliberately
- If it's a UX request matching PyCharm, remember VSCode's API constraints (no floating modals, no custom diff pane labels) and propose the closest native-feeling approximation rather than fighting the platform
