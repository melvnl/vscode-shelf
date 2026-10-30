import * as Diff from 'diff';
import * as vscode from 'vscode';
import { ShelfManager } from '../ShelfManager';
import { runGit } from '../utils/git';

export const SHELF_DIFF_SCHEME = 'shelf-diff';

export class ShelfDiffProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly getManager: () => ShelfManager | undefined) {}

  refresh(uri?: vscode.Uri): void {
    if (uri) this._onDidChange.fire(uri);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const manager = this.getManager();
    if (!manager) return '';

    const shelfId = uri.authority;
    const trimmed = uri.path.replace(/^\//, '');
    const slash = trimmed.indexOf('/');
    const label = slash >= 0 ? trimmed.slice(0, slash) : '';
    const relPath = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
    const variant: 'before' | 'after' = label === 'base' ? 'before' : 'after';

    const found = await manager.findShelf(shelfId);
    if (!found) return `// Shelf "${shelfId}" not found`;
    const { shelf, deleted } = found;
    const file = shelf.files.find((f) => f.path === relPath);
    if (!file) return `// File "${relPath}" not in shelf`;

    if (variant === 'before') {
      if (file.changeType === 'added') return '';
      return getHeadContent(manager.getRepoRoot(), relPath);
    }

    // variant === 'after'
    if (file.changeType === 'added') {
      const snaps = await manager.readUntrackedSnapshots(shelfId, deleted);
      return snaps.find((s) => s.path === relPath)?.content ?? '';
    }
    if (file.changeType === 'deleted') return '';

    // modified / renamed — apply the per-file hunk to the HEAD content
    const headContent = await getHeadContent(manager.getRepoRoot(), relPath);
    const fullPatch = await manager.readPatch(shelfId, deleted);
    const parsed = Diff.parsePatch(fullPatch);
    const match = parsed.find((p) => stripPrefix(p.oldFileName ?? '') === relPath || stripPrefix(p.newFileName ?? '') === relPath);
    if (!match) return headContent;
    const applied = Diff.applyPatch(headContent, match);
    if (applied === false) {
      return `// Shelf patch for ${relPath} does not apply cleanly to current HEAD.\n// Showing current HEAD content.\n\n${headContent}`;
    }
    return applied;
  }
}

export function buildShelfDiffUri(shelfId: string, relPath: string, variant: 'before' | 'after'): vscode.Uri {
  // Keep the real filename as the basename so VSCode's language detector picks the right extension.
  // The variant lives in the path's prefix segment so left/right panes are distinct URIs.
  const label = variant === 'before' ? 'base' : 'shelved';
  return vscode.Uri.from({
    scheme: SHELF_DIFF_SCHEME,
    authority: shelfId,
    path: `/${label}/${relPath}`,
    query: `v=${variant}`,
  });
}

async function getHeadContent(repoRoot: vscode.Uri, relPath: string): Promise<string> {
  try {
    return await runGit(repoRoot, ['show', `HEAD:${relPath}`]);
  } catch {
    return '';
  }
}

function stripPrefix(name: string): string {
  if (name === '/dev/null') return '';
  if (name.startsWith('a/') || name.startsWith('b/')) return name.slice(2);
  return name;
}
