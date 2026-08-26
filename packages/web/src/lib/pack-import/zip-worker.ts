import { unzipSync } from 'fflate';
import { parseZipEntries } from './parse-zip.js';

/**
 * "Parsing runs in a Web Worker. A full StepMania pack is hundreds of
 * simfiles; parsing on the main thread freezes the tab for long enough to
 * look broken." See DESIGN.md, "Client-Side Song Pack Parsing". Thin by
 * design — `unzipSync` plus a `postMessage`, everything that can be
 * unit-tested without a Worker lives in `parse-zip.ts`.
 */
export type ZipWorkerResult = { ok: true; charts: ReturnType<typeof parseZipEntries> } | { ok: false; error: string };

self.onmessage = (e: MessageEvent<ArrayBuffer>): void => {
  try {
    const entries = unzipSync(new Uint8Array(e.data));
    const charts = parseZipEntries(entries);
    const result: ZipWorkerResult = { ok: true, charts };
    self.postMessage(result);
  } catch (err) {
    const result: ZipWorkerResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(result);
  }
};
