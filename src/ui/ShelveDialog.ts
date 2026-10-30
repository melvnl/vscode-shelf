import * as vscode from 'vscode';
import { ShelfFile } from '../models/Shelf';

export interface ShelveDialogResult {
  name: string;
  description?: string;
  files: ShelfFile[];
  revertAfter: boolean;
}

export function showShelveDialog(
  files: ShelfFile[],
  defaults: { name?: string; revertAfter?: boolean; preselectedPaths?: string[] } = {},
): Promise<ShelveDialogResult | undefined> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel('shelfDialog', 'Shelve Changes', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
    });

    let settled = false;
    const settle = (value: ShelveDialogResult | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
      panel.dispose();
    };

    panel.webview.html = renderHtml(files, {
      name: defaults.name ?? '',
      revertAfter: defaults.revertAfter ?? true,
      preselectedPaths: defaults.preselectedPaths,
    });

    panel.webview.onDidReceiveMessage((msg: InboundMessage) => {
      if (msg.type === 'submit') {
        const selected = files.filter((f) => msg.selectedPaths.includes(f.path));
        if (selected.length === 0 || !msg.name.trim()) return;
        settle({
          name: msg.name.trim(),
          description: msg.description?.trim() || undefined,
          files: selected,
          revertAfter: msg.revertAfter,
        });
      } else if (msg.type === 'cancel') {
        settle(undefined);
      }
    });

    panel.onDidDispose(() => settle(undefined));
  });
}

type InboundMessage =
  | { type: 'submit'; name: string; description?: string; selectedPaths: string[]; revertAfter: boolean }
  | { type: 'cancel' };

