// Minimal File System Access API surface — DESIGN.md, "Client-Side Song
// Pack Parsing": "Browser reads a `.zip` or directory (File System Access
// API, with a `.zip` fallback)." Still a WICG draft, not part of DOM.
// Just enough of the surface for `parse-directory.ts`'s recursive walk;
// not a full ambient definition of the spec.

interface FileSystemHandle {
  readonly kind: 'file' | 'directory';
  readonly name: string;
}

interface FileSystemFileHandle extends FileSystemHandle {
  readonly kind: 'file';
  getFile(): Promise<File>;
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  readonly kind: 'directory';
  entries(): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>;
}

interface Window {
  showDirectoryPicker?(options?: { id?: string; mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
}
