import * as vscode from 'vscode';
import { ShelfFile } from './models/Shelf';
import { hasHead, runGit } from './utils/git';

export interface PatchResult {
  patch: string;
  untrackedSnapshots: UntrackedSnapshot[];
}

export interface UntrackedSnapshot {
  path: string;
  content: string;
}

export class PatchConflictError extends Error {
  constructor(
    public readonly conflictingPaths: string[],
    public readonly rawDetails: string,
  ) {
    super(
      conflictingPaths.length > 0
        ? `Shelf conflicts with current changes in: ${conflictingPaths.join(', ')}`
        : 'Shelf does not apply cleanly to the current working tree.',
    );
    this.name = 'PatchConflictError';
  }
}

export class PatchEngine {
  constructor(private readonly repoRoot: vscode.Uri) {}

  async generatePatch(files: ShelfFile[]): Promise<PatchResult> {
    const tracked = files.filter((f) => f.changeType !== 'added');
    const untracked = files.filter((f) => f.changeType === 'added');

    let patch = '';
    if (tracked.length > 0) {
      const headExists = await hasHead(this.repoRoot);
      const diffArgs = ['diff', '--binary'];
      if (headExists) {
        diffArgs.push('HEAD');
      }
      diffArgs.push('--', ...tracked.map((f) => f.path));
      patch = await runGit(this.repoRoot, diffArgs);
    }

    const untrackedSnapshots = await Promise.all(
      untracked.map(async (f) => ({
        path: f.path,
        content: await this.readFileContent(f.path),
      })),
    );

    return { patch, untrackedSnapshots };
  }

  async canApplyPatch(patchContent: string): Promise<{ ok: true } | { ok: false; details: string; files: string[] }> {
    if (!patchContent.trim()) return { ok: true };
    try {
      await runGit(this.repoRoot, ['apply', '--check', '--whitespace=nowarn'], patchContent);
      return { ok: true };
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      return { ok: false, details, files: extractConflictFiles(details) };
    }
  }

  async applyPatch(patchContent: string): Promise<void> {
    if (!patchContent.trim()) {
      return;
    }
    const check = await this.canApplyPatch(patchContent);
    if (!check.ok) {
      throw new PatchConflictError(check.files, check.details);
    }
    await runGit(this.repoRoot, ['apply', '--whitespace=nowarn'], patchContent);
  }

  async checkUntrackedConflicts(snapshots: UntrackedSnapshot[]): Promise<string[]> {
    const conflicts: string[] = [];
    for (const snap of snapshots) {
      const uri = vscode.Uri.joinPath(this.repoRoot, snap.path);
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const current = Buffer.from(bytes).toString('utf8');
        if (current !== snap.content) {
          conflicts.push(snap.path);
        }
      } catch {
        // file doesn't exist — no conflict
      }
    }
    return conflicts;
  }

  async revertTracked(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) {
      return;
    }
    const headExists = await hasHead(this.repoRoot);
    if (!headExists) {
      return;
    }
    await runGit(this.repoRoot, ['checkout', 'HEAD', '--', ...filePaths]);
  }

  async deleteUntracked(filePaths: string[]): Promise<void> {
    for (const p of filePaths) {
      const uri = vscode.Uri.joinPath(this.repoRoot, p);
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: false });
      } catch {
        // best effort
      }
    }
  }

  async writeUntracked(snapshots: UntrackedSnapshot[]): Promise<void> {
    for (const snap of snapshots) {
      const uri = vscode.Uri.joinPath(this.repoRoot, snap.path);
      const parent = vscode.Uri.joinPath(uri, '..');
      await vscode.workspace.fs.createDirectory(parent);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(snap.content, 'utf8'));
    }
  }

  private async readFileContent(relPath: string): Promise<string> {
    const uri = vscode.Uri.joinPath(this.repoRoot, relPath);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return '';
    }
  }
}

function extractConflictFiles(gitError: string): string[] {
  // Parses lines like "error: patch failed: path/to/file.js:123"
  // and "error: path/to/file.js: patch does not apply"
  const files = new Set<string>();
  const re = /error:\s+(?:patch failed:\s+)?([^\s:][^\n:]*)(?::\d+)?(?::\s+patch does not apply)?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(gitError)) !== null) {
    const candidate = match[1].trim();
    if (candidate && !candidate.startsWith('error') && candidate !== 'patch failed') {
      files.add(candidate);
    }
  }
  return Array.from(files);
}
