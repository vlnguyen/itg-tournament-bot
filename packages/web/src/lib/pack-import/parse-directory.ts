import type { ChartInput } from '@itg/shared';
import type { DirectoryWorkerResult } from './directory-worker.js';

/** Runs the directory walk through `directory-worker.ts` off the main thread — mirrors `parse-zip-file.ts`'s `parseZipFile`. */
export function parseDirectory(handle: FileSystemDirectoryHandle): Promise<ChartInput[]> {
  return new Promise((resolve, reject) => {
    // Vite's worker bundling recognizes this exact `new URL(..., import.meta.url)`
    // pattern statically, and needs the real `.ts` extension to do it.
    const worker = new Worker(new URL('./directory-worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (e: MessageEvent<DirectoryWorkerResult>) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.charts);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };

    worker.postMessage(handle);
  });
}