function renderHtml(
  files: ShelfFile[],
  defaults: { name: string; revertAfter: boolean; preselectedPaths?: string[] },
): string {
  const tree = buildTree(files);
  const preselected = defaults.preselectedPaths ? new Set(defaults.preselectedPaths) : undefined;
  const treeHtml = renderNode(tree, 0, preselected);
  const nonce = makeNonce();

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>Shelve Changes</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px 24px;
      margin: 0;
    }
    h1 {
      font-size: 1.1em;
      font-weight: 600;
      margin: 0 0 16px;
      color: var(--vscode-titleBar-activeForeground, var(--vscode-foreground));
    }
    label.block {
      display: block;
      margin-top: 14px;
      margin-bottom: 6px;
      font-weight: 500;
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }
    input[type="text"], textarea {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font-family: inherit;
      font-size: inherit;
    }
    input[type="text"]:focus, textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    textarea {
      min-height: 60px;
      resize: vertical;
    }
    .tree {
      border: 1px solid var(--vscode-panel-border, var(--vscode-input-border, #333));
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      border-radius: 2px;
      padding: 8px 10px;
      max-height: 280px;
      overflow: auto;
      margin-top: 4px;
    }
    .node {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 0;
      cursor: pointer;
      user-select: none;
    }
    .node:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .indent {
      display: inline-block;
      width: 14px;
      flex-shrink: 0;
    }
    .caret {
      display: inline-block;
      width: 14px;
      text-align: center;
      flex-shrink: 0;
      color: var(--vscode-icon-foreground, var(--vscode-foreground));
      font-size: 0.8em;
    }
    .caret.leaf { visibility: hidden; }
    .icon {
      flex-shrink: 0;
      width: 14px;
      text-align: center;
    }
    .name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .change-tag {
      font-size: 0.75em;
      padding: 1px 6px;
      border-radius: 2px;
      flex-shrink: 0;
      opacity: 0.8;
    }
    .change-modified { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
    .change-added { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .change-deleted { color: var(--vscode-gitDecoration-deletedResourceForeground); }
    .change-renamed { color: var(--vscode-gitDecoration-renamedResourceForeground); }
    .collapsed > .children { display: none; }
    .checkbox {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      accent-color: var(--vscode-focusBorder);
    }
    .footer {
      margin-top: 20px;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-panel-border, transparent);
    }
    button {
      padding: 6px 16px;
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-family: inherit;
      font-size: inherit;
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button.primary:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 14px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }
    .summary {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <h1>Shelve Changes</h1>

  <label class="block" for="name">Shelf Name</label>
  <input type="text" id="name" value="${escapeHtml(defaults.name)}" placeholder="e.g. ostrich changes before prod merge" />

  <label class="block">Files to shelve</label>
  <div class="tree" id="tree">${treeHtml}</div>
  <div class="summary" id="summary">0 of ${files.length} selected</div>

  <label class="block" for="description">Description (optional)</label>
  <textarea id="description" placeholder="Any notes about this shelf..."></textarea>

  <div class="row">
    <input type="checkbox" id="revertAfter" ${defaults.revertAfter ? 'checked' : ''} />
    <label for="revertAfter">Remove changes from working copy after shelving</label>
  </div>

  <div class="footer">
    <button class="secondary" id="btn-cancel">Cancel</button>
    <button class="primary" id="btn-submit">Shelve Changes</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // Checkbox cascade + caret toggle
    document.querySelectorAll('.caret').forEach((caret) => {
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        const node = caret.closest('.node-wrap');
        if (!node) return;
        node.classList.toggle('collapsed');
        caret.textContent = node.classList.contains('collapsed') ? '▸' : '▾';
      });
    });

    document.querySelectorAll('.checkbox').forEach((cb) => {
      cb.addEventListener('change', (e) => {
        const target = e.target;
        const nodeWrap = target.closest('.node-wrap');
        if (!nodeWrap) return;
        // Cascade down
        nodeWrap.querySelectorAll('.checkbox').forEach((child) => {
          child.checked = target.checked;
          child.indeterminate = false;
        });
        // Update ancestors
        let parent = nodeWrap.parentElement?.closest('.node-wrap');
        while (parent) {
          const descendantFiles = parent.querySelectorAll('.checkbox[data-path]');
          const checkedCount = Array.from(descendantFiles).filter((c) => c.checked).length;
          const parentCb = parent.querySelector(':scope > .node > .checkbox');
          if (parentCb) {
            if (checkedCount === 0) {
              parentCb.checked = false;
              parentCb.indeterminate = false;
            } else if (checkedCount === descendantFiles.length) {
              parentCb.checked = true;
              parentCb.indeterminate = false;
            } else {
              parentCb.checked = false;
              parentCb.indeterminate = true;
            }
          }
          parent = parent.parentElement?.closest('.node-wrap');
        }
        updateSummary();
      });
    });

    function updateSummary() {
      const total = document.querySelectorAll('.checkbox[data-path]').length;
      const selected = Array.from(document.querySelectorAll('.checkbox[data-path]')).filter((c) => c.checked).length;
      document.getElementById('summary').textContent = selected + ' of ' + total + ' selected';
      document.getElementById('btn-submit').disabled = selected === 0 || !document.getElementById('name').value.trim();
    }

    document.getElementById('name').addEventListener('input', updateSummary);

    document.getElementById('btn-cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });

    document.getElementById('btn-submit').addEventListener('click', () => {
      const name = document.getElementById('name').value;
      const description = document.getElementById('description').value;
      const revertAfter = document.getElementById('revertAfter').checked;
      const selectedPaths = Array.from(document.querySelectorAll('.checkbox[data-path]'))
        .filter((cb) => cb.checked)
        .map((cb) => cb.getAttribute('data-path'));
      vscode.postMessage({ type: 'submit', name, description, selectedPaths, revertAfter });
    });

    // On load, propagate indeterminate states on folders based on their children
    function syncParents() {
      const wraps = Array.from(document.querySelectorAll('.node-wrap'));
      // Walk deepest-first so parents see correct child state
      wraps.reverse().forEach((wrap) => {
        const own = wrap.querySelector(':scope > .node > .checkbox');
        if (!own || own.hasAttribute('data-path')) return;
        const descendants = wrap.querySelectorAll('.checkbox[data-path]');
        if (descendants.length === 0) return;
        const checked = Array.from(descendants).filter((c) => c.checked).length;
        if (checked === 0) {
          own.checked = false; own.indeterminate = false;
        } else if (checked === descendants.length) {
          own.checked = true; own.indeterminate = false;
        } else {
          own.checked = false; own.indeterminate = true;
        }
      });
    }

    document.getElementById('name').focus();
    document.getElementById('name').select();
    syncParents();
    updateSummary();
  </script>
</body>
</html>`;
}

interface TreeNode {
  name: string;
  path: string;
  isFile: boolean;
  file?: ShelfFile;
  children: Map<string, TreeNode>;
}

function buildTree(files: ShelfFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', isFile: false, children: new Map() };
  for (const file of files) {
    const parts = file.path.split('/');
    let cursor = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join('/');
      let next = cursor.children.get(part);
      if (!next) {
        next = { name: part, path, isFile: isLast, children: new Map(), file: isLast ? file : undefined };
        cursor.children.set(part, next);
      }
      cursor = next;
    }
  }
  return root;
}

function renderNode(node: TreeNode, depth: number, preselected?: Set<string>): string {
  const children = Array.from(node.children.values()).sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return children.map((c) => renderOne(c, depth, preselected)).join('');
}

function renderOne(node: TreeNode, depth: number, preselected?: Set<string>): string {
  const indent = `<span class="indent" style="width:${depth * 14}px"></span>`;
  if (node.isFile && node.file) {
    const isChecked = !preselected || preselected.has(node.file.path);
    const tag = `<span class="change-tag change-${node.file.changeType}">${node.file.changeType}</span>`;
    const icon = iconFor(node.file.changeType);
    return `<div class="node-wrap">
      <div class="node">
        ${indent}
        <span class="caret leaf">·</span>
        <input type="checkbox" class="checkbox" data-path="${escapeAttr(node.file.path)}" ${isChecked ? 'checked' : ''} />
        <span class="icon">${icon}</span>
        <span class="name" title="${escapeAttr(node.file.path)}">${escapeHtml(node.name)}</span>
        ${tag}
      </div>
    </div>`;
  }
  const inner = renderNode(node, depth + 1, preselected);
  const descendantPaths = collectFilePaths(node);
  const allChecked = !preselected || descendantPaths.every((p) => preselected.has(p));
  return `<div class="node-wrap">
    <div class="node">
      ${indent}
      <span class="caret">▾</span>
      <input type="checkbox" class="checkbox" ${allChecked ? 'checked' : ''} />
      <span class="icon">📁</span>
      <span class="name">${escapeHtml(node.name)}</span>
    </div>
    <div class="children">${inner}</div>
  </div>`;
}

function collectFilePaths(node: TreeNode): string[] {
  if (node.isFile && node.file) return [node.file.path];
  const out: string[] = [];
  for (const child of node.children.values()) out.push(...collectFilePaths(child));
  return out;
}

function iconFor(changeType: string): string {
  switch (changeType) {
    case 'added':
      return '+';
    case 'deleted':
      return '−';
    case 'renamed':
      return '→';
    default:
      return '·';
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function makeNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
