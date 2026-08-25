import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { type ChartInput, parseSimfile, pickPreferredSimfile } from '@itg/shared';

/**
 * The `Pack.ini`/`DisplayTitle` a pack ships with is the name organizers
 * actually gave it — closer to "Storm 2026" than the folder it happens to
 * be unzipped into on any given machine. Falls back to the folder's own
 * name when there's no `Pack.ini`, or it doesn't set one.
 */
function readPackName(dir: string): string {
  try {
    const ini = readFileSync(join(dir, 'Pack.ini'), 'utf8');
    const match = /^DisplayTitle=(.*)$/im.exec(ini);
    const title = match?.[1]?.trim();
    if (title) return title;
  } catch {
    // No Pack.ini, or it isn't readable — the folder name is all there is.
  }
  return basename(dir);
}

/**
 * Walks a StepMania pack folder on disk — one subdirectory per song — and
 * parses every song's preferred simfile (`.ssc` over `.sm`, see
 * `pickPreferredSimfile`) into `ChartInput` rows tagged with this pack's
 * name.
 *
 * This is the filesystem-walking counterpart `parseSimfile` itself
 * deliberately doesn't have — see DESIGN.md, "Client-Side Song Pack
 * Parsing": "a parser that assumes `fs` and directory walking needs its
 * I/O layer wrapped rather than used directly." A song folder simfiles
 * can't parse is skipped with a warning rather than failing the whole
 * pack — one bad file isn't a reason to import zero charts.
 */
export function readPackDirectory(dir: string): ChartInput[] {
  const sourcePack = readPackName(dir);
  const songDirs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());

  const charts: ChartInput[] = [];
  for (const entry of songDirs) {
    const songDir = join(dir, entry.name);
    const chosen = pickPreferredSimfile(readdirSync(songDir));
    if (!chosen) continue;

    try {
      const content = readFileSync(join(songDir, chosen), 'utf8');
      for (const chart of parseSimfile(chosen, content)) {
        charts.push({ ...chart, sourcePack });
      }
    } catch (err) {
      console.warn(`[pack-import] skipping "${entry.name}": ${(err as Error).message}`);
    }
  }
  return charts;
}

/** Persists a directory scan as this tournament's chart pack. Returns the count written. */
export async function importPackToTournament(
  prisma: PrismaClient,
  tournamentId: string,
  packDir: string,
): Promise<number> {
  const charts = readPackDirectory(packDir);
  if (charts.length === 0) return 0;
  await prisma.chart.createMany({ data: charts.map((c) => ({ tournamentId, ...c })) });
  return charts.length;
}
