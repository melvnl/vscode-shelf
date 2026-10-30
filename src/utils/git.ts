import * as cp from 'child_process';
import * as vscode from 'vscode';
import { ChangeType, ShelfFile } from '../models/Shelf';

interface GitRepository {
  rootUri: vscode.Uri;
  state: { onDidChange: vscode.Event<void> };
}

interface GitExtensionAPI {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly repositories: GitRepository[];
}

export async function getGitAPI(): Promise<GitExtensionAPI | undefined> {
  const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitExtensionAPI }>('vscode.git');
  if (!ext) return undefined;
  if (!ext.isActive) await ext.activate();
  return ext.exports.getAPI(1);
}

export async function waitForFirstRepo(timeoutMs = 15000): Promise<vscode.Uri | undefined> {
  const api = await getGitAPI();
  if (!api) return undefined;
  if (api.repositories.length > 0) return api.repositories[0].rootUri;

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stateSub?.dispose();
      repoSub?.dispose();
      resolve(api.repositories[0]?.rootUri);
    }, timeoutMs);

    const repoSub = api.onDidOpenRepository((repo) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stateSub?.dispose();
      repoSub.dispose();
      resolve(repo.rootUri);
    });

    const stateSub = api.onDidChangeState(() => {
      if (settled) return;
      if (api.repositories.length > 0) {
        settled = true;
        clearTimeout(timer);
        stateSub.dispose();
        repoSub.dispose();
        resolve(api.repositories[0].rootUri);
      }
    });
  });
}

export async function getPrimaryRepoRoot(): Promise<vscode.Uri | undefined> {
  const api = await getGitAPI();
  return api?.repositories[0]?.rootUri;
}

export async function getChangedFiles(repoRoot: vscode.Uri): Promise<ShelfFile[]> {
  const stdout = await runGit(repoRoot, ['status', '--porcelain', '-z']);
  return parsePorcelain(stdout);
}

export async function hasHead(repoRoot: vscode.Uri): Promise<boolean> {
  try {
    await runGit(repoRoot, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

export function runGit(repoRoot: vscode.Uri, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = cp.execFile(
      'git',
      args,
      { cwd: repoRoot.fsPath, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args.join(' ')} (cwd=${repoRoot.fsPath}) failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      },
    );
    if (input !== undefined) {
      child.stdin?.write(input);
      child.stdin?.end();
    }
  });
}

function parsePorcelain(output: string): ShelfFile[] {
  const files: ShelfFile[] = [];
  const parts = output.split('\0');
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i];
    if (!entry || entry.length < 3) {
      i++;
      continue;
    }
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    const changeType = mapPorcelainCode(xy);
    let originalPath: string | undefined;
    if (xy[0] === 'R' || xy[1] === 'R') {
      i++;
      originalPath = parts[i];
    }
    files.push({ path, changeType, originalPath });
    i++;
  }
  return files;
}

function mapPorcelainCode(xy: string): ChangeType {
  const code = xy.replace(/\s/g, '');
  if (code.includes('R')) return 'renamed';
  if (code.includes('D')) return 'deleted';
  if (code.includes('A') || code === '??') return 'added';
  return 'modified';
}
