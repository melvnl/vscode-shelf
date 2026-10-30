import * as path from 'path';
import * as vscode from 'vscode';
import { ShelfManager } from './ShelfManager';
import { ShelfProvider, ShelfTreeItem } from './ShelfProvider';
import { getChangedFiles, getGitAPI, waitForFirstRepo } from './utils/git';
import { showShelveDialog } from './ui/ShelveDialog';
import { PatchConflictError } from './PatchEngine';
import { ShelfDiffProvider, SHELF_DIFF_SCHEME, buildShelfDiffUri } from './ui/ShelfDiffProvider';
import { ShelfFile } from './models/Shelf';

const output = vscode.window.createOutputChannel('Shelf');

function wrap<T extends unknown[]>(label: string, fn: (...args: T) => Promise<void>) {
  return async (...args: T): Promise<void> => {
    try {
      await fn(...args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error && err.stack ? err.stack : '';
      output.appendLine(`[${label}] ERROR: ${msg}`);
      if (stack) output.appendLine(stack);
      const choice = await vscode.window.showErrorMessage(`Shelf · ${label}: ${msg}`, 'Show Log');
      if (choice === 'Show Log') output.show();
    }
  };
}

let currentManager: ShelfManager | undefined;
let currentProvider: ShelfProvider | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

async function updateStatusBar(): Promise<void> {
  if (!statusBarItem || !currentManager) return;
  try {
    const live = await currentManager.listShelves();
    if (live.length === 0) {
      statusBarItem.hide();
      return;
    }
    statusBarItem.text = `$(archive) ${live.length} shelf${live.length === 1 ? '' : 'es'}`;
    statusBarItem.tooltip = `${live.length} shelved change set${live.length === 1 ? '' : 's'} — click to open`;
    statusBarItem.show();
  } catch {
    statusBarItem.hide();
  }
}

async function ensureManager(): Promise<ShelfManager> {
  if (currentManager) return currentManager;
  output.appendLine('Looking up git repo...');
  const repoRoot = await waitForFirstRepo(15000);
  if (!repoRoot) {
    throw new Error('No git repository found in workspace. Open a folder that contains a git repository.');
  }
  output.appendLine(`Repo root: ${repoRoot.fsPath}`);
  currentManager = new ShelfManager(repoRoot);
  if (currentProvider) {
    currentProvider.setManager(currentManager);
    currentProvider.refresh();
  }
  return currentManager;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(output);
  output.appendLine('Shelf extension activating...');

  try {
    await doActivate(context);
    output.appendLine('Shelf extension activated.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : '';
    output.appendLine(`ACTIVATION ERROR: ${msg}`);
    if (stack) output.appendLine(stack);
    output.show();
    vscode.window.showErrorMessage(`Shelf activation failed: ${msg}`);
  }
}

async function doActivate(context: vscode.ExtensionContext): Promise<void> {
  currentProvider = new ShelfProvider(undefined);

  const diffProvider = new ShelfDiffProvider(() => currentManager);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBarItem.command = 'shelf.focusView';
  statusBarItem.hide();

  context.subscriptions.push(
    statusBarItem,
    vscode.window.registerTreeDataProvider('shelfView', currentProvider),
    vscode.window.registerTreeDataProvider('shelfViewStandalone', currentProvider),
    vscode.workspace.registerTextDocumentContentProvider(SHELF_DIFF_SCHEME, diffProvider),
    currentProvider.onDidChangeTreeData(() => void updateStatusBar()),
  );

  // Try to resolve the repo in the background (non-blocking).
  waitForFirstRepo(15000)
    .then(async (repoRoot) => {
      if (!repoRoot) {
        output.appendLine('No git repository detected after 15s. Will retry on first command.');
        return;
      }
      output.appendLine(`Repo root: ${repoRoot.fsPath}`);
      currentManager = new ShelfManager(repoRoot);
      currentProvider?.setManager(currentManager);
      currentProvider?.refresh();
      void updateStatusBar();

      // Subscribe to git state so future repo changes refresh the view.
      const api = await getGitAPI();
      if (api) {
        context.subscriptions.push(
          api.onDidOpenRepository(() => currentProvider?.refresh()),
        );
      }
    })
    .catch((err) => {
      output.appendLine(`Repo lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    });

  context.subscriptions.push(
    vscode.commands.registerCommand('shelf.refresh', () => currentProvider?.refresh()),

    vscode.commands.registerCommand(
      'shelf.shelveChanges',
      wrap('Shelve Changes', async () => {
        output.appendLine('--- shelveChanges invoked ---');
        const manager = await ensureManager();
        const repoRoot = manager.getRepoRoot();

        const all = await getChangedFiles(repoRoot);
        output.appendLine(`getChangedFiles returned ${all.length} file(s)`);
        for (const f of all) output.appendLine(`  [${f.changeType}] ${f.path}`);
        if (all.length === 0) {
          vscode.window.showInformationMessage('Shelf: nothing to shelve — working tree is clean.');
          return;
        }

        const revertAfter = vscode.workspace
          .getConfiguration('shelf')
          .get<boolean>('revertAfterShelve', true);

        const result = await showShelveDialog(all, { name: suggestName(), revertAfter });
        output.appendLine(`Dialog result: ${result ? `${result.files.length} files, name="${result.name}"` : 'cancelled'}`);
        if (!result) return;

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Shelving "${result.name}"...` },
          async () => {
            output.appendLine(`Creating shelf "${result.name}" with ${result.files.length} file(s)...`);
            await manager.createShelf(result.name, result.files, {
              description: result.description,
              revertAfter: result.revertAfter,
            });
            currentProvider?.refresh();
            output.appendLine('Shelf created.');
          },
        );
        vscode.window.showInformationMessage(`Shelved ${result.files.length} file(s) to "${result.name}".`);
      }),
    ),

    vscode.commands.registerCommand(
      'shelf.shelveSilently',
      wrap('Shelve Silently', async () => {
        const manager = await ensureManager();
        const files = await getChangedFiles(manager.getRepoRoot());
        if (files.length === 0) {
          vscode.window.showInformationMessage('Shelf: nothing to shelve.');
          return;
        }
        const name = suggestName();
        await manager.createShelf(name, files);
        currentProvider?.refresh();
        vscode.window.showInformationMessage(`Shelved ${files.length} file(s).`);
      }),
    ),

    vscode.commands.registerCommand(
      'shelf.shelveThisFile',
      wrap('Shelve This File', async (resourceState?: { resourceUri?: vscode.Uri }) => {
        const uri = resourceState?.resourceUri;
        if (!uri) {
          vscode.window.showWarningMessage('Shelf: no file selected.');
          return;
        }
        const manager = await ensureManager();
        const repoRoot = manager.getRepoRoot();
        const all = await getChangedFiles(repoRoot);
        const rel = path.relative(repoRoot.fsPath, uri.fsPath).split(path.sep).join('/');
        const match = all.find((f) => f.path === rel);
        if (!match) {
          vscode.window.showWarningMessage(`Shelf: ${rel} is not among the changed files.`);
          return;
        }
        const revertAfter = vscode.workspace
          .getConfiguration('shelf')
          .get<boolean>('revertAfterShelve', true);
        const result = await showShelveDialog(all, {
          name: `${path.basename(rel)} shelf`,
          revertAfter,
          preselectedPaths: [rel],
        });
        if (!result) return;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Shelving "${result.name}"...` },
          async () => {
            await manager.createShelf(result.name, result.files, {
              description: result.description,
              revertAfter: result.revertAfter,
            });
            currentProvider?.refresh();
          },
        );
        vscode.window.showInformationMessage(`Shelved ${result.files.length} file(s) to "${result.name}".`);
      }),
    ),

    vscode.commands.registerCommand(
      'shelf.unshelve',
      wrap('Unshelve', async (item: ShelfTreeItem) => {
        if (!item?.shelf) return;
        const manager = await ensureManager();
        try {
          await manager.restoreShelf(item.shelf.id, false);
          currentProvider?.refresh();
          vscode.window.showInformationMessage(`Unshelved "${item.shelf.name}".`);
        } catch (err) {
          if (err instanceof PatchConflictError) {
            await handleConflict(item.shelf.name, err);
            return;
          }
          throw err;
        }
      }),
    ),

    vscode.commands.registerCommand(
      'shelf.unshelveAndKeep',
      wrap('Unshelve and Keep', async (item: ShelfTreeItem) => {
        if (!item?.shelf) return;
        const manager = await ensureManager();
        try {
          await manager.restoreShelf(item.shelf.id, true);
          currentProvider?.refresh();
          vscode.window.showInformationMessage(`Unshelved "${item.shelf.name}" (shelf kept).`);
        } catch (err) {
          if (err instanceof PatchConflictError) {
            await handleConflict(item.shelf.name, err);
            return;
          }
          throw err;
        }
      }),
    ),

    vscode.commands.registerCommand(
      'shelf.deleteShelf',
      wrap('Delete', async (item: ShelfTreeItem) => {
        if (!item?.shelf) return;
        const manager = await ensureManager();
        const confirm = vscode.workspace.getConfiguration('shelf').get<boolean>('confirmBeforeDelete', true);
        if (confirm) {
          const choice = await vscode.window.showWarningMessage(
            `Delete shelf "${item.shelf.name}"?`,
            { modal: true },
            'Delete',
          );
          if (choice !== 'Delete') return;
        }
        await manager.deleteShelf(item.shelf.id);
        currentProvider?.refresh();
      }),
    ),

    vscode.commands.registerCommand(
      'shelf.renameShelf',
      wrap('Rename', async (item: ShelfTreeItem) => {
        if (!item?.shelf) return;
        const manager = await ensureManager();
        const next = await vscode.window.showInputBox({
          prompt: 'New shelf name',
          value: item.shelf.name,
        });
        if (!next) return;
        await manager.renameShelf(item.shelf.id, next);
        currentProvider?.refresh();
      }),
    ),

    vscode.commands.registerCommand(
      'shelf.recoverDeleted',
      wrap('Recover', async (item: ShelfTreeItem) => {
        if (!item?.shelf) return;
        const manager = await ensureManager();
        await manager.recoverShelf(item.shelf.id);
        currentProvider?.refresh();
      }),
    ),

    vscode.commands.registerCommand(
      'shelf.showDiff',
      wrap('Show Diff', async (item: ShelfTreeItem) => {
        if (!item?.shelf) return;
        const manager = await ensureManager();
        const found = await manager.findShelf(item.shelf.id);
        if (!found) return;
        if (found.shelf.files.length === 0) {
          vscode.window.showInformationMessage('Shelf: no files to diff.');
          return;
        }
        for (let i = 0; i < found.shelf.files.length; i++) {
          const file = found.shelf.files[i];
          const basename = file.path.split('/').pop() ?? file.path;
          const left = buildShelfDiffUri(item.shelf.id, file.path, 'before');
          const right = buildShelfDiffUri(item.shelf.id, file.path, 'after');
          const title = `Shelved: ${basename}`;
          await vscode.commands.executeCommand('vscode.diff', left, right, title, {
            preview: false,
            viewColumn: vscode.ViewColumn.Active,
            preserveFocus: i < found.shelf.files.length - 1,
          });
        }
      }),
    ),

    vscode.commands.registerCommand(
      'shelf.showRawPatch',
      wrap('Show Raw Patch', async (item: ShelfTreeItem) => {
        if (!item?.shelf) return;
        const manager = await ensureManager();
        const found = await manager.findShelf(item.shelf.id);
        if (!found) return;
        const patchUri = manager.getPatchFileUri(item.shelf.id, found.deleted);
        const doc = await vscode.workspace.openTextDocument(patchUri);
        await vscode.languages.setTextDocumentLanguage(doc, 'diff');
        await vscode.window.showTextDocument(doc, { preview: true });
      }),
    ),

    vscode.commands.registerCommand(
      'shelf.openFileDiff',
      wrap('Open File Diff', async (args: { shelfId: string; file: ShelfFile }) => {
        if (!args?.shelfId || !args.file) return;
        const manager = await ensureManager();
        const found = await manager.findShelf(args.shelfId);
        if (!found) return;

        const relPath = args.file.path;
        const basename = relPath.split('/').pop() ?? relPath;
        const left = buildShelfDiffUri(args.shelfId, relPath, 'before');
        const right = buildShelfDiffUri(args.shelfId, relPath, 'after');
        const title = `Shelved: ${basename}`;
        await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
      }),
    ),

    vscode.commands.registerCommand('shelf.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:melvinfa.vscode-shelf');
    }),

    vscode.commands.registerCommand('shelf.showLog', () => output.show()),

    vscode.commands.registerCommand('shelf.focusView', async () => {
      await vscode.commands.executeCommand('shelfView.focus');
    }),
  );
}

function suggestName(): string {
  return `Uncommitted changes at ${new Date().toLocaleString()}`;
}

async function handleConflict(shelfName: string, err: PatchConflictError): Promise<void> {
  output.appendLine(`[Unshelve conflict] shelf="${shelfName}"`);
  output.appendLine(err.rawDetails);
  const fileList = err.conflictingPaths.length > 0
    ? err.conflictingPaths.map((p) => `  • ${p}`).join('\n')
    : '  (unspecified — see log)';
  const detail = [
    `Shelf "${shelfName}" cannot be applied because the following file(s) have changes that conflict with the shelved patch:`,
    '',
    fileList,
    '',
    'The shelf has been preserved. Commit, stash, or revert your current changes to the listed files and try again.',
  ].join('\n');
  const choice = await vscode.window.showErrorMessage(
    'Unshelve conflict',
    { modal: true, detail },
    'Show Log',
  );
  if (choice === 'Show Log') output.show();
}

export function deactivate(): void {
  // nothing to clean up
}
