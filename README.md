<p align="center">
  <img src="./resources/banner.svg" alt="vscode-shelf" width="600"/>
</p>

<p align="center">
  <em>PyCharm-style named shelves for VSCode. Save uncommitted changes locally, without touching git history.</em>
</p>

---

**vscode-shelf** brings PyCharm's beloved **Shelf** feature to VSCode. Save named snapshots of your working-tree changes to a local-only store, then unshelve them later — without the baggage of `git stash`.

## Why

If you've switched between PyCharm and VSCode, you've probably missed PyCharm's Shelf: a flat, named list of saved change sets that live outside git. It's not `git stash` — none of the LIFO/pop semantics, doesn't pollute `git stash list`, and lets you partially shelve by file. Nothing in VSCode replicates it, so this extension does.

| | PyCharm Shelf (and this extension) | `git stash` |
|---|---|---|
| Storage | Patch files on disk | Git object store |
| Named | Custom name at creation | Optional message only |
| Partial shelve | Per-file (or per-hunk in PyCharm) | All or nothing (without flags) |
| Visible to teammates | **No** — local only | Via `git stash list` |
| Ordering | Flat, chronological, all visible | Stack (LIFO) |
| Apply behavior | Apply and optionally keep | Pop (destroys) or apply |

## Features

- **Named shelves** with custom names, optional descriptions, and timestamps
- **Rich shelve dialog** — hierarchical file tree with cascading checkboxes, matching PyCharm's dialog
- **Side-by-side diff viewer** — click any file in a shelf to compare current HEAD vs. shelved state
- **Conflict pre-check on unshelve** — the shelf is preserved if your working tree has diverged; you get an explicit list of conflicting files
- **Invisible to teammates** — storage lives in `.vscode/shelves/` and is auto-added to the repo's `.git/info/exclude` (never `.gitignore`, never committed)
- **Binary file support** — untracked binaries stored as base64, round-trip cleanly on unshelve
- **Soft delete with Recently Deleted** — recover accidental deletes or clear the bucket
- **Status bar count** of active shelves, click to focus the view
- **Native SCM integration** — right-click any file in Source Control → `Shelve This File...`
- **Keyboard shortcut** — `Cmd+Shift+H` / `Ctrl+Shift+H` to open the shelve dialog from anywhere

## Install

Not yet on the VSCode Marketplace. Build and install from source:

```bash
git clone <this-repo>
cd vscode-shelf
npm install
npm run package
code --install-extension vscode-shelf-0.0.1.vsix
```

## Usage

### Shelve current changes

- **Keyboard**: `Cmd+Shift+H` (Mac) / `Ctrl+Shift+H` (Win/Linux)
- **Palette**: `Shelf: Shelve Changes...`
- **Source Control panel**: right-click the Changes group → `Shelf: Shelve Changes...`

A dialog opens with every modified/added/deleted file pre-selected. Uncheck any you want to exclude, give the shelf a name, optionally add a description, then click **Shelve Changes**.

### Shelve just one file

Right-click a file in Source Control → `Shelve This File...`. The dialog opens with that file preselected (and all your other changes visible as unchecked, in case you want to add more).

### Unshelve

In the Shelf view (SCM panel or dedicated activity bar entry):

- Right-click a shelf → `Unshelve` (restores changes and deletes the shelf)
- Right-click a shelf → `Unshelve and Keep` (restores but keeps the shelf, like PyCharm's "Apply")

If your working tree has changes that conflict with the shelf, you'll see a modal listing the conflicting files. The shelf is **preserved** — nothing is partially applied.

### View a diff

- **Click a file inside a shelf** → side-by-side diff opens for that file
- **Right-click a shelf → `Show Diff`** → opens a diff tab per file in the shelf
- **Right-click a shelf → `Show Raw Patch`** → opens the unified-diff file (power users)

### Recently Deleted

Soft-deleted shelves move to the Recently Deleted bucket at the bottom of the Shelf view. Right-click any entry to `Recover` or `Delete Permanently`. Right-click the bucket header to `Clear All`.

## Settings

| Setting | Default | Description |
|---|---|---|
| `shelf.revertAfterShelve` | `true` | Clean the working tree after shelving (matches PyCharm) |
| `shelf.autoLocalIgnore` | `true` | Auto-add `.vscode/shelves/` to the repo's `.git/info/exclude` so shelves don't appear as untracked changes |
| `shelf.confirmBeforeDelete` | `true` | Ask for confirmation before soft-deleting a shelf |
| `shelf.maxDeletedShelves` | `10` | Max entries in Recently Deleted before oldest are purged |
| `shelf.showInSourceControlPanel` | `true` | Show the Shelf view inside the Source Control panel |

## Architecture

Shelves are stored as **patch files**, not git stashes:

```
.vscode/shelves/<id>/
├── metadata.json      # Shelf info (name, description, files, timestamp)
├── changes.patch      # Unified diff of tracked file changes
└── untracked.json     # Snapshots for added files (base64 if binary)
```

The directory is auto-added to the repo's `.git/info/exclude` — a local-only ignore file that is **never committed** and **never seen by collaborators**. Teammates will not see your shelves even if they `git pull` or `git clone` fresh.

For a deeper architectural overview, see [`CLAUDE.md`](./CLAUDE.md). For the ongoing task tracker, see [`docs/todo.md`](./docs/todo.md).

## Development

```bash
npm install
npm run compile       # tsc check — produces out/ for F5 dev host
npm run bundle        # esbuild single-file production bundle
npm run package       # produces .vsix (via vsce)
```

Open the project in VSCode and press **F5** to launch an Extension Development Host with the extension loaded. Open the **Shelf** output channel to see the extension log.

## Limitations

- **Not multi-root workspace aware** yet — uses the first git repo in the workspace
- **No per-hunk shelving** — shelve granularity is per-file (PyCharm supports hunks)
- **No `autoShelveOnCheckout`** — VSCode doesn't expose git branch-switch hooks cleanly
- **Not published to Marketplace yet** — install from source for now
- **Diff viewer pane labels can't be customized** — VSCode derives them from URI basenames; you'll see the filename on both panes with `base/` and `shelved/` path prefixes

## License

MIT.
