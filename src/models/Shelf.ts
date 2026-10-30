export type ChangeType = 'modified' | 'added' | 'deleted' | 'renamed';

export interface ShelfFile {
  path: string;
  changeType: ChangeType;
  originalPath?: string;
}

export interface Shelf {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  files: ShelfFile[];
  branch?: string;
  deleted?: boolean;
  deletedAt?: string;
}
