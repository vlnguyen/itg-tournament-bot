import { parseZipEntries } from './parse-zip.js';

/**
 * DESIGN.md, "Client-Side Song Pack Parsing": "Browser reads a `.zip` or
 * directory (File System Access API, with a `.zip` fallback)." A
 * `FileSystemDirectoryHandle` is structured-cloneable, so the whole walk
 * happens off the main thread — same reasoning as `zip-worker.ts`
 * ("parsing on the main thread freezes the tab"), just walking a live
 * directory instead of an in-memory archive. Reuses `parseZipEntries`
 * unchanged: a relative path plus file bytes is all it ever needed, and a
 * directory walk produces exactly that.
 */
export type DirectoryWorkerResult = { ok: true; charts: ReturnType<typeof parseZipEntries> } | { ok: false; error: string };

async function collectEntries(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  entries: Record<string, Uint8Array>,
): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      await collectEntries(handle, path, entries);
    } else if (/\.(sm|ssc)$/i.test(name)) {
      // Only simfiles are ever read — a real pack's audio/graphics files
      // outweigh its .sm/.ssc files many times over, and nothing here
      // needs them.
      const file = await handle.getFile();
      entries[path] = new Uint8Array(await file.arrayBuffer());
    }
  }
}

self.onmessage = (e: MessageEvent<FileSystemDirectoryHandle>): void => {
  const entries: Record<string, Uint8Array> = {};
  collectEntries(e.data, '', entries)
    .then(() => {
      const charts = parseZipEntries(entries);
      const result: DirectoryWorkerResult = { ok: true, charts };
      self.postMessage(result);
    })
    .catch((err: unknown) => {
      const result: DirectoryWorkerResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
      self.postMessage(result);
    });
};
