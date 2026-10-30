import * as vscode from 'vscode';

export async function ensureDir(uri: vscode.Uri): Promise<void> {
  await vscode.workspace.fs.createDirectory(uri);
}

export async function writeTextFile(uri: vscode.Uri, content: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}

export async function readTextFile(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

export async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function listDir(uri: vscode.Uri): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    return entries.map(([name]) => name);
  } catch {
    return [];
  }
}
