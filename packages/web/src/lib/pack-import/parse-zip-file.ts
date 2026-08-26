import type { ChartInput } from '@itg/shared';
import type { ZipWorkerResult } from './zip-worker.js';

/** Runs the zip through `zip-worker.ts` off the main thread and resolves with whatever charts it found. */
export function parseZipFile(file: File): Promise<ChartInput[]> {
  return new Promise((resolve, reject) => {
    // Vite's worker bundling recognizes this exact `new URL(..., import.meta.url)`
    // pattern statically, and needs the real `.ts` extension to do it.
    const worker = new Worker(new URL('./zip-worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (e: MessageEvent<ZipWorkerResult>) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.charts);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };

    file
      .arrayBuffer()
      .then((buf) => worker.postMessage(buf, [buf]))
      .catch((err: unknown) => {
        worker.terminate();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}
