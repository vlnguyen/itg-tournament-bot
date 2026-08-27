import { z } from 'zod';
import { DifficultySlot, PlayStyle } from './enums.js';

/** The only flag that exists. A general list is premature until there is a second. */
export const ChartFlag = z.enum(['noCmod']);
export type ChartFlag = z.infer<typeof ChartFlag>;

/**
 * What the client-side parser produces and the import endpoint accepts.
 *
 * This is the schema the design's "declared once and shared" promise refers to:
 * the browser validates against it before sending, and the server re-validates
 * against this same module because the client fully controls the payload.
 */
export const ChartInput = z.object({
  /** Both forms are kept. Resolution happens at display time, not at import. */
  title: z.string().min(1),
  titleTranslit: z.string().nullable().default(null),
  subtitle: z.string().nullable().default(null),
  subtitleTranslit: z.string().nullable().default(null),
  artist: z.string().nullable().default(null),
  artistTranslit: z.string().nullable().default(null),

  playStyle: PlayStyle,
  /** The named slot — NOVICE..EXPERT. Distinct from `meter`. */
  difficulty: DifficultySlot,
  /** The numeric block rating. */
  meter: z.number().int().min(1).max(99),
  /** `#CREDIT` — who authored the chart. */
  stepartist: z.string().nullable().default(null),
  /** `#DESCRIPTION` — a free-text chart label, often a variant name. */
  description: z.string().nullable().default(null),
  sourcePack: z.string().nullable().default(null),
  flags: z.array(ChartFlag).default([]),
});
export type ChartInput = z.infer<typeof ChartInput>;

/**
 * Display resolution: the transliterated form wins when present, per the
 * requirements' chart metadata table. Kept here so every surface resolves the
 * same way and no caller reimplements the precedence.
 */
export function displayTitle(c: Pick<ChartInput, 'title' | 'titleTranslit'>): string {
  return c.titleTranslit ?? c.title;
}

export function displaySubtitle(
  c: Pick<ChartInput, 'subtitle' | 'subtitleTranslit'>,
): string | null {
  return c.subtitleTranslit ?? c.subtitle;
}

export function displayArtist(c: Pick<ChartInput, 'artist' | 'artistTranslit'>): string | null {
  return c.artistTranslit ?? c.artist;
}

/**
 * `${stepartist} [${description}]` when both exist; otherwise whichever one
 * is set, unbracketed; `null` when neither is. Shared so the web match
 * detail page's Draw table renders the same "Description" a Discord state
 * message's embed does — one implementation, not two independently
 * maintained formats that can drift apart.
 */
export function displayStepartistLine(c: Pick<ChartInput, 'stepartist' | 'description'>): string | null {
  if (c.stepartist && c.description) return `${c.stepartist} [${c.description}]`;
  return c.stepartist ?? c.description ?? null;
}

/**
 * Every text field a chart search should match, raw and transliterated alike.
 *
 * `description` is deliberately absent: it is display-only. It carries variant
 * labels rather than anything a player searches by, and including it would
 * surface charts for reasons the searcher cannot see in the result.
 */
export function searchableText(c: ChartInput): string {
  return [
    c.title,
    c.titleTranslit,
    c.subtitle,
    c.subtitleTranslit,
    c.artist,
    c.artistTranslit,
    c.stepartist,
    c.sourcePack,
  ]
    .filter((v): v is string => Boolean(v))
    .join(' ');
}

export const ChartImport = z.object({ charts: z.array(ChartInput).min(1) });
export type ChartImport = z.infer<typeof ChartImport>;

/**
 * Chart metadata as it was when a chart was drawn, written into the draw event.
 * History renders from this; the pack renders from the Chart row. See
 * DESIGN.md, "Snapshotting a chart".
 */
export const ChartSnapshot = ChartInput.extend({ chartId: z.string().min(1) });
export type ChartSnapshot = z.infer<typeof ChartSnapshot>;
