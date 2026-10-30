import * as path from 'path';
import * as vscode from 'vscode';
import { Shelf, ShelfFile } from './models/Shelf';
import { PatchConflictError, PatchEngine, UntrackedSnapshot } from './PatchEngine';
import { ensureDir, listDir, pathExists, readTextFile, writeTextFile } from './utils/fs';
import { runGit } from './utils/git';

const METADATA_FILE = 'metadata.json';
const PATCH_FILE = 'changes.patch';
const UNTRACKED_FILE = 'untracked.json';
const DELETED_DIR = '_deleted';
const EXCLUDE_PATTERN = '.vscode/shelves/';
const EXCLUDE_MARKER = '# Added by vscode-shelf';

export class ShelfManager {
  private readonly storageRoot: vscode.Uri;
  private readonly patchEngine: PatchEngine;
  private localIgnoreApplied = false;

  constructor(private readonly repoRoot: vscode.Uri) {
    this.storageRoot = vscode.Uri.joinPath(repoRoot, '.vscode', 'shelves');
    this.patchEngine = new PatchEngine(repoRoot);
  }

  async ensureLocalGitIgnore(): Promise<void> {
    if (this.localIgnoreApplied) return;
    const enabled = vscode.workspace
      .getConfiguration('shelf')
      .get<boolean>('autoLocalIgnore', true);
    if (!enabled) {
      this.localIgnoreApplied = true;
      return;
    }
    try {
      const gitDir = (await runGit(this.repoRoot, ['rev-parse', '--absolute-git-dir'])).trim();
      const excludePath = path.join(gitDir, 'info', 'exclude');
      const excludeUri = vscode.Uri.file(excludePath);
      const infoDirUri = vscode.Uri.file(path.join(gitDir, 'info'));
      await ensureDir(infoDirUri);

      let current = '';
      if (await pathExists(excludeUri)) {
        current = await readTextFile(excludeUri);
      }
      if (current.split('\n').some((line) => line.trim() === EXCLUDE_PATTERN)) {
        this.localIgnoreApplied = true;
        return;
      }
      const sep = current.length === 0 || current.endsWith('\n') ? '' : '\n';
      const addition = `${sep}${EXCLUDE_MARKER}\n${EXCLUDE_PATTERN}\n`;
      await writeTextFile(excludeUri, current + addition);
      this.localIgnoreApplied = true;
    } catch {
      // best effort — if git-dir isn't resolvable we silently skip
    }
  }

