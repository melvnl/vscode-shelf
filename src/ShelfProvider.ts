import * as vscode from 'vscode';
import { Shelf, ShelfFile } from './models/Shelf';
import { ShelfManager } from './ShelfManager';

type NodeKind = 'shelf' | 'deletedBucket' | 'deletedShelf' | 'file';

export class ShelfTreeItem extends vscode.TreeItem {
  constructor(
    public readonly kind: NodeKind,
    label: string,
    public readonly shelf?: Shelf,
    public readonly file?: ShelfFile,
  ) {
    super(label, ShelfTreeItem.collapsibleFor(kind));
    this.contextValue = kind;
    this.iconPath = ShelfTreeItem.iconFor(kind, file);
  }

  private static collapsibleFor(kind: NodeKind): vscode.TreeItemCollapsibleState {
    switch (kind) {
      case 'shelf':
      case 'deletedShelf':
      case 'deletedBucket':
        return vscode.TreeItemCollapsibleState.Collapsed;
      case 'file':
        return vscode.TreeItemCollapsibleState.None;
    }
  }

  private static iconFor(kind: NodeKind, file?: ShelfFile): vscode.ThemeIcon | undefined {
    switch (kind) {
      case 'shelf':
        return new vscode.ThemeIcon('archive');
      case 'deletedShelf':
        return new vscode.ThemeIcon('trash');
      case 'deletedBucket':
        return new vscode.ThemeIcon('trash');
      case 'file':
        return ShelfTreeItem.iconForFile(file);
    }
  }

  private static iconForFile(file?: ShelfFile): vscode.ThemeIcon {
    if (!file) {
      return new vscode.ThemeIcon('file');
    }
    switch (file.changeType) {
      case 'added':
        return new vscode.ThemeIcon('diff-added');
      case 'deleted':
        return new vscode.ThemeIcon('diff-removed');
      case 'renamed':
        return new vscode.ThemeIcon('diff-renamed');
      case 'modified':
      default:
        return new vscode.ThemeIcon('diff-modified');
    }
  }
}

export class ShelfProvider implements vscode.TreeDataProvider<ShelfTreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<ShelfTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private manager: ShelfManager | undefined) {}

  setManager(manager: ShelfManager): void {
    this.manager = manager;
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: ShelfTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ShelfTreeItem): Promise<ShelfTreeItem[]> {
    if (!this.manager) {
      return [];
    }
    if (!element) {
      const shelves = await this.manager.listShelves();
      const nodes = shelves.map((s) => this.shelfNode(s, false));
      const deleted = await this.manager.listDeletedShelves();
      if (deleted.length > 0) {
        nodes.push(new ShelfTreeItem('deletedBucket', 'Recently Deleted'));
      }
      return nodes;
    }

    if (element.kind === 'shelf' || element.kind === 'deletedShelf') {
      const shelf = element.shelf;
      return (shelf?.files ?? []).map((f) => this.fileNode(f, shelf!.id));
    }

    if (element.kind === 'deletedBucket') {
      const deleted = await this.manager.listDeletedShelves();
      return deleted.map((s) => this.shelfNode(s, true));
    }

    return [];
  }

  private shelfNode(shelf: Shelf, deleted: boolean): ShelfTreeItem {
    const node = new ShelfTreeItem(deleted ? 'deletedShelf' : 'shelf', shelf.name, shelf);
    const count = `${shelf.files.length} file${shelf.files.length === 1 ? '' : 's'}`;
    const when = new Date(shelf.createdAt).toLocaleString();
    node.description = `${count}, ${when}`;
    node.tooltip = shelf.description ?? shelf.name;
    return node;
  }

  private fileNode(file: ShelfFile, shelfId: string): ShelfTreeItem {
    const node = new ShelfTreeItem('file', file.path, undefined, file);
    node.description = file.changeType;
    node.command = {
      command: 'shelf.openFileDiff',
      title: 'Open Shelf Diff',
      arguments: [{ shelfId, file }],
    };
    return node;
  }
}
