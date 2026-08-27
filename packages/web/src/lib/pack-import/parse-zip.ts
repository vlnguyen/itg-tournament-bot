import { parseSimfile, pickPreferredSimfile } from '@itg/shared';
import type { ChartInput } from '@itg/shared';

const decoder = new TextDecoder('utf-8');

/**
 * Groups a zip's flat file list into song folders (one directory per song,
 * per DESIGN.md's "Building and editing a pack": "importing a StepMania
 * folder or `.zip`"), picks each folder's preferred simfile
 * (`.ssc` over `.sm` — `pickPreferredSimfile`), and parses it. A folder
 * `parseSimfile` can't make sense of is skipped rather than failing the
 * whole pack, the same tolerance `pack-import.ts`'s server-side directory
 * walk already has.
 *
 * Pure and synchronous so it's testable without a real Worker or zip file
 * — the Worker itself (`zip-worker.ts`) is a thin `unzipSync` +
 * `postMessage` wrapper around this.
 */
export function parseZipEntries(entries: Record<string, Uint8Array>): ChartInput[] {
  const bySongFolder = new Map<string, string[]>();
  for (const path of Object.keys(entries)) {
    if (!/\.(sm|ssc)$/i.test(path)) continue;
    const folder = path.slice(0, path.lastIndexOf('/'));
    const list = bySongFolder.get(folder) ?? [];
    list.push(path);
    bySongFolder.set(folder, list);
  }

  const charts: ChartInput[] = [];
  for (const [, filesInFolder] of bySongFolder) {
    const chosen = pickPreferredSimfile(filesInFolder);
    if (!chosen) continue;
    try {
      const content = decoder.decode(entries[chosen]);
      const filename = chosen.slice(chosen.lastIndexOf('/') + 1);
      charts.push(...parseSimfile(filename, content));
    } catch {
      // One malformed simfile isn't a reason to fail the whole import.
      continue;
    }
  }
  return charts;
}