  async listShelves(): Promise<Shelf[]> {
    await ensureDir(this.storageRoot);
    const entries = await listDir(this.storageRoot);
    const shelves: Shelf[] = [];
    for (const entry of entries) {
      if (entry === DELETED_DIR) continue;
      const shelf = await this.readShelf(entry, false);
      if (shelf) shelves.push(shelf);
    }
    return shelves.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listDeletedShelves(): Promise<Shelf[]> {
    const deletedRoot = vscode.Uri.joinPath(this.storageRoot, DELETED_DIR);
    if (!(await pathExists(deletedRoot))) return [];
    const entries = await listDir(deletedRoot);
    const shelves: Shelf[] = [];
    for (const entry of entries) {
      const shelf = await this.readShelf(entry, true);
      if (shelf) shelves.push(shelf);
    }
    return shelves.sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  }

  async createShelf(
    name: string,
    files: ShelfFile[],
    opts: { description?: string; branch?: string; revertAfter?: boolean } = {},
  ): Promise<Shelf> {
    if (files.length === 0) {
      throw new Error('Nothing to shelve: no files selected.');
    }
    const id = this.makeId(name);
    const shelfDir = vscode.Uri.joinPath(this.storageRoot, id);
    await ensureDir(shelfDir);
    await this.ensureLocalGitIgnore();

    const { patch, untrackedSnapshots } = await this.patchEngine.generatePatch(files);

    const shelf: Shelf = {
      id,
      name,
      description: opts.description,
      branch: opts.branch,
      createdAt: new Date().toISOString(),
      files,
    };

    await writeTextFile(vscode.Uri.joinPath(shelfDir, METADATA_FILE), JSON.stringify(shelf, null, 2));
    await writeTextFile(vscode.Uri.joinPath(shelfDir, PATCH_FILE), patch);
    if (untrackedSnapshots.length > 0) {
      await writeTextFile(
        vscode.Uri.joinPath(shelfDir, UNTRACKED_FILE),
        JSON.stringify(untrackedSnapshots, null, 2),
      );
    }

    if (opts.revertAfter !== false) {
      const trackedPaths = files.filter((f) => f.changeType !== 'added').map((f) => f.path);
      const untrackedPaths = files.filter((f) => f.changeType === 'added').map((f) => f.path);
      await this.patchEngine.revertTracked(trackedPaths);
      await this.patchEngine.deleteUntracked(untrackedPaths);
    }

    return shelf;
  }

  async restoreShelf(id: string, keepShelf: boolean): Promise<void> {
    const shelfDir = vscode.Uri.joinPath(this.storageRoot, id);
    const patch = await readTextFile(vscode.Uri.joinPath(shelfDir, PATCH_FILE));

    const untrackedUri = vscode.Uri.joinPath(shelfDir, UNTRACKED_FILE);
    let snapshots: UntrackedSnapshot[] = [];
    if (await pathExists(untrackedUri)) {
      snapshots = JSON.parse(await readTextFile(untrackedUri));
    }

    // Pre-check both tracked (patch) and untracked (snapshot) conflicts BEFORE mutating anything.
    const patchCheck = await this.patchEngine.canApplyPatch(patch);
    const untrackedConflicts = await this.patchEngine.checkUntrackedConflicts(snapshots);

    if (!patchCheck.ok || untrackedConflicts.length > 0) {
      const files = [
        ...(patchCheck.ok ? [] : patchCheck.files),
        ...untrackedConflicts,
      ];
      const details = patchCheck.ok
        ? `Untracked files already exist with different content: ${untrackedConflicts.join(', ')}`
        : patchCheck.details;
      throw new PatchConflictError(Array.from(new Set(files)), details);
    }

    await this.patchEngine.applyPatch(patch);
    if (snapshots.length > 0) {
      await this.patchEngine.writeUntracked(snapshots);
    }

    if (!keepShelf) {
      await this.deleteShelf(id);
    }
  }

  async deleteShelf(id: string): Promise<void> {
    const src = vscode.Uri.joinPath(this.storageRoot, id);
    const deletedRoot = vscode.Uri.joinPath(this.storageRoot, DELETED_DIR);
    await ensureDir(deletedRoot);
    const dst = vscode.Uri.joinPath(deletedRoot, id);
    await vscode.workspace.fs.rename(src, dst, { overwrite: true });

    const metaUri = vscode.Uri.joinPath(dst, METADATA_FILE);
    const meta: Shelf = JSON.parse(await readTextFile(metaUri));
    meta.deleted = true;
    meta.deletedAt = new Date().toISOString();
    await writeTextFile(metaUri, JSON.stringify(meta, null, 2));
  }

  async permanentlyDeleteShelf(id: string): Promise<void> {
    const uri = vscode.Uri.joinPath(this.storageRoot, DELETED_DIR, id);
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
  }

  async recoverShelf(id: string): Promise<void> {
    const src = vscode.Uri.joinPath(this.storageRoot, DELETED_DIR, id);
    const dst = vscode.Uri.joinPath(this.storageRoot, id);
    await vscode.workspace.fs.rename(src, dst, { overwrite: true });

    const metaUri = vscode.Uri.joinPath(dst, METADATA_FILE);
    const meta: Shelf = JSON.parse(await readTextFile(metaUri));
    delete meta.deleted;
    delete meta.deletedAt;
    await writeTextFile(metaUri, JSON.stringify(meta, null, 2));
  }

  async renameShelf(id: string, newName: string): Promise<void> {
    const metaUri = vscode.Uri.joinPath(this.storageRoot, id, METADATA_FILE);
    const meta: Shelf = JSON.parse(await readTextFile(metaUri));
    meta.name = newName;
    await writeTextFile(metaUri, JSON.stringify(meta, null, 2));
  }

  async readPatch(id: string, deleted = false): Promise<string> {
    const base = deleted
      ? vscode.Uri.joinPath(this.storageRoot, DELETED_DIR, id)
      : vscode.Uri.joinPath(this.storageRoot, id);
    return readTextFile(vscode.Uri.joinPath(base, PATCH_FILE));
  }

  async readUntrackedSnapshots(id: string, deleted = false): Promise<UntrackedSnapshot[]> {
    const base = deleted
      ? vscode.Uri.joinPath(this.storageRoot, DELETED_DIR, id)
      : vscode.Uri.joinPath(this.storageRoot, id);
    const uri = vscode.Uri.joinPath(base, UNTRACKED_FILE);
    if (!(await pathExists(uri))) return [];
    try {
      return JSON.parse(await readTextFile(uri)) as UntrackedSnapshot[];
    } catch {
      return [];
    }
  }

  async findShelf(id: string): Promise<{ shelf: Shelf; deleted: boolean } | undefined> {
    const live = await this.readShelf(id, false);
    if (live) return { shelf: live, deleted: false };
    const dead = await this.readShelf(id, true);
    if (dead) return { shelf: dead, deleted: true };
    return undefined;
  }

  getPatchFileUri(id: string, deleted = false): vscode.Uri {
    const base = deleted
      ? vscode.Uri.joinPath(this.storageRoot, DELETED_DIR, id)
      : vscode.Uri.joinPath(this.storageRoot, id);
    return vscode.Uri.joinPath(base, PATCH_FILE);
  }

  getRepoRoot(): vscode.Uri {
    return this.repoRoot;
  }

  private async readShelf(id: string, deleted: boolean): Promise<Shelf | undefined> {
    const base = deleted
      ? vscode.Uri.joinPath(this.storageRoot, DELETED_DIR, id)
      : vscode.Uri.joinPath(this.storageRoot, id);
    const metaUri = vscode.Uri.joinPath(base, METADATA_FILE);
    if (!(await pathExists(metaUri))) return undefined;
    try {
      return JSON.parse(await readTextFile(metaUri)) as Shelf;
    } catch {
      return undefined;
    }
  }

  private makeId(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const ts = Date.now().toString(36);
    return `${slug || 'shelf'}-${ts}`;
  }
}
