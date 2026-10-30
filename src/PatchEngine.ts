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
  encoding?: 'utf8' | 'base64';
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
      untracked.map((f) => this.snapshotUntracked(f.path)),
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
        const expected = snapshotToBuffer(snap);
        if (!bufferEquals(bytes, expected)) {
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
      await vscode.workspace.fs.writeFile(uri, snapshotToBuffer(snap));
    }
  }

  async snapshotUntracked(relPath: string): Promise<UntrackedSnapshot> {
    const uri = vscode.Uri.joinPath(this.repoRoot, relPath);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (isBinary(bytes)) {
        return { path: relPath, content: Buffer.from(bytes).toString('base64'), encoding: 'base64' };
      }
      return { path: relPath, content: Buffer.from(bytes).toString('utf8'), encoding: 'utf8' };
    } catch {
      return { path: relPath, content: '', encoding: 'utf8' };
    }
  }
}

function snapshotToBuffer(snap: UntrackedSnapshot): Uint8Array {
  return snap.encoding === 'base64'
    ? new Uint8Array(Buffer.from(snap.content, 'base64'))
    : new Uint8Array(Buffer.from(snap.content, 'utf8'));
}

function bufferEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isBinary(bytes: Uint8Array): boolean {
  // Heuristic: a NUL byte in the first 8KB indicates a binary file (matches git's rule).
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
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
